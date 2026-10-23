/**
 * Yayra "Sign in with Google" - Web/PWA OAuth 2.0 client
 * ------------------------------------------------------
 * The Web/PWA counterpart of electron/googleAuth.cjs. Same feature (an
 * app-level "Signed in as ..." identity for Yayra itself), same protocol
 * (OAuth 2.0 Authorization Code + PKCE, RFC 7636), different transport for
 * the redirect: the browser cannot run a loopback HTTP server (RFC 8252's
 * desktop pattern), so Google redirects back to a real HTTPS callback page
 * served by the same static deployment - `/auth/callback` on e.g.
 * https://yayra.pages.dev.
 *
 * DESIGN DECISION - full-page redirect, NOT popup+postMessage:
 *   - An installed PWA runs in `display: standalone` where window.opener /
 *     popup relationships are unreliable, and popup blockers plus
 *     Safari/Brave tracking protections break popup flows routinely. A
 *     full-page redirect behaves identically in a browser tab and an
 *     installed PWA.
 *   - postMessage would add an origin-validation attack surface for no
 *     benefit; the redirect keeps the whole round trip same-origin.
 *   - The pending flow state (PKCE verifier, CSRF `state`, and the path to
 *     return the user to) survives the round trip in sessionStorage, which
 *     is per-tab and evaporates when the tab closes - exactly the lifetime
 *     a half-finished sign-in attempt should have.
 *
 * DESIGN DECISION - the token exchange happens in the Cloudflare Worker,
 * not in this file:
 *   Google's token endpoint REQUIRES a client_secret for "Web application"
 *   OAuth clients even when PKCE is used (the same documented Google quirk
 *   as the "Desktop app" client type - see electron/googleAuth.cjs). A
 *   secret embedded in browser-delivered JavaScript is public by
 *   definition, so this client never touches one: the callback page POSTs
 *   `{ code, codeVerifier, redirectUri }` to the update worker's
 *   `/auth/google/exchange` endpoint (worker/update-worker.mjs), which
 *   holds the secret as a Worker binding and performs token exchange and
 *   userinfo server-side. Basic identity returns ONLY the sanitized profile.
 *   A separate, explicit Drive-readonly consent encrypts scoped credentials
 *   in Worker KV and returns only an opaque origin-bound Yayra capability.
 *
 * SECURITY TRADE-OFF versus Electron's OS keychain - be explicit:
 *   Electron encrypts raw OAuth tokens at rest with safeStorage (OS
 *   keychain: Keychain/libsecret/DPAPI - see electron/authStore.cjs). A
 *   browser has NO equivalent: anything persisted (localStorage,
 *   IndexedDB, even a non-HttpOnly cookie) is readable by any same-origin
 *   script. Instead of storing Google credentials weakly, RAW GOOGLE TOKENS
 *   NEVER REACH THE BROWSER. Profile tokens are discarded after userinfo;
 *   delegated Drive credentials stay AES-GCM-encrypted in Worker KV and are
 *   refreshed/revoked only there. localStorage contains display profile data
 *   and, when granted, a random scoped capability—not a bearer/refresh token.
 *
 * Every external effect (storage, navigation, fetch, randomness, hashing)
 * is dependency-injected so the URL construction, state round trip, and
 * exchange request shape are unit-testable with no real browser, network,
 * or Google project - see tests/google-auth-web.test.mjs. The live consent
 * round trip against real Google servers has NOT been run by this agent
 * (no browser or registered Client ID in this sandbox) and must be
 * verified by a human per docs/GOOGLE_SIGNIN.md.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_SCOPES = [...DEFAULT_SCOPES, DRIVE_READONLY_SCOPE];
export const CALLBACK_PATH = '/auth/callback';
export const PENDING_KEY = 'yayra:google-auth:pending';
export const DRIVE_SESSION_KEY = 'yayra:google-drive:delegated-session';

export function normalizeGoogleProductOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  const googleOwned = host === 'google.com' || host.endsWith('.google.com')
    || host === 'youtube.com' || host.endsWith('.youtube.com');
  if (!googleOwned || host === 'accounts.google.com') return null;
  return `${parsed.origin}/`;
}
export const PROFILE_KEY = 'yayra:google-account';
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_CALLBACK_QUERY_LENGTH = 8192;
const MAX_EXCHANGE_RESPONSE_BYTES = 64 * 1024;

function base64urlFromBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const btoaImpl = typeof btoa === 'function' ? btoa : (s) => Buffer.from(s, 'binary').toString('base64');
  return btoaImpl(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 7636 PKCE pair using WebCrypto (injectable for tests - pass
 * node:crypto's webcrypto). Async because crypto.subtle.digest is.
 */
export async function generatePkcePair(cryptoImpl = globalThis.crypto) {
  const verifierBytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64urlFromBytes(verifierBytes);
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64urlFromBytes(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

export function generateState(cryptoImpl = globalThis.crypto) {
  return base64urlFromBytes(cryptoImpl.getRandomValues(new Uint8Array(16)));
}

function validatedWebOrigin(rawOrigin) {
  try {
    const parsed = new URL(rawOrigin);
    const localHttp = parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password
      || (parsed.protocol !== 'https:' && !localHttp)) throw new Error('invalid_redirect_uri');
    return parsed.origin;
  } catch {
    throw new Error('invalid_redirect_uri');
  }
}

function safeReturnToPath(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

export function validatedExchangeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_exchange_url');
  try {
    const parsed = new URL(value);
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !localHttp)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/auth/google/exchange') throw new Error('invalid_exchange_url');
    return parsed.toString();
  } catch {
    throw new Error('invalid_exchange_url');
  }
}

function driveApiUrlForExchange(exchangeUrl, pathname) {
  const safeExchangeUrl = new URL(validatedExchangeUrl(exchangeUrl));
  safeExchangeUrl.pathname = pathname;
  safeExchangeUrl.search = '';
  return safeExchangeUrl;
}

export function driveDownloadUrlForExchange(exchangeUrl, fileId) {
  const safeExchangeUrl = driveApiUrlForExchange(exchangeUrl, '/api/drive/download');
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error('invalid_drive_file_id');
  safeExchangeUrl.searchParams.set('fileId', fileId);
  return safeExchangeUrl.toString();
}

export function driveRevokeUrlForExchange(exchangeUrl) {
  return driveApiUrlForExchange(exchangeUrl, '/api/drive/session/revoke').toString();
}

function driveFilenameFromResponse(response) {
  const disposition = response?.headers?.get?.('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').slice(0, 180); }
    catch { /* use generic fallback */ }
  }
  return 'Google Drive download';
}

export async function downloadDelegatedDriveFile({
  fileId,
  exchangeUrl,
  sessionStorage,
  fetchImpl = globalThis.fetch,
  maxBytes = 300 * 1024 * 1024
}) {
  const session = loadDriveSession(sessionStorage);
  if (!session) throw new Error('drive_reconnect_required');
  const response = await fetchImpl(driveDownloadUrlForExchange(exchangeUrl, fileId), {
    method: 'GET',
    headers: { Authorization: `YayraDrive ${session.id}`, Accept: 'application/octet-stream' }
  });
  if (!response.ok) {
    const text = await readBoundedExchangeResponse(response);
    const code = safeExchangeErrorCode(text);
    if (response.status === 401) sessionStorage.removeItem(DRIVE_SESSION_KEY);
    throw new Error(`drive_download_failed:${response.status}:${code}`);
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 0 || declared > maxBytes)) throw new Error('drive_file_too_large');
  const reader = response.body?.getReader?.();
  let blob;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error('drive_file_too_large');
      }
      chunks.push(chunk);
    }
    blob = new Blob(chunks, { type: response.headers?.get?.('content-type') || 'application/octet-stream' });
  } else {
    blob = await response.blob();
    if (blob.size > maxBytes) throw new Error('drive_file_too_large');
  }
  return {
    blob,
    filename: driveFilenameFromResponse(response),
    mimeType: blob.type || 'application/octet-stream'
  };
}

export async function revokeDelegatedDriveSession({
  exchangeUrl,
  sessionStorage,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000
}) {
  const session = loadDriveSession(sessionStorage);
  // Local logout is authoritative and immediate even when the Worker or
  // Google is unavailable. The opaque capability cannot be recovered from
  // browser storage after this point.
  sessionStorage?.removeItem?.(DRIVE_SESSION_KEY);
  if (!session) return { ok: true, revoked: false };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000))
    : null;
  try {
    const response = await fetchImpl(driveRevokeUrlForExchange(exchangeUrl), {
      method: 'POST',
      headers: { Authorization: `YayraDrive ${session.id}`, Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {})
    });
    return { ok: response.ok, revoked: response.ok };
  } catch {
    return { ok: false, revoked: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readBoundedExchangeResponse(response, maxBytes = MAX_EXCHANGE_RESPONSE_BYTES) {
  const rawLength = response?.headers?.get?.('content-length');
  if (rawLength !== null && rawLength !== undefined && rawLength !== '') {
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new Error('exchange_response_too_large');
    }
  }
  const reader = response?.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error('exchange_response_too_large');
      }
      chunks.push(chunk);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }
  let text = '';
  try { text = await response.text(); } catch { return ''; }
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('exchange_response_too_large');
  return text;
}

export function safeExchangeErrorCode(responseText) {
  try {
    const parsed = JSON.parse(String(responseText || ''));
    if (typeof parsed?.error === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(parsed.error)) return parsed.error;
  } catch { /* never expose an arbitrary upstream response body */ }
  return 'upstream_error';
}

export function sanitizeGoogleProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const sub = typeof value.sub === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value.sub) ? value.sub : null;
  const email = typeof value.email === 'string' && value.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value.email)
    ? value.email
    : null;
  if (!sub || !email) return null;
  const name = typeof value.name === 'string'
    ? value.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
    : null;
  let picture = null;
  if (typeof value.picture === 'string' && value.picture.length <= 2048) {
    try {
      const parsed = new URL(value.picture);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) picture = parsed.toString();
    } catch { /* optional image is dropped */ }
  }
  return { sub, name, email, picture };
}

export function sanitizeDriveSession(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.id) ? value.id : null;
  const expiresAt = typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))
    ? value.expiresAt
    : null;
  if (!id || !expiresAt || value.scope !== 'drive.readonly') return null;
  return { id, expiresAt, scope: 'drive.readonly' };
}

export function saveDriveSession(sessionStorage, value) {
  const session = sanitizeDriveSession(value);
  if (!session) throw new Error('invalid_drive_session');
  sessionStorage.setItem(DRIVE_SESSION_KEY, JSON.stringify(session));
  return session;
}

export function loadDriveSession(sessionStorage, now = () => Date.now()) {
  const raw = sessionStorage?.getItem?.(DRIVE_SESSION_KEY);
  if (!raw || raw.length > 4096) return null;
  try {
    const session = sanitizeDriveSession(JSON.parse(raw));
    if (!session || Date.parse(session.expiresAt) <= Number(now())) {
      sessionStorage?.removeItem?.(DRIVE_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    sessionStorage?.removeItem?.(DRIVE_SESSION_KEY);
    return null;
  }
}

/**
 * Same parameter set as the Electron flow (including `prompt=consent
 * select_account` so "Switch account" shows Google's account chooser).
 * Ordinary profile sign-in never asks for offline access. The separate,
 * explicit Drive-readonly consent does: its refresh credential is returned
 * only to the Worker, encrypted there, while browser code receives an opaque
 * origin-bound capability that it can revoke.
 */
export function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes = DEFAULT_SCOPES }) {
  if (typeof clientId !== 'string' || clientId.length > 255
    || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('invalid_client_id');
  if (typeof redirectUri !== 'string' || !redirectUri || redirectUri.length > 2048) throw new Error('invalid_redirect_uri');
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(state)) throw new Error('invalid_state');
  if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error('invalid_code_challenge');
  const validProfileScopes = Array.isArray(scopes)
    && scopes.length === DEFAULT_SCOPES.length
    && scopes.every((scope, index) => scope === DEFAULT_SCOPES[index]);
  const validDriveScopes = Array.isArray(scopes)
    && scopes.length === DRIVE_SCOPES.length
    && scopes.every((scope, index) => scope === DRIVE_SCOPES[index]);
  if (!validProfileScopes && !validDriveScopes) throw new Error('invalid_scopes');
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent select_account');
  if (validDriveScopes) url.searchParams.set('access_type', 'offline');
  return url.toString();
}

/**
 * Step 1 (runs on the main app page): stash the PKCE verifier + CSRF state
 * + return path in sessionStorage, then send the WHOLE page to Google's
 * consent screen. Returns the URL it navigated to (for tests).
 */
export async function beginSignIn({
  clientId,
  origin,
  returnTo = '/',
  capability = 'profile',
  sessionStorage,
  cryptoImpl = globalThis.crypto,
  navigate
}) {
  if (!clientId) throw new Error('not_configured');
  if (!['profile', 'drive-readonly'].includes(capability)) throw new Error('invalid_capability');
  const safeOrigin = validatedWebOrigin(origin);
  const { codeVerifier, codeChallenge } = await generatePkcePair(cryptoImpl);
  const state = generateState(cryptoImpl);
  const redirectUri = `${safeOrigin}${CALLBACK_PATH}`;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({
    codeVerifier,
    state,
    capability,
    returnTo: safeReturnToPath(returnTo, safeOrigin),
    startedAt: new Date().toISOString()
  }));
  const scopes = capability === 'drive-readonly' ? DRIVE_SCOPES : DEFAULT_SCOPES;
  const url = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes });
  navigate(url);
  return url;
}

/** Parses and validates Google's callback query parameters. */
export function parseCallbackParams(search) {
  const raw = String(search || '');
  if (raw.length > MAX_CALLBACK_QUERY_LENGTH) return { ok: false, error: 'invalid_callback' };
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const errors = params.getAll('error');
  const codes = params.getAll('code');
  const states = params.getAll('state');
  if (errors.length > 1 || codes.length > 1 || states.length > 1) return { ok: false, error: 'invalid_callback' };
  const state = states[0];
  if (state && !/^[A-Za-z0-9_-]{1,256}$/.test(state)) return { ok: false, error: 'invalid_callback' };
  if (errors[0]) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(errors[0])) return { ok: false, error: 'invalid_callback' };
    return { ok: false, error: errors[0], ...(state ? { state } : {}) };
  }
  const code = codes[0];
  if (!code || !state) return { ok: false, error: 'missing_code_or_state', ...(state ? { state } : {}) };
  if (code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)) return { ok: false, error: 'invalid_callback' };
  return { ok: true, code, state };
}

/**
 * Step 2 (runs on /auth/callback after Google redirects back): validate the
 * CSRF state against the sessionStorage stash (and consume the stash either
 * way - a pending attempt is single-use), then hand the code + verifier to
 * the worker for the server-side exchange. Resolves with the profile and
 * the `returnTo` path; raw tokens never appear anywhere in this process.
 */
export async function completeSignIn({
  search,
  origin,
  pathname = CALLBACK_PATH,
  exchangeUrl,
  sessionStorage,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
}) {
  if (pathname !== CALLBACK_PATH) throw new Error('invalid_callback');
  const safeOrigin = validatedWebOrigin(origin);
  const safeExchangeUrl = validatedExchangeUrl(exchangeUrl);
  const pendingRaw = sessionStorage.getItem(PENDING_KEY);
  // Single-use: consume the pending attempt before anything can throw, so a
  // replayed/bookmarked callback URL can never complete a second time.
  sessionStorage.removeItem(PENDING_KEY);
  if (!pendingRaw) throw new Error('no_pending_sign_in');
  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    throw new Error('corrupt_pending_sign_in');
  }
  if (!pending || typeof pending.state !== 'string'
    || !/^[A-Za-z0-9_-]{8,256}$/.test(pending.state)
    || typeof pending.codeVerifier !== 'string'
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.codeVerifier)
    || (pending.capability !== undefined && !['profile', 'drive-readonly'].includes(pending.capability))
    || typeof pending.startedAt !== 'string') {
    throw new Error('corrupt_pending_sign_in');
  }
  const startedAt = Date.parse(pending.startedAt);
  const currentTime = Number(now());
  if (!Number.isFinite(startedAt) || !Number.isFinite(currentTime)
    || startedAt > currentTime + 60_000 || currentTime - startedAt > PENDING_MAX_AGE_MS) {
    throw new Error('expired_pending_sign_in');
  }

  const parsed = parseCallbackParams(search);
  if (parsed.error === 'invalid_callback') throw new Error(parsed.error);
  if (!parsed.state) throw new Error('missing_code_or_state');
  if (parsed.state !== pending.state) throw new Error('state_mismatch');
  if (!parsed.ok) throw new Error(parsed.error);

  const capability = pending.capability === 'drive-readonly' ? 'drive-readonly' : 'profile';
  const response = await fetchImpl(safeExchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: parsed.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${safeOrigin}${CALLBACK_PATH}`,
      platform: 'web',
      capability
    })
  });
  const responseText = await readBoundedExchangeResponse(response);
  if (!response.ok) {
    throw new Error(`exchange_failed:${response.status}:${safeExchangeErrorCode(responseText)}`);
  }
  let body;
  try { body = JSON.parse(responseText); } catch { throw new Error('exchange_malformed_response'); }
  const profile = sanitizeGoogleProfile(body?.profile);
  if (!profile) throw new Error('exchange_malformed_response');
  // Belt-and-braces: even if a future worker regression leaked token fields,
  // never let them past this seam. Drive receives only an opaque, scoped
  // delegated-session id; raw Google access/refresh tokens stay in the Worker.
  const driveSession = capability === 'drive-readonly'
    ? sanitizeDriveSession(body?.driveSession)
    : null;
  if (capability === 'drive-readonly' && !driveSession) throw new Error('exchange_malformed_drive_session');
  return {
    profile,
    ...(driveSession ? { driveSession } : {}),
    returnTo: safeReturnToPath(pending.returnTo, safeOrigin)
  };
}

/** Profile-only persistence (see the security trade-off note at the top). */
export function saveProfile(localStorage, profile) {
  const cleanProfile = sanitizeGoogleProfile(profile);
  if (!cleanProfile) throw new Error('invalid_profile');
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ profile: cleanProfile, savedAt: new Date().toISOString() }));
}

export function loadProfile(localStorage) {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw || raw.length > 16 * 1024) return null;
  try {
    const parsed = JSON.parse(raw);
    const profile = sanitizeGoogleProfile(parsed?.profile);
    if (!profile) return null;
    const savedAt = typeof parsed.savedAt === 'string' && Number.isFinite(Date.parse(parsed.savedAt))
      ? parsed.savedAt
      : null;
    return { profile, savedAt };
  } catch {
    return null;
  }
}

export function clearProfile(localStorage) {
  localStorage.removeItem(PROFILE_KEY);
}

/**
 * The authBridge-shaped adapter BrowserShell already knows how to drive
 * (same surface as electron/preload.cjs exposes: signIn/signOut/getSession/
 * onEvent/openAccountPage) so the Settings -> Account UI works on web with
 * zero shell changes. Installed as `window.yayra.auth` by
 * src/browser/main.js only when a Web Client ID is actually configured.
 */
export function createWebAuthBridge({
  clientId,
  exchangeUrl,
  origin,
  localStorage,
  sessionStorage,
  cryptoImpl = globalThis.crypto,
  fetchImpl = globalThis.fetch,
  navigate,
  openWindow,
  getPath = () => '/'
}) {
  const listeners = new Set();

  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* one bad listener must not break the rest */ }
    }
  }

  return {
    async signIn() {
      if (!clientId) return { ok: false, error: 'not_configured' };
      emit({ type: 'signing-in' });
      try {
        await beginSignIn({ clientId, origin, returnTo: getPath(), sessionStorage, cryptoImpl, navigate });
        // The page is now navigating away to Google; by the time the user
        // is back, a fresh page load picks the session up from storage.
        return { ok: true, pending: true };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'error', message });
        return { ok: false, error: message };
      }
    },
    async connectDrive() {
      if (!clientId) return { ok: false, error: 'not_configured' };
      emit({ type: 'drive-connecting' });
      try {
        await beginSignIn({
          clientId,
          origin,
          returnTo: getPath(),
          capability: 'drive-readonly',
          sessionStorage,
          cryptoImpl,
          navigate
        });
        return { ok: true, pending: true };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'drive-error', message });
        return { ok: false, error: message };
      }
    },
    async downloadDriveFile(fileId) {
      try {
        const result = await downloadDelegatedDriveFile({ fileId, exchangeUrl, sessionStorage: localStorage, fetchImpl });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async getDriveSession() {
      const session = loadDriveSession(localStorage);
      return session ? { connected: true, expiresAt: session.expiresAt } : { connected: false };
    },
    async signOut() {
      clearProfile(localStorage);
      emit({ type: 'signed-out' });
      await revokeDelegatedDriveSession({ exchangeUrl, sessionStorage: localStorage, fetchImpl });
      return { ok: true };
    },
    async getSession() {
      const saved = loadProfile(localStorage);
      if (!saved) return { signedIn: false };
      return { signedIn: true, profile: saved.profile, savedAt: saved.savedAt };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Same single hardcoded trusted URL as the Electron bridge - never a
    // generic "open any URL" capability.
    async openAccountPage() {
      openWindow('https://myaccount.google.com/');
      return { ok: true };
    },
    async openGoogleProduct(originValue) {
      const safeOrigin = normalizeGoogleProductOrigin(originValue);
      if (!safeOrigin) return { ok: false, error: 'invalid_google_product_origin' };
      openWindow(safeOrigin);
      return { ok: true };
    }
  };
}
