import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isPngBuffer,
  isIcoBuffer,
  extractPngFromIco,
  generateSiteIdentityPng,
  extractManifestLink,
  extractIconLink,
  parseManifest,
  pickManifestIcon,
  resolveStartUrl,
  pickInstallIdentity,
  siteIconCandidates,
  pngToIco
} = require('../electron/pwaManifest.cjs');

/**
 * THE REQUIREMENT: "the install as an app must install a PWA OF THAT
 * SITE the user is on to the desktop of the user's PC" - the site's OWN
 * name, OWN icon and OWN start url on the desktop, exactly like Chrome's
 * install. This suite pins the pure identity pipeline
 * (electron/pwaManifest.cjs) and its wiring in electron/main.cjs.
 */

const PAGE = 'https://app.example.com/dashboard';
const MANIFEST_URL = 'https://app.example.com/manifest.webmanifest';

test('extractManifestLink: finds the manifest link in every real-world form', () => {
  assert.equal(
    extractManifestLink('<link rel="manifest" href="/manifest.webmanifest">', PAGE),
    'https://app.example.com/manifest.webmanifest'
  );
  assert.equal(
    extractManifestLink("<link rel='manifest' href='https://cdn.example.com/m.json'>", PAGE),
    'https://cdn.example.com/m.json'
  );
  // attribute order reversed + extra attributes
  assert.equal(
    extractManifestLink('<link href="/m.json" rel="manifest" crossorigin="use-credentials">', PAGE),
    'https://app.example.com/m.json'
  );
  // other links must not confuse it
  assert.equal(
    extractManifestLink('<link rel="icon" href="/favicon.ico"><link rel="manifest" href="/m.json">', PAGE),
    'https://app.example.com/m.json'
  );
  assert.equal(extractManifestLink('<link rel="icon" href="/favicon.ico">', PAGE), null, 'no manifest -> null');
  assert.equal(extractManifestLink('<link rel="manifest" href="javascript:alert(1)">', PAGE), null, 'non-http schemes rejected');
  assert.equal(extractManifestLink('', PAGE), null);
});

test('parseManifest: safe parse - garbage and non-objects are null', () => {
  assert.deepEqual(parseManifest('{"name":"X","icons":[]}'), { name: 'X', icons: [] });
  assert.equal(parseManifest('not json {'), null);
  assert.equal(parseManifest('[1,2,3]'), null);
  assert.equal(parseManifest('null'), null);
});

test('pickManifestIcon: chooses the LARGEST usable raster icon and resolves it absolutely', () => {
  const manifest = {
    icons: [
      { src: 'icons/tiny.png', sizes: '48x48', type: 'image/png' },
      { src: '/icons/big.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/vector.svg', sizes: 'any', type: 'image/svg+xml' } // skipped: not rasterizable
    ]
  };
  const icon = pickManifestIcon(manifest, MANIFEST_URL);
  assert.ok(icon, 'an icon is chosen');
  assert.equal(icon.src, 'https://app.example.com/icons/big.png');
  assert.equal(icon.width, 512);
  // SVG alone -> no usable icon
  assert.equal(pickManifestIcon({ icons: [{ src: 'a.svg', sizes: 'any' }] }, MANIFEST_URL), null);
  // monochrome-only icons are for UI tinting, not launchers
  assert.equal(pickManifestIcon({ icons: [{ src: 'm.png', sizes: '192x192', purpose: 'monochrome' }] }, MANIFEST_URL), null);
  // maskable icons ARE launcher icons
  assert.ok(pickManifestIcon({ icons: [{ src: 'm.png', sizes: '192x192', purpose: 'maskable' }] }, MANIFEST_URL));
  // sizes: "any" and multi-size declarations are ranked correctly.
  const any = pickManifestIcon({ icons: [{ src: 'any.png', sizes: 'any', type: 'image/png' }] }, MANIFEST_URL);
  assert.equal(any.src, 'https://app.example.com/any.png');
  const multi = pickManifestIcon({ icons: [
    { src: 'multi.ico', sizes: '16x16 32x32 256x256', type: 'image/x-icon' },
    { src: 'small.png', sizes: '48x48', type: 'image/png' }
  ] }, MANIFEST_URL);
  assert.equal(multi.src, 'https://app.example.com/multi.ico');
  assert.equal(multi.width, 256);
  assert.equal(pickManifestIcon({ icons: [] }, MANIFEST_URL), null);
  assert.equal(pickManifestIcon({}, MANIFEST_URL), null);
});

test('resolveStartUrl: the manifest start url resolved per spec, honest fallbacks', () => {
  assert.equal(
    resolveStartUrl({ start_url: '/home?src=pwa' }, MANIFEST_URL, PAGE),
    'https://app.example.com/home?src=pwa'
  );
  assert.equal(
    resolveStartUrl({ start_url: 'https://other.example/start' }, MANIFEST_URL, PAGE),
    'https://other.example/start'
  );
  assert.equal(resolveStartUrl({}, MANIFEST_URL, PAGE), PAGE, 'no start_url -> the page itself');
  assert.equal(resolveStartUrl({ start_url: 'javascript:alert(1)' }, MANIFEST_URL, PAGE), PAGE, 'unsafe scheme -> the page itself');
});

test('pickInstallIdentity: the SITE\u2019S OWN name/icon; honest fallbacks for non-PWA sites', () => {
  const pwa = pickInstallIdentity({
    manifest: { short_name: 'Tasks', name: 'Tasks Pro Example', icons: [{ src: '/i.png', sizes: '192x192' }], start_url: '/app', display: 'standalone', theme_color: '#123456' },
    manifestUrl: MANIFEST_URL,
    pageUrl: PAGE,
    pageTitle: 'Some page title'
  });
  assert.equal(pwa.name, 'Tasks', 'short_name wins (the launcher-appropriate name)');
  assert.equal(pwa.startUrl, 'https://app.example.com/app');
  assert.equal(pwa.iconSrc, 'https://app.example.com/i.png');
  assert.equal(pwa.display, 'standalone');
  assert.equal(pwa.themeColor, '#123456');
  assert.equal(pwa.pwa, true, 'manifest name + icon = a true PWA install');

  const nameOnly = pickInstallIdentity({ manifest: { name: 'No Icons Inc' }, manifestUrl: MANIFEST_URL, pageUrl: PAGE, pageTitle: 'T' });
  assert.equal(nameOnly.pwa, false, 'no usable icon -> not a PWA-branded install');
  assert.equal(nameOnly.name, 'No Icons Inc');

  const plain = pickInstallIdentity({ manifest: null, manifestUrl: null, pageUrl: PAGE, pageTitle: 'My Site' });
  assert.equal(plain.name, 'My Site', 'page title used for plain sites');
  assert.equal(plain.startUrl, PAGE);
  assert.equal(plain.pwa, false);

  const bare = pickInstallIdentity({ manifest: null, manifestUrl: null, pageUrl: PAGE, pageTitle: '' });
  assert.equal(bare.name, 'app.example.com', 'hostname is the last resort');
});

test('siteIconCandidates: exhausts site-owned logos and mirrors without ever adding Yayra branding', () => {
  const candidates = siteIconCandidates({
    manifest: { icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ] },
    manifestUrl: MANIFEST_URL,
    html: '<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">',
    pageUrl: PAGE,
    preferredIcon: 'https://app.example.com/live-favicon.png'
  });
  assert.equal(candidates[0], 'https://app.example.com/icon-512.png', 'largest manifest launcher icon wins');
  assert.equal(candidates[1], 'https://app.example.com/icon-192.png', 'a second manifest icon survives if the largest URL is broken');
  assert.equal(candidates[2], 'https://app.example.com/touch.png', 'best HTML-declared site icon follows');
  assert.equal(candidates[3], 'https://app.example.com/favicon.png', 'additional declared favicons remain available');
  assert.equal(candidates[4], 'https://app.example.com/live-favicon.png', 'Chromium-reported live favicon remains an early fallback');
  assert.ok(candidates.includes('https://app.example.com/favicon.ico'));
  assert.ok(candidates.includes('https://app.example.com/favicon.png'));
  assert.ok(candidates.includes('https://app.example.com/apple-touch-icon.png'));
  assert.ok(candidates.some((url) => url.startsWith('https://icons.duckduckgo.com/ip3/app.example.com.ico')));
  assert.ok(candidates.some((url) => url.startsWith('https://www.google.com/s2/favicons?')));
  assert.equal(candidates.some((url) => /yayra/i.test(url)), false, 'the browser logo is never an icon candidate');
  assert.equal(new Set(candidates).size, candidates.length, 'candidate retries are deduplicated');
});

test('pngToIco: a valid ICO container around the PNG (Windows .lnk icons need .ico)', () => {
  // Minimal structural PNG: signature + IHDR with 512x512.
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);              // IHDR length
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(512, 16);            // width
  png.writeUInt32BE(512, 20);            // height
  const ico = pngToIco(png);
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  assert.equal(ico.readUInt16LE(4), 1, 'one image');
  assert.equal(ico.readUInt8(6), 0, 'width 512 encodes as 0 (256+)');
  assert.equal(ico.readUInt8(7), 0, 'height 512 encodes as 0 (256+)');
  assert.equal(ico.readUInt16LE(10), 1, 'planes');
  assert.equal(ico.readUInt16LE(12), 32, 'bpp');
  assert.equal(ico.readUInt32LE(14), png.length, 'payload size');
  assert.equal(ico.readUInt32LE(18), 22, 'payload offset');
  assert.ok(ico.slice(22).equals(png), 'PNG payload intact');
  assert.deepEqual(extractPngFromIco(ico), png, 'PNG-backed ICO can be normalized on Linux and Android-class launchers');
  // Small icon: dimensions encoded directly.
  png.writeUInt32BE(48, 16);
  png.writeUInt32BE(48, 20);
  const small = pngToIco(png);
  assert.equal(small.readUInt8(6), 48);
  assert.equal(small.readUInt8(7), 48);
  // Non-PNG input is rejected loudly (callers fall back honestly).
  assert.throws(() => pngToIco(Buffer.from('not a png')));
});

test('magic-byte guards: Content-Type is never trusted', () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  assert.equal(isPngBuffer(png), true);
  assert.equal(isIcoBuffer(png), false);
  const ico = Buffer.alloc(32);
  Buffer.from([0x00, 0x00, 0x01, 0x00]).copy(ico, 0);
  assert.equal(isIcoBuffer(ico), true);
  assert.equal(isPngBuffer(ico), false);
  assert.equal(isPngBuffer(null), false);
  assert.equal(isIcoBuffer(Buffer.alloc(4)), false);
});

test('iconless sites receive a deterministic origin-specific neutral PNG identity', () => {
  const first = generateSiteIdentityPng('https://iconless.example/docs/page');
  const sameOrigin = generateSiteIdentityPng('https://iconless.example/another/path?x=1');
  const otherSite = generateSiteIdentityPng('https://different.example/');
  assert.ok(isPngBuffer(first), 'fallback is a real PNG launcher asset');
  assert.equal(first.readUInt32BE(16), 256);
  assert.equal(first.readUInt32BE(20), 256);
  assert.deepEqual(first, sameOrigin, 'one origin keeps one stable identity across routes');
  assert.notDeepEqual(first, otherSite, 'different sites do not share a generic browser logo');
  assert.equal(generateSiteIdentityPng('yayra://newtab'), null, 'internal/browser URLs never get an install identity');
});

test('WIRING (source pin): main.cjs resolves a site icon or generates a site-specific identity', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/pwaManifest\.cjs'\)/, 'the pure module is loaded');
  const fn = src.indexOf('async function resolvePwaInstallIdentity');
  const helpers = src.indexOf('function siteIconCacheSlug');
  assert.ok(fn > -1, 'identity resolver exists');
  assert.ok(helpers > -1 && helpers < fn, 'site-icon cache/normalization helpers exist');
  const block = src.slice(helpers, src.indexOf('\n\napp.whenReady()', fn));
  assert.match(block, /extractManifestLink/, 'page HTML is scanned for the manifest');
  assert.match(block, /parseManifest/, 'the manifest is parsed');
  assert.match(block, /pickInstallIdentity/, 'the identity (name/icon/start url) is picked');
  assert.match(block, /siteIconCandidates/, 'manifest, HTML, conventional, and mirrored site icons are tried');
  assert.match(block, /persistSiteIcon/, 'the verified site icon is stored for launcher and window use');
  assert.match(block, /normalizeSiteIconToPng/, 'JPEG/WebP/ICO sources are normalized for Linux launchers');
  assert.match(block, /generateSiteIdentityPng/, 'an iconless site receives a deterministic neutral identity');
  assert.match(block, /generated:\s*true/, 'generated identities are tracked separately from downloaded logos');
  assert.match(block, /AbortController/, 'every fetch is time-boxed - a slow site never blocks the install');
  assert.match(block, /catch \(err\)/, 'any failure is caught');
  assert.match(block, /return fallback/, 'invalid input returns an iconless identity that the handler refuses safely');
  // The handler wires it all into the install plan.
  const h = src.indexOf("ipcMain.handle('yayra:install-page-as-app'");
  const hblock = src.slice(h, h + 2000);
  assert.match(hblock, /async \(_event/, 'handler is async');
  assert.match(hblock, /await resolvePwaInstallIdentity/, 'identity resolved before planning');
  assert.match(hblock, /url: identity\.startUrl/, 'the PWA start url is what gets installed');
  assert.match(hblock, /title: (identity\.name|installName)/, "the PWA's own (or user-edited) name is the launcher name");
  assert.match(hblock, /if \(!identity\.iconFile\) return \{ ok: false, reason: 'site-icon-unavailable' \};/, 'an exceptional identity-generation failure still cannot inherit Yayra branding');
  assert.match(hblock, /iconPath = identity\.iconFile/, "the PWA's own icon is the only launcher icon");
  assert.doesNotMatch(hblock, /Icon=yayra|\? 'yayra'|yayra_bubble_logo/, 'no Yayra icon fallback can enter the site-app plan');
});

test('WIRING (source pin): successful installs distinguish real logos from generated site identities', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  assert.match(src, /site-specific generated icon/, 'iconless sites are described honestly');
  assert.match(src, /the site\\'s own logo/, 'real site logos are still identified as such');
  assert.doesNotMatch(src, /(?:Added|Installed)[^\n]+Yayra(?:'s)? logo/, 'success never implies a Yayra-logo fallback');
});


/* ------- P68: editable install name + site-logo guarantees ------- */

test('extractIconLink: a plain site own <link rel="icon"> is found - apple-touch-icon preferred, relative urls resolved, SVG skipped', () => {
  const PAGE = 'https://plain.example.com/articles/1';
  assert.equal(
    extractIconLink('<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">', PAGE),
    'https://plain.example.com/favicon-32.png'
  );
  assert.equal(
    extractIconLink(
      '<link rel="icon" href="/i16.png" sizes="16x16" type="image/png">'
      + '<link rel="apple-touch-icon" href="/touch.png" sizes="180x180">',
      PAGE
    ),
    'https://plain.example.com/touch.png'
  );
  assert.equal(
    extractIconLink('<link rel="shortcut icon" href="https://cdn.example.net/f.ico">', PAGE),
    'https://cdn.example.net/f.ico'
  );
  assert.equal(extractIconLink('<link rel="icon" href="/v.svg" type="image/svg+xml">', PAGE), null, 'SVG icons cannot be used');
  assert.equal(extractIconLink('<link rel="stylesheet" href="/a.css">', PAGE), null, 'non-icon links ignored');
  assert.equal(extractIconLink('', PAGE), null);
});

test('INSTALL FLOW (desktop): the name is EDITABLE - previewed from the site own manifest, then honored verbatim', async () => {
  const { setupDomShim } = await import('./dom-shim.mjs');
  setupDomShim();
  const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');
  let lastInstall = null;
  globalThis.window.yayra = {
    system: {
      installPageAsAppPreview: async () => ({ ok: true, name: 'Example App', startUrl: 'https://example.com/?src=pwa', pwa: true }),
      installPageAsApp: async (opts) => { lastInstall = opts; return { ok: true, name: opts.title, inLauncher: true, pwa: true }; }
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const notices = [];
  shell.showTransientNotice = (m) => notices.push(String(m));
  shell.state.tabs[0].url = 'https://example.com/app';
  shell.state.tabs[0].title = 'Some page title';
  try {
    let seenInstallDialog = null;
    shell._installPageAsAppDialog = async (opts) => { seenInstallDialog = opts; return 'My Example'; };
    await shell.installPageAsApp();
    assert.equal(seenInstallDialog.title, 'Example App', 'the confirmation is pre-filled with the SITE OWN name');
    assert.equal(seenInstallDialog.url, 'https://example.com/app', 'the active site is previewed in the confirmation');
    assert.equal(lastInstall.url, 'https://example.com/?src=pwa', 'the manifest start url is installed');
    assert.equal(lastInstall.title, 'My Example', 'the EDITED name is used');
    assert.equal(lastInstall.nameOverride, 'My Example', 'the edit is passed as an explicit override');
    assert.ok(notices.some((n) => /site's own logo/.test(n)), 'announced with the site-owned logo');

    lastInstall = null;
    shell._installPageAsAppDialog = async () => null;
    await shell.installPageAsApp();
    assert.equal(lastInstall, null, 'cancel writes nothing');
    assert.ok(notices.some((n) => /cancelled/i.test(n)), 'cancellation is confirmed to the user');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('INSTALL FLOW: an exceptional site-identity creation failure aborts instead of using Yayra branding', async () => {
  const { setupDomShim } = await import('./dom-shim.mjs');
  setupDomShim();
  const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');
  let installs = 0;
  globalThis.window.yayra = {
    system: {
      installPageAsAppPreview: async () => ({
        ok: true,
        name: 'No Logo Site',
        startUrl: 'https://no-logo.example/',
        pwa: false,
        iconAvailable: false,
        iconDataUrl: null
      }),
      installPageAsApp: async () => { installs += 1; return { ok: true }; }
    }
  };
  const shell = new BrowserShell({ container: document.createElement('div'), platform: 'linux', isMobile: false });
  await shell.initialize();
  const notices = [];
  shell.showTransientNotice = (message) => notices.push(String(message));
  shell.state.tabs[0].url = 'https://no-logo.example/';
  shell.state.tabs[0].title = 'No Logo Site';
  shell._installPageAsAppDialog = async () => { throw new Error('dialog must not open without any safe site identity'); };
  try {
    await shell.installPageAsApp();
    assert.equal(installs, 0, 'no launcher is written');
    assert.match(notices.at(-1), /safe identity/i);
    assert.match(notices.at(-1), /will not substitute its own logo/i);
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('INSTALL FLOW: iconless sites preview and install with a generated site-specific identity', async () => {
  const { setupDomShim } = await import('./dom-shim.mjs');
  setupDomShim();
  const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');
  let installed = null;
  globalThis.window.yayra = {
    system: {
      installPageAsAppPreview: async () => ({
        ok: true,
        name: 'Iconless Example',
        startUrl: 'https://iconless.example/',
        pwa: false,
        iconAvailable: true,
        generatedIcon: true,
        iconDataUrl: 'data:image/png;base64,AA=='
      }),
      installPageAsApp: async (options) => {
        installed = options;
        return { ok: true, name: options.title, inLauncher: true, generatedIcon: true };
      }
    }
  };
  const shell = new BrowserShell({ container: document.createElement('div'), platform: 'linux', isMobile: false });
  await shell.initialize();
  const notices = [];
  let dialogOptions = null;
  shell.showTransientNotice = (message) => notices.push(String(message));
  shell.state.tabs[0].url = 'https://iconless.example/path';
  shell.state.tabs[0].title = 'Iconless Example';
  shell._installPageAsAppDialog = async (options) => { dialogOptions = options; return options.title; };
  try {
    await shell.installPageAsApp();
    assert.ok(installed, 'the launcher install proceeds instead of failing closed');
    assert.match(dialogOptions.iconHtml, /data:image\/png;base64,AA==/, 'the generated identity is shown in confirmation');
    assert.ok(notices.some((notice) => /site-specific generated icon/i.test(notice)), 'success identifies the neutral fallback honestly');
    assert.equal(notices.some((notice) => /Yayra logo.*installed|installed.*Yayra logo/i.test(notice)), false);
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('INSTALL CONFIRMATION: Chrome-style name, site identity, Install and Cancel controls', async () => {
  const { setupDomShim } = await import('./dom-shim.mjs');
  setupDomShim();
  const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');
  const shell = new BrowserShell({ container: document.createElement('div'), platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    const accepted = shell._installPageAsAppDialog({
      title: 'Redis',
      url: 'https://redis.io/docs/latest/',
      iconHtml: '<svg aria-hidden="true"></svg>'
    });
    const overlay = document.getElementById('yayra-install-app-overlay');
    assert.ok(overlay, 'confirmation dialog is visible');
    const dialog = overlay.querySelector('[role="dialog"]');
    assert.ok(dialog, 'dialog has an accessible role');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.querySelector('h2').textContent, 'Install this page as an app');
    assert.equal(dialog.querySelector('input').value, 'Redis', 'name is editable and site-provided');
    assert.equal(dialog.querySelector('.fb-install-app-domain').textContent, 'redis.io');
    assert.equal(dialog.querySelector('.fb-install-app-hint').textContent, 'Apps open in a window');
    dialog.querySelector('input').value = 'Redis Docs';
    dialog.querySelector('.fb-btn-primary').click();
    assert.equal(await accepted, 'Redis Docs', 'Install returns the edited app name');
    assert.equal(document.getElementById('yayra-install-app-overlay'), null, 'dialog closes on Install');

    const cancelled = shell._installPageAsAppDialog({ title: 'Redis', url: 'https://redis.io/' });
    document.getElementById('yayra-install-app-overlay').querySelector('.fb-btn-secondary').click();
    assert.equal(await cancelled, null, 'Cancel does not install');
  } finally {
    shell.destroy();
  }
});

test('WIRING (source pin): preview IPC + preload bridge + nameOverride honored in main', () => {
  const mainSrc = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(mainSrc, /yayra:install-page-as-app-preview/, 'preview IPC registered');
  assert.match(mainSrc, /nameOverride\.trim\(\) !== ''/, 'nameOverride validated');
  assert.match(mainSrc, /title: installName/, 'the override (or manifest) name reaches the plan');
  assert.match(mainSrc, /siteIconCandidates\(\{ manifest, manifestUrl, html, pageUrl: url, preferredIcon \}\)/, 'the live favicon plus all site-owned/fallback candidates are tried');
  assert.match(mainSrc, /iconAvailable: Boolean\(identity\.iconFile\)/, 'preview reports whether a real site logo exists');
  assert.match(mainSrc, /iconDataUrl: identity\.iconDataUrl \|\| null/, 'resolved logo reaches the confirmation dialog');
  const preloadSrc = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preloadSrc, /installPageAsAppPreview/, 'the renderer can call the preview');
  assert.match(preloadSrc, /installPageAsApp:\s*\(\{\s*url,\s*title,\s*nameOverride,\s*favicon\s*\}\s*=\s*\{\}\)\s*=> ipcRenderer\.invoke\('yayra:install-page-as-app',\s*\{\s*url,\s*title,\s*nameOverride,\s*favicon\s*\}\)/s, 'the editable name and live site favicon reach the desktop installer');
  assert.match(preloadSrc, /installPageAsAppPreview:\s*\(\{\s*url,\s*title,\s*favicon\s*\}/, 'preview receives the same live site favicon');
});
