// Bundles index.html into a single self-contained file suitable for publishing
// as a Claude Artifact, which can't load relative-path assets. The Tiempos Fine
// fonts and the GS logo are inlined as data URIs, and links back to the tools
// homepage are made absolute. Run with:
//   node training/intro-to-slate/build-artifact.js > training/intro-to-slate/artifact.html
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const repo = path.join(dir, '..', '..');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

const HOMEPAGE = 'https://cade-macritchie.github.io/gs.labs/';

function dataUri(rel, mime) {
  const buf = fs.readFileSync(path.join(repo, rel));
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const head = html.match(/<head>([\s\S]*)<\/head>/);
const body = html.match(/<body>([\s\S]*)<\/body>/);
if (!head || !body) throw new Error('index.html is missing <head> or <body>');

// The artifact skeleton supplies charset/viewport, so drop the page's own metas.
let out = head[1].replace(/<meta[^>]*>\s*/g, '').trim() + '\n\n' + body[1].trim() + '\n';

out = out.replace(/\.\.\/\.\.\/assets\/fonts\/(TiemposFine-[A-Za-z]+\.woff2)/g,
  (_, file) => dataUri(`assets/fonts/${file}`, 'font/woff2'));
out = out.replace(/\.\.\/\.\.\/assets\/brand-new\/([a-z-]+\.png)/g,
  (_, file) => dataUri(`assets/brand-new/${file}`, 'image/png'));
out = out.replace(/href="\.\.\/\.\.\/"/g, `href="${HOMEPAGE}"`);

if (/\.\.\/\.\.\//.test(out)) throw new Error('Unresolved relative path left in the bundle');

process.stdout.write(out);
