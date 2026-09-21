# Slate template folders

## `wrappers/` — paste these into Slate

These are the current production templates. Each file sends Slate query results to its matching GitHub-hosted page:

- `pipeline-overview-wrapper.liquid.html`
- `teaching-site-overview-wrapper.liquid.html`
- `event-tracker-wrapper.liquid.html`
- `public-event-registrants-wrapper.liquid.html`
- `funnel-overview-wrapper.liquid.html`
- `student-lookup-wrapper.liquid.html`
- `regional-campus-wrapper.liquid.html`

The live hosted HTML is kept in each tool's top-level folder—for example, `pipeline-overview/index.html`. Those locations must not be moved without also updating the iframe URLs in the wrappers.

The Teaching Sites overview and its site-specific funnel share `teaching-site-overview-wrapper.liquid.html`; there is no separate funnel wrapper. The wrapper gets period summary and site-funnel counts from the teaching-site population service for the `inquiry`, `applicant`, and `student` status values. When a site is selected, it gets drilldown rows separately from the new-schema `all_people` service. See the repository README for the two response shapes and URL filters.

The Regional Campus portal loads the `campus` values from Queryomatic's Slate prompt/options service, with the current campus-prompt values as a static wrapper fallback, and excludes `Doctor of Ministry`. It calls two JSON services. The general service uses `campus`, `term`, and `year` and supplies Applicant and Student rows with `first`, `last`, `email`, `phone`, `sisid`, `status`, `app_status`, and `program`. The inquiry-only service uses `campus` and supplies `first`, `last`, `email`, `phone`, and `sisid`; the wrapper assigns the `Inquiry` status. Inquiry counts are all-time rather than period-specific. The wrapper uses `sisid` to build the individual profile's Slate record-lookup link. No Liquid query export is required. The interface labels `app_status` as **Application Status** and hides campus cards whose combined record count is below 20.

The Record Lookup wrapper does not require a portal query. It fetches the configured `all_people` Slate JSON service after a name or SIS-ID search. That service must export `per_status`, `per_name`, `per_email`, `per_phone`, `per_pipeline`, `per_teachingsite`, `per_birthdate`, `per_url`, `per_location_code`, `app_created_date`, `app_degree`, `app_round`, `app_status`, `app_term`, `app_year`, `app_f1`, `app_url`, `app_missing_mats_list`, and `app_full_mats_list`. The application degree also supplies the profile's Program card. The material-list fields may be comma-separated plaintext or HTML list content; the interface compares them to mark each full-list item as **Missing** or **Received**. The `per_url` export must point to the person record in Slate. The application URL is retained only as an application-presence signal; the interface does not expose an applicant-facing application link. Legacy export names are accepted temporarily as fallbacks during rollout.

The Event Tracker wrapper also fetches `all_people`, always passing `alt_form_type=Event`. Its `event_people` portal query needs only the event title plus a stable person identity (`sisid`/`per_sisid` or `email`/`per_email`) so the fetched person details can be associated with the correct event without rendering complex person exports through Liquid.

The Public Event Registrants wrapper uses only the `public_events_registrants` Liquid query export. Each registrant row must expose `ev_title`, `reg_date`, `ev_date`, and `ev_link_slate`. `reg_date` is when that registrant registered, `ev_date` is the event date repeated on each row, and `ev_link_slate` links to the Slate event record. Liquid renders all rows and supplies the source total with `public_events_registrants | size`; JavaScript groups matching event titles into one event, counts their rows, and retains their registration dates for the cumulative growth chart. It does not fetch an API.
