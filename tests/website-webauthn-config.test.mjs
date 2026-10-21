import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKeychainAccessGroup,
  extractWebAuthnKeychainAccessGroup,
  configureWebsiteWebAuthn
} from '../electron/websiteWebAuthn.cjs';

const silentLogger = { info() {}, warn() {} };

test('macOS website WebAuthn: parses only a dedicated valid group from signed entitlements', () => {
  const plist = `<?xml version="1.0"?><plist><dict>
    <key>keychain-access-groups</key>
    <array>
      <string>TEAMID1234.com.yayra.shared</string>
      <string>TEAMID1234.com.yayra.app.webauthn</string>
    </array>
  </dict></plist>`;
  assert.equal(extractWebAuthnKeychainAccessGroup(plist), 'TEAMID1234.com.yayra.app.webauthn');
  assert.equal(extractWebAuthnKeychainAccessGroup('<plist><dict></dict></plist>'), null);
  assert.equal(normalizeKeychainAccessGroup('$(AppIdentifierPrefix)com.yayra.app.webauthn'), null, 'unexpanded signing placeholders are never trusted at runtime');
  assert.equal(normalizeKeychainAccessGroup('TEAMID1234.com.yayra.app.webauthn'), 'TEAMID1234.com.yayra.app.webauthn');
});

test('macOS website WebAuthn: configures Touch ID after readiness with an explicitly entitled group', () => {
  const calls = [];
  const app = { configureWebAuthn: (options) => calls.push(options) };
  const result = configureWebsiteWebAuthn({
    app,
    platform: 'darwin',
    env: { YAYRA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP: 'TEAMID1234.com.yayra.app.webauthn' },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: '<plist><dict><key>keychain-access-groups</key><array><string>TEAMID1234.com.yayra.app.webauthn</string></array></dict></plist>',
      stderr: ''
    }),
    logger: silentLogger
  });
  assert.deepEqual(result, { configured: true, source: 'environment-and-signed-entitlements' });
  assert.deepEqual(calls, [{
    touchID: {
      keychainAccessGroup: 'TEAMID1234.com.yayra.app.webauthn',
      promptReason: 'verify your identity on $1'
    }
  }]);
});

test('macOS website WebAuthn: discovers the exact group from the running app signature', () => {
  const calls = [];
  const app = { configureWebAuthn: (options) => calls.push(options) };
  const plist = `<plist><dict><key>keychain-access-groups</key><array>
    <string>TEAMID1234.com.yayra.app.webauthn</string>
  </array></dict></plist>`;
  const result = configureWebsiteWebAuthn({
    app,
    platform: 'darwin',
    env: {},
    executablePath: '/Applications/yayra.app/Contents/MacOS/yayra',
    spawnSyncImpl: (executable, args) => {
      assert.equal(executable, '/usr/bin/codesign');
      assert.deepEqual(args, ['-d', '--entitlements', ':-', '/Applications/yayra.app/Contents/MacOS/yayra']);
      return { status: 0, stdout: plist, stderr: '' };
    },
    logger: silentLogger
  });
  assert.deepEqual(result, { configured: true, source: 'signed-entitlements' });
  assert.equal(calls.length, 1);
});

test('website WebAuthn configuration fails closed off macOS or without a matching entitlement', () => {
  let calls = 0;
  const app = { configureWebAuthn: () => { calls += 1; } };
  assert.deepEqual(
    configureWebsiteWebAuthn({ app, platform: 'linux', env: {}, logger: silentLogger }),
    { configured: false, reason: 'not-macos' }
  );
  assert.deepEqual(
    configureWebsiteWebAuthn({
      app,
      platform: 'darwin',
      env: { YAYRA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP: 'TEAMID1234.com.yayra.app.webauthn' },
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'not signed' }),
      logger: silentLogger
    }),
    { configured: false, reason: 'missing-entitlement' }
  );
  assert.equal(calls, 0, 'an invented keychain group is never passed to Electron');
});

test('macOS website WebAuthn reports an entitlement/configuration mismatch without crashing startup', () => {
  const result = configureWebsiteWebAuthn({
    app: { configureWebAuthn: () => { throw new Error('missing keychain-access-groups entitlement'); } },
    platform: 'darwin',
    env: { YAYRA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP: 'TEAMID1234.com.yayra.app.webauthn' },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: '<plist><dict><key>keychain-access-groups</key><array><string>TEAMID1234.com.yayra.app.webauthn</string></array></dict></plist>',
      stderr: ''
    }),
    logger: silentLogger
  });
  assert.deepEqual(result, { configured: false, reason: 'configuration-rejected' });
});
