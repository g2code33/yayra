import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOBILE_REDIRECT_URI,
  isExpectedMobileCallbackUrl,
  createCapacitorAuthBridge,
  signInWithGoogleCapacitor
} from '../src/services/googleAuthCapacitor.js';
import { DRIVE_SESSION_KEY, GMAIL_SESSION_KEY, PROFILE_KEY } from '../src/services/googleAuthWeb.js';
import { resolveCapacitorGoogleAuthConfig } from '../src/config/googleAuthCapacitor.js';

const CLIENT_ID = 'android-client-id.apps.googleusercontent.com';
const EXCHANGE_URL = 'https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map.entries())
  };
}

/**
 * A fake of the Capacitor plugin surface: captures Browser.open calls and
 * lets a test deliver the appUrlOpen deep link (i.e. play the role of the
 * OS routing com.yayra.app:/oauth2redirect back into the app).
 */
function fakeCapacitor() {
  const opened = [];
  const closed = [];
  let urlHandler = null;
  let finishedHandler = null;
  return {
    opened,
    closed,
    deliverUrl: (url) => urlHandler?.({ url }),
    finishBrowser: () => finishedHandler?.(),
    openBrowser: async ({ url }) => { opened.push(url); },
    closeBrowser: async () => { closed.push(true); },
    onUrlOpen: (handler) => { urlHandler = handler; return () => { urlHandler = null; }; },
    onBrowserFinished: (handler) => { finishedHandler = handler; return () => { finishedHandler = null; }; }
  };
}

/**
 * generatePkcePair awaits crypto.subtle.digest (threadpool), so "one
 * setTimeout(0)" is NOT guaranteed to run after Browser.open fires. Poll
 * instead of racing.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('mobile callback URL validation requires the exact app scheme and callback path', () => {
  assert.equal(isExpectedMobileCallbackUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=s`), true);
  for (const candidate of [
    'com.yayra.app:/oauth2redirect-evil?code=c&state=s',
    'com.yayra.app:/oauth2redirect/extra?code=c&state=s',
    'com.yayra.app://oauth2redirect?code=c&state=s',
    'com.yayra.app.evil:/oauth2redirect?code=c&state=s',
    `${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=s#fragment`,
    'https://attacker.example/oauth2redirect?code=c&state=s'
  ]) {
    assert.equal(isExpectedMobileCallbackUrl(candidate), false, candidate);
  }
});

function profileResponse() {
  return new Response(JSON.stringify({
    profile: { sub: '7', name: 'Ama Mensah', email: 'ama@example.com', picture: 'https://lh3.googleusercontent.com/a/p' }
  }), { status: 200 });
}

// --- happy path ------------------------------------------------------------

test('capacitor sign-in opens the SYSTEM browser with a PKCE auth URL and finishes via the deep-link callback + worker exchange', async () => {
  const cap = fakeCapacitor();
  const exchanges = [];
  const fetchImpl = async (url, options) => {
    exchanges.push({ url, options });
    return profileResponse();
  };

  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID,
    platform: 'android',
    exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser,
    closeBrowser: cap.closeBrowser,
    onUrlOpen: cap.onUrlOpen,
    onBrowserFinished: cap.onBrowserFinished,
    fetchImpl
  });

  await waitFor(() => cap.opened.length === 1);
  const authUrl = new URL(cap.opened[0]);
  assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authUrl.searchParams.get('redirect_uri'), DEFAULT_MOBILE_REDIRECT_URI);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  // Mobile Google clients have no secret, and no offline access is wanted.
  assert.equal(authUrl.searchParams.get('client_secret'), null);
  assert.equal(authUrl.searchParams.get('access_type'), null);

  const state = authUrl.searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=one-shot&state=${state}`);

  const { profile } = await pending;
  assert.equal(profile.email, 'ama@example.com');
  assert.equal(cap.closed.length, 1, 'the in-app browser sheet is closed after the callback');

  assert.equal(exchanges.length, 1);
  const body = JSON.parse(exchanges[0].options.body);
  assert.equal(body.code, 'one-shot');
  assert.equal(body.platform, 'android');
  assert.equal(body.redirectUri, DEFAULT_MOBILE_REDIRECT_URI);
  assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  // No token-shaped field may appear anywhere in the request or result.
  assert.equal(exchanges[0].options.body.includes('client_secret'), false);
});

test('capacitor sign-in ignores unrelated deep links and still completes on the real callback', async () => {
  const cap = fakeCapacitor();
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'ios', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => profileResponse()
  });
  await waitFor(() => cap.opened.length === 1);
  const state = new URL(cap.opened[0]).searchParams.get('state');

  cap.deliverUrl('com.yayra.app:/share?url=https://example.com'); // unrelated deep link
  cap.deliverUrl(`com.yayra.app:/oauth2redirect.evil?code=forged&state=${state}`); // prefix lookalike
  cap.deliverUrl(`com.yayra.app://oauth2redirect?code=forged&state=${state}`); // authority/path lookalike
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c1&state=${state}`);
  const { profile } = await pending;
  assert.equal(profile.email, 'ama@example.com');
});

// --- failure paths -----------------------------------------------------------

test('capacitor sign-in refuses an unregistered redirect URI before opening a browser', async () => {
  const cap = fakeCapacitor();
  await assert.rejects(
    () => signInWithGoogleCapacitor({
      clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
      redirectUri: 'com.yayra.app:/oauth2redirect.evil',
      openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen
    }),
    /invalid_redirect_uri/
  );
  assert.equal(cap.opened.length, 0);
});

test('capacitor sign-in ignores a URI-prefix lookalike instead of exchanging it', async () => {
  const cap = fakeCapacitor();
  let exchanges = 0;
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => { exchanges += 1; return profileResponse(); },
    timeoutMs: 15
  });
  await waitFor(() => cap.opened.length === 1);
  const state = new URL(cap.opened[0]).searchParams.get('state');
  cap.deliverUrl(`com.yayra.app:/oauth2redirect.evil?code=forged&state=${state}`);
  await assert.rejects(() => pending, /sign_in_timeout/);
  assert.equal(exchanges, 0, 'an untrusted callback never reaches the worker');
});

test('capacitor sign-in rejects a state mismatch without calling the worker', async () => {
  const cap = fakeCapacitor();
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await waitFor(() => cap.opened.length === 1);
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=FORGED`);
  await assert.rejects(() => pending, /state_mismatch/);
});

test('capacitor sign-in rejects any callback that carries bearer tokens in the custom-scheme URL', async () => {
  const cap = fakeCapacitor();
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await waitFor(() => cap.opened.length === 1);
  const state = new URL(cap.opened[0]).searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?access_token=secret-bearer&state=${state}`);
  await assert.rejects(() => pending, /token_in_callback_rejected/);
});

test('capacitor sign-in validates state on OAuth error callbacks before surfacing the provider error', async () => {
  const cap = fakeCapacitor();
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await waitFor(() => cap.opened.length === 1);
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?error=access_denied&state=FORGED`);
  await assert.rejects(() => pending, /state_mismatch/);
});

test('capacitor sign-in surfaces consent-screen cancellation (error param) and user dismissal (browserFinished)', async () => {
  const cancelled = fakeCapacitor();
  const viaErrorParam = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cancelled.openBrowser, onUrlOpen: cancelled.onUrlOpen,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await waitFor(() => cancelled.opened.length === 1);
  const cancelState = new URL(cancelled.opened[0]).searchParams.get('state');
  cancelled.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?error=access_denied&state=${cancelState}`);
  await assert.rejects(() => viaErrorParam, /access_denied/);

  const dismissed = fakeCapacitor();
  const viaDismissal = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: dismissed.openBrowser, onUrlOpen: dismissed.onUrlOpen,
    onBrowserFinished: dismissed.onBrowserFinished,
    fetchImpl: async () => { throw new Error('must not fetch'); },
    // Shrink ONLY the 1000ms dismissal grace period; the (cleared-on-finish)
    // main sign-in timeout keeps its real delay so the two can't race.
    setTimeoutImpl: (fn, ms) => setTimeout(fn, ms === 1000 ? 5 : ms),
    clearTimeoutImpl: clearTimeout
  });
  await waitFor(() => dismissed.opened.length === 1);
  dismissed.finishBrowser();
  await assert.rejects(() => viaDismissal, /sign_in_cancelled/);
});

test('capacitor sign-in times out instead of hanging forever when the callback never arrives', async () => {
  const cap = fakeCapacitor();
  await assert.rejects(
    () => signInWithGoogleCapacitor({
      clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
      openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
      fetchImpl: async () => { throw new Error('must not fetch'); },
      timeoutMs: 10
    }),
    /sign_in_timeout/
  );
});

test('capacitor sign-in fails fast when unconfigured and reports worker exchange failures', async () => {
  await assert.rejects(
    () => signInWithGoogleCapacitor({ clientId: '', platform: 'android', exchangeUrl: EXCHANGE_URL, openBrowser: async () => {}, onUrlOpen: () => () => {} }),
    /not_configured/
  );

  const cap = fakeCapacitor();
  const pending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 502 })
  });
  await waitFor(() => cap.opened.length === 1);
  const state = new URL(cap.opened[0]).searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=${state}`);
  await assert.rejects(() => pending, /exchange_failed:502:invalid_grant/);

  const hostile = fakeCapacitor();
  const hostilePending = signInWithGoogleCapacitor({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    openBrowser: hostile.openBrowser, onUrlOpen: hostile.onUrlOpen,
    fetchImpl: async () => new Response('<html>refresh_token=do-not-echo</html>', { status: 502 })
  });
  await waitFor(() => hostile.opened.length === 1);
  const hostileState = new URL(hostile.opened[0]).searchParams.get('state');
  hostile.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=${hostileState}`);
  await assert.rejects(
    () => hostilePending,
    (error) => error.message === 'exchange_failed:502:upstream_error' && !error.message.includes('do-not-echo')
  );
});

// --- the authBridge-shaped adapter ------------------------------------------

test('capacitor auth bridge satisfies the BrowserShell contract and persists profile only', async () => {
  const cap = fakeCapacitor();
  const local = fakeStorage();
  const bridge = createCapacitorAuthBridge({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    localStorage: local,
    openBrowser: cap.openBrowser, closeBrowser: cap.closeBrowser,
    onUrlOpen: cap.onUrlOpen, onBrowserFinished: cap.onBrowserFinished,
    fetchImpl: async () => profileResponse()
  });
  const events = [];
  bridge.onEvent((evt) => events.push(evt.type));

  assert.deepEqual(await bridge.getSession(), { signedIn: false });

  const pending = bridge.signIn();
  await waitFor(() => cap.opened.length === 1);
  // Re-entrancy guard, same as the Electron bridge.
  assert.deepEqual(await bridge.signIn(), { ok: false, error: 'sign_in_already_in_progress' });
  const state = new URL(cap.opened[0]).searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=c&state=${state}`);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.profile.email, 'ama@example.com');
  assert.deepEqual(events, ['signing-in', 'signed-in']);

  const session = await bridge.getSession();
  assert.equal(session.signedIn, true);
  assert.ok(session.savedAt);
  // Profile-only persistence: nothing token-shaped may ever hit storage.
  const serialized = JSON.stringify(local.dump());
  for (const needle of ['access_token', 'refresh_token', 'id_token', 'code_verifier']) {
    assert.equal(serialized.includes(needle), false, `localStorage must never contain ${needle}`);
  }
  assert.ok(local.getItem(PROFILE_KEY));

  assert.deepEqual(await bridge.signOut(), { ok: true });
  assert.deepEqual(await bridge.getSession(), { signedIn: false });
  assert.deepEqual(events, ['signing-in', 'signed-in', 'signed-out']);
});

test('capacitor Drive consent persists only an opaque capability, downloads internally, and revokes on logout', async () => {
  const cap = fakeCapacitor();
  const local = fakeStorage();
  const sessionId = 'M'.repeat(43);
  const calls = [];
  const bridge = createCapacitorAuthBridge({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    localStorage: local,
    openBrowser: cap.openBrowser, closeBrowser: cap.closeBrowser,
    onUrlOpen: cap.onUrlOpen, onBrowserFinished: cap.onBrowserFinished,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === EXCHANGE_URL) {
        const body = JSON.parse(options.body);
        assert.equal(body.capability, 'drive-readonly');
        return new Response(JSON.stringify({
          profile: { sub: '7', name: 'Ama Mensah', email: 'ama@example.com' },
          driveSession: { id: sessionId, expiresAt: '2099-01-01T00:00:00.000Z', scope: 'drive.readonly' }
        }), { status: 200 });
      }
      if (String(url).includes('/api/drive/download')) {
        assert.equal(options.headers.Authorization, `YayraDrive ${sessionId}`);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''Paper.pdf", 'Content-Length': '3' }
        });
      }
      if (String(url).includes('/api/drive/session/revoke')) {
        assert.equal(options.headers.Authorization, `YayraDrive ${sessionId}`);
        return new Response(JSON.stringify({ ok: true, providerRevoked: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }
  });

  const events = [];
  bridge.onEvent((event) => events.push(event.type));
  const connecting = bridge.connectDrive();
  await waitFor(() => cap.opened.length === 1);
  const authorization = new URL(cap.opened[0]);
  assert.equal(authorization.searchParams.get('scope'), 'openid email profile https://www.googleapis.com/auth/drive.readonly');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  const state = authorization.searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=drive-code&state=${state}`);
  const connected = await connecting;
  assert.equal(connected.ok, true);
  assert.deepEqual(events, ['drive-connecting', 'signed-in', 'drive-connected'],
    'the verified deep link immediately updates Yayra account state as well as Drive state');
  assert.equal(JSON.parse(local.getItem(DRIVE_SESSION_KEY)).id, sessionId);
  assert.equal(JSON.stringify(local.dump()).includes('access_token'), false);
  assert.equal(JSON.stringify(local.dump()).includes('refresh_token'), false);

  const download = await bridge.downloadDriveFile('file-1234567890');
  assert.equal(download.ok, true);
  assert.equal(download.filename, 'Paper.pdf');
  assert.deepEqual([...new Uint8Array(await download.blob.arrayBuffer())], [1, 2, 3]);

  assert.deepEqual(await bridge.signOut(), { ok: true });
  assert.deepEqual(events, ['drive-connecting', 'signed-in', 'drive-connected', 'signed-out']);
  assert.equal(local.getItem(DRIVE_SESSION_KEY), null);
  assert.equal(calls.some(({ url }) => String(url).includes('/api/drive/session/revoke')), true);
});

test('capacitor Gmail consent returns to the initiating app and reads mail through the opaque Worker capability', async () => {
  const cap = fakeCapacitor();
  const local = fakeStorage();
  const sessionId = 'N'.repeat(43);
  const events = [];
  const bridge = createCapacitorAuthBridge({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    localStorage: local,
    openBrowser: cap.openBrowser, closeBrowser: cap.closeBrowser,
    onUrlOpen: cap.onUrlOpen, onBrowserFinished: cap.onBrowserFinished,
    fetchImpl: async (url, options) => {
      if (url === EXCHANGE_URL) {
        assert.equal(JSON.parse(options.body).capability, 'gmail-readonly');
        return new Response(JSON.stringify({
          profile: { sub: 'mobile-gmail', name: 'Ama', email: 'mobile@example.com' },
          gmailSession: { id: sessionId, expiresAt: '2099-01-01T00:00:00.000Z', scope: 'gmail.readonly' }
        }), { status: 200 });
      }
      if (String(url).includes('/api/gmail/messages')) {
        assert.equal(options.headers.Authorization, `YayraGmail ${sessionId}`);
        return new Response(JSON.stringify({
          messages: [{
            id: 'mobile_msg', threadId: 'mobile_thread', labelIds: ['INBOX'], snippet: 'Hi', internalDate: '1700000000000',
            headers: { subject: 'Mobile mail', from: 'sender@example.com', to: 'mobile@example.com', date: 'Tue' }
          }]
        }), { status: 200 });
      }
      if (String(url).includes('/api/gmail/session/revoke')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }
  });
  bridge.onEvent((event) => events.push(event.type));
  const connecting = bridge.connectGmail('profile-mobile');
  await waitFor(() => cap.opened.length === 1);
  const authorization = new URL(cap.opened[0]);
  assert.equal(authorization.searchParams.get('scope'), 'openid email profile https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?code=gmail-code&state=${authorization.searchParams.get('state')}`);
  const connected = await connecting;
  assert.equal(connected.profile.email, 'mobile@example.com');
  assert.deepEqual(events, ['gmail-connecting', 'signed-in', 'gmail-connected']);
  assert.ok(local.getItem(`${GMAIL_SESSION_KEY}:profile:profile-mobile`));
  assert.equal(JSON.stringify(local.dump()).includes('access_token'), false);

  const listed = await bridge.listGmailMessages({ query: 'in:inbox' }, 'profile-mobile');
  assert.equal(listed.ok, true);
  assert.equal(listed.messages[0].headers.subject, 'Mobile mail');
});

test('capacitor auth bridge reports sign-in errors through the event channel without throwing', async () => {
  const cap = fakeCapacitor();
  const bridge = createCapacitorAuthBridge({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    localStorage: fakeStorage(),
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  const events = [];
  bridge.onEvent((evt) => events.push(evt));
  const pending = bridge.signIn();
  await waitFor(() => cap.opened.length === 1);
  const cancelState = new URL(cap.opened[0]).searchParams.get('state');
  cap.deliverUrl(`${DEFAULT_MOBILE_REDIRECT_URI}?error=access_denied&state=${cancelState}`);
  const result = await pending;
  assert.deepEqual(result, { ok: false, error: 'access_denied' });
  assert.deepEqual(events.map((e) => e.type), ['signing-in', 'error']);
});

test('capacitor auth bridge opens only trusted account and sanitized product destinations', async () => {
  const cap = fakeCapacitor();
  const bridge = createCapacitorAuthBridge({
    clientId: CLIENT_ID, platform: 'android', exchangeUrl: EXCHANGE_URL,
    localStorage: fakeStorage(),
    openBrowser: cap.openBrowser, onUrlOpen: cap.onUrlOpen
  });
  assert.deepEqual(await bridge.openAccountPage(), { ok: true });
  assert.deepEqual(await bridge.openGoogleProduct('https://mail.google.com/mail/u/0/?private=x'), { ok: true });
  assert.deepEqual(await bridge.openGoogleProduct('https://mail.google.com.evil.example/'), { ok: false, error: 'invalid_google_product_origin' });
  assert.deepEqual(cap.opened, ['https://myaccount.google.com/', 'https://mail.google.com/']);
});

// --- config resolution --------------------------------------------------------

function fakeDocWithMetas(metas) {
  return {
    querySelector: (selector) => {
      const match = /meta\[name="([^"]+)"\]/.exec(selector);
      const value = match && metas[match[1]];
      return value ? { getAttribute: (attr) => (attr === 'content' ? value : null) } : null;
    }
  };
}

test('capacitor auth config picks the client id matching the native platform and ignores placeholders', () => {
  const metas = {
    'yayra-google-android-client-id': 'android-id.apps.googleusercontent.com',
    'yayra-google-ios-client-id': 'ios-id.apps.googleusercontent.com',
    'yayra-google-auth-exchange-url': EXCHANGE_URL
  };
  assert.deepEqual(
    resolveCapacitorGoogleAuthConfig({ doc: fakeDocWithMetas(metas), getPlatform: () => 'android' }),
    { platform: 'android', clientId: 'android-id.apps.googleusercontent.com', exchangeUrl: EXCHANGE_URL }
  );
  assert.deepEqual(
    resolveCapacitorGoogleAuthConfig({ doc: fakeDocWithMetas(metas), getPlatform: () => 'ios' }),
    { platform: 'ios', clientId: 'ios-id.apps.googleusercontent.com', exchangeUrl: EXCHANGE_URL }
  );
  // Web platform or missing/placeholder config -> feature off, honestly.
  assert.deepEqual(
    resolveCapacitorGoogleAuthConfig({ doc: fakeDocWithMetas(metas), getPlatform: () => 'web' }),
    { platform: null, clientId: null, exchangeUrl: null }
  );
  assert.deepEqual(
    resolveCapacitorGoogleAuthConfig({ doc: fakeDocWithMetas({ 'yayra-google-android-client-id': '__GOOGLE_ANDROID_CLIENT_ID__' }), getPlatform: () => 'android' }),
    { platform: 'android', clientId: null, exchangeUrl: null }
  );
});
