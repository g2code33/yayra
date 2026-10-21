import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CALLBACK_PATH,
  PENDING_KEY,
  PROFILE_KEY,
  beginSignIn,
  buildAuthorizationUrl,
  clearProfile,
  completeSignIn,
  createWebAuthBridge,
  generatePkcePair,
  generateState,
  loadProfile,
  normalizeGoogleProductOrigin,
  parseCallbackParams,
  saveProfile
} from '../src/services/googleAuthWeb.js';
import { resolveWebGoogleAuthConfig } from '../src/config/googleAuthWeb.js';

// Minimal Storage stand-in (same contract as window.localStorage /
// window.sessionStorage) so every test runs without a browser.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map.entries())
  };
}

const CLIENT_ID = 'web-client-id.apps.googleusercontent.com';
const ORIGIN = 'https://yayra.pages.dev';
const EXCHANGE_URL = 'https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange';
const VALID_WEB_VERIFIER = 'A'.repeat(43);
const VALID_WEB_STATE = 'state-xyz-12345678';
const VALID_WEB_CHALLENGE = 'B'.repeat(43);

// --- PKCE / state generation --------------------------------------------

test('web PKCE pair: challenge is base64url(SHA-256(verifier)), both URL-safe', async () => {
  const { codeVerifier, codeChallenge } = await generatePkcePair(globalThis.crypto);
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = createHash('sha256').update(codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(codeChallenge, expected);
});

test('web state parameter is unpredictable and URL-safe', () => {
  const a = generateState(globalThis.crypto);
  const b = generateState(globalThis.crypto);
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
});

// --- Authorization URL ----------------------------------------------------

test('web authorization URL carries PKCE S256 + account chooser and NEVER a client secret or offline access', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    state: VALID_WEB_STATE,
    codeChallenge: VALID_WEB_CHALLENGE
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://yayra.pages.dev/auth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('code_challenge'), VALID_WEB_CHALLENGE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  // A browser client is public: no secret can exist here, and no long-lived
  // refresh token should ever be requested (nowhere safe to store it).
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal(url.searchParams.get('access_type'), null);
});

test('web authorization URL rejects broad scopes and malformed PKCE/state inputs', () => {
  assert.throws(() => buildAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    state: VALID_WEB_STATE,
    codeChallenge: VALID_WEB_CHALLENGE,
    scopes: ['openid', 'email', 'profile', 'https://mail.google.com/']
  }), /invalid_scopes/);
  assert.throws(() => buildAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    state: 'predictable',
    codeChallenge: 'short'
  }), /invalid_state|invalid_code_challenge/);
});

// --- beginSignIn (step 1: stash + full-page redirect) ---------------------

test('beginSignIn stashes verifier/state/returnTo in sessionStorage and navigates the page to Google', async () => {
  const session = fakeStorage();
  const navigations = [];
  const url = await beginSignIn({
    clientId: CLIENT_ID,
    origin: ORIGIN,
    returnTo: '/settings',
    sessionStorage: session,
    navigate: (target) => navigations.push(target)
  });
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0], url);
  const pending = JSON.parse(session.getItem(PENDING_KEY));
  assert.match(pending.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pending.returnTo, '/settings');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('state'), pending.state);
  // The challenge in the URL must correspond to the stashed verifier.
  const expectedChallenge = createHash('sha256').update(pending.codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(parsed.searchParams.get('code_challenge'), expectedChallenge);
});

test('beginSignIn refuses to start without a client id', async () => {
  await assert.rejects(
    () => beginSignIn({ clientId: '', origin: ORIGIN, sessionStorage: fakeStorage(), navigate: () => {} }),
    /not_configured/
  );
});

test('beginSignIn rejects an untrusted redirect origin and stores only a same-origin return path', async () => {
  await assert.rejects(
    () => beginSignIn({ clientId: CLIENT_ID, origin: 'javascript:alert(1)', sessionStorage: fakeStorage(), navigate: () => {} }),
    /invalid_redirect_uri/
  );
  const session = fakeStorage();
  await beginSignIn({ clientId: CLIENT_ID, origin: ORIGIN, returnTo: '//attacker.example', sessionStorage: session, navigate: () => {} });
  assert.equal(JSON.parse(session.getItem(PENDING_KEY)).returnTo, '/');
});

// --- parseCallbackParams ---------------------------------------------------

test('parseCallbackParams surfaces Google errors, rejects incomplete or ambiguous callbacks', () => {
  assert.deepEqual(parseCallbackParams('?error=access_denied'), { ok: false, error: 'access_denied' });
  assert.deepEqual(parseCallbackParams('?error=access_denied&state=xyz'), { ok: false, error: 'access_denied', state: 'xyz' });
  assert.deepEqual(parseCallbackParams('?code=abc'), { ok: false, error: 'missing_code_or_state' });
  assert.deepEqual(parseCallbackParams('?code=abc&state=xyz'), { ok: true, code: 'abc', state: 'xyz' });
  assert.deepEqual(parseCallbackParams('?code=one&code=two&state=xyz'), { ok: false, error: 'invalid_callback' });
  assert.deepEqual(parseCallbackParams('?code=abc&state=one&state=two'), { ok: false, error: 'invalid_callback' });
});

// --- completeSignIn (step 2: validate + server-side exchange) -------------

function pendingSession(overrides = {}) {
  return fakeStorage({
    [PENDING_KEY]: JSON.stringify({
      codeVerifier: VALID_WEB_VERIFIER,
      state: VALID_WEB_STATE,
      returnTo: '/settings',
      startedAt: new Date().toISOString(),
      ...overrides
    })
  });
}

test('completeSignIn posts code+verifier+redirectUri to the worker and returns profile + returnTo - never tokens', async () => {
  const session = pendingSession();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      profile: {
        sub: '108',
        name: 'Ama Mensah',
        email: 'ama@example.com',
        picture: 'https://lh3.googleusercontent.com/a/photo',
        // A hypothetical worker regression leaking extra fields must be
        // stripped at this seam.
        access_token: 'leaked-token'
      }
    }), { status: 200 });
  };

  const result = await completeSignIn({ search: `?code=auth-code-1&state=${VALID_WEB_STATE}`, origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: session, fetchImpl });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, EXCHANGE_URL);
  assert.equal(requests[0].options.method, 'POST');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body, { code: 'auth-code-1', codeVerifier: VALID_WEB_VERIFIER, redirectUri: 'https://yayra.pages.dev/auth/callback' });
  // No token-ish material may leave completeSignIn.
  assert.deepEqual(result, {
    profile: { sub: '108', name: 'Ama Mensah', email: 'ama@example.com', picture: 'https://lh3.googleusercontent.com/a/photo' },
    returnTo: '/settings'
  });
  assert.equal(JSON.stringify(result).includes('leaked-token'), false);
  // Pending stash is single-use.
  assert.equal(session.getItem(PENDING_KEY), null);
});

test('completeSignIn rejects a CSRF state mismatch and still consumes the pending attempt', async () => {
  const session = pendingSession();
  await assert.rejects(
    () => completeSignIn({ search: '?code=c&state=WRONG', origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: session, fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /state_mismatch/
  );
  assert.equal(session.getItem(PENDING_KEY), null);
});

test('completeSignIn validates state on OAuth error callbacks before surfacing the provider error', async () => {
  await assert.rejects(
    () => completeSignIn({ search: '?error=access_denied&state=wrong', origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: pendingSession(), fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /state_mismatch/
  );
  await assert.rejects(
    () => completeSignIn({ search: `?error=access_denied&state=${VALID_WEB_STATE}`, origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: pendingSession(), fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /access_denied/
  );
});

test('completeSignIn rejects a callback on an unexpected route or untrusted origin before exchanging', async () => {
  const session = pendingSession();
  await assert.rejects(
    () => completeSignIn({ search: `?code=c&state=${VALID_WEB_STATE}`, origin: ORIGIN, pathname: '/not-auth-callback', exchangeUrl: EXCHANGE_URL, sessionStorage: session, fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /invalid_callback/
  );
  assert.ok(session.getItem(PENDING_KEY), 'an unrelated route cannot consume the pending sign-in');

  await assert.rejects(
    () => completeSignIn({ search: `?code=c&state=${VALID_WEB_STATE}`, origin: 'http://evil.example', exchangeUrl: EXCHANGE_URL, sessionStorage: session, fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /invalid_redirect_uri/
  );
});

test('completeSignIn rejects a malformed pending PKCE verifier before worker exchange', async () => {
  const session = pendingSession({ codeVerifier: 'short' });
  await assert.rejects(
    () => completeSignIn({ search: `?code=c&state=${VALID_WEB_STATE}`, origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: session, fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /corrupt_pending_sign_in/
  );
  assert.equal(session.getItem(PENDING_KEY), null, 'the malformed attempt is consumed and cannot be replayed');
});

test('completeSignIn expires stale PKCE/state transactions before any worker request', async () => {
  const session = pendingSession({ startedAt: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(
    () => completeSignIn({
      search: `?code=c&state=${VALID_WEB_STATE}`,
      origin: ORIGIN,
      exchangeUrl: EXCHANGE_URL,
      sessionStorage: session,
      fetchImpl: async () => { throw new Error('must not fetch'); },
      now: () => Date.parse('2026-01-01T00:11:00.000Z')
    }),
    /expired_pending_sign_in/
  );
  assert.equal(session.getItem(PENDING_KEY), null, 'an expired transaction is consumed');
});

test('completeSignIn rejects non-HTTPS or wrong-route exchange endpoints before consuming state', async () => {
  const session = pendingSession();
  await assert.rejects(
    () => completeSignIn({
      search: `?code=c&state=${VALID_WEB_STATE}`,
      origin: ORIGIN,
      exchangeUrl: 'https://attacker.example/collect',
      sessionStorage: session,
      fetchImpl: async () => { throw new Error('must not fetch'); }
    }),
    /invalid_exchange_url/
  );
  assert.ok(session.getItem(PENDING_KEY), 'deployment misconfiguration does not consume a valid pending transaction');
});

test('completeSignIn rejects a callback with no pending sign-in (replayed/bookmarked URL)', async () => {
  await assert.rejects(
    () => completeSignIn({ search: '?code=c&state=s', origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: fakeStorage(), fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /no_pending_sign_in/
  );
});

test('completeSignIn surfaces Google consent-screen cancellation as its error code', async () => {
  await assert.rejects(
    () => completeSignIn({ search: `?error=access_denied&state=${VALID_WEB_STATE}`, origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: pendingSession(), fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /access_denied/
  );
});

test('completeSignIn reports a failed worker exchange with status detail', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 502 });
  await assert.rejects(
    () => completeSignIn({ search: `?code=c&state=${VALID_WEB_STATE}`, origin: ORIGIN, exchangeUrl: EXCHANGE_URL, sessionStorage: pendingSession(), fetchImpl }),
    /exchange_failed:502:invalid_grant/
  );
});

test('completeSignIn bounds Worker responses and never echoes an arbitrary upstream body', async () => {
  const secretBody = '<html>access_token=do-not-echo user diagnostic</html>';
  await assert.rejects(
    () => completeSignIn({
      search: `?code=c&state=${VALID_WEB_STATE}`,
      origin: ORIGIN,
      exchangeUrl: EXCHANGE_URL,
      sessionStorage: pendingSession(),
      fetchImpl: async () => new Response(secretBody, { status: 502 })
    }),
    (error) => error.message === 'exchange_failed:502:upstream_error' && !error.message.includes('do-not-echo')
  );
  await assert.rejects(
    () => completeSignIn({
      search: `?code=c&state=${VALID_WEB_STATE}`,
      origin: ORIGIN,
      exchangeUrl: EXCHANGE_URL,
      sessionStorage: pendingSession(),
      fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 })
    }),
    /exchange_response_too_large/
  );
});

// --- profile persistence (localStorage, profile-only) ----------------------

test('profile persistence round trip stores only profile + savedAt, and clears cleanly', () => {
  const local = fakeStorage();
  saveProfile(local, { sub: '1', name: 'A', email: 'a@b.c', picture: 'p' });
  const loaded = loadProfile(local);
  assert.equal(loaded.profile.email, 'a@b.c');
  assert.ok(loaded.savedAt);
  // Nothing token-shaped is ever persisted in the browser.
  const serialized = JSON.stringify(local.dump());
  for (const needle of ['access_token', 'refresh_token', 'id_token']) {
    assert.equal(serialized.includes(needle), false, `localStorage must never contain ${needle}`);
  }
  clearProfile(local);
  assert.equal(loadProfile(local), null);
});

test('loadProfile tolerates corrupt or incomplete stored JSON', () => {
  assert.equal(loadProfile(fakeStorage({ [PROFILE_KEY]: 'not json' })), null);
  assert.equal(loadProfile(fakeStorage({ [PROFILE_KEY]: JSON.stringify({ profile: {} }) })), null);
});

// --- the authBridge-shaped adapter -----------------------------------------

function makeBridge({ local = fakeStorage(), session = fakeStorage(), navigations = [], windows = [] } = {}) {
  return {
    local,
    session,
    navigations,
    windows,
    bridge: createWebAuthBridge({
      clientId: CLIENT_ID,
      exchangeUrl: EXCHANGE_URL,
      origin: ORIGIN,
      localStorage: local,
      sessionStorage: session,
      navigate: (url) => navigations.push(url),
      openWindow: (url) => windows.push(url),
      getPath: () => '/current-page'
    })
  };
}

test('web auth bridge satisfies the BrowserShell contract: signIn emits signing-in and redirects with the current path preserved', async () => {
  const { bridge, navigations, session } = makeBridge();
  const events = [];
  bridge.onEvent((evt) => events.push(evt));
  const result = await bridge.signIn();
  assert.deepEqual(result, { ok: true, pending: true });
  assert.deepEqual(events.map((e) => e.type), ['signing-in']);
  assert.equal(navigations.length, 1);
  assert.equal(JSON.parse(session.getItem(PENDING_KEY)).returnTo, '/current-page');
});

test('web auth bridge reports not_configured without a client id instead of failing deep in the flow', async () => {
  const bridge = createWebAuthBridge({ clientId: null, exchangeUrl: EXCHANGE_URL, origin: ORIGIN, localStorage: fakeStorage(), sessionStorage: fakeStorage(), navigate: () => {}, openWindow: () => {} });
  assert.deepEqual(await bridge.signIn(), { ok: false, error: 'not_configured' });
});

test('web auth bridge getSession/signOut mirror the Electron bridge shapes (profile only)', async () => {
  const { bridge, local } = makeBridge();
  assert.deepEqual(await bridge.getSession(), { signedIn: false });

  saveProfile(local, { sub: '2', name: 'Kofi', email: 'kofi@example.com', picture: 'pic' });
  const sessionInfo = await bridge.getSession();
  assert.equal(sessionInfo.signedIn, true);
  assert.equal(sessionInfo.profile.email, 'kofi@example.com');
  assert.ok(sessionInfo.savedAt);

  const events = [];
  bridge.onEvent((evt) => events.push(evt));
  assert.deepEqual(await bridge.signOut(), { ok: true });
  assert.deepEqual(events.map((e) => e.type), ['signed-out']);
  assert.deepEqual(await bridge.getSession(), { signedIn: false });
});

test('web auth bridge openAccountPage only ever opens the single hardcoded Google account URL', async () => {
  const { bridge, windows } = makeBridge();
  assert.deepEqual(await bridge.openAccountPage(), { ok: true });
  assert.deepEqual(windows, ['https://myaccount.google.com/']);
});

test('web auth bridge opens only sanitized Google product origins', async () => {
  const { bridge, windows } = makeBridge();
  assert.equal(normalizeGoogleProductOrigin('https://mail.google.com/mail/u/0/?auth=private'), 'https://mail.google.com/');
  assert.deepEqual(await bridge.openGoogleProduct('https://mail.google.com/mail/u/0/?auth=private'), { ok: true });
  assert.deepEqual(windows, ['https://mail.google.com/']);
  assert.deepEqual(await bridge.openGoogleProduct('https://google.com.evil.example/'), { ok: false, error: 'invalid_google_product_origin' });
  assert.deepEqual(windows, ['https://mail.google.com/']);
});

test('web auth bridge onEvent unsubscribe stops delivery and a throwing listener cannot break others', async () => {
  const { bridge } = makeBridge();
  const seen = [];
  bridge.onEvent(() => { throw new Error('bad listener'); });
  const unsubscribe = bridge.onEvent((evt) => seen.push(evt.type));
  await bridge.signOut();
  assert.deepEqual(seen, ['signed-out']);
  unsubscribe();
  await bridge.signOut();
  assert.deepEqual(seen, ['signed-out']);
});

// --- build-time config resolution ------------------------------------------

function fakeDocWithMetas(metas) {
  return {
    querySelector: (selector) => {
      const match = /meta\[name="([^"]+)"\]/.exec(selector);
      const value = match && metas[match[1]];
      return value ? { getAttribute: (attr) => (attr === 'content' ? value : null) } : null;
    }
  };
}

test('web auth config resolves from injected meta tags, treating unreplaced placeholders as unconfigured', () => {
  const configured = resolveWebGoogleAuthConfig({
    win: {},
    doc: fakeDocWithMetas({ 'yayra-google-web-client-id': CLIENT_ID, 'yayra-google-auth-exchange-url': EXCHANGE_URL })
  });
  assert.deepEqual(configured, { clientId: CLIENT_ID, exchangeUrl: EXCHANGE_URL });

  const placeholder = resolveWebGoogleAuthConfig({
    win: {},
    doc: fakeDocWithMetas({ 'yayra-google-web-client-id': '__GOOGLE_WEB_CLIENT_ID__' })
  });
  assert.deepEqual(placeholder, { clientId: null, exchangeUrl: null });

  const missing = resolveWebGoogleAuthConfig({ win: {}, doc: fakeDocWithMetas({}) });
  assert.deepEqual(missing, { clientId: null, exchangeUrl: null });
});

test('web auth config falls back to the production worker exchange URL when only a client id is provided', () => {
  const resolved = resolveWebGoogleAuthConfig({
    win: {},
    doc: fakeDocWithMetas({ 'yayra-google-web-client-id': CLIENT_ID })
  });
  assert.equal(resolved.clientId, CLIENT_ID);
  assert.match(resolved.exchangeUrl, /^https:\/\/.+\/auth\/google\/exchange$/);
});

test('web auth config window override wins over metas (test/experiment hook)', () => {
  const resolved = resolveWebGoogleAuthConfig({
    win: { __YAYRA_GOOGLE_WEB_AUTH__: { clientId: 'override-id', exchangeUrl: 'https://example.com/x' } },
    doc: fakeDocWithMetas({ 'yayra-google-web-client-id': CLIENT_ID })
  });
  assert.deepEqual(resolved, { clientId: 'override-id', exchangeUrl: 'https://example.com/x' });
});
