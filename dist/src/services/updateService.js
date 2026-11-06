import { DEFAULT_UPDATE_CONFIG, compareSemver, mergeWithUpdateDefaults, parseSemver } from '../config/updates.js';

const LAST_GOOD_KEY = 'yayra:update:last-good-manifest';
const STAGED_KEY = 'yayra:update:staged-download';
const SNOOZE_PREFIX = 'yayra:update:snooze:';
const SESSION_PROMPT_PREFIX = 'yayra:update:prompted:';
const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

export class UpdateService {
  constructor(options = {}) {
    this.target = options.target || 'pwa';
    this.installedVersion = options.installedVersion || '0.0.0';
    this.manifestUrl = options.manifestUrl || '/updates/manifest.json';
    this.deviceId = options.deviceId || 'anonymous-device';
    this.roles = options.roles || [];
    this.storage = options.storage || defaultStorage();
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || ((line) => console.info(line));
    this.telemetry = options.telemetry || null;
    this.config = mergeWithUpdateDefaults(options.config || DEFAULT_UPDATE_CONFIG);
    // Optional artifact-signature pinning (SPKI PEM, RSA - the key pair
    // scripts/sign-linux-artifacts.mjs signs with; its public half is
    // published as linux-signing-public-key.pem). When set, every download
    // MUST carry a valid `sig` in the manifest and verification FAILS
    // CLOSED - a compromised manifest host can then no longer point
    // clients at an artifact the release key never signed (sha256 alone
    // can't give that guarantee, because whoever controls the manifest
    // controls the sha256 too). When unset, behavior is unchanged:
    // sha256+bytes verification against the TLS-served manifest.
    this.updatePublicKey = options.updatePublicKey || null;
    this.state = { status: 'idle', installedVersion: this.installedVersion, target: this.target };
    this.inFlight = null;
    this.abortController = null;
    this.lastManualCheckAt = 0;
    this.stateListeners = new Set();
  }

  subscribe(listener) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onAppHidden() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async check(options = {}) {
    const manual = options.manual === true;
    if (!this.config.enabled) {
      return this.#transition({ status: 'disabled', reason: 'updates.disabled:false', installedVersion: this.installedVersion, target: this.target }, 'checked');
    }
    const throttleMs = Math.max(0, Number(this.config.desktop?.manualCheckThrottleSeconds ?? 20)) * 1000;
    const now = this.now();
    if (manual && this.lastManualCheckAt && now - this.lastManualCheckAt < throttleMs) {
      const throttled = { ...this.state, status: this.state.status === 'idle' ? 'unknown' : this.state.status, throttledUntil: this.lastManualCheckAt + throttleMs };
      return this.#transition(throttled, 'checked');
    }
    if (manual) this.lastManualCheckAt = now;
    if (this.inFlight) return this.inFlight;
    // A non-semver installed version (e.g. a build that injected "dev")
    // used to throw inside the comparison AFTER the manifest fetch, where
    // the catch reported it as "offline"/"could not reach the update
    // server" - a lie that made the whole update system look broken. Fail
    // fast with an honest reason instead.
    try {
      parseSemver(this.installedVersion);
    } catch {
      return this.#transition({
        status: 'unknown',
        target: this.target,
        installedVersion: this.installedVersion,
        reason: `invalid-installed-version:${this.installedVersion}`
      }, 'error');
    }
    if (!this.fetchImpl) {
      return this.#offlineState(new Error('fetch unavailable'));
    }
    this.abortController = new AbortController();
    this.inFlight = this.#checkWithNetwork(this.abortController.signal)
      .finally(() => {
        this.inFlight = null;
        this.abortController = null;
      });
    return this.inFlight;
  }

  async #checkWithNetwork(signal) {
    this.#transition({ ...this.state, status: 'checking' }, 'checked');
    try {
      const response = await this.fetchImpl(this.manifestUrl, { cache: 'no-store', signal, headers: { accept: 'application/json' } });
      if (!response || !response.ok) {
        throw new Error(`manifest HTTP ${response?.status || 'unavailable'}`);
      }
      const manifest = await response.json();
      const lastSeenAt = new Date(this.now()).toISOString();
      this.storage.setItem(LAST_GOOD_KEY, JSON.stringify({ manifest, lastSeenAt }));
      return this.#stateFromManifest(manifest, lastSeenAt);
    } catch (error) {
      return this.#offlineState(error);
    }
  }

  #stateFromManifest(manifest, lastSeenAt) {
    const latest = manifest?.latest?.[this.target];
    const minimum = manifest?.minSupported?.[this.target];
    const download = manifest?.downloads?.[this.target] || null;
    const base = {
      target: this.target,
      installedVersion: this.installedVersion,
      manifest,
      checkedAt: new Date(this.now()).toISOString(),
      lastSeenAt
    };
    if (minimum && compareSemver(this.installedVersion, minimum) < 0) {
      return this.#transition({ ...base, status: 'available', version: latest || minimum, force: true, download, reason: 'below-min-supported' }, 'available');
    }
    if (!latest) {
      return this.#transition({ ...base, status: 'upToDate', reason: 'target-not-in-manifest' }, 'target_not_in_manifest');
    }
    const versionCompare = compareSemver(this.installedVersion, latest);
    if (versionCompare > 0) {
      return this.#transition({ ...base, status: 'ahead', version: latest, reason: 'installed-newer-than-release-channel' }, 'installed_ahead');
    }
    if (versionCompare === 0) {
      return this.#transition({ ...base, status: 'upToDate', version: latest }, 'up_to_date');
    }
    if (!this.#rolloutEligible(manifest.rollout || {})) {
      return this.#transition({ ...base, status: 'upToDate', version: latest, reason: 'rollout-not-eligible' }, 'rollout_pending');
    }
    return this.#transition({ ...base, status: 'available', version: latest, force: false, download }, 'available');
  }

  async #offlineState(error) {
    const cached = this.#lastGood();
    const state = {
      status: 'unknown',
      target: this.target,
      installedVersion: this.installedVersion,
      lastSeenAt: cached?.lastSeenAt || null,
      reason: error?.message || 'offline'
    };
    return this.#transition(state, 'error');
  }

  async download() {
    if (this.state.status !== 'available' || !this.state.download?.url) {
      return this.#transition({ ...this.state, status: 'error', reason: 'no-download-for-current-state' }, 'install_failed');
    }
    if (!this.fetchImpl) {
      return this.#transition({ ...this.state, status: 'error', reason: 'fetch unavailable' }, 'install_failed');
    }
    this.#transition({ ...this.state, status: 'downloading', progress: 0 }, 'checked');
    const response = await this.fetchImpl(this.state.download.url, { cache: 'no-store' });
    if (!response.ok) {
      return this.#transition({ ...this.state, status: 'error', reason: `download HTTP ${response.status}` }, 'install_failed');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedBytes = Number(this.state.download.bytes);
    if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && bytes.byteLength !== expectedBytes) {
      return this.#transition({ ...this.state, status: 'error', reason: 'checksum:bytes-mismatch', keptOldFile: true }, 'install_failed');
    }
    const digest = await sha256Hex(bytes);
    if (this.state.download.sha256 && digest !== this.state.download.sha256) {
      return this.#transition({ ...this.state, status: 'error', reason: 'checksum:sha256-mismatch', expectedSha256: this.state.download.sha256, actualSha256: digest, keptOldFile: true }, 'install_failed');
    }
    if (this.updatePublicKey) {
      const signature = this.state.download.sig;
      if (!signature) {
        return this.#transition({ ...this.state, status: 'error', reason: 'signature:missing', keptOldFile: true }, 'install_failed');
      }
      let signatureValid = false;
      try {
        signatureValid = await verifyRsaSha256(this.updatePublicKey, bytes, signature);
      } catch (error) {
        return this.#transition({ ...this.state, status: 'error', reason: `signature:verify-error:${error?.message || error}`, keptOldFile: true }, 'install_failed');
      }
      if (!signatureValid) {
        return this.#transition({ ...this.state, status: 'error', reason: 'signature:invalid', keptOldFile: true }, 'install_failed');
      }
    }
    const staged = {
      version: this.state.version,
      target: this.target,
      sha256: digest,
      bytes: bytes.byteLength,
      stagedAt: new Date(this.now()).toISOString(),
      path: `userData/updates/${this.target}-${this.state.version}`
    };
    this.storage.setItem(STAGED_KEY, JSON.stringify(staged));
    return this.#transition({ ...this.state, status: 'ready', stagedDownload: staged }, 'downloaded');
  }

  async install() {
    if (this.state.status !== 'ready') {
      return this.#transition({ ...this.state, status: 'error', reason: 'install-called-before-ready' }, 'install_failed');
    }
    return this.#transition({ ...this.state, status: 'installing' }, 'install_started');
  }

  dismiss(scope = 'session') {
    const version = this.state.version || this.state.availableVersion || 'unknown';
    persistSnooze(this.storage, version, scope, this.now());
    return this.#transition({ ...this.state, dismissed: scope }, scope === 'session' ? 'dismissed' : 'snoozed');
  }

  diagnostics() {
    return {
      target: this.target,
      installedVersion: this.installedVersion,
      manifestUrl: this.manifestUrl,
      state: this.state,
      stagedDownload: parseJson(this.storage.getItem(STAGED_KEY)),
      lastGoodManifest: this.#lastGood()
    };
  }

  #lastGood() {
    return parseJson(this.storage.getItem(LAST_GOOD_KEY));
  }

  #rolloutEligible(rollout) {
    if (Array.isArray(rollout.allowlist) && rollout.allowlist.includes(this.deviceId)) return true;
    if (Array.isArray(rollout.allowlistRoles) && this.roles.some((role) => rollout.allowlistRoles.includes(role))) return true;
    const percent = Number.isFinite(Number(rollout.percent)) ? Number(rollout.percent) : 100;
    return stablePercent(this.deviceId) < Math.max(0, Math.min(100, percent));
  }

  #transition(nextState, eventName) {
    this.state = nextState;
    const line = `[updates] ${eventName || nextState.status} target=${this.target} state=${nextState.status} installed=${this.installedVersion}${nextState.version ? ` available=${nextState.version}` : ''}${nextState.reason ? ` reason=${nextState.reason}` : ''}`;
    this.logger(line);
    if (this.config.telemetry && this.telemetry) {
      this.telemetry({ event: eventName || nextState.status, target: this.target, state: nextState.status, version: nextState.version || null, at: new Date(this.now()).toISOString() });
    }
    for (const listener of this.stateListeners) listener(this.state);
    return this.state;
  }
}

export class PromptSession {
  constructor({ storage = defaultStorage(), now = () => Date.now(), platform = 'pwa' } = {}) {
    this.storage = storage;
    this.now = now;
    this.platform = platform;
    this.prompted = new Set();
  }

  shouldPrompt(state, config = DEFAULT_UPDATE_CONFIG) {
    if (!['pwa', 'ios', 'android'].includes(this.platform)) return false;
    const cadence = config.mobile?.promptCadence || 'per-open';
    if (cadence === 'off') return false;
    if (state.status !== 'available' || !state.version) return false;
    const key = `${SESSION_PROMPT_PREFIX}${this.platform}:${state.version}`;
    if (this.prompted.has(key)) return false;
    if (isSnoozed(this.storage, state.version, this.now())) return false;
    if (cadence === 'once-a-day') {
      const last = Number(this.storage.getItem(key) || 0);
      if (last && this.now() - last < DAY_MS) return false;
    }
    this.prompted.add(key);
    this.storage.setItem(key, String(this.now()));
    return true;
  }

  dismiss(version, scope = 'session') {
    persistSnooze(this.storage, version, scope, this.now());
  }
}

export function persistSnooze(storage, version, scope, now = Date.now()) {
  const key = `${SNOOZE_PREFIX}${version}`;
  if (scope === 'session') {
    storage.setItem(key, JSON.stringify({ scope, expiresAt: null }));
  } else if (scope === '1d') {
    storage.setItem(key, JSON.stringify({ scope, expiresAt: now + DAY_MS }));
  } else if (scope === '7d') {
    storage.setItem(key, JSON.stringify({ scope, expiresAt: now + 7 * DAY_MS }));
  } else if (scope === 'never-for-version') {
    storage.setItem(key, JSON.stringify({ scope, expiresAt: 'never' }));
  }
}

export function isSnoozed(storage, version, now = Date.now()) {
  const value = parseJson(storage.getItem(`${SNOOZE_PREFIX}${version}`));
  if (!value) return false;
  if (value.scope === 'session') return true;
  if (value.expiresAt === 'never') return true;
  if (Number(value.expiresAt) > now) return true;
  storage.removeItem(`${SNOOZE_PREFIX}${version}`);
  return false;
}

export function stablePercent(deviceId) {
  let hash = 2166136261;
  for (const char of String(deviceId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 100;
}

/**
 * Verifies a detached RSA-SHA256 signature (what
 * `openssl dgst -sha256 -sign` in scripts/sign-linux-artifacts.mjs
 * produces) against an SPKI PEM public key. Uses WebCrypto's
 * RSASSA-PKCS1-v1_5 in browsers (universally supported, unlike Ed25519)
 * and node:crypto elsewhere.
 */
export async function verifyRsaSha256(publicKeyPem, bytes, signatureBase64) {
  const signature = base64ToBytes(signatureBase64);
  if (globalThis.crypto?.subtle) {
    const der = base64ToBytes(publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''));
    const key = await globalThis.crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, bytes);
  }
  const { createVerify } = await import('node:crypto');
  const verifier = createVerify('sha256');
  verifier.update(bytes);
  return verifier.verify(publicKeyPem, signature);
}

function base64ToBytes(base64) {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function defaultStorage() {
  if (globalThis.localStorage) return globalThis.localStorage;
  return new MemoryStorage();
}
