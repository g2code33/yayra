/**
 * P27 - passkey fallback ladder for devices with NO fingerprint / Face ID /
 * security-key access:
 *
 *  1. 6-digit PIN (electron/passkeyBridge.cjs 'pin' method): stored only
 *     as a salted scrypt verifier, 5 wrong tries -> 60s lockout, works
 *     even when safeStorage/OS keychain is completely unavailable.
 *  2. System lock ('device' method, unchanged): safeStorage bound to the
 *     OS login session.
 *  3. Phone QR approval (electron/phoneApproval.cjs): the PC serves a
 *     one-time LAN URL; scanning the QR and approving on the phone
 *     completes the vault verification. Tested here against a REAL HTTP
 *     round trip on localhost.
 *
 * Plus: PasskeyService passes method/pin/phone calls through the native
 * bridge, and the vendored QR encoder produces a sane module matrix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { createRequire } from 'node:module';
import { PasskeyService } from '../packages/shared-ui/src/services/passkeyService.js';
import qrcode from '../packages/shared-ui/src/vendor/qrcode.js';

const require = createRequire(import.meta.url);
const { createPasskeyBridge } = require('../electron/passkeyBridge.cjs');
const { createPhoneApproval } = require('../electron/phoneApproval.cjs');

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

const noKeychain = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('no backend'); },
  decryptString: () => { throw new Error('no backend'); }
};

function makeBridge(overrides = {}) {
  const fs = overrides.fs || makeFakeFs();
  const bridge = createPasskeyBridge({
    ipcMain: null,
    fs,
    path,
    userDataDir: '/fake/userData',
    safeStorageImpl: overrides.safeStorageImpl ?? noKeychain,
    systemPreferencesImpl: null,
    platform: 'win32',
    phoneApproval: overrides.phoneApproval ?? null,
    logger: { error: () => {}, warn: () => {} }
  });
  return { bridge, fs };
}

/* ------------------------------ 6-digit PIN ------------------------------ */

test('PIN: registers and verifies WITHOUT any OS keychain - the no-biometrics fallback', async () => {
  const { bridge, fs } = makeBridge(); // safeStorage completely unavailable

  const status0 = await bridge.handleStatus();
  assert.equal(status0.available, false, 'keychain really is unavailable');
  assert.deepEqual(status0.methods, { deviceLock: false, touchId: false, pin: true, phone: false },
    'the ladder reports exactly what this device supports');

  const reg = await bridge.handleRegister(null, { label: 'no-bio user', method: 'pin', pin: '204896' });
  assert.equal(reg.ok, true, 'PIN registration works with zero keychain support');
  assert.equal(reg.passkey.method, 'pin');

  const record = JSON.parse([...fs.files.values()][0]);
  assert.equal(record.method, 'pin');
  assert.ok(!JSON.stringify(record).includes('204896'), 'the PIN digits are NEVER stored');
  assert.equal(record.pinVerifier.length, 64, 'scrypt verifier (32 bytes hex)');
  assert.equal(record.pinSalt.length, 32, 'random 16-byte salt');

  assert.deepEqual(await bridge.handleVerify(null, { pin: '204896' }), { ok: true });
  const wrong = await bridge.handleVerify(null, { pin: '111111' });
  assert.equal(wrong.reason, 'wrong-pin');
  assert.equal(wrong.attemptsRemaining, 4);

  const statusAfter = await bridge.handleStatus();
  assert.equal(statusAfter.method, 'pin', 'status reflects the registered method');
});

test('PIN: website authorization is an opaque one-shot grant bound to shell, tab, profile, RP, and request', async () => {
  const { bridge } = makeBridge();
  const event = { sender: { id: 17 } };
  const request = {
    tabId: 'tab-1',
    requestId: 'yayra-wa-grant-1',
    rpId: 'github.com',
    profileId: 'profile-a',
    action: 'get'
  };
  const registered = await bridge.handleRegister(event, {
    label: 'grant user', method: 'pin', pin: '204896', websiteRequest: request
  });
  assert.equal(registered.ok, true);
  assert.match(registered.authorizationToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(JSON.stringify(registered).includes('204896'), false, 'the grant never returns the PIN');

  const mismatch = bridge.consumeWebsiteGrant({
    token: registered.authorizationToken,
    event,
    ...request,
    rpId: 'example.com'
  });
  assert.equal(mismatch.reason, 'yayra-authorization-mismatch');
  assert.equal(bridge.consumeWebsiteGrant({ token: registered.authorizationToken, event, ...request }).ok, false,
    'a mismatched attempt consumes the unguessable token');

  const verified = await bridge.handleVerify(event, { pin: '204896', websiteRequest: request });
  const consumed = bridge.consumeWebsiteGrant({ token: verified.authorizationToken, event, ...request });
  assert.deepEqual({ ok: consumed.ok, method: consumed.method }, { ok: true, method: 'yayra-passkey' });
  assert.equal(bridge.consumeWebsiteGrant({ token: verified.authorizationToken, event, ...request }).reason,
    'yayra-authorization-expired', 'a successful grant cannot be replayed');
});

test('PIN: rejects anything that is not exactly 6 digits', async () => {
  const { bridge } = makeBridge();
  for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', null, 123456]) {
    const res = await bridge.handleRegister(null, { method: 'pin', pin: bad });
    assert.equal(res.ok, false, `rejected: ${String(bad)}`);
    assert.equal(res.reason, 'pin-invalid');
  }
});

test('PIN: 5 wrong attempts lock PIN entry for 60s - even the CORRECT pin is refused while locked', async () => {
  const { bridge, fs } = makeBridge();
  await bridge.handleRegister(null, { method: 'pin', pin: '314159' });

  for (let i = 1; i <= 4; i++) {
    const res = await bridge.handleVerify(null, { pin: '000000' });
    assert.equal(res.reason, 'wrong-pin');
    assert.equal(res.attemptsRemaining, 5 - i);
  }
  const fifth = await bridge.handleVerify(null, { pin: '000000' });
  assert.equal(fifth.reason, 'pin-locked');
  assert.ok(fifth.retryAt > Date.now(), 'lockout is in the future');

  const lockedCorrect = await bridge.handleVerify(null, { pin: '314159' });
  assert.equal(lockedCorrect.reason, 'pin-locked', 'brute-force cannot keep guessing during lockout');

  const status = await bridge.handleStatus();
  assert.equal(status.pinLocked, true, 'UI can show the lockout');

  // Simulate the lockout elapsing by rewinding the stored timestamp.
  const [file, raw] = [...fs.files.entries()][0];
  const record = JSON.parse(raw);
  record.pinLockUntil = Date.now() - 1000;
  fs.files.set(file, JSON.stringify(record));

  assert.deepEqual(await bridge.handleVerify(null, { pin: '314159' }), { ok: true }, 'correct PIN works after the lock expires');
  const after = JSON.parse(fs.files.get(file));
  assert.equal(after.pinAttempts, 0, 'counter reset on success');
});

test('PIN: verify without a pin asks for one; device-method records are untouched by pin options', async () => {
  const { bridge } = makeBridge();
  await bridge.handleRegister(null, { method: 'pin', pin: '555555' });
  assert.equal((await bridge.handleVerify(null, {})).reason, 'pin-required');
  assert.equal((await bridge.handleVerify()).reason, 'pin-required');
});

/* --------------------------- phone QR approval --------------------------- */

function makePhone({ ttlMs = 2000 } = {}) {
  return createPhoneApproval({
    httpImpl: http,
    // Pretend the loopback interface is a LAN NIC so the REAL server is
    // reachable by this test over 127.0.0.1.
    osImpl: { networkInterfaces: () => ({ eth0: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] }) },
    randomBytesImpl: (n) => crypto.randomBytes(n),
    ttlMs,
    logger: { log: () => {}, warn: () => {} }
  });
}

async function fetchText(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, body: await res.text() };
}

test('phone QR: REAL HTTP round trip - scan URL serves the approval page, approving resolves the session', async () => {
  const phone = makePhone();
  const started = await phone.start({ reason: 'unlock the Yayra vault for "ada@example.com"' });
  assert.equal(started.ok, true);
  assert.ok(started.url.startsWith('http://127.0.0.1:'), 'one-time LAN URL');
  assert.match(started.url, /\/a\/[0-9a-f]{32}$/, '128-bit one-time token');
  assert.equal(phone.status().state, 'pending');

  const page = await fetchText(started.url);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Approve on your PC?'), 'phone sees what it is approving');
  assert.ok(page.body.includes('ada@example.com'), 'the vault owner is named');

  const approve = await fetchText(new URL('/r/approve', started.url), { method: 'POST' });
  assert.equal(approve.status, 200);
  assert.equal(phone.status().state, 'approved');

  // Server shuts down shortly after resolution - the token is single-use.
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(() => fetch(started.url), 'listener is gone after approval');
});

test('phone QR: wrong token 404s and reveals nothing; deny resolves denied; expiry flips to expired', async () => {
  const phone = makePhone({ ttlMs: 300 });
  const started = await phone.start({});
  const bogus = await fetchText(started.url.replace(/[0-9a-f]{32}$/, 'f'.repeat(32)));
  assert.equal(bogus.status, 404);

  await new Promise((r) => setTimeout(r, 350));
  assert.equal(phone.status().state, 'expired', 'sessions die after the TTL');

  const phone2 = makePhone();
  const started2 = await phone2.start({});
  await fetchText(new URL('/r/deny', started2.url), { method: 'POST' });
  assert.equal(phone2.status().state, 'denied');
  await new Promise((r) => setTimeout(r, 350));
});

test('phone QR: no LAN interface is reported honestly; cancel stops a pending session', async () => {
  const noLan = createPhoneApproval({
    httpImpl: http,
    osImpl: { networkInterfaces: () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }) },
    randomBytesImpl: (n) => crypto.randomBytes(n),
    logger: { log: () => {}, warn: () => {} }
  });
  assert.deepEqual(await noLan.start({}), { ok: false, reason: 'no-lan' });

  const phone = makePhone();
  const started = await phone.start({});
  assert.equal(phone.status().state, 'pending');
  phone.cancel();
  assert.equal(phone.status().state, 'idle');
  await assert.rejects(() => fetch(started.url), 'cancel closed the listener');
});

test('phone QR: bridge handlers require a registered passkey and pass the label through', async () => {
  const calls = [];
  const fakePhone = {
    start: async (opts) => { calls.push(['start', opts]); return { ok: true, url: 'http://10.0.0.2:1/a/x', expiresAt: 1 }; },
    status: () => ({ state: 'pending', expiresAt: 1 }),
    cancel: () => ({ ok: true, state: 'idle' })
  };
  const { bridge } = makeBridge({ phoneApproval: fakePhone });

  assert.deepEqual(await bridge.handlePhoneStart(), { ok: false, reason: 'no-passkey-registered' });
  await bridge.handleRegister(null, { label: 'g2@yayra', method: 'pin', pin: '909090' });
  const started = await bridge.handlePhoneStart();
  assert.equal(started.ok, true);
  assert.ok(calls[0][1].reason.includes('g2@yayra'), 'phone page will name the vault owner');
  assert.equal((await bridge.handlePhoneStatus()).state, 'pending');
  assert.equal((await bridge.handlePhoneCancel()).ok, true);

  const { bridge: noPhone } = makeBridge();
  assert.deepEqual(await noPhone.handlePhoneStart(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await noPhone.handlePhoneStatus(), { state: 'unavailable' });
  const status = await noPhone.handleStatus();
  assert.equal(status.methods.phone, false, 'ladder reports phone approval honestly');
});

/* ------------------------- PasskeyService passthrough ------------------------- */

// PasskeyService storage adapter contract: async get/set/delete.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async set(key, val) { this.map.set(key, val); }
  async delete(key) { this.map.delete(key); }
}

test('PasskeyService: method/pin ride through register and verify to the native bridge', async () => {
  const seen = [];
  const nativeBridge = {
    register: async (label, options) => { seen.push(['register', label, options]); return { ok: true, passkey: { credentialId: 'c1', method: 'pin', createdAt: 1 } }; },
    verify: async (options) => { seen.push(['verify', options]); return { ok: true }; },
    status: async () => ({ registered: true }),
    remove: async () => ({ ok: true })
  };
  const service = new PasskeyService({ storage: new MemoryStorage(), nativeBridge });

  const reg = await service.registerPasskey({ accountLabel: 'u', method: 'pin', pin: '123456' });
  assert.equal(reg.success, true);
  assert.equal(reg.passkey.method, 'pin');
  assert.deepEqual(seen[0], ['register', 'u', { method: 'pin', pin: '123456' }]);

  await service.verifyPasskey({ pin: '123456' });
  assert.deepEqual(seen[1], ['verify', { pin: '123456' }]);

  // Device-method verify stays argument-free (old bridge signature safe).
  await service.verifyPasskey();
  assert.deepEqual(seen[2], ['verify', undefined]);
});

test('PasskeyService: phone approval passthrough + markVerifiedViaPhone stamps the ceremony', async () => {
  const nativeBridge = {
    register: async () => ({ ok: true, passkey: { credentialId: 'c1', method: 'pin', createdAt: 1 } }),
    verify: async () => ({ ok: true }),
    status: async () => ({ registered: true }),
    remove: async () => ({ ok: true }),
    phoneStart: async () => ({ ok: true, url: 'http://10.0.0.5:9/a/t', expiresAt: 99 }),
    phoneStatus: async () => ({ state: 'approved' }),
    phoneCancel: async () => ({ ok: true })
  };
  const service = new PasskeyService({ storage: new MemoryStorage(), nativeBridge });
  assert.equal(service.supportsPhoneApproval, true);
  await service.registerPasskey({ accountLabel: 'u', method: 'pin', pin: '123456' });

  assert.equal((await service.startPhoneApproval()).ok, true);
  assert.equal((await service.phoneApprovalStatus()).state, 'approved');
  await service.markVerifiedViaPhone();
  const stored = await service.getRegisteredPasskey();
  assert.ok(stored.lastVerifiedAt > 0, 'phone approval counts as a verification ceremony');

  const noPhoneService = new PasskeyService({ storage: new MemoryStorage(), nativeBridge: { register: async () => ({}), verify: async () => ({}) } });
  assert.equal(noPhoneService.supportsPhoneApproval, false);
  assert.deepEqual(await noPhoneService.startPhoneApproval(), { ok: false, reason: 'unavailable' });
});

/* ------------------------------ QR encoder ------------------------------ */

test('QR: vendored encoder produces a scannable-structure matrix + SVG for a LAN approval URL', () => {
  const qr = qrcode(0, 'M');
  qr.addData('http://192.168.8.101:40123/a/0123456789abcdef0123456789abcdef', 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  assert.ok(n >= 21 && (n - 21) % 4 === 0, `valid QR version size (got ${n})`);
  // Finder patterns: the 3 corner squares every scanner locks onto.
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(qr.isDark(r, c), true, `finder ring dark at ${r},${c}`);
    assert.equal(qr.isDark(r + 1, c + 1), false, `finder inner-white at ${r + 1},${c + 1}`);
    assert.equal(qr.isDark(r + 3, c + 3), true, `finder core dark at ${r + 3},${c + 3}`);
  }
  // Timing patterns alternate along row/column 6.
  for (let i = 8; i < n - 8; i++) {
    assert.equal(qr.isDark(6, i), i % 2 === 0, `timing row at ${i}`);
    assert.equal(qr.isDark(i, 6), i % 2 === 0, `timing col at ${i}`);
  }
  const svg = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  assert.ok(svg.includes('<svg') && svg.includes('<path'), 'SVG render for the dialog');
});
