import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  generatePkcePair,
  generateState,
  buildAuthorizationUrl,
  parseCallbackUrl,
  exchangeCodeForTokens,
  fetchUserProfile,
  signInWithGoogle,
  CALLBACK_PATH,
  DEFAULT_SCOPES
} from '../electron/googleAuth.cjs';

// --- PKCE / state generation --------------------------------------------

test('generatePkcePair: produces a base64url verifier and its S256 challenge, no padding/unsafe chars', () => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.match(codeChallenge, /^[A-Za-z0-9_-]+$/);
  assert.ok(codeVerifier.length >= 43); // RFC 7636 minimum entropy
  assert.notEqual(codeVerifier, codeChallenge);
});

test('generatePkcePair: is deterministic given injected randomBytes, so the challenge is a pure function of the verifier', () => {
  const fixedRandom = () => Buffer.alloc(32, 7);
  const a = generatePkcePair(fixedRandom);
  const b = generatePkcePair(fixedRandom);
  assert.equal(a.codeVerifier, b.codeVerifier);
  assert.equal(a.codeChallenge, b.codeChallenge);
});

test('generateState: produces different values on each call with real randomness', () => {
  const s1 = generateState();
  const s2 = generateState();
  assert.notEqual(s1, s2);
  assert.match(s1, /^[A-Za-z0-9_-]+$/);
});

// --- Authorization URL ----------------------------------------------------

test('buildAuthorizationUrl: includes PKCE S256 challenge, state, and default identity-only scopes', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: 'client-123.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:54321/callback',
    state: 'abc',
    codeChallenge: 'xyz'
  }));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-123.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:54321/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'xyz');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('scope'), DEFAULT_SCOPES.join(' '));
  // Must never request broad Gmail/Drive/etc access for simple app sign-in.
  assert.ok(!url.searchParams.get('scope').includes('gmail'));
});

test('buildAuthorizationUrl: honors custom scopes when provided', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: 'c',
    redirectUri: 'http://127.0.0.1:1/callback',
    state: 's',
    codeChallenge: 'ch',
    scopes: ['openid', 'email']
  }));
  assert.equal(url.searchParams.get('scope'), 'openid email');
});

// --- Callback URL parsing --------------------------------------------------

test('parseCallbackUrl: extracts code and state from a successful redirect', () => {
  const result = parseCallbackUrl(`${CALLBACK_PATH}?code=abc123&state=xyz789`);
  assert.deepEqual(result, { code: 'abc123', state: 'xyz789' });
});

test('parseCallbackUrl: surfaces the error param when the user cancels/denies consent', () => {
  const result = parseCallbackUrl(`${CALLBACK_PATH}?error=access_denied&state=xyz789`);
  assert.deepEqual(result, { error: 'access_denied', state: 'xyz789' });
});

test('parseCallbackUrl: treats a missing code with no error as a malformed callback', () => {
  const result = parseCallbackUrl(`${CALLBACK_PATH}?state=xyz789`);
  assert.equal(result.error, 'missing_code');
});

test('parseCallbackUrl: ignores non-origin-form, untrusted-origin, and lookalike callback URLs', () => {
  assert.deepEqual(parseCallbackUrl('/favicon.ico'), { ignored: true });
  assert.deepEqual(parseCallbackUrl('/'), { ignored: true });
  assert.deepEqual(parseCallbackUrl('/callback/../callback?code=c&state=s'), { ignored: true });
  assert.deepEqual(parseCallbackUrl('/callback-evil?code=c&state=s'), { ignored: true });
  assert.deepEqual(parseCallbackUrl('http://evil.example/callback?code=c&state=s'), { ignored: true });
  assert.deepEqual(parseCallbackUrl('//evil.example/callback?code=c&state=s'), { ignored: true });
});

test('parseCallbackUrl: rejects duplicate OAuth security parameters', () => {
  assert.deepEqual(parseCallbackUrl('/callback?code=one&code=two&state=s'), { error: 'invalid_callback_parameters' });
  assert.deepEqual(parseCallbackUrl('/callback?code=c&state=one&state=two'), { error: 'invalid_callback_parameters' });
});

// --- Token exchange / userinfo (fetch injected, no real network) ---------

test('exchangeCodeForTokens: POSTs the correct PKCE token-exchange body with no client_secret', async () => {
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' }) };
  };
  const tokens = await exchangeCodeForTokens({
    clientId: 'client-123',
    code: 'auth-code',
    codeVerifier: 'verifier-abc',
    redirectUri: 'http://127.0.0.1:9999/callback',
    fetchImpl: fakeFetch
  });
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.options.method, 'POST');
  const body = new URLSearchParams(captured.options.body);
  assert.equal(body.get('client_id'), 'client-123');
  assert.equal(body.get('code'), 'auth-code');
  assert.equal(body.get('code_verifier'), 'verifier-abc');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:9999/callback');
  assert.equal(body.has('client_secret'), false); // no secret given: omit it rather than send "undefined"
  assert.deepEqual(tokens, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' });
});

test('exchangeCodeForTokens: includes client_secret in the body when one is configured (Google requires it for Desktop-app clients)', async () => {
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = options;
    return { ok: true, json: async () => ({ access_token: 'at' }) };
  };
  await exchangeCodeForTokens({
    clientId: 'client-123',
    clientSecret: 'shh-secret',
    code: 'auth-code',
    codeVerifier: 'verifier-abc',
    redirectUri: 'http://127.0.0.1:9999/callback',
    fetchImpl: fakeFetch
  });
  const body = new URLSearchParams(captured.body);
  assert.equal(body.get('client_secret'), 'shh-secret');
});

test('exchangeCodeForTokens: throws a descriptive error on a non-OK response instead of returning partial data', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
  await assert.rejects(
    () => exchangeCodeForTokens({ clientId: 'c', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetchImpl: fakeFetch }),
    /token_exchange_failed:400/
  );
});

test('fetchUserProfile: sends the bearer token and normalizes the response shape', async () => {
  let capturedHeaders = null;
  const fakeFetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      json: async () => ({ sub: '12345', email: 'user@example.com', email_verified: true, name: 'Ama Mensah', picture: 'https://example.com/p.jpg' })
    };
  };
  const profile = await fetchUserProfile({ accessToken: 'tok-abc', fetchImpl: fakeFetch });
  assert.equal(capturedHeaders.authorization, 'Bearer tok-abc');
  assert.deepEqual(profile, {
    sub: '12345',
    email: 'user@example.com',
    emailVerified: true,
    name: 'Ama Mensah',
    picture: 'https://example.com/p.jpg'
  });
});

test('fetchUserProfile: throws on a non-OK response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchUserProfile({ accessToken: 'bad', fetchImpl: fakeFetch }), /userinfo_failed:401/);
});

// --- Full signInWithGoogle flow (real loopback socket, fake browser+fetch) -

function openExternalThatHitsCallback(query) {
  // Simulates the user completing consent in their real system browser by
  // issuing the exact redirect request Google would send, against whatever
  // ephemeral port the loopback server actually bound to.
  return async (authUrl) => {
    const url = new URL(authUrl);
    const redirectUri = new URL(url.searchParams.get('redirect_uri'));
    const callback = new URL(redirectUri.toString());
    Object.entries(query(url)).forEach(([k, v]) => callback.searchParams.set(k, v));
    await new Promise((resolve, reject) => {
      http.get(callback, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  };
}

test('signInWithGoogle: completes the full PKCE + loopback + token + profile flow', async () => {
  const fakeFetch = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), 'real-client-id');
      assert.equal(body.get('client_secret'), 'real-client-secret');
      return { ok: true, json: async () => ({ access_token: 'access-xyz', refresh_token: 'refresh-xyz', expires_in: 3600 }) };
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      assert.equal(options.headers.authorization, 'Bearer access-xyz');
      return { ok: true, json: async () => ({ sub: '1', email: 'a@b.com', name: 'A B' }) };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  const openExternal = openExternalThatHitsCallback((url) => ({ code: 'auth-code-123', state: url.searchParams.get('state') }));

  const result = await signInWithGoogle({
    clientId: 'real-client-id',
    clientSecret: 'real-client-secret',
    openExternal,
    fetchImpl: fakeFetch,
    timeoutMs: 5000
  });

  assert.equal(result.profile.email, 'a@b.com');
  assert.equal(result.tokens.access_token, 'access-xyz');
});

test('signInWithGoogle: rejects when the callback state does not match (CSRF protection)', async () => {
  const openExternal = openExternalThatHitsCallback(() => ({ code: 'c', state: 'wrong-state' }));
  await assert.rejects(
    () => signInWithGoogle({ clientId: 'c', openExternal, fetchImpl: async () => { throw new Error('should not be called'); }, timeoutMs: 5000 }),
    /oauth_state_mismatch/
  );
});

test('signInWithGoogle: rejects cleanly when the user cancels consent (access_denied)', async () => {
  const openExternal = openExternalThatHitsCallback((url) => ({ error: 'access_denied', state: url.searchParams.get('state') }));
  await assert.rejects(
    () => signInWithGoogle({ clientId: 'c', openExternal, fetchImpl: async () => { throw new Error('should not be called'); }, timeoutMs: 5000 }),
    /oauth_error:access_denied/
  );
});

test('signInWithGoogle: rejects fast with a clear error when no Client ID is configured', async () => {
  await assert.rejects(
    () => signInWithGoogle({ clientId: '', openExternal: async () => {}, fetchImpl: async () => { throw new Error('should not be called'); } }),
    /google_oauth_not_configured/
  );
});

test('signInWithGoogle: rejects on timeout if the browser never completes the redirect', async () => {
  const openExternal = async () => {
    // Simulate a user who never finishes signing in: never hits the
    // callback server at all.
  };
  await assert.rejects(
    () => signInWithGoogle({ clientId: 'c', openExternal, fetchImpl: async () => { throw new Error('should not be called'); }, timeoutMs: 50 }),
    /oauth_timeout/
  );
});

test('signInWithGoogle: propagates a failed token exchange instead of reporting success', async () => {
  const openExternal = openExternalThatHitsCallback((url) => ({ code: 'c', state: url.searchParams.get('state') }));
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  await assert.rejects(
    () => signInWithGoogle({ clientId: 'c', openExternal, fetchImpl: fakeFetch, timeoutMs: 5000 }),
    /token_exchange_failed/
  );
});
