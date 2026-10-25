'use strict';

/**
 * Yayra "Sign in with Google" - Electron desktop OAuth 2.0 client
 * ----------------------------------------------------------------
 * This is a SEPARATE concern from electron/webviewBridge.cjs's website-auth
 * routing. Both avoid completing Google OAuth INSIDE an app-controlled page
 * surface, because Google rejects embedded user agents. See webviewBridge.cjs
 * and https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews.
 *
 * This file authenticates a user against Google for Yayra's own app-level
 * features. It uses the loopback callback + PKCE security model and the OS
 * default browser as the external user-agent Google and RFC 8252 require:
 *
 *   1. Open Google's consent screen in the OS default secure browser. A
 *      separate Electron BrowserWindow is still app-controlled and therefore
 *      is not a compliant external user-agent.
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
  url.searchParams.set('include_granted_scopes', 'true');
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
  // Node's loopback HTTP server should receive a bounded origin-form path
  // only. Reject absolute-form URLs, authority-relative targets and path
  // lookalikes before URL normalization can turn them into the trusted path.
  if (typeof requestUrl !== 'string' || requestUrl.length > 8192
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
  if (state && !/^[A-Za-z0-9_-]{1,256}$/.test(state)) return { error: 'invalid_callback_parameters' };
  if (error) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(error)) return { error: 'invalid_callback_parameters', state };
    return { error, state };
  }
  if (!code) return { error: 'missing_code', state };
  if (code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)) return { error: 'invalid_callback_parameters', state };
  return { code, state };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

const CLEAN_CALLBACK_SCRIPT = '<script>try{history.replaceState(null,"","/complete")}catch(e){}</script>';
const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Yayra sign-in complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0d12;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;"><h2>Signed in to Yayra</h2><p>Return to Yayra. You may close this browser tab.</p></div>${CLEAN_CALLBACK_SCRIPT}
</body></html>`;

const FAILURE_HTML = (reason) => `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Yayra sign-in failed</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0d12;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;"><h2>Sign-in did not complete</h2><p>${escapeHtml(reason)}</p><p>Return to Yayra.</p></div>${CLEAN_CALLBACK_SCRIPT}
</body></html>`;

const CALLBACK_RESPONSE_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
});

/**
 * Starts the one-shot loopback HTTP server, opens the injected OS external
 * user-agent to Google's consent screen once the server's assigned port is
 * known (needed to build the exact redirect_uri), and resolves with the
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
  onRedirectUriKnown,
  signal = null
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler = null;
    const timer = setTimeout(() => finish(new Error('oauth_timeout')), timeoutMs);
    timer.unref?.();

    const server = httpModule.createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { ...CALLBACK_RESPONSE_HEADERS, allow: 'GET' }).end();
        return;
      }
      const parsed = parseCallbackUrl(req.url);
      if (parsed.ignored) {
        res.writeHead(404, CALLBACK_RESPONSE_HEADERS).end();
        return;
      }
      if (parsed.state !== state) {
        res.writeHead(400, CALLBACK_RESPONSE_HEADERS).end(FAILURE_HTML('This sign-in attempt could not be verified and was rejected for your security.'));
        finish(new Error('oauth_state_mismatch'));
        return;
      }
      if (parsed.error) {
        const message = parsed.error === 'access_denied' ? 'You cancelled sign-in.' : `Google reported: ${parsed.error}`;
        res.writeHead(200, CALLBACK_RESPONSE_HEADERS).end(FAILURE_HTML(message));
        finish(new Error(`oauth_error:${parsed.error}`));
        return;
      }
      res.writeHead(200, CALLBACK_RESPONSE_HEADERS).end(SUCCESS_HTML);
      finish(null, parsed.code);
    });

    function finish(err, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortHandler && signal?.removeEventListener) {
        try { signal.removeEventListener('abort', abortHandler); } catch { /* optional signal shim */ }
      }
      try { server.close(); } catch { /* server may not have started yet */ }
      if (err) reject(err);
      else resolve(code);
    }

    if (signal) {
      abortHandler = () => finish(new Error('oauth_window_closed'));
      if (signal.aborted) {
        finish(new Error('oauth_window_closed'));
        return;
      }
      try { signal.addEventListener('abort', abortHandler, { once: true }); } catch { /* optional signal shim */ }
    }

    server.on('error', finish);
    server.listen(0, '127.0.0.1', async () => {
      if (settled) return;
      try {
        const { port } = server.address();
        const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        onRedirectUriKnown?.(redirectUri);
        const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes });
        logger?.info?.('[yayra:auth] opening Google sign-in in the system browser with a one-shot loopback callback');
        await openExternal(authUrl);
      } catch (err) {
        finish(err);
      }
    });
  });
}


async function exchangeCodeForTokens({ clientId, clientSecret, code, codeVerifier, redirectUri, fetchImpl = globalThis.fetch, signal = null }) {
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
  if (signal?.aborted) throw new Error('oauth_window_closed');
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  };
  if (signal) request.signal = signal;
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, request);
  if (!response.ok) {
    let detail = 'upstream_error';
    try {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(parsed.error)) detail = parsed.error;
    } catch { /* never echo an upstream body into logs or renderer errors */ }
    throw new Error(`token_exchange_failed:${response.status}:${detail}`);
  }
  const tokens = await response.json();
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token
    || tokens.access_token.length > 8192 || /[\u0000-\u0020\u007f]/.test(tokens.access_token)) {
    throw new Error('token_exchange_malformed');
  }
  return tokens;
}

async function fetchUserProfile({ accessToken, fetchImpl = globalThis.fetch, signal = null }) {
  if (signal?.aborted) throw new Error('oauth_window_closed');
  const request = { headers: { authorization: `Bearer ${accessToken}` } };
  if (signal) request.signal = signal;
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, request);
  if (!response.ok) {
    throw new Error(`userinfo_failed:${response.status}`);
  }
  const data = await response.json();
  const sub = typeof data?.sub === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(data.sub) ? data.sub : null;
  const email = typeof data?.email === 'string' && data.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(data.email)
    ? data.email
    : null;
  if (!sub || !email) throw new Error('userinfo_malformed');
  const name = typeof data.name === 'string'
    ? data.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
    : null;
  let picture = null;
  if (typeof data.picture === 'string' && data.picture.length <= 2048) {
    try {
      const parsedPicture = new URL(data.picture);
      if (parsedPicture.protocol === 'https:' && !parsedPicture.username && !parsedPicture.password) picture = parsedPicture.toString();
    } catch { /* optional picture is dropped */ }
  }
  return { sub, email, emailVerified: Boolean(data.email_verified), name, picture };
}

/**
 * Runs the full interactive sign-in flow end to end: PKCE/state generation,
 * loopback server + OS external browser, code-for-token exchange, and
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
  logger = console,
  signal = null
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
    signal,
    onRedirectUriKnown: (uri) => { capturedRedirectUri = uri; }
  });

  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code, codeVerifier, redirectUri: capturedRedirectUri, fetchImpl, signal });
  const profile = await fetchUserProfile({ accessToken: tokens.access_token, fetchImpl, signal });

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
