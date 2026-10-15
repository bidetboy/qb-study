// Stamps a content-hash version (?v=...) onto every script/stylesheet URL in docs/, so browsers
// never mix freshly deployed files with stale cached ones (GitHub Pages caches for 10 minutes).
// Run before committing a change to docs/:  npm run stamp
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCS = path.join(__dirname, '..', 'docs');
const JS = path.join(DOCS, 'js');
const INDEX = path.join(DOCS, 'index.html');
const STRIP = /\?v=[0-9a-f]+/g;

const jsFiles = fs.readdirSync(JS).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(JS, f));
const files = [INDEX, path.join(DOCS, 'styles.css'), ...jsFiles];

const hash = crypto.createHash('sha1');
for (const f of files) hash.update(fs.readFileSync(f, 'utf8').replace(STRIP, ''));
const v = hash.digest('hex').slice(0, 8);

let changed = 0;
const write = (f, text) => {
  if (fs.readFileSync(f, 'utf8') !== text) { fs.writeFileSync(f, text); changed++; }
};

for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  write(f, src.replace(/(['"])(\.\/[\w-]+\.js)(?:\?v=[0-9a-f]+)?\1/g, `$1$2?v=${v}$1`));
}
write(INDEX, fs.readFileSync(INDEX, 'utf8')
  .replace(/(src="js\/app\.js)(?:\?v=[0-9a-f]+)?"/, `$1?v=${v}"`)
  .replace(/(href="styles\.css)(?:\?v=[0-9a-f]+)?"/, `$1?v=${v}"`));

console.log(`version ${v} (${changed} file${changed === 1 ? '' : 's'} updated)`);
