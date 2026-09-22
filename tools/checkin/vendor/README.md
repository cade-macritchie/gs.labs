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

To update it later (a new DYMO Connect release, a bug fix upstream), re-fetch
the same URL and replace this file — it's a static SDK file, not a secret,
so it's fine to commit.
