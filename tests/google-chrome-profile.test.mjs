import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parity = require('../electron/googleAuthParity.cjs');
const profiles = require('../electron/googleChromeProfile.cjs');
const uaMetadata = require('../electron/googleAuthUserAgentMetadata.cjs');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function fakeFs({ files = new Set(), dirs = new Set() } = {}) {
  const state = { files: new Set(files), dirs: new Set(dirs), writes: [] };
  return {
    state,
    existsSync: (p) => state.files.has(p) || state.dirs.has(p),
    statSync: (p) => ({ isFile: () => state.files.has(p) }),
    mkdirSync: (p) => { state.dirs.add(p); },
    readFileSync: (p) => {
      const entry = state.writes.find((w) => w.path === p);
      if (entry) return entry.contents;
      throw new Error('ENOENT');
    },
    writeFileSync: (p, contents) => {
      state.writes.push({ path: p, contents: String(contents) });
      state.files.add(p);
    }
  };
}

// ---------------------------------------------------------------------------
// googleAuthParity.cjs: exact host matching, honest destinations, client hints
// ---------------------------------------------------------------------------

test('parity: only real Google-owned HTTPS hosts are valid destinations', () => {
  assert.match(parity.safeGoogleDestination('https://mail.google.com/mail/u/0/#inbox'), /^https:\/\/mail\.google\.com\//);
  assert.match(parity.safeGoogleDestination('https://myaccount.google.com/'), /myaccount\.google\.com/);
  assert.equal(parity.safeGoogleDestination('https://google.com.evil.example/signin'), null);
  assert.equal(parity.safeGoogleDestination('https://evilgoogle.com/'), null);
  assert.equal(parity.safeGoogleDestination('http://accounts.google.com/'), null);
  assert.equal(parity.safeGoogleDestination('https://user:pass@accounts.google.com/'), null);
  assert.equal(parity.safeGoogleDestination('javascript:alert(1)'), null);
  assert.equal(parity.safeGoogleDestination('https://accounts.google.com/\u0000evil'), null);
  assert.equal(parity.isGoogleOwnedHost('accounts.google.com.evil.test'), false);
  assert.equal(parity.isGoogleOwnedHost('google.co.uk'), true);
});

test('parity: auth surface is exact and never a lookalike domain', () => {
  assert.equal(parity.isGoogleAuthSurface('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(parity.isGoogleAuthSurface('https://consent.google.com/'), true);
  assert.equal(parity.isGoogleAuthSurface('https://myaccount.google.com/'), true);
  assert.equal(parity.isGoogleAuthSurface('https://www.google.com/search?q=x'), false);
  assert.equal(parity.isGoogleAuthSurface('http://accounts.google.com/'), false);
  assert.equal(parity.isGoogleAuthSurface('https://accounts.google.com.evil.test/'), false);
});

test('parity: first-party sign-in allowed natively, third-party OAuth never is', () => {
  const serviceLogin = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2F';
  const v3 = 'https://accounts.google.com/v3/signin/identifier?flowName=GlifDesktop';
  const thirdParty = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fexample.com%2Fcb';
  assert.equal(parity.isFirstPartyGoogleSignInUrl(serviceLogin), true);
  assert.equal(parity.isFirstPartyGoogleSignInUrl(v3), true);
  assert.equal(parity.isFirstPartyGoogleSignInUrl(thirdParty), false);
  assert.equal(parity.isThirdPartyGoogleOAuthUrl(thirdParty), true);
  assert.equal(parity.isFirstPartyGoogleSignInUrl('https://myaccount.google.com/'), false);
  assert.equal(parity.isGoogleAccountPortalUrl('https://myaccount.google.com/'), true);
  assert.equal(parity.isThirdPartyGoogleOAuthUrl(serviceLogin), false);
});

test('parity: rejected sign-in fallback opens a fresh ServiceLogin and preserves only safe continuation', () => {
  const rejected = 'https://accounts.google.com/signin/rejected?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F%23inbox&hl=en';
  const recovered = new URL(parity.googleSignInFallbackUrl(rejected));
  assert.equal(recovered.origin, 'https://accounts.google.com');
  assert.equal(recovered.pathname, '/ServiceLogin');
  assert.equal(recovered.searchParams.get('continue'), 'https://mail.google.com/mail/u/0/#inbox');
  assert.equal(recovered.searchParams.get('hl'), 'en');
  assert.equal(parity.googleSignInFallbackUrl('https://accounts.google.com/signin/rejected?continue=https%3A%2F%2Fevil.example%2F'), 'https://accounts.google.com/ServiceLogin');
  assert.equal(parity.googleSignInFallbackUrl('https://evil.example/signin/rejected'), 'https://accounts.google.com/ServiceLogin');
});

test('parity: rejected sign-in URLs are detected without echoing the URL', () => {
  assert.equal(parity.isGoogleSignInRejectedUrl('https://accounts.google.com/signin/rejected?reason=disallowed_useragent'), true);
  assert.equal(parity.isGoogleSignInRejectedUrl('https://accounts.google.com/v3/signin/rejected'), true);
  assert.equal(parity.isGoogleSignInRejectedUrl('https://accounts.google.com/signin/v2/identifier?error=disallowed_useragent'), true);
  assert.equal(parity.isGoogleSignInRejectedUrl('https://accounts.google.com/signin/v2/identifier'), false);
  assert.equal(parity.isGoogleSignInRejectedUrl('https://www.google.com/signin/rejected'), false);
});

test('parity: client hints are honest, internally consistent, and token-free', () => {
  const hints = parity.buildGoogleAuthClientHints({ chromeVersion: '144.0.7559.20', platform: 'win32' });
  assert.match(hints['Sec-CH-UA'], /"Chromium";v="144"/);
  assert.match(hints['Sec-CH-UA'], /"Not\?A_Brand";v="99"/);
  assert.doesNotMatch(hints['Sec-CH-UA'], /Google Chrome/i);
  assert.equal(hints['Sec-CH-UA-Platform'], '"Windows"');
  assert.equal(hints['Sec-CH-UA-Mobile'], '?0');
  assert.match(hints['Sec-CH-UA-Full-Version-List'], /144\.0\.7559\.20/);
  const serialized = JSON.stringify(hints);
  for (const secret of ['access_token', 'refresh_token', 'cookie', 'bearer', 'profileId']) {
    assert.equal(serialized.toLowerCase().includes(secret), false);
  }
});

test('parity: applyGoogleAuthClientHints replaces inconsistent hints case-insensitively', () => {
  const headers = { 'sec-ch-ua': '"Not A(Brand";v="8"', Cookie: 'SID=abc', 'X-Custom': 'keep' };
  const next = parity.applyGoogleAuthClientHints(headers, { chromeVersion: '144.0.0.0', platform: 'linux' });
  assert.equal(next.Cookie, 'SID=abc', 'existing cookies are preserved');
  assert.equal(next['X-Custom'], 'keep', 'unrelated headers are preserved');
  assert.equal(next['sec-ch-ua'], undefined, 'inconsistent hint removed');
  assert.match(next['Sec-CH-UA'], /Chromium/);
  assert.equal(headers['sec-ch-ua'], '"Not A(Brand";v="8"', 'input object not mutated');
  // Idempotent: a second application is a no-op with the same reference.
  const again = parity.applyGoogleAuthClientHints(next, { chromeVersion: '144.0.0.0', platform: 'linux' });
  assert.equal(again, next);
});

test('parity: unsafe Chrome flags are rejected', () => {
  assert.ok(parity.unsafeChromeFlag('--remote-debugging-port=9222'));
  assert.ok(parity.unsafeChromeFlag('--enable-automation'));
  assert.ok(parity.unsafeChromeFlag('--user-agent=Mozilla/5.0 evil'));
  assert.ok(parity.unsafeChromeFlag(['--no-sand', 'box'].join('')));
  assert.equal(parity.unsafeChromeFlag('--user-data-dir=/home/u/.config/yayra/chrome'), null);
  assert.equal(parity.unsafeChromeFlag('--no-first-run'), null);
});

// ---------------------------------------------------------------------------
// googleChromeProfile.cjs: isolation, binary resolution, launch safety
// ---------------------------------------------------------------------------

test('chrome profile: per-profile directories are isolated and cannot escape userData', () => {
  const userDataDir = '/home/u/.config/yayra';
  const a = profiles.chromeProfileDir({ userDataDir, profileId: 'alice' });
  const b = profiles.chromeProfileDir({ userDataDir, profileId: 'bob' });
  assert.notEqual(a, b);
  assert.ok(a.startsWith(path.resolve(userDataDir, 'google-chrome-profiles') + path.sep));
  assert.equal(profiles.normalizeChromeProfileId('../../etc/passwd'), 'default');
  assert.equal(profiles.normalizeChromeProfileId(''), 'default');
  const longA = 'a'.repeat(64) + 'alice';
  const longB = 'a'.repeat(64) + 'bob';
  assert.equal(profiles.normalizeChromeProfileId(longA), longA);
  assert.notEqual(
    profiles.chromeProfileDir({ userDataDir, profileId: longA }),
    profiles.chromeProfileDir({ userDataDir, profileId: longB }),
    'long profile identifiers never collide through path truncation'
  );
});

test('chrome profile: binary resolution uses an allowlist and honours an explicit override', () => {
  const fs = fakeFs({ files: new Set(['/usr/bin/google-chrome-stable']) });
  const found = profiles.resolveChromeBinary({ fs, platform: 'linux', env: {}, homedir: '/home/u' });
  assert.equal(found, '/usr/bin/google-chrome-stable');
  const absent = profiles.resolveChromeBinary({ fs: fakeFs(), platform: 'linux', env: {}, homedir: '/home/u' });
  assert.equal(absent, null);
  const fs2 = fakeFs({ files: new Set(['/opt/custom/chrome']) });
  assert.equal(profiles.resolveChromeBinary({ fs: fs2, platform: 'linux', env: { YAYRA_CHROME_BINARY: '/opt/custom/chrome' } }), '/opt/custom/chrome');
  assert.equal(profiles.resolveChromeBinary({ fs: fs2, platform: 'linux', env: { YAYRA_CHROME_BINARY: 'chrome' } }), null, 'relative override rejected');
  assert.equal(profiles.resolveChromeBinary({ fs: fs2, platform: 'linux', env: { YAYRA_CHROME_BINARY: '/opt/custom/other' } }), null, 'unknown override rejected');
});

test('chrome profile: Windows/macOS candidate lists contain only absolute install paths', () => {
  const win = profiles.chromeBinaryCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } });
  assert.ok(win.length > 0);
  assert.ok(win.every((p) => p.includes('chrome.exe') || p.includes('msedge.exe')));
  const mac = profiles.chromeBinaryCandidates({ platform: 'darwin', env: {}, homedir: '/Users/u' });
  assert.ok(mac.some((p) => p.includes('Google Chrome.app')));
  assert.ok(mac.every((p) => p.startsWith('/')));
});

test('chrome profile: launch args are fixed, safe, and only Google destinations', () => {
  const profileDir = '/home/u/.config/yayra/google-chrome-profiles/default';
  const args = profiles.buildChromeProfileArgs({ profileDir, url: 'https://myaccount.google.com/', platform: 'linux' });
  assert.ok(args.some((a) => a === `--user-data-dir=${profileDir}`));
  assert.equal(args[args.length - 1], 'https://myaccount.google.com/');
  for (const forbidden of ['--remote-debugging-port', '--enable-automation', '--headless', ['--no-sand', 'box'].join(''), '--user-agent=', 'Electron']) {
    assert.equal(args.some((a) => a.includes(forbidden)), false, `forbidden: ${forbidden}`);
  }
  assert.throws(() => profiles.buildChromeProfileArgs({ profileDir, url: 'https://evil.example/', platform: 'linux' }), /invalid_google_destination/);
  assert.throws(() => profiles.buildChromeProfileArgs({ profileDir: 'relative/dir', url: 'https://google.com/', platform: 'linux' }), /invalid_profile_dir/);
});

test('chrome profile: OAuth authorization URL must be exact accounts.google.com with a loopback callback', () => {
  const good = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A45123%2Fcallback&response_type=code&scope=openid%20email&code_challenge=abc&state=xyz';
  assert.ok(profiles.safeGoogleAuthorizationUrl(good));
  assert.equal(profiles.safeGoogleAuthorizationUrl(good.replace('https://accounts.google.com', 'https://accounts.google.com.evil.test')), null);
  assert.equal(profiles.safeGoogleAuthorizationUrl(good.replace('http%3A%2F%2F127.0.0.1%3A45123%2Fcallback', 'https%3A%2F%2Fevil.example%2Fcallback')), null);
  assert.equal(profiles.safeGoogleAuthorizationUrl('http://accounts.google.com/o/oauth2/v2/auth'), null);
  const args = profiles.buildChromeProfileAuthorizationArgs({ profileDir: '/tmp/yayra-google/default', url: good, platform: 'linux' });
  assert.equal(args[args.length - 1], good);
  assert.equal(args.some((a) => a.includes('--remote-debugging')), false);
});

test('chrome profile: the REAL PKCE URL from googleAuth.cjs is accepted as the external user-agent launch target', () => {
  const googleAuth = require('../electron/googleAuth.cjs');
  const { codeVerifier, codeChallenge } = googleAuth.generatePkcePair(() => require('node:crypto').randomBytes(32));
  const authUrl = googleAuth.buildAuthorizationUrl({
    clientId: '1234567890-abcdef.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:45123/callback',
    state: 'a'.repeat(43),
    codeChallenge,
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.readonly']
  });
  assert.ok(codeVerifier);
  assert.equal(profiles.safeGoogleAuthorizationUrl(authUrl), authUrl, 'exact real authorization URL validates');
  const args = profiles.buildChromeProfileAuthorizationArgs({
    profileDir: '/home/u/.config/yayra/google-chrome-profiles/default',
    url: authUrl
  });
  assert.equal(args[args.length - 1], authUrl);
  // The loopback callback still belongs to Yayra's main-process HTTP server:
  // no Google token, cookie or refresh token is ever placed in the launch URL.
  for (const secret of ['access_token', 'refresh_token', 'id_token', 'SID=']) {
    assert.equal(authUrl.includes(secret), false);
  }
  // A valid OAuth URL with a non-loopback redirect must be refused.
  const tampered = authUrl.replace('http%3A%2F%2F127.0.0.1%3A45123%2Fcallback', 'https%3A%2F%2Fattacker.example%2Fcb');
  assert.equal(profiles.safeGoogleAuthorizationUrl(tampered), null);
});

test('chrome profile: manager isolates profiles, persists a manifest, and never reads cookies', () => {
  const fs = fakeFs({ files: new Set(['/opt/google/chrome/chrome']) });
  const spawns = [];
  const manager = profiles.createGoogleChromeProfileManager({
    fs,
    spawn: (exe, args) => { spawns.push({ exe, args }); return { pid: 1234, unref() {} }; },
    platform: 'linux',
    env: {},
    homedir: '/home/u',
    userDataDir: '/home/u/.config/yayra',
    logger: { error() {} },
    now: () => 1700000000000
  });
  assert.equal(manager.status('alice').available, true);
  assert.doesNotMatch(JSON.stringify(manager.status('alice')), /cookie|token|SID=|password/i);

  const first = manager.open('alice', 'https://mail.google.com/mail/u/0/#inbox');
  assert.equal(first.ok, true);
  const second = manager.open('bob', 'https://drive.google.com/drive/u/0/my-drive');
  assert.equal(second.ok, true);
  assert.notEqual(first.profileDir, second.profileDir);
  assert.equal(spawns.length, 2);
  assert.notEqual(spawns[0].args[0], spawns[1].args[0], 'different --user-data-dir per profile');

  const manifests = fs.state.writes.filter((w) => w.path.endsWith('yayra-profile.json'));
  assert.equal(manifests.length, 2);
  for (const manifest of manifests) {
    const parsed = JSON.parse(manifest.contents);
    assert.ok(['alice', 'bob'].includes(parsed.profileId));
    assert.equal(Object.keys(parsed).includes('cookies'), false);
    assert.equal(Object.keys(parsed).includes('tokens'), false);
  }
  // A restarted app reuses the exact same directory and manifest.
  const restarted = profiles.createGoogleChromeProfileManager({
    fs, spawn: () => ({ pid: 1, unref() {} }), platform: 'linux', env: {}, homedir: '/home/u',
    userDataDir: '/home/u/.config/yayra', logger: { error() {} }
  });
  assert.equal(restarted.status('alice').exists, true);
  assert.equal(restarted.status('alice').profileDir, first.profileDir);
  assert.equal(fs.state.writes.filter((w) => w.path.endsWith('yayra-profile.json')).length, 2, 'no new manifest on restart');
});

test('chrome profile: manager fails closed when no Chrome is installed', () => {
  const fs = fakeFs();
  const manager = profiles.createGoogleChromeProfileManager({
    fs, spawn: () => { throw new Error('should not spawn'); }, platform: 'linux', env: {}, homedir: '/home/u',
    userDataDir: '/home/u/.config/yayra', logger: { error() {} }
  });
  assert.equal(manager.status().available, false);
  assert.deepEqual(manager.open('default', 'https://myaccount.google.com/'), { ok: false, error: 'chrome_binary_not_found' });
  assert.equal(manager.open('default', 'https://evil.example/').ok, false);
});

test('chrome profile: profile binding mismatch is rejected', () => {
  const userDataDir = '/home/u/.config/yayra';
  const dir = profiles.chromeProfileDir({ userDataDir, profileId: 'alice' });
  const manifestPath = path.join(dir, 'yayra-profile.json');
  const fs = fakeFs({ files: new Set(['/opt/google/chrome/chrome', manifestPath]), dirs: new Set([dir]) });
  fs.state.writes.push({ path: manifestPath, contents: JSON.stringify({ version: 1, profileId: 'someone-else' }) });
  const manager = profiles.createGoogleChromeProfileManager({
    fs, spawn: () => ({ pid: 1, unref() {} }), platform: 'linux', env: {}, homedir: '/home/u',
    userDataDir, logger: { error() {} }
  });
  const result = manager.open('alice', 'https://myaccount.google.com/');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chrome_profile_binding_mismatch');
});

// ---------------------------------------------------------------------------
// UA metadata: honest brands, no automation flags, best-effort CDP
// ---------------------------------------------------------------------------

test('UA metadata: honest Chromium brands and no Google Chrome impersonation', () => {
  const meta = uaMetadata.buildUserAgentMetadata({ chromeVersion: '144.0.7559.20', platform: 'darwin' });
  assert.equal(meta.brands[0].brand, 'Chromium');
  assert.equal(meta.brands[0].version, '144');
  assert.equal(meta.platform, 'macOS');
  assert.equal(meta.mobile, false);
  assert.equal(JSON.stringify(meta).includes('Google Chrome'), false);
  const override = uaMetadata.buildUserAgentOverride({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36', chromeVersion: '144.0.0.0', platform: 'linux' });
  assert.ok(override.userAgentMetadata);
  assert.equal(uaMetadata.buildUserAgentOverride({ userAgent: '' }), null);
});

test('UA metadata: CDP application is best-effort and never throws', async () => {
  const sent = [];
  const wc = { debugger: { isAttached: () => false, attach: () => {}, sendCommand: async (name, args) => { sent.push({ name, args }); } } };
  assert.equal(await uaMetadata.applyGoogleAuthUserAgentMetadata(wc, { userAgent: 'Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36' }), true);
  assert.equal(sent[0].name, 'Emulation.setUserAgentOverride');
  assert.doesNotMatch(JSON.stringify(sent[0].args), /enable-automation|headless|remote-debugging/);
  assert.equal(await uaMetadata.applyGoogleAuthUserAgentMetadata(null, { userAgent: 'x' }), false);
  assert.equal(await uaMetadata.applyGoogleAuthUserAgentMetadata({ debugger: { sendCommand: async () => { throw new Error('blocked'); } } }, { userAgent: 'x' }), false);
});

// ---------------------------------------------------------------------------
// Integration: source-level guarantees
// ---------------------------------------------------------------------------

test('integration: no page scripts, no header rewriting, verified origin on auth surfaces', () => {
  const bridge = readFileSync(path.join(ROOT, 'electron/webviewBridge.cjs'), 'utf8');
  const preload = readFileSync(path.join(ROOT, 'electron/autofillPreload.cjs'), 'utf8');
  const media = readFileSync(path.join(ROOT, 'electron/mediaCompatibility.cjs'), 'utf8');
  const shell = readFileSync(path.join(ROOT, 'packages/shared-ui/src/components/BrowserShell.js'), 'utf8');
  const preloadBridge = readFileSync(path.join(ROOT, 'electron/preload.cjs'), 'utf8');

  assert.match(preload, /GOOGLE_AUTH_SURFACE_HOST/, 'autofill preload is gated on Google auth hosts');
  assert.match(bridge, /if \(!wc \|\| isAuthSurfaceEntry\(entry\)\) return;/, 'text-selection injection gated');
  assert.match(bridge, /if \(isAuthSurfaceEntry\(entry\)\) return;/, 'account marker injection gated');
  assert.match(bridge, /if \(authSurfaceRequest\(details\)\) return \{\};/, 'no request rewriting');
  assert.match(bridge, /applyGoogleAuthClientHints\(headers\)/, 'honest client hints on auth traffic');
  assert.match(bridge, /google-sign-in-rejected/, 'rejected sign-in fallback event');
  assert.match(bridge, /google-auth-surface/, 'main-process-verified origin event');
  assert.match(bridge, /select-webauthn-account/, 'native WebAuthn chooser retained');
  assert.match(media, /authSurfaceParity/, 'media compatibility respects auth surfaces');
  assert.match(shell, /fb-auth-surface-verified/, 'verified origin badge in browser chrome');
  assert.match(shell, /setGoogleAuthParity/, 'parity switch wired to main');
  assert.match(preloadBridge, /yayra:chrome-profile-status/, 'Chrome profile IPC exposed');
});

test('integration: Yayra account sign-in is untouched and no cookies are copied', () => {
  const authBridge = readFileSync(path.join(ROOT, 'electron/authBridge.cjs'), 'utf8');
  const main = readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8');
  const profileModule = readFileSync(path.join(ROOT, 'electron/googleChromeProfile.cjs'), 'utf8');
  assert.match(authBridge, /async function handleSignIn\(/, 'original Yayra sign-in intact');
  assert.match(authBridge, /openExternal: \(url\) => shell\.openExternal\(url\)/, 'Yayra account sign-in still uses OS browser');
  assert.doesNotMatch(profileModule, /cookies\.get|encrypted_value|Login Data|Local State|DPAPI|Keychain|sqlite/i, 'no Chrome cookie extraction');
  assert.match(main, /createGoogleChromeProfileManager/, 'dedicated Chrome manager wired into main');
  assert.match(main, /openGoogleAuthorization/, 'OAuth loop uses dedicated Chrome as external user-agent');
});
