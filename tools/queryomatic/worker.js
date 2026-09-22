/**
 * GS Labs Slate Gateway (formerly "Queryomatic Cloudflare Worker")
 *
 * Two jobs live in this one Worker:
 *
 * 1. Queryomatic — the AI-assisted admissions-export tool's own backend
 *    (options.md refresh/generate/run flows below).
 *
 * 2. Slate portal proxy (/api/slate/*) — the Slate credentials that used to be
 *    hardcoded directly in slate-templates/wrappers/*.liquid.html live here as
 *    secrets instead, so the browser never sees them. Each route is a
 *    parameter set over the same maindb query Queryomatic runs (portal-options
 *    reads the prompts query), and whitelists only the query-string parameters
 *    its wrapper actually sends. These routes are called from Slate portal
 *    pages at PORTAL_ORIGIN (enroll.gs.edu), NOT from ALLOWED_ORIGIN (GitHub
 *    Pages) — that's a different caller than Queryomatic's own routes below,
 *    so they check Origin against PORTAL_ORIGIN instead.
 *
 *
 * QUERYOMATIC REFRESH FLOW:
 *
 * POST /api/options/refresh
 *     ↓
 * Slate options query
 *     ↓
 * { row: [{ key, value }, ...] }
 *     ↓
 * Group + deduplicate values
 *     ↓
 * Read current GitHub options.md
 *     ↓
 * Replace ONLY <!-- VALUES:key START/END --> blocks
 *     ↓
 * Preserve manually-written Context sections
 *     ↓
 * Commit updated options.md to GitHub
 *
 *
 * QUERYOMATIC GENERATE FLOW:
 *
 * POST /api/generate
 *     ↓
 * Read current options.md from GitHub
 *     ↓
 * Send options.md + user prompt to Claude
 *     ↓
 * Return Slate query parameters
 *
 *
 * QUERYOMATIC RUN FLOW:
 *
 * POST /api/run
 *     ↓
 * Run main Slate query
 *
 *
 * SLATE PORTAL PROXY ROUTES (/api/slate/*), one per distinct Slate query id:
 *
 * - GET /api/slate/teaching-site-people       (teaching-site-overview wrapper)
 * - GET /api/slate/regional-campus-people     (regional-campus wrapper)
 * - GET /api/slate/pipeline-people            (pipeline-overview wrapper)
 * - GET /api/slate/teaching-site-counts       (no portal caller; kept for ad-hoc use)
 * - GET /api/slate/records                    (student-lookup, event-tracker wrappers)
 * - GET /api/slate/inquiries                  (regional-campus wrapper)
 * - GET /api/slate/portal-options             (teaching-site-overview, regional-campus wrappers)
 * - GET /api/slate/regional-campus-records    (regional-campus wrapper)
 * - GET /api/slate/additional-applications    (student-lookup wrapper)
 *
 * - GET /api/slate/checkin-search             (tools/checkin/, called directly from GitHub
 *   Pages — NOT a Slate wrapper, so this one route checks Origin against
 *   ALLOWED_ORIGIN instead of PORTAL_ORIGIN. See handlePagesSlateProxyRoute.)
 * - GET /api/slate/checkin-qr-image           (tools/checkin/, re-serves a per_qr_url PNG
 *   with CORS headers — also ALLOWED_ORIGIN-gated. See handleCheckinQrImage.)
 *
 *
 * Secrets (names only — set with `wrangler secret put <NAME>`):
 * - SLATE_TOKEN_PROMPTS                        (prompts query: options refresh + /api/slate/portal-options)
 * - SLATE_TOKEN_MAINDB                         (maindb query: /api/run + every other /api/slate/* route)
 * - ANTHROPIC_API_KEY                          (Queryomatic /api/generate)
 * - GITHUB_TOKEN                               (Queryomatic options.md commits)
 * - SLATE_OPTIONS_URL                          (prompts query URL)
 * - SLATE_QUERY_URL                            (maindb query URL)
 *
 * Vars:
 * - ALLOWED_ORIGIN   (GitHub Pages origin — Queryomatic + analytics routes)
 * - PORTAL_ORIGIN    (Slate portal origin — /api/slate/* routes)
 */


// ============================================================
// CONFIG
// ============================================================

const GITHUB_OWNER = "cade-macritchie";
const GITHUB_REPO = "gs.labs";
const GITHUB_BRANCH = "main";
const GITHUB_OPTIONS_PATH = "tools/queryomatic/options.md";

const GITHUB_API_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_OPTIONS_PATH}`;

const QUERY_PARAMETER_KEYS = Object.freeze([
  "first",
  "last",
  "sisid",
  "term",
  "year",
  "status",
  "pipeline",
  "teachingsite",
  "program",
  "app_code",
  "app_createddate_start",
  "app_createddate_end",
  "campus_assigned",
  "alt_form_type",
]);



// ============================================================
// DEBUG HELPERS
// ============================================================

function requestId() {
  return crypto.randomUUID().slice(0, 8);
}


function logInfo(id, message, details = {}) {
  console.log(`[${id}] ${message}`, details);
}


function logError(id, message, details = {}) {
  console.error(`[${id}] ${message}`, details);
}


function safeUrl(urlString) {
  try {
    const url = new URL(urlString);

    for (const key of [
      "token",
      "access_token",
      "api_key",
      "h",
    ]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(
          key,
          "[REDACTED]"
        );
      }
    }

    return url.toString();

  } catch {
    return "[INVALID URL]";
  }
}


function secretStatus(value) {
  if (!value) {
    return "MISSING";
  }

  return `SET (${value.length} characters)`;
}


function normalizeQueryParams(params) {
  const source =
    params &&
    typeof params === "object" &&
    !Array.isArray(params)
      ? params
      : {};

  return Object.fromEntries(
    QUERY_PARAMETER_KEYS.map(key => [
      key,
      source[key] == null
        ? ""
        : String(source[key]).trim(),
    ])
  );
}


// ============================================================
// CORS / JSON
// ============================================================

function corsHeaders(env, origin) {
  return {
    "Access-Control-Allow-Origin":
      origin || env.ALLOWED_ORIGIN || "*",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",
  };
}


function json(data, env, status = 200, origin) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(env, origin),
      },
    }
  );
}


// ============================================================
// SLATE PORTAL PROXY HELPERS (/api/slate/*)
// ============================================================

function originAllowed(request, allowedOrigin) {
  if (!allowedOrigin) return false;

  const origin = request.headers.get("Origin");
  if (origin === allowedOrigin) return true;

  const referer = request.headers.get("Referer") || "";
  return referer === allowedOrigin || referer.startsWith(allowedOrigin + "/");
}


const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function checkRateLimit(env, request, bucket) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `ratelimit:${bucket}:${ip}:${window}`;

  const current = Number.parseInt((await env.OPTIONS_CACHE.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_MAX_REQUESTS) return false;

  await env.OPTIONS_CACHE.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2,
  });
  return true;
}


// Portal route parameter names that differ from the maindb query's own
// parameter names. Anything absent here is passed through unchanged. If a
// route returns the wrong population, check this table first.
const MAINDB_PARAM_ALIASES = Object.freeze({
  site: "teachingsite",
  campus: "campus_assigned",
});


async function proxySlateQuery(env, id, routeName, allowedParams, incomingSearchParams, fixedParams) {
  if (!env.SLATE_QUERY_URL) {
    throw new Error("SLATE_QUERY_URL is missing");
  }

  if (!env.SLATE_TOKEN_MAINDB) {
    throw new Error("SLATE_TOKEN_MAINDB is missing");
  }

  const url = new URL(env.SLATE_QUERY_URL);
  url.searchParams.set("output", "json");

  for (const [key, value] of Object.entries(fixedParams || {})) {
    url.searchParams.set(key, value);
  }

  for (const key of allowedParams) {
    if (!incomingSearchParams.has(key)) continue;

    const value = String(incomingSearchParams.get(key) || "").trim();

    // Blank values are dropped rather than sent as "" — Slate's Date-typed
    // parameters reject an empty string, which is why the teaching-site
    // wrapper omits its inquiry date bounds for "Total (All Time)".
    if (!value) continue;

    url.searchParams.set(MAINDB_PARAM_ALIASES[key] || key, value);
  }

  logInfo(id, "Slate portal proxy request", { route: routeName, url: safeUrl(url.toString()) });

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.SLATE_TOKEN_MAINDB}`,
      Accept: "application/json",
    },
  });

  const responseText = await resp.text();

  if (!resp.ok) {
    logError(id, "Slate portal proxy query failed", {
      route: routeName,
      status: resp.status,
      body: responseText.slice(0, 2000),
    });
    throw new Error(`Slate query failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error("Slate query returned invalid JSON");
  }
}


// `source` picks which Slate query backs the route: "maindb" (the parameterized
// person query, SLATE_QUERY_URL + SLATE_TOKEN_MAINDB) or "prompts" (the
// key/value options query, SLATE_OPTIONS_URL + SLATE_TOKEN_PROMPTS).
async function handleSlateProxyRoute(request, env, id, routeName, source, allowedParams, fixedParams) {
  if (!originAllowed(request, env.PORTAL_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.PORTAL_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, routeName))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.PORTAL_ORIGIN);
  }

  const data = source === "prompts"
    ? await fetchSlateOptions(env, id)
    : await proxySlateQuery(env, id, routeName, allowedParams, new URL(request.url).searchParams, fixedParams);

  return json(data, env, 200, env.PORTAL_ORIGIN);
}


// Same shape as handleSlateProxyRoute, but for a route called directly from a
// GitHub Pages tool page's own script (like tools/idea-box/ calls its own
// Worker) rather than from a Slate wrapper's inline <script>. The only
// difference that matters is which origin the request is allowed to come
// from — ALLOWED_ORIGIN (GitHub Pages) here, not PORTAL_ORIGIN (Slate).
async function handlePagesSlateProxyRoute(request, env, id, routeName, allowedParams, fixedParams) {
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.ALLOWED_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, routeName))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.ALLOWED_ORIGIN);
  }

  const data = await proxySlateQuery(env, id, routeName, allowedParams, new URL(request.url).searchParams, fixedParams);
  return json(data, env, 200, env.ALLOWED_ORIGIN);
}


// Fixed params always sent on every /api/slate/checkin-search call, on top of
// whatever the caller sends. Empty for now — the check-in portal is still
// being tested against the whole maindb population. Once there's a
// parameter that should scope every check-in search (e.g. a specific event),
// add it here, e.g. { alt_form_type: "Event" }, the same way the /inquiries
// route pins { status: "Inquiry" }.
const CHECKIN_FIXED_PARAMS = Object.freeze({});


// ============================================================
// CHECK-IN QR IMAGE PROXY
//
// maindb's per_qr_url column (verified live 2026-09-22) is not an opaque
// code to encode ourselves — it's a link to a PNG Slate already renders at
// enroll.gs.edu/register/mobile?id=<guid>&cmd=barcode&type=person. That
// response carries no Access-Control-Allow-Origin header, so a browser on
// GitHub Pages can display it in a plain <img> (tag loads aren't
// CORS-gated) but cannot read its pixel bytes via fetch()/canvas — which
// tools/checkin/ needs to do to hand the image to the Dymo SDK for
// printing. This route does that read server-side, where CORS doesn't
// apply, and re-serves the bytes with CORS headers for ALLOWED_ORIGIN.
//
// The `url` parameter is checked against an exact pattern (Slate's own
// host/path/query shape, GUID-validated) rather than fetched blind, so this
// can't be turned into an open image-fetching proxy for arbitrary URLs.
// ============================================================

const CHECKIN_QR_IMAGE_PATTERN =
  /^https:\/\/enroll\.gs\.edu\/register\/mobile\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}&cmd=barcode&type=person$/i;

async function handleCheckinQrImage(request, env, id) {
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.ALLOWED_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "checkin-qr-image"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.ALLOWED_ORIGIN);
  }

  const target = new URL(request.url).searchParams.get("url") || "";
  if (!CHECKIN_QR_IMAGE_PATTERN.test(target)) {
    return json({ error: "Unrecognized QR image URL", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }

  logInfo(id, "Checkin QR image proxy request", { url: safeUrl(target) });

  const resp = await fetch(target, { headers: { Accept: "image/png" } });
  if (!resp.ok) {
    return json({ error: `QR image fetch failed: HTTP ${resp.status}`, requestId: id }, env, 502, env.ALLOWED_ORIGIN);
  }

  const bytes = await resp.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": resp.headers.get("content-type") || "image/png",
      "Cache-Control": "no-store",
      ...corsHeaders(env, env.ALLOWED_ORIGIN),
    },
  });
}


// ============================================================
// PORTAL FUNNELS
//
// Three portals -- Teaching Sites, Regional Campus, Pipeline Overview -- all
// draw the same shape: a population split by person status, narrowed to an
// academic period, grouped by some affiliation. All three are served from the
// shared maindb ("all people") query by the helpers in this section.
//
// The one rule that matters
// -------------------------
// maindb's "term" and "year" parameters filter on the APPLICATION's term and
// year. A person with no application -- every Inquiry, every Prospect -- has
// them blank, so "status=Inquiry&term=Fall&year=2026-2027" returns ZERO rows.
// That is not a bug to work around; it is the question being asked (inquiries
// whose application is for Fall), and an inquiry has no application.
//
// So each funnel stage is fetched with the parameters that mean something for
// it, in its own call:
//
//   pre-application (Inquiry, Prospect)  status + person_created_date_start/end
//   application     (Applicant, Student) status + term + year
//
// The pre-application stages are scoped by when the person record was created,
// using the calendar window for the selected period.
// ============================================================

const PORTAL_FUNNEL_CACHE_SECONDS = 300;

// Academic period -> the calendar window a person must have been CREATED in to
// count toward that period. One entry per period in the selector in
// assets/dashboard-common.js; the two tables have to be kept in step, or a
// period with no window here silently falls back to an all-time count.
//
// The windows are HALF-OPEN: [start, end). The Slate field carries a time as
// well as a date, so "end: 1/15/2026" means "before 1/15/2026 00:00" and drops
// anyone created during that day. Each window's end is therefore the NEXT
// window's start, not the day before it. Getting this wrong loses people at the
// seams -- the day-before spelling lost 6 of 2,301 inquiries.
//
// The earliest period has no start bound so it absorbs everything before the
// tracked range instead of discarding it.
//
// Verified against the live query: the nine windows sum to 2,301, exactly the
// all-time inquiry count, with no gap or overlap.
//
// Dates are M/D/YYYY with no leading zeros, the format the Slate field expects.
const PERSON_CREATED_WINDOWS = Object.freeze({
  "Fall|2025-2026": { start: "", end: "8/16/2025" },
  "Spring|2025-2026": { start: "8/16/2025", end: "1/16/2026" },
  "Summer|2025-2026": { start: "1/16/2026", end: "5/16/2026" },
  "Fall|2026-2027": { start: "5/16/2026", end: "8/16/2026" },
  "Spring|2026-2027": { start: "8/16/2026", end: "1/16/2027" },
  "Summer|2026-2027": { start: "1/16/2027", end: "5/16/2027" },
  "Fall|2027-2028": { start: "5/16/2027", end: "8/16/2027" },
  "Spring|2027-2028": { start: "8/16/2027", end: "1/16/2028" },
  "Summer|2027-2028": { start: "1/16/2028", end: "5/16/2028" },
});

// per_status value for each funnel stage.
const FUNNEL_STAGE_STATUS = Object.freeze({
  inquiries: "Inquiry",
  prospects: "Prospect",
  applications: "Applicant",
  students: "Student",
});

// The stages whose people have an application, and so answer to term/year.
const APPLICATION_STAGES = new Set(["applications", "students"]);

// Every maindb parameter any funnel route is allowed to send.
const FUNNEL_PARAMS = Object.freeze([
  "status",
  "term",
  "year",
  "person_created_date_start",
  "person_created_date_end",
  "teachingsite",
  "campus_assigned",
  "pipeline",
]);


// Returns the person-created window for a period, or null for "Total (All
// Time)" and for any period this table does not know about -- in which case the
// caller falls back to an unbounded query and says so in its response.
function personCreatedWindow(term, year) {
  if (!term && !year) return null;
  return PERSON_CREATED_WINDOWS[`${term}|${year}`] || null;
}


function normalizeOptionKey(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");
}


// Pulls one prompt's values out of the prompts query, by any of several
// spellings of its key.
function optionValues(optionsData, keys) {
  const wanted = new Set([...keys].map(normalizeOptionKey));
  const rows = Array.isArray(optionsData?.row) ? optionsData.row : [];

  const values = rows
    .filter((row) => wanted.has(normalizeOptionKey(row?.key)))
    .map((row) => String(row?.value == null ? "" : row.value).trim())
    .filter(Boolean);

  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}


function plainText(value) {
  if (value == null) return "";
  const raw = typeof value === "object"
    ? String(value.display ?? value.label ?? value.name ?? value.value ?? value.text ?? "")
    : String(value);
  return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}


function rowsOf(data) {
  if (Array.isArray(data?.row)) return data.row;
  return data?.row ? [data.row] : [];
}


// Bounded-concurrency map. Cloudflare caps a request at 50 subrequests, and
// firing two dozen Slate queries at once is a good way to get throttled.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await worker(items[index]);
      }
    }
  );

  await Promise.all(runners);
  return results;
}


// One maindb call for one funnel stage.
//
// `scope` optionally narrows to one affiliation, e.g.
// { param: "campus_assigned", value: "Bay Area Campus" }. Note that passing a
// scope parameter can change which columns Slate returns -- `teachingsite`
// drops the app_* block -- so nothing downstream may depend on a column that a
// scope parameter could take away.
async function fetchFunnelStage(env, id, routeName, stage, filters, scope) {
  const params = new URLSearchParams({ status: FUNNEL_STAGE_STATUS[stage] });

  if (APPLICATION_STAGES.has(stage)) {
    if (filters.term) params.set("term", filters.term);
    if (filters.year) params.set("year", filters.year);
  } else {
    const window = personCreatedWindow(filters.term, filters.year);
    if (window) {
      // Blank bounds are omitted rather than sent as "" -- the Slate field is
      // Date-typed and rejects an empty string.
      if (window.start) params.set("person_created_date_start", window.start);
      if (window.end) params.set("person_created_date_end", window.end);
    }
  }

  if (scope && scope.value) params.set(scope.param, scope.value);

  const data = await proxySlateQuery(
    env, id, `${routeName}:${stage}`, FUNNEL_PARAMS, params, null
  );

  return rowsOf(data);
}


// Runs several stages, letting one failure through as an empty stage rather
// than blanking the portal. Throws only if every stage failed.
async function fetchFunnelStages(env, id, routeName, stageNames, filters, scope) {
  const settled = await Promise.all(stageNames.map(async (stage) => {
    try {
      return { stage, rows: await fetchFunnelStage(env, id, routeName, stage, filters, scope) };
    } catch (error) {
      logError(id, "Funnel stage query failed", {
        route: routeName,
        stage,
        scope: scope?.value || "",
        message: String(error && error.message ? error.message : error),
      });
      return { stage, rows: [], failed: true };
    }
  }));

  if (settled.every((entry) => entry.failed)) {
    throw new Error(`Every stage of ${routeName} failed`);
  }

  return settled;
}


// Shared entry: origin check, rate limit, KV cache. `build` does the work.
async function serveFunnelRoute(request, env, id, routeName, cacheKey, build) {
  if (!originAllowed(request, env.PORTAL_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.PORTAL_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, routeName))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.PORTAL_ORIGIN);
  }

  const cached = await env.OPTIONS_CACHE.get(cacheKey, "json").catch(() => null);
  if (cached) {
    logInfo(id, "Portal funnel served from cache", { route: routeName, cacheKey });
    return json(cached, env, 200, env.PORTAL_ORIGIN);
  }

  const { payload, complete } = await build();

  // Only cache a complete result -- a partial one would pin a missing stage or
  // scope at zero for the whole TTL.
  if (complete) {
    await env.OPTIONS_CACHE
      .put(cacheKey, JSON.stringify(payload), { expirationTtl: PORTAL_FUNNEL_CACHE_SECONDS })
      .catch(() => {});
  }

  return json(payload, env, 200, env.PORTAL_ORIGIN);
}


// ============================================================
// TEACHING SITE PEOPLE
//
// maindb has no "teaching site is set" parameter, but it does return
// per_teachingsite on every row, and that column agrees exactly with what the
// teachingsite parameter matches (verified site by site). So each stage is
// fetched unscoped and the rows without a teaching site are dropped here --
// which also keeps ~4,800 unrelated people out of the browser.
// ============================================================

const TEACHING_SITE_OPTION_KEYS = ["teachingsite", "teachingsites", "site"];
const TEACHING_SITE_STAGES = ["inquiries", "applications", "students"];


async function handleTeachingSitePeople(request, env, id) {
  const search = new URL(request.url).searchParams;
  const filters = {
    term: String(search.get("term") || "").trim(),
    year: String(search.get("year") || "").trim(),
    site: String(search.get("site") || "").trim(),
  };

  const cacheKey = `teaching-site-people:v3:${filters.term}|${filters.year}|${filters.site}`;

  return serveFunnelRoute(request, env, id, "teaching-site-people", cacheKey, async () => {
    const [options, settled] = await Promise.all([
      fetchSlateOptions(env, id),
      fetchFunnelStages(env, id, "teaching-site-people", TEACHING_SITE_STAGES, filters, null),
    ]);

    const keep = (row) => {
      const site = plainText(row?.per_teachingsite);
      if (!site) return false;
      return filters.site ? site.toLowerCase() === filters.site.toLowerCase() : true;
    };

    const failedStages = settled.filter((entry) => entry.failed).map((entry) => entry.stage);

    const payload = {
      sites: optionValues(options, TEACHING_SITE_OPTION_KEYS),
      scope: filters.site,
      filters: { term: filters.term, year: filters.year },
      // False once the period was applied as a person-created-date window. It
      // stays true for "Total (All Time)", and for a period missing from
      // PERSON_CREATED_WINDOWS, so the portal can label the stat rather than
      // let it be mistaken for a per-period count.
      inquiriesAllTime: !personCreatedWindow(filters.term, filters.year),
      failedStages,
      stages: Object.fromEntries(settled.map((e) => [e.stage, e.rows.filter(keep)])),
    };

    logInfo(id, "Teaching site people assembled", {
      ...filters,
      counts: Object.fromEntries(Object.entries(payload.stages).map(([k, v]) => [k, v.length])),
      failed: failedStages.length,
    });

    return { payload, complete: !failedStages.length };
  });
}


// ============================================================
// REGIONAL CAMPUS PEOPLE
//
// The campus lives in the campus_assigned PARAMETER but is not among the
// columns maindb returns, so there is no column to group by -- each campus has
// to be asked for by name and the answer stamped onto its rows. The campus
// names come from the prompts query.
//
// campus_assigned partitions the whole population cleanly (the eight campuses
// sum to exactly the 5,837-person total), so no row is dropped or counted
// twice. Hawaii and Boston legitimately return 0: people affiliated with them
// sit in a pipeline or a teaching site rather than being assigned there.
//
// Worst case -- every campus, every stage -- is 8 x 4 = 32 Slate calls, under
// Cloudflare's 50-subrequest cap, returning the whole population between them.
// Selecting a campus or a status cuts that sharply, and the result is cached.
// ============================================================

const REGIONAL_CAMPUS_OPTION_KEYS = ["campus", "campuses"];
// The campus prompt carries one value that is not a campus. Excluded here so it
// costs no Slate calls; the wrapper has always left it out of the picker too.
const REGIONAL_CAMPUS_EXCLUDED = new Set(["doctor of ministry"]);
const REGIONAL_CAMPUS_STAGES = ["inquiries", "prospects", "applications", "students"];
const REGIONAL_CAMPUS_FANOUT_LIMIT = 8;


async function handleRegionalCampusPeople(request, env, id) {
  const search = new URL(request.url).searchParams;
  const filters = {
    term: String(search.get("term") || "").trim(),
    year: String(search.get("year") || "").trim(),
    campus: String(search.get("campus") || "").trim(),
    status: String(search.get("status") || "").trim().toLowerCase(),
  };

  const cacheKey = `regional-campus-people:v1:${filters.term}|${filters.year}|${filters.campus}|${filters.status}`;

  return serveFunnelRoute(request, env, id, "regional-campus-people", cacheKey, async () => {
    const options = await fetchSlateOptions(env, id);
    const campuses = optionValues(options, REGIONAL_CAMPUS_OPTION_KEYS)
      .filter((name) => !REGIONAL_CAMPUS_EXCLUDED.has(name.toLowerCase()));

    const targets = filters.campus ? [filters.campus] : campuses;

    // A selected status narrows the fan-out to the one stage that can match it.
    const stages = filters.status
      ? REGIONAL_CAMPUS_STAGES.filter(
          (stage) => FUNNEL_STAGE_STATUS[stage].toLowerCase() === filters.status
        )
      : REGIONAL_CAMPUS_STAGES;

    if (!targets.length || !stages.length) {
      return {
        payload: { campuses, scope: filters.campus, filters, failedCampuses: [], row: [] },
        complete: false,
      };
    }

    const perCampus = await mapWithLimit(targets, REGIONAL_CAMPUS_FANOUT_LIMIT, async (campus) => {
      try {
        const settled = await fetchFunnelStages(
          env, id, "regional-campus-people", stages, filters,
          { param: "campus_assigned", value: campus }
        );
        const failed = settled.filter((entry) => entry.failed).length > 0;
        // Stamp the campus on: it is what was asked for, and no column carries it.
        const rows = settled.flatMap((entry) =>
          entry.rows.map((row) => ({ ...row, campus }))
        );
        return { campus, rows, failed };
      } catch (error) {
        logError(id, "Regional campus query failed", {
          campus,
          message: String(error && error.message ? error.message : error),
        });
        return { campus, rows: [], failed: true };
      }
    });

    const failedCampuses = perCampus.filter((entry) => entry.failed).map((entry) => entry.campus);

    if (failedCampuses.length === targets.length) {
      throw new Error("Every regional campus query failed");
    }

    const payload = {
      campuses,
      scope: filters.campus,
      filters,
      // As on Teaching Sites: true means the pre-application stages were not
      // scoped to the period, so the portal should say so.
      preApplicationAllTime: !personCreatedWindow(filters.term, filters.year),
      failedCampuses,
      row: perCampus.flatMap((entry) => entry.rows),
    };

    logInfo(id, "Regional campus people assembled", {
      ...filters,
      campuses: targets.length,
      stages: stages.length,
      rows: payload.row.length,
      failed: failedCampuses.length,
    });

    return { payload, complete: !failedCampuses.length };
  });
}


// ============================================================
// PIPELINE PEOPLE
//
// per_pipeline IS returned on every row, so unlike Regional Campus this needs
// no fan-out: one call for the selected status, grouped by that column here.
//
// The totals are a fixed comparison population -- every person by status,
// ignoring the period -- so they come from one unparameterized call that is
// tallied rather than four status calls returning the same 5,837 rows between
// them.
// ============================================================

const PIPELINE_OPTION_KEYS = ["pipelines", "pipeline"];
const PIPELINE_TOTAL_KEYS = Object.freeze({
  Applicant: "applications",
  Inquiry: "inquiries",
  Prospect: "prospects",
  Student: "students",
});


async function handlePipelinePeople(request, env, id) {
  const search = new URL(request.url).searchParams;
  const filters = {
    term: String(search.get("term") || "").trim(),
    year: String(search.get("year") || "").trim(),
    status: String(search.get("status") || "applicant").trim().toLowerCase(),
  };

  const stage = Object.keys(FUNNEL_STAGE_STATUS).find(
    (key) => FUNNEL_STAGE_STATUS[key].toLowerCase() === filters.status
  ) || "applications";

  const cacheKey = `pipeline-people:v1:${filters.term}|${filters.year}|${stage}`;

  return serveFunnelRoute(request, env, id, "pipeline-people", cacheKey, async () => {
    const [options, totalsData, settled] = await Promise.all([
      fetchSlateOptions(env, id),
      // Unparameterized: the whole population, tallied by status below.
      proxySlateQuery(env, id, "pipeline-people:totals", [], new URLSearchParams(), null),
      fetchFunnelStages(env, id, "pipeline-people", [stage], filters, null),
    ]);

    const totals = { applications: 0, inquiries: 0, prospects: 0, students: 0 };
    for (const row of rowsOf(totalsData)) {
      const key = PIPELINE_TOTAL_KEYS[plainText(row?.per_status)];
      if (key) totals[key] += 1;
    }

    const failedStages = settled.filter((entry) => entry.failed).map((entry) => entry.stage);

    const payload = {
      pipelines: optionValues(options, PIPELINE_OPTION_KEYS),
      filters: { ...filters, stage },
      totals,
      preApplicationAllTime: !personCreatedWindow(filters.term, filters.year),
      failedStages,
      // Only people who actually sit in a pipeline; the rest are not this
      // portal's subject.
      row: settled
        .flatMap((entry) => entry.rows)
        .filter((row) => plainText(row?.per_pipeline)),
    };

    logInfo(id, "Pipeline people assembled", {
      ...filters,
      stage,
      totals,
      rows: payload.row.length,
      failed: failedStages.length,
    });

    return { payload, complete: !failedStages.length };
  });
}


// ============================================================
// PRIVACY-FRIENDLY PORTAL ANALYTICS
// ============================================================

const ANALYTICS_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const ANALYTICS_IDENTIFIER_PATTERN = /^[a-f0-9-]{20,64}$/i;
const ANALYTICS_PATHS = new Set([
  "/gs.labs/",
  "/gs.labs/funnel-overview/",
  "/gs.labs/reports/funnel-overview/",
  "/gs.labs/pipeline-overview/",
  "/gs.labs/teaching-site-overview/",
  "/gs.labs/reports/teaching-site-overview/",
  "/gs.labs/event-tracker/",
  "/gs.labs/reports/event-tracker/",
  "/gs.labs/public-event-registrants/",
  "/gs.labs/reports/public-event-registrants/",
  "/gs.labs/regional-campus/",
  "/gs.labs/reports/regional-campus/",
  "/gs.labs/student-lookup/",
  "/gs.labs/tools/student-lookup/",
  "/gs.labs/slate-concepts/",
  "/gs.labs/training/slate-concepts/",
  "/gs.labs/queryomatic/",
  "/gs.labs/tools/queryomatic/",
  "/gs.labs/queryomatic/admin/",
  "/gs.labs/tools/queryomatic/admin/",
  "/gs.labs/idea-box/",
  "/gs.labs/tools/idea-box/",
  "/gs.labs/checkin/",
  "/gs.labs/tools/checkin/",
]);

function analyticsLabel(path) {
  const labels = {
    "/gs.labs/": "Admissions",
    "/gs.labs/funnel-overview/": "Funnel Overview",
    "/gs.labs/reports/funnel-overview/": "Funnel Overview",
    "/gs.labs/pipeline-overview/": "Pipeline Overview",
    "/gs.labs/teaching-site-overview/": "Teaching Sites",
    "/gs.labs/reports/teaching-site-overview/": "Teaching Sites",
    "/gs.labs/event-tracker/": "Event Tracker",
    "/gs.labs/reports/event-tracker/": "Event Tracker",
    "/gs.labs/public-event-registrants/": "Public Event Registrants",
    "/gs.labs/reports/public-event-registrants/": "Public Event Registrants",
    "/gs.labs/regional-campus/": "Regional Campus",
    "/gs.labs/reports/regional-campus/": "Regional Campus",
    "/gs.labs/student-lookup/": "Record Lookup",
    "/gs.labs/tools/student-lookup/": "Record Lookup",
    "/gs.labs/slate-concepts/": "Slate Concepts",
    "/gs.labs/training/slate-concepts/": "Slate Concepts",
    "/gs.labs/queryomatic/": "BetterQuery",
    "/gs.labs/tools/queryomatic/": "BetterQuery",
    "/gs.labs/queryomatic/admin/": "BetterQuery Admin",
    "/gs.labs/tools/queryomatic/admin/": "BetterQuery Admin",
    "/gs.labs/idea-box/": "Slate Idea Box",
    "/gs.labs/tools/idea-box/": "Slate Idea Box",
    "/gs.labs/checkin/": "Check-In",
    "/gs.labs/tools/checkin/": "Check-In",
  };

  return labels[path] || path;
}

function cleanAnalyticsPath(value) {
  let path;

  try {
    path = new URL(String(value || ""), "https://example.invalid").pathname;
  } catch {
    return null;
  }

  if (!path.endsWith("/")) path += "/";
  return ANALYTICS_PATHS.has(path) ? path : null;
}

async function recordAnalyticsEvent(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) {
    return json({ error: "Origin not allowed" }, env, 403);
  }

  const body = await request.json();
  const path = cleanAnalyticsPath(body?.path);
  const session = String(body?.session || "");
  const visitor = String(body?.visitor || "");

  if (
    !path ||
    !ANALYTICS_IDENTIFIER_PATTERN.test(session) ||
    (visitor && !ANALYTICS_IDENTIFIER_PATTERN.test(visitor))
  ) {
    return json({ error: "Invalid analytics event" }, env, 400);
  }

  const occurredAt = new Date().toISOString();
  const key = `analytics:event:${occurredAt}:${crypto.randomUUID()}`;

  const metadata = { path, session, occurredAt };
  if (visitor) metadata.visitor = visitor;

  await env.OPTIONS_CACHE.put(key, "1", {
    expirationTtl: ANALYTICS_RETENTION_SECONDS,
    metadata,
  });

  return json({ recorded: true }, env, 202);
}

async function readAnalyticsSummary(url, env) {
  const requestedDays = Number.parseInt(url.searchParams.get("days") || "30", 10);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = [];
  let cursor;

  do {
    const page = await env.OPTIONS_CACHE.list({
      prefix: "analytics:event:",
      cursor,
      limit: 1000,
    });

    for (const key of page.keys) {
      const event = key.metadata;
      const eventTime = Date.parse(event?.occurredAt || "");
      if (event && eventTime >= cutoff && cleanAnalyticsPath(event.path)) {
        events.push(event);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const sessions = new Set();
  const browsers = new Set();
  const daily = new Map();
  const pages = new Map();

  for (const event of events) {
    const date = event.occurredAt.slice(0, 10);
    sessions.add(event.session);
    if (ANALYTICS_IDENTIFIER_PATTERN.test(event.visitor || "")) browsers.add(event.visitor);

    if (!daily.has(date)) daily.set(date, { pageviews: 0, sessions: new Set(), browsers: new Set() });
    const day = daily.get(date);
    day.pageviews += 1;
    day.sessions.add(event.session);
    if (ANALYTICS_IDENTIFIER_PATTERN.test(event.visitor || "")) day.browsers.add(event.visitor);

    if (!pages.has(event.path)) pages.set(event.path, { pageviews: 0, sessions: new Set(), browsers: new Set() });
    const page = pages.get(event.path);
    page.pageviews += 1;
    page.sessions.add(event.session);
    if (ANALYTICS_IDENTIFIER_PATTERN.test(event.visitor || "")) page.browsers.add(event.visitor);
  }

  return json({
    days,
    generatedAt: new Date().toISOString(),
    pageviews: events.length,
    visits: sessions.size,
    uniqueBrowsers: browsers.size,
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, pageviews: value.pageviews, visits: value.sessions.size, uniqueBrowsers: value.browsers.size })),
    pages: [...pages.entries()]
      .map(([path, value]) => ({
        path,
        label: analyticsLabel(path),
        pageviews: value.pageviews,
        visits: value.sessions.size,
        uniqueBrowsers: value.browsers.size,
      }))
      .sort((a, b) => b.pageviews - a.pageviews || a.label.localeCompare(b.label)),
  }, env);
}


// ============================================================
// UTF-8 / BASE64
// ============================================================

function utf8ToBase64(text) {
  const bytes =
    new TextEncoder().encode(text);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {

    const chunk =
      bytes.subarray(
        i,
        i + chunkSize
      );

    binary +=
      String.fromCharCode(...chunk);
  }

  return btoa(binary);
}


function base64ToUtf8(base64) {
  const cleaned =
    String(base64 || "")
      .replace(/\s/g, "");

  const binary =
    atob(cleaned);

  const bytes =
    new Uint8Array(binary.length);

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return new TextDecoder()
    .decode(bytes);
}


// ============================================================
// GITHUB HELPERS
// ============================================================

function githubHeaders(env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "queryomatic-cloudflare-worker",
  };
}


// ============================================================
// GET OPTIONS.MD FROM GITHUB
// ============================================================

async function getGitHubOptionsFile(
  env,
  id
) {

  logInfo(
    id,
    "Fetching options.md from GitHub"
  );

  const url =
    `${GITHUB_API_URL}` +
    `?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  const resp = await fetch(
    url,
    {
      method: "GET",
      headers: githubHeaders(env),
    }
  );

  const responseText =
    await resp.text();

  logInfo(
    id,
    "GitHub options.md response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 2000),
    }
  );

  if (!resp.ok) {

    throw new Error(
      `Unable to read options.md from GitHub: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 1500)}`
    );
  }


  let data;

  try {
    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "GitHub returned invalid JSON while reading options.md"
    );
  }


  if (!data.sha) {
    throw new Error(
      "GitHub options.md response did not contain a SHA"
    );
  }


  if (!data.content) {
    throw new Error(
      "GitHub options.md response did not contain file content"
    );
  }


  const markdown =
    base64ToUtf8(data.content);


  return {
    sha: data.sha,
    markdown,
  };
}


// ============================================================
// FETCH OPTIONS FROM SLATE
// ============================================================

async function fetchSlateOptions(
  env,
  id
) {

  logInfo(
    id,
    "Starting Slate OPTIONS request",
    {
      url:
        safeUrl(env.SLATE_OPTIONS_URL),

      token:
        secretStatus(
          env.SLATE_TOKEN_PROMPTS
        ),
    }
  );


  if (!env.SLATE_OPTIONS_URL) {

    throw new Error(
      "SLATE_OPTIONS_URL is missing"
    );
  }


  if (!env.SLATE_TOKEN_PROMPTS) {

    throw new Error(
      "SLATE_TOKEN_PROMPTS is missing"
    );
  }


  const resp = await fetch(
    env.SLATE_OPTIONS_URL,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.SLATE_TOKEN_PROMPTS}`,

        Accept:
          "application/json",
      },
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Slate OPTIONS response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Slate OPTIONS request failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  try {

    return JSON.parse(
      responseText
    );

  } catch {

    throw new Error(
      `Slate OPTIONS returned invalid JSON. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }
}


// ============================================================
// GROUP SLATE OPTIONS
// ============================================================

function groupSlateOptions(data) {

  const rows =
    Array.isArray(data?.row)
      ? data.row
      : [];


  const groups = {};

  let validRowCount = 0;


  for (const row of rows) {

    const key =
      row?.key == null
        ? ""
        : String(row.key).trim();


    const value =
      row?.value == null
        ? ""
        : String(row.value).trim();


    // Ignore null / blank rows
    if (!key || !value) {
      continue;
    }


    validRowCount++;


    if (!groups[key]) {
      groups[key] =
        new Set();
    }


    groups[key].add(value);
  }


  return {
    groups,
    validRowCount,
    totalRowCount: rows.length,
  };
}


// ============================================================
// REGEX HELPER
// ============================================================

function escapeRegExp(value) {

  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}


// ============================================================
// BUILD VALUES BLOCK
// ============================================================

function buildValuesBlock(
  key,
  values
) {

  const start =
    `<!-- VALUES:${key} START -->`;

  const end =
    `<!-- VALUES:${key} END -->`;


  const list =
    values
      .map(
        value =>
          `- ${value}`
      )
      .join("\n");


  return `${start}

${list}

${end}`;
}


// ============================================================
// BUILD A BRAND NEW KEY SECTION
// ============================================================

function buildNewKeySection(
  key,
  values
) {

  const valuesBlock =
    buildValuesBlock(
      key,
      values
    );


  return `## ${key}

### Context

_Add context for this parameter here._

### Valid Values

${valuesBlock}`;
}


// ============================================================
// FIND MARKDOWN KEY SECTION
//
// Finds:
//
// ## program
//
// ...content...
//
// until the next:
//
// ## another-key
//
// or EOF.
// ============================================================

function findKeySection(
  markdown,
  key
) {

  const headingPattern =
    new RegExp(
      `^##\\s+${escapeRegExp(key)}\\s*$`,
      "mi"
    );


  const match =
    headingPattern.exec(markdown);


  if (!match) {
    return null;
  }


  const start =
    match.index;


  const afterHeading =
    match.index +
    match[0].length;


  const rest =
    markdown.slice(
      afterHeading
    );


  const nextHeading =
    /^##\s+/m.exec(rest);


  const end =
    nextHeading
      ? afterHeading +
        nextHeading.index
      : markdown.length;


  return {
    start,
    end,
    text:
      markdown.slice(
        start,
        end
      ),
  };
}


// ============================================================
// UPDATE OPTIONS.MD
//
// Important:
//
// JavaScript ONLY modifies:
//
// <!-- VALUES:key START -->
//
// ...
//
// <!-- VALUES:key END -->
//
// Everything else is preserved.
//
// If a key does not exist yet, a new section is created.
// ============================================================

function updateOptionsMarkdown(
  existingMarkdown,
  groups
) {

  let markdown =
    String(existingMarkdown || "")
      .replace(/\r\n/g, "\n");


  // If options.md is basically empty,
  // give it a useful title.
  if (!markdown.trim()) {

    markdown =
`# Queryomatic Options

> Parameter reference used by Queryomatic.

`;
  }


  const keys =
    Object.keys(groups)
      .sort(
        (a, b) =>
          a.localeCompare(
            b,
            undefined,
            {
              numeric: true,
              sensitivity: "base",
            }
          )
      );


  for (const key of keys) {

    const values =
      [...groups[key]]
        .sort(
          (a, b) =>
            a.localeCompare(
              b,
              undefined,
              {
                numeric: true,
                sensitivity: "base",
              }
            )
        );


    const valuesStart =
      `<!-- VALUES:${key} START -->`;

    const valuesEnd =
      `<!-- VALUES:${key} END -->`;


    const newValuesBlock =
      buildValuesBlock(
        key,
        values
      );


    // --------------------------------------------------------
    // CASE 1
    //
    // Existing generated block exists.
    //
    // Replace ONLY the contents between its markers.
    // --------------------------------------------------------

    if (
      markdown.includes(valuesStart) &&
      markdown.includes(valuesEnd)
    ) {

      const pattern =
        new RegExp(
          escapeRegExp(valuesStart) +
          "[\\s\\S]*?" +
          escapeRegExp(valuesEnd),
          "g"
        );


      markdown =
        markdown.replace(
          pattern,
          newValuesBlock
        );


      continue;
    }


    // --------------------------------------------------------
    // CASE 2
    //
    // The ## key section exists,
    // but it doesn't have VALUES markers yet.
    //
    // Preserve everything already inside that section
    // and append Valid Values at the bottom.
    // --------------------------------------------------------

    const section =
      findKeySection(
        markdown,
        key
      );


    if (section) {

      let sectionText =
        section.text
          .trimEnd();


      sectionText +=
`

### Valid Values

${newValuesBlock}

`;


      markdown =
        markdown.slice(
          0,
          section.start
        ) +
        sectionText +
        markdown.slice(
          section.end
        );


      continue;
    }


    // --------------------------------------------------------
    // CASE 3
    //
    // Brand new Slate key.
    //
    // Create a new section with an editable Context area.
    // --------------------------------------------------------

    const newSection =
      buildNewKeySection(
        key,
        values
      );


    markdown =
      markdown.trimEnd() +
      `\n\n${newSection}\n`;
  }


  return (
    markdown.trimEnd() +
    "\n"
  );
}


// ============================================================
// COMMIT OPTIONS.MD TO GITHUB
// ============================================================

async function commitOptionsMarkdown(
  env,
  id,
  markdown,
  currentSha
) {

  if (!env.GITHUB_TOKEN) {

    throw new Error(
      "GITHUB_TOKEN is missing"
    );
  }


  if (!currentSha) {

    throw new Error(
      "Cannot update options.md without its current GitHub SHA"
    );
  }


  logInfo(
    id,
    "Committing updated options.md to GitHub",
    {
      repo:
        `${GITHUB_OWNER}/${GITHUB_REPO}`,

      branch:
        GITHUB_BRANCH,

      path:
        GITHUB_OPTIONS_PATH,

      markdownLength:
        markdown.length,
    }
  );


  const encodedContent =
    utf8ToBase64(markdown);


  const body = {
    message:
      "Refresh Queryomatic options from Slate",

    content:
      encodedContent,

    sha:
      currentSha,

    branch:
      GITHUB_BRANCH,
  };


  const resp = await fetch(
  GITHUB_API_URL,
  {
    method: "PUT",

    headers: {
      ...githubHeaders(env),
      "Content-Type": "application/json",
    },

    body: JSON.stringify(body),
  }
);

const responseText = await resp.text();

logInfo(
  id,
  "GitHub commit response",
  {
    url: GITHUB_API_URL,
    status: resp.status,
    statusText: resp.statusText,
    contentType: resp.headers.get("content-type"),
    server: resp.headers.get("server"),
    cfRay: resp.headers.get("cf-ray"),
    body: responseText.slice(0, 3000),
  }
);


  if (!resp.ok) {

    throw new Error(
      `GitHub update failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  let data;

  try {

    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "GitHub returned invalid JSON after updating options.md"
    );
  }


  return data;
}


// ============================================================
// REFRESH OPTIONS FROM SOURCE
// ============================================================

async function refreshOptionsFromSlate(
  env,
  id
) {

  // ----------------------------------------------------------
  // STEP 1
  // Query Slate
  // ----------------------------------------------------------

  const slateData =
    await fetchSlateOptions(
      env,
      id
    );


  // ----------------------------------------------------------
  // STEP 2
  // Group key/value pairs
  // ----------------------------------------------------------

  const {
    groups,
    validRowCount,
    totalRowCount,
  } =
    groupSlateOptions(
      slateData
    );


  const keys =
    Object.keys(groups);


  logInfo(
    id,
    "Slate options grouped",
    {
      totalRowCount,
      validRowCount,
      keyCount: keys.length,
      keys,
    }
  );


  // ----------------------------------------------------------
  // SAFETY CHECK
  //
  // Never overwrite GitHub if Slate returned
  // no useful data.
  // ----------------------------------------------------------

  if (
    validRowCount === 0 ||
    keys.length === 0
  ) {

    throw new Error(
      `Slate returned ${totalRowCount} rows but ` +
      `0 valid key/value option rows. ` +
      `options.md was NOT changed.`
    );
  }


  // ----------------------------------------------------------
  // STEP 3
  // Read current options.md
  // ----------------------------------------------------------

  const currentFile =
    await getGitHubOptionsFile(
      env,
      id
    );


  // ----------------------------------------------------------
  // STEP 4
  // Replace generated values
  // ----------------------------------------------------------

  const updatedMarkdown =
    updateOptionsMarkdown(
      currentFile.markdown,
      groups
    );


  // ----------------------------------------------------------
  // STEP 5
  // Don't create pointless commits
  // ----------------------------------------------------------

  if (
    updatedMarkdown ===
    currentFile.markdown
  ) {

    logInfo(
      id,
      "Options are already current; skipping GitHub commit"
    );


    return {
      updated: false,
      committed: false,

      message:
        "options.md is already up to date",

      keyCount:
        keys.length,

      validRowCount,
      totalRowCount,

      keys,
    };
  }


  // ----------------------------------------------------------
  // STEP 6
  // Commit updated file
  // ----------------------------------------------------------

  const githubResult =
    await commitOptionsMarkdown(
      env,
      id,
      updatedMarkdown,
      currentFile.sha
    );


  return {
    updated: true,
    committed: true,

    message:
      "options.md refreshed from Slate and committed to GitHub",

    keyCount:
      keys.length,

    validRowCount,
    totalRowCount,

    keys,

    commitSha:
      githubResult?.commit?.sha || null,

    commitUrl:
      githubResult?.commit?.html_url || null,
  };
}


// ============================================================
// ANTHROPIC
// ============================================================

async function generateQueryParams(
  env,
  id,
  userPrompt,
  optionsMarkdown
) {

  logInfo(
    id,
    "Starting Anthropic request",
    {
      promptLength:
        userPrompt.length,

      optionsLength:
        optionsMarkdown.length,

      apiKey:
        secretStatus(
          env.ANTHROPIC_API_KEY
        ),
    }
  );


  if (!env.ANTHROPIC_API_KEY) {

    throw new Error(
      "ANTHROPIC_API_KEY is missing"
    );
  }


  const currentDate =
    new Date()
      .toISOString()
      .slice(0, 10);

  const emptyParameters =
    JSON.stringify(
      normalizeQueryParams({}),
      null,
      2
    );


  const systemPrompt =
`You translate a staff member's plain-English request into query parameters for a Slate admissions export.

You have a Markdown reference document called options.md.

Each parameter is represented by a section such as:

## program

### Context

Human-written instructions explaining how the parameter should be interpreted.

### Valid Values

A generated list containing the exact valid values from Slate.

Use BOTH the Context and Valid Values when interpreting the user's request.

The Context explains aliases, terminology, behavior, and interpretation.

The Valid Values section contains values that may actually be sent to Slate.

Do not invent parameter values.

If the user does not specify a parameter, leave that parameter as an empty string.

If the user's language corresponds to an alias or instruction in a Context section, translate it to the appropriate exact value from Valid Values.

The output keys are Slate query parameter names. Map them to these options.md sections when a fixed list of values applies:

- term: academic_term
- year: academic_year
- status: person_status
- pipeline: pipelines
- teachingsite: teachingsites
- program: program
- app_code: Decision Code
- campus_assigned: campus
- alt_form_type: alt_form_type

The first, last, and sisid parameters are free text and do not require a Valid Values lookup. Use first and last only when the user identifies a person by name. For a clearly stated full name, put all given-name words in first and the family name in last. Use sisid for an explicitly provided student/SIS ID.

Use the exact Valid Values from the mapped section. For a shorthand location such as "Burbank", select the one teaching-site or campus value that contains that location name.

Today is ${currentDate}. Resolve relative academic-term language when possible. For example, "this fall" means term "Fall" and the academic-year value whose first year is this calendar year. Thus, during 2026, "this fall" maps to year "2026-2027".

When the user asks for people associated with events or event registrations, set alt_form_type to the exact value "Event". Otherwise leave alt_form_type empty.

When the user asks for "students", use the exact person_status value "Student" in the status output key. When they ask for admitted students or admitted applications, use status "Student" and decision code "AT". For provisionally admitted students, use decision code "ATP" instead.

Application Created Date is a date range. Use app_createddate_start for the inclusive beginning of the requested range and app_createddate_end for the inclusive end. Return dates in YYYY-MM-DD format. If the user provides only one boundary, leave the other boundary empty. If they name a full month, use its first and last calendar dates. Never return app_createddate.

OPTIONS.MD
============================================================

${optionsMarkdown}

============================================================
END OPTIONS.MD

Respond with ONLY a JSON object using exactly these keys:

${emptyParameters}

No prose.
No explanation.
No markdown fences.`;


  const resp = await fetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-api-key":
          env.ANTHROPIC_API_KEY,

        "anthropic-version":
          "2023-06-01",
      },

      body:
        JSON.stringify({
          model:
            "claude-haiku-4-5-20251001",

          max_tokens:
            500,

          system:
            systemPrompt,

          messages: [
            {
              role: "user",
              content: userPrompt,
            },
          ],
        }),
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Anthropic response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Anthropic API error: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  let data;

  try {

    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      `Anthropic returned invalid JSON: ` +
      responseText.slice(0, 2000)
    );
  }


  if (!data.content) {

    throw new Error(
      "Anthropic response did not contain content"
    );
  }


  const text =
    data.content
      .map(
        block =>
          block.type === "text"
            ? block.text
            : ""
      )
      .join("");


  const cleaned =
    text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();


  logInfo(
    id,
    "Anthropic generated parameters",
    {
      response: cleaned,
    }
  );


  try {

    return normalizeQueryParams(
      JSON.parse(
        cleaned
      )
    );

  } catch {

    throw new Error(
      `Anthropic returned invalid parameter JSON: ` +
      cleaned.slice(0, 2000)
    );
  }
}


// ============================================================
// MAIN SLATE QUERY
// ============================================================

async function runSlateQuery(
  env,
  id,
  params
) {

  const normalizedParams =
    normalizeQueryParams(params);

  logInfo(
    id,
    "Starting main Slate query",
    {
      baseUrl:
        safeUrl(
          env.SLATE_QUERY_URL
        ),

      token:
        secretStatus(
          env.SLATE_TOKEN_MAINDB
        ),

      params:
        normalizedParams,
    }
  );


  if (!env.SLATE_QUERY_URL) {

    throw new Error(
      "SLATE_QUERY_URL is missing"
    );
  }


  if (!env.SLATE_TOKEN_MAINDB) {

    throw new Error(
      "SLATE_TOKEN_MAINDB is missing"
    );
  }


  const url =
    new URL(
      env.SLATE_QUERY_URL
    );


  url.searchParams.set(
    "output",
    "json"
  );


  for (
    const [key, value]
    of Object.entries(normalizedParams)
  ) {

    url.searchParams.set(
      key,
      value ?? ""
    );
  }


  logInfo(
    id,
    "Final Slate query URL",
    {
      url:
        safeUrl(
          url.toString()
        ),
    }
  );


  const resp = await fetch(
    url.toString(),
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.SLATE_TOKEN_MAINDB}`,

        Accept:
          "application/json",
      },
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Main Slate query response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Slate MAIN query failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  try {

    return JSON.parse(
      responseText
    );

  } catch {

    throw new Error(
      `Slate MAIN query returned invalid JSON: ` +
      responseText.slice(0, 2000)
    );
  }
}


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const id =
      requestId();


    const url =
      new URL(
        request.url
      );


    logInfo(
      id,
      "========== NEW REQUEST ==========",
      {
        method:
          request.method,

        pathname:
          url.pathname,

        search:
          url.search,
      }
    );


    // ========================================================
    // CORS
    // ========================================================

    if (
      request.method === "OPTIONS"
    ) {

      const requestOrigin = request.headers.get("Origin");
      const reflectedOrigin =
        requestOrigin === env.PORTAL_ORIGIN
          ? env.PORTAL_ORIGIN
          : env.ALLOWED_ORIGIN;

      return new Response(
        null,
        {
          headers:
            corsHeaders(env, reflectedOrigin),
        }
      );
    }


    try {

      if (
        url.pathname === "/api/analytics/event" &&
        request.method === "POST"
      ) {
        return await recordAnalyticsEvent(request, env);
      }

      // ======================================================
      // SLATE PORTAL PROXY ROUTES
      //
      // Every route is a parameter set over the shared maindb
      // query, except portal-options, which reads the prompts
      // query. Called from Slate portal wrapper pages at
      // PORTAL_ORIGIN, not from ALLOWED_ORIGIN — see
      // handleSlateProxyRoute.
      // ======================================================

      if (
        url.pathname === "/api/slate/teaching-site-people" &&
        request.method === "GET"
      ) {
        return await handleTeachingSitePeople(request, env, id);
      }

      if (
        url.pathname === "/api/slate/regional-campus-people" &&
        request.method === "GET"
      ) {
        return await handleRegionalCampusPeople(request, env, id);
      }

      if (
        url.pathname === "/api/slate/pipeline-people" &&
        request.method === "GET"
      ) {
        return await handlePipelinePeople(request, env, id);
      }

      if (
        url.pathname === "/api/slate/teaching-site-counts" &&
        request.method === "GET"
      ) {
        return await handleSlateProxyRoute(
          request, env, id, "teaching-site-counts", "maindb",
          ["status", "year", "term", "site"]
        );
      }

      if (
        url.pathname === "/api/slate/records" &&
        request.method === "GET"
      ) {
        return await handleSlateProxyRoute(
          request, env, id, "records", "maindb",
          ["status", "year", "term", "teachingsite", "first", "last", "sisid", "alt_form_type"]
        );
      }

      if (
        url.pathname === "/api/slate/inquiries" &&
        request.method === "GET"
      ) {
        // status=Inquiry is pinned here because this route replaced a
        // dedicated inquiry-only Slate query. Both callers relabel every row
        // they get back as an inquiry, so an unconstrained population would
        // report students and prospects as inquiries.
        return await handleSlateProxyRoute(
          request, env, id, "inquiries", "maindb",
          ["campus", "teachingsite", "person_created_date_start", "person_created_date_end"],
          { status: "Inquiry" }
        );
      }

      if (
        url.pathname === "/api/slate/portal-options" &&
        request.method === "GET"
      ) {
        return await handleSlateProxyRoute(
          request, env, id, "portal-options", "prompts",
          []
        );
      }

      if (
        url.pathname === "/api/slate/regional-campus-records" &&
        request.method === "GET"
      ) {
        return await handleSlateProxyRoute(
          request, env, id, "regional-campus-records", "maindb",
          ["campus", "term", "year"]
        );
      }

      if (
        url.pathname === "/api/slate/additional-applications" &&
        request.method === "GET"
      ) {
        return await handleSlateProxyRoute(
          request, env, id, "additional-applications", "maindb",
          ["sisid"]
        );
      }

      // Called directly from tools/checkin/'s own script (GitHub Pages
      // origin), not a Slate wrapper — see handlePagesSlateProxyRoute.
      if (
        url.pathname === "/api/slate/checkin-search" &&
        request.method === "GET"
      ) {
        return await handlePagesSlateProxyRoute(
          request, env, id, "checkin-search",
          ["first", "last", "sisid", "per_guid"],
          CHECKIN_FIXED_PARAMS
        );
      }

      // Re-serves a per_qr_url PNG with CORS headers so tools/checkin/ can
      // read its bytes for Dymo printing — see handleCheckinQrImage.
      if (
        url.pathname === "/api/slate/checkin-qr-image" &&
        request.method === "GET"
      ) {
        return await handleCheckinQrImage(request, env, id);
      }

      if (
        url.pathname === "/api/analytics/summary" &&
        request.method === "GET"
      ) {
        return await readAnalyticsSummary(url, env);
      }


      // ======================================================
      // GET CURRENT OPTIONS.MD
      //
      // Read-only.
      //
      // Does NOT query Slate.
      // Does NOT commit anything.
      // ======================================================

      if (
        url.pathname === "/api/options" &&
        request.method === "GET"
      ) {

        const file =
          await getGitHubOptionsFile(
            env,
            id
          );


        return json(
          {
            markdown:
              file.markdown,

            source:
              "github",

            repository:
              `${GITHUB_OWNER}/${GITHUB_REPO}`,

            branch:
              GITHUB_BRANCH,

            path:
              GITHUB_OPTIONS_PATH,

            requestId:
              id,
          },
          env
        );
      }


      // ======================================================
      // REFRESH FROM SOURCE
      //
      // POST only.
      //
      // Slate
      //   ↓
      // JS transformation
      //   ↓
      // options.md
      //   ↓
      // GitHub commit
      // ======================================================

      if (
        url.pathname ===
          "/api/options/refresh" &&

        request.method ===
          "POST"
      ) {

        logInfo(
          id,
          "Refresh from Source requested"
        );


        const result =
          await refreshOptionsFromSlate(
            env,
            id
          );


        return json(
          {
            ...result,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // GENERATE QUERY PARAMETERS
      //
      // Reads options.md directly from GitHub.
      // ======================================================

      if (
        url.pathname ===
          "/api/generate" &&

        request.method ===
          "POST"
      ) {

        const body =
          await request.json();


        const prompt =
          body?.prompt;


        if (
          !prompt ||
          !String(prompt).trim()
        ) {

          return json(
            {
              error:
                "Missing 'prompt'",

              requestId:
                id,
            },
            env,
            400
          );
        }


        // Always get current
        // options.md from GitHub.
        const file =
          await getGitHubOptionsFile(
            env,
            id
          );


        const params =
          await generateQueryParams(
            env,
            id,
            String(prompt),
            file.markdown
          );


        return json(
          {
            params,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // RUN MAIN SLATE QUERY
      // ======================================================

      if (
        url.pathname ===
          "/api/run" &&

        request.method ===
          "POST"
      ) {

        const body =
          await request.json();


        const params =
          body?.params;


        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params)
        ) {

          return json(
            {
              error:
                "Missing 'params'",

              requestId:
                id,
            },
            env,
            400
          );
        }


        const data =
          await runSlateQuery(
            env,
            id,
            params
          );


        return json(
          {
            data,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // NOT FOUND
      // ======================================================

      return json(
        {
          error:
            "Not found",

          requestId:
            id,

          path:
            url.pathname,

          method:
            request.method,
        },
        env,
        404
      );


    } catch (err) {


      // ======================================================
      // ERROR
      // ======================================================

      logError(
        id,
        "REQUEST FAILED",
        {
          message:
            err?.message,

          name:
            err?.name,

          stack:
            err?.stack,
        }
      );


      return json(
        {
          error:
            err?.message ||
            "Unknown error",

          requestId:
            id,
        },
        env,
        500,
        url.pathname === "/api/slate/checkin-search" || url.pathname === "/api/slate/checkin-qr-image"
          ? env.ALLOWED_ORIGIN
          : url.pathname.startsWith("/api/slate/") ? env.PORTAL_ORIGIN : undefined
      );
    }
  },
};
