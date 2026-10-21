'use strict';

/**
 * Device passkey for the Electron desktop shell.
 *
 * WHY THIS EXISTS: Yayra's desktop UI is served from the custom
 * `yayra://app` scheme. Chromium's WebAuthn implementation only mints
 * credentials for real http(s) origins with a valid domain, so
 * navigator.credentials.create() inside the shell throws SecurityError -
 * which users saw as "passkeys require a secure (HTTPS) context" even
 * though the app itself is perfectly trusted. Web/PWA builds (real
 * https origin) keep genuine WebAuthn passkeys.
 *
 * WHAT THIS IS (honest scope): an OS-keychain-bound device credential.
 * A random secret is generated at registration and encrypted with
 * Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux). Verifying = decrypting that secret, which
 * only the logged-in OS user's session can do; on macOS a REAL Touch ID
 * prompt guards the ceremony when the hardware supports it. It proves
 * "the OS user who registered this is present on this device" - the
 * right bar for unlocking a local vault.
 *
 * WHAT IT IS NOT: a cross-device synced passkey or (outside macOS) a
 * biometric prompt. The UI copy reflects that honestly.
 *
 * FALLBACK LADDER for devices with no biometrics / no usable keychain /
 * no security key:
 *  1. 'device' method - safeStorage bound to the OS login ("system lock":
 *     unlocking the PC session IS the authentication), + Touch ID where
 *     the hardware has it.
 *  2. 'pin' method - a user-created 6-digit PIN, stored only as a
 *     scrypt verifier (salted, memory-hard) with attempt lockout:
 *     5 wrong tries locks PIN entry for 60 seconds.
 *  3. Phone QR approval (electron/phoneApproval.cjs) - scan a one-time
 *     QR with any phone on the same network and approve there.
 */

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FILE_NAME = 'yayra-device-passkey.json';
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 60 * 1000;
const SYSTEM_AUTH_TIMEOUT_MS = 90 * 1000;
// A successful Yayra-account verification can authorize exactly one pending
// website WebAuthn ceremony. The opaque grant never contains a PIN, private
// key or challenge, is bound to the requesting shell WebContents + tab/RP,
// and is consumed once in the main process.
const WEBSITE_GRANT_TTL_MS = 30 * 1000;
const MAX_WEBSITE_GRANTS = 32;

function createPasskeyBridge({
  ipcMain,
  fs,
  path,
  userDataDir,
  safeStorageImpl,
  systemPreferencesImpl = null,
  platform = process.platform,
  randomBytesImpl = (n) => crypto.randomBytes(n),
  // Real system-password confirmation on Linux (PolicyKit GUI prompt).
  spawnImpl = spawn,
  // Phone QR approval session manager (electron/phoneApproval.cjs).
  // Optional: without it the phone option reports itself unavailable.
  phoneApproval = null,
  logger = console
}) {
  const filePath = path.join(userDataDir, FILE_NAME);
  const websiteGrants = new Map();

  function normalizeWebsiteRequest(value) {
    if (!value || typeof value !== 'object') return null;
    const tabId = String(value.tabId || '').slice(0, 128);
    const requestId = String(value.requestId || '').slice(0, 160);
    const rpId = String(value.rpId || '').trim().toLowerCase().slice(0, 253);
    const profileId = String(value.profileId || 'default').slice(0, 128);
    const action = value.action === 'create' ? 'create' : value.action === 'get' ? 'get' : '';
    if (!/^[a-z0-9_-]+$/i.test(tabId)
      || !/^yayra-wa-[a-z0-9-]+$/i.test(requestId)
      || !/^[a-z0-9.-]+$/i.test(rpId)
      || !/^[a-z0-9_-]+$/i.test(profileId)
      || !action) return null;
    return { tabId, requestId, rpId, profileId, action };
  }

  function pruneWebsiteGrants() {
    const now = Date.now();
    for (const [token, grant] of websiteGrants) {
      if (!grant || grant.expiresAt <= now) websiteGrants.delete(token);
    }
    while (websiteGrants.size >= MAX_WEBSITE_GRANTS) {
      const oldest = websiteGrants.keys().next().value;
      if (!oldest) break;
      websiteGrants.delete(oldest);
    }
  }

  function withWebsiteGrant(event, websiteRequest, result) {
    if (!result?.ok) return result;
    const request = normalizeWebsiteRequest(websiteRequest);
    const senderId = Number(event?.sender?.id);
    if (!request || !Number.isSafeInteger(senderId) || senderId < 0) return result;
    pruneWebsiteGrants();
    const token = Buffer.from(randomBytesImpl(32)).toString('base64url');
    const expiresAt = Date.now() + WEBSITE_GRANT_TTL_MS;
    websiteGrants.set(token, { ...request, senderId, expiresAt });
    return { ...result, authorizationToken: token, authorizationExpiresAt: expiresAt };
  }

  /**
   * Main-process-only, one-shot grant consumption. Supplying a token on the
   * website continuation IPC is not enough: every bound field must match the
   * real pending request owned by the same shell WebContents.
   */
  function consumeWebsiteGrant({ token, event, tabId, requestId, rpId, profileId, action } = {}) {
    pruneWebsiteGrants();
    const safeToken = typeof token === 'string' && token.length <= 128 ? token : '';
    const grant = safeToken ? websiteGrants.get(safeToken) : null;
    if (safeToken) websiteGrants.delete(safeToken); // one attempt, success or failure
    if (!grant || grant.expiresAt <= Date.now()) return { ok: false, reason: 'yayra-authorization-expired' };
    const actual = normalizeWebsiteRequest({ tabId, requestId, rpId, profileId, action });
    const senderId = Number(event?.sender?.id);
    if (!actual
      || !Number.isSafeInteger(senderId)
      || grant.senderId !== senderId
      || grant.tabId !== actual.tabId
      || grant.requestId !== actual.requestId
      || grant.rpId !== actual.rpId
      || grant.profileId !== actual.profileId
      || grant.action !== actual.action) {
      return { ok: false, reason: 'yayra-authorization-mismatch' };
    }
    return { ok: true, method: 'yayra-passkey', expiresAt: grant.expiresAt };
  }

  function encryptionAvailable() {
    try {
      return Boolean(safeStorageImpl && safeStorageImpl.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  function touchIdAvailable() {
    try {
      return platform === 'darwin'
        && Boolean(systemPreferencesImpl && typeof systemPreferencesImpl.canPromptTouchID === 'function'
          && systemPreferencesImpl.canPromptTouchID());
    } catch {
      return false;
    }
  }

  async function promptTouchIdIfAvailable(reason) {
    if (!touchIdAvailable()) return { ok: true, prompted: false };
    try {
      await systemPreferencesImpl.promptTouchID(reason);
      return { ok: true, prompted: true };
    } catch (err) {
      return { ok: false, reason: 'user-declined-or-timeout', detail: String(err?.message || err) };
    }
  }

  /* -------------- REAL system-password prompt (Linux) -------------- */
  // "System lock" on Linux used to be a SILENT safeStorage decrypt - the
  // user was never asked for anything, which read as "not working at
  // all". pkexec (PolicyKit) shows the genuine system password dialog;
  // exit 0 means the OS user authenticated, 126/127 means they dismissed
  // the prompt. This is the same elevation path the updater uses for
  // .deb installs, so it is known-good on the target machines.

  function findPkexec() {
    const candidates = ['/usr/bin/pkexec', '/bin/pkexec', '/usr/local/bin/pkexec'];
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
    }
    return null;
  }

  function systemAuthAvailable() {
    return platform === 'linux' && Boolean(findPkexec());
  }

  function promptSystemAuthIfAvailable() {
    if (!systemAuthAvailable()) return Promise.resolve({ ok: true, prompted: false });
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      let child;
      try {
        child = spawnImpl(findPkexec(), ['/bin/true'], { stdio: 'ignore' });
      } catch (err) {
        done({ ok: false, prompted: false, reason: 'system-auth-unavailable', detail: String(err?.message || err) });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill?.(); } catch { /* best effort */ }
        done({ ok: false, prompted: true, reason: 'user-declined-or-timeout' });
      }, SYSTEM_AUTH_TIMEOUT_MS);
      if (typeof timer?.unref === 'function') timer.unref();
      child.once?.('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, prompted: false, reason: 'system-auth-unavailable', detail: String(err?.message || err) });
      });
      child.once?.('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) done({ ok: true, prompted: true });
        else done({ ok: false, prompted: true, reason: 'user-declined-or-timeout' });
      });
    });
  }

  /* --------------- durable record storage (+ backup) --------------- */
  // "Verify now removed my passkey": a corrupted/missing record file made
  // verify report no-passkey-registered, and the renderer then dropped
  // its own copy too. The record is now written atomically (temp file +
  // rename where the fs supports it) WITH a .bak twin, and reads fall
  // back to the backup - a half-written main file no longer destroys the
  // registration.

  const backupPath = `${filePath}.bak`;

  function parseRecordFile(p) {
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  function readRecord() {
    const main = parseRecordFile(filePath);
    if (main) return main;
    const backup = parseRecordFile(backupPath);
    if (backup) {
      // Self-heal the main file from the surviving backup.
      try { fs.writeFileSync(filePath, JSON.stringify(backup)); } catch { /* read-only fs - backup still serves */ }
      logger?.warn?.('[yayra:passkey] main record file was missing/corrupt - restored from backup');
      return backup;
    }
    return null;
  }

  function writeRecord(record) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = JSON.stringify(record);
    if (typeof fs.renameSync === 'function') {
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, filePath);
    } else {
      fs.writeFileSync(filePath, payload);
    }
    try { fs.writeFileSync(backupPath, payload); } catch { /* backup is best-effort */ }
  }

  /* ---------------------- 6-digit PIN fallback ---------------------- */

  function validPin(pin) {
    return typeof pin === 'string' && /^\d{6}$/.test(pin);
  }

  // scrypt: memory-hard, so a stolen record file cannot be brute-forced
  // cheaply even though a 6-digit space is small - combined with the
  // random 16-byte salt and the live attempt lockout below.
  function derivePinVerifier(pin, saltHex) {
    return crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  }

  function pinLockState(record) {
    const lockUntil = Number(record?.pinLockUntil) || 0;
    if (lockUntil > Date.now()) return { locked: true, retryAt: lockUntil };
    return { locked: false, retryAt: null };
  }

  function verifyPin(record, pin) {
    const lock = pinLockState(record);
    if (lock.locked) return { ok: false, reason: 'pin-locked', retryAt: lock.retryAt };
    if (!validPin(pin)) return { ok: false, reason: 'pin-required' };
    const expected = Buffer.from(record.pinVerifier, 'hex');
    const got = Buffer.from(derivePinVerifier(pin, record.pinSalt), 'hex');
    const matches = expected.length === got.length && crypto.timingSafeEqual(expected, got);
    if (matches) {
      if (record.pinAttempts || record.pinLockUntil) {
        writeRecord({ ...record, pinAttempts: 0, pinLockUntil: 0 });
      }
      return { ok: true };
    }
    const attempts = (Number(record.pinAttempts) || 0) + 1;
    const lockedNow = attempts >= PIN_MAX_ATTEMPTS;
    writeRecord({
      ...record,
      pinAttempts: lockedNow ? 0 : attempts,
      pinLockUntil: lockedNow ? Date.now() + PIN_LOCK_MS : 0
    });
    if (lockedNow) {
      logger?.warn?.('[yayra:passkey] 5 wrong PIN attempts - PIN entry locked for 60s');
      return { ok: false, reason: 'pin-locked', retryAt: Date.now() + PIN_LOCK_MS };
    }
    return { ok: false, reason: 'wrong-pin', attemptsRemaining: PIN_MAX_ATTEMPTS - attempts };
  }

  function method() {
    if (touchIdAvailable()) return 'touch-id';
    // Linux with PolicyKit: verification is a REAL system-password
    // prompt, not just keychain decryption - name it honestly.
    if (systemAuthAvailable()) return 'system-lock';
    return 'os-keychain';
  }

  /**
   * Linux honesty: safeStorage only gives REAL keychain-bound encryption
   * when a secret service (gnome-keyring/kwallet) is running. Electron
   * falls back to a hardcoded-key 'basic_text' backend otherwise - that
   * still works, but it is NOT bound to the OS login, so the UI must say
   * so instead of overclaiming.
   */
  function weakEncryption() {
    try {
      return platform === 'linux'
        && typeof safeStorageImpl?.getSelectedStorageBackend === 'function'
        && safeStorageImpl.getSelectedStorageBackend() === 'basic_text';
    } catch {
      return false;
    }
  }

  async function handleStatus() {
    const record = readRecord();
    const pinLock = record?.method === 'pin' ? pinLockState(record) : { locked: false, retryAt: null };
    return {
      // 'available' keeps its historical meaning (OS keychain usable);
      // the PIN fallback works regardless - see 'methods' below.
      available: encryptionAvailable(),
      method: record?.method || method(),
      weakEncryption: weakEncryption(),
      registered: Boolean(record),
      // The fallback ladder, so the UI can offer exactly what this
      // device really supports instead of a dead button.
      methods: {
        // System lock works via the OS keychain OR a real PolicyKit
        // password prompt (Linux) - either one makes the option live.
        deviceLock: encryptionAvailable() || systemAuthAvailable(),
        touchId: touchIdAvailable(),
        pin: true,
        phone: Boolean(phoneApproval)
      },
      pinLocked: pinLock.locked,
      pinRetryAt: pinLock.retryAt,
      passkey: record ? { credentialId: record.credentialId, label: record.label, createdAt: record.createdAt, method: record.method } : null
    };
  }

  function persistWithReadBack(record) {
    writeRecord(record);
    // Read-back verification: registration only reports success when
    // the device record is genuinely on disk and parseable - otherwise
    // the UI would claim "passkey active" while verify (which re-reads
    // this file) would say nothing is registered.
    const persisted = readRecord();
    if (!persisted || persisted.credentialId !== record.credentialId) {
      return { ok: false, reason: 'device-storage-failed' };
    }
    return { ok: true, passkey: { credentialId: record.credentialId, label: record.label, createdAt: record.createdAt, method: record.method } };
  }

  async function handleRegister(event, {
    label = 'Yayra user',
    method: wantMethod = 'device',
    pin = null,
    websiteRequest = null
  } = {}) {
    if (wantMethod === 'pin') {
      // 6-digit PIN fallback: for devices with no fingerprint/Face ID,
      // no security key and no usable OS keychain. Stored only as a
      // salted scrypt verifier - never the PIN itself.
      if (!validPin(pin)) return { ok: false, reason: 'pin-invalid' };
      try {
        const pinSalt = randomBytesImpl(16).toString('hex');
        const result = persistWithReadBack({
          credentialId: `device-${Date.now()}-${randomBytesImpl(6).toString('hex')}`,
          label: String(label),
          createdAt: Date.now(),
          method: 'pin',
          pinSalt,
          pinVerifier: derivePinVerifier(pin, pinSalt),
          pinAttempts: 0,
          pinLockUntil: 0
        });
        return withWebsiteGrant(event, websiteRequest, result);
      } catch (err) {
        logger?.error?.(`[yayra:passkey] PIN register failed: ${err?.message || err}`);
        return { ok: false, reason: 'device-storage-failed' };
      }
    }
    // 'device' (system lock): needs the OS keychain OR a real system
    // password prompt (Linux PolicyKit). With neither, the UI falls back
    // to the PIN/phone rungs of the ladder.
    if (!encryptionAvailable() && !systemAuthAvailable()) {
      return { ok: false, reason: 'keychain-unavailable' };
    }
    const gate = await promptTouchIdIfAvailable('register a Yayra device passkey');
    if (!gate.ok) return { ok: false, reason: gate.reason };
    if (!gate.prompted) {
      // No Touch ID on this device: creating a system-lock passkey must
      // CONFIRM the system password where a real prompt exists.
      const sysGate = await promptSystemAuthIfAvailable();
      if (!sysGate.ok && sysGate.prompted) return { ok: false, reason: sysGate.reason };
    }
    try {
      const base = {
        credentialId: `device-${Date.now()}-${randomBytesImpl(6).toString('hex')}`,
        label: String(label),
        createdAt: Date.now(),
        method: method()
      };
      if (encryptionAvailable()) {
        const secret = randomBytesImpl(32).toString('base64');
        const encrypted = safeStorageImpl.encryptString(secret);
        const result = persistWithReadBack({
          ...base,
          secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
          encryptedSecret: Buffer.from(encrypted).toString('base64')
        });
        return withWebsiteGrant(event, websiteRequest, result);
      }
      // No keychain, but a real system-password prompt exists (verified
      // above): the record carries no secret - every verify re-runs the
      // live OS authentication, which is the actual proof.
      return withWebsiteGrant(event, websiteRequest, persistWithReadBack(base));
    } catch (err) {
      logger?.error?.(`[yayra:passkey] register failed: ${err?.message || err}`);
      return { ok: false, reason: 'keychain-unavailable' };
    }
  }

  async function handleVerify(event, { pin = null, websiteRequest = null } = {}) {
    const record = readRecord();
    if (!record) return { ok: false, reason: 'no-passkey-registered' };
    if (record.method === 'pin') {
      return withWebsiteGrant(event, websiteRequest, verifyPin(record, pin));
    }
    const verified = (result = { ok: true }) => withWebsiteGrant(event, websiteRequest, result);

    // macOS: Touch ID prompt where the hardware has it.
    const gate = await promptTouchIdIfAvailable('unlock your Yayra vault');
    if (!gate.ok) return { ok: false, reason: gate.reason };

    // Linux: REAL system-password confirmation via PolicyKit. Succeeding
    // here IS the authentication ("confirm your system" - the user sees
    // and answers the OS dialog); declining it fails the ceremony.
    let systemProved = false;
    if (!gate.prompted) {
      const sysGate = await promptSystemAuthIfAvailable();
      if (!sysGate.ok && sysGate.prompted) return { ok: false, reason: sysGate.reason };
      systemProved = Boolean(sysGate.ok && sysGate.prompted);
    }

    if (!record.encryptedSecret) {
      // System-auth-only record (registered without a keychain): the
      // live prompt above is the whole ceremony.
      if (systemProved || gate.prompted) return verified();
      return { ok: false, reason: systemAuthAvailable() ? 'verification-failed' : 'system-auth-unavailable' };
    }

    if (!encryptionAvailable()) {
      // Keychain gone since registration (e.g. keyring service removed).
      // A successful live system prompt still proves the user.
      if (systemProved) return verified();
      return { ok: false, reason: 'keychain-unavailable' };
    }
    try {
      const secret = safeStorageImpl.decryptString(Buffer.from(record.encryptedSecret, 'base64'));
      const matches = crypto.createHash('sha256').update(secret).digest('hex') === record.secretHash;
      if (matches) return verified();
      // Decrypt succeeded but the hash does not line up: the record was
      // tampered with - fail regardless of the live prompt.
      return { ok: false, reason: 'verification-failed' };
    } catch (err) {
      logger?.error?.(`[yayra:passkey] verify failed: ${err?.message || err}`);
      // The OS keyring could not decrypt (changed/reset keyring) - but a
      // live system-password prompt that the user just passed is stronger
      // proof than the stale ciphertext, so honour it.
      if (systemProved) return verified();
      return { ok: false, reason: 'verification-failed' };
    }
  }

  /* ---------------- phone QR approval (verification alt) ---------------- */

  async function handlePhoneStart() {
    if (!phoneApproval) return { ok: false, reason: 'unavailable' };
    const record = readRecord();
    if (!record) return { ok: false, reason: 'no-passkey-registered' };
    return phoneApproval.start({ reason: `unlock the Yayra vault for "${record.label}"` });
  }

  async function handlePhoneStatus() {
    if (!phoneApproval) return { state: 'unavailable' };
    return phoneApproval.status();
  }

  async function handlePhoneCancel() {
    if (!phoneApproval) return { ok: false, reason: 'unavailable' };
    return phoneApproval.cancel();
  }

  async function handleRemove() {
    try {
      websiteGrants.clear();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch { /* best effort */ }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
  }

  if (ipcMain) {
    ipcMain.handle('yayra:passkey-status', handleStatus);
    ipcMain.handle('yayra:passkey-register', handleRegister);
    ipcMain.handle('yayra:passkey-verify', handleVerify);
    ipcMain.handle('yayra:passkey-remove', handleRemove);
    ipcMain.handle('yayra:passkey-phone-start', handlePhoneStart);
    ipcMain.handle('yayra:passkey-phone-status', handlePhoneStatus);
    ipcMain.handle('yayra:passkey-phone-cancel', handlePhoneCancel);
  }

  return {
    handleStatus, handleRegister, handleVerify, handleRemove,
    handlePhoneStart, handlePhoneStatus, handlePhoneCancel,
    consumeWebsiteGrant,
    _filePath: filePath,
    _websiteGrants: websiteGrants
  };
}

module.exports = { createPasskeyBridge };
