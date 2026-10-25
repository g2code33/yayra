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
  .filter((file) => file !== './sw.js' && file !== './precache-manifest.json' && !file.endsWith('.yayrapack'))
  .sort();
if (JSON.stringify(precache) !== JSON.stringify(expected)) {
  fail(`precache mismatch\nexpected=${JSON.stringify(expected, null, 2)}\nactual=${JSON.stringify(precache, null, 2)}`);
}
for (const [dictionaryPack, licenseFile] of [
  ['./dictionary-packs/wordnet-3.0-v1.yayrapack', './dictionary-packs/WORDNET-LICENSE-3.0.txt'],
  ['./dictionary-packs/oewn-2025-v1.yayrapack', './dictionary-packs/OPEN-ENGLISH-WORDNET-LICENSE-2025.md']
]) {
  if (!existsSync(path.join(dist, dictionaryPack.slice(2)))) fail(`bundled dictionary download asset is missing: ${dictionaryPack}`);
  if (precache.includes(dictionaryPack)) fail(`large dictionary pack must be downloaded only on explicit user request, not precached: ${dictionaryPack}`);
  if (!precache.includes(licenseFile)) fail(`dictionary license notices must remain available to the PWA: ${licenseFile}`);
}
// The integrated document readers are a lazy ESM graph. Pin every offline
// engine explicitly so a copy/filter change cannot ship a shell whose Open
// document action lands on a startup error only after installation.
const documentAssets = [
  ['./packages/shared-ui/src/vendor/pdfjs/pdf.mjs', 100_000],
  ['./packages/shared-ui/src/vendor/pdfjs/pdf.worker.mjs', 100_000],
  ['./packages/shared-ui/src/vendor/documents/pptxRenderer.mjs', 150_000],
  ['./packages/shared-ui/src/vendor/documents/docxPreview.mjs', 200_000],
  ['./packages/shared-ui/src/vendor/documents/xlsx.mjs', 700_000],
  ['./packages/shared-ui/src/vendor/documents/legacyOffice.mjs', 700_000],
  ['./packages/shared-ui/src/vendor/documents/LEGACY-OFFICE-NOTICES.md', 5_000],
  ['./packages/shared-ui/src/services/legacyOfficeWorker.js', 500],
  ['./packages/shared-ui/src/vendor/documents/manifest.json', 100]
];
for (const [asset, minimumBytes] of documentAssets) {
  if (!precache.includes(asset)) fail(`document reader asset missing from build/precache: ${asset}`);
  const info = await stat(path.join(dist, asset.slice(2)));
  if (info.size < minimumBytes) fail(`document reader asset is unexpectedly small: ${asset} (${info.size} bytes)`);
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
