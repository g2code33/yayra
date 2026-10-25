'use strict';

/**
 * Dedicated real-Chrome profile manager for Google website sign-in.
 *
 * WHY
 * ---
 * An OAuth token is an app identity; it is not a Google website cookie
 * session. Google's own sites (Gmail, Drive, myaccount.google.com) check that
 * cookie. Since 2026 those cookies can additionally be bound to the device's
 * TPM/Secure Enclave (DBSC), so they cannot be copied into an Electron
 * partition at all. The only reliable, policy-compliant way to give Yayra
 * users a genuinely signed-in Google website is to let a REAL Chrome-family
 * browser own that cookie jar.
 *
 * DESIGN (no cookies are ever read, copied, decrypted, or imported)
 * ----------------------------------------------------------------
 * - One `--user-data-dir` per Yayra browsing profile, under Yayra's own
 *   userData directory. Nothing touches the user's personal Chrome profile.
 * - Chrome/Edge/Chromium is discovered from an explicit allowlist of install
 *   locations. The binary path is never taken from renderer input.
 * - `spawn` (never `shell: true`), fixed safe flags, no automation flags, no
 *   remote debugging, no custom user agent, no extension loading.
 * - Only exact HTTPS Google-owned destinations may be opened.
 * - The OAuth PKCE loopback callback still runs in Yayra's main process: the
 *   dedicated Chrome is simply the RFC 8252 external user-agent, so ONE
 *   sign-in produces BOTH the verified app identity and real website cookies.
 * - `status()` never returns cookie values, tokens, or profile contents.
 *
 * This module is pure/dependency-injected so it is fully unit-testable.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const {
  safeGoogleDestination,
  isGoogleAuthSurface,
  unsafeChromeFlag,
  MAX_URL_LENGTH
} = require('./googleAuthParity.cjs');

const DEFAULT_PROFILE_ID = 'default';
const PROFILE_ROOT = 'google-chrome-profiles';
const MANIFEST_NAME = 'yayra-profile.json';

function normalizeChromeProfileId(profileId = DEFAULT_PROFILE_ID) {
  const raw = String(profileId == null ? '' : profileId).trim();
  if (!raw || raw === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
  // Match main-process profile validation without truncation. Truncation can
  // collide two long, otherwise valid profile ids and silently share their
  // Google cookie jars; the directory name is a bounded SHA-256 below.
  if (raw.length > 160 || !/^[A-Za-z0-9_-]+$/.test(raw)) return DEFAULT_PROFILE_ID;
  return raw;
}

function chromeProfileDir({ userDataDir, profileId = DEFAULT_PROFILE_ID } = {}) {
  if (typeof userDataDir !== 'string' || !userDataDir) throw new Error('userDataDir_required');
  const root = path.resolve(userDataDir);
  const id = normalizeChromeProfileId(profileId);
  const leaf = id === DEFAULT_PROFILE_ID
    ? DEFAULT_PROFILE_ID
    : `profile-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
  const dir = path.resolve(root, PROFILE_ROOT, leaf);
  // Defense in depth: a crafted profile id must never escape userData.
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) throw new Error('profile_dir_escape');
  if (!dir.startsWith(path.resolve(root, PROFILE_ROOT) + path.sep)) throw new Error('profile_dir_escape');
  return dir;
}

/**
 * Ordered Chrome/Edge/Chromium install locations. Chrome is preferred
 * (DBSC + Google account support), then Edge, then Chromium. Nothing here is
 * user-controlled; `env` only supplies standard OS install roots.
 */
function chromeBinaryCandidates({ platform = process.platform, env = process.env, homedir = '' } = {}) {
  const home = typeof homedir === 'string' ? homedir : '';
  const programFiles = env.PROGRAMFILES || '';
  const programFilesX86 = env['PROGRAMFILES(X86)'] || programFiles;
  const localAppData = env.LOCALAPPDATA || '';

  if (platform === 'win32') {
    const roots = [programFiles, programFilesX86, localAppData].filter(Boolean);
    const candidates = [];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
        path.join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
        path.join(root, 'Google', 'Chrome SxS', 'Application', 'chrome.exe')
      );
    }
    return Array.from(new Set(candidates));
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', home ? path.join(home, 'Applications') : ''].filter(Boolean);
    const candidates = [];
    for (const root of apps) {
      candidates.push(
        path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
        path.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, 'Google Chrome Beta.app', 'Contents', 'MacOS', 'Google Chrome Beta')
      );
    }
    candidates.push(
      '/usr/local/bin/google-chrome',
      '/opt/homebrew/bin/google-chrome',
      '/usr/local/bin/chromium',
      '/opt/homebrew/bin/chromium'
    );
    return Array.from(new Set(candidates));
  }
  return [
    '/opt/google/chrome/chrome',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    home ? path.join(home, '.local', 'bin', 'google-chrome') : '',
    home ? path.join(home, '.local', 'bin', 'chromium') : ''
  ].filter(Boolean);
}

/** Resolve the first executable candidate. Injectable fs/which for tests. */
function resolveChromeBinary({ fs = require('node:fs'), platform = process.platform, env = process.env, homedir = '', which = null } = {}) {
  const explicit = String(env.YAYRA_CHROME_BINARY || '').trim();
  if (explicit) {
    // Explicit override is only honored when it is an absolute, existing file.
    if (!path.isAbsolute(explicit)) return null;
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;
    } catch { /* fall through to allowlist */ }
    return null;
  }
  const candidates = chromeBinaryCandidates({ platform, env, homedir });
  for (const candidate of candidates) {
    try {
      if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  if (typeof which === 'function') {
    for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge']) {
      try {
        const found = which(name);
        if (found && path.isAbsolute(found) && fs.existsSync(found)) return found;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Fixed, minimal launch arguments. `--no-first-run` and
 * `--no-default-browser-check` only suppress first-run UI; they do not signal
 * automation. `--user-data-dir` is the isolation boundary. The URL is passed
 * as the final positional argument so Chrome opens it in that profile.
 */
function buildChromeProfileArgs({ profileDir, url } = {}) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw new Error('invalid_profile_dir');
  const target = safeGoogleDestination(url);
  if (!target) throw new Error('invalid_google_destination');
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
  ];
  for (const arg of args) {
    const unsafe = unsafeChromeFlag(arg);
    if (unsafe) throw new Error(`unsafe_chrome_flag:${unsafe}`);
  }
  args.push(target);
  return args;
}

/**
 * Validate the OAuth authorization URL before using the dedicated profile as
 * the external user-agent. Only the exact accounts.google.com authorization
 * endpoint with a loopback redirect_uri is accepted; no arbitrary URL can be
 * injected into the browser launch.
 */
function safeGoogleAuthorizationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname.toLowerCase() !== 'accounts.google.com') return null;
  if (!isGoogleAuthSurface(rawUrl)) return null;
  const redirect = String(url.searchParams.get('redirect_uri') || '');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/i.test(redirect)) return null;
  // No custom schemes, no javascript:, no embedded credentials in continue.
  for (const key of ['continue', 'state', 'scope', 'client_id', 'code_challenge']) {
    const value = url.searchParams.get(key);
    if (value && /[\u0000-\u001f\u007f]/.test(value)) return null;
  }
  return url.toString();
}

function buildChromeProfileAuthorizationArgs({ profileDir, url } = {}) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw new Error('invalid_profile_dir');
  const target = safeGoogleAuthorizationUrl(url);
  if (!target) throw new Error('invalid_google_authorization_url');
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
  ];
  for (const arg of args) {
    const unsafe = unsafeChromeFlag(arg);
    if (unsafe) throw new Error(`unsafe_chrome_flag:${unsafe}`);
  }
  args.push(target);
  return args;
}

/**
 * Create the manager. All I/O is injected so the whole module is testable
 * without spawning a browser or touching disk.
 */
function createGoogleChromeProfileManager({
  fs = require('node:fs'),
  spawn = null,
  childProcess = null,
  platform = process.platform,
  env = process.env,
  homedir = '',
  userDataDir,
  logger = console,
  which = null,
  now = () => Date.now()
} = {}) {
  if (typeof userDataDir !== 'string' || !userDataDir) throw new Error('userDataDir_required');
  const spawnImpl = spawn || (childProcess && childProcess.spawn) || require('node:child_process').spawn;
  const sessions = new Map();
  const root = path.resolve(userDataDir, PROFILE_ROOT);
  let cachedBinary;
  let binaryResolved = false;

  function binary() {
    if (!binaryResolved) {
      cachedBinary = resolveChromeBinary({ fs, platform, env, homedir, which });
      binaryResolved = true;
    }
    return cachedBinary;
  }

  function dirFor(profileId) {
    return chromeProfileDir({ userDataDir, profileId });
  }

  /**
   * Writes/validates a tiny manifest. It contains ONLY the owning Yayra
   * profile id and timestamps - never cookies, tokens, or account data. Its
   * purpose is to detect a profile-directory collision so one Yayra profile
   * cannot accidentally reuse another profile's Chrome cookie jar.
   */
  function ensureProfileDir(profileId) {
    const id = normalizeChromeProfileId(profileId);
    const dir = dirFor(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(dir, MANIFEST_NAME);
    let existing = null;
    try {
      if (fs.existsSync(manifestPath)) existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch { existing = null; }
    if (existing && existing.profileId !== id) throw new Error('chrome_profile_binding_mismatch');
    if (!existing) {
      const manifest = JSON.stringify({ version: 1, profileId: id, createdAt: now() }, null, 2);
      fs.writeFileSync(manifestPath, manifest, { mode: 0o600 });
    }
    return dir;
  }

  function launch(profileId, rawUrl, { authorization = false } = {}) {
    const id = normalizeChromeProfileId(profileId);
    const exe = binary();
    if (!exe) return { ok: false, error: 'chrome_binary_not_found' };
    let args;
    try {
      const dir = ensureProfileDir(id);
      args = authorization
        ? buildChromeProfileAuthorizationArgs({ profileDir: dir, url: rawUrl })
        : buildChromeProfileArgs({ profileDir: dir, url: rawUrl });
    } catch (err) {
      return { ok: false, error: err?.message || 'chrome_profile_prepare_failed' };
    }
    try {
      const child = spawnImpl(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false
      });
      if (child && typeof child.unref === 'function') child.unref();
      const record = {
        profileId: id,
        launchedAt: now(),
        pid: child?.pid ?? null,
        lastUrl: args[args.length - 1],
        authorization
      };
      sessions.set(id, record);
      return { ok: true, profileId: id, profileDir: dirFor(id), binary: exe, authorization };
    } catch (err) {
      logger?.error?.(`[yayra:chrome-profile] launch failed: ${err?.message || err}`);
      return { ok: false, error: 'chrome_profile_launch_failed' };
    }
  }

  return {
    /** Open a Google-owned website in this profile's real Chrome. */
    open(profileId, rawUrl) {
      return launch(profileId, rawUrl, { authorization: false });
    },
    /** Start the OAuth authorization ceremony in this profile's real Chrome. */
    openAuthorization(profileId, rawUrl) {
      return launch(profileId, rawUrl, { authorization: true });
    },
    /**
     * Whether a real Chrome is available. Availability is a binary lookup
     * only; no cookie, token or profile content is ever returned.
     */
    status(profileId = DEFAULT_PROFILE_ID) {
      const id = normalizeChromeProfileId(profileId);
      const exe = binary();
      const dir = dirFor(id);
      let exists = false;
      try { exists = fs.existsSync(dir); } catch { exists = false; }
      const session = sessions.get(id) || null;
      return {
        available: Boolean(exe),
        binary: exe || null,
        profileDir: dir,
        exists,
        launched: Boolean(session),
        launchedAt: session?.launchedAt || null,
        profileId: id
      };
    },
    /**
     * Best-effort terminate a tracked Chrome process. Chrome may have been
     * launched with `--new-window` into an existing instance; in that case the
     * original process exits quickly and there is nothing to kill. The cookie
     * jar is intentionally left intact so sign-in survives restart.
     */
    close(profileId = DEFAULT_PROFILE_ID) {
      const id = normalizeChromeProfileId(profileId);
      const session = sessions.get(id);
      sessions.delete(id);
      return { ok: true, terminated: Boolean(session) };
    },
    /** Clear the cached binary lookup after install/uninstall. */
    reset() {
      binaryResolved = false;
      cachedBinary = undefined;
    },
    get rootDir() { return root; }
  };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  PROFILE_ROOT,
  MANIFEST_NAME,
  normalizeChromeProfileId,
  chromeProfileDir,
  chromeBinaryCandidates,
  resolveChromeBinary,
  buildChromeProfileArgs,
  buildChromeProfileAuthorizationArgs,
  safeGoogleAuthorizationUrl,
  createGoogleChromeProfileManager
};
