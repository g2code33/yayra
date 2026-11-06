/**
 * Yayra "Sign in with Google" - Android/iOS (Capacitor) OAuth 2.0 client
 * ----------------------------------------------------------------------
 * The mobile counterpart of electron/googleAuth.cjs (desktop) and
 * src/services/googleAuthWeb.js (web). Same feature, same protocol
 * (Authorization Code + PKCE per RFC 8252 "OAuth 2.0 for Native Apps"),
 * mobile-shaped transport:
 *
 *   1. Open Google's consent screen in the SYSTEM browser surface -
 *      SFSafariViewController on iOS / Chrome Custom Tabs on Android - via
 *      the first-party `@capacitor/browser` plugin. Never the app's own
 *      WebView: Google detects and blocks embedded-webview sign-in, and
 *      RFC 8252 §8.12 forbids it anyway.
 *   2. Google redirects to the app's custom URL scheme
 *      (`com.yayra.app:/oauth2redirect` - RFC 8252 §7.1 reverse-DNS
 *      pattern). The OS routes that URL back into the app, surfaced to JS
 *      by the first-party `@capacitor/app` plugin's `appUrlOpen` event.
 *      The native plumbing that makes this work (Android intent filter,
 *      iOS CFBundleURLTypes) is injected into the generated projects by
 *      scripts/ensure-capacitor-platform.mjs and documented in
 *      docs/GOOGLE_SIGNIN.md.
 *   3. The one-shot code + PKCE verifier go to the update worker's
 *      /auth/google/exchange endpoint (worker/update-worker.mjs) with
 *      `platform: 'android' | 'ios'`; the worker exchanges them against
 *      the matching "Android"/"iOS" Google client (these client types
 *      have NO secret - they're verified by package name + SHA-1 /
 *      bundle ID instead), fetches userinfo, and returns the verified
 *      profile. Separate Gmail-readonly and Drive-readonly flows additionally
 *      return only opaque Worker capabilities; raw Google tokens remain
 *      server-side.
 *
 * WHY THE PLUGIN CHOICE (researched 2026-10): the once-popular
 * @byteowls/capacitor-oauth2 is unmaintained (last publish 2023,
 * officially superseded), and its successor
 * @capacitor-community/generic-oauth2 currently tops out at Capacitor 7
 * while this repo is on Capacitor 8. The two FIRST-PARTY plugins above are
 * maintained in lockstep with Capacitor itself, and the OAuth logic they
 * don't provide (PKCE, state, exchange) is exactly the code this repo
 * already owns and unit-tests on the other two platforms.
 *
 * WHY THE EXCHANGE GOES THROUGH THE WORKER even though mobile clients are
 * public (a direct on-device exchange, the classic AppAuth pattern, would
 * also work): routing it server-side means RAW TOKENS NEVER EXIST IN THE
 * APP'S JS CONTEXT AT ALL - the same token-isolation guarantee the Electron
 * bridge enforces across IPC and the web flow enforces in the browser. In
 * a Capacitor app, UI and flow logic share one WebView context, so the
 * only way to keep Google tokens away from UI-reachable code is to never let
 * them arrive. Trade-off (documented in docs/GOOGLE_SIGNIN.md): mobile
 * sign-in needs the worker reachable - which the app already requires for
 * update checks.
 *
 * Every external effect (plugins, fetch, storage, randomness, clock) is
 * dependency-injected - see tests/google-auth-capacitor.test.mjs. The live
 * round trip needs a human with real Android/iOS Client IDs and a real
 * device/emulator; this sandbox can run neither.
 */

import {
  buildAuthorizationUrl,
  clearProfile,
  downloadDelegatedDriveFile,
  getDelegatedGmailMessage,
  getDelegatedGoogleServiceItems,
  DEFAULT_AUTH_PROFILE_ID,
  DRIVE_SCOPES,
  GMAIL_SCOPES,
  GOOGLE_SERVICES_CAPABILITY,
  GOOGLE_SERVICES_SCOPES,
  generatePkcePair,
  generateState,
  listDelegatedGmailMessages,
  loadProfile,
  normalizeAuthProfileId,
  normalizeGoogleProductOrigin,
  readBoundedExchangeResponse,
  revokeDelegatedDriveSession,
  revokeDelegatedGmailSession,
  revokeDelegatedGoogleServicesSession,
  safeExchangeErrorCode,
  sanitizeDriveSession,
  sanitizeGmailSession,
  sanitizeGoogleProfile,
  sanitizeGoogleServicesSession,
  saveDriveSession,
  saveGmailSession,
  saveGoogleServicesSession,
  loadGoogleServicesSession,
  saveProfile,
  validatedExchangeUrl
} from './googleAuthWeb.js';

export const DEFAULT_MOBILE_REDIRECT_URI = 'com.yayra.app:/oauth2redirect';
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000; // match the Electron flow

/** Accept only the exact registered app callback URI, with OAuth query data. */
export function isExpectedMobileCallbackUrl(candidate, redirectUri = DEFAULT_MOBILE_REDIRECT_URI) {
  if (typeof candidate !== 'string' || candidate.length > 8192 || typeof redirectUri !== 'string') return false;
  if (candidate !== redirectUri && !candidate.startsWith(`${redirectUri}?`)) return false;
  try {
    const actual = new URL(candidate);
    const expected = new URL(redirectUri);
    return !expected.search && !expected.hash
      && actual.protocol === expected.protocol
      && actual.host === expected.host
      && actual.pathname === expected.pathname
      && !actual.username && !actual.password
      && !actual.hash;
  } catch {
    return false;
  }
}

/**
 * Runs one complete sign-in attempt. Resolves with the profile or rejects
 * with an Error whose message is a stable snake_case code (plus detail).
 *
 * @param {object} deps
 * @param {string} deps.clientId          "Android" or "iOS" type Google OAuth client ID
 * @param {string} deps.platform          'android' | 'ios' (forwarded to the worker)
 * @param {string} deps.exchangeUrl       worker /auth/google/exchange endpoint
 * @param {string} [deps.redirectUri]     registered app redirect (must match com.yayra.app:/oauth2redirect)
 * @param {Function} deps.openBrowser     async ({url}) => void  (Browser.open)
 * @param {Function} [deps.closeBrowser]  async () => void       (Browser.close - iOS only; Android Custom Tabs dismiss themselves)
 * @param {Function} deps.onUrlOpen       (handler) => unsubscribe - App 'appUrlOpen' subscription
 * @param {Function} [deps.onBrowserFinished] (handler) => unsubscribe - Browser 'browserFinished' (user dismissed the tab)
 * @param {Function} [deps.fetchImpl]
 * @param {object}   [deps.cryptoImpl]
 * @param {number}   [deps.timeoutMs]
 * @param {Function} [deps.setTimeoutImpl] / [deps.clearTimeoutImpl]
 */
export async function signInWithGoogleCapacitor({
  clientId,
  platform,
  exchangeUrl,
  redirectUri = DEFAULT_MOBILE_REDIRECT_URI,
  capability = 'profile',
  openBrowser,
  closeBrowser,
  onUrlOpen,
  onBrowserFinished,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  timeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
}) {
  if (!clientId) throw new Error('not_configured');
  if (!exchangeUrl) throw new Error('not_configured');
  if (platform !== 'android' && platform !== 'ios') throw new Error('invalid_platform');
  if (!['profile', 'drive-readonly', 'gmail-readonly', GOOGLE_SERVICES_CAPABILITY].includes(capability)) throw new Error('invalid_capability');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60 * 1000) throw new Error('invalid_timeout');
  const safeExchangeUrl = validatedExchangeUrl(exchangeUrl);
  // The Worker and generated Android/iOS manifests are bound to this one
  // registered app callback. Never let a caller substitute an arbitrary URI.
  if (redirectUri !== DEFAULT_MOBILE_REDIRECT_URI) throw new Error('invalid_redirect_uri');

  const { codeVerifier, codeChallenge } = await generatePkcePair(cryptoImpl);
  const state = generateState(cryptoImpl);
  const authUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge,
    ...(capability === 'drive-readonly'
      ? { scopes: DRIVE_SCOPES }
      : (capability === 'gmail-readonly' ? { scopes: GMAIL_SCOPES }
        : (capability === GOOGLE_SERVICES_CAPABILITY ? { scopes: GOOGLE_SERVICES_SCOPES } : {})))
  });

  // Subscribe BEFORE opening the browser - on a slow device the redirect
  // can land before Browser.open()'s promise even settles.
  const callbackUrl = await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanups = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeoutImpl(timer);
      for (const cleanup of cleanups) {
        try { cleanup(); } catch { /* best effort */ }
      }
      fn(value);
    };

    cleanups.push(onUrlOpen((event) => {
      const url = typeof event === 'string' ? event : event?.url;
      if (isExpectedMobileCallbackUrl(url, redirectUri)) finish(resolve, url);
      // Unrelated or prefix-confusable deep links are ignored, not trusted as
      // callbacks. A valid app callback must still pass the state check below.
    }));
    if (typeof onBrowserFinished === 'function') {
      // The user swiped the Custom Tab / Safari sheet away without
      // completing consent. Give the OS a beat first: on Android the
      // browserFinished event can race AHEAD of appUrlOpen on success.
      cleanups.push(onBrowserFinished(() => {
        setTimeoutImpl(() => finish(reject, new Error('sign_in_cancelled')), 1000);
      }));
    }
    timer = setTimeoutImpl(() => finish(reject, new Error('sign_in_timeout')), timeoutMs);

    Promise.resolve(openBrowser({ url: authUrl })).catch((err) => {
      finish(reject, new Error(`browser_open_failed:${err?.message || err}`));
    });
  });

  if (typeof closeBrowser === 'function') {
    try { await closeBrowser(); } catch { /* Android Custom Tabs have no close(); ignore */ }
  }

  const params = new URL(callbackUrl).searchParams;
  // Bearer credentials are never valid in the app callback. Reject rather
  // than ignore them so a future provider/config regression cannot normalize
  // token-bearing deep links into accepted input.
  if (['access_token', 'refresh_token', 'id_token', 'token'].some((key) => params.has(key))) {
    throw new Error('token_in_callback_rejected');
  }
  const codes = params.getAll('code');
  const states = params.getAll('state');
  const errors = params.getAll('error');
  if (codes.length > 1 || states.length > 1 || errors.length > 1) throw new Error('invalid_callback');
  const returnedState = states[0];
  if (!returnedState) throw new Error('missing_code_or_state');
  if (returnedState !== state) throw new Error('state_mismatch');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(returnedState)) throw new Error('invalid_callback');
  if (errors[0]) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(errors[0])) throw new Error('invalid_callback');
    throw new Error(errors[0]);
  }
  const code = codes[0];
  if (!code) throw new Error('missing_code_or_state');
  if (code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)) throw new Error('invalid_callback');

  // Server-side exchange: tokens never enter this process (see header).
  const response = await fetchImpl(safeExchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, codeVerifier, redirectUri, platform, capability })
  });
  const responseText = await readBoundedExchangeResponse(response);
  if (!response.ok) {
    throw new Error(`exchange_failed:${response.status}:${safeExchangeErrorCode(responseText)}`);
  }
  let body;
  try { body = JSON.parse(responseText); } catch { throw new Error('exchange_malformed_response'); }
  const profile = sanitizeGoogleProfile(body?.profile);
  if (!profile) throw new Error('exchange_malformed_response');
  const driveSession = capability === 'drive-readonly' ? sanitizeDriveSession(body?.driveSession) : null;
  const gmailSession = capability === 'gmail-readonly' ? sanitizeGmailSession(body?.gmailSession) : null;
  const googleServicesSession = capability === GOOGLE_SERVICES_CAPABILITY
    ? sanitizeGoogleServicesSession(body?.googleServicesSession)
    : null;
  if (capability === 'drive-readonly' && !driveSession) throw new Error('exchange_malformed_drive_session');
  if (capability === 'gmail-readonly' && !gmailSession) throw new Error('exchange_malformed_gmail_session');
  if (capability === GOOGLE_SERVICES_CAPABILITY && !googleServicesSession) throw new Error('exchange_malformed_google_services_session');
  return {
    profile,
    ...(driveSession ? { driveSession } : {}),
    ...(gmailSession ? { gmailSession } : {}),
    ...(googleServicesSession ? { googleServicesSession } : {})
  };
}

/**
 * The authBridge-shaped adapter (same contract as electron/preload.cjs's
 * window.yayra.auth and the web adapter in googleAuthWeb.js) so
 * BrowserShell's Settings -> Account UI drives mobile sign-in unmodified.
 * Installed by src/browser/main.js only on a native Capacitor platform
 * with a configured client ID.
 */
export function createCapacitorAuthBridge({
  clientId,
  platform,
  exchangeUrl,
  redirectUri = DEFAULT_MOBILE_REDIRECT_URI,
  localStorage,
  openBrowser,
  closeBrowser,
  onUrlOpen,
  onBrowserFinished,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  timeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS
}) {
  const listeners = new Set();
  let signingIn = false;

  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* one bad listener must not break the rest */ }
    }
  }

  return {
    async signIn(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      if (signingIn) return { ok: false, error: 'sign_in_already_in_progress' };
      if (!clientId) return { ok: false, error: 'not_configured' };
      signingIn = true;
      emit({ type: 'signing-in', profileId });
      try {
        const { profile } = await signInWithGoogleCapacitor({
          clientId, platform, exchangeUrl, redirectUri,
          openBrowser, closeBrowser, onUrlOpen, onBrowserFinished,
          fetchImpl, cryptoImpl, timeoutMs
        });
        saveProfile(localStorage, profile, profileId);
        emit({ type: 'signed-in', profileId, profile });
        return { ok: true, profile };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'error', profileId, message });
        return { ok: false, error: message };
      } finally {
        signingIn = false;
      }
    },
    async connectDrive(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      if (!clientId) return { ok: false, error: 'not_configured' };
      if (signingIn) return { ok: false, error: 'sign_in_already_in_progress' };
      signingIn = true;
      emit({ type: 'drive-connecting', profileId });
      try {
        const { profile, driveSession } = await signInWithGoogleCapacitor({
          clientId, platform, exchangeUrl, redirectUri, capability: 'drive-readonly',
          openBrowser, closeBrowser, onUrlOpen, onBrowserFinished,
          fetchImpl, cryptoImpl, timeoutMs
        });
        saveProfile(localStorage, profile, profileId);
        saveDriveSession(localStorage, driveSession, profileId);
        // Drive consent also verifies the Yayra identity. Emit the ordinary
        // account event first so the avatar/account state updates immediately
        // when the deep link returns, matching desktop and web callbacks.
        emit({ type: 'signed-in', profileId, profile });
        emit({ type: 'drive-connected', profileId, profile, expiresAt: driveSession.expiresAt });
        return { ok: true, profile, expiresAt: driveSession.expiresAt };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'drive-error', profileId, message });
        return { ok: false, error: message };
      } finally {
        signingIn = false;
      }
    },
    async connectGmail(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      if (!clientId) return { ok: false, error: 'not_configured' };
      if (signingIn) return { ok: false, error: 'sign_in_already_in_progress' };
      signingIn = true;
      emit({ type: 'gmail-connecting', profileId });
      try {
        const { profile, gmailSession } = await signInWithGoogleCapacitor({
          clientId, platform, exchangeUrl, redirectUri, capability: 'gmail-readonly',
          openBrowser, closeBrowser, onUrlOpen, onBrowserFinished,
          fetchImpl, cryptoImpl, timeoutMs
        });
        saveProfile(localStorage, profile, profileId);
        saveGmailSession(localStorage, gmailSession, profileId);
        emit({ type: 'signed-in', profileId, profile });
        emit({ type: 'gmail-connected', profileId, profile, expiresAt: gmailSession.expiresAt });
        return { ok: true, profile, expiresAt: gmailSession.expiresAt };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'gmail-error', profileId, message });
        return { ok: false, error: message };
      } finally {
        signingIn = false;
      }
    },
    async connectGoogleServices(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      if (!clientId) return { ok: false, error: 'not_configured' };
      if (signingIn) return { ok: false, error: 'sign_in_already_in_progress' };
      signingIn = true;
      emit({ type: 'google-services-connecting', profileId });
      try {
        const { profile, googleServicesSession } = await signInWithGoogleCapacitor({
          clientId, platform, exchangeUrl, redirectUri, capability: GOOGLE_SERVICES_CAPABILITY,
          openBrowser, closeBrowser, onUrlOpen, onBrowserFinished,
          fetchImpl, cryptoImpl, timeoutMs
        });
        saveProfile(localStorage, profile, profileId);
        saveGoogleServicesSession(localStorage, googleServicesSession, profileId);
        emit({ type: 'signed-in', profileId, profile });
        emit({ type: 'google-services-connected', profileId, profile, expiresAt: googleServicesSession.expiresAt });
        return { ok: true, profile, expiresAt: googleServicesSession.expiresAt };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ type: 'google-services-error', profileId, message });
        return { ok: false, error: message };
      } finally {
        signingIn = false;
      }
    },
    async getGoogleServiceItems(serviceId, claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      try {
        const result = await getDelegatedGoogleServiceItems({ serviceId, exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async getGoogleServicesSession(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      const session = loadGoogleServicesSession(localStorage, () => Date.now(), profileId);
      return session ? { connected: true, expiresAt: session.expiresAt, scopes: GOOGLE_SERVICES_SCOPES } : { connected: false };
    },
    async downloadDriveFile(fileId, claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      try {
        const result = await downloadDelegatedDriveFile({ fileId, exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async listGmailMessages(options = {}, claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      try {
        const result = await listDelegatedGmailMessages({ options, exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async getGmailMessage(messageId, claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      try {
        const message = await getDelegatedGmailMessage({ messageId, exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl });
        return { ok: true, message };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    async signOut(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      clearProfile(localStorage, profileId);
      emit({ type: 'signed-out', profileId });
      await Promise.all([
        revokeDelegatedDriveSession({ exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl }),
        revokeDelegatedGmailSession({ exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl }),
        revokeDelegatedGoogleServicesSession({ exchangeUrl, sessionStorage: localStorage, profileId, fetchImpl })
      ]);
      return { ok: true };
    },
    async getSession(claimedProfileId = DEFAULT_AUTH_PROFILE_ID) {
      const profileId = normalizeAuthProfileId(claimedProfileId);
      const saved = loadProfile(localStorage, profileId);
      if (!saved) return { signedIn: false };
      const services = loadGoogleServicesSession(localStorage, () => Date.now(), profileId);
      const result = { signedIn: true, profile: saved.profile, savedAt: saved.savedAt };
      return services ? { ...result, servicesConnected: true, scopes: GOOGLE_SERVICES_SCOPES } : result;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Same single hardcoded trusted URL as every other platform's bridge.
    async openAccountPage() {
      await openBrowser({ url: 'https://myaccount.google.com/' });
      return { ok: true };
    },
    async openGoogleProduct(originValue) {
      const safeOrigin = normalizeGoogleProductOrigin(originValue);
      if (!safeOrigin) return { ok: false, error: 'invalid_google_product_origin' };
      await openBrowser({ url: safeOrigin });
      return { ok: true };
    }
  };
}
