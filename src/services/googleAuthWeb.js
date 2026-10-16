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
 *   holds the secret as a Worker secret binding, performs the
 *   code-for-token exchange and the userinfo fetch server-side, and
 *   returns ONLY the basic profile (sub/name/email/picture).
 *
 * SECURITY TRADE-OFF versus Electron's OS keychain - be explicit:
 *   Electron encrypts raw OAuth tokens at rest with safeStorage (OS
 *   keychain: Keychain/libsecret/DPAPI - see electron/authStore.cjs). A
 *   browser has NO equivalent: anything persisted (localStorage,
 *   IndexedDB, even a non-HttpOnly cookie) is readable by any same-origin
 *   script. Instead of storing tokens weakly, this design ensures RAW
 *   TOKENS NEVER REACH THE BROWSER AT ALL - the worker consumes them
 *   server-side and discards them, returning only the profile. What IS
 *   persisted client-side (localStorage) is exactly what the UI shows
 *   anyway: display name, email, avatar URL. Consequence: the web session
 *   is "profile-only" - Yayra cannot call Google APIs on the user's behalf
 *   later (it has no tokens), which is fine because the openid/email/
 *   profile scopes are all Yayra uses anywhere.
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
export const CALLBACK_PATH = '/auth/callback';
export const PENDING_KEY = 'yayra:google-auth:pending';
export const PROFILE_KEY = 'yayra:google-account';

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
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

/**
 * Same parameter set as the Electron flow (including `prompt=consent
 * select_account` so "Switch account" shows Google's account chooser), with
 * one deliberate difference: NO offline access is requested. A refresh
 * token would be a long-lived credential with nowhere safe to live in a
 * browser; the one-shot code is all this flow needs.
 */
export function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes = DEFAULT_SCOPES }) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent select_account');
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
  sessionStorage,
  cryptoImpl = globalThis.crypto,
  navigate
}) {
  if (!clientId) throw new Error('not_configured');
  const safeOrigin = validatedWebOrigin(origin);
  const { codeVerifier, codeChallenge } = await generatePkcePair(cryptoImpl);
  const state = generateState(cryptoImpl);
  const redirectUri = `${safeOrigin}${CALLBACK_PATH}`;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({
    codeVerifier,
    state,
    returnTo: safeReturnToPath(returnTo, safeOrigin),
    startedAt: new Date().toISOString()
  }));
  const url = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge });
  navigate(url);
  return url;
}

/** Parses and validates Google's callback query parameters. */
export function parseCallbackParams(search) {
  const params = new URLSearchParams(String(search || '').startsWith('?') ? String(search).slice(1) : String(search || ''));
  const errors = params.getAll('error');
  const codes = params.getAll('code');
  const states = params.getAll('state');
  if (errors.length > 1 || codes.length > 1 || states.length > 1) return { ok: false, error: 'invalid_callback' };
  const state = states[0];
  if (errors[0]) return { ok: false, error: errors[0], ...(state ? { state } : {}) };
  const code = codes[0];
  if (!code || !state) return { ok: false, error: 'missing_code_or_state', ...(state ? { state } : {}) };
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
  fetchImpl = globalThis.fetch
}) {
  if (pathname !== CALLBACK_PATH) throw new Error('invalid_callback');
  const safeOrigin = validatedWebOrigin(origin);
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
  if (!pending || typeof pending.state !== 'string' || !pending.state
    || typeof pending.codeVerifier !== 'string'
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.codeVerifier)) {
    throw new Error('corrupt_pending_sign_in');
  }

  const parsed = parseCallbackParams(search);
  if (parsed.error === 'invalid_callback') throw new Error(parsed.error);
  if (!parsed.state) throw new Error('missing_code_or_state');
  if (parsed.state !== pending.state) throw new Error('state_mismatch');
  if (!parsed.ok) throw new Error(parsed.error);

  const response = await fetchImpl(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: parsed.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${safeOrigin}${CALLBACK_PATH}`
    })
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* best effort */ }
    throw new Error(`exchange_failed:${response.status}${detail ? `:${detail.slice(0, 200)}` : ''}`);
  }
  const body = await response.json();
  if (!body || !body.profile || !body.profile.email) throw new Error('exchange_malformed_response');
  // Belt-and-braces: even if a future worker regression leaked token fields,
  // never let them past this seam. Profile only - same contract as the
  // Electron bridge (electron/authBridge.cjs).
  const { sub, name, email, picture } = body.profile;
  return {
    profile: { sub, name, email, picture },
    returnTo: safeReturnToPath(pending.returnTo, safeOrigin)
  };
}

/** Profile-only persistence (see the security trade-off note at the top). */
export function saveProfile(localStorage, profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ profile, savedAt: new Date().toISOString() }));
}

export function loadProfile(localStorage) {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.profile || !parsed.profile.email) return null;
    return parsed;
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
    async signOut() {
      clearProfile(localStorage);
      emit({ type: 'signed-out' });
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
    }
  };
}
