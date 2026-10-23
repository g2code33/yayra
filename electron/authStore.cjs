'use strict';

/**
 * Persists Yayra's app-level Google session for one browsing profile.
 *
 * Security design:
 *   - Only the non-sensitive Google profile (sub/email/name/picture) crosses
 *     IPC. Access and refresh tokens remain in the Electron main process.
 *   - Token JSON is encrypted with Electron safeStorage (the OS keychain)
 *     before disk persistence. Raw credentials are never written.
 *   - Every Yayra browsing profile gets a different file. The default
 *     profile deliberately retains the legacy `google-session.json` path,
 *     which migrates existing users without copying or re-encrypting tokens.
 *     Non-default filenames are a SHA-256 digest of the validated profile id,
 *     so a renderer-controlled value can never become a path traversal.
 *
 * Fully dependency-injected for tests; no Electron runtime is required.
 */

const path = require('node:path');
const { createHash } = require('node:crypto');

const FILE_NAME = 'google-session.json';
const DEFAULT_PROFILE_ID = 'default';
const MAX_PROFILE_ID_LENGTH = 160;

function normalizeAuthProfileId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > MAX_PROFILE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(id)) return DEFAULT_PROFILE_ID;
  return id;
}

function fileNameForProfile(profileId = DEFAULT_PROFILE_ID) {
  const id = normalizeAuthProfileId(profileId);
  if (id === DEFAULT_PROFILE_ID) return FILE_NAME;
  const digest = createHash('sha256').update(id, 'utf8').digest('hex');
  return `google-session-${digest}.json`;
}

function createAuthStore({ fs, safeStorageImpl, userDataDir, profileId = DEFAULT_PROFILE_ID }) {
  const normalizedProfileId = normalizeAuthProfileId(profileId);
  const filePath = path.join(userDataDir, fileNameForProfile(normalizedProfileId));

  function isEncryptionAvailable() {
    try {
      return Boolean(safeStorageImpl && safeStorageImpl.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  function save({ profile, tokens }) {
    const payload = {
      version: 2,
      profileId: normalizedProfileId,
      profile,
      savedAt: new Date().toISOString()
    };
    if (isEncryptionAvailable() && tokens) {
      const encrypted = safeStorageImpl.encryptString(JSON.stringify(tokens));
      payload.tokensEncrypted = encrypted.toString('base64');
    } else if (tokens) {
      // No OS keychain available (e.g. some headless Linux CI environments).
      // Do not persist raw tokens unencrypted; the user will simply need to
      // sign in again next launch. The display profile alone is harmless.
      payload.tokensEncrypted = null;
      payload.encryptionUnavailable = true;
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
    return payload;
  }

  function load() {
    if (!fs.existsSync(filePath)) return null;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
    // Legacy default sessions had no version/profileId fields. They remain
    // valid only for the default store because only that store uses the old
    // filename. A scoped file whose embedded id does not match is ignored.
    if (payload?.profileId && normalizeAuthProfileId(payload.profileId) !== normalizedProfileId) return null;
    let tokens = null;
    if (payload.tokensEncrypted && isEncryptionAvailable()) {
      try {
        const decrypted = safeStorageImpl.decryptString(Buffer.from(payload.tokensEncrypted, 'base64'));
        tokens = JSON.parse(decrypted);
      } catch {
        tokens = null;
      }
    }
    return { profile: payload.profile || null, tokens, savedAt: payload.savedAt || null };
  }

  function clear() {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Local sign-out remains authoritative even if cleanup raced shutdown.
    }
  }

  return {
    save,
    load,
    clear,
    profileId: normalizedProfileId,
    filePath
  };
}

module.exports = {
  createAuthStore,
  fileNameForProfile,
  normalizeAuthProfileId,
  FILE_NAME,
  DEFAULT_PROFILE_ID
};
