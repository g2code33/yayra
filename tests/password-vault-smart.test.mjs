/**
 * Password & Keys Vault + Passkeys + Chrome-style remember prompt.
 *
 * Covers:
 *  - PasswordManager v2: real AES-GCM-256 encryption at rest (no
 *    plaintext, no reversible XOR), browser-safe (no Buffer requirement),
 *    legacy v1 XOR entries still decrypt (migration path).
 *  - Keys & tokens live in the same encrypted vault but a separate section.
 *  - shouldOfferToSave(): the full Chrome-style prompt gate (private tabs,
 *    disabled saving, never-save origins, unchanged duplicates).
 *  - PasskeyService: register/verify/remove with an injected fake
 *    WebAuthn API; honest failure reasons.
 *  - BrowserShell: captured login -> "Save password?" bar -> Save/Never;
 *    autofill-form-detected -> fillCredentials on the native bridge;
 *    passkey gate for revealing vault secrets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { PasswordManager } from '../packages/persistence/src/PasswordManager.js';
import { PasskeyService } from '../packages/shared-ui/src/services/passkeyService.js';
import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

class MemoryAdapter {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async set(key, val) { this.map.set(key, val); }
  async delete(key) { this.map.delete(key); }
}

async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/* ------------------------- PasswordManager v2 ------------------------- */

test('Vault v2: passwords are AES-GCM encrypted at rest, never plaintext or XOR', async () => {
  const storage = new MemoryAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });

  const result = await pm.saveCredential({
    origin: 'https://example.com',
    username: 'ada',
    password: 'Hunter2!Secret'
  });
  assert.equal(result.success, true);

  const raw = await storage.get('yayra-passwords-vault');
  assert.equal(raw.length, 1);
  assert.ok(raw[0].enc && raw[0].enc.v === 2 && raw[0].enc.iv && raw[0].enc.ct, 'entry must carry AES-GCM envelope');
  assert.equal(raw[0].encryptedPassword, undefined, 'legacy XOR field must not be written');
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes('Hunter2!Secret'), 'plaintext must never hit storage');

  // Decrypts back through the public API.
  const creds = await pm.getAllCredentials();
  assert.equal(creds[0].password, 'Hunter2!Secret');

  // A second manager over the same storage uses the persisted key material.
  const pm2 = new PasswordManager({ storageAdapter: storage });
  const creds2 = await pm2.getAllCredentials();
  assert.equal(creds2[0].password, 'Hunter2!Secret');
});

test('Vault v2: legacy XOR (v1) entries still decrypt and re-encrypt on update', async () => {
  const storage = new MemoryAdapter();
  // Craft a legacy v1 entry exactly like the old implementation wrote it.
  const salt = 'yayra-sec-salt-88';
  const legacyEncrypt = (plain) => {
    let out = '';
    for (let i = 0; i < plain.length; i++) {
      out += String.fromCharCode(plain.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
    }
    return Buffer.from(out, 'utf8').toString('base64');
  };
  await storage.set('yayra-passwords-vault', [{
    id: 'pwd-legacy-1',
    origin: 'https://old.example.com',
    username: 'legacy-user',
    encryptedPassword: legacyEncrypt('old-secret-42'),
    title: 'Old',
    createdAt: 1,
    lastUsedAt: 1
  }]);

  const pm = new PasswordManager({ storageAdapter: storage });
  const creds = await pm.getAllCredentials();
  assert.equal(creds.length, 1);
  assert.equal(creds[0].password, 'old-secret-42');

  // Updating the password upgrades the entry to the AES-GCM envelope.
  await pm.updateCredential('pwd-legacy-1', { password: 'new-secret-43' });
  const raw = await storage.get('yayra-passwords-vault');
  assert.ok(raw[0].enc && raw[0].enc.v === 2);
  assert.equal(raw[0].encryptedPassword, undefined);
  assert.equal((await pm.getAllCredentials())[0].password, 'new-secret-43');
});

test('Vault keys: API keys/tokens live in the same encrypted vault but separate section', async () => {
  const storage = new MemoryAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });

  await pm.saveCredential({ origin: 'https://site.dev', username: 'u', password: 'p' });
  const keyResult = await pm.saveKey({ label: 'OpenAI API key', keyName: 'prod', secret: 'sk-123-top-secret' });
  assert.equal(keyResult.success, true);

  const passwords = await pm.getAllCredentials();
  const keys = await pm.getAllKeys();
  assert.equal(passwords.length, 1);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].password, 'sk-123-top-secret');
  assert.equal(keys[0].kind, 'key');

  // Keys are AES-GCM encrypted at rest too.
  const raw = await storage.get('yayra-passwords-vault');
  assert.ok(!JSON.stringify(raw).includes('sk-123-top-secret'));
});

test('shouldOfferToSave: private, disabled, never-saved and unchanged logins never prompt', async () => {
  const storage = new MemoryAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });
  const base = { origin: 'https://github.com', username: 'octo', password: 'pw-1' };

  assert.equal(await pm.shouldOfferToSave({ ...base, isPrivate: true }), false, 'private tabs never prompt');
  assert.equal(await pm.shouldOfferToSave(base), true, 'fresh credential prompts');

  await pm.updateConfig({ savePasswordsEnabled: false });
  assert.equal(await pm.shouldOfferToSave(base), false, 'disabled saving never prompts');
  await pm.updateConfig({ savePasswordsEnabled: true });

  await pm.addNeverSaveOrigin('https://github.com');
  assert.equal(await pm.shouldOfferToSave(base), false, 'never-save origin never prompts');
  await pm.removeNeverSaveOrigin('https://github.com');

  await pm.saveCredential(base);
  assert.equal(await pm.shouldOfferToSave(base), false, 'identical stored credential never re-prompts');
  assert.equal(await pm.shouldOfferToSave({ ...base, password: 'pw-2' }), true, 'changed password prompts to update');
});

/* --------------------------- PasskeyService --------------------------- */

function makeFakeWebAuthn({ failCreate = null, failGet = null } = {}) {
  const calls = { create: [], get: [] };
  const rawId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  globalThis.PublicKeyCredential = globalThis.PublicKeyCredential || function PublicKeyCredential() {};
  return {
    calls,
    api: {
      async create(options) {
        calls.create.push(options);
        if (failCreate) { const e = new Error('nope'); e.name = failCreate; throw e; }
        return { rawId, id: 'cred-1', type: 'public-key' };
      },
      async get(options) {
        calls.get.push(options);
        if (failGet) { const e = new Error('nope'); e.name = failGet; throw e; }
        return { rawId, id: 'cred-1', type: 'public-key' };
      }
    }
  };
}

test('PasskeyService: register -> verify -> remove with user verification required', async () => {
  const storage = new MemoryAdapter();
  const fake = makeFakeWebAuthn();
  const svc = new PasskeyService({ storage, credentialsApi: fake.api, rpName: 'Yayra', rpId: 'yayra.app' });

  assert.equal(svc.isSupported(), true);
  assert.equal(await svc.getRegisteredPasskey(), null);

  const reg = await svc.registerPasskey({ accountLabel: 'ada@example.com' });
  assert.equal(reg.success, true);
  assert.ok(reg.passkey.credentialId, 'credential id stored');
  assert.equal(reg.passkey.accountLabel, 'ada@example.com');

  // The WebAuthn ceremony demanded user verification (biometrics/PIN).
  const createOpts = fake.calls.create[0].publicKey;
  assert.equal(createOpts.authenticatorSelection.userVerification, 'required');
  assert.equal(createOpts.rp.id, 'yayra.app');

  const verify = await svc.verifyPasskey();
  assert.equal(verify.success, true);
  const getOpts = fake.calls.get[0].publicKey;
  assert.equal(getOpts.userVerification, 'required');
  assert.equal(getOpts.allowCredentials.length, 1, 'verification pinned to the registered credential');

  const stored = await svc.getRegisteredPasskey();
  assert.ok(stored.lastVerifiedAt, 'successful ceremony recorded');

  await svc.removePasskey();
  assert.equal(await svc.getRegisteredPasskey(), null);
});

test('PasskeyService: honest failure reasons (decline, unsupported, nothing registered)', async () => {
  const storage = new MemoryAdapter();
  const declined = makeFakeWebAuthn({ failCreate: 'NotAllowedError' });
  const svc = new PasskeyService({ storage, credentialsApi: declined.api });
  const reg = await svc.registerPasskey({});
  assert.equal(reg.success, false);
  assert.equal(reg.reason, 'user-declined-or-timeout');

  const verifyNothing = await svc.verifyPasskey();
  assert.equal(verifyNothing.success, false);
  assert.equal(verifyNothing.reason, 'no-passkey-registered');

  const unsupported = new PasskeyService({ storage, credentialsApi: null });
  // In node there is no navigator.credentials - unsupported must be clean.
  if (!unsupported.isSupported()) {
    const r = await unsupported.registerPasskey({});
    assert.equal(r.reason, 'passkeys-unsupported');
  }
});

/* ------------------- BrowserShell: remember & autofill ------------------- */

function installFakeWebviewBridge() {
  const fills = [];
  window.yayra = window.yayra || {};
  window.yayra.webview = {
    ensure: async () => ({}),
    setBounds: async () => ({}),
    setVisible: async () => ({}),
    goBack: async () => ({}),
    goForward: async () => ({}),
    reload: async () => ({}),
    stop: async () => ({}),
    destroy: async () => ({}),
    fillCredentials: async (tabId, creds) => { fills.push({ tabId, ...creds }); return { filled: true }; },
    onEvent: () => () => {}
  };
  return {
    fills,
    uninstall: () => { delete window.yayra.webview; }
  };
}

test('Remember prompt: captured login shows Save-password bar; Save stores it encrypted', async () => {
  const fakeBridge = installFakeWebviewBridge();
  try {
    const container = document.createElement('div');
    const storage = new MemoryAdapter();
    const pm = new PasswordManager({ storageAdapter: storage });
    const shell = new BrowserShell({ container, isMobile: false, passwordManager: pm, storageAdapter: storage });
    await shell.initialize();
    shell.render(container);

    const tab = shell.getActiveTab();
    tab.url = 'https://accounts.site.dev/login';

    await shell.handleAutofillCaptured(tab, {
      url: 'https://accounts.site.dev/login',
      username: 'ada@site.dev',
      password: 'S3cret!'
    });

    assert.ok(shell.state.pendingPasswordSave, 'capture must stage a pending save');
    assert.equal(shell.state.pendingPasswordSave.origin, 'https://accounts.site.dev');
    shell.render(container);
    const bar = container.querySelector('.fb-password-save-bar');
    assert.ok(bar, 'Save password? bar must render');
    assert.ok(bar.textContent.includes('ada@site.dev'));
    assert.ok(shell.hasBlockingOverlay(), 'bar must count as blocking overlay so it sits above the native page');

    bar.querySelector('.fb-pwd-save-yes').click();
    assert.ok(await waitFor(async () => (await pm.getCredentialsForOrigin('https://accounts.site.dev')).length === 1));
    assert.equal(shell.state.pendingPasswordSave, null);
    const saved = await pm.getCredentialsForOrigin('https://accounts.site.dev');
    assert.equal(saved[0].username, 'ada@site.dev');
    assert.equal(saved[0].password, 'S3cret!');

    // Same unchanged login never re-prompts (Chrome behaviour).
    await shell.handleAutofillCaptured(tab, {
      url: 'https://accounts.site.dev/login',
      username: 'ada@site.dev',
      password: 'S3cret!'
    });
    assert.equal(shell.state.pendingPasswordSave, null, 'identical credential must not re-prompt');
  } finally {
    fakeBridge.uninstall();
  }
});

test('Remember prompt: Never for this site is honoured; private tabs never prompt', async () => {
  const fakeBridge = installFakeWebviewBridge();
  try {
    const container = document.createElement('div');
    const storage = new MemoryAdapter();
    const pm = new PasswordManager({ storageAdapter: storage });
    const shell = new BrowserShell({ container, isMobile: false, passwordManager: pm, storageAdapter: storage });
    await shell.initialize();
    shell.render(container);
    const tab = shell.getActiveTab();

    await shell.handleAutofillCaptured(tab, { url: 'https://nope.dev/login', username: 'u', password: 'p' });
    assert.ok(shell.state.pendingPasswordSave);
    await shell.resolvePendingPasswordSave('never');
    assert.ok(await waitFor(async () => (await pm.getConfig()).neverSaveOrigins.includes('https://nope.dev')));

    await shell.handleAutofillCaptured(tab, { url: 'https://nope.dev/login', username: 'u', password: 'p' });
    assert.equal(shell.state.pendingPasswordSave, null, 'never-save origin must not prompt again');

    const privateTab = { ...tab, id: 'tab-priv', isPrivate: true };
    await shell.handleAutofillCaptured(privateTab, { url: 'https://other.dev/login', username: 'u', password: 'p' });
    assert.equal(shell.state.pendingPasswordSave, null, 'private tabs never prompt');
  } finally {
    fakeBridge.uninstall();
  }
});

test('Autofill: detected login form gets saved credentials filled through the native bridge', async () => {
  const fakeBridge = installFakeWebviewBridge();
  try {
    const container = document.createElement('div');
    const storage = new MemoryAdapter();
    const pm = new PasswordManager({ storageAdapter: storage });
    await pm.saveCredential({ origin: 'https://fill.dev', username: 'ada', password: 'fill-me-1' });

    const shell = new BrowserShell({ container, isMobile: false, passwordManager: pm, storageAdapter: storage });
    await shell.initialize();
    shell.render(container);
    const tab = shell.getActiveTab();
    tab.url = 'https://fill.dev/login';

    await shell.handleAutofillFormDetected(tab, { url: 'https://fill.dev/login' });
    assert.equal(fakeBridge.fills.length, 1, 'credentials must be pushed to the page');
    assert.equal(fakeBridge.fills[0].username, 'ada');
    assert.equal(fakeBridge.fills[0].password, 'fill-me-1');

    // Guard: the same tab+origin is not refilled in a loop.
    await shell.handleAutofillFormDetected(tab, { url: 'https://fill.dev/login' });
    assert.equal(fakeBridge.fills.length, 1);

    // Autofill disabled => nothing is pushed.
    await pm.updateConfig({ autofillEnabled: false });
    await shell.refreshVaultState();
    shell._autofilledFor.clear();
    await shell.handleAutofillFormDetected(tab, { url: 'https://fill.dev/login' });
    assert.equal(fakeBridge.fills.length, 1, 'disabled autofill must not fill');
  } finally {
    fakeBridge.uninstall();
  }
});

test('Website passkeys: a genuine native lifecycle request gets an immediate omnibox indicator and deterministic cleanup', async () => {
  const fakeBridge = installFakeWebviewBridge();
  try {
    const container = document.createElement('div');
    const storage = new MemoryAdapter();
    const pm = new PasswordManager({ storageAdapter: storage });
    const shell = new BrowserShell({ container, isMobile: false, passwordManager: pm, storageAdapter: storage });
    await shell.initialize();
    shell.render(container);
    const tab = shell.getActiveTab();
    tab.url = 'https://login.github.com/security';

    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'webauthn-request',
      phase: 'started',
      requestId: 'yayra-wa-shell-1',
      action: 'create',
      rpId: 'github.com',
      conditional: false,
      attachment: 'platform'
    });
    shell.render(container);
    const indicator = container.querySelector('.fb-site-passkey-indicator');
    assert.ok(indicator, 'active site ceremony is visible in browser chrome without a fallback delay');
    assert.match(indicator.textContent, /Creating passkey/i);
    assert.match(indicator.getAttribute('title'), /github\.com/);

    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'webauthn-request',
      phase: 'settled',
      requestId: 'yayra-wa-shell-1',
      action: 'create',
      rpId: 'github.com',
      success: false,
      errorName: 'AbortError'
    });
    shell.render(container);
    assert.equal(container.querySelector('.fb-site-passkey-indicator'), null, 'cancel/settle always clears the active indicator');
    assert.equal(tab.sitePasskeyRequest, undefined);

    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'webauthn-request',
      phase: 'started',
      requestId: 'yayra-wa-conditional-1',
      action: 'get',
      rpId: 'github.com',
      conditional: true
    });
    shell.render(container);
    assert.equal(container.querySelector('.fb-site-passkey-indicator'), null, 'passive conditional mediation remains quiet until account interaction');
  } finally {
    fakeBridge.uninstall();
  }
});

test('Passkey gate: vault reveal requires a successful ceremony when enabled', async () => {
  const container = document.createElement('div');
  const storage = new MemoryAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });
  await pm.saveCredential({ origin: 'https://locked.dev', username: 'ada', password: 'locked-pw' });
  await pm.updateConfig({ requirePasskeyToReveal: true });

  const fake = makeFakeWebAuthn();
  const passkeyService = new PasskeyService({ storage, credentialsApi: fake.api });
  await passkeyService.registerPasskey({ accountLabel: 'ada' });

  const shell = new BrowserShell({
    container, isMobile: false, passwordManager: pm, storageAdapter: storage, passkeyService
  });
  await shell.initialize();
  assert.ok(shell.state.passkeyInfo, 'registered passkey visible to the shell');

  // Gate closed: unlock requires the WebAuthn ceremony to succeed.
  shell._vaultUnlockedAt = 0;
  assert.equal(await shell.unlockVaultIfNeeded(), true, 'successful ceremony unlocks');
  assert.equal(fake.calls.get.length, 1, 'a real verification ran');

  // Within the 5-minute window no second ceremony is needed.
  assert.equal(await shell.unlockVaultIfNeeded(), true);
  assert.equal(fake.calls.get.length, 1, 'unlock window honoured');

  // A declining authenticator keeps the vault locked.
  const declining = makeFakeWebAuthn({ failGet: 'NotAllowedError' });
  const decliningService = new PasskeyService({ storage, credentialsApi: declining.api });
  const shell2 = new BrowserShell({
    container: document.createElement('div'), isMobile: false,
    passwordManager: pm, storageAdapter: storage, passkeyService: decliningService
  });
  await shell2.initialize();
  shell2._vaultUnlockedAt = 0;
  assert.equal(await shell2.unlockVaultIfNeeded(), false, 'declined ceremony keeps secrets hidden');
});

test('Vault page: Passwords and Keys sections render with counts, vault-unlock passkey, and separate website-passkey status', async (t) => {
  const fakeBridge = installFakeWebviewBridge();
  t.after(() => fakeBridge.uninstall());
  const container = document.createElement('div');
  const storage = new MemoryAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });
  await pm.saveCredential({ origin: 'https://a.dev', username: 'u1', password: 'p1' });
  await pm.saveKey({ label: 'Deploy token', secret: 'tok-1' });

  const shell = new BrowserShell({ container, isMobile: false, passwordManager: pm, storageAdapter: storage });
  await shell.initialize();
  shell.render(container);
  shell.navigateActiveTab('yayra://passwords');

  assert.ok(container.querySelector('.fb-vault-security-card'), 'Yayra vault-unlock passkey card renders');
  const sitePasskeys = container.querySelector('.fb-site-passkeys-card');
  assert.ok(sitePasskeys, 'website WebAuthn support is explained separately from vault unlock');
  assert.match(sitePasskeys.textContent, /Website passkeys/);
  assert.match(sitePasskeys.textContent, /Always active/);
  assert.match(sitePasskeys.textContent, /system-browser fallback/);
  const tabs = container.querySelectorAll('.fb-vault-tab');
  assert.equal(tabs.length, 2);
  assert.ok(container.querySelector('.fb-pwd-row'), 'password row renders');

  // Switch to Keys & Tokens section.
  tabs[1].click();
  const keyRow = container.querySelector('.fb-key-row');
  assert.ok(keyRow, 'key row renders in keys section');
  assert.ok(keyRow.textContent.includes('Deploy token'));
});
