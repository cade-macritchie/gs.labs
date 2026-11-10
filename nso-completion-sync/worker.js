// nso-completion-sync: nightly Caspio NSO_table -> Slate "NSO Completion (Caspio)" source format.
//
// Reads NSO_table through the Caspio REST API (read-only), cleans the rows and POSTs a CSV to the
// source format's web-service URL. The format (update-only, Unsafe Yes) matches on gs_ID = SIS ID
// and sets Person field NSO Completion (complete -1 -> Yes).
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

// Academic year starts with Fall (August). Aug 2026 - Jul 2027 = "2026-2027". NSO_YEAR overrides.
function currentAcademicYear(now) {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 7 ? y : y - 1;
  return `${start}-${start + 1}`;
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

async function fetchCaspioRows(env, year) {
  const base = `https://${env.CASPIO_ACCOUNT}.caspio.com/integrations/rest/v3/tables/${encodeURIComponent(env.CASPIO_TABLE)}/records`;
  const token = await caspioToken(env);
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    // Caspio REST v3 takes q.where / q.pageSize / q.pageNumber (default page size is 100, max 1000).
    const qs = `q.where=${encodeURIComponent(`year='${year}'`)}&q.pageSize=1000&q.pageNumber=${page}`;
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

// Clean + dedupe. gs_ID is the SIS ID: digits only, exactly 6, not all zeros ("#168109" -> "168109";
// "test", "000000", short or garbled IDs are dropped and counted). One output row per ID.
function cleanRows(rows, year) {
  const dropped = { wrongYear: 0, notComplete: 0, badId: 0, duplicate: 0 };
  const byId = new Map();
  for (const r of rows) {
    if (String(r.year || "").trim() !== year) { dropped.wrongYear++; continue; }
    if (!isTrue(r.complete)) { dropped.notComplete++; continue; }
    const id = String(r.gs_ID == null ? "" : r.gs_ID).replace(/^[\s#]+/, "").trim();
    if (!/^\d{6}$/.test(id) || /^0+$/.test(id)) { dropped.badId++; continue; }
    if (byId.has(id)) { dropped.duplicate++; continue; }
    byId.set(id, { gs_ID: id, term: r.term || "", year, campus: r.campus || "", complete: "-1" });
  }
  return { rows: [...byId.values()], dropped };
}

function toCsv(rows) {
  const cols = ["gs_ID", "term", "year", "campus", "complete"];
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
  const year = env.NSO_YEAR || currentAcademicYear(new Date());
  const fetched = await fetchCaspioRows(env, year);
  const cleaned = cleanRows(fetched, year);
  let rows = cleaned.rows;
  if (limit > 0) rows = rows.slice(0, limit);
  const summary = {
    year,
    fetchedFromCaspio: fetched.length,
    dropped: cleaned.dropped,
    uniquePeople: cleaned.rows.length,
    toSend: rows.length,
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
