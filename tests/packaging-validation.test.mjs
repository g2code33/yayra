import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('Android Packaging: Manifest declares stable applicationId, permissions and floating services', async () => {
  const manifestPath = path.join(root, 'packages/platform-packaging/android/AndroidManifest.xml');
  assert.equal(existsSync(manifestPath), true, 'AndroidManifest.xml must exist');

  const xml = await readFile(manifestPath, 'utf8');
  assert.match(xml, /package="com\.yayra\.app"/);
  assert.match(xml, /android:name="android\.permission\.INTERNET"/);
  assert.match(xml, /android:name="android\.permission\.ACCESS_NETWORK_STATE"/);
  assert.match(xml, /android:name="android\.permission\.SYSTEM_ALERT_WINDOW"/);
  assert.match(xml, /android:name="android\.permission\.POST_NOTIFICATIONS"/);
  assert.match(xml, /android:name="android\.permission\.RECORD_AUDIO"/);
  assert.match(xml, /android:name="android\.permission\.FOREGROUND_SERVICE"/);
  assert.match(xml, /android:name="android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE"/);

  // Floating service declarations
  assert.match(xml, /com\.yayra\.floating\.android\.YayraFloatBubbleService/);
  assert.match(xml, /com\.yayra\.floating\.android\.YayraFloatWindowService/);
  assert.match(xml, /android:foregroundServiceType="specialUse"/);

  // Intent filter schemes
  assert.match(xml, /android:scheme="https"/);
  assert.match(xml, /android:scheme="yayra"/);
});

test('Android Packaging: Gradle build defines target/min SDKs and secure release signing without hardcoded keys', async () => {
  const gradlePath = path.join(root, 'packages/platform-packaging/android/build.gradle');
  assert.equal(existsSync(gradlePath), true, 'build.gradle must exist');

  const gradle = await readFile(gradlePath, 'utf8');
  assert.match(gradle, /namespace "com\.yayra\.app"/);
  assert.match(gradle, /applicationId "com\.yayra\.app"/);
  assert.match(gradle, /minSdkVersion 24/);
  assert.match(gradle, /targetSdkVersion 34/);
  assert.match(gradle, /compileSdkVersion 34/);

  // Ensure signing reads from environment variables, not hardcoded strings
  assert.match(gradle, /System\.getenv\("ANDROID_KEYSTORE_PATH"\)/);
  assert.match(gradle, /System\.getenv\("ANDROID_KEYSTORE_PASSWORD"\)/);
  assert.match(gradle, /System\.getenv\("ANDROID_KEY_ALIAS"\)/);
  assert.match(gradle, /System\.getenv\("ANDROID_KEY_PASSWORD"\)/);

  // No hardcoded passwords or keystores in source
  assert.equal(/storePassword\s+["'][^"']+["']/.test(gradle), false);
  assert.equal(/keyPassword\s+["'][^"']+["']/.test(gradle), false);
});

test('Windows Packaging: NSIS 64-bit installer enforces 64-bit, WebView2 detection, shortcuts, and data preservation', async () => {
  const nsiPath = path.join(root, 'packages/platform-packaging/windows/installer.nsi');
  assert.equal(existsSync(nsiPath), true, 'installer.nsi must exist');

  const nsi = await readFile(nsiPath, 'utf8');
  assert.match(nsi, /Name "Yayra"/);
  assert.match(nsi, /SetRegView 64/);
  assert.match(nsi, /\$\{RunningX64\}/);

  // Microsoft Edge WebView2 runtime detection GUID
  assert.match(nsi, /\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5\}/);
  assert.match(nsi, /CheckWebView2Runtime/);

  // Shortcuts & registry
  assert.match(nsi, /\$SMPROGRAMS\\Yayra\\Yayra\.lnk/);
  assert.match(nsi, /\$DESKTOP\\Yayra\.lnk/);
  assert.match(nsi, /Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Yayra/);

  // Uninstaller cleans binary folder without deleting %APPDATA%\yayra user data
  assert.match(nsi, /RMDir \/r "\$INSTDIR"/);
  assert.equal(nsi.includes('RMDir /r "$APPDATA\\yayra"'), false, 'Uninstaller must not delete user browsing data directory by default');
});

test('Windows Packaging: WiX 64-bit MSI definition includes 64-bit platform, UpgradeCode, and WebView2 search', async () => {
  const wxsPath = path.join(root, 'packages/platform-packaging/windows/yayra.wxs');
  assert.equal(existsSync(wxsPath), true, 'yayra.wxs must exist');

  const wxs = await readFile(wxsPath, 'utf8');
  assert.match(wxs, /Platform="x64"/);
  assert.match(wxs, /UpgradeCode="e87d894e-5264-4bf8-b809-58b2db51341e"/);
  assert.match(wxs, /MajorUpgrade/);
  assert.match(wxs, /\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5\}/);
  assert.match(wxs, /Shortcut Id="ApplicationStartMenuShortcut"/);
  assert.match(wxs, /Shortcut Id="ApplicationDesktopShortcut"/);
});

test('Linux Packaging: Debian package control file defines dependencies, arch amd64, and version lockstep', async () => {
  const controlPath = path.join(root, 'packages/platform-packaging/linux/control');
  assert.equal(existsSync(controlPath), true, 'control file must exist');

  const control = await readFile(controlPath, 'utf8');
  assert.match(control, /Package: yayra/);
  assert.match(control, /Architecture: amd64/);
  assert.match(control, /Depends:.*libc6/);
  assert.match(control, /Depends:.*libgtk/);
  assert.match(control, /Depends:.*libwebkit/);

  // Check postinst, prerm, postrm
  const postinst = await readFile(path.join(root, 'packages/platform-packaging/linux/postinst'), 'utf8');
  assert.match(postinst, /update-desktop-database/);
  assert.match(postinst, /gtk-update-icon-cache/);

  const prerm = await readFile(path.join(root, 'packages/platform-packaging/linux/prerm'), 'utf8');
  assert.match(prerm, /killall yayra/);

  const postrm = await readFile(path.join(root, 'packages/platform-packaging/linux/postrm'), 'utf8');
  assert.match(postrm, /update-desktop-database/);
  assert.match(postrm, /gtk-update-icon-cache/);
});

test('Linux Packaging: Builds valid 64-bit .deb archive with complete filesystem layout and icons', async () => {
  // Execute Debian packaging script
  const buildResult = spawnSync('node', ['scripts/package-linux-deb.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(buildResult.status, 0, `Debian packaging script failed: ${buildResult.stderr}`);

  const debPath = path.join(root, `release/yayra_${pkg.version}_amd64.deb`);
  assert.equal(existsSync(debPath), true, 'Debian .deb package file must be produced in release/');

  // Inspect contents using dpkg-deb
  const contents = spawnSync('dpkg-deb', ['--contents', debPath], { encoding: 'utf8' });
  assert.equal(contents.status, 0);

  const stdout = contents.stdout;
  assert.match(stdout, /\.\/usr\/bin\/yayra/);
  assert.match(stdout, /\.\/usr\/share\/applications\/yayra\.desktop/);
  assert.match(stdout, /\.\/opt\/yayra\/yayra(?:\s|$)/, 'Debian package must contain the Electron executable');
  assert.match(stdout, /\.\/opt\/yayra\/resources\/app\.asar/, 'Debian package must contain the Electron app, not only a web bundle');

  // Verify all 9 icon resolutions are present in the package
  for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
    assert.match(stdout, new RegExp(`\\./usr/share/icons/hicolor/${size}x${size}/apps/yayra\\.png`));
  }

  // Inspect control info
  const info = spawnSync('dpkg-deb', ['--info', debPath], { encoding: 'utf8' });
  assert.equal(info.status, 0);
  assert.match(info.stdout, /Package: yayra/);
  assert.match(info.stdout, new RegExp(`Version: ${pkg.version}`));
  assert.match(info.stdout, /Architecture: amd64/);
});

test('Packaging Scripts: Linux packaging is native Electron-only and never delegates to an external browser', async () => {
  const linuxPackager = await readFile(path.join(root, 'scripts/package-linux-deb.mjs'), 'utf8');
  const legacyLinuxEntry = await readFile(path.join(root, 'packages/platform-packaging/scripts/build-deb.sh'), 'utf8');
  const externalBrowserOpener = ['xdg', 'open'].join('-');
  assert.doesNotMatch(linuxPackager, new RegExp(externalBrowserOpener));
  assert.doesNotMatch(legacyLinuxEntry, new RegExp(externalBrowserOpener));
  assert.ok(linuxPackager.includes('hasElectronExecutable'));
  assert.ok(linuxPackager.includes('/opt/yayra/resources/app.asar'));
});

test('Packaging Scripts: Automated packagers for Android, Windows, and Linux execute cleanly', async () => {
  // Test Android packaging runner
  const androidRun = spawnSync('node', ['scripts/package-android.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(androidRun.status, 0);
  assert.match(androidRun.stdout, /com\.yayra\.app/);

  // Test Windows packaging runner
  const windowsRun = spawnSync('node', ['scripts/package-windows.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(windowsRun.status, 0);
  assert.match(windowsRun.stdout, /Preparing 64-bit Windows packaging/);
});
