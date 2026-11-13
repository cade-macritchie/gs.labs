# nso-completion-sync

Nightly Cloudflare Worker that pushes completed New Student Orientation records from Caspio (`NSO_table`) into Slate. Read-only on the Caspio side: no webhook, no change to NSO_table.

```
Caspio NSO_table --(REST, read-only)--> Worker (cron 09:20 UTC) --(POST CSV)--> Slate source format
                                                                  "NSO Completion (Caspio)" (guid cdc7e1e1-8d28-4eee-a651-c053127b7674)
```

## What it sends

- Rows from `NSO_START_TERM` of `NSO_START_YEAR` on (`Spring` of `2023-2024`, i.e. Spring 24 on), future years included, so someone who does NSO early for a later term is still sent. Years must look like `2026-2027`; within the start year, terms run Fall → Winter/January → Spring → Summer, so Fall 23 (also 2023-2024) is skipped. Older history (back to 2016) is not sent. Changed from Fall 26 on 2026-11-12.
- Cleaned: `gs_ID` stripped of `#`/spaces, must be 6 digits and not `000000`; duplicates collapsed to one row per ID (the latest completion by `time` wins); only `complete` = -1/true.
- CSV columns: `gs_ID, term, year, campus, complete, completed_date`. No names or emails leave Caspio.
- `completed_date` (added 2026-11-13, IT-224) = the date part of NSO_table `time` for the person's latest completed row, `YYYY-MM-DD`. For Person field **NSO Completion Date**, so staff can judge whether a returning student must redo NSO. Optional `NSO_DATE_FROM_YEAR` (e.g. `2016-2017`) also reads older rows for the date only: people whose only rows are before the start term go out with `complete` blank, so their NSO Completion isn't set. Unset = date from the same window. On the 11-10 export: window only = 643 people; from 2016 = 2,533 (1,890 date-only).
- On 2026-11-10's export: 115 rows for 2026-2027 became 107 people (7 duplicates, 1 `000000`).

## Slate side (already set up)

Source format "NSO Completion (Caspio)": update-only, **Unsafe Yes** (needed or it skips Students with decided applications), Remap active. Mappings: `gs_ID` -> Fields "Other - SIS ID" (the match key; `gs_ID` is the SIS ID, not the Slate ID), `complete` -> Fields "Other - NSO Completion" (prompt value -1 -> Yes) and, once the field exists, `completed_date` -> Fields "Other - NSO Completion Date" (`nso_completion_date`, Person, date). With Remap on, a new column only lists after a post containing it has been read. Keep the mappings that small: with Unsafe on, a name/email mapping would overwrite records.

Each night's POST becomes one source in the format (Database > Sources). Slate imports it within about 10 minutes. Check the result with the NSO TEST query (`/manage/query/build?id=0f304a61-fd4c-4cc2-a422-9a57fb81566c`).

## Setup (once)

1. **Caspio API profile** (read-only): Caspio > Integrations > API profiles > New. Give it read access to `NSO_table` only. Note the Client ID and Secret.
2. **Slate service user**: a Slate user (Database > User Permissions) with permission to use the source format's web service. Note the username and password. (Slate's "Certificate-Based Authentication" is the alternative.)
3. Secrets, from this folder:
   ```
   npx wrangler secret put CASPIO_CLIENT_ID
   npx wrangler secret put CASPIO_CLIENT_SECRET
   npx wrangler secret put SLATE_IMPORT_USER
   npx wrangler secret put SLATE_IMPORT_PASSWORD
   npx wrangler secret put ADMIN_KEY      # any long random string; guards /run
   ```
4. `npx wrangler deploy` (no CI for Workers in this repo).

## Testing

```
# dry run: fetch + clean, nothing sent (counts only)
curl -H "X-Admin-Key: $ADMIN_KEY" https://nso-completion-sync.<subdomain>.workers.dev/run
# test push of 5 people
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" "https://nso-completion-sync.<subdomain>.workers.dev/run?push=1&limit=5"
```

Then check the source in Slate, the audit log on one person, and the NSO TEST query. Only after that set `ENABLED = "true"` in `wrangler.toml` and redeploy; until then the nightly cron is a dry run that just logs counts.

## Failure behavior

A Caspio or Slate error throws, so the cron invocation shows as failed in Cloudflare (Workers & Pages > nso-completion-sync > Logs). Re-sending is safe: the Slate format is differential and the field is just set to Yes again.

Email alerts come from Slate, not the Worker (the Cloudflare account has no domain to send from): the source format's **Notification = Failures only**, Notification Email = cademacritchie@gs.edu (set 2026-11-11). That covers imports Slate receives but fails. A failure before Slate (Caspio down, bad credentials, Worker error) sends nothing to Slate, so a backstop Deliver mailing, **"NSO sync: no import last night (alert to Cade)"** (folder System), runs query "NSO sync: latest import over 24 hours old" (Source base: the newest successful NSO source, returned once it is over 24 hours old). With execution mode "new records only" that is one email per outage. The mailing has to be scheduled as recurring daily (after ~4:30 AM Central) in Slate to be live.
