# Check-In

Tablet/mobile-first check-in portal: scan a registrant's badge to reprint
its QR code, or search by name to look one up, then print to a Dymo label
printer. GitHub-hosted, like `tools/idea-box/`; the backend is two routes on
the existing `gs-labs-slate-gateway` Cloudflare Worker.

There is no logging or persistence here on purpose — this is
scan/search-and-print only, no record of who checked in or when.

## How it's wired

- **Scanning a badge needs no Slate query at all.** A scanned badge's code
  is itself the check-in credential, so reprinting it is just: take
  whatever was scanned or pasted into the scan input, and print it straight
  back out as a QR code. See `renderProfile()`/`printLabel()` in
  `index.html` — the scan-form handler just builds a synthetic record with
  the raw scanned value as `qrUrl` and hands it to the same rendering/print
  path name search already uses, no lookup step in between.
  - A maindb-backed scan lookup (matching the scanned id back to a person
    record) was tried and abandoned on 2026-09-22: it needed a
    `per_mobile_pass` filter that only matches event-registrant rows (which
    maindb only returns with `alt_form_type=Event`), and reliably
    reconstructing the *exact* originally-scanned payload from whatever got
    pasted turned out to be more fragile than just reprinting the scanned
    value directly. See the comment above `CHECKIN_FIXED_PARAMS` in
    `tools/queryomatic/worker.js` if this is ever revisited.
  - A scanned QR decodes to a value like
    `person:07f59624160e47eea4c10394429ea33f` (confirmed by actually
    decoding a real barcode image) when the badge is a "person" type, or
    just the bare hex GUID with no prefix for other types (e.g. an event
    registrant) — confirmed these differ by testing both. Either way,
    whatever gets scanned is treated as an opaque value to print back out,
    not something this page tries to interpret.
- The scan input is focused by default and refocused after every reprint,
  since a USB/Bluetooth badge scanner behaves like a keyboard — it just
  needs whatever field is focused to receive its keystrokes, then submits on
  the Enter it sends at the end.
- **Name search is separate and does query Slate.** The page calls
  `GET /api/slate/checkin-search` on `gs-labs-slate-gateway` directly (no
  Slate wrapper/iframe involved) with `first`/`last`/`sisid` params, the
  same name-splitting strategy Record Lookup's wrapper uses against
  maindb. See the route's entry in `tools/queryomatic/README.md` and
  `handlePagesSlateProxyRoute` in `tools/queryomatic/worker.js`.
- **Name search currently searches the whole maindb population** — there's
  no event scoping yet. `tools/queryomatic/worker.js` has a
  `CHECKIN_FIXED_PARAMS` constant (currently `{}`) specifically for adding
  a parameter that should always be sent on every check-in name search once
  there's one (e.g. scoping to one event), the same mechanism
  `/api/slate/inquiries` uses to pin `status: "Inquiry"`.
- **Name search's QR field is `per_qr_url`, and it's a link to an image, not
  a code.**
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

## Dymo printing

Printing goes through DYMO's own browser SDK (`dymo.label.framework.*`),
which talks to the DYMO Connect desktop app running locally on the check-in
device. `vendor/dymo.connect.framework.js` is committed here (fetched
2026-09-22 straight from `dymosoftware/dymo-connect-framework`, DYMO's own
GitHub org, with one local patch — see below) — nothing to download
separately.

**The label schema actually matters, and it's not the one in DYMO's public
docs/samples.** Confirmed 2026-09-22 by calling DYMO Connect's local print
service directly (`https://127.0.0.1:41951/DYMO/DLS/Printing/PrintLabel`),
bypassing the browser entirely, that this DYMO Connect installation rejects
the widely-documented `<DieCutLabel>` schema outright at the print step —
`Invalid label file: The 'DieCutLabel' element is not declared.` — even
though every official DYMO sample file (and the original version of this
page) used exactly that schema. The schema it actually accepts is the newer
`<DesktopLabel><DYMOLabel Version="4">...` one; `isDCDLabel()` in the SDK is
checking for exactly this (a literal `"</DYMOLabel>"` in the label's XML).

`LABEL_XML_QR` in `index.html` (used for the scan/reprint flow) is adapted
directly from a label Cade created and saved in the DYMO Connect app itself
(`local-files/BTC/test.dymo`) and is fully verified end to end: printed
successfully via a direct call to DYMO Connect's local service, rendered via
its `RenderLabel` endpoint to confirm the QR code actually appears (an
earlier attempt at reconstructing the schema produced a label that printed
"successfully" per the API but rendered a blank box — no QR at all, because
the `QRCodeObject`'s `BackgroundBrush` needs to be opaque white, not
transparent like every other object's; a `QRCodeObject` also needs its
`FillBrush` opaque, unlike a plain text object), and had that rendered image
decoded to confirm it actually encodes the value that was set, not stale
placeholder content. `setObjectText` for a `QRCodeObject` needs a local
patch to `vendor/dymo.connect.framework.js`: the version fetched straight
from DYMO's repo only updates `<Data><DataString>`, but DYMO Connect can
keep displaying/encoding the *original* designed-in value unless
`<TextDataHolder><Value>` is *also* updated — a real bug fixed by the
community (see
[DCD-SDK-Sample#12](https://github.com/dymosoftware/DCD-SDK-Sample/issues/12)),
patched into the vendored copy here.

`LABEL_XML_IMAGE` (used for the name-search/`per_qr_url` flow, where there's
no underlying text value to encode — only a link to an image Slate already
rendered) is adapted to the same schema's conventions but has **not** been
verified the same thorough way — its `ImageObject` shape is inferred from
`_setImageObjectText`'s `isDCDLabel()` branch (a direct `<Data>` child, not
nested like `QRCodeObject`'s), not confirmed against a real DYMO-authored
example. Do a real test print of a name-search result before relying on it;
if it fails or renders blank, get another DYMO Connect-authored `.dymo` file
(this time with an Image object — same way `test.dymo` was made) and adapt
`LABEL_XML_IMAGE` to match, the same way `LABEL_XML_QR` was fixed.

Both labels reuse the exact `DYMORect` `test.dymo` used — a 30251 Address
label, ~3.21in x 1in. To use different label stock, resize
`DYMORect`/`ObjectLayout` in `index.html`; note this schema uses **inches**
(`DYMOPoint`/`Size`), not twips like the old `<DieCutLabel>` schema did.

The header shows a live "DYMO ready — <printer name>" / "DYMO Connect not
detected" status so staff can tell at a glance whether printing will work,
without having to try a search first.

### If this ever breaks again

Don't guess at the XML blind — DYMO Connect's local web service can be
called directly to iterate fast, without needing the browser or a physical
test print for every attempt:

```
GET  https://127.0.0.1:41951/DYMO/DLS/Printing/GetPrinters
POST https://127.0.0.1:41951/DYMO/DLS/Printing/PrintLabel
     body (form-urlencoded): printerName=<name>&printParamsXml=&labelXml=<xml>&labelSetXml=
POST https://127.0.0.1:41951/DYMO/DLS/Printing/RenderLabel
     body (form-urlencoded): labelXml=<xml>&renderParamsXml=&printerName=<name>
     → returns a JSON-quoted base64 PNG of what would actually print
```
`RenderLabel` is what caught the invisible-QR bug above — it shows you what
DYMO Connect thinks the label looks like without spending a physical label
on every guess.

## Local testing without a printer

You can exercise the search flow and on-screen QR rendering without DYMO
Connect installed at all — the QR preview always renders (it's independent
of Dymo), and hitting "Print to Dymo" with DYMO unavailable surfaces the
"Print via browser dialog instead" fallback rather than failing silently.
