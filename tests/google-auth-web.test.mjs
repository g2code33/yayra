import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CALLBACK_PATH,
  DRIVE_SCOPES,
  DRIVE_SESSION_KEY,
  GMAIL_SCOPES,
  GMAIL_SESSION_KEY,
  PENDING_KEY,
  PROFILE_KEY,
  authStorageKey,
  beginSignIn,
  buildAuthorizationUrl,
  clearProfile,
  completeSignIn,
  createWebAuthBridge,
  downloadDelegatedDriveFile,
  driveDownloadUrlForExchange,
  driveRevokeUrlForExchange,
  generatePkcePair,
  generateState,
  getDelegatedGmailMessage,
  listDelegatedGmailMessages,
  loadDriveSession,
  loadGmailSession,
  loadProfile,
  normalizeGoogleProductOrigin,
  parseCallbackParams,
  revokeDelegatedDriveSession,
  saveDriveSession,
  saveGmailSession,
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

test('Drive authorization is a separate explicit consent with only drive.readonly and offline return capability', async () => {
  const session = fakeStorage();
  let target = '';
  await beginSignIn({
    clientId: CLIENT_ID,
    origin: ORIGIN,
    returnTo: '/downloads',
    capability: 'drive-readonly',
    sessionStorage: session,
    navigate: (url) => { target = url; }
  });
  const parsed = new URL(target);
  assert.equal(parsed.searchParams.get('scope'), DRIVE_SCOPES.join(' '));
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(JSON.parse(session.getItem(PENDING_KEY)).capability, 'drive-readonly');
});

test('Gmail authorization is an explicit read-only consent that preserves the callback destination', async () => {
  const session = fakeStorage();
  let target = '';
  await beginSignIn({
    clientId: CLIENT_ID,
    origin: ORIGIN,
    returnTo: '/?restored=gmail',
    capability: 'gmail-readonly',
    sessionStorage: session,
    navigate: (url) => { target = url; }
  });
  const parsed = new URL(target);
  assert.equal(parsed.searchParams.get('scope'), GMAIL_SCOPES.join(' '));
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('include_granted_scopes'), 'true');
  const pending = JSON.parse(session.getItem(PENDING_KEY));
  assert.equal(pending.capability, 'gmail-readonly');
  assert.equal(pending.returnTo, '/?restored=gmail');
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
  assert.deepEqual(body, {
    code: 'auth-code-1',
    codeVerifier: VALID_WEB_VERIFIER,
    redirectUri: 'https://yayra.pages.dev/auth/callback',
    platform: 'web',
    capability: 'profile'
  });
  // No token-ish material may leave completeSignIn.
  assert.deepEqual(result, {
    profile: { sub: '108', name: 'Ama Mensah', email: 'ama@example.com', picture: 'https://lh3.googleusercontent.com/a/photo' },
    returnTo: '/settings'
  });
  assert.equal(JSON.stringify(result).includes('leaked-token'), false);
  // Pending stash is single-use.
  assert.equal(session.getItem(PENDING_KEY), null);
});

test('Drive callback returns only an opaque persistent session and delegated download stays origin-scoped', async () => {
  const pending = pendingSession({ capability: 'drive-readonly' });
  const sessionId = 'D'.repeat(43);
  let exchangeBody;
  const completed = await completeSignIn({
    search: `?code=drive-code&state=${VALID_WEB_STATE}`,
    origin: ORIGIN,
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: pending,
    fetchImpl: async (_url, options) => {
      exchangeBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        profile: { sub: '108', name: 'Ama', email: 'ama@example.com' },
        driveSession: { id: sessionId, expiresAt: '2099-01-01T00:00:00.000Z', scope: 'drive.readonly' }
      }), { status: 200 });
    }
  });
  assert.equal(exchangeBody.capability, 'drive-readonly');
  assert.equal(completed.driveSession.id, sessionId);
  assert.equal(JSON.stringify(completed).includes('access_token'), false);

  const persistentStorage = fakeStorage();
  saveDriveSession(persistentStorage, completed.driveSession);
  assert.equal(loadDriveSession(persistentStorage).id, sessionId, 'opaque Drive access survives a Yayra restart');
  const calls = [];
  const downloaded = await downloadDelegatedDriveFile({
    fileId: 'file-1234567890',
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: persistentStorage,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Disposition': "attachment; filename*=UTF-8''Research%20Methodology.pptx",
          'Content-Length': '4'
        }
      });
    }
  });
  assert.equal(calls[0].url, driveDownloadUrlForExchange(EXCHANGE_URL, 'file-1234567890'));
  assert.equal(calls[0].options.headers.Authorization, `YayraDrive ${sessionId}`);
  assert.equal(downloaded.filename, 'Research Methodology.pptx');
  assert.deepEqual([...new Uint8Array(await downloaded.blob.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(persistentStorage.getItem(DRIVE_SESSION_KEY).includes('ya29'), false);

  let revokeCall;
  const revoked = await revokeDelegatedDriveSession({
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: persistentStorage,
    fetchImpl: async (url, options) => {
      revokeCall = { url, options };
      return new Response(JSON.stringify({ ok: true, providerRevoked: true }), { status: 200 });
    }
  });
  assert.deepEqual(revoked, { ok: true, revoked: true });
  assert.equal(revokeCall.url, driveRevokeUrlForExchange(EXCHANGE_URL));
  assert.equal(revokeCall.options.headers.Authorization, `YayraDrive ${sessionId}`);
  assert.equal(persistentStorage.getItem(DRIVE_SESSION_KEY), null, 'logout removes the local capability before its network request');
});

test('Gmail callback persists only an opaque capability and mailbox requests never expose Google tokens', async () => {
  const pending = pendingSession({ capability: 'gmail-readonly', returnTo: '/?gmail=1' });
  const sessionId = 'G'.repeat(43);
  let exchangeBody;
  const completed = await completeSignIn({
    search: `?code=gmail-code&state=${VALID_WEB_STATE}`,
    origin: ORIGIN,
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: pending,
    fetchImpl: async (_url, options) => {
      exchangeBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        profile: { sub: 'gmail-user', name: 'Ama', email: 'ama@example.com' },
        gmailSession: { id: sessionId, expiresAt: '2099-01-01T00:00:00.000Z', scope: 'gmail.readonly' }
      }), { status: 200 });
    }
  });
  assert.equal(exchangeBody.capability, 'gmail-readonly');
  assert.equal(completed.gmailSession.id, sessionId);
  assert.equal(completed.returnTo, '/?gmail=1');
  assert.equal(JSON.stringify(completed).includes('access_token'), false);

  const storage = fakeStorage();
  saveGmailSession(storage, completed.gmailSession, 'profile-work');
  assert.equal(loadGmailSession(storage, () => Date.now(), 'profile-work').id, sessionId);
  assert.equal(storage.getItem(authStorageKey(GMAIL_SESSION_KEY, 'profile-work')).includes('ya29'), false);

  const calls = [];
  const listed = await listDelegatedGmailMessages({
    options: { query: 'in:inbox', maxResults: 25 },
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: storage,
    profileId: 'profile-work',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        messages: [{
          id: 'msg_1', threadId: 'thread_1', labelIds: ['INBOX'], snippet: 'Hello', internalDate: '1700000000000',
          headers: { subject: 'Welcome', from: 'sender@example.com', to: 'ama@example.com', date: 'Tue' }
        }],
        nextPageToken: 'NEXT_1', resultSizeEstimate: 1
      }), { status: 200 });
    }
  });
  assert.equal(listed.messages[0].headers.subject, 'Welcome');
  assert.equal(listed.nextPageToken, 'NEXT_1');
  assert.equal(calls[0].options.headers.Authorization, `YayraGmail ${sessionId}`);
  assert.match(calls[0].url, /\/api\/gmail\/messages/);

  const opened = await getDelegatedGmailMessage({
    messageId: 'msg_1',
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: storage,
    profileId: 'profile-work',
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `YayraGmail ${sessionId}`);
      return new Response(JSON.stringify({ message: {
        id: 'msg_1', threadId: 'thread_1', labelIds: ['INBOX'], snippet: 'Hello', internalDate: '1700000000000',
        headers: { subject: 'Welcome', from: 'sender@example.com', to: 'ama@example.com', date: 'Tue' },
        bodyText: '<script>is rendered as text</script>', bodyTruncated: false
      } }), { status: 200 });
    }
  });
  assert.equal(opened.bodyText, '<script>is rendered as text</script>');
});

test('Drive logout removes the local capability even when Worker revocation is offline', async () => {
  const storage = fakeStorage();
  saveDriveSession(storage, {
    id: 'R'.repeat(43),
    expiresAt: '2099-01-01T00:00:00.000Z',
    scope: 'drive.readonly'
  });
  const result = await revokeDelegatedDriveSession({
    exchangeUrl: EXCHANGE_URL,
    sessionStorage: storage,
    fetchImpl: async () => { throw new Error('offline'); },
    timeoutMs: 20
  });
  assert.deepEqual(result, { ok: false, revoked: false });
  assert.equal(storage.getItem(DRIVE_SESSION_KEY), null);
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

test('web profile and delegated Drive persistence are isolated per browsing profile', () => {
  const local = fakeStorage();
  const personalDrive = { id: 'P'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z', scope: 'drive.readonly' };
  const workDrive = { id: 'W'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z', scope: 'drive.readonly' };
  saveProfile(local, { sub: 'personal', email: 'personal@example.com' }, 'default');
  saveProfile(local, { sub: 'work', email: 'work@example.com' }, 'profile-work');
  saveDriveSession(local, personalDrive, 'default');
  saveDriveSession(local, workDrive, 'profile-work');

  assert.equal(loadProfile(local, 'default').profile.email, 'personal@example.com');
  assert.equal(loadProfile(local, 'profile-work').profile.email, 'work@example.com');
  assert.equal(loadDriveSession(local, () => Date.now(), 'default').id, personalDrive.id);
  assert.equal(loadDriveSession(local, () => Date.now(), 'profile-work').id, workDrive.id);
  assert.equal(local.getItem(PROFILE_KEY) !== null, true, 'legacy/default key remains compatible');
  assert.equal(local.getItem(authStorageKey(PROFILE_KEY, 'profile-work')) !== null, true);

  clearProfile(local, 'profile-work');
  assert.equal(loadProfile(local, 'profile-work'), null);
  assert.equal(loadProfile(local, 'default').profile.email, 'personal@example.com');
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

test('web auth bridge carries the selected profile through redirect state and scopes sign-out', async () => {
  const { bridge, local, session } = makeBridge();
  saveProfile(local, { sub: 'personal', email: 'personal@example.com' }, 'default');
  saveProfile(local, { sub: 'work', email: 'work@example.com' }, 'profile-work');
  const events = [];
  bridge.onEvent((event) => events.push(event));

  assert.deepEqual(await bridge.signIn('profile-work'), { ok: true, pending: true });
  assert.equal(JSON.parse(session.getItem(PENDING_KEY)).profileId, 'profile-work');
  assert.equal(events[0].profileId, 'profile-work');

  await bridge.signOut('profile-work');
  assert.equal((await bridge.getSession('default')).profile.email, 'personal@example.com');
  assert.deepEqual(await bridge.getSession('profile-work'), { signedIn: false });
  assert.equal(events.at(-1).type, 'signed-out');
  assert.equal(events.at(-1).profileId, 'profile-work');
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
