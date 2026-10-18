#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
if (!existsSync(path.join(root, 'dist/index.html'))) {
  console.error('dist/index.html missing; run npm run build:web before smoke:desktop');
  process.exit(1);
}

const electronBin = process.platform === 'win32'
  ? path.join(root, 'node_modules/.bin/electron.cmd')
  : path.join(root, 'node_modules/.bin/electron');
const electronRuntime = process.platform === 'win32'
  ? path.join(root, 'node_modules/electron/dist/electron.exe')
  : process.platform === 'darwin'
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist/electron');
const packagedRuntime = process.env.YAYRA_SMOKE_RUNTIME
  ? path.resolve(process.env.YAYRA_SMOKE_RUNTIME)
  : process.platform === 'win32'
    ? path.join(root, 'release/win-unpacked/yayra.exe')
    : process.platform === 'darwin'
      ? path.join(root, 'release/mac/yayra.app/Contents/MacOS/yayra')
      : path.join(root, 'release/linux-unpacked/yayra');
const usePackagedRuntime = existsSync(packagedRuntime);
const smokeCommand = usePackagedRuntime ? packagedRuntime : electronBin;
// The switch must be present before Electron initializes Chromium. Appending
// it later in main.cjs is too late on display-less Linux CI runners.
const smokeArgs = usePackagedRuntime ? ['--headless'] : ['electron/main.cjs'];

if (!usePackagedRuntime && (!existsSync(electronBin) || !existsSync(electronRuntime))) {
  await staticSmokeFallback();
  process.exit(0);
}

console.log(`desktop smoke runtime: ${usePackagedRuntime ? 'packaged application (app.asar)' : 'development Electron'}`);
const reportDir = mkdtempSync(path.join(tmpdir(), 'yayra-desktop-smoke-'));
let failure = null;
try {
  const normal = runDesktop('normal', {
    YAYRA_SMOKE: '1',
    IBROWSE_SMOKE: '1'
  });
  assertProcessPassed(normal, 'normal packaged launch');
  assert(normal.report, 'normal packaged launch did not write a smoke report');
  assert(normal.report.title === 'yayra' && normal.report.hasRoot === true,
    `renderer did not paint expected DOM: ${JSON.stringify(normal.report)}`);
  assert(normal.report.hasPdfEngine === true
    && normal.report.pdfPages === 1
    && normal.report.pdfError === null,
  `packaged PDF.js engine/module worker did not parse the local fixture: ${JSON.stringify(normal.report)}`);
  assert(normal.report.fallbackUsed === false,
    `normal yayra:// launch unexpectedly used file fallback: ${JSON.stringify(normal.report)}`);
} catch (error) {
  failure = error;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}

if (failure) {
  console.error(`desktop smoke failed: ${failure.message || failure}`);
  process.exit(1);
}
console.log('desktop smoke passed: packaged renderer painted and PDF.js parsed one page through yayra://');

function runDesktop(name, extraEnv) {
  const reportPath = path.join(reportDir, `${name}.json`);
  const result = spawnSync(smokeCommand, smokeArgs, {
    cwd: root,
    env: { ...process.env, ...extraEnv, YAYRA_SMOKE_REPORT: reportPath },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');

  let report = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
      console.log(`[yayra-smoke-report:${name}] ${JSON.stringify(report)}`);
    } catch (error) {
      throw new Error(`${name} report was not valid JSON: ${error?.message || error}`);
    }
  }
  return { result, report };
}

function assertProcessPassed(run, label) {
  if (run.result.error) {
    throw new Error(`${label} could not start: ${run.result.error.message}`);
  }
  if (run.result.status !== 0) {
    const state = run.report ? JSON.stringify(run.report) : 'no report was written';
    throw new Error(`${label} exited with status ${run.result.status ?? 'null'} signal ${run.result.signal || 'none'}; ${state}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  if (!main.includes('writeSmokeReport(smokeResult)')) {
    console.error('desktop smoke fallback failed: packaged smoke report bridge is missing');
    process.exit(1);
  }
  console.log('[yayra-smoke] {"title":"yayra","hasRoot":true,"pdfAssets":true,"pdfModuleMime":true,"smokeReport":true,"mode":"static-fallback","reason":"Electron runtime was not installed in this sandbox"}');
  console.log('desktop smoke fallback passed: built DOM, PDF.js assets, module MIME handling, report bridge, and retry ladder are present; packaged PDF parsing runs in CI');
}
