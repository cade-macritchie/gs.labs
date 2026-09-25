# Check-In

Tablet/mobile-first check-in portal: tap "Scan with camera", point the
device's camera at a registrant's badge, and its QR code is decoded and
handed off for reprinting — no lookup, no manual print step. Hosted on
GitHub Pages.

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
- **The queue is a Durable Object** (`CheckinPrintQueue` in
  `tools/queryomatic/worker.js`, bound as `CHECKIN_PRINT_QUEUE` in
  `wrangler.toml`), capped at 50 pending jobs, with jobs over an hour old
  dropped. **Not KV:** the first version stored the queue in `OPTIONS_CACHE`
  KV and lost jobs in real use (2026-09-25). KV is eventually consistent across
  Cloudflare's edge locations, and a phone on cellular and the print station
  on office Wi-Fi hit different ones, so the station could go up to a minute
  without seeing a scan. See "CHECK-IN PRINT QUEUE" in `worker.js`.
- **A poll clears what it reads** — jobs are deleted from the queue as soon
  as the print station's GET returns them, on the assumption that exactly
  one print station is active at a time. Two devices both running as "print
  station" simultaneously would race for the same jobs, not each print a
  copy.
- **Mobile devices are scanners only.** `IS_MOBILE` in `index.html`
  (user-agent sniff covering Android, iOS, iPadOS, and Kindle's Silk
  browser) hides the print-station toggle, the DYMO header status, and the
  result card's Print buttons, since none of those can work without DYMO
  Connect. The scanner's confirmation ("✓ Sent to the print station")
  appears on the result card, right under the QR preview.
- **Keep the print station's tab in the foreground.** Chrome and Edge
  throttle timers in background or minimized tabs (down to about once a
  minute after a few minutes), which would slow polling to match.
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

The object shapes (`QRCodeObject`, `TextObject`, brushes) come from a label
Cade created and saved in the DYMO Connect app itself
(`local-files/BTC/test.dymo`), checked with DYMO Connect's `RenderLabel`
endpoint. Two traps it found: a `QRCodeObject` needs an opaque white
`BackgroundBrush` and opaque `FillBrush`, or it renders as an empty box while
the print call still reports success. And the SDK's `setObjectText` for a QR
needs a local patch to `vendor/dymo.connect.framework.js` to update
`<TextDataHolder><Value>` too (see
[DCD-SDK-Sample#12](https://github.com/dymosoftware/DCD-SDK-Sample/issues/12)).
The page no longer calls `setObjectText`. `buildLabelXml()` writes every value
into the XML directly, so the settings preview is exactly what prints.
Coordinates are in inches (`DYMOPoint`/`Size`), not twips.

### The label (added 2026-09-25)

- **Stock: DYMO 30256 shipping labels** (2-5/16" x 4"), printed landscape.
  DYMO Connect calls this stock `LargeShipping` in `<LabelName>`. It rejects
  the printer driver's name for it (`Shipping30256`: "The labelname ... is
  not available"). The real name is in the `<DieCutSKU>` catalog embedded in
  `DYMOConnect.exe`. The printable rect in `LABEL_STOCK` comes from the
  LabelWriter 450 driver's `Shipping30256` entry (`Drivers/DLS/lw450c.gpd`
  under DYMO Connect's install folder).
- **Layout** (`buildLabelXml()`): Gateway logo, then the event title, then a
  thin rule across the top. Below that, the QR code on the left and the
  registrant's name on the right. A name longer than 14 characters wraps
  onto two lines so it stays large. Anything switched off is left out and
  the rest grows into the room. With no name, the QR is centered.
- **Vertical layout** (setting): prints the same stock in `Portrait`, with the
  printable rect's axes swapped. The header is centered, then a large QR with
  the name centered under it. A title longer than 24 characters wraps onto two
  lines, since the label is only about 2.2in wide this way.
- **The logo** is `assets/brand-new/gs-logo-horizontal-black.png`, drawn onto a
  white canvas at 600px wide before embedding, because a transparent PNG
  can print as a solid black box. The header rule is a 1x1 black PNG
  stretched with `ScaleMode` `Fill`. Both `ImageObject` uses were checked with
  `RenderLabel`.
- **Settings** (event title, logo on/off, name on/off, vertical layout) live in the print
  station's own browser (`localStorage`, key `checkin.labelSettings`), set
  from the "Label settings" panel under the print-station toggle. They're
  read fresh on every print, and the panel shows a live preview rendered by
  DYMO Connect itself. Clearing that browser's site data resets them to the
  defaults (logo and name on, no title).
- **The name** comes from the Worker, not the scanner. When a scan is
  queued, `lookupCheckinPassName()` in `tools/queryomatic/worker.js` opens
  that pass's Slate mobile page
  (`enroll.gs.edu/register/mobile?id=<guid>[&type=<type>]`) on the server and
  stores the name with the job. Where the name lives depends on the pass
  template. The custom event pass uses `<p class="pass__name">` (double
  underscore, first and last name split by a `<br>`). The default "person"
  pass uses a bare `<div>` inside `.pass_badge`. `p.pass_name` is also
  accepted. There is **no** fallback to `<title>` or `.pass_title`: on the
  custom template both hold the event title, which is what the first
  version printed as the "name". If nothing matches, the label prints
  without a name rather than the scan failing. The Worker logs only the
  lookup's outcome and the page's element classes (e.g.
  `nameLookup: "pass-name [div.pass_container …]"`), never the name. So if a
  new pass template ever prints no name, the logs show its structure.

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
