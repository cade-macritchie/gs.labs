# Slate Idea Box — Worker setup

A small Cloudflare Worker + D1 database backing `tools/idea-box/index.html`. No
Slate integration — it just stores submitted ideas, vote counts, and status.

## 1. Deploy the Worker

```bash
npm install -g wrangler
wrangler login

cd idea-box-worker
wrangler d1 create slate-idea-box
# paste the returned database_id into wrangler.toml under [[d1_databases]]

wrangler d1 execute slate-idea-box --remote --file ./schema.sql

wrangler secret put ADMIN_KEY
wrangler deploy
```

`ADMIN_KEY` is the shared passphrase that unlocks status changes and
deletion in the frontend's admin mode. Use a long, random value and share it
only with whoever should be able to triage ideas.

Edit `wrangler.toml` first:
- `ALLOWED_ORIGIN` — your GitHub Pages origin, e.g.
  `https://cade-macritchie.github.io`

`wrangler deploy` prints your Worker URL, e.g.
`https://slate-idea-box.yoursubdomain.workers.dev`.

## 2. Point the frontend at it

Open `../tools/idea-box/index.html` and set:

```js
const WORKER_URL = "https://slate-idea-box.yoursubdomain.workers.dev";
```

## API

- `GET /api/ideas` — list ideas, sorted by votes desc then newest first.
- `POST /api/ideas` — `{ title, description?, url?, submitter? }`, creates
  an idea with `status: "new"` and `votes: 0`.
- `POST /api/ideas/:id/vote` — increments the vote count by 1. The frontend
  tracks which ideas a browser has already voted on in `localStorage` to
  avoid repeat votes from the same person; the Worker itself doesn't
  enforce this (there's no login), so it's a soft limit.
- `PATCH /api/ideas/:id` — admin only (`X-Admin-Key` header). Body:
  `{ status }`, one of `new`, `planned`, `in-progress`, `done`, `declined`.
- `DELETE /api/ideas/:id` — admin only (`X-Admin-Key` header).

## Notes

- No Slate tokens or scheduled sync — this tool is entirely self-contained.
- Cloudflare's free tier (D1 + Workers) comfortably covers internal,
  low-volume use like this.
