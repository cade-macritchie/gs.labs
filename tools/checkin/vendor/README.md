# vendor/

Put `dymo.connect.framework.js` here.

It's DYMO's own browser SDK for talking to the DYMO Connect desktop software
(which runs a local web service the browser calls to list/print to a Dymo
LabelWriter). It isn't published to a public CDN or npm, so it can't be
loaded by URL the way `assets/fonts` or Google Fonts are elsewhere in this
repo — download it from DYMO's official developer/SDK page for DYMO Connect
and place the file here as `dymo.connect.framework.js`.

The check-in page (`tools/checkin/index.html`) references it with a plain
`<script src="vendor/dymo.connect.framework.js">` tag. If the file isn't
present, that request just 404s quietly — the page still loads and search
still works, it just falls back to the "Print via browser dialog" path
instead of printing directly to a Dymo LabelWriter (see `dymoAvailable()` in
`index.html`).

This file is expected to be committed to the repo once you have it (it's a
static SDK file, not a secret), so the check-in page works the same way for
every device that opens it from GitHub Pages.
