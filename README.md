# Enrollment Gateway Tools

This repository is the single source of truth for the Admissions hub and its associated tools.

## Structure

- `index.html` — hub published at the GitHub Pages root.
- `tools/queryomatic/` — Queryomatic frontend, Worker configuration, options reference, and setup notes. Its GitHub Pages entry point is `/tools/queryomatic/`. The Worker itself (`tools/queryomatic/worker.js`, Cloudflare service name `gs-labs-slate-gateway`) now also proxies every Slate query token used by the portal wrappers below — see "Slate query tokens".
- `slate-templates/wrappers/` — the small wrapper files you paste into Slate.
- `tools/student-lookup/` — GitHub-hosted record search/profile interface.
- `slate-templates/wrappers/student-lookup-wrapper.liquid.html` — the Slate query wrapper for the Record Lookup portal.
- `reports/regional-campus/` — GitHub-hosted campus funnel, record drilldown, lookup, and individual record dashboard.
- `training/slate-concepts/` — source for the conceptual Slate glossary and guided staff training lesson. The hub's Training Materials tab links to a bundled copy of this page published as a Claude Artifact (comments enabled) rather than the GitHub Pages copy, so staff can leave feedback comments directly on the lesson; Claude applies accepted feedback back to these source files, regenerates the bundle with `node training/slate-concepts/build-artifact.js`, and republishes it to the same artifact URL. The artifact also declares the `sample` runtime capability (for the "Practice with Claude" request-feedback module); a plain republish keeps that declaration, but pass `capabilities: {sample: {}}` explicitly again if it's ever republished from a fresh session state.
- `slate-templates/wrappers/regional-campus-wrapper.liquid.html` — the Slate query wrapper for the Regional Campus portal.
- `reports/public-event-registrants/` — GitHub-hosted public-event registrant count interface.
- `tools/idea-box/` and `idea-box-worker/` — Slate Idea Box: a standalone submission/voting board for Slate improvement ideas (with an optional reference URL), backed by a small Cloudflare Worker + D1 database. No Slate integration or scheduled sync — see `idea-box-worker/README.md` for deploy steps.
- `pipeline-overview/`, `reports/teaching-site-overview/`, `reports/event-tracker/`, and `reports/funnel-overview/` — GitHub-hosted dashboard interfaces.
- `assets/dashboard.css` and `assets/dashboard-common.js` — shared dashboard presentation, iframe bridge, and academic-period definitions.
- `slate-templates/wrappers/*-wrapper.liquid.html` — thin Slate templates that serialize query results and host the corresponding dashboard iframe.
- `merch-order-form/` — merchandise catalog admin, public order form, and branded catalog PDF generator. Unlike the other tools this is a Next.js **server** app (SQLite via Prisma, Puppeteer for the PDF), so GitHub Pages does not host it — see its own `README.md` and "Deployment model" below.
- `supabase/functions/telegram-codex/` and `.github/workflows/telegram-codex.yml` — optional, allowlisted Telegram-to-Codex automation that proposes changes through pull requests. See `docs/telegram-codex.md` for setup.

## Deployment model

GitHub Pages hosts the front-end pages. Slate retains the queries and renders their results into a small wrapper, which sends the data to the relevant page using `window.postMessage`. This keeps UI code deployable from this repository while each Slate portal controls its own query.

`merch-order-form/` is the one exception. It needs a Node runtime, a writable
SQLite file, and local disk for uploaded product images, so it cannot run on
Pages; the Pages build simply carries its source along as static files. Deploy
it separately to an always-on Node host and keep the source here so it stays
with the other internal tools. It's reverse-proxied at
`https://enroll.gs.edu/portal/merch-order`, linked from the hub's Tools tab
like the other portals.

Use the files in `slate-templates/wrappers/` for the iframe-based portals. Normal HTML, CSS, labels, charts, and client-side behavior can be changed in this repository without repasting a Slate template. Repaste a wrapper only when its query/export names, exported fields, URL parameters, iframe URL, or message contract changes.

## Usage analytics

The GitHub-hosted hub and portal interfaces support Cloudflare Web Analytics for aggregate page views and visits. They also send the current route, a random tab-session identifier, and a random browser identifier to the Queryomatic Worker so the unlisted `/analytics/` dashboard can show rolling 7-, 30-, and 90-day totals. The browser identifier is stored locally, rotates after 90 days, and is used only for aggregate unique-browser counts. Neither integration sends IP addresses, search text, student IDs, names, record URLs, or query results.

To enable collection:

1. In the existing Cloudflare account, open **Web Analytics**, add `cade-macritchie.github.io` as a site, and copy its beacon token.
2. Paste the public token into `SITE_TOKEN` in `assets/portal-analytics.js`.
3. Push the change to `main`, repaste the seven iframe wrappers in Slate to activate their explicit referrer safeguards, and verify a visit in the Cloudflare Web Analytics dashboard.

An empty `SITE_TOKEN` disables collection, and the loader also refuses to run outside the production GitHub Pages hostname so local development does not affect the reports. The dashboard paths distinguish the hub, Funnel Overview, Pipeline Overview, Teaching Sites, Event Tracker, Public Event Registrants, Regional Campus, Record Lookup, Slate Concepts, BetterQuery, and `/tools/queryomatic/admin/`. The Slate wrapper iframes use an origin-only referrer policy so parent portal paths and query values are not disclosed to the hosted interfaces or analytics beacon.

## Wrapper rollout

Publish and verify one wrapper at a time in this order:

1. `slate-templates/wrappers/pipeline-overview-wrapper.liquid.html`
2. `slate-templates/wrappers/teaching-site-overview-wrapper.liquid.html`
3. `slate-templates/wrappers/event-tracker-wrapper.liquid.html`
4. `slate-templates/wrappers/funnel-overview-wrapper.liquid.html`

Before publishing the Pipeline and Teaching Sites wrappers, configure their primary Slate query exports as follows:

- `pipeline_persons` must apply `status`, `term`, and `year`.
- `teaching_sites_persons` must return all teaching-site records and apply only `term` and `year`. Do not filter this export by `status`; the overview displays total records per site.

The Teaching Sites wrapper also powers the site-specific funnel inside the same tool. It calls the teaching-site population service with these `status` values to populate the overview's period totals and the selected site's authoritative funnel counts:

- `inquiry` → Inquiries
- `applicant` → Applicants
- `student` → Students

The population service applies `status`, `site`, `term`, and `year`, returns JSON in the form `{ "row": [...] }`, and exports the teaching-site title as `title`. With no `site`, the wrapper counts only rows whose title is populated, preventing non-teaching-site records from entering the overview totals.

The population service must explicitly return rows for all three status values, including `inquiry`; the wrapper does not estimate inquiry counts from applicant or student rows.

For a selected site's record drilldowns, the wrapper separately calls Record Lookup's `all_people` JSON service with `status`, `teachingsite`, `term`, and `year`. Its current person-detail exports are `per_name`, `per_email`, `per_phone`, `per_sisid`, `per_status`, `per_url`, `per_teachingsite`, and `app_degree`; the wrapper retains legacy aliases as fallbacks and accepts scalar or display/value-shaped JSON fields. The count remains authoritative when the person-detail service cannot supply every row. The `site` and `teachingsite` parameters must exactly match the title returned as `teaching_sites_persons.title`. The wrapper writes spaces as `%20`; standard query parsing also decodes `+` as a space, so either encoding represents the same site name. No separate `teaching_site_*` Liquid exports are required.

The Pipeline wrapper's `total_apps`, `total_inquiries`, `total_prospects`, and `total_students` exports are fixed comparison populations used as percentage denominators. Do not apply the `term` or `year` URL parameters to those total exports. The Teaching Sites wrapper no longer uses comparison-total exports.

The Regional Campus wrapper does not require a Liquid query export. It reads `campus` key/value rows from Queryomatic's Slate prompt/options service (falling back to the current static campus-prompt values in the wrapper), excludes `Doctor of Ministry`, then queries two configured JSON services for every remaining campus. The general service supplies Applicant and Student rows using `campus`, `term`, and `year`; it must export `first`, `last`, `email`, `phone`, `sisid`, `status`, `app_status`, and `program`. The inquiry-only service accepts `campus` and exports `first`, `last`, `email`, `phone`, and `sisid`; the wrapper assigns `Inquiry` as the status for those rows. Inquiry counts are therefore all-time and do not change with the academic-period selector. The wrapper uses `sisid` to link individual profiles to Slate's record lookup. It tags each returned row with the requested campus, combines the responses, and sends them to the hosted interface. Campus cards are shown only when their current combined record count is at least 20. Choosing a campus limits the next page load to that campus's two service calls.

The Event Tracker uses its `event_people` portal query only to associate a person identity (SIS ID or email) with an event. It retrieves current person status and drilldown details from the shared `all_people` JSON service with `alt_form_type=Event`; the service must continue exporting the `per_*` person fields and `app_degree`. If the service is later configured to return an event-title field (`event_title`, `alt_form_title`, `form_title`, or `title`), the wrapper can use those rows without the identity-association query.

The Public Event Registrants portal uses the `public_events_registrants` Liquid query export and does not call a JSON service. Each registrant row exports `ev_title`, `reg_date`, `ev_date`, and `ev_link_slate`. Liquid renders the complete export and supplies its total through the `size` filter before JavaScript groups all matching `ev_title` rows into one event. `reg_date` supplies the cumulative registration-growth chart; `ev_date` supplies the event date once for the grouped card. Each card can open its analytics detail or its event record in Slate through `ev_link_slate`.

The Event Tracker, Teaching Sites, and Regional Campus funnel drilldowns can export their currently filtered record tables as CSV files.

The Pipeline status dropdown supports `applicant`, `inquiry`, `prospect`, and `student`. Configure its Slate status filter so `?status=student` returns the intended student population.

Record Lookup makes a second, SIS-ID-specific service request only after a profile whose person status is `Student` is opened. That service may return prior applications for other degree programs. The hosted interface removes the degree already displayed by the primary lookup, deduplicates exact application rows, and presents the remaining records as an interactive stack of application sheets. Changes to this request contract or its service URL require repasting `slate-templates/wrappers/student-lookup-wrapper.liquid.html` in Slate.

The Pipeline dropdowns send combinations such as `?status=applicant&term=Fall&year=2026-2027`. The Teaching Sites period dropdown sends `term` and `year` without a status. Choosing **Total (All Time)** removes `term` and `year`.

Do not rename the query exports or their fields without making the matching change in the relevant wrapper. The iframe pages intentionally accept data only from `https://enroll.gs.edu`, and the wrappers intentionally accept messages only from the configured GitHub Pages origin.

## Queryomatic

The former standalone Queryomatic repository was imported under `tools/queryomatic/`. The Cloudflare Worker remains a separate deployment; use `tools/queryomatic/README.md` for its Worker secrets and setup instructions. Update its worker `ALLOWED_ORIGIN` to permit the consolidated Pages origin and the `/gs.labs` site.

## Slate query tokens

No `slate-templates/wrappers/*.liquid.html` file may hardcode a Slate query `id` or `h` token — this repository is public, and anything committed here or shipped in the wrapper's inline `<script>` is visible to every site visitor. Every wrapper's Slate call instead goes through the `/api/slate/*` routes on the `gs-labs-slate-gateway` Cloudflare Worker (`tools/queryomatic/worker.js`), which injects the real Slate URL (id + token) from a Worker secret and whitelists only the query-string parameters that route legitimately accepts. See `tools/queryomatic/README.md` for the full secret list and how to add a new route when a portal needs another Slate query.
