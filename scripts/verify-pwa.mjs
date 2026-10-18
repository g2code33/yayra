#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
if (!existsSync(dist)) fail('dist/ missing; run npm run build:web first');
const precache = JSON.parse(await readFile(path.join(dist, 'precache-manifest.json'), 'utf8'));
const expected = (await listFiles(dist))
  .map((file) => `./${file}`)
  .filter((file) => file !== './sw.js' && file !== './precache-manifest.json')
  .sort();
if (JSON.stringify(precache) !== JSON.stringify(expected)) {
  fail(`precache mismatch\nexpected=${JSON.stringify(expected, null, 2)}\nactual=${JSON.stringify(precache, null, 2)}`);
}
// The integrated document reader is a lazy ESM graph. Pin its two entry
// modules explicitly so a copy/filter change cannot ship a shell whose PDF
// button always lands on the startup error screen (and so PWA use is truly
// offline after installation).
for (const asset of [
  './packages/shared-ui/src/vendor/pdfjs/pdf.mjs',
  './packages/shared-ui/src/vendor/pdfjs/pdf.worker.mjs'
]) {
  if (!precache.includes(asset)) fail(`PDF reader asset missing from build/precache: ${asset}`);
  const info = await stat(path.join(dist, asset.slice(2)));
  if (info.size < 100_000) fail(`PDF reader asset is unexpectedly small: ${asset} (${info.size} bytes)`);
}
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
for (const ref of refs) {
  if (/^(https?:|data:|blob:|#|mailto:)/.test(ref)) continue;
  const clean = ref.replace(/^\.\//, '').split(/[?#]/)[0];
  if (!existsSync(path.join(dist, clean))) fail(`index.html reference does not resolve: ${ref}`);
}
const sw = await readFile(path.join(dist, 'sw.js'), 'utf8');
if (!sw.includes('yayra-') || !sw.includes('PRECACHE')) fail('sw.js does not contain the generated precache/cache version');
if (!html.includes("cache: 'no-store'") && !(await readFile(path.join(dist, 'src/services/updateService.js'), 'utf8')).includes("cache: 'no-store'")) {
  fail('manifest fetch is not visibly configured with cache: no-store');
}
console.log(`pwa verification passed: ${precache.length} precache entries and ${refs.length} HTML references resolved`);

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const absolute = path.join(dir, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) out.push(...await listFiles(absolute, base));
    else out.push(path.relative(base, absolute).split(path.sep).join('/'));
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
