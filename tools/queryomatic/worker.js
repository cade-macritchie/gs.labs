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
 * - GET /api/slate/teaching-site-trend        (teaching-site-overview wrapper)
 * - GET /api/slate/regional-campus-people     (regional-campus wrapper)
 * - GET /api/slate/pipeline-people            (pipeline-overview wrapper)
 * - GET /api/slate/teaching-site-counts       (no portal caller; kept for ad-hoc use)
 * - GET /api/slate/records                    (student-lookup, event-tracker wrappers)
 * - GET /api/slate/inquiries                  (regional-campus wrapper)
 * - GET /api/slate/portal-options             (teaching-site-overview, regional-campus wrappers)
 * - GET /api/slate/regional-campus-records    (regional-campus wrapper)
 * - GET /api/slate/additional-applications    (student-lookup wrapper)
 *
 * - GET /api/slate/checkin-search             (tools/checkin/ last-name lookup of BTC 2027
 *   individual registrants, called directly from GitHub Pages — NOT a Slate
 *   wrapper. Backed by its own Slate query, not maindb, and gated by
 *   ALLOWED_ORIGIN + the CHECKIN_KEY passcode. See "CHECK-IN LAST-NAME LOOKUP".)
 * - GET /api/slate/btc-email-check            (BTC 2027 individual registration form script:
 *   is this email already registered? yes/no only. PORTAL_ORIGIN + rate limit,
 *   no key. See "BTC DUPLICATE-EMAIL CHECK".)
 * - GET /api/slate/checkin-qr-image           (tools/checkin/, re-serves a per_qr_url PNG
 *   with CORS headers — also ALLOWED_ORIGIN-gated. See handleCheckinQrImage.)
 * - POST /api/checkin/print-queue             (tools/checkin/ scanners queue a print job)
 * - GET  /api/checkin/print-station           (tools/checkin/ print station WebSocket, or a
 *   one-off connected check — both backed by the CheckinPrintQueue Durable Object,
 *   one instance per station name. See "CHECK-IN PRINT QUEUE".)
 *
 * - POST /api/mailings/analyze                (mailing-success wrapper: asks Claude what the
 *   top and bottom ranked mailings have in common. PORTAL_ORIGIN + key gated.
 *   See "MAILING SUCCESS AI ANALYSIS".)
 *
 *
 * Secrets (names only — set with `wrangler secret put <NAME>`):
 * - SLATE_TOKEN_PROMPTS                        (prompts query: options refresh + /api/slate/portal-options)
 * - SLATE_TOKEN_MAINDB                         (maindb query: /api/run + every other /api/slate/* route)
 * - ANTHROPIC_API_KEY                          (Queryomatic /api/generate, /api/mailings/analyze)
 * - GITHUB_TOKEN                               (Queryomatic options.md commits)
 * - SLATE_OPTIONS_URL                          (prompts query URL)
 * - SLATE_QUERY_URL                            (maindb query URL)
 * - PORTAL_KEY                                 (shared gateway key the Slate portal views send
 *                                               as X-GS-Key — see gatewayKeyAllowed. Unset = not
 *                                               enforced, so code can deploy before Slate is ready.)
 * - SLATE_CHECKIN_QUERY_URL                    (checkin_btc_registrants query: /api/slate/checkin-search)
 * - SLATE_TOKEN_CHECKIN                        (that query's token)
 * - SLATE_BTC_EMAIL_QUERY_URL                  (btc_registrant_email_check query: /api/slate/btc-email-check)
 * - SLATE_TOKEN_BTC_EMAIL                      (that query's token. Either unset = check returns 503,
 *                                               and the form lets people submit.)
 * - CHECKIN_KEY                                (passcode tools/checkin/ devices send as X-Checkin-Key
 *                                               for the last-name lookup. Unset = lookup refused.)
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
  "person_created_date_start",
  "person_created_date_end",
  "campus_assigned",
  "alt_form_type",
  // Added 2026-10-12. Each is an ignore-when-blank filter on all_people.
  "app_status",
  "app_round",
  "app_f1",
  "app_submitted_start",
  "app_submitted_end",
  "app_decision_date_start",
  "app_decision_date_end",
  "academic_interest",
  "degree_interest",
  "entry_term",
  "entry_year",
  "marital_status",
  // The four event_* filters apply together: a person matches when at least
  // one non-cancelled event registration satisfies all of the ones given.
  "event_title",
  "event_date_start",
  "event_date_end",
  "event_attended",
]);

// Date-typed maindb parameters: Slate rejects "" for these, so a blank is
// omitted from the query rather than sent empty.
const DATE_PARAMETER_KEYS = Object.freeze([
  "app_createddate_start",
  "app_createddate_end",
  "person_created_date_start",
  "person_created_date_end",
  "app_submitted_start",
  "app_submitted_end",
  "app_decision_date_start",
  "app_decision_date_end",
  "event_date_start",
  "event_date_end",
]);

// The date fields expect M/D/YYYY (no leading zeros); the model
// returns YYYY-MM-DD. Anything that isn't a YYYY-MM-DD date passes through.
function toSlatePersonDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : value;
}

// maindb's date filters compare `@end > field`, and a bare date means
// midnight, so the end day itself would be left out. Queryomatic promises
// inclusive ranges, so a YYYY-MM-DD end bound is moved to the next day.
function inclusiveEndDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return next.toISOString().slice(0, 10);
}



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
      "Content-Type, X-GS-Key, X-Checkin-Key",
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


// originAllowed only stops OTHER WEBSITES running in a browser: a script can
// send any Origin/Referer it likes, and this Worker's URL is in the public
// repo. The shared key is what stops a caller who just knows the URL. It lives
// as the PORTAL_KEY secret here and in each Slate portal view (as
// window.GS_GATEWAY_KEY), never in this repo, so only signed-in Slate users
// ever see it. While PORTAL_KEY is unset this passes, so the Worker can be
// deployed before the portal views send the key.
function gatewayKeyAllowed(request, env) {
  if (!env.PORTAL_KEY) return true;
  return keysMatch(request.headers.get("X-GS-Key") || "", String(env.PORTAL_KEY));
}

// Constant-time compare, written out so it also runs under the Node demo.
function keysMatch(sent, expected) {
  if (sent.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= sent.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}


// Origin, key and rate limit, in that order. Returns the error Response to
// send, or null when the request may proceed.
async function guardRoute(request, env, id, bucket, allowedOrigin) {
  if (!originAllowed(request, allowedOrigin)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, allowedOrigin);
  }

  if (!gatewayKeyAllowed(request, env)) {
    return json({ error: "Missing or invalid gateway key", requestId: id }, env, 401, allowedOrigin);
  }

  if (!(await checkRateLimit(env, request, bucket))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, allowedOrigin);
  }

  return null;
}


// Person-level routes whose every filter is optional would otherwise return
// the whole maindb population when called with no parameters. These must be
// given at least one non-blank filter.
const ROUTES_REQUIRING_A_FILTER = new Set([
  "records",
  "checkin-search",
  "additional-applications",
]);

function hasAnyFilter(searchParams, allowedParams) {
  return allowedParams.some((key) => String(searchParams.get(key) || "").trim() !== "");
}

const QUERYOMATIC_GUARDED_PATHS = new Set([
  "/api/run",
  "/api/generate",
  "/api/options/refresh",
]);

function missingFilterResponse(env, id, origin) {
  return json({ error: "At least one filter is required", requestId: id }, env, 400, origin);
}


// 60 requests per IP per route per minute, set on the RATE_LIMITER binding in
// wrangler.toml. This used to be a KV counter, which cost one KV write per
// request: an open tools/checkin/ print station polls every 2.5s, so it alone
// wrote ~1,440 times an hour — past Workers Free's 1,000 writes/day within
// the hour, at which point every KV write in this Worker starts failing.
async function checkRateLimit(env, request, bucket) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: `${bucket}:${ip}` });
  return success;
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
  const denied = await guardRoute(request, env, id, routeName, env.PORTAL_ORIGIN);
  if (denied) return denied;

  const searchParams = new URL(request.url).searchParams;
  if (ROUTES_REQUIRING_A_FILTER.has(routeName) && !hasAnyFilter(searchParams, allowedParams)) {
    return missingFilterResponse(env, id, env.PORTAL_ORIGIN);
  }

  const data = source === "prompts"
    ? await fetchSlateOptions(env, id)
    : await proxySlateQuery(env, id, routeName, allowedParams, searchParams, fixedParams);

  return json(data, env, 200, env.PORTAL_ORIGIN);
}


// ============================================================
// CHECK-IN LAST-NAME LOOKUP (GET /api/slate/checkin-search?last=<name>)
//
// For a BTC 2027 registrant who can't pull up their mobile pass:
// tools/checkin/ sends a last name and gets back the matching individual
// registrants (name, church, and their registration GUID, which is the id
// in their mobile-pass link). Tapping one prints the same label a scan of
// that pass would. See tools/checkin/README.md.
//
// Backed by its own Slate query (checkin_btc_registrants, SLATE_CHECKIN_QUERY_URL),
// NOT maindb. Checked read-only 2026-10-27: all_people filtered to the BTC
// 2027 event (event_title + event_date_*) is one row per person with no
// registration/pass GUID, QR value or church column, so a lookup there
// couldn't print a badge. The query's own filter pins it to the BTC 2027
// individual registration form, and the only parameter is `last`, so a
// caller can't widen it to anyone else.
//
// Not behind PORTAL_KEY: the page runs on GitHub Pages and on volunteers'
// tablets, which must never hold the gateway key (it unlocks every maindb
// route). It's gated instead by a separate passcode, the CHECKIN_KEY secret,
// typed once per device and sent as X-Checkin-Key. Unlike PORTAL_KEY, an
// unset CHECKIN_KEY refuses every lookup, since a last-name search is
// enumerable in a way a pass GUID isn't. Origin, rate limit and the
// required-filter rule apply as on every other person-level route, and only
// the three fields the page shows are returned.
// ============================================================

const CHECKIN_SEARCH_MAX_RESULTS = 25;
// A last name of 2-60 letters, spaces, apostrophes, periods or hyphens.
const CHECKIN_LAST_NAME_PATTERN = /^[\p{L}][\p{L} '’.-]{1,59}$/u;

async function handleCheckinSearch(request, env, id) {
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.ALLOWED_ORIGIN);
  }

  if (!env.CHECKIN_KEY || !env.SLATE_CHECKIN_QUERY_URL || !env.SLATE_TOKEN_CHECKIN) {
    return json({ error: "Last-name lookup isn't set up yet", requestId: id }, env, 503, env.ALLOWED_ORIGIN);
  }

  if (!keysMatch(request.headers.get("X-Checkin-Key") || "", String(env.CHECKIN_KEY))) {
    return json({ error: "Missing or wrong check-in passcode", requestId: id }, env, 401, env.ALLOWED_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "checkin-search"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.ALLOWED_ORIGIN);
  }

  const searchParams = new URL(request.url).searchParams;
  if (ROUTES_REQUIRING_A_FILTER.has("checkin-search") && !hasAnyFilter(searchParams, ["last"])) {
    return missingFilterResponse(env, id, env.ALLOWED_ORIGIN);
  }

  const last = String(searchParams.get("last") || "").trim().replace(/\s+/g, " ");
  if (!CHECKIN_LAST_NAME_PATTERN.test(last)) {
    return json({ error: "Type at least two letters of a last name", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }

  const url = new URL(env.SLATE_CHECKIN_QUERY_URL);
  url.searchParams.set("output", "json");
  url.searchParams.set("last", last);
  // Logs the route and result count only, never the name searched for.
  logInfo(id, "Checkin search request", { route: "checkin-search" });

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.SLATE_TOKEN_CHECKIN}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    logError(id, "Checkin search query failed", { status: resp.status });
    throw new Error(`Slate query failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("Slate query returned invalid JSON");
  }

  const text = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  const results = (Array.isArray(data?.row) ? data.row : [])
    .map((row) => ({
      id: text(row?.reg_id, 36).toLowerCase(),
      name: text(`${text(row?.reg_first, 60)} ${text(row?.reg_last, 60)}`, 120),
      last: text(row?.reg_last, 60),
      church: text(row?.reg_church, 120),
    }))
    // Only a GUID ever leaves here, so the page can only build a Slate pass URL from it.
    .filter((row) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) && row.name)
    .sort((a, b) => a.last.localeCompare(b.last) || a.name.localeCompare(b.name))
    .slice(0, CHECKIN_SEARCH_MAX_RESULTS)
    .map(({ id: regId, name, church }) => ({ id: regId, name, church }));

  logInfo(id, "Checkin search results", { count: results.length });
  return json({ results }, env, 200, env.ALLOWED_ORIGIN);
}


// ============================================================
// BTC DUPLICATE-EMAIL CHECK (GET /api/slate/btc-email-check)
//
// The BTC 2027 individual registration form (enroll.gs.edu) asks this whether
// an email already has an active registration, so a group leader can't
// register several people under their own email. A reused email matches the
// same Slate person, so the second registration overwrites the first one's
// name and only one mobile pass exists. See local.files.misc/BTC/
// ind-registration.js ("BTC DUPLICATE EMAIL CHECK").
//
// Backed by its own Slate query (btc_registrant_email_check,
// SLATE_BTC_EMAIL_QUERY_URL), pinned to the BTC 2027 individual form with
// `email` as its only parameter. Answers yes/no only, never names or ids.
//
// Not behind PORTAL_KEY: it's called from the public registration form, which
// can't hold a key. Gated by origin (PORTAL_ORIGIN) and the rate limit. That
// leaves "is this email registered for BTC?" answerable by anyone who sends
// that Origin header, which is the same thing the form itself reveals.
// Unset secrets return 503, and the form lets the registrant submit.
// ============================================================

// Loose on purpose: Slate's own email field validates the format.
const BTC_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function handleBtcEmailCheck(request, env, id) {
  if (!originAllowed(request, env.PORTAL_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.PORTAL_ORIGIN);
  }

  if (!env.SLATE_BTC_EMAIL_QUERY_URL || !env.SLATE_TOKEN_BTC_EMAIL) {
    return json({ error: "Email check isn't set up yet", requestId: id }, env, 503, env.PORTAL_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "btc-email-check"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.PORTAL_ORIGIN);
  }

  const email = String(new URL(request.url).searchParams.get("email") || "").trim();
  if (!BTC_EMAIL_PATTERN.test(email)) {
    return json({ error: "Send an email address", requestId: id }, env, 400, env.PORTAL_ORIGIN);
  }

  const url = new URL(env.SLATE_BTC_EMAIL_QUERY_URL);
  url.searchParams.set("output", "json");
  url.searchParams.set("email", email);
  // Logs the route and the answer only, never the email.
  logInfo(id, "BTC email check request", { route: "btc-email-check" });

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.SLATE_TOKEN_BTC_EMAIL}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    logError(id, "BTC email check query failed", { status: resp.status });
    throw new Error(`Slate query failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("Slate query returned invalid JSON");
  }

  const registered = Array.isArray(data?.row) && data.row.length > 0;
  logInfo(id, "BTC email check result", { registered });
  return json({ registered }, env, 200, env.PORTAL_ORIGIN);
}


// ============================================================
// MAILING SUCCESS AI ANALYSIS (POST /api/mailings/analyze)
//
// reports/mailing-success/ ranks Deliver mailings, then asks Claude what the
// top and bottom ones have in common. The hosted page has no gateway key, so
// its Slate wrapper (slate-templates/wrappers/mailing-success-wrapper.liquid.html)
// makes this call from PORTAL_ORIGIN with X-GS-Key and relays the answer back.
//
// Only mailing-level rows come in (name, subject, folder, owner, send time,
// counts and rates) — never people. Every field is re-shaped below so a caller
// can't stuff arbitrary text or volume into the prompt.
// ============================================================

const MAILING_ANALYSIS_MODEL = "claude-opus-5-5";
const MAILING_ANALYSIS_MAX_ROWS = 40;

const MAILING_ANALYSIS_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    headline: { type: "string" },
    top_patterns: {
      type: "array",
      items: {
        type: "object",
        properties: { factor: { type: "string" }, evidence: { type: "string" } },
        required: ["factor", "evidence"],
        additionalProperties: false,
      },
    },
    low_patterns: {
      type: "array",
      items: {
        type: "object",
        properties: { factor: { type: "string" }, evidence: { type: "string" } },
        required: ["factor", "evidence"],
        additionalProperties: false,
      },
    },
    recommendations: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
    caveats: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "top_patterns", "low_patterns", "recommendations", "answer", "caveats"],
  additionalProperties: false,
});

const MAILING_ANALYSIS_SYSTEM = `You analyze Slate Deliver mailing results for the admissions and enrollment staff at Gateway Seminary, a graduate theological school.

You get two groups of mailings from the same filtered view: "top" (highest success score) and "bottom" (lowest). Success score is a mailing's percentile within its own type: click rate for emails (opens are inflated by Apple Mail privacy prefetching, so treat open rate as weak evidence), reply rate for texts. Rates are fractions (0.08 = 8%).

Find the factors that separate the two groups: send weekday and time of day, audience size, email vs. text, subject-line wording and length, mailing-name cues about purpose or audience (inquiries, applicants, current students, events, deadlines), folder, and sender. Cite specific mailings by name as evidence. Prefer a few well-supported patterns over many weak ones, and say when a pattern rests on only two or three mailings. Recommendations should be concrete things staff can try on their next mailing.

If the staff member asked a question, answer it directly in "answer" from this data, or say what data would be needed; otherwise set "answer" to an empty string. Use "caveats" for limits of the data, such as small samples, reply windows, or replies that may belong to one-to-one texts.`;

function analysisText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function analysisRate(value) {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000;
}

function shapeMailingRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAILING_ANALYSIS_MAX_ROWS).map((row) => ({
    group: row && row.group === "top" ? "top" : "bottom",
    rank: Number.isFinite(Number(row?.rank)) ? Number(row.rank) : null,
    name: analysisText(row?.name, 160),
    type: row?.type === "text" ? "text" : "email",
    subject: analysisText(row?.subject, 200),
    folder: analysisText(row?.folder, 80),
    sent_by: analysisText(row?.sent_by, 60),
    sent_at: analysisText(row?.sent_at, 16),
    weekday: analysisText(row?.weekday, 3),
    delivered: Number.isFinite(Number(row?.delivered)) ? Number(row.delivered) : 0,
    bounce_rate: analysisRate(row?.bounce_rate),
    open_rate: analysisRate(row?.open_rate),
    click_rate: analysisRate(row?.click_rate),
    reply_rate: analysisRate(row?.reply_rate),
    opt_out_rate: analysisRate(row?.opt_out_rate),
    success_score: analysisRate(row?.success_score),
  }));
}

async function handleMailingAnalyze(request, env, id) {
  const denied = await guardRoute(request, env, id, "mailings-analyze", env.PORTAL_ORIGIN);
  if (denied) return denied;

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body", requestId: id }, env, 400, env.PORTAL_ORIGIN);
  }

  const mailings = shapeMailingRows(body?.mailings);
  if (mailings.length < 4 || !mailings.some((m) => m.group === "top") || !mailings.some((m) => m.group === "bottom")) {
    return json({ error: "Send at least two top and two bottom mailings", requestId: id }, env, 400, env.PORTAL_ORIGIN);
  }

  const filters = body?.filters && typeof body.filters === "object" ? body.filters : {};
  const question = analysisText(body?.question, 500);
  const userContent =
    `Current view: ${analysisText(filters.type, 40) || "all types"}, sent in the last ${analysisText(filters.range, 40) || "(unspecified)"}, ` +
    `at least ${Number(filters.min_delivered) || 0} delivered, text replies counted within ${analysisText(filters.reply_window, 40) || "3 days"}.\n\n` +
    `Mailings (JSON):\n${JSON.stringify(mailings)}\n\n` +
    (question ? `Staff question: ${question}` : "No specific question was asked.");

  logInfo(id, "Mailing analysis request", { rows: mailings.length, hasQuestion: !!question });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: MAILING_ANALYSIS_MODEL,
      max_tokens: 16000,
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: MAILING_ANALYSIS_SCHEMA },
      },
      system: MAILING_ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  const responseText = await resp.text();
  if (!resp.ok) {
    logError(id, "Anthropic error", { status: resp.status, body: responseText.slice(0, 500) });
    return json({ error: `AI service error (HTTP ${resp.status})`, requestId: id }, env, 502, env.PORTAL_ORIGIN);
  }

  let message;
  try {
    message = JSON.parse(responseText);
  } catch {
    return json({ error: "AI service returned invalid JSON", requestId: id }, env, 502, env.PORTAL_ORIGIN);
  }

  if (message.stop_reason === "refusal") {
    return json({ error: "The AI declined to analyze these mailings", requestId: id }, env, 502, env.PORTAL_ORIGIN);
  }
  if (message.stop_reason === "max_tokens") {
    return json({ error: "The analysis ran too long; try fewer mailings", requestId: id }, env, 502, env.PORTAL_ORIGIN);
  }

  const textBlock = (message.content || []).find((block) => block.type === "text");
  let analysis;
  try {
    analysis = JSON.parse(textBlock ? textBlock.text : "");
  } catch {
    return json({ error: "AI response was not valid JSON", requestId: id }, env, 502, env.PORTAL_ORIGIN);
  }

  return json({ analysis, model: message.model, requestId: id }, env, 200, env.PORTAL_ORIGIN);
}


// ============================================================
// CHECK-IN QR IMAGE PROXY
//
// maindb's per_qr_url column (verified live 2026-09-22) is not an opaque
// code to encode ourselves — it's a link to a PNG Slate already renders at
// enroll.gs.edu/register/mobile?id=<guid>&cmd=barcode[&type=<type>]. That
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
//
// `&type=...` is OPTIONAL: confirmed 2026-09-22 that an event registrant's
// link 404s WITH "&type=person" and only renders correctly without it (or
// presumably with whatever type actually matches that record), so the
// pattern can't require a fixed type value — that's this route's job to
// pass through unchanged, not to validate.
// ============================================================

const CHECKIN_QR_IMAGE_PATTERN =
  /^https:\/\/enroll\.gs\.edu\/register\/mobile\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}&cmd=barcode(&type=[a-z]+)?$/i;

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
// CHECK-IN PRINT QUEUE
//
// Lets a scanning device with no Dymo attached (e.g. a Kindle Fire tablet,
// which can't run DYMO Connect at all — see tools/checkin/README.md) hand a
// decoded badge value off to a Windows machine acting as a print station,
// without the two devices needing to be on the same network.
//
// Stations are named ("Main", "Table 2", ...), and each name gets its own
// Durable Object instance (CheckinPrintQueue, below), so several stations can
// run at once, each with its own Dymo. A scanner POSTs a job with the station
// name it's sending to. The station's tab (with "Enable as print station"
// turned on in tools/checkin/index.html) holds a WebSocket open to its
// instance, and the instance pushes each job down it the moment it arrives.
//
// Push, not polling. The first version had the station poll every 2.5s,
// which was ~1,440 Worker requests an hour per station for nothing, and
// several stations behind one office IP would have tripped the per-IP rate
// limit. The WebSocket uses the hibernation API, so an idle connection costs
// nothing, and the station's keep-alive ping is answered by the runtime
// (setWebSocketAutoResponse) without waking the object.
//
// Delivery is at-least-once. A job stays in storage until the station acks
// it, and everything unacked is re-sent when a station (re)connects, so a
// scan made while the station's laptop was asleep or offline prints when it
// comes back. Only one station per name: a new connection closes the old one
// (code 4000), so two tabs can't both print the same job.
//
// Storage is a Durable Object, NOT KV. The first version used OPTIONS_CACHE
// KV and silently lost jobs in real use (2026-09-25): KV is eventually
// consistent across Cloudflare edge locations, so a phone on cellular and the
// print station on office wifi could take up to a minute to see each other's
// writes. A Durable Object is one strongly-consistent instance every request
// is routed to. Capped at 50 pending jobs, and jobs older than an hour are
// dropped, so an offline station can't make this grow unbounded.
// ============================================================

const CHECKIN_PRINT_QUEUE_MAX = 50;
const CHECKIN_PRINT_QUEUE_TTL_MS = 60 * 60 * 1000;
const CHECKIN_PRINT_QUEUE_VALUE_MAX_LENGTH = 500;
const CHECKIN_STATION_REPLACED_CODE = 4000;
// Letters, digits, spaces and hyphens. Matched case-insensitively, so
// "Table 2" and "table 2" are the same station.
const CHECKIN_STATION_NAME_PATTERN = /^[a-z0-9][a-z0-9 -]{0,39}$/i;

export class CheckinPrintQueue {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async pendingJobs() {
    const cutoff = Date.now() - CHECKIN_PRINT_QUEUE_TTL_MS;
    return ((await this.storage.get("jobs")) || []).filter((job) => job.ts >= cutoff);
  }

  openStations() {
    return this.state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/connect") {
      for (const ws of this.openStations()) {
        ws.close(CHECKIN_STATION_REPLACED_CODE, "Another print station connected with this name");
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      const jobs = await this.pendingJobs();
      if (jobs.length) server.send(JSON.stringify({ type: "jobs", jobs }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (pathname === "/push") {
      const { value, name, church } = await request.json();
      const job = { id: crypto.randomUUID(), value, name: name || "", church: church || "", ts: Date.now() };
      await this.storage.put("jobs", [...(await this.pendingJobs()), job].slice(-CHECKIN_PRINT_QUEUE_MAX));
      const stations = this.openStations();
      for (const ws of stations) ws.send(JSON.stringify({ type: "jobs", jobs: [job] }));
      return Response.json({ job, stationConnected: stations.length > 0 });
    }

    return Response.json({ stationConnected: this.openStations().length > 0 });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg?.type !== "ack" || !Array.isArray(msg.ids)) return;
    const acked = new Set(msg.ids);
    const remaining = (await this.pendingJobs()).filter((job) => !acked.has(job.id));
    if (remaining.length) await this.storage.put("jobs", remaining);
    else await this.storage.delete("jobs");
  }

  webSocketClose(ws, code, reason) {
    // Completes the closing handshake; needed on this compatibility_date.
    try { ws.close(code, reason); } catch { /* already closed */ }
  }
}

// Returns the case-folded station key, or "" if the name isn't valid.
function checkinStationKey(rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ");
  return CHECKIN_STATION_NAME_PATTERN.test(name) ? name.toLowerCase() : "";
}

function checkinPrintQueueStub(env, stationKey) {
  return env.CHECKIN_PRINT_QUEUE.get(env.CHECKIN_PRINT_QUEUE.idFromName(`station:${stationKey}`));
}

async function pushCheckinPrintJob(env, stationKey, value, name, church) {
  const resp = await checkinPrintQueueStub(env, stationKey).fetch("https://checkin-print-queue/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, name, church }),
  });
  return resp.json();
}

// A scanned badge decodes to "<type>:<32 hex>" (e.g. "person:07f5…") or a
// bare GUID for other pass types. Slate's mobile pass page for that GUID
// shows the holder's name, read here server-side (enroll.gs.edu sends no
// CORS headers). Where it lives depends on the pass template, all verified
// 2026-09-25: <p class="pass__name"> (BEM double underscore, first and last
// name split by a <br>) on the custom event-registrant pass;
// <p class="pass_name"> as its single-underscore variant; or a bare,
// class-less <div> directly inside .pass_badge on the default "person"
// pass. On the custom template .pass_badge wraps the whole designed pass,
// hence the :not([class]) child match rather than any div. There is
// deliberately NO fallback to <title> or .pass_title: on some templates
// those hold the pass/event title, and a label with no name beats a label
// with the wrong one. The BTC 2027 pass also shows the registrant's church in
// <p class="pass__church"> (p.pass_church accepted too), which the label
// prints under the name; other templates have none, and the label just
// leaves it out. The type
// must be passed through as-is: an event registrant's page 404s with
// &type=person, the same quirk CHECKIN_QR_IMAGE_PATTERN documents. Only a
// validated GUID and a lowercase type word ever reach the URL, so this
// can't be pointed at arbitrary pages. Best-effort: any failure returns "",
// and the label prints without a name rather than the scan failing.
const CHECKIN_PASS_CODE_PATTERN = /^(?:([a-z]+):)?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Returns { name, church, outcome }. `outcome` is safe to log (never the
// name or church) and says why a lookup came back empty.
async function lookupCheckinPass(value) {
  const match = CHECKIN_PASS_CODE_PATTERN.exec(value);
  if (!match) return { name: "", church: "", outcome: "unrecognized-code" };
  const [, type, ...guidParts] = match;
  const url = new URL("https://enroll.gs.edu/register/mobile");
  url.searchParams.set("id", guidParts.join("-").toLowerCase());
  if (type) url.searchParams.set("type", type.toLowerCase());

  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return { name: "", church: "", outcome: `http-${resp.status}` };
    let passName = "";
    let badgeName = "";
    let passChurch = "";
    const classes = new Set();
    // The name can be split across a <br> (first / last), so each <br>
    // inside it becomes a space.
    const addName = { text(chunk) { passName += chunk.text; } };
    const addSpace = { element() { passName += " "; } };
    await new HTMLRewriter()
      .on("p.pass__name, p.pass_name", addName)
      .on("p.pass__name br, p.pass_name br", addSpace)
      .on(".pass_badge > div:not([class])", { text(chunk) { badgeName += chunk.text; } })
      .on("p.pass__church, p.pass_church", { text(chunk) { passChurch += chunk.text; } })
      .on("p.pass__church br, p.pass_church br", { element() { passChurch += " "; } })
      .on("[class]", { element(el) { classes.add(`${el.tagName}.${el.getAttribute("class")}`); } })
      .transform(resp)
      .arrayBuffer();
    const name = decodeHtmlEntities(passName || badgeName).replace(/\s+/g, " ").trim().slice(0, 120);
    const church = decodeHtmlEntities(passChurch).replace(/\s+/g, " ").trim().slice(0, 120);
    const source = passName ? "pass-name" : badgeName ? "pass-badge" : "no-match";
    // Element classes only (no text), so a template change is diagnosable
    // from the logs without ever logging a name or church.
    return { name, church, outcome: `${source} ${church ? "church" : "no-church"} [${[...classes].join(" ")}]` };
  } catch (err) {
    return { name: "", church: "", outcome: `error-${err?.name || "unknown"}` };
  }
}

async function handleCheckinPrintQueuePost(request, env, id) {
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.ALLOWED_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "checkin-print-queue-post"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.ALLOWED_ORIGIN);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }

  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (!value) {
    return json({ error: "value is required", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }
  if (value.length > CHECKIN_PRINT_QUEUE_VALUE_MAX_LENGTH) {
    return json({ error: "value is too long", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }
  const stationKey = checkinStationKey(body?.station);
  if (!stationKey) {
    return json({ error: "A valid station name is required", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }

  const { name, church, outcome } = await lookupCheckinPass(value);
  const { job, stationConnected } = await pushCheckinPrintJob(env, stationKey, value, name, church);
  // Deliberately logs how the pass lookup went, never the name or church.
  logInfo(id, "Checkin print queue job queued", { jobId: job.id, station: stationKey, stationConnected, nameLookup: outcome });
  return json({ ok: true, job, stationConnected }, env, 200, env.ALLOWED_ORIGIN);
}

// GET /api/checkin/print-station?station=<name>
// With "Upgrade: websocket": the print station's push connection (see
// "CHECK-IN PRINT QUEUE"). Without: a one-off { connected } check a scanner
// makes when its station is picked. Neither is ever polled.
async function handleCheckinPrintStation(request, env, id, url) {
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.ALLOWED_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "checkin-print-station"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, env.ALLOWED_ORIGIN);
  }

  const stationKey = checkinStationKey(url.searchParams.get("station"));
  if (!stationKey) {
    return json({ error: "A valid station name is required", requestId: id }, env, 400, env.ALLOWED_ORIGIN);
  }

  const stub = checkinPrintQueueStub(env, stationKey);
  if (request.headers.get("Upgrade") === "websocket") {
    logInfo(id, "Checkin print station connecting", { station: stationKey });
    return stub.fetch(new Request("https://checkin-print-queue/connect", request));
  }

  const { stationConnected } = await (await stub.fetch("https://checkin-print-queue/status")).json();
  return json({ connected: stationConnected }, env, 200, env.ALLOWED_ORIGIN);
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
  const denied = await guardRoute(request, env, id, routeName, env.PORTAL_ORIGIN);
  if (denied) return denied;

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
// TEACHING SITE STUDENT TREND
//
// Students per academic period, per teaching site, for the trend charts on
// the Teaching Sites overview (sum of all sites) and each site's detail page.
// One status=Student maindb call per period in PERSON_CREATED_WINDOWS -- the
// same term/year parameters the people route uses, so each point matches the
// Students stat for that period exactly. Rows without a teaching site are
// dropped, as on the people route.
//
// The answer does not depend on which site or period the page is showing, so
// it is one cache entry for everyone, held for an hour to keep KV writes to a
// couple dozen a day (Workers Free caps them at 1,000).
// ============================================================

const TEACHING_SITE_TREND_CACHE_SECONDS = 3600;
const TEACHING_SITE_TREND_FANOUT_LIMIT = 3;


async function handleTeachingSiteTrend(request, env, id) {
  // Also open to ALLOWED_ORIGIN (GitHub Pages): the report page fetches this
  // itself when the Slate wrapper did not send it, so the charts do not depend
  // on the wrapper pasted into Slate being current. It is aggregate counts
  // only -- no names or contact details.
  const origin = originAllowed(request, env.PORTAL_ORIGIN) ? env.PORTAL_ORIGIN
    : originAllowed(request, env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN
    : "";
  if (!origin) {
    return json({ error: "Origin not allowed", requestId: id }, env, 403, env.PORTAL_ORIGIN);
  }

  if (!(await checkRateLimit(env, request, "teaching-site-trend"))) {
    return json({ error: "Rate limit exceeded", requestId: id }, env, 429, origin);
  }

  const cacheKey = "teaching-site-trend:v1";
  const cached = await env.OPTIONS_CACHE.get(cacheKey, "json").catch(() => null);
  if (cached) {
    logInfo(id, "Teaching site trend served from cache", { cacheKey });
    return json(cached, env, 200, origin);
  }

  const periodKeys = Object.keys(PERSON_CREATED_WINDOWS);
  const periods = await mapWithLimit(periodKeys, TEACHING_SITE_TREND_FANOUT_LIMIT, async (key) => {
    const [term, year] = key.split("|");
    try {
      const rows = await fetchFunnelStage(env, id, "teaching-site-trend", "students", { term, year }, null);
      const bySite = {};
      let total = 0;
      rows.forEach((row) => {
        const site = plainText(row?.per_teachingsite);
        if (!site) return;
        bySite[site] = (bySite[site] || 0) + 1;
        total += 1;
      });
      return { term, year, total, bySite };
    } catch (error) {
      logError(id, "Teaching site trend period failed", {
        term,
        year,
        message: String(error && error.message ? error.message : error),
      });
      return { term, year, total: 0, bySite: {}, failed: true };
    }
  });

  const failedPeriods = periods.filter((p) => p.failed).map((p) => `${p.term} ${p.year}`);
  const payload = {
    periods: periods.map(({ term, year, total, bySite }) => ({ term, year, total, bySite })),
    failedPeriods,
  };

  logInfo(id, "Teaching site trend assembled", {
    totals: periods.map((p) => p.total),
    failed: failedPeriods.length,
  });

  if (!failedPeriods.length) {
    await env.OPTIONS_CACHE
      .put(cacheKey, JSON.stringify(payload), { expirationTtl: TEACHING_SITE_TREND_CACHE_SECONDS })
      .catch(() => {});
  }

  return json(payload, env, 200, origin);
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
  "/gs.labs/reports/enrollment-events/",
  "/gs.labs/public-event-registrants/",
  "/gs.labs/reports/public-event-registrants/",
  "/gs.labs/reports/advancement-student-life-events/",
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
    "/gs.labs/event-tracker/": "Enrollment Events",
    "/gs.labs/reports/event-tracker/": "Enrollment Events",
    "/gs.labs/reports/enrollment-events/": "Enrollment Events",
    "/gs.labs/public-event-registrants/": "Advancement and Student Life Events",
    "/gs.labs/reports/public-event-registrants/": "Advancement and Student Life Events",
    "/gs.labs/reports/advancement-student-life-events/": "Advancement and Student Life Events",
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
- app_status: app_status
- app_round: app_round
- app_f1: app_f1
- degree_interest: standard_degree
- entry_term: entry_term
- entry_year: academic_year
- marital_status: marital_status

academic_interest is matched as "contains", so use the closest academic_interests value or a shorter word from the request (e.g. "Counseling").

The first, last, and sisid parameters are free text and do not require a Valid Values lookup. Use first and last only when the user identifies a person by name. For a clearly stated full name, put all given-name words in first and the family name in last. Use sisid for an explicitly provided student/SIS ID.

Use the exact Valid Values from the mapped section. For a shorthand location such as "Burbank", select the one teaching-site or campus value that contains that location name.

Today is ${currentDate}. Resolve relative academic-term language when possible. For example, "this fall" means term "Fall" and the academic-year value whose first year is this calendar year. Thus, during 2026, "this fall" maps to year "2026-2027".

Leave alt_form_type empty. It only checks one form response per person, so it misses most event registrants; the event_* filters below replace it. When the user asks for people tied to any event at all (no event name or dates), set event_date_start to "2000-01-01" so every event registration counts.

When the user asks for "students", use the exact person_status value "Student" in the status output key. When they ask for admitted students or admitted applications, use status "Student" and decision code "AT". For provisionally admitted students, use decision code "ATP" instead.

Application Created Date is a date range. Use app_createddate_start for the inclusive beginning of the requested range and app_createddate_end for the inclusive end. Return dates in YYYY-MM-DD format. If the user provides only one boundary, leave the other boundary empty. If they name a full month, use its first and last calendar dates. Never return app_createddate.

Person Created Date is a separate date range for when the person's record was created (when they first inquired or entered Slate), not when an application was created. Use person_created_date_start for the inclusive beginning and person_created_date_end for the inclusive end, in YYYY-MM-DD format, following the same rules as Application Created Date. Use it for requests like "inquiries from last month" or "people added since August"; use the app_createddate fields only when the user says application created or started. Leave both empty otherwise.

Application Submitted Date (app_submitted_start / app_submitted_end) and Decision Date (app_decision_date_start / app_decision_date_end) are date ranges with the same rules. Use the submitted fields for "submitted", "completed" or "turned in" applications, and the decision-date fields for requests like "admitted this month" or "decisions made since September" (combine them with app_code when a specific decision is named).

app_status is the application's funnel stage (e.g. "Awaiting Materials", "Decided"). app_round separates Master's/diploma/certificate applications from PhD & ThM applications. app_f1 is "1" for applicants needing an F-1 student visa (international students) and "0" for those who don't.

degree_interest, entry_term, entry_year, academic_interest and marital_status describe what a person said on an inquiry or RFI ("inquiries interested in the MDiv", "people planning to start Fall 2027"). Use program, term and year instead when the user is talking about an application.

Event filters: event_title is matched as "contains", so use a distinctive part of the event name ("Bible Teaching Conference", "SBC"). event_date_start / event_date_end are a YYYY-MM-DD range on the event's date. Set event_attended to "1" only when the user says attended, came, or showed up; leave it empty for registered or signed up.

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
            1000,

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

    if (DATE_PARAMETER_KEYS.includes(key) && !value) continue;

    url.searchParams.set(
      key,
      DATE_PARAMETER_KEYS.includes(key)
        ? toSlatePersonDate(key.endsWith("_end") ? inclusiveEndDate(value) : value)
        : value ?? ""
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

        // A check-in lookup's query string is a registrant's last name, and
        // a BTC email check's is an email address.
        search:
          url.pathname === "/api/slate/checkin-search" ||
          url.pathname === "/api/slate/btc-email-check"
            ? "[REDACTED]"
            : url.search,
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
        url.pathname === "/api/slate/teaching-site-trend" &&
        request.method === "GET"
      ) {
        return await handleTeachingSiteTrend(request, env, id);
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
      // origin), not a Slate wrapper — see "CHECK-IN LAST-NAME LOOKUP".
      if (
        url.pathname === "/api/slate/checkin-search" &&
        request.method === "GET"
      ) {
        return await handleCheckinSearch(request, env, id);
      }

      // Called directly from the BTC 2027 registration form's own script
      // (PORTAL_ORIGIN), not a wrapper — see "BTC DUPLICATE-EMAIL CHECK".
      if (
        url.pathname === "/api/slate/btc-email-check" &&
        request.method === "GET"
      ) {
        return await handleBtcEmailCheck(request, env, id);
      }

      // Re-serves a per_qr_url PNG with CORS headers so tools/checkin/ can
      // read its bytes for Dymo printing — see handleCheckinQrImage.
      if (
        url.pathname === "/api/slate/checkin-qr-image" &&
        request.method === "GET"
      ) {
        return await handleCheckinQrImage(request, env, id);
      }

      // See "CHECK-IN PRINT QUEUE" below for what these do.
      if (
        url.pathname === "/api/checkin/print-queue" &&
        request.method === "POST"
      ) {
        return await handleCheckinPrintQueuePost(request, env, id);
      }

      if (
        url.pathname === "/api/checkin/print-station" &&
        request.method === "GET"
      ) {
        return await handleCheckinPrintStation(request, env, id, url);
      }

      if (
        url.pathname === "/api/mailings/analyze" &&
        request.method === "POST"
      ) {
        return await handleMailingAnalyze(request, env, id);
      }

      if (
        url.pathname === "/api/analytics/summary" &&
        request.method === "GET"
      ) {
        return await readAnalyticsSummary(url, env);
      }


      // ======================================================
      // QUERYOMATIC GUARD
      //
      // The POST routes below run the person query, spend
      // Claude credit and commit to GitHub, so they get the
      // same origin/key/rate-limit gate as the portal routes.
      // BetterQuery calls them from GitHub Pages, and its
      // Slate wrapper hands the page the key. GET /api/options
      // stays open: options.md is already public in the repo.
      // ======================================================

      if (
        request.method === "POST" &&
        QUERYOMATIC_GUARDED_PATHS.has(url.pathname)
      ) {
        const denied = await guardRoute(
          request, env, id,
          "queryomatic" + url.pathname.slice(4).replace(/\//g, "-"),
          env.ALLOWED_ORIGIN
        );
        if (denied) return denied;
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


        // Every maindb filter is optional, so an all-blank
        // params object would return the whole population.
        if (
          !Object.values(
            normalizeQueryParams(params)
          ).some(Boolean)
        ) {

          return json(
            {
              error:
                "Add at least one filter. BetterQuery won't return everyone at once.",

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
        url.pathname === "/api/slate/checkin-search" ||
        url.pathname === "/api/slate/checkin-qr-image" ||
        url.pathname.startsWith("/api/checkin/")
          ? env.ALLOWED_ORIGIN
          : url.pathname.startsWith("/api/slate/") || url.pathname.startsWith("/api/mailings/") ? env.PORTAL_ORIGIN : undefined
      );
    }
  },
};
