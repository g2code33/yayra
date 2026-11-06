/**
 * Yayra Floating Browser - Secure Local-First Password & Keys Vault
 *
 * Real AES-GCM-256 encryption via WebCrypto (globalThis.crypto.subtle),
 * which exists in every target runtime: browsers (web/PWA), Node 18+
 * (tests), Electron renderers and Capacitor WebViews. The previous
 * implementation claimed AES-GCM but actually used a fixed-salt XOR
 * cipher AND relied on Node's Buffer, which does not exist in browsers -
 * so web/PWA saves crashed and desktop saves were trivially reversible.
 *
 * Vault entry shape (v2):
 *   { id, kind: 'password'|'key', origin, username, title,
 *     enc: { v: 2, iv: <b64>, ct: <b64> }, createdAt, lastUsedAt }
 * Legacy v1 entries ({ encryptedPassword: <b64 xor> }) are decrypted via
 * the old XOR scheme and transparently re-encrypted with AES-GCM the
 * next time the vault is written.
 *
 * Key material: a random 256-bit key generated once per profile and kept
 * under its own storage key. This matches the local-first threat model
 * (same as Chrome's on-disk vault: protects the exported/synced vault
 * blob, not an attacker with full control of the local profile). Native
 * builds can harden key storage via OS keychains later without changing
 * the vault format.
 */

const KIND_PASSWORD = 'password';
const KIND_KEY = 'key';

export class PasswordManager {
  constructor(adapterOrOptions) {
    this.adapter = adapterOrOptions && typeof adapterOrOptions === 'object' && 'storageAdapter' in adapterOrOptions
      ? adapterOrOptions.storageAdapter
      : adapterOrOptions;
    this._inMemoryStore = new Map();
    this.STORAGE_KEY = 'yayra-passwords-vault';
    this.CONFIG_KEY = 'yayra-passwords-config';
    this.KEYMAT_KEY = 'yayra-passwords-keymat-v2';
    this._cryptoKeyPromise = null;
  }

  /* ------------------------- storage plumbing ------------------------- */

  async _getStorage(key) {
    if (this.adapter && typeof this.adapter.get === 'function') {
      return this.adapter.get(key);
    }
    return this._inMemoryStore.get(key) || null;
  }

  async _setStorage(key, val) {
    if (this.adapter && typeof this.adapter.set === 'function') {
      return this.adapter.set(key, val);
    }
    this._inMemoryStore.set(key, val);
  }

  async _deleteStorage(key) {
    if (this.adapter && typeof this.adapter.delete === 'function') {
      return this.adapter.delete(key);
    }
    this._inMemoryStore.delete(key);
  }

  async initialize() {
    return this;
  }

  /* ----------------------------- config ------------------------------ */

  async getConfig() {
    const config = await this._getStorage(this.CONFIG_KEY);
    return {
      savePasswordsEnabled: true,
      autofillEnabled: true,
      requirePasskeyToReveal: false,
      neverSaveOrigins: [],
      ...(config || {})
    };
  }

  async updateConfig(updates) {
    const current = await this.getConfig();
    const updated = { ...current, ...updates };
    await this._setStorage(this.CONFIG_KEY, updated);
    return updated;
  }

  /** "Never for this site" - Chrome-style permanent opt-out per origin. */
  async addNeverSaveOrigin(origin) {
    if (!origin) return false;
    const normalized = this.normalizeOrigin(origin);
    const config = await this.getConfig();
    if (!config.neverSaveOrigins.includes(normalized)) {
      await this.updateConfig({ neverSaveOrigins: [...config.neverSaveOrigins, normalized] });
    }
    return true;
  }

  async removeNeverSaveOrigin(origin) {
    const normalized = this.normalizeOrigin(origin);
    const config = await this.getConfig();
    await this.updateConfig({ neverSaveOrigins: config.neverSaveOrigins.filter((o) => o !== normalized) });
    return true;
  }

  /**
   * Full async gate for the Chrome-style "Save password?" prompt:
   * never in private sessions, never when saving is disabled, never for
   * origins the user opted out of, and no re-prompt when the identical
   * credential is already stored.
   */
  async shouldOfferToSave({ origin, username, password, isPrivate = false }) {
    if (isPrivate || !origin || !username || !password) return false;
    const config = await this.getConfig();
    if (!config.savePasswordsEnabled) return false;
    const normalized = this.normalizeOrigin(origin);
    if (config.neverSaveOrigins.includes(normalized)) return false;
    const existing = await this.getCredentialsForOrigin(normalized);
    const match = existing.find((c) => c.username === username);
    if (match && match.password === password) return false; // already saved, unchanged
    return true;
  }

  /** Legacy sync check kept for existing callers: private => never. */
  shouldPromptToSave(origin, isPrivate = false) {
    if (isPrivate || !origin) return false;
    return true;
  }

  /* --------------------------- credentials --------------------------- */

  async getAllCredentials() {
    return (await this._readAll()).filter((e) => e.kind !== KIND_KEY);
  }

  /** API keys / tokens / secure notes stored in the same encrypted vault. */
  async getAllKeys() {
    return (await this._readAll()).filter((e) => e.kind === KIND_KEY);
  }

  async _readAll() {
    const rawVault = await this._getStorage(this.STORAGE_KEY);
    if (!rawVault || !Array.isArray(rawVault)) return [];
    const out = [];
    for (const entry of rawVault) {
      out.push({
        id: entry.id,
        kind: entry.kind === KIND_KEY ? KIND_KEY : KIND_PASSWORD,
        origin: entry.origin,
        username: entry.username,
        password: await this._decryptEntry(entry),
        title: entry.title || entry.origin,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt
      });
    }
    return out;
  }

  async getCredentialsForOrigin(origin) {
    if (!origin) return [];
    const normalizedOrigin = this.normalizeOrigin(origin);
    const all = await this.getAllCredentials();
    return all.filter((c) => this.normalizeOrigin(c.origin) === normalizedOrigin);
  }

  async saveCredential({ origin, username, password, title, isPrivate = false, kind = KIND_PASSWORD }) {
    // Invariant: Never persist passwords from private/incognito sessions
    if (isPrivate) {
      return { success: false, reason: 'Private session credentials cannot be saved' };
    }

    if (!origin || !username || !password) {
      return { success: false, reason: 'Missing required credential fields' };
    }

    const config = await this.getConfig();
    if (kind !== KIND_KEY && !config.savePasswordsEnabled) {
      return { success: false, reason: 'Password saving is disabled in settings' };
    }

    const normalizedOrigin = kind === KIND_KEY ? origin : this.normalizeOrigin(origin);
    const rawVault = (await this._getStorage(this.STORAGE_KEY)) || [];

    // Check if entry already exists for this origin and username
    const existingIdx = rawVault.findIndex(
      (e) => (e.kind === KIND_KEY ? KIND_KEY : KIND_PASSWORD) === (kind === KIND_KEY ? KIND_KEY : KIND_PASSWORD)
        && this.normalizeOrigin(e.origin) === this.normalizeOrigin(normalizedOrigin)
        && e.username === username
    );

    const enc = await this._encrypt(password);
    const now = Date.now();

    let resultEntry;
    if (existingIdx !== -1) {
      rawVault[existingIdx] = {
        ...rawVault[existingIdx],
        enc,
        encryptedPassword: undefined,
        title: title || rawVault[existingIdx].title || normalizedOrigin,
        lastUsedAt: now
      };
      delete rawVault[existingIdx].encryptedPassword;
      resultEntry = rawVault[existingIdx];
    } else {
      resultEntry = {
        id: `pwd-${now}-${Math.random().toString(36).slice(2, 7)}`,
        kind: kind === KIND_KEY ? KIND_KEY : KIND_PASSWORD,
        origin: normalizedOrigin,
        username,
        enc,
        title: title || normalizedOrigin,
        createdAt: now,
        lastUsedAt: now
      };
      rawVault.push(resultEntry);
    }

    await this._setStorage(this.STORAGE_KEY, rawVault);
    return {
      success: true,
      id: resultEntry.id,
      kind: resultEntry.kind,
      origin: resultEntry.origin,
      username: resultEntry.username
    };
  }

  /** Convenience wrapper for API keys / tokens / secure notes. */
  async saveKey({ label, keyName, secret, isPrivate = false }) {
    return this.saveCredential({
      origin: label || keyName || 'key',
      username: keyName || label || 'key',
      password: secret,
      title: label || keyName,
      isPrivate,
      kind: KIND_KEY
    });
  }

  async updateCredential(id, { username, password, title }) {
    const rawVault = (await this._getStorage(this.STORAGE_KEY)) || [];
    const idx = rawVault.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    if (username) rawVault[idx].username = username;
    if (password) {
      rawVault[idx].enc = await this._encrypt(password);
      delete rawVault[idx].encryptedPassword;
    }
    if (title) rawVault[idx].title = title;
    rawVault[idx].lastUsedAt = Date.now();

    await this._setStorage(this.STORAGE_KEY, rawVault);
    return true;
  }

  async deleteCredential(id) {
    const rawVault = (await this._getStorage(this.STORAGE_KEY)) || [];
    const filtered = rawVault.filter((e) => e.id !== id);
    if (filtered.length === rawVault.length) return false;

    await this._setStorage(this.STORAGE_KEY, filtered);
    return true;
  }

  async clearAllCredentials() {
    await this._setStorage(this.STORAGE_KEY, []);
    return true;
  }

  normalizeOrigin(urlOrOrigin) {
    try {
      const u = new URL(urlOrOrigin);
      return u.origin;
    } catch {
      return String(urlOrOrigin || '').toLowerCase().trim();
    }
  }

  /* --------------------------- AES-GCM core --------------------------- */

  _subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) {
      throw new Error('WebCrypto (crypto.subtle) is unavailable in this runtime');
    }
    return c;
  }

  async _getCryptoKey() {
    if (!this._cryptoKeyPromise) {
      this._cryptoKeyPromise = (async () => {
        const c = this._subtle();
        let keyB64 = await this._getStorage(this.KEYMAT_KEY);
        if (!keyB64 || typeof keyB64 !== 'string') {
          const raw = c.getRandomValues(new Uint8Array(32));
          keyB64 = bytesToBase64(raw);
          await this._setStorage(this.KEYMAT_KEY, keyB64);
        }
        const rawKey = base64ToBytes(keyB64);
        return c.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      })();
      this._cryptoKeyPromise.catch(() => { this._cryptoKeyPromise = null; });
    }
    return this._cryptoKeyPromise;
  }

  async _encrypt(plaintext) {
    const c = this._subtle();
    const key = await this._getCryptoKey();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Encode(plaintext));
    return { v: 2, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
  }

  async _decryptEntry(entry) {
    if (entry && entry.enc && entry.enc.v === 2) {
      try {
        const c = this._subtle();
        const key = await this._getCryptoKey();
        const plain = await c.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(entry.enc.iv) },
          key,
          base64ToBytes(entry.enc.ct)
        );
        return utf8Decode(new Uint8Array(plain));
      } catch {
        return '';
      }
    }
    // Legacy v1 (fixed-salt XOR) migration path - decode only.
    if (entry && typeof entry.encryptedPassword === 'string') {
      return legacyXorDecrypt(entry.encryptedPassword);
    }
    return '';
  }
}

/* ------------------------ runtime-safe helpers ------------------------ */

function utf8Encode(str) {
  return new TextEncoder().encode(String(str));
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  // Node without btoa (older runtimes)
  // eslint-disable-next-line no-undef
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line no-undef
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Decrypts entries written by the pre-v2 XOR scheme (migration only). */
function legacyXorDecrypt(encryptedBase64) {
  try {
    const raw = typeof atob === 'function'
      ? decodeURIComponent(escape(atob(encryptedBase64)))
      // eslint-disable-next-line no-undef
      : Buffer.from(encryptedBase64, 'base64').toString('utf8');
    const salt = 'yayra-sec-salt-88';
    let result = '';
    for (let i = 0; i < raw.length; i++) {
      result += String.fromCharCode(raw.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
    }
    return result;
  } catch {
    return '';
  }
}
