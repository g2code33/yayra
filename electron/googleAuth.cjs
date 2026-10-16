'use strict';

/**
 * Yayra "Sign in with Google" - Electron desktop OAuth 2.0 client
 * ----------------------------------------------------------------
 * This is a SEPARATE concern from electron/webviewBridge.cjs's embedded-auth
 * handoff. That file stops Yayra from ever trying (and failing) to complete
 * a Google sign-in INSIDE the embedded browsing surface, because Google
 * actively refuses that for any embedded webview - see the comment at the
 * top of webviewBridge.cjs and
 * https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews.
 *
 * This file is how Yayra ITSELF authenticates a user against their Google
 * account for its own app-level features (not for browsing Google services
 * logged in inside the embedded view - that is never possible, by Google's
 * own design, from ANY embedded browser surface, and this file does not
 * attempt it). It implements the OAuth 2.0 flow Google explicitly recommends
 * for native/installed apps per RFC 8252 ("OAuth 2.0 for Native Apps"):
 *
 *   1. Open the user's real SYSTEM browser to Google's consent screen
 *      (shell.openExternal - never an embedded view).
 *   2. Use the Authorization Code + PKCE flow. Google's docs call "Desktop
 *      app" OAuth clients public/non-confidential, but Google's token
 *      endpoint still rejects the code exchange without a client_secret in
 *      the request body (a known Google-specific quirk - PKCE is additive
 *      here, not a replacement). The secret is still non-confidential in the
 *      sense Google means: it's fine for it to ship inside the built app,
 *      same as the Client ID - see electron/googleAuthConfig.cjs.
 *   3. Catch the redirect with a short-lived local HTTP server bound to
 *      127.0.0.1 on an OS-assigned port. Google's own native-app guide
 *      documents this "loopback interface redirect" as the supported pattern
 *      for desktop/CLI apps; it requires no custom URI scheme registration
 *      and no domain of any kind.
 *      https://developers.google.com/identity/protocols/oauth2/native-app#loopback-ip-address
 *   4. Exchange the authorization code for tokens directly with Google's
 *      token endpoint, then fetch the user's basic profile (name/email/
 *      picture) from the userinfo endpoint.
 *
 * Every external effect (opening the browser, the HTTP server, the network
 * calls, random byte generation) is dependency-injected so PKCE/state
 * generation, callback URL parsing, and the token-exchange request shape can
 * be unit-tested without a real Electron runtime, a real browser, or a live
 * network connection to Google - see tests/google-oauth.test.mjs. The live
 * end-to-end round trip against real Google servers has NOT been run by this
 * agent (no GUI/browser or registered Client ID in this sandbox) and can
 * only be verified by a human clicking through a real consent screen with a
 * real Client ID from their own Google Cloud project.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
const CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // give the user 5 minutes to complete sign-in

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generates an RFC 7636 PKCE code_verifier/code_challenge pair. */
function generatePkcePair(randomBytesImpl = crypto.randomBytes) {
  const codeVerifier = base64url(randomBytesImpl(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function generateState(randomBytesImpl = crypto.randomBytes) {
  return base64url(randomBytesImpl(16));
}

function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes = DEFAULT_SCOPES }) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  return url.toString();
}

/**
 * Parses an incoming loopback callback request's query string into either
 * { code, state }, { error, state }, or { ignored: true } for any request
 * that isn't the expected callback path (e.g. a stray favicon fetch). Pure
 * function, no I/O, fully unit-testable.
 */
function parseCallbackUrl(requestUrl) {
  // Node's loopback HTTP server should receive an origin-form path only.
  // Reject absolute-form URLs, authority-relative targets and path lookalikes
  // before URL normalization can turn them into the trusted callback path.
  if (typeof requestUrl !== 'string'
    || (requestUrl !== CALLBACK_PATH && !requestUrl.startsWith(`${CALLBACK_PATH}?`))) {
    return { ignored: true };
  }
  let url;
  try { url = new URL(requestUrl, 'http://127.0.0.1'); } catch { return { ignored: true }; }
  if (url.origin !== 'http://127.0.0.1' || url.pathname !== CALLBACK_PATH || url.hash) return { ignored: true };
  const errors = url.searchParams.getAll('error');
  const codes = url.searchParams.getAll('code');
  const states = url.searchParams.getAll('state');
  if (errors.length > 1 || codes.length > 1 || states.length > 1) return { error: 'invalid_callback_parameters' };
  const error = errors[0];
  const code = codes[0];
  const state = states[0];
  if (error) return { error, state };
  if (!code) return { error: 'missing_code', state };
  return { code, state };
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Yayra sign-in complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0d12;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;"><h2>Signed in to Yayra</h2><p>You can close this tab and return to the Yayra app.</p></div>
</body></html>`;

const FAILURE_HTML = (reason) => `<!doctype html><html><head><meta charset="utf-8"><title>Yayra sign-in failed</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0d12;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;"><h2>Sign-in did not complete</h2><p>${reason}</p><p>You can close this tab and return to the Yayra app.</p></div>
</body></html>`;

/**
 * Starts the one-shot loopback HTTP server, opens the user's system browser
 * to Google's consent screen once the server's real assigned port is known
 * (needed to build the exact redirect_uri), and resolves with the
 * authorization code once Google redirects back. Rejects on state mismatch,
 * an error param from Google (e.g. the user clicked "Cancel"), or timeout.
 */
function runLoopbackAuthorization({
  clientId,
  scopes,
  state,
  codeChallenge,
  openExternal,
  httpModule = http,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
  onRedirectUriKnown
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('oauth_timeout')), timeoutMs);
    timer.unref?.();

    const server = httpModule.createServer((req, res) => {
      const parsed = parseCallbackUrl(req.url);
      if (parsed.ignored) {
        res.writeHead(404).end();
        return;
      }
      if (parsed.state !== state) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(FAILURE_HTML('This sign-in attempt could not be verified and was rejected for your security.'));
        finish(new Error('oauth_state_mismatch'));
        return;
      }
      if (parsed.error) {
        const message = parsed.error === 'access_denied' ? 'You cancelled sign-in.' : `Google reported: ${parsed.error}`;
        res.writeHead(200, { 'content-type': 'text/html' }).end(FAILURE_HTML(message));
        finish(new Error(`oauth_error:${parsed.error}`));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(SUCCESS_HTML);
      finish(null, parsed.code);
    });

    function finish(err, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(code);
    }

    server.on('error', finish);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        onRedirectUriKnown?.(redirectUri);
        const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes });
        logger?.info?.(`[yayra:auth] opening system browser for Google sign-in (redirect ${redirectUri})`);
        await openExternal(authUrl);
      } catch (err) {
        finish(err);
      }
    });
  });
}


async function exchangeCodeForTokens({ clientId, clientSecret, code, codeVerifier, redirectUri, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  // Google requires this for Desktop-app clients despite PKCE - see the
  // file header comment above for why this is still safe to send.
  if (clientSecret) body.set('client_secret', clientSecret);
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`token_exchange_failed:${response.status}:${text}`);
  }
  return response.json();
}

async function fetchUserProfile({ accessToken, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`userinfo_failed:${response.status}`);
  }
  const data = await response.json();
  return {
    sub: data.sub,
    email: data.email || null,
    emailVerified: Boolean(data.email_verified),
    name: data.name || null,
    picture: data.picture || null
  };
}

/**
 * Runs the full interactive sign-in flow end to end: PKCE/state generation,
 * loopback server + system browser handoff, code-for-token exchange, and
 * profile fetch. Returns { profile, tokens } on success, where tokens is the
 * raw Google token response ({ access_token, refresh_token?, expires_in,
 * id_token, ... }). Throws on cancellation, state mismatch, timeout, or any
 * network/HTTP failure - callers should surface a user-facing message rather
 * than assuming success.
 */
async function signInWithGoogle({
  clientId,
  clientSecret,
  scopes = DEFAULT_SCOPES,
  openExternal,
  httpModule = http,
  fetchImpl = globalThis.fetch,
  randomBytesImpl = crypto.randomBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console
}) {
  if (!clientId) throw new Error('google_oauth_not_configured');
  if (typeof openExternal !== 'function') throw new Error('openExternal_required');

  const { codeVerifier, codeChallenge } = generatePkcePair(randomBytesImpl);
  const state = generateState(randomBytesImpl);

  let capturedRedirectUri = null;
  const code = await runLoopbackAuthorization({
    clientId,
    scopes,
    state,
    codeChallenge,
    openExternal,
    httpModule,
    timeoutMs,
    logger,
    onRedirectUriKnown: (uri) => { capturedRedirectUri = uri; }
  });

  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code, codeVerifier, redirectUri: capturedRedirectUri, fetchImpl });
  const profile = await fetchUserProfile({ accessToken: tokens.access_token, fetchImpl });

  return { profile, tokens };
}

module.exports = {
  DEFAULT_SCOPES,
  CALLBACK_PATH,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  generatePkcePair,
  generateState,
  buildAuthorizationUrl,
  parseCallbackUrl,
  runLoopbackAuthorization,
  exchangeCodeForTokens,
  fetchUserProfile,
  signInWithGoogle
};
