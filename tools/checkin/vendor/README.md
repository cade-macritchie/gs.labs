# vendor/

`dymo.connect.framework.js` lives here, committed (fetched 2026-09-22 from
`https://raw.githubusercontent.com/dymosoftware/dymo-connect-framework/master/dymo.connect.framework.js`
— DYMO's own official GitHub org, not a guess). It's DYMO's browser SDK for
talking to the DYMO Connect desktop software (which runs a local web service
the browser calls to list/print to a Dymo LabelWriter). It isn't published
to npm or a CDN, so it can't be loaded by URL the way `assets/fonts` or
Google Fonts are elsewhere in this repo.

The check-in page (`tools/checkin/index.html`) references it with a plain
`<script src="vendor/dymo.connect.framework.js">` tag. If the file is ever
removed or fails to load, that request just 404s quietly — the page still
loads and search still works, it just falls back to the "Print via browser
dialog" path instead of printing directly to a Dymo LabelWriter (see
`dymoAvailable()` in `index.html`).

**This file carries one local patch on top of the upstream fetch**, applied
2026-09-22: `_setQRCodeObjectText` now also updates `<TextDataHolder><Value>`,
not just `<Data><DataString>` — otherwise DYMO Connect can keep
displaying/encoding a `QRCodeObject`'s *original* designed-in value even
after `setObjectText` is called. This is a real upstream bug, already fixed
by the community (see
[DCD-SDK-Sample#12](https://github.com/dymosoftware/DCD-SDK-Sample/issues/12)),
just not yet merged into `dymosoftware/dymo-connect-framework` itself.

**If you ever update this file by re-fetching upstream, re-apply that patch
first** — check whether `_setQRCodeObjectText` already sets `TextDataHolder`
(search for that string); if the fetch changed and it's still missing, patch
it back in before committing, or the scan-reprint QR in
`tools/checkin/index.html` can silently start printing stale content again.

To update it later (a new DYMO Connect release, a bug fix upstream), re-fetch
the same URL, re-apply the patch above, and replace this file — it's a
static SDK file, not a secret, so it's fine to commit.
