#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dimensions } from './lib/png.mjs';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build;
const failures = [];

assert(build.appId === 'com.yayra.app', 'appId must be explicit');
assert(build.productName === 'yayra', 'productName must be explicit');
assert(build.executableName === 'yayra', 'executableName must be yayra');
assert(build.win?.requestedExecutionLevel === 'asInvoker', 'Windows requestedExecutionLevel must be asInvoker');
assert(build.nsis?.oneClick === false, 'NSIS oneClick must be false');
assert(build.nsis?.allowToChangeInstallationDirectory === true, 'NSIS allowToChangeInstallationDirectory must be true');
assert(build.nsis?.shortcutName === 'yayra', 'NSIS shortcutName must be explicit');
assert(build.nsis?.uninstallDisplayName === 'yayra', 'NSIS uninstallDisplayName must be explicit');
for (const icon of ['build/icons/icon.ico', 'build/icons/installer.ico', 'build/icons/uninstaller.ico']) assert(existsSync(path.join(root, icon)), `${icon} missing`);

const desktop = parseDesktop(await readFile(path.join(root, 'build/linux/yayra.desktop'), 'utf8'));
assert(desktop.Name === 'yayra', '.desktop Name must equal executableName');
assert(desktop.StartupWMClass === 'yayra', '.desktop StartupWMClass must equal executableName');
assert(desktop.Icon === 'yayra', '.desktop Icon must be yayra');
const appImageDesktop = parseDesktop(await readFile(path.join(root, 'build/linux/yayra-appimage.desktop'), 'utf8'));
assert(appImageDesktop.StartupWMClass !== desktop.StartupWMClass, 'AppImage desktop file must not fight the deb StartupWMClass');
const icon48 = path.join(root, 'build/icons/hicolor/48x48/apps/yayra.png');
assert(existsSync(icon48), '48x48 hicolor icon missing');
if (existsSync(icon48)) {
  const dims = dimensions(await readFile(icon48));
  assert(dims.width === 48 && dims.height === 48, '48x48 hicolor icon dimensions do not resolve to 48x48');
}
for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
  assert(existsSync(path.join(root, `build/icons/hicolor/${size}x${size}/apps/yayra.png`)), `hicolor ${size} icon missing`);
}
const hook = 'build/linux/after-install.sh';
const hookText = await readFile(path.join(root, hook), 'utf8');
assert(!/\$\{[^}]+\}/.test(hookText), 'after-install hook contains unsupported ${...} macro');
assert(hookText.includes('chown root:root') && hookText.includes('chmod 4755'), 'after-install hook must set root:root and mode 4755 unconditionally when helper exists');
assert(hookText.includes('WARNING:'), 'after-install hook must print WARNING only on failure path');
const bashResult = spawnSync('bash', ['-n', hook], { cwd: root, encoding: 'utf8' });
assert(bashResult.status === 0, `bash -n failed for ${hook}: ${bashResult.stderr}`);

const nativeAndroid = await readFile(path.join(root, 'native/android/version.gradle'), 'utf8');
const nativeIos = await readFile(path.join(root, 'native/ios/Info.plist'), 'utf8');
const webManifest = JSON.parse(await readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
assert(nativeAndroid.includes(`appVersionName = "${pkg.version}"`), 'Android versionName does not match package.json');
assert(nativeIos.includes(`<string>${pkg.version}</string>`), 'iOS CFBundleShortVersionString does not match package.json');
assert(webManifest.version === pkg.version && webManifest.cacheVersion === pkg.version, 'web manifest version/cacheVersion mismatch package.json');
assert(JSON.parse(await readFile(path.join(root, 'electron/app-version.json'), 'utf8')).version === pkg.version, 'electron app-version mismatch package.json');

// PDF.js is loaded lazily at runtime, so ordinary static imports cannot save
// it from an over-aggressive packaging filter. Verify both the builder input
// and the custom protocol's strict .mjs MIME handling.
assert(build.files?.includes('dist/**/*'), 'Electron builder must include the complete dist tree (including lazy PDF.js modules)');
const electronMain = await readFile(path.join(root, 'electron/main.cjs'), 'utf8');
assert(electronMain.includes("lower.endsWith('.mjs')"), 'yayra:// MIME map must recognize .mjs');
assert(electronMain.includes("headers.set('content-type', type)"), 'yayra:// responses must set deterministic asset Content-Type headers');
const builtPdfAssets = [
  'dist/packages/shared-ui/src/vendor/pdfjs/pdf.mjs',
  'dist/packages/shared-ui/src/vendor/pdfjs/pdf.worker.mjs'
];
if (existsSync(path.join(root, 'dist'))) {
  for (const asset of builtPdfAssets) {
    const absolute = path.join(root, asset);
    assert(existsSync(absolute), `${asset} missing from built desktop input`);
    if (existsSync(absolute)) assert((await stat(absolute)).size > 100_000, `${asset} is unexpectedly truncated`);
  }
}

// Inspect every unpacked desktop target that is present. Runtime GUI smoke is
// useful diagnostics but can depend on the CI display/console environment;
// app.asar contents are deterministic and therefore remain the release gate.
const packagedAsars = [
  ['linux-unpacked', path.join(root, 'release/linux-unpacked/resources/app.asar')],
  ['win-unpacked', path.join(root, 'release/win-unpacked/resources/app.asar')],
  ['mac', path.join(root, 'release/mac/yayra.app/Contents/Resources/app.asar')]
].filter(([, asarPath]) => existsSync(asarPath));
if (packagedAsars.length) {
  for (const [target, asarPath] of packagedAsars) {
    const asar = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['asar', 'list', asarPath], { cwd: root, encoding: 'utf8' });
    assert(asar.status === 0, `${target} app.asar listing failed: ${asar.stderr || asar.stdout}`);
    assert(asar.stdout.includes('/dist/index.html'), `${target} app.asar did not include dist/index.html`);
    assert(asar.stdout.includes('/dist/packages/shared-ui/src/vendor/pdfjs/pdf.mjs'), `${target} app.asar did not include the PDF.js engine`);
    assert(asar.stdout.includes('/dist/packages/shared-ui/src/vendor/pdfjs/pdf.worker.mjs'), `${target} app.asar did not include the PDF.js worker`);
  }
} else {
  console.log('packaging layout note: no unpacked desktop app is present; package a desktop target to inspect its real app.asar contents');
}

const builtExe = await findBuiltExe(path.join(root, 'release'));
if (builtExe) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${builtExe.replaceAll("'", "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    assert(out.startsWith(pkg.version), `built exe ProductVersion ${out} does not match package.json ${pkg.version}`);
  } else {
    console.log(`windows version resource check deferred on non-Windows host for ${path.relative(root, builtExe)}; CI Windows runs scripts/assert-windows-version.mjs`);
  }
} else {
  console.log('windows version resource check deferred: no built .exe present in release/');
}

if (failures.length) {
  console.error('packaging verification failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('packaging verification passed: desktop config, PDF.js app.asar assets, hook syntax, icons, and version lockstep are valid');

function assert(condition, message) { if (!condition) failures.push(message); }
function parseDesktop(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^=#]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
async function findBuiltExe(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of await readdir(dir)) {
    const absolute = path.join(dir, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      const nested = await findBuiltExe(absolute);
      if (nested) return nested;
    } else if (/\.exe$/i.test(entry)) return absolute;
  }
  return null;
}
