'use strict';

/**
 * Linux website passkey provider for native WebContentsView pages.
 *
 * Electron/Chromium on Linux exposes WebAuthn but has no usable platform
 * authenticator UI. A site can therefore sit in navigator.credentials.create
 * for Chromium's three-minute minimum timeout with no prompt at all. This
 * provider supplies a CTAP2-compatible local platform authenticator through
 * Chromium's WebAuthn DevTools domain and persists its P-256 private credentials
 * encrypted by Electron safeStorage. User presence is released only after an
 * explicit browser-chrome click plus either a one-shot grant from Yayra's
 * configured vault passkey (PIN/Touch ID/system lock), or PolicyKit fallback.
 *
 * It is deliberately Linux-only. Windows keeps Windows Hello and macOS keeps
 * Electron's signed Touch ID integration. It also fails closed when Electron
 * uses Linux's insecure `basic_text` safeStorage fallback, the tab is private,
 * its encrypted store is unsafe, or the WebAuthn protocol cannot attach.
 */

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const STORE_FILE = 'yayra-site-passkeys.json';
const STORE_VERSION = 1;
const SYSTEM_AUTH_TIMEOUT_MS = 90 * 1000;
const CDP_COMMAND_TIMEOUT_MS = 5 * 1000;
const PRESENCE_RESET_MS = 60 * 1000;
const MAX_PROFILE_CREDENTIALS = 100;
const MAX_RP_CREDENTIALS = 20;
const MAX_STORE_ENVELOPE_CHARS = 64 * 1024 * 1024;
const STRONG_LINUX_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6'
]);

function cleanProfileKey(profileId) {
  // Profile labels can contain user-controlled Unicode and are not metadata
  // that belongs beside the encrypted envelope. A fixed-size opaque key also
  // avoids overlong/non-round-trippable JSON property names.
  return createHash('sha256')
    .update(String(profileId || 'default').slice(0, 512), 'utf8')
    .digest('base64url');
}

function validBinary(value, max = 16 * 1024) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && /^[A-Za-z0-9+/_=-]+$/.test(value);
}

function normalizeCredential(value) {
  if (!value || typeof value !== 'object') return null;
  const credentialId = String(value.credentialId || '');
  const privateKey = String(value.privateKey || '');
  const rpId = String(value.rpId || '').trim().toLowerCase();
  if (!validBinary(credentialId, 4096)
      || !validBinary(privateKey, 16 * 1024)
      || !rpId || rpId.length > 253 || !/^[a-z0-9.-]+$/.test(rpId)) return null;
  const signCount = Number(value.signCount);
  if (!Number.isFinite(signCount) || signCount < -1 || signCount > Number.MAX_SAFE_INTEGER) return null;
  const credential = {
    credentialId,
    isResidentCredential: Boolean(value.isResidentCredential),
    rpId,
    privateKey,
    signCount: Math.trunc(signCount)
  };
  if (validBinary(value.userHandle, 1024)) credential.userHandle = String(value.userHandle);
  if (validBinary(value.largeBlob, 256 * 1024)) credential.largeBlob = String(value.largeBlob);
  if (typeof value.backupEligibility === 'boolean') credential.backupEligibility = value.backupEligibility;
  if (typeof value.backupState === 'boolean') credential.backupState = value.backupState;
  if (typeof value.userName === 'string') credential.userName = value.userName.slice(0, 256);
  if (typeof value.userDisplayName === 'string') credential.userDisplayName = value.userDisplayName.slice(0, 256);
  return credential;
}

function strongStorageStatus(safeStorageImpl, platform = process.platform) {
  if (platform !== 'linux') return { available: false, reason: 'native-platform-authenticator' };
  try {
    if (!safeStorageImpl?.isEncryptionAvailable?.()) {
      return { available: false, reason: 'secure-storage-unavailable' };
    }
    const backend = String(safeStorageImpl.getSelectedStorageBackend?.() || '').toLowerCase();
    // Fail closed for unknown future backends too: only Electron backends
    // currently backed by a Linux secret service are safe for website keys.
    if (!STRONG_LINUX_STORAGE_BACKENDS.has(backend)) {
      return { available: false, reason: 'secure-storage-unavailable' };
    }
    return { available: true, backend };
  } catch {
    return { available: false, reason: 'secure-storage-unavailable' };
  }
}

function findPkexec(fsImpl) {
  for (const candidate of ['/usr/bin/pkexec', '/bin/pkexec', '/usr/local/bin/pkexec']) {
    try { if (fsImpl?.existsSync?.(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

function createPolicyKitAuthorizer({ fsImpl, spawnImpl = spawn, timeoutMs = SYSTEM_AUTH_TIMEOUT_MS } = {}) {
  const executable = findPkexec(fsImpl);
  const available = Boolean(executable && typeof spawnImpl === 'function');
  const authorize = () => {
    if (!available) return Promise.resolve({ ok: false, prompted: false, reason: 'system-auth-unavailable' });
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        child = spawnImpl(executable, ['/bin/true'], { stdio: 'ignore' });
      } catch (error) {
        finish({ ok: false, prompted: false, reason: 'system-auth-unavailable', detail: String(error?.message || error) });
        return;
      }
      timer = setTimeout(() => {
        try { child?.kill?.(); } catch { /* best effort */ }
        finish({ ok: false, prompted: true, reason: 'user-declined-or-timeout' });
      }, timeoutMs);
      timer?.unref?.();
      child?.once?.('error', (error) => {
        finish({ ok: false, prompted: false, reason: 'system-auth-unavailable', detail: String(error?.message || error) });
      });
      child?.once?.('exit', (code) => {
        finish(code === 0
          ? { ok: true, prompted: true }
          : { ok: false, prompted: true, reason: 'user-declined-or-timeout' });
      });
    });
  };
  return { available, executable, authorize };
}

function createWebsitePasskeyProvider({
  fsImpl,
  pathImpl,
  userDataDir,
  safeStorageImpl,
  platform = process.platform,
  spawnImpl = spawn,
  authorizeImpl = null,
  commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
  logger = console
} = {}) {
  const storage = strongStorageStatus(safeStorageImpl, platform);
  const policyKit = createPolicyKitAuthorizer({ fsImpl, spawnImpl });
  // Strong encrypted storage is the provider prerequisite. PolicyKit is a
  // fallback verifier, not an availability gate: the desktop Yayra passkey
  // can authorize a ceremony with a main-process one-shot grant even on a
  // Linux setup where pkexec is not installed.
  const globallyAvailable = storage.available;
  const globalReason = storage.reason;
  const filePath = pathImpl?.join?.(userDataDir || '', STORE_FILE) || STORE_FILE;
  const backupPath = `${filePath}.bak`;
  const states = new Map();
  const profileApprovals = new Map();
  let vault = { version: STORE_VERSION, profiles: Object.create(null) };
  let storeFailureReason = '';

  function decryptVault(pathname) {
    try {
      if (!fsImpl?.existsSync?.(pathname)) return null;
      const envelope = JSON.parse(fsImpl.readFileSync(pathname, 'utf8'));
      if (envelope?.version !== STORE_VERSION
          || !validBinary(envelope.encrypted, MAX_STORE_ENVELOPE_CHARS)) return null;
      const clear = safeStorageImpl.decryptString(Buffer.from(envelope.encrypted, 'base64'));
      const parsed = JSON.parse(clear);
      if (parsed?.version !== STORE_VERSION || !parsed.profiles || typeof parsed.profiles !== 'object') return null;
      const profiles = Object.create(null);
      for (const [key, list] of Object.entries(parsed.profiles)) {
        if (!/^[A-Za-z0-9_-]{1,180}$/.test(key) || !Array.isArray(list)) continue;
        profiles[key] = list.map(normalizeCredential).filter(Boolean).slice(0, MAX_PROFILE_CREDENTIALS);
      }
      return { version: STORE_VERSION, profiles };
    } catch {
      return null;
    }
  }

  function loadVault() {
    if (!storage.available) return;
    let mainExists = false;
    let backupExists = false;
    try {
      mainExists = Boolean(fsImpl?.existsSync?.(filePath));
      backupExists = Boolean(fsImpl?.existsSync?.(backupPath));
    } catch { /* decrypt attempts below still decide availability */ }
    const main = decryptVault(filePath);
    if (main) { vault = main; return; }
    const backup = decryptVault(backupPath);
    if (backup) {
      vault = backup;
      try {
        fsImpl.copyFileSync(backupPath, filePath);
        fsImpl.chmodSync?.(filePath, 0o600);
      } catch { /* backup remains usable in place */ }
      logger?.warn?.('[yayra:site-passkeys] encrypted credential store restored from backup');
      return;
    }
    if (mainExists || backupExists) {
      // Never overwrite an unreadable store with an empty one. The user may
      // have changed keyrings or the file may be corrupt; external handoff is
      // safer than silently orphaning every registered website credential.
      storeFailureReason = 'credential-store-unreadable';
      logger?.error?.('[yayra:site-passkeys] encrypted credential store is unreadable; local provider disabled');
    }
  }

  function writeEnvelope(pathname, envelope) {
    fsImpl.writeFileSync(pathname, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    try { fsImpl.chmodSync?.(pathname, 0o600); } catch { /* best effort on non-POSIX test hosts */ }
  }

  function saveVault() {
    if (!storage.available || storeFailureReason) return false;
    const temporary = `${filePath}.tmp`;
    const backupTemporary = `${backupPath}.tmp`;
    try {
      fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true, mode: 0o700 });
      try { fsImpl.chmodSync?.(pathImpl.dirname(filePath), 0o700); } catch { /* existing app directory may be broader */ }
      const encrypted = safeStorageImpl.encryptString(JSON.stringify(vault));
      const envelope = { version: STORE_VERSION, encrypted: Buffer.from(encrypted).toString('base64') };
      if (!validBinary(envelope.encrypted, MAX_STORE_ENVELOPE_CHARS)) throw new Error('credential-store-too-large');
      writeEnvelope(temporary, envelope);
      // Verify the exact bytes on disk before replacing the last known-good
      // store. This catches truncated writes and keyring round-trip failures.
      if (!decryptVault(temporary)) throw new Error('credential-store-verification-failed');
      fsImpl.renameSync(temporary, filePath);
      try {
        writeEnvelope(backupTemporary, envelope);
        if (!decryptVault(backupTemporary)) throw new Error('credential-backup-verification-failed');
        fsImpl.renameSync(backupTemporary, backupPath);
      } catch (backupError) {
        try { fsImpl.unlinkSync?.(backupTemporary); } catch { /* best effort */ }
        logger?.warn?.(`[yayra:site-passkeys] encrypted credential backup could not be refreshed: ${backupError?.message || backupError}`);
        // The atomically replaced and verified primary store is sufficient;
        // retain any previous known-good backup rather than fail the ceremony.
      }
      return true;
    } catch (error) {
      try { fsImpl.unlinkSync?.(temporary); } catch { /* best effort */ }
      try { fsImpl.unlinkSync?.(backupTemporary); } catch { /* best effort */ }
      logger?.error?.(`[yayra:site-passkeys] could not persist encrypted credentials: ${error?.message || error}`);
      return false;
    }
  }

  function profileCredentials(profileKey) {
    const list = vault.profiles[profileKey];
    return Array.isArray(list) ? list : [];
  }

  function setProfileCredentials(profileKey, list) {
    vault.profiles[profileKey] = list.map(normalizeCredential).filter(Boolean).slice(0, MAX_PROFILE_CREDENTIALS);
  }

  loadVault();

  function describe({ webContents, isPrivate = false } = {}) {
    if (platform !== 'linux') return { mode: 'native', available: false, reason: 'native-platform-authenticator' };
    if (isPrivate) return { mode: 'external', available: false, reason: 'private-tab' };
    if (!globallyAvailable) return { mode: 'external', available: false, reason: globalReason };
    if (storeFailureReason) return { mode: 'external', available: false, reason: storeFailureReason };
    const state = states.get(webContents);
    if (state?.failed) return { mode: 'external', available: false, reason: state.reason || 'provider-unavailable' };
    return { mode: 'local', available: true, reason: state?.ready ? '' : 'initializing' };
  }

  /**
   * Request-aware capability check. A generic virtual authenticator existing
   * is not proof that Yayra owns the credential a site is requesting. For an
   * assertion, advertise the local route only when this exact profile has at
   * least one encrypted credential for the RP; otherwise fail fast to the
   * honest system-browser path instead of releasing a request that can hang.
   */
  function describeRequest({ webContents, isPrivate = false, action, rpId } = {}) {
    const base = describe({ webContents, isPrivate });
    if (base.mode !== 'local' || action !== 'get') return base;
    const relyingPartyId = typeof rpId === 'string' && /^[a-z0-9.-]{1,253}$/i.test(rpId)
      ? rpId.toLowerCase()
      : '';
    const state = states.get(webContents);
    if (!relyingPartyId || !state?.ready) return base;
    const credentialCount = profileCredentials(state.profileKey)
      .filter((credential) => credential.rpId === relyingPartyId).length;
    if (credentialCount === 0) {
      return { mode: 'external', available: false, reason: 'no-local-credential', credentialCount: 0 };
    }
    return { ...base, credentialCount };
  }

  async function send(state, method, params = {}) {
    if (!state?.webContents || state.webContents.isDestroyed?.()) throw new Error('view-destroyed');
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(state.webContents.debugger.sendCommand(method, params)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`protocol-timeout:${method}`)), Math.max(1, Number(commandTimeoutMs) || CDP_COMMAND_TIMEOUT_MS));
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function releaseApproval(state) {
    const lock = state ? profileApprovals.get(state.profileKey) : null;
    if (lock?.state === state) profileApprovals.delete(state.profileKey);
    if (state) state.approvingRequestId = null;
  }

  async function resetPresence(state) {
    if (!state) return;
    if (state.resetTimer) clearTimeout(state.resetTimer);
    state.resetTimer = null;
    if (state.ready && state.authenticatorId) {
      try {
        await send(state, 'WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId: state.authenticatorId,
          enabled: false
        });
        await send(state, 'WebAuthn.setUserVerified', {
          authenticatorId: state.authenticatorId,
          isUserVerified: false
        });
      } catch { /* detached/navigated view already fails closed */ }
    }
    state.presenceActive = false;
    // A page can settle while PolicyKit is still in front. Keep the lock until
    // that authorizer returns, then isStillActive() will reject the old page.
    if (!state.authorizing) releaseApproval(state);
  }

  async function syncCredentialToPeers(sourceState, credential) {
    const normalized = normalizeCredential(credential);
    if (!normalized) return;
    for (const peer of states.values()) {
      if (peer === sourceState || !peer.ready || peer.profileKey !== sourceState.profileKey) continue;
      try {
        if (!peer.credentialIds.has(normalized.credentialId)) {
          await send(peer, 'WebAuthn.addCredential', {
            authenticatorId: peer.authenticatorId,
            credential: normalized
          });
          peer.credentialIds.add(normalized.credentialId);
        } else {
          await send(peer, 'WebAuthn.setCredentialProperties', {
            authenticatorId: peer.authenticatorId,
            credentialId: normalized.credentialId,
            signCount: normalized.signCount,
            ...(typeof normalized.backupEligibility === 'boolean'
              ? { backupEligibility: normalized.backupEligibility }
              : {}),
            ...(typeof normalized.backupState === 'boolean'
              ? { backupState: normalized.backupState }
              : {})
          });
        }
      } catch { /* peer will hydrate from disk when recreated */ }
    }
  }

  function markCredentialStoreFailed(state) {
    storeFailureReason = 'credential-store-write-failed';
    if (state) {
      state.failed = true;
      state.reason = storeFailureReason;
    }
  }

  async function rememberCredential(state, rawCredential) {
    const credential = normalizeCredential(rawCredential);
    if (!credential) return;
    const list = profileCredentials(state.profileKey);
    const previous = list.map((item) => ({ ...item }));
    const index = list.findIndex((item) => item.credentialId === credential.credentialId);
    const isNew = index < 0;
    if (index >= 0 && JSON.stringify(list[index]) === JSON.stringify(credential)) return;
    if (index >= 0) list[index] = credential;
    else {
      const sameRpCount = list.filter((item) => item.rpId === credential.rpId).length;
      if (list.length >= MAX_PROFILE_CREDENTIALS || sameRpCount >= MAX_RP_CREDENTIALS) {
        logger?.warn?.(`[yayra:site-passkeys] credential limit reached for ${credential.rpId}`);
        try {
          await send(state, 'WebAuthn.removeCredential', {
            authenticatorId: state.authenticatorId,
            credentialId: credential.credentialId
          });
        } catch { /* request will fail rather than leave an unpersisted key */ }
        return;
      }
      list.push(credential);
    }
    setProfileCredentials(state.profileKey, list);
    state.credentialIds.add(credential.credentialId);
    if (!saveVault()) {
      // A credential that exists only until the next restart is worse than a
      // failed ceremony. Roll the in-memory mutation back, remove any newly
      // generated key from Chromium, and disable local ceremonies globally.
      setProfileCredentials(state.profileKey, previous);
      if (isNew) {
        state.credentialIds.delete(credential.credentialId);
        try {
          await send(state, 'WebAuthn.removeCredential', {
            authenticatorId: state.authenticatorId,
            credentialId: credential.credentialId
          });
        } catch { /* provider is disabled below regardless */ }
      }
      await resetPresence(state);
      markCredentialStoreFailed(state);
      return;
    }
    await syncCredentialToPeers(state, credential);
  }

  async function forgetCredential(state, credentialId) {
    const id = String(credentialId || '');
    if (!id) return;
    const list = profileCredentials(state.profileKey);
    const previous = list.map((item) => ({ ...item }));
    const next = list.filter((item) => item.credentialId !== id);
    if (next.length === list.length) return;
    setProfileCredentials(state.profileKey, next);
    state.credentialIds.delete(id);
    if (!saveVault()) {
      setProfileCredentials(state.profileKey, previous);
      state.credentialIds.add(id);
      await resetPresence(state);
      markCredentialStoreFailed(state);
      return;
    }
    for (const peer of states.values()) {
      if (peer === state || !peer.ready || peer.profileKey !== state.profileKey || !peer.credentialIds.has(id)) continue;
      try {
        await send(peer, 'WebAuthn.removeCredential', {
          authenticatorId: peer.authenticatorId,
          credentialId: id
        });
        peer.credentialIds.delete(id);
      } catch { /* peer is being destroyed */ }
    }
  }

  function onDebuggerMessage(state, _event, method, params = {}) {
    if (!state.ready || state.tearingDown || params.authenticatorId !== state.authenticatorId) return;
    if (method === 'WebAuthn.credentialAdded'
        || method === 'WebAuthn.credentialUpdated'
        || method === 'WebAuthn.credentialAsserted') {
      Promise.resolve(rememberCredential(state, params.credential)).catch(() => {});
      // Do NOT reset UP/UV on credentialAdded/credentialAsserted. CDP emits
      // those events before Chromium has necessarily resolved the page's
      // WebAuthn promise; clearing presence here races the final response and
      // produced GitHub's permanent “Waiting for browser interaction” state.
      // The metadata-only preload settlement (or the bounded main watchdog)
      // calls settle() after the terminal page result instead.
    } else if (method === 'WebAuthn.credentialDeleted') {
      Promise.resolve(forgetCredential(state, params.credentialId)).catch(() => {});
    }
  }

  async function initializeState(state) {
    const wc = state.webContents;
    try {
      if (!wc?.debugger
          || typeof wc.debugger.attach !== 'function'
          || typeof wc.debugger.sendCommand !== 'function'
          || wc.debugger.isAttached?.()) {
        throw new Error('debugger-unavailable');
      }
      state.onMessage = (...args) => onDebuggerMessage(state, ...args);
      state.onDetach = () => {
        state.ready = false;
        if (!state.failed) {
          state.failed = true;
          state.reason = 'provider-detached';
        }
        if (state.resetTimer) clearTimeout(state.resetTimer);
      };
      wc.debugger.on?.('message', state.onMessage);
      wc.debugger.on?.('detach', state.onDetach);
      wc.debugger.attach('1.3');
      state.attachedByUs = true;
      await send(state, 'WebAuthn.enable', { enableUI: false });
      const created = await send(state, 'WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: false,
          isUserVerified: false
        }
      });
      state.authenticatorId = String(created?.authenticatorId || '');
      if (!state.authenticatorId) throw new Error('authenticator-unavailable');
      for (const credential of profileCredentials(state.profileKey)) {
        await send(state, 'WebAuthn.addCredential', {
          authenticatorId: state.authenticatorId,
          credential
        });
        state.credentialIds.add(credential.credentialId);
      }
      state.ready = true;
      state.reason = '';
      return { ok: true, mode: 'local' };
    } catch (error) {
      state.ready = false;
      state.failed = true;
      state.reason = String(error?.message || 'provider-unavailable').slice(0, 120);
      logger?.warn?.(`[yayra:site-passkeys] local Linux provider unavailable: ${state.reason}`);
      try {
        if (state.attachedByUs && wc?.debugger?.isAttached?.()) wc.debugger.detach();
      } catch { /* already detached */ }
      return { ok: false, mode: 'external', reason: state.reason };
    }
  }

  function attach({ webContents, profileId = 'default', isPrivate = false } = {}) {
    if (!webContents || isPrivate || !globallyAvailable || storeFailureReason || platform !== 'linux') {
      return Promise.resolve(describe({ webContents, isPrivate }));
    }
    if (states.has(webContents)) return states.get(webContents).readyPromise;
    const state = {
      webContents,
      profileKey: cleanProfileKey(profileId),
      isPrivate: false,
      ready: false,
      failed: false,
      reason: 'initializing',
      authenticatorId: '',
      credentialIds: new Set(),
      attachedByUs: false,
      tearingDown: false,
      authorizing: false,
      presenceActive: false,
      approvingRequestId: null,
      resetTimer: null,
      readyPromise: null,
      onMessage: null,
      onDetach: null
    };
    states.set(webContents, state);
    state.readyPromise = initializeState(state);
    webContents.once?.('destroyed', () => detach(webContents));
    return state.readyPromise;
  }

  async function confirm({
    webContents,
    requestId,
    action,
    rpId,
    userVerification = null,
    isStillActive = () => true
  } = {}) {
    const id = typeof requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(requestId)
      ? requestId
      : '';
    const relyingPartyId = typeof rpId === 'string' && rpId.length <= 253 && /^[a-z0-9.-]+$/i.test(rpId)
      ? rpId.toLowerCase()
      : '';
    if (!id || (action !== 'create' && action !== 'get') || !relyingPartyId) {
      return { ok: false, reason: 'invalid-request' };
    }
    const state = states.get(webContents);
    if (!state) return { ok: false, reason: globalReason || 'provider-unavailable' };
    await state.readyPromise;
    if (!state.ready || state.failed || storeFailureReason) {
      return { ok: false, reason: state.reason || storeFailureReason || 'provider-unavailable' };
    }
    if (state.approvingRequestId || profileApprovals.has(state.profileKey)) {
      return { ok: false, reason: 'request-already-prompting' };
    }
    // Prove that this profile's encrypted store can be atomically written and
    // decrypted before asking for a password or releasing authenticator
    // presence. A disk-full/keyring failure can therefore never knowingly
    // create a restart-lost credential.
    if (!saveVault()) {
      markCredentialStoreFailed(state);
      return { ok: false, reason: storeFailureReason };
    }
    const credentials = profileCredentials(state.profileKey);
    const relyingPartyCredentials = credentials.filter((item) => item.rpId === relyingPartyId);
    if (action === 'get' && relyingPartyCredentials.length === 0) {
      return { ok: false, reason: 'no-local-credential' };
    }
    if (action === 'create'
        && (credentials.length >= MAX_PROFILE_CREDENTIALS
          || relyingPartyCredentials.length >= MAX_RP_CREDENTIALS)) {
      return { ok: false, reason: 'credential-limit-reached' };
    }
    state.approvingRequestId = id;
    state.authorizing = true;
    profileApprovals.set(state.profileKey, { state, requestId: id });
    let gate;
    const trustedYayraVerification = userVerification?.verified === true
      && userVerification?.method === 'yayra-passkey';
    try {
      gate = trustedYayraVerification
        ? { ok: true, prompted: true }
        : typeof authorizeImpl === 'function'
          ? await authorizeImpl({ action, rpId: relyingPartyId })
          : await policyKit.authorize({ action, rpId: relyingPartyId });
    } catch (error) {
      state.authorizing = false;
      releaseApproval(state);
      return {
        ok: false,
        reason: 'system-auth-unavailable',
        detail: String(error?.message || error).slice(0, 120)
      };
    }
    state.authorizing = false;
    if (!gate?.ok) {
      releaseApproval(state);
      return { ok: false, reason: gate?.reason || 'user-declined-or-timeout', prompted: Boolean(gate?.prompted) };
    }
    if (!isStillActive()) {
      releaseApproval(state);
      return { ok: false, reason: 'request-ended' };
    }
    try {
      await send(state, 'WebAuthn.setUserVerified', {
        authenticatorId: state.authenticatorId,
        isUserVerified: true
      });
      await send(state, 'WebAuthn.setAutomaticPresenceSimulation', {
        authenticatorId: state.authenticatorId,
        enabled: true
      });
      state.presenceActive = true;
      state.resetTimer = setTimeout(() => resetPresence(state), PRESENCE_RESET_MS);
      state.resetTimer?.unref?.();
      return {
        ok: true,
        prompted: Boolean(gate?.prompted),
        verification: trustedYayraVerification ? 'yayra-passkey' : 'system-auth',
        presenceExpiresInMs: PRESENCE_RESET_MS
      };
    } catch (error) {
      await resetPresence(state);
      return { ok: false, reason: String(error?.message || 'provider-unavailable').slice(0, 120) };
    }
  }

  async function settle({ webContents, requestId } = {}) {
    const state = states.get(webContents);
    if (!state || (state.approvingRequestId && state.approvingRequestId !== String(requestId || ''))) return;
    await resetPresence(state);
  }

  function detach(webContents) {
    const state = states.get(webContents);
    if (!state) return;
    state.tearingDown = true;
    state.authorizing = false;
    releaseApproval(state);
    states.delete(webContents);
    if (state.resetTimer) clearTimeout(state.resetTimer);
    try { webContents.debugger.removeListener?.('message', state.onMessage); } catch { /* already detached */ }
    try { webContents.debugger.removeListener?.('detach', state.onDetach); } catch { /* already detached */ }
    try {
      if (state.attachedByUs && webContents.debugger.isAttached?.()) {
        if (state.authenticatorId) {
          Promise.resolve(webContents.debugger.sendCommand('WebAuthn.removeVirtualAuthenticator', {
            authenticatorId: state.authenticatorId
          })).catch(() => {});
        }
        webContents.debugger.detach();
      }
    } catch { /* view is already gone */ }
  }

  function destroy() {
    for (const webContents of Array.from(states.keys())) detach(webContents);
  }

  return {
    attach,
    confirm,
    settle,
    detach,
    destroy,
    describe,
    describeRequest,
    _filePath: filePath,
    _states: states,
    _storage: storage,
    _policyKit: policyKit
  };
}

module.exports = {
  STORE_FILE,
  cleanProfileKey,
  normalizeCredential,
  strongStorageStatus,
  findPkexec,
  createPolicyKitAuthorizer,
  createWebsitePasskeyProvider
};
