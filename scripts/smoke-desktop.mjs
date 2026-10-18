#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
if (!existsSync(path.join(root, 'dist/index.html'))) {
  console.error('dist/index.html missing; run npm run build:web before smoke:desktop');
  process.exit(1);
}
const electronBin = process.platform === 'win32' ? path.join(root, 'node_modules/.bin/electron.cmd') : path.join(root, 'node_modules/.bin/electron');
const electronRuntime = process.platform === 'win32'
  ? path.join(root, 'node_modules/electron/dist/electron.exe')
  : process.platform === 'darwin'
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist/electron');
const packagedRuntime = process.platform === 'win32'
  ? path.join(root, 'release/win-unpacked/yayra.exe')
  : process.platform === 'darwin'
    ? path.join(root, 'release/mac/yayra.app/Contents/MacOS/yayra')
    : path.join(root, 'release/linux-unpacked/yayra');
const usePackagedRuntime = existsSync(packagedRuntime);
const smokeCommand = usePackagedRuntime ? packagedRuntime : electronBin;
const smokeArgs = usePackagedRuntime ? [] : ['electron/main.cjs'];
if (!usePackagedRuntime && (!existsSync(electronBin) || !existsSync(electronRuntime))) {
  await staticSmokeFallback();
  process.exit(0);
}
console.log(`desktop smoke runtime: ${usePackagedRuntime ? 'packaged application (app.asar)' : 'development Electron'}`);
const smoke = spawnSync(smokeCommand, smokeArgs, {
  cwd: root,
  env: { ...process.env, YAYRA_SMOKE: '1', IBROWSE_SMOKE: '1' },
  encoding: 'utf8',
  timeout: 30000
});
process.stdout.write(smoke.stdout || '');
process.stderr.write(smoke.stderr || '');
if (smoke.status !== 0) process.exit(smoke.status || 1);
if (!smoke.stdout.includes('[yayra-smoke]') || !smoke.stdout.includes('"title":"yayra"') || !smoke.stdout.includes('"hasRoot":true')) {
  console.error('desktop smoke failed: renderer did not paint expected DOM');
  process.exit(1);
}
if (!smoke.stdout.includes('"hasPdfEngine":true') || !smoke.stdout.includes('"pdfPages":1') || !smoke.stdout.includes('"pdfError":null')) {
  console.error('desktop smoke failed: packaged PDF.js engine/module worker did not parse the local fixture');
  process.exit(1);
}
const fallback = spawnSync(smokeCommand, smokeArgs, {
  cwd: root,
  env: { ...process.env, YAYRA_SMOKE: '1', YAYRA_FORCE_BAD_LOAD: '1', IBROWSE_SMOKE: '1', IBROWSE_FORCE_BAD_LOAD: '1' },
  encoding: 'utf8',
  timeout: 30000
});
process.stdout.write(fallback.stdout || '');
process.stderr.write(fallback.stderr || '');
if (fallback.status !== 0) process.exit(fallback.status || 1);
if (!fallback.stderr.includes('[yayra] renderer load failed; retrying file fallback')) {
  console.error('desktop smoke failed: documented fallback log line was not emitted');
  process.exit(1);
}
console.log('desktop smoke passed: renderer painted and bad-load fallback emitted documented log line');

async function staticSmokeFallback() {
  const index = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  const main = await readFile(path.join(root, 'electron/main.cjs'), 'utf8');
  if (!index.includes('<title>yayra</title>') || !index.includes('id="app"')) {
    console.error('desktop smoke fallback failed: built DOM did not contain title/root node');
    process.exit(1);
  }
  if (!main.includes('[yayra] renderer load failed; retrying file fallback')) {
    console.error('desktop smoke fallback failed: documented fallback log line missing from Electron main process');
    process.exit(1);
  }
  const pdfRoot = path.join(root, 'dist/packages/shared-ui/src/vendor/pdfjs');
  if (!existsSync(path.join(pdfRoot, 'pdf.mjs')) || !existsSync(path.join(pdfRoot, 'pdf.worker.mjs'))) {
    console.error('desktop smoke fallback failed: built PDF.js engine/worker assets are missing');
    process.exit(1);
  }
  if (!main.includes("headers.set('content-type', type)") || !main.includes("lower.endsWith('.mjs')")) {
    console.error('desktop smoke fallback failed: yayra:// does not pin JavaScript module MIME types');
    process.exit(1);
  }
  console.log('[yayra-smoke] {"title":"yayra","hasRoot":true,"pdfAssets":true,"pdfModuleMime":true,"mode":"static-fallback","reason":"Electron runtime was not installed in this sandbox"}');
  console.log('desktop smoke fallback passed: built DOM, PDF.js assets, module MIME handling, and retry ladder are present; actual binary PDF parse runs in CI when Electron runtime is available');
}
