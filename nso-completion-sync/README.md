# nso-completion-sync

Nightly Cloudflare Worker that pushes completed New Student Orientation records from Caspio (`NSO_table`) into Slate. Read-only on the Caspio side: no webhook, no change to NSO_table.

```
Caspio NSO_table --(REST, read-only)--> Worker (cron 09:20 UTC) --(POST CSV)--> Slate source format
                                                                  "NSO Completion (Caspio)" (guid cdc7e1e1-8d28-4eee-a651-c053127b7674)
```

## What it sends

- Rows where `year` = the current academic year (Aug-Jul, e.g. `2026-2027`; override with the `NSO_YEAR` var). NSO Completion is one yes/no field on the person, so history back to 2016 is not sent.
- Cleaned: `gs_ID` stripped of `#`/spaces, must be 6 digits and not `000000`; duplicates collapsed to one row per ID; only `complete` = -1/true.
- CSV columns: `gs_ID, term, year, campus, complete`. No names or emails leave Caspio.
- On 2026-11-10's export: 115 rows for 2026-2027 became 107 people (7 duplicates, 1 `000000`).

## Slate side (already set up)

Source format "NSO Completion (Caspio)": update-only, **Unsafe Yes** (needed or it skips Students with decided applications), Remap active. Mappings: `gs_ID` -> Fields "Other - SIS ID" (the match key; `gs_ID` is the SIS ID, not the Slate ID) and `complete` -> Fields "Other - NSO Completion" (prompt value -1 -> Yes). Keep the mappings that small: with Unsafe on, a name/email mapping would overwrite records.

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

A Caspio or Slate error throws, so the cron invocation shows as failed in Cloudflare (Workers & Pages > nso-completion-sync > Logs). There is no email alert yet. Re-sending is safe: the Slate format is differential and the field is just set to Yes again.
