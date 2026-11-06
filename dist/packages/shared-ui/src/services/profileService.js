// Yayra Browser Profiles - the "keep your browsing separate" brain.
//
// This powers the Chrome-style smart prompt: when somebody signs in to a
// site (or to Yayra itself) with an account that is NOT the account this
// profile belongs to, Yayra offers to keep that person's browsing in
// their own profile instead of mixing cookies, logins and passwords into
// the current one.
//
// What a profile actually separates:
//   - Electron desktop: each profile gets its own persistent Chromium
//     session partition for REAL web content (cookies, site logins,
//     localStorage of visited sites) - see electron/webviewBridge.cjs.
//   - All platforms: which account the profile "belongs" to, and the
//     memory of which accounts the user said "No thanks" for (so the
//     prompt is never a nag).
//
// Pure + dependency-injected (storage is any localStorage-shaped object),
// so the whole decision table is unit-testable. See
// tests/profile-service.test.mjs.

const STORAGE_KEY = 'yayra:profiles';

export const PROFILE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];

export const DEFAULT_PROFILE_ID = 'default';

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  // Only full account identifiers participate in profile logic: a plain
  // site username like "jess92" is not evidence of a different person.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function displayNameFromEmail(email) {
  const local = String(email).split('@')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export class ProfileService {
  constructor({ storage = null, now = () => Date.now() } = {}) {
    this.storage = storage;
    this.now = now;
    this.state = this.load();
    // A native/web profile window can be pinned to a profile without
    // rewriting the shared persisted `currentId`. Otherwise booting Work in
    // a second window silently changes which identity the already-open
    // Personal window (or the next main window) considers current.
    this.windowProfileId = null;
  }

  load() {
    let raw = null;
    try {
      raw = this.storage ? this.storage.getItem(STORAGE_KEY) : null;
    } catch {
      raw = null;
    }
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
      parsed = {
        profiles: [{
          id: DEFAULT_PROFILE_ID,
          name: 'My profile',
          email: null,
          color: PROFILE_COLORS[0],
          createdAt: this.now(),
          lastUsedAt: this.now()
        }],
        currentId: DEFAULT_PROFILE_ID,
        dismissed: []
      };
    }
    if (!parsed.profiles.some((p) => p.id === parsed.currentId)) {
      parsed.currentId = parsed.profiles[0].id;
    }
    if (!Array.isArray(parsed.dismissed)) parsed.dismissed = [];
    return parsed;
  }

  persist() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // storage full/unavailable - profiles still work for this session
    }
  }

  list() {
    return this.state.profiles.slice();
  }

  current() {
    const currentId = this.windowProfileId || this.state.currentId;
    return this.state.profiles.find((p) => p.id === currentId) || this.state.profiles[0];
  }

  /**
   * Bind only this service/window instance. Unlike switchTo(), this never
   * changes shared storage's global currentId, so two live windows retain
   * independent identities even though their profile metadata is shared.
   */
  bindToWindow(profileId) {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile) return null;
    this.windowProfileId = profile.id;
    profile.lastUsedAt = this.now();
    return profile;
  }

  getProfileForEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.state.profiles.find((p) => p.email === normalized) || null;
  }

  createProfile({ name = null, email = null } = {}) {
    const normalized = normalizeEmail(email);
    const profile = {
      id: `profile-${this.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: name || (normalized ? displayNameFromEmail(normalized) : `Profile ${this.state.profiles.length + 1}`),
      email: normalized,
      color: PROFILE_COLORS[this.state.profiles.length % PROFILE_COLORS.length],
      createdAt: this.now(),
      lastUsedAt: this.now()
    };
    this.state.profiles.push(profile);
    this.persist();
    return profile;
  }

  switchTo(profileId) {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile) return null;
    this.windowProfileId = null;
    this.state.currentId = profile.id;
    profile.lastUsedAt = this.now();
    this.persist();
    return profile;
  }

  renameProfile(profileId, name) {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile || !String(name || '').trim()) return null;
    profile.name = String(name).trim();
    this.persist();
    return profile;
  }

  deleteProfile(profileId) {
    // The last remaining profile can never be deleted; deleting the
    // current one falls back to the first remaining profile.
    if (this.state.profiles.length <= 1) return false;
    const idx = this.state.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) return false;
    this.state.profiles.splice(idx, 1);
    if (this.windowProfileId === profileId) this.windowProfileId = null;
    if (this.state.currentId === profileId) {
      this.state.currentId = this.state.profiles[0].id;
      this.state.profiles[0].lastUsedAt = this.now();
    }
    this.persist();
    return true;
  }

  dismissAccount(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    if (!this.state.dismissed.includes(normalized)) {
      this.state.dismissed.push(normalized);
      this.persist();
    }
  }

  /**
   * The smart part - decides what a sign-in with `email` means for
   * profile separation. Returns one of:
   *   { action: 'none' }                      - nothing to do
   *   { action: 'adopted', profile }          - current profile had no
   *       account yet; it now belongs to this email (Chrome's silent
   *       first-sign-in binding - no prompt)
   *   { action: 'suggest-switch', profile }   - this email already has
   *       its own profile; offer to switch to it
   *   { action: 'suggest-create', email }     - a DIFFERENT person signed
   *       in; offer to create a separate profile for them
   * "No thanks" answers are remembered forever (per email) so the prompt
   * never becomes a nag loop.
   */
  evaluateSignIn(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return { action: 'none' };
    if (this.state.dismissed.includes(normalized)) return { action: 'none' };

    const current = this.current();
    if (current.email === normalized) return { action: 'none' };

    if (!current.email) {
      current.email = normalized;
      if (current.name === 'My profile') current.name = displayNameFromEmail(normalized);
      this.persist();
      return { action: 'adopted', profile: current };
    }

    const owner = this.getProfileForEmail(normalized);
    if (owner) return { action: 'suggest-switch', profile: owner };
    return { action: 'suggest-create', email: normalized };
  }
}

export default ProfileService;
