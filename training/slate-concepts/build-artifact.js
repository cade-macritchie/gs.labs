// Bundles index.html, styles.css, and app.js into a single self-contained
// file suitable for publishing as a Claude Artifact (which serves one HTML
// file with no external relative-path assets). Run with:
//   node slate-concepts/build-artifact.js > slate-concepts/artifact.html
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

const HOMEPAGE = 'https://cade-macritchie.github.io/gs.labs/';

const fontLinks = [...html.matchAll(/<link rel="preconnect"[^>]*>|<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g)].map(m => m[0]);

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('No <body> found in index.html');
let body = bodyMatch[1];

body = body.replace('<script src="app.js"></script>', '');
body = body.replace(/href="\.\.\/"/g, `href="${HOMEPAGE}"`);
body = body.trim();

const output = `<title>Slate Concepts</title>
${fontLinks.join('\n')}
<style>
${css}
</style>

${body}

<script>
${js}
</script>
`;

process.stdout.write(output);
