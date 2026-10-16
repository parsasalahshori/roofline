// Fails the build when a page bundle would load without its own stylesheet. Rolldown once merged main.tsx's two
// dynamic imports (the app and the public quote page) into one preload call that carried only the quote page's
// files, so every app page rendered unstyled. This reads the built start-up file and checks that the app bundle
// (boot-*.js) and the quote bundle (entry-*.js) are each imported with a preload list that includes their own CSS.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'dist', 'assets');
const files = readdirSync(dir);
const index = files.find((f) => /^index-.*\.js$/.test(f));
if (!index) throw new Error('check-build-preload: no index-*.js in dist/assets');
const src = readFileSync(join(dir, index), 'utf8');

const table = /const __vite__mapDeps=.*?m\.f=\[(.*?)\]/s.exec(src);
const deps = table ? [...table[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

function check(prefix, cssPrefix) {
  const call = new RegExp('import\\(`\\./(' + prefix + '[^`]*\\.js)`\\)[^;]*?__vite__mapDeps\\(\\[([0-9,]*)\\]\\)').exec(src);
  if (!call) throw new Error(`check-build-preload: no preloaded import of ${prefix}*.js in ${index}`);
  const listed = call[2].split(',').filter(Boolean).map((i) => deps[Number(i)]);
  const css = files.filter((f) => f.startsWith(cssPrefix) && f.endsWith('.css'));
  for (const f of css) {
    if (!listed.includes(`assets/${f}`)) throw new Error(`check-build-preload: ${call[1]} is imported without its stylesheet ${f}`);
  }
  console.log(`check-build-preload: ${call[1]} preloads ${css.join(', ') || '(no own css)'}`);
}

check('boot-', 'boot-');
check('entry-', 'entry-');
