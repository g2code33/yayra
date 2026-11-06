/**
 * Yayra Passkey Service - WebAuthn-backed account & vault protection.
 *
 * What this is (honest scope): a real platform-authenticator passkey for
 * the YAYRA ACCOUNT itself - registered with the device's biometric /
 * PIN / security-key authenticator via navigator.credentials. Once
 * registered it gates sensitive actions (revealing vault passwords,
 * account security settings) behind an OS-level user-verification
 * ceremony, exactly like Chrome gates "show password" behind Windows
 * Hello / Touch ID.
 *
 * What it is NOT: this account credential is never a third-party site's
 * credential. Supported Linux desktop builds have a separate encrypted,
 * profile-scoped website CTAP2 provider. This service may verify the user and
 * mint a one-shot authorization for that provider, but the site's own RP-bound
 * key still performs its WebAuthn signature inside Chromium/main.
 *
 * Local-first: no server. The credential is created with a locally
 * generated challenge and verified by the authenticator's user-presence
 * + user-verification flags. That gives "this human, on this device,
 * approved via OS biometrics" - the right bar for unlocking a local
 * vault (a remote attacker cannot complete the OS ceremony).
 *
 * DI-friendly: `credentialsApi` and `storage` are injectable for tests.
 */

const STORAGE_KEY = 'yayra-account-passkey-v1';

export class PasskeyService {
  constructor({ storage, credentialsApi, rpName = 'Yayra', rpId, nativeBridge = null } = {}) {
    this.storage = storage || null;
    this._credentialsApi = credentialsApi || null;
    this.rpName = rpName;
    this.rpId = rpId || (typeof location !== 'undefined' && location.hostname ? location.hostname : undefined);
    // Electron desktop: the shell runs on the custom yayra:// scheme,
    // which Chromium's WebAuthn refuses (no valid RP domain) - users saw
    // "passkeys require a secure (HTTPS) context" on a perfectly trusted
    // app. When the preload exposes the device-passkey bridge
    // (electron/passkeyBridge.cjs: OS keychain via safeStorage + real
    // Touch ID on supporting Macs), it takes precedence over WebAuthn.
    this.nativeBridge = nativeBridge;
  }

  get credentialsApi() {
    if (this._credentialsApi) return this._credentialsApi;
    if (typeof navigator !== 'undefined' && navigator.credentials) return navigator.credentials;
    return null;
  }

  get usesNativeBridge() {
    return Boolean(this.nativeBridge && typeof this.nativeBridge.register === 'function');
  }

  isSupported() {
    if (this.usesNativeBridge) return true;
    const api = this.credentialsApi;
    return Boolean(api && typeof api.create === 'function' && typeof api.get === 'function'
      && typeof globalThis.PublicKeyCredential !== 'undefined');
  }

  async _get(key) {
    if (this.storage && typeof this.storage.get === 'function') return this.storage.get(key);
    return null;
  }

  async _set(key, val) {
    if (this.storage && typeof this.storage.set === 'function') return this.storage.set(key, val);
  }

  async _delete(key) {
    if (this.storage && typeof this.storage.delete === 'function') return this.storage.delete(key);
  }

  async getRegisteredPasskey() {
    const stored = await this._get(STORAGE_KEY);
    if (!stored || !stored.credentialId) return null;
    return stored;
  }

  /**
   * Reconcile the renderer's stored passkey record with the device
   * bridge's ground truth (the OS-keychain file in the main process).
   * The two CAN drift - e.g. app data cleared or the device file removed
   * between runs - which used to leave the UI claiming "Passkey active"
   * while verify honestly failed with "no passkey is registered yet".
   * Called on startup; self-heals both directions:
   *   - bridge registered, storage empty  -> adopt the bridge record;
   *   - storage has a native record, bridge empty -> drop the stale
   *     record so the UI goes back to "Create passkey";
   * Returns { action: 'adopted'|'cleared-stale'|'none', status } where
   * status is the bridge's report (available/method/weakEncryption/...)
   * or null off-desktop.
   */
  async syncWithNativeBridge() {
    if (!this.usesNativeBridge || typeof this.nativeBridge.status !== 'function') {
      return { action: 'none', status: null };
    }
    let status = null;
    try {
      status = await this.nativeBridge.status();
    } catch {
      return { action: 'none', status: null };
    }
    const stored = await this.getRegisteredPasskey();
    if (status?.registered && status.passkey && !stored) {
      const adopted = {
        credentialId: status.passkey.credentialId,
        accountLabel: status.passkey.label || 'Yayra user',
        rpId: null,
        method: status.passkey.method || 'os-keychain',
        createdAt: status.passkey.createdAt || Date.now(),
        lastVerifiedAt: null
      };
      await this._set(STORAGE_KEY, adopted);
      return { action: 'adopted', status };
    }
    if (status && !status.registered && stored && stored.method) {
      // Only native-bridge records (they carry `method`) are dropped here;
      // a WebAuthn record from the web build is none of the bridge's business.
      await this._delete(STORAGE_KEY);
      return { action: 'cleared-stale', status };
    }
    return { action: 'none', status };
  }

  /**
   * Register a passkey for the Yayra account on this device.
   * Returns { success, passkey } or { success: false, reason }.
   */
  async registerPasskey({
    accountLabel = 'Yayra user',
    accountId,
    method = null,
    pin = null,
    websiteRequest = null
  } = {}) {
    if (!this.isSupported()) {
      return { success: false, reason: 'passkeys-unsupported' };
    }
    if (this.usesNativeBridge) {
      try {
        // method 'pin' (+ the 6 digits) is the fallback for devices with
        // no fingerprint/Face ID/security key and no usable OS keychain;
        // the default 'device' method binds to the OS login (system lock).
        const options = (method || websiteRequest)
          ? { ...(method ? { method, pin } : {}), ...(websiteRequest ? { websiteRequest } : {}) }
          : undefined;
        const res = await this.nativeBridge.register(accountLabel, options);
        if (!res || !res.ok) {
          return { success: false, reason: (res && res.reason) || 'creation-cancelled' };
        }
        const passkey = {
          credentialId: res.passkey.credentialId,
          accountLabel,
          rpId: null,
          method: res.passkey.method || 'os-keychain',
          createdAt: res.passkey.createdAt || Date.now(),
          lastVerifiedAt: null
        };
        await this._set(STORAGE_KEY, passkey);
        return {
          success: true,
          passkey,
          ...(res.authorizationToken ? {
            authorizationToken: res.authorizationToken,
            authorizationExpiresAt: res.authorizationExpiresAt
          } : {})
        };
      } catch (err) {
        return { success: false, reason: errorReason(err) };
      }
    }
    try {
      const challenge = randomBytes(32);
      const userId = utf8Bytes(accountId || `yayra-local-${Date.now()}`);
      const credential = await this.credentialsApi.create({
        publicKey: {
          challenge,
          rp: this.rpId ? { name: this.rpName, id: this.rpId } : { name: this.rpName },
          user: { id: userId, name: accountLabel, displayName: accountLabel },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },   // ES256
            { type: 'public-key', alg: -257 }  // RS256
          ],
          authenticatorSelection: {
            // Prefer the device's built-in authenticator (biometrics/PIN)
            // but allow roaming security keys too.
            residentKey: 'preferred',
            userVerification: 'required'
          },
          timeout: 60000
        }
      });
      if (!credential || !credential.rawId) {
        return { success: false, reason: 'creation-cancelled' };
      }
      const passkey = {
        credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
        accountLabel,
        rpId: this.rpId || null,
        createdAt: Date.now(),
        lastVerifiedAt: null
      };
      await this._set(STORAGE_KEY, passkey);
      return { success: true, passkey };
    } catch (err) {
      return { success: false, reason: errorReason(err) };
    }
  }

  /**
   * Run a user-verification ceremony against the registered passkey.
   * Returns { success } or { success: false, reason }.
   */
  async verifyPasskey({ pin = null, websiteRequest = null } = {}) {
    if (!this.isSupported()) {
      return { success: false, reason: 'passkeys-unsupported' };
    }
    const stored = await this.getRegisteredPasskey();
    if (!stored) {
      return { success: false, reason: 'no-passkey-registered' };
    }
    if (this.usesNativeBridge) {
      try {
        const options = (pin != null || websiteRequest)
          ? { ...(pin != null ? { pin } : {}), ...(websiteRequest ? { websiteRequest } : {}) }
          : undefined;
        const res = await this.nativeBridge.verify(options);
        if (!res || !res.ok) {
          const reason = (res && res.reason) || 'verification-failed';
          if (reason === 'no-passkey-registered') {
            // The device-side record is gone (file corrupted/removed)
            // while the renderer still holds one. Old behavior deleted
            // the renderer record too - the user experienced that as
            // "Verify now REMOVED my passkey". Device-lock records can
            // be re-created safely (the proof is the live OS ceremony,
            // not the stored blob), so REPAIR first and only fall back
            // to dropping the record when repair is impossible (PIN
            // records - the verifier cannot be rebuilt without trusting
            // whatever PIN was just typed).
            if (stored.method && stored.method !== 'pin') {
              const repaired = await this._repairDeviceRecord(stored, websiteRequest);
              if (repaired) return repaired;
            }
            await this._delete(STORAGE_KEY);
          }
          return { success: false, reason };
        }
        await this._set(STORAGE_KEY, { ...stored, lastVerifiedAt: Date.now() });
        return {
          success: true,
          ...(res.authorizationToken ? {
            authorizationToken: res.authorizationToken,
            authorizationExpiresAt: res.authorizationExpiresAt
          } : {})
        };
      } catch (err) {
        return { success: false, reason: errorReason(err) };
      }
    }
    try {
      const assertion = await this.credentialsApi.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{
            type: 'public-key',
            id: base64UrlToBytes(stored.credentialId)
          }],
          userVerification: 'required',
          ...(stored.rpId ? { rpId: stored.rpId } : {}),
          timeout: 60000
        }
      });
      if (!assertion) return { success: false, reason: 'verification-cancelled' };
      await this._set(STORAGE_KEY, { ...stored, lastVerifiedAt: Date.now() });
      return { success: true };
    } catch (err) {
      return { success: false, reason: errorReason(err) };
    }
  }

  /**
   * Re-create a lost device-lock record and re-run the ceremony. The
   * re-registration itself runs the OS confirmation (Touch ID / system
   * password prompt), so this never grants access without the user
   * proving themselves. Returns a { success, repaired } result on
   * success, or null when the repair could not complete.
   */
  async _repairDeviceRecord(stored, websiteRequest = null) {
    try {
      const res = await this.nativeBridge.register(stored.accountLabel || 'Yayra user', {
        method: 'device',
        ...(websiteRequest ? { websiteRequest } : {})
      });
      if (!res || !res.ok || !res.passkey) return null;
      const passkey = {
        credentialId: res.passkey.credentialId,
        accountLabel: stored.accountLabel || 'Yayra user',
        rpId: null,
        method: res.passkey.method || stored.method || 'os-keychain',
        createdAt: stored.createdAt || res.passkey.createdAt || Date.now(),
        lastVerifiedAt: Date.now()
      };
      await this._set(STORAGE_KEY, passkey);
      return {
        success: true,
        repaired: true,
        ...(res.authorizationToken ? {
          authorizationToken: res.authorizationToken,
          authorizationExpiresAt: res.authorizationExpiresAt
        } : {})
      };
    } catch {
      return null;
    }
  }

  /* -------------------- phone QR approval (desktop) -------------------- */

  get supportsPhoneApproval() {
    return Boolean(this.usesNativeBridge && typeof this.nativeBridge.phoneStart === 'function');
  }

  /** Start a phone QR approval session. Returns { ok, url, expiresAt } or { ok:false, reason }. */
  async startPhoneApproval() {
    if (!this.supportsPhoneApproval) return { ok: false, reason: 'unavailable' };
    try { return await this.nativeBridge.phoneStart(); } catch (err) { return { ok: false, reason: errorReason(err) }; }
  }

  /** Poll the session: { state: 'pending'|'approved'|'denied'|'expired'|'idle'|'unavailable' }. */
  async phoneApprovalStatus() {
    if (!this.supportsPhoneApproval) return { state: 'unavailable' };
    try { return await this.nativeBridge.phoneStatus(); } catch { return { state: 'unavailable' }; }
  }

  async cancelPhoneApproval() {
    if (!this.supportsPhoneApproval) return { ok: false };
    try { return await this.nativeBridge.phoneCancel(); } catch { return { ok: false }; }
  }

  /** A completed phone approval counts as a verification ceremony. */
  async markVerifiedViaPhone() {
    const stored = await this.getRegisteredPasskey();
    if (stored) await this._set(STORAGE_KEY, { ...stored, lastVerifiedAt: Date.now() });
    return { success: true };
  }

  async removePasskey() {
    if (this.usesNativeBridge && typeof this.nativeBridge.remove === 'function') {
      try { await this.nativeBridge.remove(); } catch { /* local record still cleared below */ }
    }
    await this._delete(STORAGE_KEY);
    return { success: true };
  }
}

/* ------------------------------ helpers ------------------------------ */

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(bytes)
    : bytes.fill(Math.floor(Math.random() * 256));
  return bytes;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function'
    ? btoa(bin)
    // eslint-disable-next-line no-undef
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line no-undef
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function errorReason(err) {
  if (!err) return 'unknown-error';
  if (err.name === 'NotAllowedError') return 'user-declined-or-timeout';
  if (err.name === 'InvalidStateError') return 'authenticator-already-registered';
  if (err.name === 'SecurityError') return 'insecure-context';
  return err.name || err.message || 'unknown-error';
}
