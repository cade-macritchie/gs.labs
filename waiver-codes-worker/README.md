# Slate Waiver Codes — Worker setup

A small Cloudflare Worker + D1 database for waiver codes used at checkout in a
Slate form. Each code has a remaining-use `amount`; a form's client-side
script checks a code, confirms it still has balance, and decrements it once
the waiver is applied. No admin UI — manage codes with `curl`/`wrangler` or
build one later.

## 1. Deploy the Worker

```bash
npm install -g wrangler
wrangler login

cd waiver-codes-worker
wrangler d1 create slate-waiver-codes
# paste the returned database_id into wrangler.toml under [[d1_databases]]

wrangler d1 execute slate-waiver-codes --remote --file ./schema.sql
# on an already-deployed database, also run any new files under ./migrations
# in order, e.g.:
wrangler d1 execute slate-waiver-codes --remote --file ./migrations/0001_add_notes_and_initial_amount.sql

wrangler secret put ADMIN_KEY
wrangler deploy
```

`ADMIN_KEY` is the shared passphrase required to add or list waiver codes.
Use a long, random value and keep it out of any Slate form script — it should
only ever be used from a trusted machine (e.g. when loading a new batch of
codes), never sent from the browser-side form.

Edit `wrangler.toml` first:
- `ALLOWED_ORIGIN` — the origin the Slate form is served from, e.g.
  `https://enroll.gs.edu`. Only same-origin requests from this host get a
  CORS-allowed response.

`wrangler deploy` prints your Worker URL, e.g.
`https://slate-waiver-codes.yoursubdomain.workers.dev`. Point the Slate
form's script at that URL — see `local-files/Other/waiver-code-api.md` for
call examples covering all four operations.

## API

Codes are stored uppercased and trimmed, so lookups are case-insensitive.

- `POST /api/waiver-codes` — **admin only** (`X-Admin-Key` header). Body:
  `{ code, amount, notes? }`. Creates a new waiver code with that many uses;
  `initial_amount` is set to `amount` at creation and never changes
  afterward. 409 if the code already exists.
- `GET /api/waiver-codes/:code` — check that a code matches an existing
  record. Returns `{ valid: true, waiverCode }` or 404
  `{ valid: false, error }`.
- `GET /api/waiver-codes/:code/limit` — check whether the code still has
  uses left. Returns `{ valid: amount > 0, amount }` or 404 if the code
  doesn't exist.
- `POST /api/waiver-codes/:code/decrement` — consume one use. Atomic: it
  only decrements (and only succeeds) if `amount > 0`, so two near-
  simultaneous requests can't drive it negative. Returns the updated
  `waiverCode` on success, 409 `{ error: 'waiver code limit reached' }` if
  the balance was already 0, or 404 if the code doesn't exist.
- `GET /api/waiver-codes` — **admin only** (`X-Admin-Key` header). Lists
  every code, newest first.
- `GET /api/waiver-codes/summary` — **admin only** (`X-Admin-Key` header).
  Returns `{ totalRegistrants, codeCount }`, where `totalRegistrants` is the
  sum of every code's `initial_amount` (its original limit, unaffected by
  later decrements) excluding any code whose `notes` mentions "admin".

## Notes

- No Slate token sync — this Worker only knows about codes you add to it
  directly; it has no awareness of Slate records.
- The decrement endpoint doubles as the limit check in practice (it refuses
  to go below 0), but the separate `/limit` endpoint lets the form validate
  and show an inline message *before* actually committing to using the code.
- Cloudflare's free tier (D1 + Workers) comfortably covers this volume.
