# Gateway Seminary Merchandise Tool

Three things in one Next.js app:

| Page | Route | Access |
|---|---|---|
| Order form | `/order` | Public |
| Catalog admin (product CRUD) | `/admin` | Password |
| Catalog PDF (download / email) | `/admin/catalog` | Password |
| Submitted orders | `/admin/orders` | Password |

Product data lives in SQLite (via Prisma). The catalog PDF is rendered from a
styled HTML template by headless Chromium (Puppeteer), with images and fonts
inlined as data URIs so it needs no network access at generation time.

## Setup

```bash
npm install
npx puppeteer browsers install chrome   # only if Chromium wasn't downloaded on install
cp .env.example .env                    # then edit the values
npx prisma migrate dev
npx prisma db seed                      # optional sample products
npm run dev
```

Then open http://localhost:3000/order, or http://localhost:3000/admin and sign
in with `ADMIN_PASSWORD`.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file, e.g. `file:./dev.db` |
| `ADMIN_PASSWORD` | The shared admin password |
| `SESSION_SECRET` | Signs the admin session cookie — use a long random string |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Outgoing mail. **Leave `SMTP_HOST` blank to disable email entirely** — orders still save, they just don't notify |
| `MAIL_FROM` | From address on outgoing mail |
| `STAFF_NOTIFICATION_EMAIL` | Who gets notified when an order comes in |

## Branding

The palette, type, and shape language follow the Gateway Seminary 2026 brand:
only the seven approved colors, Tiempos Fine for headings, Montserrat for
labels, Open Sans for body, and a 4px corner radius. Tokens are defined once in
`src/app/globals.css` (`@theme`) and mirrored in `src/lib/catalog/template.ts`
for the PDF.

Two things to know:

- The Tiempos Fine files are Klim's **Test Fonts** build — evaluation-only, and
  they contain just 66 glyphs (no `$`, `!`, `?`, `&`). Prices and punctuation
  therefore stay in the Montserrat/Open Sans tiers. Swap in purchased OTFs
  before any public-facing use; regenerate with:
  `python -m fontTools.ttLib.woff2 compress -o out.woff2 in.otf`
- Logos and fonts served to the browser live in `public/brand/`, copied from
  `../brand-assets/`.

## How the pieces fit

- `src/lib/products.ts` — the only place products are queried; used by the admin
  pages, the order form, and the PDF generator.
- `src/lib/auth.ts` + `src/middleware.ts` — signed-cookie session (JWT via
  `jose`), checked in middleware and again in each admin API route.
- `src/lib/catalog/template.ts` — builds the catalog HTML and renders the PDF.
- `src/lib/mailer.ts` — Nodemailer transport; `trySendMail` is used where a
  failed send must not fail the request (order submission).
- Orders snapshot `productName`, `sku`, and `unitPrice` at submission time, so
  later price edits never rewrite past orders. Submitted prices from the client
  are ignored; the server re-reads them from the database.

## Bulk editing with CSV

**Update by CSV** on the `/admin` dashboard (next to *Add product*) exports the
whole catalog — hidden products included — as a CSV and takes an edited sheet
back. The workflow is download → edit in Excel or Sheets → upload → **Check
file** (a dry run that reports what would change and which rows are unusable) →
**Apply import**.

Columns: `sku`, `name`, `price`, `category`, `description`, `active`,
`sortOrder`. Common header spellings are accepted too (`Item Number`,
`Product Name`, `Price USD`, `Status`, `Sort Order`), and prices may be written
`18`, `18.00`, or `$18.00`.

Rules worth knowing:

- Rows match on **SKU**: a known SKU is updated, an unknown one is created.
- **An import never deletes.** Products missing from the file are untouched. To
  retire an item, set `active` to `no` (or delete it on the product page).
- **A blank cell means "leave unchanged"**, so a half-filled sheet can't wipe
  existing descriptions. Only new products need a name and price.
- Images can't be set from CSV; uploads happen on the product page and survive
  a CSV update.
- Bad rows are skipped and reported by line number — the rest still apply.

## Deploying

Puppeteer, SQLite, and local image uploads all need a persistent filesystem, so
run this on an always-on Node host (small VPS, Docker container, or an on-prem
machine) rather than a serverless platform.

```bash
npm run build
npm run start
```

### Slate embed

Staff reach the order form through the Slate portal
`https://enroll.gs.edu/portal/merch-order`, which iframes this app's `/order`
page using `../slate-templates/wrappers/merch-order-wrapper.liquid.html`. After
deploying, replace `MERCH-APP-HOST` in that wrapper (both the iframe `src` and
`MERCH_APP_ORIGIN`) with the real host and paste it into the portal.

- `next.config.ts` lets only `https://enroll.gs.edu` frame `/order`, and forbids
  framing `/admin` (its `SameSite=Lax` cookie wouldn't work in a cross-site
  iframe anyway), so admins use the app's own URL directly.
- `src/lib/embed.ts` posts `merch-order-resize` (page height) and
  `merch-order-scroll-top` (after a successful submit) to the wrapper. If the
  portal ever moves off `enroll.gs.edu`, update the origin in both files.
- The host must serve HTTPS, or the browser will block the iframe as mixed
  content.

Back up **both** `dev.db` (or whatever `DATABASE_URL` points at) and
`public/uploads/products/` — the database references those files by path.
