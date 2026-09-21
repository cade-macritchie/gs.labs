# GS Labs Slate Gateway — Setup

This Worker (Cloudflare service name `gs-labs-slate-gateway`, formerly
`slate-query-tool`) does two jobs:

1. **Queryomatic** — the AI-assisted admissions-export tool's own backend
   (options.md refresh/generate/run flows).
2. **Slate portal proxy** (`/api/slate/*`) — the Slate credentials used by
   `slate-templates/wrappers/*.liquid.html` live here as secrets, so nothing
   is hardcoded in a wrapper file or shipped to a browser. Every route is a
   parameter set over the same maindb query Queryomatic runs, except
   `portal-options`, which reads the prompts query. See "Slate portal proxy
   routes" below.

Two pieces: this Cloudflare Worker (holds your secrets, calls Slate + Anthropic)
and a static page (goes on GitHub Pages).

## 1. Deploy the Worker

```bash
npm install -g wrangler
wrangler login

cd tools/queryomatic
wrangler kv namespace create OPTIONS_CACHE
# paste the returned id into wrangler.toml under [[kv_namespaces]]

wrangler secret put SLATE_TOKEN_PROMPTS
wrangler secret put SLATE_TOKEN_MAINDB
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put APP_PASSWORD
wrangler secret put SESSION_SECRET

# The two Slate query URLs (each includes that query's id) — moved here from
# wrangler.toml [vars] because vars are committed in plaintext. Between them
# they back every route: the maindb query serves Queryomatic and all but one
# of the /api/slate/* portal routes, the prompts query serves the rest.
wrangler secret put SLATE_OPTIONS_URL
wrangler secret put SLATE_QUERY_URL

wrangler deploy
```

## Slate portal proxy routes

Each route below whitelists only the query-string parameters its wrapper
actually sends, checks `Origin`/`Referer` against the `PORTAL_ORIGIN` var
(`https://enroll.gs.edu` — where the wrapper's `<script>` actually executes,
*not* `ALLOWED_ORIGIN`, which is GitHub Pages), and applies a 60
requests/IP/minute limit using the `OPTIONS_CACHE` KV namespace.

| Route | Query | Used by | Allowed params |
| --- | --- | --- | --- |
| `GET /api/slate/teaching-site-people` | maindb x3 + prompts | Teaching Sites | `term`, `year`, `site` |
| `GET /api/slate/regional-campus-people` | maindb x(campuses x stages) + prompts | Regional Campus | `campus`, `term`, `year`, `status` |
| `GET /api/slate/pipeline-people` | maindb x2 + prompts | Pipeline Overview | `status`, `term`, `year` |
| `GET /api/slate/portal-options` | prompts | (all three above, via the route) | (none) |
| `GET /api/slate/records` | maindb | Record Lookup, Event Tracker | `status`, `year`, `term`, `teachingsite`, `first`, `last`, `sisid`, `alt_form_type` |
| `GET /api/slate/additional-applications` | maindb | Record Lookup | `sisid` |
| `GET /api/slate/teaching-site-counts` | maindb | (none) | `status`, `year`, `term`, `site` |
| `GET /api/slate/inquiries` | maindb | (none) | `campus`, `teachingsite`, `person_created_date_start`, `person_created_date_end` |
| `GET /api/slate/regional-campus-records` | maindb | (none) | `campus`, `term`, `year` |

The last three have no caller since the portal rebuild and are kept only for
ad-hoc use. Nothing should be built on them.

Route parameter names that differ from the maindb query’s own are renamed by
`MAINDB_PARAM_ALIASES` in `worker.js` (`site` → `teachingsite`, `campus` →
`campus_assigned`); everything else passes through unchanged, and blank values
are dropped rather than sent as `""`.

### What maindb’s parameters actually mean

Verified against the live query. Getting these wrong is the difference between
a portal showing real numbers and a portal showing zero.

- **`term` and `year` filter on the APPLICATION’s term and year.** A person
  with no application matches neither, so `status=Inquiry&term=Fall&year=…`
  returns **0 rows, always** — it asks for inquiries whose application is for
  Fall, and an inquiry has no application. A portal that wants a period-scoped
  funnel must query its pre-application stages separately, without
  `term`/`year`.
- **`person_created_date_start` / `person_created_date_end` are how you
  scope a pre-application stage to a period.** They filter on when the PERSON
  record was created, which is the only anchor in time an inquiry or prospect
  has. The period windows live in `PERSON_CREATED_WINDOWS` in `worker.js` and
  tile the population exactly (2,256 + 46 + 0 = 2,302, the all-time inquiry
  count). Dates are M/D/YYYY. Send no bound rather than an empty string --
  the field is Date-typed and rejects `""`.
  (These returned nothing before 2026-09-21; the query has since been changed
  on the Slate side, so re-probe before trusting an old note about them.)
- **There is no `app_degree` column** — the degree is `per_degree_current`.
- **The output columns are not fixed.** The query has been observed returning
  its `app_*` block (`app_term`, `app_year`, `app_status`, …) on one day
  and only `app_decision_code` on another, and passing `teachingsite` narrows
  the column set as well. Never build a portal on a client-side filter over a
  column a parameter could take away — filter with parameters, and read only
  the `per_*` columns, which have been stable.
- **One row per person**, not per application (5,837 rows, 5,837 distinct
  `per_url`), so counting rows is counting people.

### The three portal funnel routes

Teaching Sites, Regional Campus and Pipeline Overview all draw the same shape:
a population split by person status, narrowed to a period, grouped by some
affiliation. They share the helpers under PORTAL FUNNELS in `worker.js`,
which fetch each stage with the parameters that stage can answer to:

    pre-application (Inquiry, Prospect)   status + person_created_date_start/end
    application     (Applicant, Student)  status + term + year

What differs between them is how the grouping field is reached:

- **Teaching Sites** -- `per_teachingsite` is returned on every row, so each
  stage is fetched once, unscoped, and rows without a site are dropped in the
  worker. 3 Slate calls.
- **Pipeline Overview** -- `per_pipeline` is returned too, so the same trick
  applies. Its comparison totals come from one unparameterized call tallied by
  status rather than four status calls returning the same rows. 2 Slate calls.
- **Regional Campus** -- the campus exists only as the `campus_assigned`
  PARAMETER, never as a column, so there is nothing to group by. Each campus is
  asked for by name and the answer is stamped onto its rows. Worst case (every
  campus, every status) is 8 x 4 = 32 calls, under Cloudflare’s 50-subrequest
  cap; picking a campus or status cuts it sharply. `campus_assigned` partitions
  the population exactly -- the campuses sum to the full 5,837 -- so nothing is
  lost or double-counted. Hawaii and Boston really are 0.

Every result is cached in KV for five minutes, keyed by the filter combination.
Each portal makes one request and derives its counts, bars, funnel and
drilldown tables from the response.

### Portals still on Liquid

**Funnel Overview** and the two event portals cannot move to maindb yet:

- Funnel Overview needs "awaiting approval" and "admitted". maindb returns
  `app_decision_code` (values `DF`/`WT`/`AT`/`DN`/`WD`/`ADP`, blank for 608
  of 751 applicants) with no dictionary, and neither it nor `app_status` is a
  parameter. Its F-1 list needs a flag maindb no longer returns.
- Event Tracker and Public Event Registrants need event titles and a working
  event-type filter. maindb has neither.
**Adding a new Slate query to a portal:** never hardcode a query `id`/`h` in a
wrapper file. Add a route in `worker.js` that calls `handleSlateProxyRoute`
with an explicit parameter whitelist, then point the wrapper at
`${workerBase}/api/slate/<route>` instead of `enroll.gs.edu`. Prefer another
parameter set over the maindb query to standing up a new Slate query.

`APP_PASSWORD` is the shared password shown to authorized staff. Use a long,
random password and distribute it only through an approved channel.

`SESSION_SECRET` signs browser sessions. Generate a separate random value (for
example, with `openssl rand -base64 32`) and never share it. Changing either
`SESSION_SECRET` invalidates active sessions after their next request. Changing
`APP_PASSWORD` changes the password required for future sign-ins. Rotate both
secrets after a password-security event.

Set these via `wrangler secret put` (see above) rather than `wrangler.toml`,
since `wrangler.toml`'s `[vars]` are committed in plaintext:
- `SLATE_QUERY_URL` — the query that returns the actual export data
- `SLATE_OPTIONS_URL` — a separate Slate query that returns the valid
  values for term/year/status/etc. (the "prompt" endpoint)

Edit `wrangler.toml` for the non-secret vars:
- `ALLOWED_ORIGIN` — your GitHub Pages URL, e.g. `https://yourorg.github.io`
- `PORTAL_ORIGIN` — the Slate portal origin the `/api/slate/*` routes accept
  requests from, e.g. `https://enroll.gs.edu`

The main Slate query and Queryomatic currently share this parameter contract:

- Person identity: `first`, `last`, `sisid`
- Academic and enrollment: `term`, `year`, `status`, `pipeline`, `teachingsite`, `campus_assigned`, `program`
- Application: `app_code`, `app_createddate_start`, `app_createddate_end`
- Alternate form population: `alt_form_type` (`Event` for event-associated people)

Keep the `SLATE_QUERY_URL`, the frontend `PARAMS` list, and the Worker's generated JSON schema in sync when adding another parameter. Fixed prompt values belong in `options.md`; free-text identity and date parameters are described directly in the Worker prompt.

The Worker reads and refreshes `tools/queryomatic/options.md` in the consolidated `gs.labs` repository. Its GitHub token therefore needs write access to this repository if administrators will use **Refresh from source**.

`wrangler deploy` prints your Worker URL, e.g.
`https://gs-labs-slate-gateway.yoursubdomain.workers.dev`.

## 2. Deploy the frontend

Open `index.html` and set:

```js
const WORKER_URL = "https://gs-labs-slate-gateway.yoursubdomain.workers.dev";
```

Push this repo to GitHub, enable **Settings → Pages → Deploy from branch**,
and point it at the branch/folder containing `index.html`.

The user and administrator views are available from the tabs in the deployed
single-page app.

## Notes

- The Worker requires the shared password for every API request. Login attempts
  are limited to five per IP address in a 15-minute window, and sessions expire
  after eight hours.

- Your Slate tokens (Queryomatic's two, plus the six behind `/api/slate/*`)
  and Anthropic key live only in the Worker (via `wrangler secret`) — never
  in the frontend, a wrapper file, or the repo.
- The Worker caches the parameter options in KV for 12 hours to cut down
  on Slate calls; call `GET /api/options?refresh=1` to force a refresh.
- The API also supports a two-step CSV export for integrations. After signing
  in through `POST /api/login` and retaining its session cookie, send
  `POST /api/export` with `{ "prompt": "admitted students for fall 2026" }`.
  The response contains `downloadUrl`; request that URL with `GET` and the
  same session cookie to receive the CSV. Export files are retained in KV for
  15 minutes, then `GET` returns `404`.
- Cloudflare's free tier (100k requests/day) comfortably covers a
  medium-size office.
- Before scaling this beyond testing, move off your personal Anthropic
  key onto an org key so usage is billed and rate-limited separately.
