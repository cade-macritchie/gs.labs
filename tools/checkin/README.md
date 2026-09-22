# Check-In

Tablet/mobile-first check-in portal: search `all_people`/maindb by name, then
print the matched person's QR code to a Dymo label printer. GitHub-hosted,
like `tools/idea-box/`; the backend is two routes on the existing
`gs-labs-slate-gateway` Cloudflare Worker.

There is no logging or persistence here on purpose — this is search-and-print
only, no record of who checked in or when.

## How it's wired

- The page calls `GET /api/slate/checkin-search` on `gs-labs-slate-gateway`
  directly (no Slate wrapper/iframe involved) with `first`/`last`/`sisid`
  params, the same name-splitting search strategy Record Lookup's wrapper
  uses against maindb. See the route's entry in
  `tools/queryomatic/README.md` and `handlePagesSlateProxyRoute` in
  `tools/queryomatic/worker.js`.
- **Currently searches the whole maindb population** — there's no event
  scoping yet. `tools/queryomatic/worker.js` has a `CHECKIN_FIXED_PARAMS`
  constant (currently `{}`) specifically for adding a parameter that should
  always be sent on every check-in search once you have one (e.g. scoping to
  one event), the same mechanism `/api/slate/inquiries` uses to pin
  `status: "Inquiry"`.
- **The QR field is `per_qr_url`, and it's a link to an image, not a code.**
  Verified against the live query on 2026-09-22: maindb's QR column comes
  back as `per_qr_url`, holding a URL like
  `https://enroll.gs.edu/register/mobile?id=<guid>&cmd=barcode&type=person`
  that Slate resolves to an already-rendered PNG. So this page doesn't encode
  anything itself for that case — it displays and prints Slate's own image.
  (`per_qr`/`qr` remain as fallback field names in `index.html`'s
  `normalize()`, and if a value ever comes back that *isn't* URL-shaped, the
  page falls back to encoding it client-side as a QR code instead — see
  `isProbablyUrl()`.)
- **That image URL needs a second Worker route to be printable.**
  `enroll.gs.edu` sends no CORS headers on the image response, so a plain
  `<img>` tag can display it (tag loads aren't CORS-gated) but page script
  can't read its pixel bytes — which the Dymo print path needs, to hand the
  image to the SDK. `GET /api/slate/checkin-qr-image?url=<per_qr_url value>`
  re-fetches it server-side and re-serves the bytes with CORS headers for
  `ALLOWED_ORIGIN`. The `url` param is checked against an exact pattern
  (`CHECKIN_QR_IMAGE_PATTERN` in `worker.js`) matching Slate's own
  host/path/query shape with a GUID-validated `id`, so this can't be used as
  an open image-fetching proxy for arbitrary URLs.

## Dymo printing — needs a real test print before an event

Printing goes through DYMO's own browser SDK (`dymo.label.framework.*`),
which talks to the DYMO Connect desktop app running locally on the check-in
device. Two things to do before relying on this live:

1. **Get the SDK file.** See `vendor/README.md` — download
   `dymo.connect.framework.js` from DYMO's SDK and commit it into `vendor/`.
   Without it, the page still works but only offers the browser-print
   fallback (a plain `window.print()` of the QR image and name).
2. **Verify the label XML.** `LABEL_XML_IMAGE` in `index.html` targets a
   30334 (2-1/4in x 1-1/4in) label with an `ImageObject` on the left (fed
   Slate's PNG via `label.setObjectImage`) and the person's name on the
   right, built from the documented DYMO Label XML schema — it has **not**
   been tested against a physical LabelWriter. Do one real test print, and
   if it's misaligned or on the wrong stock, adjust `<PaperName>` and each
   `<Bounds>` to match. The easiest way to get a known-good template is to
   design a label once in the DYMO Connect desktop app, save it, and copy
   its XML into this constant instead of hand-tuning bounds. `LABEL_XML_TEXT`
   is the original QR-code-object template, kept only as the fallback path
   for a non-URL QR value.

The header shows a live "DYMO ready — <printer name>" / "DYMO Connect not
detected" status so staff can tell at a glance whether printing will work,
without having to try a search first.

## Local testing without a printer

You can exercise the search flow and on-screen QR rendering without DYMO
Connect installed at all — the QR preview always renders (it's independent
of Dymo), and hitting "Print to Dymo" with DYMO unavailable surfaces the
"Print via browser dialog instead" fallback rather than failing silently.
