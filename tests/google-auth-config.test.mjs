import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGoogleClientId, resolveGoogleClientSecret, defaultUserConfigDir } from '../electron/googleAuthConfig.cjs';

function fakeFs(files = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p]
  };
}

test('resolveGoogleClientId: prefers the YAYRA_GOOGLE_CLIENT_ID environment variable', () => {
  const id = resolveGoogleClientId({
    env: { YAYRA_GOOGLE_CLIENT_ID: '  env-client-id  ' },
    fs: fakeFs(),
    configDir: '/app/electron'
  });
  assert.equal(id, 'env-client-id');
});

test('resolveGoogleClientId: falls back to electron/google-auth.config.json when env is unset', () => {
  const id = resolveGoogleClientId({
    env: {},
    fs: fakeFs({ '/app/electron/google-auth.config.json': JSON.stringify({ clientId: 'file-client-id' }) }),
    configDir: '/app/electron'
  });
  assert.equal(id, 'file-client-id');
});

test('resolveGoogleClientId: returns null (not a throw) when neither source is configured', () => {
  const id = resolveGoogleClientId({ env: {}, fs: fakeFs(), configDir: '/app/electron' });
  assert.equal(id, null);
});

test('resolveGoogleClientId: returns null for a malformed config file instead of throwing', () => {
  const id = resolveGoogleClientId({
    env: {},
    fs: fakeFs({ '/app/electron/google-auth.config.json': 'not valid json' }),
    configDir: '/app/electron'
  });
  assert.equal(id, null);
});

test('resolveGoogleClientId: returns null when the config file has no clientId field', () => {
  const id = resolveGoogleClientId({
    env: {},
    fs: fakeFs({ '/app/electron/google-auth.config.json': JSON.stringify({ foo: 'bar' }) }),
    configDir: '/app/electron'
  });
  assert.equal(id, null);
});

test('resolveGoogleClientSecret: prefers the YAYRA_GOOGLE_CLIENT_SECRET environment variable', () => {
  const secret = resolveGoogleClientSecret({
    env: { YAYRA_GOOGLE_CLIENT_SECRET: '  env-secret  ' },
    fs: fakeFs(),
    configDir: '/app/electron'
  });
  assert.equal(secret, 'env-secret');
});

test('resolveGoogleClientSecret: falls back to electron/google-auth.config.json when env is unset', () => {
  const secret = resolveGoogleClientSecret({
    env: {},
    fs: fakeFs({ '/app/electron/google-auth.config.json': JSON.stringify({ clientId: 'id', clientSecret: 'file-secret' }) }),
    configDir: '/app/electron'
  });
  assert.equal(secret, 'file-secret');
});

test('resolveGoogleClientSecret: returns null (not a throw) when neither source is configured', () => {
  const secret = resolveGoogleClientSecret({ env: {}, fs: fakeFs(), configDir: '/app/electron' });
  assert.equal(secret, null);
});

test('resolveGoogleClientSecret: returns null for a malformed config file instead of throwing', () => {
  const secret = resolveGoogleClientSecret({
    env: {},
    fs: fakeFs({ '/app/electron/google-auth.config.json': 'not valid json' }),
    configDir: '/app/electron'
  });
  assert.equal(secret, null);
});

test('resolveGoogleClientId and resolveGoogleClientSecret read independent fields from the same config file', () => {
  const fs = fakeFs({ '/app/electron/google-auth.config.json': JSON.stringify({ clientId: 'id-only' }) });
  assert.equal(resolveGoogleClientId({ env: {}, fs, configDir: '/app/electron' }), 'id-only');
  assert.equal(resolveGoogleClientSecret({ env: {}, fs, configDir: '/app/electron' }), null);
});

// ---------------------------------------------------------------------------
// Installed-build fallback: the per-user config directory. This is what lets
// an ALREADY-INSTALLED Yayra be configured for Google sign-in with no rebuild:
// drop google-auth.config.json into ~/.config/yayra (or %APPDATA%\yayra /
// ~/Library/Application Support/yayra) and restart the app.
// ---------------------------------------------------------------------------

test('INSTALLED-BUILD FIX: user config dir google-auth.config.json works when the bundled file is absent (no rebuild needed)', () => {
  const fs = fakeFs({ '/home/u/.config/yayra/google-auth.config.json': JSON.stringify({ clientId: 'user-dir-id', clientSecret: 'user-dir-secret' }) });
  const opts = { env: {}, fs, configDir: '/app/electron', userConfigDir: '/home/u/.config/yayra' };
  assert.equal(resolveGoogleClientId(opts), 'user-dir-id');
  assert.equal(resolveGoogleClientSecret(opts), 'user-dir-secret');
});

test('INSTALLED-BUILD FIX: a machine-local user-dir file WINS over the file baked into the installer', () => {
  const fs = fakeFs({
    '/home/u/.config/yayra/google-auth.config.json': JSON.stringify({ clientId: 'machine-local-id' }),
    '/app/electron/google-auth.config.json': JSON.stringify({ clientId: 'baked-in-id', clientSecret: 'baked-in-secret' })
  });
  const opts = { env: {}, fs, configDir: '/app/electron', userConfigDir: '/home/u/.config/yayra' };
  assert.equal(resolveGoogleClientId(opts), 'machine-local-id', 'user dir overrides the shipped clientId');
  assert.equal(resolveGoogleClientSecret(opts), 'baked-in-secret', 'fields resolve independently - missing user-dir field falls through to the bundled file');
});

test('INSTALLED-BUILD FIX: env vars still beat every file source', () => {
  const fs = fakeFs({ '/home/u/.config/yayra/google-auth.config.json': JSON.stringify({ clientId: 'user-dir-id' }) });
  const id = resolveGoogleClientId({ env: { YAYRA_GOOGLE_CLIENT_ID: 'env-id' }, fs, configDir: '/app/electron', userConfigDir: '/home/u/.config/yayra' });
  assert.equal(id, 'env-id');
});

test('defaultUserConfigDir matches where the installed app keeps its per-user data on each OS', () => {
  assert.equal(
    defaultUserConfigDir({ env: {}, platform: 'linux', homedir: '/home/u' }),
    '/home/u/.config/yayra'
  );
  assert.equal(
    defaultUserConfigDir({ env: { XDG_CONFIG_HOME: '/custom/cfg' }, platform: 'linux', homedir: '/home/u' }),
    '/custom/cfg/yayra'
  );
  assert.equal(
    defaultUserConfigDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u' }).endsWith('yayra'),
    true
  );
  assert.equal(
    defaultUserConfigDir({ env: {}, platform: 'darwin', homedir: '/Users/u' }),
    '/Users/u/Library/Application Support/yayra'
  );
});

test('RELEASE PIPELINE: release.yml injects the Google config from repo secrets into BOTH desktop packaging jobs', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const injections = yml.split('Inject Google sign-in config').length - 1;
  assert.equal(injections >= 2, true, 'linux and windows jobs each inject google-auth.config.json before packaging');
  assert.equal(yml.includes('YAYRA_GOOGLE_CLIENT_ID'), true, 'reads the client id from repo secrets');
  assert.equal(yml.includes('YAYRA_GOOGLE_CLIENT_SECRET'), true, 'reads the client secret from repo secrets');
  assert.equal((yml.match(/Published desktop builds require YAYRA_GOOGLE_CLIENT_ID/g) || []).length >= 2, true,
    'both publishing jobs fail closed instead of shipping a callback flow with no client configuration');
});
