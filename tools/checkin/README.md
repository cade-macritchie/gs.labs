# Check-In

Tablet/mobile-first check-in portal: scan a registrant's badge/QR code (or
search by name), then print their QR code to a Dymo label printer.
GitHub-hosted, like `tools/idea-box/`; the backend is two routes on the
existing `gs-labs-slate-gateway` Cloudflare Worker.

There is no logging or persistence here on purpose — this is
scan/search-and-print only, no record of who checked in or when.

## How it's wired

- The page calls `GET /api/slate/checkin-search` on `gs-labs-slate-gateway`
  directly (no Slate wrapper/iframe involved) with `first`/`last`/`sisid`
  params for name search, the same name-splitting strategy Record Lookup's
  wrapper uses against maindb. See the route's entry in
  `tools/queryomatic/README.md` and `handlePagesSlateProxyRoute` in
  `tools/queryomatic/worker.js`.
- **Scanning a badge looks the person up by `per_guid` instead.** A scanned
  QR code decodes to `person:<32 hex chars, no dashes>` — confirmed by
  actually decoding a real barcode image, not by guessing from the URL that
  renders it. `index.html`'s `extractGuid()` pulls that GUID out of whatever
  gets scanned or pasted into the same input (a raw scan, a pasted
  `.../register/mobile?id=<guid>...` link, or a bare GUID with or without
  dashes all work), reformats it to the standard dashed form, and calls
  `checkin-search` with `per_guid=<dashed-guid>`. This is a maindb filter
  Cade added directly in Slate's query builder for the maindb query behind
  `SLATE_QUERY_URL` on 2026-09-22 — it has to be configured as an actual
  filter/prompt on *that specific query*, not just present as an export
  column, or it's silently ignored (returns the whole unfiltered
  population instead of erroring). See the "What maindb's parameters
  actually mean" note in `tools/queryomatic/README.md` if this ever seems to
  stop working, e.g. after the query gets rebuilt.
- The scan input is focused by default and refocused after every lookup,
  since a USB/Bluetooth badge scanner behaves like a keyboard — it just
  needs whatever field is focused to receive its keystrokes, then submits on
  the Enter it sends at the end.
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
device. `vendor/dymo.connect.framework.js` is committed here (fetched
2026-09-22 straight from `dymosoftware/dymo-connect-framework`, DYMO's own
GitHub org) — nothing to download separately.

Its actual source (not just the documented API) was checked to get the
implementation right:

- **There is no `setObjectImage()`.** `setObjectText(name, value)` is the
  only setter; called on an `ImageObject` it dispatches internally to a
  handler that only has a working code path when the label XML is authored
  in the older `<DieCutLabel>` schema (used here, same as every official
  DYMO sample label) — it then finds that object's `<Image>` element and
  overwrites its content. That's what `printLabel()` in `index.html` does.
- **A `QRCodeObject`'s value can't be set dynamically in this schema at
  all** — the SDK's internal handler for it has no code path for
  `<DieCutLabel>`-schema labels, only for DYMO's newer `<DYMOLabel>` schema.
  So there's one printing code path, not two: a non-URL QR value (never seen
  live, but handled) is rendered to a PNG via QRCode.js first, then printed
  through the same `ImageObject` path as the normal `per_qr_url` case.
- **`getPrinters()` printer-type value is `"LabelWriterPrinter"`** —
  confirmed present in the SDK source; nothing else is checked for.

**What's still unverified is physical alignment.** `LABEL_XML_IMAGE` in
`index.html` targets a 30334 (2-1/4in x 1-1/4in) label with the QR image on
the left and the person's name on the right — do one real test print, and if
it's misaligned or on the wrong stock, adjust `<PaperName>` and each
`<Bounds>` to match. The easiest way to get a known-good template is to
design a label once in the DYMO Connect desktop app, save it, and copy its
XML into this constant instead of hand-tuning bounds.

The header shows a live "DYMO ready — <printer name>" / "DYMO Connect not
detected" status so staff can tell at a glance whether printing will work,
without having to try a search first.

## Local testing without a printer

You can exercise the search flow and on-screen QR rendering without DYMO
Connect installed at all — the QR preview always renders (it's independent
of Dymo), and hitting "Print to Dymo" with DYMO unavailable surfaces the
"Print via browser dialog instead" fallback rather than failing silently.
