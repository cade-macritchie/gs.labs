# Check-In

Tablet/mobile-first check-in portal: search `all_people`/maindb by name, then
print the matched person's `per_qr` value as a QR code to a Dymo label
printer. GitHub-hosted, like `tools/idea-box/`; the only backend piece is one
route on the existing `gs-labs-slate-gateway` Cloudflare Worker.

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
- **The maindb Slate query must export `per_qr`.** The Worker passes columns
  through unchanged; if `per_qr` comes back blank, that's a Slate-side export
  configuration issue, not something to fix here.
- QR rendering is client-side via the `qrcode` npm package loaded from
  jsDelivr — no server involvement, it just encodes whatever string is in
  `per_qr`.

## Dymo printing — needs a real test print before an event

Printing goes through DYMO's own browser SDK (`dymo.label.framework.*`),
which talks to the DYMO Connect desktop app running locally on the check-in
device. Two things to do before relying on this live:

1. **Get the SDK file.** See `vendor/README.md` — download
   `dymo.connect.framework.js` from DYMO's SDK and commit it into `vendor/`.
   Without it, the page still works but only offers the browser-print
   fallback (a plain `window.print()` of the QR code and name).
2. **Verify the label XML.** `LABEL_XML` in `index.html` targets a 30334
   (2-1/4in x 1-1/4in) label with a QR object on the left and the person's
   name on the right, built from the documented DYMO Label XML schema — it
   has **not** been tested against a physical LabelWriter. Do one real test
   print, and if it's misaligned or on the wrong stock, adjust
   `<PaperName>` and each `<Bounds>` in `LABEL_XML` to match. The easiest way
   to get a known-good template is to design a label once in the DYMO
   Connect desktop app, save it, and copy its XML into this constant instead
   of hand-tuning bounds.

The header shows a live "DYMO ready — <printer name>" / "DYMO Connect not
detected" status so staff can tell at a glance whether printing will work,
without having to try a search first.

## Local testing without a printer

You can exercise the search flow and on-screen QR rendering without DYMO
Connect installed at all — the QR preview always renders (it's independent
of Dymo), and hitting "Print to Dymo" with DYMO unavailable surfaces the
"Print via browser dialog instead" fallback rather than failing silently.
