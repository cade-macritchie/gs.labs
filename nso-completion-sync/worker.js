// nso-completion-sync: nightly Caspio NSO_table -> Slate "NSO Completion (Caspio)" source format.
//
// Reads NSO_table through the Caspio REST API (read-only), cleans the rows and POSTs a CSV to the
// source format's web-service URL. The format (update-only, Unsafe Yes) matches on gs_ID = SIS ID
// and sets Person fields NSO Completion (complete -1 -> Yes) and NSO Completion Date (completed_date).
//
// Routes (all need the X-Admin-Key header = ADMIN_KEY secret):
//   GET  /run             dry run: fetch + clean, return counts and a PII-free preview, send nothing
//   GET  /run?limit=5     same, first 5 cleaned rows only
//   POST /run?push=1      fetch + clean + send to Slate (add &limit=5 for a test push)
// Cron (wrangler.toml): runs the same pipeline and pushes only when the ENABLED var is "true".
//
// Secrets (names only, set with `wrangler secret put <NAME>`):
//   CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET   Caspio REST API profile (read access to NSO_table)
//   SLATE_IMPORT_USER, SLATE_IMPORT_PASSWORD Slate user allowed to POST to the source-format web service
//   ADMIN_KEY                                guards /run

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), { status: status || 200, headers: JSON_HEADERS });
}

// Sends every row from NSO_START_TERM of NSO_START_YEAR on (Spring 24 = Spring of "2023-2024"),
// including future years, so a student who does NSO early for a later term is still picked up. Year
// looks like "2026-2027", so a plain string compare orders it correctly. Within the start year, terms
// run Fall -> Winter/January -> Spring -> Summer (Fall 23 is in 2023-2024, before Spring 24).
const YEAR_RE = /^\d{4}-\d{4}$/;
function startYear(env) {
  const y = String(env.NSO_START_YEAR || "").trim();
  if (!YEAR_RE.test(y)) throw new Error(`NSO_START_YEAR must look like 2026-2027, got "${y}"`);
  return y;
}

const TERM_ORDER = [/fall/i, /winter|jan/i, /spring/i, /summer/i];
function termRank(term) {
  const i = TERM_ORDER.findIndex((re) => re.test(String(term || "")));
  return i; // -1 = unrecognised term
}
function startTermRank(env) {
  const t = String(env.NSO_START_TERM || "Fall").trim();
  const r = termRank(t);
  if (r < 0) throw new Error(`NSO_START_TERM must be Fall, Winter, Spring or Summer, got "${t}"`);
  return r;
}

async function caspioToken(env) {
  const base = `https://${env.CASPIO_ACCOUNT}.caspio.com`;
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.CASPIO_CLIENT_ID}:${env.CASPIO_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Caspio token request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("Caspio token response had no access_token");
  return body.access_token;
}

async function fetchCaspioRows(env, fromYear) {
  const base = `https://${env.CASPIO_ACCOUNT}.caspio.com/integrations/rest/v3/tables/${encodeURIComponent(env.CASPIO_TABLE)}/records`;
  const token = await caspioToken(env);
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    // Caspio REST v3 takes q.where / q.pageSize / q.pageNumber (default page size is 100, max 1000).
    const qs = `q.where=${encodeURIComponent(`year>='${fromYear}'`)}&q.pageSize=1000&q.pageNumber=${page}`;
    const res = await fetch(`${base}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Caspio records request failed: HTTP ${res.status}`);
    const body = await res.json();
    const batch = Array.isArray(body.Result) ? body.Result : [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

function isTrue(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "-1" || s === "1" || s === "true" || s === "yes";
}

// NSO_table.time = when the row was completed. The REST API returns ISO ("2026-08-14T15:32:10");
// Caspio's CSV export shows "8/14/2026 3:32:10 PM". Returns "YYYY-MM-DD" (Caspio local date) or "".
function completionDate(v) {
  const s = String(v == null ? "" : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

// Optional history for the date only: NSO_DATE_FROM_YEAR (e.g. "2016-2017") also reads older rows,
// so returning students get their last completion date. Those rows never set NSO Completion: a
// person whose only rows are before the start term is sent with `complete` blank (Slate skips blank
// values). Unset = the date comes from the same window as NSO Completion.
function dateFromYear(env, fromYear) {
  const y = String(env.NSO_DATE_FROM_YEAR || "").trim();
  if (!y) return fromYear;
  if (!YEAR_RE.test(y)) throw new Error(`NSO_DATE_FROM_YEAR must look like 2016-2017, got "${y}"`);
  return y < fromYear ? y : fromYear;
}

// Clean + dedupe. gs_ID is the SIS ID: digits only, exactly 6, not all zeros ("#168109" -> "168109";
// "test", "000000", short or garbled IDs are dropped and counted). One output row per ID: the latest
// completion (by `time`) wins, so `completed_date` is the most recent NSO and term/year/campus match it.
function cleanRows(rows, fromYear, fromTermRank, histFromYear) {
  const dropped = { wrongYear: 0, beforeStartTerm: 0, notComplete: 0, badId: 0, duplicate: 0 };
  const byId = new Map();
  let noDate = 0;
  for (const r of rows) {
    const year = String(r.year || "").trim();
    if (!YEAR_RE.test(year) || year < histFromYear) { dropped.wrongYear++; continue; }
    const inWindow = year > fromYear || (year === fromYear && termRank(r.term) >= fromTermRank);
    if (!inWindow && histFromYear === fromYear) { dropped.beforeStartTerm++; continue; }
    if (!isTrue(r.complete)) { dropped.notComplete++; continue; }
    const id = String(r.gs_ID == null ? "" : r.gs_ID).replace(/^[\s#]+/, "").trim();
    if (!/^\d{6}$/.test(id) || /^0+$/.test(id)) { dropped.badId++; continue; }
    const date = completionDate(r.time);
    if (!date) noDate++;
    const row = { gs_ID: id, term: r.term || "", year, campus: r.campus || "", complete: inWindow ? "-1" : "", completed_date: date };
    const prev = byId.get(id);
    if (prev) {
      dropped.duplicate++;
      const keep = (row.completed_date || "") > (prev.completed_date || "") ? row : prev;
      if (prev.complete === "-1" || row.complete === "-1") keep.complete = "-1";
      byId.set(id, keep);
      continue;
    }
    byId.set(id, row);
  }
  return { rows: [...byId.values()], dropped, noDate };
}

function toCsv(rows) {
  const cols = ["gs_ID", "term", "year", "campus", "complete", "completed_date"];
  const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

async function pushToSlate(env, csv) {
  const res = await fetch(env.SLATE_IMPORT_URL, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      Authorization: "Basic " + btoa(`${env.SLATE_IMPORT_USER}:${env.SLATE_IMPORT_PASSWORD}`),
    },
    body: csv,
  });
  const text = (await res.text()).slice(0, 300);
  return { ok: res.ok, status: res.status, body: text };
}

async function sync(env, { push, limit }) {
  const fromYear = startYear(env);
  const fromTermRank = startTermRank(env);
  const histFromYear = dateFromYear(env, fromYear);
  const fetched = await fetchCaspioRows(env, histFromYear);
  const cleaned = cleanRows(fetched, fromYear, fromTermRank, histFromYear);
  let rows = cleaned.rows;
  if (limit > 0) rows = rows.slice(0, limit);
  const summary = {
    fromYear,
    fromTerm: String(env.NSO_START_TERM || "Fall").trim(),
    dateFromYear: histFromYear,
    fetchedFromCaspio: fetched.length,
    dropped: cleaned.dropped,
    uniquePeople: cleaned.rows.length,
    toSend: rows.length,
    completeYes: rows.filter((r) => r.complete === "-1").length,
    dateOnly: rows.filter((r) => r.complete !== "-1").length,
    missingDate: rows.filter((r) => !r.completed_date).length,
    // shape of the raw `time` value, digits masked (e.g. "9999-99-99T99:99:99"), to confirm parsing
    timeShapes: [...new Set(fetched.slice(0, 50).map((r) => String(r.time == null ? "" : r.time).replace(/\d/g, "9")))].slice(0, 3),
    byDateYear: rows.reduce((a, r) => ((a[(r.completed_date || "none").slice(0, 4)] = (a[(r.completed_date || "none").slice(0, 4)] || 0) + 1), a), {}),
    byYear: rows.reduce((a, r) => ((a[r.year] = (a[r.year] || 0) + 1), a), {}),
    byTerm: rows.reduce((a, r) => ((a[r.term] = (a[r.term] || 0) + 1), a), {}),
    pushed: false,
  };
  if (!push) return summary;
  if (!rows.length) return { ...summary, note: "nothing to send" };
  const slate = await pushToSlate(env, toCsv(rows));
  summary.pushed = slate.ok;
  summary.slate = { status: slate.status, body: slate.body };
  if (!slate.ok) throw Object.assign(new Error(`Slate rejected the push: HTTP ${slate.status}`), { summary });
  return summary;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return json({ error: "not found" }, 404);
    const key = request.headers.get("X-Admin-Key");
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
    const push = request.method === "POST" && url.searchParams.get("push") === "1";
    const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
    try {
      return json(await sync(env, { push, limit }));
    } catch (err) {
      console.error("nso-completion-sync failed:", err.message);
      return json({ error: err.message, summary: err.summary || null }, 502);
    }
  },

  async scheduled(event, env) {
    const live = env.ENABLED === "true";
    try {
      const summary = await sync(env, { push: live, limit: 0 });
      console.log("nso-completion-sync", live ? "pushed" : "dry run (ENABLED is not true)", JSON.stringify(summary));
    } catch (err) {
      console.error("nso-completion-sync failed:", err.message, JSON.stringify(err.summary || {}));
      throw err; // marks the cron invocation as failed in Cloudflare
    }
  },
};
