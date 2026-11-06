/**
 * Entry script for /auth/callback (public/auth/callback/index.html) - the
 * page Google redirects back to after the consent screen in the Web/PWA
 * "Sign in with Google" flow (full-page redirect variant; rationale in
 * src/services/googleAuthWeb.js).
 *
 * Responsibilities, in order:
 *   1. Validate the callback (CSRF state vs the sessionStorage stash) and
 *      hand the one-shot code + PKCE verifier to the Cloudflare Worker for
 *      the server-side exchange (profile plus, only for explicit Drive
 *      consent, an opaque Yayra capability; Google tokens never come back).
 *   2. Persist the profile and optional opaque Drive capability the same way
 *      the shell reads them.
 *   3. Return the user to where they started the sign-in, replacing this
 *      page in history so Back never lands on a dead callback URL full of
 *      consumed OAuth parameters.
 * On any failure: show the error honestly with a way back into the app -
 * never a blank page.
 */
import {
  completeSignIn,
  saveDriveSession,
  saveGmailSession,
  saveGoogleServicesSession,
  saveProfile
} from '../services/googleAuthWeb.js';
import { resolveWebGoogleAuthConfig } from '../config/googleAuthWeb.js';

const statusEl = document.getElementById('auth-status');

run();

async function run() {
  const { clientId, exchangeUrl } = resolveWebGoogleAuthConfig({});
  if (!clientId || !exchangeUrl) {
    return fail('Google sign-in is not configured for this deployment.');
  }
  try {
    const { profile, profileId = 'default', driveSession, gmailSession, googleServicesSession, returnTo } = await completeSignIn({
      search: window.location.search,
      origin: window.location.origin,
      pathname: window.location.pathname,
      exchangeUrl,
      sessionStorage: window.sessionStorage,
      fetchImpl: window.fetch.bind(window)
    });
    saveProfile(window.localStorage, profile, profileId);
    // The value is an opaque, origin-bound, Drive-readonly capability — not a
    // Google token. Persist it so the reflected Yayra connection survives a
    // browser/PWA restart; the Worker keeps encrypted Google credentials.
    if (driveSession) saveDriveSession(window.localStorage, driveSession, profileId);
    if (gmailSession) saveGmailSession(window.localStorage, gmailSession, profileId);
    if (googleServicesSession) saveGoogleServicesSession(window.localStorage, googleServicesSession, profileId);
    if (statusEl) statusEl.textContent = googleServicesSession
      ? `Google services connected for ${profile.email} — returning to Yayra…`
      : (driveSession
        ? `Google Drive connected for ${profile.email} — returning to Yayra…`
        : (gmailSession
          ? `Gmail connected for ${profile.email} — returning to Yayra…`
          : `Signed in as ${profile.email} — returning to Yayra…`));
    // Only ever return to a same-origin path - a stored absolute URL (which
    // beginSignIn never writes, but defense in depth) must not become an
    // open redirect.
    const safeReturnTo = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    window.location.replace(safeReturnTo);
  } catch (err) {
    fail(describe(err && err.message ? err.message : String(err)));
  }
}

function describe(code) {
  switch (code) {
    case 'access_denied':
      return 'Sign-in was cancelled on the Google consent screen.';
    case 'no_pending_sign_in':
      return 'This sign-in link has already been used or expired. Start again from Settings → Account.';
    case 'state_mismatch':
      return "This sign-in response didn't match the request that started it (possible stale tab). Start again from Settings → Account.";
    default:
      return `Couldn't finish signing in: ${code}`;
  }
}

function fail(message) {
  if (!statusEl) return;
  statusEl.textContent = message;
  const link = document.createElement('a');
  link.href = '/';
  link.textContent = 'Back to Yayra';
  link.className = 'auth-callback-back';
  statusEl.insertAdjacentElement('afterend', link);
}
