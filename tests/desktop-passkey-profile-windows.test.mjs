/**
 * P22 - desktop passkeys + Chrome-style per-profile windows.
 *
 * 1) electron/passkeyBridge.cjs: Chromium refuses real WebAuthn on the
 *    custom yayra:// scheme (users saw "passkeys require a secure (HTTPS)
 *    context" in the desktop app), so the desktop uses an OS-keychain
 *    device credential: random secret encrypted via safeStorage, with a
 *    REAL Touch ID gate on supporting Macs. Covers register/verify/
 *    status/remove, keychain-unavailable, and Touch ID decline.
 *
 * 2) PasskeyService native-bridge path: when the preload exposes
 *    window.yayra.passkeys, the service routes register/verify/remove
 *    through it instead of navigator.credentials, and isSupported() is
 *    true even where WebAuthn is absent.
 *
 * 3) BrowserShell profile windows: "Add profile", switching from the
 *    dropdown, and accepting the smart suggestion all open the OTHER
 *    profile in a NEW window (bridge or window.open fallback) while THIS
 *    window keeps its profile; without any window capability the old
 *    in-place switch still happens (covered in profile-service.test.mjs).
 *    Plus the ?profile= boot binding (windowProfileId ctor option).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { createRequire } from 'node:module';
import { PasskeyService } from '../packages/shared-ui/src/services/passkeyService.js';
import { ProfileService, DEFAULT_PROFILE_ID } from '../packages/shared-ui/src/services/profileService.js';
import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

const require = createRequire(import.meta.url);
const { createPasskeyBridge } = require('../electron/passkeyBridge.cjs');
const { createDownloadsBridge } = require('../electron/downloadsBridge.cjs');

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, val) { this.map.set(key, String(val)); }
  removeItem(key) { this.map.delete(key); }
}

/* ------------------------- passkeyBridge (main process) ------------------------- */

function makeFakeFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, String(data)); },
    mkdirSync: () => {},
    unlinkSync: (p) => { files.delete(p); }
  };
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8').slice(4)
};

function makeBridge(overrides = {}) {
  const fs = overrides.fs || makeFakeFs();
  const bridge = createPasskeyBridge({
    ipcMain: null,
    fs,
    path,
    userDataDir: '/fake/userData',
    safeStorageImpl: overrides.safeStorageImpl ?? fakeSafeStorage,
    systemPreferencesImpl: overrides.systemPreferencesImpl ?? null,
    platform: overrides.platform ?? 'linux',
    phoneApproval: overrides.phoneApproval ?? null,
    logger: { error: () => {}, warn: () => {} }
  });
  return { bridge, fs };
}

test('passkeyBridge: register -> status -> verify -> remove round-trip', async () => {
  const { bridge, fs } = makeBridge();

  let status = await bridge.handleStatus();
  assert.equal(status.available, true);
  assert.equal(status.registered, false);
  assert.equal(status.method, 'os-keychain');

  const reg = await bridge.handleRegister(null, { label: 'ada@example.com' });
  assert.equal(reg.ok, true);
  assert.ok(reg.passkey.credentialId.startsWith('device-'));
  assert.equal(reg.passkey.label, 'ada@example.com');
  assert.equal(reg.passkey.method, 'os-keychain');
  assert.ok(!('encryptedSecret' in reg.passkey), 'secret material never leaves the main process');

  // The on-disk record only holds the ENCRYPTED secret + a hash.
  const raw = JSON.parse(fs.files.get(bridge._filePath));
  assert.ok(raw.encryptedSecret && raw.secretHash, 'encrypted secret + hash stored');
  assert.ok(raw.encryptedSecret.length > 0 && !raw.encryptedSecret.includes(raw.secretHash));

  status = await bridge.handleStatus();
  assert.equal(status.registered, true);
  assert.equal(status.passkey.label, 'ada@example.com');

  const ver = await bridge.handleVerify();
  assert.equal(ver.ok, true);

  const rem = await bridge.handleRemove();
  assert.equal(rem.ok, true);
  assert.equal((await bridge.handleStatus()).registered, false);
  assert.deepEqual(await bridge.handleVerify(), { ok: false, reason: 'no-passkey-registered' });
});

test('passkeyBridge: keychain unavailable is reported honestly', async () => {
  const { bridge } = makeBridge({ safeStorageImpl: { isEncryptionAvailable: () => false } });
  assert.equal((await bridge.handleStatus()).available, false);
  assert.deepEqual(await bridge.handleRegister(null, {}), { ok: false, reason: 'keychain-unavailable' });
});

test('passkeyBridge: macOS Touch ID gates the ceremony and a decline cancels it', async () => {
  const prompts = [];
  let allow = true;
  const systemPreferencesImpl = {
    canPromptTouchID: () => true,
    promptTouchID: async (reason) => {
      prompts.push(reason);
      if (!allow) throw new Error('User rejected Touch ID');
    }
  };
  const { bridge } = makeBridge({ platform: 'darwin', systemPreferencesImpl });

  assert.equal((await bridge.handleStatus()).method, 'touch-id');

  const reg = await bridge.handleRegister(null, { label: 'mac user' });
  assert.equal(reg.ok, true);
  assert.equal(reg.passkey.method, 'touch-id');
  assert.equal(prompts.length, 1, 'registration prompted Touch ID');

  allow = false;
  const ver = await bridge.handleVerify();
  assert.deepEqual(ver, { ok: false, reason: 'user-declined-or-timeout' });
  assert.equal(prompts.length, 2, 'verify prompted Touch ID too');

  allow = true;
  assert.equal((await bridge.handleVerify()).ok, true);
});

test('passkeyBridge: tampered record fails verification', async () => {
  const { bridge, fs } = makeBridge();
  await bridge.handleRegister(null, { label: 'x' });
  const raw = JSON.parse(fs.files.get(bridge._filePath));
  raw.secretHash = 'f'.repeat(64);
  fs.files.set(bridge._filePath, JSON.stringify(raw));
  assert.deepEqual(await bridge.handleVerify(), { ok: false, reason: 'verification-failed' });
});

/* ------------------------- PasskeyService native path ------------------------- */

function makeNativeBridgeFake({ failRegister = null, failVerify = null } = {}) {
  const calls = [];
  return {
    calls,
    register: async (label) => {
      calls.push(['register', label]);
      if (failRegister) return { ok: false, reason: failRegister };
      return { ok: true, passkey: { credentialId: 'device-1', label, createdAt: 1700000000000, method: 'os-keychain' } };
    },
    verify: async () => {
      calls.push(['verify']);
      return failVerify ? { ok: false, reason: failVerify } : { ok: true };
    },
    remove: async () => { calls.push(['remove']); return { ok: true }; },
    status: async () => ({ available: true, registered: false })
  };
}

function makeServiceStorage() {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); }
  };
}

test('PasskeyService: native bridge makes passkeys supported without WebAuthn', () => {
  const svc = new PasskeyService({ storage: makeServiceStorage(), nativeBridge: makeNativeBridgeFake() });
  assert.equal(svc.isSupported(), true, 'bridge present -> supported even with no navigator.credentials');
  const webauthnOnly = new PasskeyService({ storage: makeServiceStorage() });
  assert.equal(webauthnOnly.isSupported(), false, 'dom-shim has no WebAuthn -> unsupported without bridge');
});

test('PasskeyService: register routes through the bridge and persists an honest record', async () => {
  const bridge = makeNativeBridgeFake();
  const storage = makeServiceStorage();
  const svc = new PasskeyService({ storage, nativeBridge: bridge });

  const res = await svc.registerPasskey({ accountLabel: 'ada@example.com' });
  assert.equal(res.success, true);
  assert.equal(res.passkey.method, 'os-keychain', 'method recorded for honest UI copy');
  assert.deepEqual(bridge.calls[0], ['register', 'ada@example.com']);

  const stored = await svc.getRegisteredPasskey();
  assert.equal(stored.credentialId, 'device-1');
  assert.equal(stored.accountLabel, 'ada@example.com');
});

test('PasskeyService: bridge failures surface their reasons', async () => {
  const svc = new PasskeyService({
    storage: makeServiceStorage(),
    nativeBridge: makeNativeBridgeFake({ failRegister: 'keychain-unavailable' })
  });
  assert.deepEqual(await svc.registerPasskey({}), { success: false, reason: 'keychain-unavailable' });

  const bridge2 = makeNativeBridgeFake({ failVerify: 'user-declined-or-timeout' });
  const storage2 = makeServiceStorage();
  const svc2 = new PasskeyService({ storage: storage2, nativeBridge: bridge2 });
  await svc2.registerPasskey({ accountLabel: 'x' });
  assert.deepEqual(await svc2.verifyPasskey(), { success: false, reason: 'user-declined-or-timeout' });
});

test('PasskeyService: verify success stamps lastVerifiedAt; remove clears bridge AND record', async () => {
  const bridge = makeNativeBridgeFake();
  const storage = makeServiceStorage();
  const svc = new PasskeyService({ storage, nativeBridge: bridge });
  await svc.registerPasskey({ accountLabel: 'x' });

  const ver = await svc.verifyPasskey();
  assert.equal(ver.success, true);
  assert.ok((await svc.getRegisteredPasskey()).lastVerifiedAt > 0);

  await svc.removePasskey();
  assert.equal(await svc.getRegisteredPasskey(), null);
  assert.ok(bridge.calls.some(([m]) => m === 'remove'), 'OS-side credential removed too');
});

/* --------------- renderer/device drift (the "Passkey active but
   verify says nothing registered" screenshot bug) --------------- */

test('passkeyBridge: register verifies the file actually persisted (read-back)', async () => {
  const fs = makeFakeFs();
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => {}; // disk silently drops the write
  const { bridge } = makeBridge({ fs });
  const reg = await bridge.handleRegister(null, { label: 'x' });
  assert.deepEqual(reg, { ok: false, reason: 'device-storage-failed' }, 'never claims success without a persisted record');

  fs.writeFileSync = originalWrite;
  assert.equal((await bridge.handleRegister(null, { label: 'x' })).ok, true, 'works once writes persist');
});

test('passkeyBridge: status reports weak encryption honestly on keyring-less Linux', async () => {
  const { bridge } = makeBridge({
    platform: 'linux',
    safeStorageImpl: { ...fakeSafeStorage, getSelectedStorageBackend: () => 'basic_text' }
  });
  assert.equal((await bridge.handleStatus()).weakEncryption, true);

  const { bridge: healthy } = makeBridge({
    platform: 'linux',
    safeStorageImpl: { ...fakeSafeStorage, getSelectedStorageBackend: () => 'gnome_libsecret' }
  });
  assert.equal((await healthy.handleStatus()).weakEncryption, false);
});

test('PasskeyService: sync drops a STALE renderer record when the device file is gone', async () => {
  const storage = makeServiceStorage();
  const svc = new PasskeyService({
    storage,
    nativeBridge: {
      ...makeNativeBridgeFake(),
      status: async () => ({ available: true, registered: false, passkey: null })
    }
  });
  // The renderer believes a native passkey exists (the screenshot state)...
  await storage.set('yayra-account-passkey-v1', { credentialId: 'device-old', accountLabel: 'ghost', method: 'os-keychain' });

  const sync = await svc.syncWithNativeBridge();
  assert.equal(sync.action, 'cleared-stale');
  assert.equal(await svc.getRegisteredPasskey(), null, 'stale record dropped - UI offers Create passkey again');
});

test('PasskeyService: sync ADOPTS the device record after a renderer-storage wipe', async () => {
  const svc = new PasskeyService({
    storage: makeServiceStorage(),
    nativeBridge: {
      ...makeNativeBridgeFake(),
      status: async () => ({
        available: true,
        registered: true,
        passkey: { credentialId: 'device-9', label: 'ada@example.com', createdAt: 1700000000000, method: 'os-keychain' }
      })
    }
  });
  const sync = await svc.syncWithNativeBridge();
  assert.equal(sync.action, 'adopted');
  const stored = await svc.getRegisteredPasskey();
  assert.equal(stored.credentialId, 'device-9');
  assert.equal(stored.accountLabel, 'ada@example.com');
});

test('PasskeyService: sync never touches a WebAuthn (web-build) record', async () => {
  const storage = makeServiceStorage();
  const svc = new PasskeyService({
    storage,
    nativeBridge: {
      ...makeNativeBridgeFake(),
      status: async () => ({ available: true, registered: false, passkey: null })
    }
  });
  // WebAuthn records carry no `method` - the bridge has no say over them.
  await storage.set('yayra-account-passkey-v1', { credentialId: 'webauthn-1', accountLabel: 'web' });
  const sync = await svc.syncWithNativeBridge();
  assert.equal(sync.action, 'none');
  assert.ok(await svc.getRegisteredPasskey(), 'WebAuthn record untouched');
});

test('PasskeyService: a stale verify self-heals - REPAIRED when the device ceremony works, cleared only when it cannot', async () => {
  // Device records are re-created through the OS ceremony (P29: "verify
  // must not REMOVE my passkey") - see tests/passkey-system-auth.test.mjs
  // for the full repair matrix. Here: when repair is impossible (the
  // bridge cannot register either), the stale record is still dropped so
  // the UI can offer re-creation instead of a dead "Passkey active" card.
  const storage = makeServiceStorage();
  const svc = new PasskeyService({
    storage,
    nativeBridge: {
      ...makeNativeBridgeFake(),
      register: async () => ({ ok: false, reason: 'keychain-unavailable' }),
      verify: async () => ({ ok: false, reason: 'no-passkey-registered' })
    }
  });
  await storage.set('yayra-account-passkey-v1', { credentialId: 'device-old', accountLabel: 'ghost', method: 'os-keychain' });

  const result = await svc.verifyPasskey();
  assert.deepEqual(result, { success: false, reason: 'no-passkey-registered' });
  assert.equal(await svc.getRegisteredPasskey(), null, 'stale record dropped when repair is impossible');
});

/* ------------------------- Shell: per-profile windows ------------------------- */

function makeShell({ storage = new MemoryStorage(), options = {} } = {}) {
  const container = document.createElement('div');
  const profileService = new ProfileService({ storage });
  const shell = new BrowserShell({ container, isMobile: false, profileService, ...options });
  shell.render(container);
  return { shell, container, profileService, storage };
}

function withProfileWindowBridge(fn) {
  const opened = [];
  globalThis.window.yayra = {
    profiles: { openWindow: (id) => { opened.push(id); return Promise.resolve({ ok: true }); } }
  };
  try {
    return fn(opened);
  } finally {
    delete globalThis.window.yayra;
  }
}

test('Shell: "Add profile" opens the NEW profile in a NEW window; this window keeps its profile', () => {
  withProfileWindowBridge((opened) => {
    const { shell, container, profileService } = makeShell();
    shell.state.tabs[0].url = 'https://example.com';
    shell.state.isAccountMenuOpen = true;
    shell.render(container);

    container.querySelector('.fb-profile-add-btn').click();

    assert.equal(profileService.list().length, 2, 'new profile created');
    const created = profileService.list().find((p) => p.id !== DEFAULT_PROFILE_ID);
    assert.deepEqual(opened, [created.id], 'new window opened FOR THE NEW profile');
    assert.equal(profileService.current().id, DEFAULT_PROFILE_ID, 'THIS window stays on its profile');
    assert.equal(shell.state.tabs[0].url, 'https://example.com', 'current tabs untouched');
    assert.equal(shell.state.isAccountMenuOpen, false, 'menu closes');
  });
});

test('Shell: clicking another profile row opens IT in a new window, current stays', () => {
  withProfileWindowBridge((opened) => {
    const { shell, container, profileService } = makeShell();
    const work = profileService.createProfile({ name: 'Work' });
    shell.state.tabs[0].url = 'https://example.com';
    shell.state.isAccountMenuOpen = true;
    shell.render(container);

    const row = container.querySelectorAll('.fb-profile-row')
      .find((r) => r.getAttribute('data-profile-id') === work.id);
    row.click();

    assert.deepEqual(opened, [work.id]);
    assert.equal(profileService.current().id, DEFAULT_PROFILE_ID, 'no in-place switch');
    assert.equal(shell.state.tabs[0].url, 'https://example.com', 'tabs survive');
  });
});

test('Shell: accepting the "keep separate" suggestion opens a new window for it', () => {
  withProfileWindowBridge((opened) => {
    const { shell, profileService } = makeShell();
    shell.handleAccountSignal('ada@example.com');
    shell.handleAccountSignal('grace@example.com');
    assert.ok(shell.state.profileSuggestion);
    shell.state.tabs[0].url = 'https://mail.example.com';

    shell.acceptProfileSuggestion();

    assert.equal(shell.state.profileSuggestion, null);
    assert.equal(profileService.list().length, 2, 'profile created for grace');
    const grace = profileService.list().find((p) => p.email === 'grace@example.com');
    assert.deepEqual(opened, [grace.id], 'grace opens in her own window');
    assert.equal(profileService.current().email, 'ada@example.com', 'ada keeps this window');
    assert.equal(shell.state.tabs[0].url, 'https://mail.example.com', 'ada keeps her tabs');
  });
});

test('Shell: without a bridge, window.open fallback carries ?profile=<id>', () => {
  const opens = [];
  globalThis.window.open = (url) => { opens.push(url); return {}; };
  try {
    const { shell, container, profileService } = makeShell();
    shell.state.isAccountMenuOpen = true;
    shell.render(container);
    container.querySelector('.fb-profile-add-btn').click();

    const created = profileService.list().find((p) => p.id !== DEFAULT_PROFILE_ID);
    assert.equal(opens.length, 1);
    assert.ok(opens[0].includes(`profile=${encodeURIComponent(created.id)}`), `url carries the profile id: ${opens[0]}`);
    assert.equal(profileService.current().id, DEFAULT_PROFILE_ID, 'opener window unaffected');
  } finally {
    delete globalThis.window.open;
  }
});

test('Shell: windowProfileId boot option binds the new window to its profile', () => {
  const storage = new MemoryStorage();
  const seed = new ProfileService({ storage });
  const work = seed.createProfile({ name: 'Work' });
  assert.equal(seed.current().id, DEFAULT_PROFILE_ID, 'creating does not switch');

  // The new window boots with ?profile=<work> -> binds to Work.
  const { profileService } = makeShell({ storage, options: { windowProfileId: work.id } });
  assert.equal(profileService.current().id, work.id);

  // Unknown ids are ignored instead of corrupting state.
  const { profileService: svc2 } = makeShell({ storage: new MemoryStorage(), options: { windowProfileId: 'nope' } });
  assert.equal(svc2.current().id, DEFAULT_PROFILE_ID);
});

test('Shell: two live profile windows keep different Google accounts and ignore each other’s auth lifecycle', async () => {
  const storage = new MemoryStorage();
  const seed = new ProfileService({ storage });
  seed.evaluateSignIn('personal@example.com');
  const work = seed.createProfile({ name: 'Work', email: 'work@example.com' });
  const listeners = new Set();
  const calls = [];
  const accounts = new Map([
    ['default', { sub: 'personal', name: 'Personal', email: 'personal@example.com' }],
    [work.id, { sub: 'work', name: 'Work', email: 'work@example.com' }]
  ]);
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const auth = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async getSession(profileId) {
      calls.push(['getSession', profileId]);
      const profile = accounts.get(profileId);
      return profile
        ? { signedIn: true, profile, savedAt: '2026-01-01T00:00:00.000Z' }
        : { signedIn: false };
    },
    async signIn(profileId) {
      calls.push(['signIn', profileId]);
      const profile = { sub: 'work-new', name: 'New Work', email: 'new-work@example.com' };
      accounts.set(profileId, profile);
      emit({ type: 'signed-in', profileId, profile });
      return { ok: true, profile };
    },
    async signOut(profileId) {
      calls.push(['signOut', profileId]);
      accounts.delete(profileId);
      emit({ type: 'signed-out', profileId });
      return { ok: true };
    },
    async downloadDriveFile(_fileId, profileId) {
      calls.push(['downloadDriveFile', profileId]);
      return { ok: false, error: 'drive_reconnect_required' };
    },
    async connectDrive(profileId) {
      calls.push(['connectDrive', profileId]);
      return { ok: true, pending: true };
    }
  };
  globalThis.window.yayra = { auth };
  try {
    const personalWindow = makeShell({ storage, options: { windowProfileId: 'default' } }).shell;
    const workWindow = makeShell({ storage, options: { windowProfileId: work.id } }).shell;
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(personalWindow.state.googleAccount.profile.email, 'personal@example.com');
    assert.equal(workWindow.state.googleAccount.profile.email, 'work@example.com');
    assert.deepEqual(calls.filter(([name]) => name === 'getSession'), [
      ['getSession', 'default'],
      ['getSession', work.id]
    ]);

    // Account chooser completion in Work is tagged and ignored by Personal.
    await workWindow.switchGoogleAccount();
    assert.equal(workWindow.state.googleAccount.profile.email, 'new-work@example.com');
    assert.equal(personalWindow.state.googleAccount.profile.email, 'personal@example.com');
    assert.deepEqual(calls.find(([name]) => name === 'signIn'), ['signIn', work.id]);

    // Drive fallback must use Work's delegated session, never Personal's.
    await workWindow._downloadDriveFileThroughApi(
      workWindow.state.activeTabId,
      'https://drive.google.com/file/d/abcdefghij12345/view'
    );
    assert.ok(calls.some(([name, id]) => name === 'downloadDriveFile' && id === work.id));
    assert.ok(calls.some(([name, id]) => name === 'connectDrive' && id === work.id));

    await workWindow.signOutOfGoogle();
    assert.equal(workWindow.state.googleAccount.signedIn, false);
    assert.equal(personalWindow.state.googleAccount.profile.email, 'personal@example.com',
      'Work sign-out cannot clear Personal');
    assert.deepEqual(calls.find(([name]) => name === 'signOut'), ['signOut', work.id]);

    // Even an accidental/broadcast foreign event is defense-in-depth filtered.
    emit({ type: 'signed-out', profileId: work.id });
    assert.equal(personalWindow.state.googleAccount.signedIn, true);
  } finally {
    delete globalThis.window.yayra;
  }
});

/* ------------------------- downloadsBridge.attachSession ------------------------- */

test('downloadsBridge: profile-window sessions join download tracking exactly once', () => {
  const listeners = [];
  const makeSession = () => ({ on: (ev, fn) => listeners.push([ev, fn]) });
  const base = makeSession();
  const bridge = createDownloadsBridge({
    ipcMain: { handle: () => {}, on: () => {} },
    shell: {},
    dialog: {},
    path,
    fs: { existsSync: () => false },
    sessions: [base],
    downloadsStore: {
      load: () => ({ items: [] }),
      addOrUpdateItem: () => {},
      getDownloadRoot: () => '/tmp'
    },
    getMainWindow: () => null
  });
  assert.equal(listeners.length, 1, 'base session subscribed at creation');

  const profileSession = makeSession();
  assert.equal(bridge.attachSession(profileSession), true, 'new session attaches');
  assert.equal(bridge.attachSession(profileSession), false, 'duplicate attach is a no-op');
  assert.equal(bridge.attachSession(base), false, 'creation-time sessions never double-subscribe');
  assert.equal(listeners.length, 2, 'exactly one will-download listener per session');
  assert.equal(listeners[1][0], 'will-download');
});
