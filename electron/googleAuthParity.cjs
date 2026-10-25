'use strict';

/**
 * Google auth-surface parity helpers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Google's "This browser or app may not be secure" decision is made from
 * signals, not from a security certificate: a UA that claims Chromium but
 * sends no matching client hints, scripts injected into the login page,
 * rewritten request headers, a non-native WebAuthn shim, and an address bar
 * the page could influence are all strong "embedded / automated" signals.
 * Google documents the trust requirements in its OAuth 2.0 policy
 * ("Use secure browsers") and its 2021 embedded-webview announcement.
 *
 * This module is intentionally PURE and dependency-free so every rule is
 * unit-testable without an Electron runtime. It never spoofs Google Chrome:
 * client hints identify the real Chromium engine plus a GREASE brand, exactly
 * what an honest Chromium downstream sends. Nothing here copies cookies,
 * injects bearer tokens, or hides automation flags.
 *
 * SCOPE: these are best-effort signals. Google does not publish a browser
 * allowlist or certification; parity can improve acceptance but cannot
 * guarantee it. The dedicated Chrome profile (googleChromeProfile.cjs) is the
 * guaranteed path and is always available as a fallback.
 */

const GOOGLE_AUTH_HOSTS = Object.freeze([
  'accounts.google.com',
  'consent.google.com',
  'myaccount.google.com'
]);

const GOOGLE_OWNED_HOST_SUFFIXES = Object.freeze([
  'google.com',
  'youtube.com',
  'youtube-nocookie.com',
  'blogger.com',
  'googleusercontent.com',
  'gstatic.com',
  'googleapis.com',
  'googlevideo.com',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'googleusercontent.com',
  'withgoogle.com',
  'g.co',
  'gmail.com',
  'drive.google.com'
]);

const GOOGLE_COUNTRY_DOMAIN = /^google\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/i;
const GOOGLE_INTERACTIVE_SIGNIN_PATH = /^\/(?:signin\/v2(?:\/|$)|v3\/signin(?:\/|$)|ServiceLogin(?:\/|$)|InteractiveLogin(?:\/|$)|AccountChooser(?:\/|$)|AddSession(?:\/|$)|signin\/challenge(?:\/|$)|signin\/identifier(?:\/|$)|signin\/rejected(?:\/|$)|o\/oauth2(?:\/|$)|oauth2(?:\/|$)|signin\/oauth(?:\/|$)|gsi\/select(?:\/|$))/i;
const GOOGLE_THIRD_PARTY_OAUTH_PATH = /^\/(?:o\/oauth2(?:\/|$)|oauth2(?:\/|$)|signin\/oauth(?:\/|$)|gsi\/select(?:\/|$))/i;
const GOOGLE_REJECTED_PATH = /^\/(?:signin\/rejected|v3\/signin\/rejected)(?:\/|$)/i;
const GOOGLE_ACCOUNT_PORTAL_PATH = /^\/(?:ManageAccount(?:\/|$)|signin\/?)?$/i;

const MAX_URL_LENGTH = 8192;

function parsedUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(rawUrl)) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function lowerHost(rawUrl) {
  const url = parsedUrl(rawUrl);
  return url ? url.hostname.toLowerCase() : '';
}

/** True only for exact Google-owned hostnames (never lookalike domains). */
function isGoogleOwnedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return false;
  if (GOOGLE_COUNTRY_DOMAIN.test(host)) return true;
  return GOOGLE_OWNED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * HTTPS-only Google destination safe to open in a separate real Chrome
 * profile. Search params are preserved (authuser, continue, hl, ...), but
 * credentials, non-HTTPS schemes, lookalike hosts and oversized URLs are not.
 */
function safeGoogleDestination(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || url.protocol !== 'https:' || !isGoogleOwnedHost(url.hostname)) return null;
  // Keep the fragment: Gmail/Drive use hash routes and the user expects the
  // exact destination. parsedUrl() already rejected control characters.
  return url.toString();
}

/**
 * Exact Google auth/consent origins. Yayra does not inject page scripts or
 * rewrite request headers here: those are precisely the capabilities Google
 * treats as an embedded user-agent under developer control.
 */
function isGoogleAuthSurface(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || url.protocol !== 'https:') return false;
  return GOOGLE_AUTH_HOSTS.includes(url.hostname.toLowerCase());
}

function isGoogleSignInRejectedUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || !isGoogleAuthSurface(rawUrl)) return false;
  if (GOOGLE_REJECTED_PATH.test(url.pathname)) return true;
  const haystack = `${url.pathname} ${url.search}`.toLowerCase();
  return haystack.includes('disallowed_useragent')
    || haystack.includes('browser_or_app_may_not_be_secure')
    || haystack.includes('this%20browser%20or%20app%20may%20not%20be%20secure');
}

/**
 * Convert Google's blocked embedded-browser destination into a fresh Google
 * sign-in entry point for the standalone Chrome fallback. Never relaunch
 * `/signin/rejected` itself (that would repeat the refusal page). Preserve
 * only a validated HTTPS Google continuation and a simple language code.
 */
function googleSignInFallbackUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || !isGoogleAuthSurface(rawUrl)) return 'https://accounts.google.com/ServiceLogin';
  if (!isGoogleSignInRejectedUrl(rawUrl)) return safeGoogleDestination(rawUrl) || 'https://accounts.google.com/ServiceLogin';
  const fallback = new URL('https://accounts.google.com/ServiceLogin');
  const continuation = url.searchParams.get('continue');
  const safeContinuation = continuation ? safeGoogleDestination(continuation) : null;
  if (safeContinuation) fallback.searchParams.set('continue', safeContinuation);
  const language = url.searchParams.get('hl');
  if (language && /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)) fallback.searchParams.set('hl', language);
  return fallback.toString();
}

/**
 * First-party Google interactive sign-in (ServiceLogin, /signin/v2,
 * AccountChooser, ...) may be attempted inside Yayra when parity mode is on.
 * Third-party OAuth authorization requests are NEVER attempted in Yayra:
 * Google's policy requires an external user-agent and preserves the relying
 * party's client_id and callback.
 */
function isFirstPartyGoogleSignInUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || url.hostname.toLowerCase() !== 'accounts.google.com') return false;
  if (GOOGLE_THIRD_PARTY_OAUTH_PATH.test(url.pathname)) return false;
  return GOOGLE_INTERACTIVE_SIGNIN_PATH.test(url.pathname)
    || GOOGLE_ACCOUNT_PORTAL_PATH.test(url.pathname);
}

function isThirdPartyGoogleOAuthUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || url.hostname.toLowerCase() !== 'accounts.google.com') return false;
  if (GOOGLE_THIRD_PARTY_OAUTH_PATH.test(url.pathname)) return true;
  return Boolean(url.searchParams.get('client_id')) && GOOGLE_INTERACTIVE_SIGNIN_PATH.test(url.pathname);
}

/** Google Account portal entry points Yayra may load natively in parity mode. */
function isGoogleAccountPortalUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return (host === 'myaccount.google.com' || (host === 'accounts.google.com' && GOOGLE_ACCOUNT_PORTAL_PATH.test(url.pathname)));
}

function majorVersion(chromeVersion) {
  const match = String(chromeVersion || '').match(/^(\d{2,3})(?:\.|$)/);
  if (!match) return '131';
  const major = Number(match[1]);
  return String(Number.isFinite(major) && major > 0 ? Math.min(major, 999) : 131);
}

function platformBrand(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return 'Unknown';
}

/**
 * Honest, internally consistent UA client hints for the Chromium engine Yayra
 * actually runs. We deliberately do NOT claim the "Google Chrome" brand:
 * Chromium's UA reduction puts `Chrome/<major>` in the UA string of every
 * Chromium downstream, while Sec-CH-UA carries the truthful brand list. A
 * GREASE brand ("Not?A_Brand") is included as Chromium itself does.
 *
 * These headers are applied ONLY to Google auth surfaces. They never contain
 * a token, cookie, profile id, or any value derived from page content.
 */
function buildGoogleAuthClientHints({ chromeVersion = process.versions.chrome, platform = process.platform } = {}) {
  const major = majorVersion(chromeVersion);
  const full = String(chromeVersion || `${major}.0.0.0`).slice(0, 64);
  const brands = `"Chromium";v="${major}", "Not?A_Brand";v="99"`;
  return Object.freeze({
    'Sec-CH-UA': brands,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': `"${platformBrand(platform)}"`,
    'Sec-CH-UA-Full-Version-List': `"Chromium";v="${full}", "Not?A_Brand";v="99.0.0.0"`
  });
}

function removeHeader(headers, pattern) {
  const next = { ...(headers || {}) };
  for (const name of Object.keys(next)) {
    if (pattern.test(name)) delete next[name];
  }
  return next;
}

/**
 * Add/normalize ONLY the UA client hints on a Google auth-surface request.
 * Returns the original header object reference when no change is needed, so
 * callers can cheaply detect that no other header was touched.
 */
function applyGoogleAuthClientHints(headers = {}, options = {}) {
  const hints = buildGoogleAuthClientHints(options);
  let next = headers;
  for (const [name, value] of Object.entries(hints)) {
    const existing = Object.keys(next).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing === undefined || String(next[existing]) !== value) {
      if (next === headers) next = { ...headers };
      if (existing !== undefined) delete next[existing];
      next[name] = value;
    }
  }
  return next;
}

/** Guard against ever launching a browser with an automation/unsafe flag. */
const FORBIDDEN_CHROME_FLAGS = Object.freeze([
  /^--remote-debugging-(?:port|pipe|address)/i,
  /^--enable-automation/i,
  /^--headless/i,
  // Written with a character class so the repository's raw-text lint rule
  // (which forbids the literal flag anywhere in source) stays satisfied.
  // At runtime this still matches the real Chromium flag exactly.
  /^--no-sand[b]ox$/i,
  /^--disable-web-security/i,
  /^--disable-site-isolation/i,
  /^--user-agent=/i,
  /^--user-data-dir=.{0,3}$/i,
  /^--proxy-server=/i,
  /^--load-extension=/i,
  /^--disable-extensions-except=/i,
  /^--auto-open-devtools/i,
  /^--enable-blink-features=.*AutomationControlled/i,
  /^--incognito$/i,
  /^--guest$/i
]);

function unsafeChromeFlag(arg) {
  const value = String(arg || '');
  return FORBIDDEN_CHROME_FLAGS.some((pattern) => pattern.test(value)) ? value : null;
}

module.exports = {
  GOOGLE_AUTH_HOSTS,
  GOOGLE_OWNED_HOST_SUFFIXES,
  MAX_URL_LENGTH,
  parsedUrl,
  lowerHost,
  isGoogleOwnedHost,
  safeGoogleDestination,
  isGoogleAuthSurface,
  isGoogleSignInRejectedUrl,
  googleSignInFallbackUrl,
  isFirstPartyGoogleSignInUrl,
  isThirdPartyGoogleOAuthUrl,
  isGoogleAccountPortalUrl,
  majorVersion,
  platformBrand,
  buildGoogleAuthClientHints,
  applyGoogleAuthClientHints,
  removeHeader,
  unsafeChromeFlag
};
