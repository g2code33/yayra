import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  normalizeCredential,
  strongStorageStatus,
  createWebsitePasskeyProvider
} = require('../electron/websitePasskeyProvider.cjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function strongSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet6',
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      const text = Buffer.from(value).toString();
      if (!text.startsWith('sealed:')) throw new Error('not sealed');
      return Buffer.from(text.slice(7), 'base64').toString();
    }
  };
}

function fsWithPolicyKit() {
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return (value) => value === '/usr/bin/pkexec' || target.existsSync(value);
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function approvedSpawn() {
  const child = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => child.emit('exit', 0));
  return child;
}

function fakeWebContents() {
  const wc = new EventEmitter();
  const debug = new EventEmitter();
  const commands = [];
  let attached = false;
  debug.isAttached = () => attached;
  debug.attach = () => { attached = true; };
  debug.detach = () => { attached = false; debug.emit('detach', {}, 'target closed'); };
  debug.sendCommand = async (method, params = {}) => {
    commands.push({ method, params });
    if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' };
    return {};
  };
  wc.debugger = debug;
  wc.isDestroyed = () => false;
  wc.commands = commands;
  return wc;
}

const credential = {
  credentialId: 'Y3JlZGVudGlhbC0x',
  isResidentCredential: true,
  rpId: 'github.com',
  privateKey: 'cHJpdmF0ZS1rZXktcGs4',
  userHandle: 'dXNlci0x',
  signCount: 0,
  backupEligibility: false,
  backupState: false,
  userName: 'octocat',
  userDisplayName: 'Octocat'
};

test('Linux website passkeys require strong safeStorage instead of basic_text', () => {
  assert.equal(strongStorageStatus(strongSafeStorage(), 'linux').available, true);
  for (const backend of ['basic_text', 'unknown', '']) {
    assert.deepEqual(
      strongStorageStatus({
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => backend
      }, 'linux'),
      { available: false, reason: 'secure-storage-unavailable' }
    );
  }
  assert.equal(strongStorageStatus(strongSafeStorage(), 'win32').reason, 'native-platform-authenticator');
});

test('credential records are tightly validated before entering the encrypted provider store', () => {
  assert.deepEqual(normalizeCredential(credential), credential);
  assert.equal(normalizeCredential({ ...credential, rpId: 'https://evil.example' }), null);
  assert.equal(normalizeCredential({ ...credential, privateKey: '' }), null);
  assert.equal(normalizeCredential({ ...credential, signCount: -1 })?.signCount, -1);
  assert.equal(normalizeCredential({ ...credential, signCount: -2 }), null);
});

test('Linux provider waits for explicit PolicyKit approval, then persists and rehydrates a real virtual credential', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const safeStorage = strongSafeStorage();
  const provider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: safeStorage,
    platform: 'linux',
    spawnImpl: approvedSpawn
  });
  const wc = fakeWebContents();
  assert.deepEqual(provider.describe({ webContents: wc }), { mode: 'local', available: true, reason: 'initializing' });
  assert.deepEqual(await provider.attach({ webContents: wc, profileId: 'default' }), { ok: true, mode: 'local' });

  const addAuthenticator = wc.commands.find((command) => command.method === 'WebAuthn.addVirtualAuthenticator');
  assert.equal(addAuthenticator.params.options.transport, 'internal');
  assert.equal(addAuthenticator.params.options.hasResidentKey, true);
  assert.equal(addAuthenticator.params.options.hasUserVerification, true);
  assert.equal(addAuthenticator.params.options.automaticPresenceSimulation, false,
    'the site cannot create a credential before an explicit toolbar confirmation');
  assert.equal(addAuthenticator.params.options.isUserVerified, false);

  const approved = await provider.confirm({
    webContents: wc,
    requestId: 'yayra-wa-1',
    action: 'create',
    rpId: 'github.com',
    isStillActive: () => true
  });
  assert.deepEqual(approved, { ok: true, prompted: true, presenceExpiresInMs: 30000 });
  assert.ok(wc.commands.some((command) => command.method === 'WebAuthn.setUserVerified'
    && command.params.isUserVerified === true));
  assert.ok(wc.commands.some((command) => command.method === 'WebAuthn.setAutomaticPresenceSimulation'
    && command.params.enabled === true));

  wc.debugger.emit('message', {}, 'WebAuthn.credentialAdded', {
    authenticatorId: 'auth-1',
    credential
  });
  await flush();
  const rawStore = fs.readFileSync(provider._filePath, 'utf8');
  assert.equal(rawStore.includes(credential.privateKey), false, 'private key is never written in plaintext');
  assert.equal(rawStore.includes('github.com'), false, 'relying-party metadata is encrypted too');

  const restored = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: safeStorage,
    platform: 'linux',
    spawnImpl: approvedSpawn
  });
  const secondView = fakeWebContents();
  await restored.attach({ webContents: secondView, profileId: 'default' });
  const hydrate = secondView.commands.find((command) => command.method === 'WebAuthn.addCredential');
  assert.ok(hydrate, 'encrypted credential is restored into a new Chromium authenticator');
  assert.deepEqual(hydrate.params.credential, credential);

  secondView.debugger.emit('message', {}, 'WebAuthn.credentialAsserted', {
    authenticatorId: 'auth-1',
    credential: { ...credential, signCount: 1 }
  });
  await flush();
  assert.ok(secondView.commands.some((command) => command.method === 'WebAuthn.setAutomaticPresenceSimulation'
    && command.params.enabled === false), 'presence closes immediately after the assertion');
  provider.destroy();
  restored.destroy();
});

test('private tabs and weak-storage Linux sessions fail closed to the system-browser mode', async () => {
  const weakProvider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir: '/tmp/unused-yayra-passkeys',
    safeStorageImpl: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text'
    },
    platform: 'linux',
    spawnImpl: approvedSpawn
  });
  const wc = fakeWebContents();
  assert.equal(weakProvider.describe({ webContents: wc }).mode, 'external');
  assert.equal(wc.commands.length, 0);

  const strongProvider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir: '/tmp/unused-yayra-passkeys',
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    spawnImpl: approvedSpawn
  });
  assert.equal(strongProvider.describe({ webContents: wc, isPrivate: true }).reason, 'private-tab');
  await strongProvider.attach({ webContents: wc, isPrivate: true });
  assert.equal(wc.commands.length, 0, 'private tabs never receive a persistable software authenticator');
});

test('cancelled system verification never releases virtual user presence', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-cancel-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const provider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    authorizeImpl: async () => ({ ok: false, prompted: true, reason: 'user-declined-or-timeout' })
  });
  const wc = fakeWebContents();
  await provider.attach({ webContents: wc });
  const result = await provider.confirm({
    webContents: wc,
    requestId: 'yayra-wa-cancel',
    action: 'create',
    rpId: 'github.com'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'user-declined-or-timeout');
  assert.equal(wc.commands.some((command) => command.method === 'WebAuthn.setAutomaticPresenceSimulation'
    && command.params.enabled === true), false);
  provider.destroy();
});


test('an unreadable encrypted credential store is never replaced with an empty vault', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-corrupt-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const storePath = path.join(userDataDir, 'yayra-site-passkeys.json');
  fs.writeFileSync(storePath, '{"version":1,"encrypted":"not-a-valid-envelope"}', { mode: 0o600 });
  const before = fs.readFileSync(storePath, 'utf8');
  const provider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    spawnImpl: approvedSpawn,
    logger: { error: () => {}, warn: () => {} }
  });
  const wc = fakeWebContents();
  assert.deepEqual(provider.describe({ webContents: wc }), {
    mode: 'external',
    available: false,
    reason: 'credential-store-unreadable'
  });
  await provider.attach({ webContents: wc });
  assert.equal(wc.commands.length, 0);
  assert.equal(fs.readFileSync(storePath, 'utf8'), before, 'corrupt bytes remain recoverable for support/keyring repair');
});

test('disk failure is detected before PolicyKit and never releases user presence', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-write-fail-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let authorizationCalls = 0;
  const brokenFs = new Proxy(fsWithPolicyKit(), {
    get(target, property) {
      if (property === 'writeFileSync') {
        return (pathname, ...args) => {
          if (String(pathname).includes('yayra-site-passkeys')) throw new Error('disk full');
          return target.writeFileSync(pathname, ...args);
        };
      }
      return target[property];
    }
  });
  const provider = createWebsitePasskeyProvider({
    fsImpl: brokenFs,
    pathImpl: path,
    userDataDir,
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    authorizeImpl: async () => { authorizationCalls += 1; return { ok: true, prompted: true }; },
    logger: { error: () => {}, warn: () => {} }
  });
  const wc = fakeWebContents();
  await provider.attach({ webContents: wc });
  const result = await provider.confirm({
    webContents: wc,
    requestId: 'yayra-wa-storage-failure',
    action: 'create',
    rpId: 'github.com'
  });
  assert.deepEqual(result, { ok: false, reason: 'credential-store-write-failed' });
  assert.equal(authorizationCalls, 0, 'do not request a password for a ceremony whose key cannot be saved');
  assert.equal(wc.commands.some((command) => command.method === 'WebAuthn.setAutomaticPresenceSimulation'
    && command.params.enabled === true), false);
  assert.equal(provider.describe({ webContents: wc }).mode, 'external');
  provider.destroy();
});


test('a stalled experimental protocol command times out to external mode instead of blocking page load forever', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-protocol-timeout-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const provider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    spawnImpl: approvedSpawn,
    commandTimeoutMs: 5,
    logger: { error: () => {}, warn: () => {} }
  });
  const wc = fakeWebContents();
  wc.debugger.sendCommand = () => new Promise(() => {});
  const result = await provider.attach({ webContents: wc });
  assert.equal(result.ok, false);
  assert.match(result.reason, /protocol-timeout:WebAuthn\.enable/);
  assert.equal(provider.describe({ webContents: wc }).mode, 'external');
  provider.destroy();
});


test('one profile cannot authorize overlapping ceremonies in different tabs', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-site-passkeys-profile-lock-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let resolveAuthorization;
  const provider = createWebsitePasskeyProvider({
    fsImpl: fsWithPolicyKit(),
    pathImpl: path,
    userDataDir,
    safeStorageImpl: strongSafeStorage(),
    platform: 'linux',
    authorizeImpl: () => new Promise((resolve) => { resolveAuthorization = resolve; })
  });
  const firstView = fakeWebContents();
  const secondView = fakeWebContents();
  await provider.attach({ webContents: firstView, profileId: 'same-profile' });
  await provider.attach({ webContents: secondView, profileId: 'same-profile' });
  const first = provider.confirm({
    webContents: firstView,
    requestId: 'yayra-wa-first-profile-lock',
    action: 'get',
    rpId: 'github.com',
    isStillActive: () => false
  });
  await flush();
  await provider.settle({ webContents: firstView, requestId: 'yayra-wa-first-profile-lock' });
  const overlapping = await provider.confirm({
    webContents: secondView,
    requestId: 'yayra-wa-second-profile-lock',
    action: 'get',
    rpId: 'github.com'
  });
  assert.deepEqual(overlapping, { ok: false, reason: 'request-already-prompting' });
  resolveAuthorization({ ok: true, prompted: true });
  assert.deepEqual(await first, { ok: false, reason: 'request-ended' });
  provider.destroy();
});
