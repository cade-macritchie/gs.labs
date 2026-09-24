# Check-In

Tablet/mobile-first check-in portal: tap "Scan with camera", point the
device's camera at a registrant's badge, and its QR code is decoded and
handed off for reprinting — no lookup, no manual print step. GitHub-hosted,
like `tools/idea-box/`.

Any device that can load this page and run a camera can scan (including
one that can't run DYMO Connect at all, like a Kindle Fire tablet — see
"Print station" below); only the one Windows machine with the Dymo actually
plugged in needs to be the print station.

There is no logging or persistence here on purpose — this is scan-and-print
only, no record of who checked in or when. (The print queue itself is
short-lived infrastructure, not a check-in record — see "Print station".)

## How it's wired

- **Scanning a badge needs no Slate query at all.** A scanned badge's code
  is itself the check-in credential, so reprinting it is just: decode
  whatever the camera sees, and print it straight back out as a QR code. See
  `handleDecodedValue()`/`renderProfile()`/`printLabel()` in `index.html` —
  the decoded string becomes a synthetic record's `qrUrl`, which is queued
  for the print station (see below) and, if this same device also has a
  Dymo attached, offered as a manual "Print to Dymo" button too.
  - A maindb-backed scan lookup (matching the scanned id back to a person
    record) was tried and abandoned on 2026-09-22: it needed a
    `per_mobile_pass` filter that only matches event-registrant rows (which
    maindb only returns with `alt_form_type=Event`), and reliably
    reconstructing the *exact* originally-scanned payload from whatever got
    decoded turned out to be more fragile than just reprinting the scanned
    value directly. See the comment above `CHECKIN_FIXED_PARAMS` in
    `tools/queryomatic/worker.js` if this is ever revisited.
  - A scanned QR decodes to a value like
    `person:07f59624160e47eea4c10394429ea33f` (confirmed by actually
    decoding a real barcode image) when the badge is a "person" type, or
    just the bare hex GUID with no prefix for other types (e.g. an event
    registrant) — confirmed these differ by testing both. Either way,
    whatever gets scanned is treated as an opaque value to print back out,
    not something this page tries to interpret.
- **"Scan with camera"** opens a full-screen video overlay
  (`navigator.mediaDevices.getUserMedia`) and decodes frames continuously.
  Decoding prefers the native `BarcodeDetector` API where available;
  browsers without it (Safari/iOS as of this writing) fall back to `jsQR`
  (loaded from jsDelivr, same pattern as the existing `qrcode.js` CDN
  script). On a successful decode, the overlay closes and the value is
  queued for the print station — see `handleDecodedValue()`.
  There is no name-search fallback and no manual scan/paste input anymore
  (removed 2026-09-24) — camera scanning is the only entry point.
- **`isProbablyUrl()`/`qrImageProxyUrl()` are kept even though camera-scanned
  codes are never URL-shaped in practice.** They were built for the old
  name-search flow's `per_qr_url` field (a link to a Slate-rendered PNG,
  re-served with CORS via `GET /api/slate/checkin-qr-image` on
  `gs-labs-slate-gateway` — see `handleCheckinQrImage` in
  `tools/queryomatic/worker.js`) and are left in place as a defensive
  fallback in case a decoded value is ever URL-shaped.

## Print station

Added 2026-09-24: check-in doesn't require every scanning device to have a
Dymo attached (most won't — a Kindle Fire, for instance, can't run DYMO
Connect at all, see above). Instead, exactly one device — the Windows
machine with the label printer physically plugged in — opens this same page
and clicks **"Enable as print station."**

- **Every scan is POSTed to a shared queue**, not printed locally. See
  `queueScannedValue()` in `index.html`, which calls
  `POST /api/checkin/print-queue` on `gs-labs-slate-gateway`. That's true
  even on the print station's own device if it also scans — there's exactly
  one code path for "a badge got scanned," not two.
- **The print station polls that same queue** (`GET /api/checkin/print-queue`,
  every 2.5s — see `pollPrintQueue()`) and, for each job it gets back, calls
  the exact same `renderProfile()`/`printLabel()` pair the old direct-print
  flow used, so a relayed scan looks and prints identically to one scanned on
  the print station itself.
- **The queue lives in `OPTIONS_CACHE`** (the same Cloudflare KV namespace
  already bound for the options cache and rate limiter — no new binding
  needed) as a single JSON blob, not one key per job. See "CHECK-IN PRINT
  QUEUE" in `tools/queryomatic/worker.js` for why that's an acceptable
  tradeoff (this is a handful of scans at a check-in table, not a
  high-concurrency queue) and its caveats (a small race window on
  simultaneous scans; capped at 50 pending jobs with a 1-hour TTL so an
  offline print station can't make it grow unbounded).
- **A poll clears what it reads** — jobs are deleted from the queue as soon
  as the print station's GET returns them, on the assumption that exactly
  one print station is active at a time. Two devices both running as "print
  station" simultaneously would race for the same jobs, not each print a
  copy.
- There's no access restriction on who can queue a print job beyond the
  existing origin check (requests must come from this page's own GitHub
  Pages origin) — anyone who can load the Check-In page and scan a badge can
  queue a print, the same trust level the old single-device version had.

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
