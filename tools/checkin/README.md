# Check-In

Tablet/mobile-first check-in portal: tap "Scan with camera", point the
device's camera at a registrant's badge, and its QR code is decoded and
handed off for reprinting — no manual print step. A registrant without their
pass can be looked up by last name instead (registrants of the event
registration form set on the device, see "Look up by last name"). Hosted on GitHub Pages.

Any device that can load this page and run a camera can scan (including
one that can't run DYMO Connect at all, like a Kindle Fire tablet — see
"Print stations" below); only a Windows machine with a Dymo actually plugged in
needs to be a print station.

There is no logging or persistence here on purpose — this is scan-and-print
only, no record of who checked in or when. A lookup is logged by its result
count, never the name searched for. (The print queue itself is
short-lived infrastructure, not a check-in record — see "Print stations".)

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
    value directly.
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
  queued for a print station — see `handleDecodedValue()`.
  The original maindb name search and the manual scan/paste input were
  removed 2026-09-24. A last-name lookup came back 2026-10-27, scoped to one
  event registration form's registrants, and prints through this same scan path — see
  "Look up by last name".
- **`isProbablyUrl()` is kept even though camera-scanned codes are never
  URL-shaped in practice.** It was built for the old name-search flow's
  `per_qr_url` field (a link to a Slate-rendered PNG) and is left in place
  as a defensive fallback in case a decoded value is ever URL-shaped.
  `qrImageProxyUrl()` re-serves such a PNG with CORS via
  `GET /api/slate/checkin-qr-image` on `gs-labs-slate-gateway` (see
  `handleCheckinQrImage` in `tools/queryomatic/worker.js`); the last-name
  lookup uses it to read a registrant's pass QR.

## Look up by last name

Added 2026-10-27 for registrants who arrive without their mobile pass.
Set the event's registration form once per device under "Event registration
form", by its exact title in Slate (or open the page with
`?form=<title>`, e.g. on the link handed to volunteers, which saves it the
same way `?station=` does). Then type a last name under "No pass? Look up by
last name", tap **Find**, then tap the person. Each result shows the name
and, when there is one, the church.

- **Only that form's registrants are searched**, never all of maindb. The
  page calls `GET /api/slate/checkin-search?form_title=<title>&last=<name>`,
  and the Worker runs its own Slate query, `checkin_event_registrants`,
  which matches the one event registration form with that exact title. One
  query serves every conference (BTC 2027 first), so a new event only needs
  its form title typed on the devices. A mistyped title finds nobody, which
  is why the "no registrant" message names the form searched. Matches are
  last names *starting with* what was typed, at least two letters, 25
  results at most.
- **Why not maindb:** checked read-only 2026-10-27, `all_people` filtered to
  an event (BTC 2027: `event_title` + `event_date_start/_end` = 2027-01-30)
  returns one row per person with no registration or pass GUID, no QR value
  and no church. It couldn't print the badge a scan prints. It also can't
  tell an event's individual form from its other forms.
- **A looked-up badge matches a scanned one.** Tapping a result fetches
  Slate's own QR image for that registration
  (`enroll.gs.edu/register/mobile?id=<reg_id>&cmd=barcode`, through
  `checkin-qr-image`), decodes it with jsQR, and hands the decoded value to
  `handleDecodedValue()`, the same function a camera scan calls. So it's
  queued to the selected print station the same way, and the Worker reads
  the name off the same pass page. If the image can't be fetched or decoded,
  the page queues the bare registration GUID instead (32 hex, no dashes). The
  Worker still finds the pass and name from it, but the printed QR then
  encodes the GUID rather than whatever the pass's QR encodes. See
  `passValueFor()`.
- **Passcode.** The lookup needs the `CHECKIN_KEY` secret, sent as
  `X-Checkin-Key`. It's asked for on a device's first search, kept in that
  browser's `localStorage` (`checkin.lookupKey`), and asked for again if the
  Worker rejects it. It's not the Slate gateway key, which must never go on
  a check-in tablet. With `CHECKIN_KEY` unset the Worker refuses every lookup
  (503), unlike `PORTAL_KEY`, because a last-name search can list
  registrants in a way a pass GUID can't.

### The Slate query this needs

Created in Slate 2026-10-27 as `checkin_btc_registrants` (query id
`304b4661-7024-4e06-9bb2-a37670070f24`), pinned to the BTC 2027 individual
registration form (GUID `13b61153-c379-4b88-bffa-d8688ec85af4`). To serve
every conference (2026-10-28) it's renamed `checkin_event_registrants` and
names the form by a `form_title` parameter instead of the pinned GUID. As
built for BTC: one
custom SQL filter (form, not cancelled/declined, not pending,
`len(@last) >= 2`, and the person's last name starts with `@last` via
`left(...) =`, so `%`/`_` aren't wildcards); `reg_id` is the Form Response
GUID; `reg_first`/`reg_last` come from `[person]`; `reg_church` is
`dbo.getFormResponseTopTable(<response>, 'church')`. The BTC form's Church
Name field had no export key, so it was given `church` the same day (older
answers resolve under it too); give other events' church fields the same
key, or the badge prints without one. The spec:

- **Name** `checkin_event_registrants`, Configurable Joins, base **Form
  Responses**, in the same folder as `all_people`.
- **Parameters:** declare both under **Edit Web Service**
  (`<param id="form_title" type="string" />` and
  `<param id="last" type="string" />`).
- **Filter:** in the custom SQL filter, the response's form is an event
  registration form whose title equals `@form_title` exactly, and the
  response isn't Cancelled, Declined or Saved for Later (the same rule
  maindb's `event_*` filters use). A blank `form_title` or `last` must
  match **nobody**, unlike maindb's filters. Keep the event-form limit:
  `form_title` comes from the caller, and the passcode is all that stands
  between a device and any form it names.
- **Exports** (exact names):
  - `reg_id`: the form response's GUID. It must be the `id=` in the
    registrant's mobile-pass link (check one against the "View mobile pass"
    button in a "Thanks for Registering" email).
  - `reg_first`, `reg_last`: the person's first and last name, as the pass
    prints them.
  - `reg_church`: the form's `church` field (the value the pass's Church
    line shows), blank on forms without one.
- **Web service:** JSON, authenticated the same way as `all_people`. Put its
  URL in `wrangler secret put SLATE_CHECKIN_QUERY_URL` and its token in
  `SLATE_TOKEN_CHECKIN` (see `tools/queryomatic/README.md`). The Worker adds
  `output=json`, `form_title` and `last` itself.
- Then `wrangler secret put CHECKIN_KEY` with a passcode to give the
  check-in staff. These three secrets serve every conference.

## Print stations

Added 2026-09-24, multiple stations and push delivery 2026-09-28. A scanning
device doesn't need a Dymo attached (most won't — a Kindle Fire, for
instance, can't run DYMO Connect at all, see above). Instead, each Windows
machine with a label printer plugged in opens this same page, gives itself a
station name ("Main", "Table 2", …), and clicks **"Enable as print
station."** Run as many stations as you have Dymos.

- **Scanners pick a station.** "Send scans to print station" under the scan
  button, remembered per device. `?station=Table%202` in the URL sets it, so
  each table's tablet can bookmark its own link. Picking one checks once
  whether it's online (`GET /api/checkin/print-station?station=…`); nothing
  re-checks on a timer. Names are letters, digits, spaces and hyphens, and
  case doesn't matter.
- **Every scan is POSTed to that station's queue**, not printed locally. See
  `queueScannedValue()` in `index.html`, which calls
  `POST /api/checkin/print-queue` with `{ value, station }`. That's true even
  on a print station's own device if it also scans.
- **Jobs are pushed, not polled.** The print station holds a WebSocket open to
  `/api/checkin/print-station` and each job is sent down it the moment it's
  queued, then printed with the same `renderProfile()`/`printLabel()` pair as
  a local scan. The first version polled every 2.5s, which was ~1,440 Worker
  requests an hour per station (and, before the rate limiter moved off KV,
  1,440 KV writes). Several polling stations behind one office IP would also
  have tripped the 60/min per-IP rate limit. The only recurring traffic now
  is a `ping` every 30s, which Cloudflare answers without waking the Durable
  Object; if nothing comes back for 75s the station redials.
- **One Durable Object per station name** (`CheckinPrintQueue` in
  `tools/queryomatic/worker.js`, `idFromName("station:<name>")`), capped at 50
  pending jobs, with jobs over an hour old dropped. **Not KV:** the first
  version stored the queue in `OPTIONS_CACHE` KV and lost jobs in real use
  (2026-09-25), because KV is eventually consistent across edge locations.
  See "CHECK-IN PRINT QUEUE" in `worker.js`.
- **Nothing is lost while a station is offline.** A job stays queued until the
  station acks it after printing, and everything unacked is re-sent when a
  station connects. The scanner says so when it happens ("… isn't online, so
  this scan is waiting"). A job re-sent after a dropped ack isn't reprinted
  in the same tab.
- **One computer per station name.** A second computer enabling the same name
  takes over, and the first one stops with a message saying so (close code
  4000), so two tabs can never print the same job.
- **Mobile devices are scanners only.** `IS_MOBILE` in `index.html`
  (user-agent sniff covering Android, iOS, iPadOS, and Kindle's Silk
  browser) hides the print-station controls, the DYMO header status, and the
  result card's Print buttons, since none of those can work without DYMO
  Connect.
- **Background tabs are fine.** Jobs arrive as WebSocket messages, which
  aren't throttled. The keep-alive and reconnect timers run in a Web Worker,
  since Chrome and Edge slow main-thread timers in hidden tabs to once a
  minute.
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
(`../local.files.misc/BTC/test.dymo`, outside the repo), checked with DYMO Connect's `RenderLabel`
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
  registrant's name on the right, with their church (added 2026-10-27) in
  smaller type under it. A name longer than 14 characters wraps onto two
  lines so it stays large; a church longer than 22 wraps too. Anything
  switched off or blank is left out and the rest grows into the room. With
  no name and no church, the QR is centered.
  - Every text object uses `FitMode` `AlwaysFit`, which grows short text as
    well as shrinking long text. So the church's box is sized to its line
    count (one line or two), which keeps it smaller than the name. Checked
    with `RenderLabel` 2026-10-27: `ShrinkToFit` doesn't shrink at all in
    this DYMO Connect, it just clips.
- **Vertical layout** (setting): prints the same stock in `Portrait`, with the
  printable rect's axes swapped. The header is centered, then a large QR with
  the name and church centered under it. A title longer than 24 characters wraps onto two
  lines, since the label is only about 2.2in wide this way.
- **The logo** is `assets/brand-new/gs-logo-horizontal-black.png`, drawn onto a
  white canvas at 600px wide before embedding, because a transparent PNG
  can print as a solid black box. The header rule is a 1x1 black PNG
  stretched with `ScaleMode` `Fill`. Both `ImageObject` uses were checked with
  `RenderLabel`.
- **Label size** (setting, added 2026-09-29): 30256 (default) or **DYMO
  30252 address labels** (1-1/8" x 3-1/2"), which DYMO Connect calls
  `Address` (same `<DieCutSKU>` catalog). Its printable rect is the 450
  driver's `Address30252` entry; the 550's `lw5xx.gpd` gives the same numbers.
  At about 1in tall it gets a compact layout, checked with `RenderLabel`: the
  QR fills the height on the left, and the logo, title, name and church
  stack to its right. With a church the name stays on one line. Vertical layout is disabled for this size. Pick the size that's
  actually loaded in the printer. `LABEL_STOCKS` in `index.html` is where to
  add another size.
- **Settings** (label size, event title, logo on/off, name on/off, church
  on/off, vertical layout) live in the print station's own browser
  (`localStorage`, key `checkin.labelSettings`), set from the "Label
  settings" panel under the print-station toggle. They're read fresh on every
  print, and the panel shows a live preview rendered by DYMO Connect itself.
  Clearing that browser's site data resets them to the defaults (logo, name
  and church on, no title). A station saved before the church setting existed
  gets it switched on. The event title field's placeholder suggests "The
  Bible Teaching Conference 2027" for BTC, but only what's typed prints.
- **The name and church** come from the Worker, not the scanner. When a
  scan (or a last-name lookup) is queued, `lookupCheckinPass()` in
  `tools/queryomatic/worker.js` opens that pass's Slate mobile page
  (`enroll.gs.edu/register/mobile?id=<guid>[&type=<type>]`) on the server and
  stores the name and church with the job. The church is the BTC 2027 pass's
  `<p class="pass__church">` (`p.pass_church` also accepted); a pass without
  one prints no church line. Where the name lives depends on the pass
  template. The custom event pass uses `<p class="pass__name">` (double
  underscore, first and last name split by a `<br>`). The default "person"
  pass uses a bare `<div>` inside `.pass_badge`. `p.pass_name` is also
  accepted. There is **no** fallback to `<title>` or `.pass_title`: on the
  custom template both hold the event title, which is what the first
  version printed as the "name". If nothing matches, the label prints
  without a name rather than the scan failing. The Worker logs only the
  lookup's outcome and the page's element classes (e.g.
  `nameLookup: "pass-name church [div.pass_container …]"`), never the name
  or church. So if a new pass template ever prints no name or church, the
  logs show its structure.

The header shows a live "DYMO ready — <printer name>" / "DYMO Connect not
detected" status so staff can tell at a glance whether printing will work,
without having to try a search first.

**Only a printer DYMO Connect reports as connected is used**
(`findLabelPrinter()`). When a Dymo is replugged or its driver reinstalled,
Windows keeps the old queue and adds a new one, e.g. `DYMO LabelWriter 550`
(disconnected) next to `DYMO LabelWriter 550 (Copy 1)` (connected), and the
stale one is often listed first. Before 2026-09-29 the page took the first
LabelWriter in the list, so a new machine "printed" to a dead queue and
nothing came out. If none is connected, the header says "DYMO printer not
connected", and a print attempt names the queues it found.

**A new print station needs no DYMO Connect setup beyond the install.** No
label files or templates are configured in DYMO Connect. The page sends the
complete label XML with every print. What a new machine does need: DYMO
Connect installed and running (its tray web service is what the page talks
to), the Dymo plugged in and showing as connected, and the header reading
"DYMO ready — …".

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

You can exercise the scan and lookup flows and on-screen QR rendering without DYMO
Connect installed at all — the QR preview always renders (it's independent
of Dymo), and hitting "Print to Dymo" with DYMO unavailable surfaces the
"Print via browser dialog instead" fallback rather than failing silently.
