import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { parseAppModeUrl, sanitizeAppName, buildInstallPlan, appWindowClass } = require('../electron/appMode.cjs');

test('parseAppModeUrl extracts a valid https --app url', () => {
  assert.equal(
    parseAppModeUrl(['/usr/bin/yayra', '--app=https://music.youtube.com/']),
    'https://music.youtube.com/'
  );
});

test('parseAppModeUrl strips surrounding quotes (desktop Exec lines quote the url)', () => {
  assert.equal(
    parseAppModeUrl(['yayra', '--app="https://example.com/dash?x=1"']),
    'https://example.com/dash?x=1'
  );
});

test('parseAppModeUrl rejects unsafe schemes and missing flag', () => {
  assert.equal(parseAppModeUrl(['yayra', '--app=javascript:alert(1)']), null);
  assert.equal(parseAppModeUrl(['yayra', '--app=file:///etc/passwd']), null);
  assert.equal(parseAppModeUrl(['yayra', '--app=chrome://settings']), null);
  assert.equal(parseAppModeUrl(['yayra', 'https://example.com']), null);
  assert.equal(parseAppModeUrl([]), null);
  assert.equal(parseAppModeUrl(undefined), null);
});

test('sanitizeAppName cleans filesystem-hostile characters and falls back to host', () => {
  assert.equal(sanitizeAppName('My: App/Name?', 'https://example.com'), 'My App Name');
  assert.equal(sanitizeAppName('', 'https://music.youtube.com/'), 'music.youtube.com');
});

test('buildInstallPlan linux: desktop + applications-menu .desktop entries launching yayra --app', () => {
  const plan = buildInstallPlan({
    platform: 'linux',
    execPath: '/opt/Yayra/yayra',
    url: 'https://music.youtube.com/',
    title: 'YouTube Music',
    desktopDir: '/home/me/Desktop',
    applicationsDir: '/home/me/.local/share/applications',
    iconPath: '/home/me/.config/yayra/pwa-icons/site.png'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.name, 'YouTube Music');
  assert.equal(plan.inLauncher, true);
  assert.equal(plan.artifacts.length, 2);
  const [desktop, launcher] = plan.artifacts;
  assert.equal(desktop.path, '/home/me/Desktop/YouTube Music.desktop');
  assert.equal(launcher.path, '/home/me/.local/share/applications/yayra-app-youtube-music.desktop');
  for (const artifact of plan.artifacts) {
    assert.equal(artifact.kind, 'file');
    assert.equal(artifact.executable, true);
    assert.match(artifact.contents, /^\[Desktop Entry\]\n/);
    assert.ok(artifact.contents.includes('Exec="/opt/Yayra/yayra" --app="https://music.youtube.com/"'));
    assert.ok(artifact.contents.includes('Name=YouTube Music'));
    assert.ok(artifact.contents.includes('Icon=/home/me/.config/yayra/pwa-icons/site.png'));
    assert.ok(artifact.contents.includes('Terminal=false'));
  }
});

test('buildInstallPlan linux fails closed instead of inheriting the Yayra icon', () => {
  const plan = buildInstallPlan({
    platform: 'linux',
    execPath: '/opt/Yayra/yayra',
    url: 'https://example.com/',
    title: 'Example',
    desktopDir: '/home/me/Desktop'
  });
  assert.deepEqual(plan, { ok: false, reason: 'site-icon-unavailable' });
});

test('buildInstallPlan win32: desktop + Start Menu shortcuts with --app args', () => {
  const plan = buildInstallPlan({
    platform: 'win32',
    execPath: 'C:\\Yayra\\yayra.exe',
    url: 'https://example.com/app',
    title: 'Example App',
    desktopDir: 'C:\\Users\\me\\Desktop',
    startMenuDir: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    iconPath: 'C:\\Users\\me\\AppData\\Roaming\\yayra\\pwa-icons\\site.ico'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.inLauncher, true);
  assert.equal(plan.artifacts.length, 2);
  const [desktop, startMenu] = plan.artifacts;
  assert.equal(desktop.kind, 'shortcut');
  assert.equal(desktop.path, 'C:\\Users\\me\\Desktop\\Example App.lnk');
  assert.ok(startMenu.path.endsWith('\\Programs\\Example App.lnk'));
  for (const artifact of plan.artifacts) {
    assert.equal(artifact.options.target, 'C:\\Yayra\\yayra.exe');
    assert.equal(artifact.options.args, '--app="https://example.com/app"');
    assert.equal(artifact.options.icon, 'C:\\Users\\me\\AppData\\Roaming\\yayra\\pwa-icons\\site.ico');
  }
});

test('buildInstallPlan darwin: honest unsupported-platform', () => {
  const plan = buildInstallPlan({
    platform: 'darwin',
    execPath: '/Applications/Yayra.app/Contents/MacOS/Yayra',
    url: 'https://example.com/',
    title: 'Example',
    desktopDir: '/Users/me/Desktop'
  });
  assert.deepEqual(plan, { ok: false, reason: 'unsupported-platform' });
});

test('buildInstallPlan rejects invalid or non-http urls and missing paths', () => {
  assert.deepEqual(
    buildInstallPlan({ platform: 'linux', execPath: '/x', url: 'yayra://newtab', desktopDir: '/d' }),
    { ok: false, reason: 'invalid-url' }
  );
  assert.deepEqual(
    buildInstallPlan({ platform: 'linux', execPath: '/x', url: 'not a url', desktopDir: '/d' }),
    { ok: false, reason: 'invalid-url' }
  );
  assert.deepEqual(
    buildInstallPlan({ platform: 'linux', execPath: '', url: 'https://example.com', desktopDir: '/d' }),
    { ok: false, reason: 'missing-paths' }
  );
});


/* ------- P67: the two REAL install-as-app defects (field report) ------- */

test('install handler (source pin): AppImage shortcuts target the .AppImage FILE, not the vanishing temp mount', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf("ipcMain.handle('yayra:install-page-as-app'");
  const block = src.slice(start, start + 1600);
  assert.ok(start > -1, 'handler exists');
  assert.match(block, /process\.env\.APPIMAGE/, 'the .AppImage file path is preferred when running from one');
  // ...and the dead PNG icon candidate (never shipped in the package,
  // and .png is not a valid .lnk icon anyway) is gone for good.
  assert.ok(!block.includes('iconCandidate'), 'no unshipped PNG icon candidate');
});

test('install handler (source pin): the TRUE site-app flow requires the SITE OWN name/icon/start url', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf("ipcMain.handle('yayra:install-page-as-app'");
  const block = src.slice(start, start + 4000);
  assert.ok(start > -1, 'handler exists');
  assert.match(block, /async \(_event/, 'the handler is async (manifest fetches)');
  assert.match(block, /resolvePwaInstallIdentity\(url, title, favicon\)/, 'the site identity includes the live page favicon');
  assert.match(block, /if \(!identity\.iconFile\) return \{ ok: false, reason: 'site-icon-unavailable' \};/,
    'a missing site logo aborts instead of inheriting Yayra branding');
  assert.match(block, /const iconPath = identity\.iconFile;/, 'the SITE OWN icon file is the only icon');
  assert.doesNotMatch(block, /\? 'yayra'|yayra_bubble_logo/, 'no Yayra fallback remains');
  assert.match(block, /url: identity\.startUrl/, 'the manifest start url is installed');
  assert.match(block, /title: installName/, 'the site own (or user-edited) name is installed');
  assert.match(block, /pwa: identity\.pwa/, 'the renderer learns whether it was a true PWA install');
});

test('buildInstallPlan linux requires an explicit verified site icon', () => {
  const rejected = buildInstallPlan({
    platform: 'linux',
    execPath: '/home/me/Applications/yayra.AppImage',
    url: 'https://music.youtube.com/',
    title: 'YouTube Music',
    desktopDir: '/home/me/Desktop'
  });
  assert.deepEqual(rejected, { ok: false, reason: 'site-icon-unavailable' });

  const accepted = buildInstallPlan({
    platform: 'linux',
    execPath: '/home/me/Applications/yayra.AppImage',
    url: 'https://music.youtube.com/',
    title: 'YouTube Music',
    desktopDir: '/home/me/Desktop',
    iconPath: '/home/me/.config/yayra/pwa-icons/site.png'
  });
  assert.equal(accepted.ok, true);
  assert.match(accepted.artifacts[0].contents, /Icon=\/home\/me\/\.config\/yayra\/pwa-icons\/site\.png/);
});


/* ------------------------------------------------------------------ */
/* Desktop install-as-app fixes (Ubuntu/Linux + Windows)               */
/* ------------------------------------------------------------------ */

test('appWindowClass: stable per site URL, normalized, distinct per site', () => {
  const a = appWindowClass('https://music.youtube.com/');
  assert.equal(a, appWindowClass('https://music.youtube.com'), 'URL normalization cannot split one site into two classes');
  assert.match(a, /^yayra-app-[0-9a-f]{16}$/, 'safe, deterministic class name');
  assert.notEqual(a, appWindowClass('https://x.com/'), 'different sites get different classes');
  assert.equal(appWindowClass('not a url'), 'yayra-app', 'degrades safely');
});

test('buildInstallPlan linux: StartupWMClass matches the class the real window will have', () => {
  const url = 'https://music.youtube.com/';
  const plan = buildInstallPlan({
    platform: 'linux',
    execPath: '/opt/yayra/yayra',
    url,
    title: 'YouTube Music',
    desktopDir: '/home/me/Desktop',
    applicationsDir: '/home/me/.local/share/applications',
    iconPath: '/home/me/.config/yayra/pwa-icons/site.png'
  });
  const expected = `StartupWMClass=${appWindowClass(url)}`;
  for (const artifact of plan.artifacts) {
    assert.ok(artifact.contents.includes(expected), `${artifact.path} declares the real window class`);
  }
});

test('main.cjs (source pin): the Wayland self-heal handover CARRIES the --app url of the clicked shortcut', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf("app.on('second-instance'");
  const block = src.slice(start, start + 3000);
  assert.ok(start > -1, 'second-instance handler exists');
  assert.match(block, /const appUrl = parseAppModeUrl\(argv \|\| \[\]\);/, 'the app url is parsed FIRST, before any handover');
  assert.match(block, /--ozone-platform=x11\$\{appArg\}/, 'the handover command includes the --app url');
  assert.match(block, /const appArg = appUrl \? ` --app="\$\{appUrl\}"` : '';/, 'built from the parsed url, never dropped');
});

test('main.cjs (source pin): launching the same installed app again FOCUSES its window instead of stacking duplicates', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf('const appModeWindows = new Map()');
  // The media-compatibility setup deliberately lives inside this constructor,
  // so keep the source window wide enough to include the close cleanup too.
  const block = src.slice(start, start + 2800);
  assert.ok(start > -1, 'app windows are tracked');
  assert.match(block, /const existing = appModeWindows\.get\(normalized\);/, 'looked up by normalized url');
  assert.match(block, /existing\.isMinimized\(\)\) existing\.restore\(\)/, 'restored when minimized');
  assert.match(block, /existing\.show\(\);/, 'shown');
  assert.match(block, /existing\.focus\(\);/, 'focused');
  assert.match(block, /win\.on\('closed', \(\) => \{ appModeWindows\.delete\(normalized\); \}\);/, 'tracked windows are released on close');
});

test('main.cjs (source pin): cold app-mode launches set the real X11 window class (and the Windows AUMID)', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf('const appModeLaunchUrl = parseAppModeUrl(process.argv);');
  const block = src.slice(start, start + 900);
  assert.ok(start > -1);
  assert.match(block, /appendSwitch\('class', appWindowClass\(appModeLaunchUrl\)\)/, 'the --class switch matches the .desktop StartupWMClass');
  assert.match(block, /app\.setAppUserModelId\(appWindowClass\(appModeLaunchUrl\)\)/, 'Windows taskbar grouping key set');
});

test('main.cjs (source pin): written .desktop launchers are marked TRUSTED for GNOME (gio metadata::trusted)', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = src.indexOf("ipcMain.handle('yayra:install-page-as-app'");
  const block = src.slice(start, start + 4500);
  assert.ok(start > -1);
  assert.match(block, /'metadata::trusted', 'true'/, 'gvfs trust metadata is set');
  assert.match(block, /spawn\('gio', \['set', artifact\.path/, 'via the gio binary, best-effort');
});
