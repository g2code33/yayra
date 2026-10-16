#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const expectedName = `yayra_${pkg.version}_amd64.deb`;
const expectedPath = path.join(releaseDir, expectedName);
const localElectronBuilder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const electronBuilder = existsSync(localElectronBuilder)
  ? { command: localElectronBuilder, args: [] }
  : { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['--yes', 'electron-builder'] };

await mkdir(releaseDir, { recursive: true });

// electron-builder's "files" config bundles dist/**/* into resources/app.asar.
// This script is invoked standalone (npm run package:linux:deb), from the
// release CI job (which restores a prebuilt dist/ artifact first), AND from
// tests/packaging-validation.test.mjs as part of `npm test` — which, per
// package.json/CI workflow ordering, runs BEFORE `npm run build:web`. Without
// this guard, a test-time build here would silently package an empty/stale
// dist directory, producing an app.asar missing dist/index.html that only
// scripts/verify-packaging.mjs's later asar inspection would ever catch.
const distIndexPath = path.join(root, 'dist', 'index.html');
if (!existsSync(distIndexPath)) {
  console.log('[Linux DEB Packager] dist/index.html missing; building the web bundle first...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const webBuild = spawnSync(npm, ['run', 'build:web'], { cwd: root, stdio: 'inherit', env: process.env });
  if (webBuild.status !== 0) process.exit(webBuild.status ?? 1);
}

console.log(`[Linux DEB Packager] Building the self-contained Electron Debian application for Yayra v${pkg.version}...`);

// electron-builder must DOWNLOAD the Electron runtime zip from the CDN on
// every fresh CI runner - the only network-dependent piece of `npm test`.
// That download has intermittently failed on GitHub runners (transient
// CDN/TLS errors, release run 38840844245), taking the whole pipeline down
// even though the build config was byte-identical to the previous green
// run. Retry with a short backoff before giving up; deterministic failures
// (e.g. an invalid build config) still fail, just after the extra attempts.
const maxAttempts = 3;
let result = null;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  if (attempt > 1) {
    const backoffMs = 10000 * (attempt - 1);
    console.warn(`[Linux DEB Packager] retrying electron-builder in ${backoffMs / 1000}s (attempt ${attempt}/${maxAttempts})...`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  result = spawnSync(electronBuilder.command, [...electronBuilder.args, '--linux', 'deb', '--publish', 'never'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    console.error(`[Linux DEB Packager] Could not start electron-builder: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status === 0) break;
  console.error(`[Linux DEB Packager] electron-builder failed with status ${result.status} (attempt ${attempt}/${maxAttempts}).`);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const debFiles = (await Promise.all((await readdir(releaseDir))
  .filter((name) => name.endsWith('.deb'))
  .map(async (name) => ({ name, info: await stat(path.join(releaseDir, name)) }))))
  .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
const built = debFiles[0];
if (!built) {
  console.error('[Linux DEB Packager] electron-builder did not produce a .deb file.');
  process.exit(1);
}

const builtPath = path.join(releaseDir, built.name);
if (built.name !== expectedName) await copyFile(builtPath, expectedPath);

const contents = spawnSync('dpkg-deb', ['--contents', expectedPath], { encoding: 'utf8' });
const hasElectronExecutable = /\/opt\/yayra\/yayra(?:\s|$)/.test(contents.stdout);
const hasBundledApp = contents.stdout.includes('/opt/yayra/resources/app.asar');
if (contents.status !== 0 || !hasElectronExecutable || !hasBundledApp) {
  console.error('[Linux DEB Packager] Refusing to publish a web-only package; the Debian archive must contain the Electron executable and resources/app.asar.');
  process.exit(1);
}

console.log(`[Linux DEB Packager] Successfully built self-contained ${path.join('release', expectedName)}`);
