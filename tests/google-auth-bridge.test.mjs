import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthBridge, AUTH_EVENT_CHANNEL, normalizeGoogleProductOrigin } from '../electron/authBridge.cjs';

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)(...args)
  };
}

function fakeWindow() {
  const sent = [];
  return {
    shown: 0,
    focused: 0,
    isDestroyed: () => false,
    show() { this.shown += 1; },
    focus() { this.focused += 1; },
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    sent
  };
}

function fakeAuthStore() {
  let session = null;
  return {
    save: ({ profile, tokens }) => { session = { profile, tokens }; },
    load: () => (session ? { profile: session.profile, tokens: session.tokens, savedAt: '2026-01-01T00:00:00.000Z' } : null),
    clear: () => { session = null; }
  };
}

test('authBridge: sign-in success persists the session and emits signed-in with only the profile (no tokens over IPC)', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const shell = { openExternal: async () => {} };
  const signInImpl = async () => ({ profile: { sub: '1', email: 'a@b.com' }, tokens: { access_token: 'secret-at', refresh_token: 'secret-rt' } });

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'client-123', clientSecret: 'secret-123', signInImpl });

  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(result, { ok: true, profile: { sub: '1', email: 'a@b.com' } });
  assert.equal(win.shown, 1, 'Yayra is restored after the verified callback');
  assert.equal(win.focused, 1, 'the connected account is brought back in front of the system browser');

  const events = win.sent.filter((e) => e.channel === AUTH_EVENT_CHANNEL).map((e) => e.payload.type);
  assert.deepEqual(events, ['signing-in', 'signed-in']);

  // Never leak tokens to the renderer under any event.
  const anyTokenLeak = win.sent.some((e) => JSON.stringify(e.payload).includes('secret-'));
  assert.equal(anyTokenLeak, false);

  const session = await ipcMain.invoke('yayra:auth-get-session');
  assert.deepEqual(session, { signedIn: true, profile: { sub: '1', email: 'a@b.com' }, savedAt: '2026-01-01T00:00:00.000Z' });
});

test('authBridge: sign-in returns to the detached/profile window that initiated it', async () => {
  const ipcMain = fakeIpcMain();
  const mainWindow = fakeWindow();
  const requestWindow = fakeWindow();
  const sender = { id: 77 };
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => mainWindow,
    getWindowForWebContents: (webContents) => webContents === sender ? requestWindow : null,
    authStore: fakeAuthStore(),
    clientId: 'client-123',
    clientSecret: 'secret-123',
    signInImpl: async () => ({ profile: { sub: 'detached' }, tokens: { access_token: 'private' } })
  });

  const result = await ipcMain.invoke('yayra:auth-sign-in', { sender });
  assert.equal(result.ok, true);
  assert.deepEqual(mainWindow.sent, [],
    'a profile-window sign-in must never replace the unrelated main-window account');
  assert.deepEqual(requestWindow.sent.map((entry) => entry.payload.type), ['signing-in', 'signed-in']);
  assert.ok(requestWindow.sent.every((entry) => entry.payload.profileId === 'default'), 'events identify their profile');
  assert.equal(requestWindow.shown, 1);
  assert.equal(requestWindow.focused, 1);
});

test('authBridge: two open profile windows retain independent accounts and sign-out cannot cross the sender binding', async () => {
  const ipcMain = fakeIpcMain();
  const personalWindow = fakeWindow();
  const workWindow = fakeWindow();
  const personalSender = { id: 101 };
  const workSender = { id: 202 };
  const senderWindows = new Map([
    [personalSender, personalWindow],
    [workSender, workWindow]
  ]);
  const senderProfiles = new Map([
    [personalSender, 'default'],
    [workSender, 'profile-work']
  ]);
  const stores = new Map([
    ['default', fakeAuthStore()],
    ['profile-work', fakeAuthStore()]
  ]);
  const windowsByProfile = new Map([
    ['default', [personalWindow]],
    ['profile-work', [workWindow]]
  ]);
  const responses = [
    { profile: { sub: 'personal', email: 'personal@example.com' }, tokens: { access_token: 'personal-private' } },
    { profile: { sub: 'work', email: 'work@example.com' }, tokens: { access_token: 'work-private' } }
  ];

  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => personalWindow,
    getWindowForWebContents: (sender) => senderWindows.get(sender) || null,
    // This models electron/main.cjs: the native BrowserWindow binding wins
    // over any profileId forged in the renderer payload.
    getProfileIdForWebContents: (sender) => senderProfiles.get(sender),
    getWindowsForProfile: (profileId) => windowsByProfile.get(profileId) || [],
    authStore: stores.get('default'),
    getAuthStore: (profileId) => stores.get(profileId),
    clientId: 'client-123',
    clientSecret: 'secret-123',
    signInImpl: async () => responses.shift()
  });

  await ipcMain.invoke('yayra:auth-sign-in', { sender: personalSender }, { profileId: 'default' });
  await ipcMain.invoke('yayra:auth-sign-in', { sender: workSender }, { profileId: 'profile-work' });

  assert.equal((await ipcMain.invoke('yayra:auth-get-session', { sender: personalSender }, { profileId: 'default' })).profile.email, 'personal@example.com');
  assert.equal((await ipcMain.invoke('yayra:auth-get-session', { sender: workSender }, { profileId: 'profile-work' })).profile.email, 'work@example.com');
  assert.deepEqual(personalWindow.sent.map((entry) => entry.payload.profileId), ['default', 'default']);
  assert.deepEqual(workWindow.sent.map((entry) => entry.payload.profileId), ['profile-work', 'profile-work']);

  // Work lies and asks to sign out `default`; the trusted sender binding
  // still scopes the operation to profile-work.
  await ipcMain.invoke('yayra:auth-sign-out', { sender: workSender }, { profileId: 'default' });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session', { sender: workSender }, { profileId: 'profile-work' }), { signedIn: false });
  assert.equal((await ipcMain.invoke('yayra:auth-get-session', { sender: personalSender }, { profileId: 'default' })).profile.email, 'personal@example.com');
  assert.equal(personalWindow.sent.some((entry) => entry.payload.type === 'signed-out'), false,
    'personal window is never cleared by work sign-out');
  assert.equal(workWindow.sent.at(-1).payload.type, 'signed-out');
  assert.equal(workWindow.sent.at(-1).payload.profileId, 'profile-work');

  const leaked = [...personalWindow.sent, ...workWindow.sent]
    .some((entry) => JSON.stringify(entry.payload).includes('-private'));
  assert.equal(leaked, false, 'no profile token crosses IPC');
});

test('authBridge: Drive consent and API download stay inside the initiating profile', async () => {
  const ipcMain = fakeIpcMain();
  const personalWindow = fakeWindow();
  const workWindow = fakeWindow();
  const personalSender = { id: 301 };
  const workSender = { id: 302 };
  const personalStore = fakeAuthStore();
  const workStore = fakeAuthStore();
  personalStore.save({
    profile: { sub: 'personal', email: 'personal@example.com' },
    tokens: { access_token: 'personal-access' }
  });
  const seenAuthorizations = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('?fields=')) {
      seenAuthorizations.push(options.headers.Authorization);
      return new Response(JSON.stringify({
        id: 'file-1234567890', name: 'Work plan.pdf', mimeType: 'application/pdf', size: '3', capabilities: { canDownload: true }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('alt=media')) {
      seenAuthorizations.push(options.headers.Authorization);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '3' }
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => personalWindow,
    getWindowForWebContents: (sender) => sender === workSender ? workWindow : personalWindow,
    getProfileIdForWebContents: (sender) => sender === workSender ? 'profile-work' : 'default',
    getWindowsForProfile: (profileId) => profileId === 'profile-work' ? [workWindow] : [personalWindow],
    authStore: personalStore,
    getAuthStore: (profileId) => profileId === 'profile-work' ? workStore : personalStore,
    clientId: 'c',
    clientSecret: 's',
    fetchImpl,
    signInImpl: async () => ({
      profile: { sub: 'work', email: 'work@example.com' },
      tokens: {
        access_token: 'work-access',
        refresh_token: 'work-refresh',
        scope: 'openid email profile https://www.googleapis.com/auth/drive.readonly',
        expires_in: 3600
      }
    })
  });

  // Even with a forged default claim, the sender is pinned to Work.
  const connected = await ipcMain.invoke('yayra:auth-connect-drive', { sender: workSender }, { profileId: 'default' });
  assert.equal(connected.ok, true);
  assert.equal(workStore.load().profile.email, 'work@example.com');
  assert.equal(personalStore.load().profile.email, 'personal@example.com');
  assert.equal(personalWindow.sent.length, 0);
  assert.deepEqual(workWindow.sent.map((entry) => entry.payload.type), [
    'drive-connecting', 'signed-in', 'drive-connected'
  ]);

  const downloaded = await ipcMain.invoke('yayra:auth-download-drive-file', { sender: workSender }, {
    profileId: 'default', fileId: 'file-1234567890'
  });
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.filename, 'Work plan.pdf');
  assert.deepEqual([...downloaded.data], [1, 2, 3]);
  assert.deepEqual(seenAuthorizations, ['Bearer work-access', 'Bearer work-access']);
});

test('authBridge: Gmail consent, inbox metadata, and plain-text message bodies stay profile-scoped and token-free over IPC', async () => {
  const ipcMain = fakeIpcMain();
  const personalStore = fakeAuthStore();
  const workStore = fakeAuthStore();
  const workWindow = fakeWindow();
  const workSender = { id: 880 };
  let requestedScopes = null;
  const requests = [];
  const encodedBody = Buffer.from('Hello from Gmail\n<script>alert(1)</script>', 'utf8')
    .toString('base64url');
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), authorization: options.headers?.Authorization });
    if (String(url).includes('/messages?maxResults=')) {
      return new Response(JSON.stringify({ messages: [{ id: 'msg_123' }], resultSizeEstimate: 1 }), { status: 200 });
    }
    if (String(url).includes('msg_123?format=metadata')) {
      return new Response(JSON.stringify({
        id: 'msg_123', threadId: 'thread_123', labelIds: ['INBOX', 'UNREAD'], snippet: 'Preview', internalDate: '1700000000000',
        payload: { headers: [{ name: 'Subject', value: '<img onerror=alert(1)>' }, { name: 'From', value: 'Sender <s@example.com>' }] }
      }), { status: 200 });
    }
    if (String(url).includes('msg_123?format=full')) {
      return new Response(JSON.stringify({
        id: 'msg_123', threadId: 'thread_123', labelIds: ['INBOX'], snippet: 'Preview', internalDate: '1700000000000',
        payload: {
          mimeType: 'text/plain', body: { data: encodedBody },
          headers: [{ name: 'Subject', value: 'Safe subject' }, { name: 'From', value: 'Sender <s@example.com>' }]
        }
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => fakeWindow(),
    getWindowForWebContents: () => workWindow,
    getProfileIdForWebContents: () => 'profile-work',
    getWindowsForProfile: () => [workWindow],
    authStore: personalStore,
    getAuthStore: (profileId) => profileId === 'profile-work' ? workStore : personalStore,
    clientId: 'client',
    clientSecret: 'secret',
    fetchImpl,
    signInImpl: async ({ scopes }) => {
      requestedScopes = scopes;
      return {
        profile: { sub: 'work-google', email: 'work@example.com' },
        tokens: {
          access_token: 'gmail-private-access', refresh_token: 'gmail-private-refresh', expires_in: 3600,
          scope: scopes.join(' ')
        }
      };
    }
  });

  const connected = await ipcMain.invoke('yayra:auth-connect-gmail', { sender: workSender }, { profileId: 'default' });
  assert.equal(connected.ok, true);
  assert.ok(requestedScopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
  assert.equal(personalStore.load(), null, 'a forged renderer profile id cannot receive the Gmail credential');
  assert.equal(workStore.load().profile.email, 'work@example.com');

  const listed = await ipcMain.invoke('yayra:auth-list-gmail-messages', { sender: workSender }, {
    profileId: 'default', query: 'in:inbox', maxResults: 25
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.messages[0].headers.subject, '<img onerror=alert(1)>');
  assert.equal(Object.prototype.hasOwnProperty.call(listed, 'access_token'), false);

  const opened = await ipcMain.invoke('yayra:auth-get-gmail-message', { sender: workSender }, {
    profileId: 'default', messageId: 'msg_123'
  });
  assert.equal(opened.ok, true);
  assert.match(opened.message.bodyText, /Hello from Gmail/);
  assert.ok(requests.every((entry) => entry.authorization === 'Bearer gmail-private-access'));
  assert.equal(workWindow.sent.some((entry) => JSON.stringify(entry).includes('gmail-private')), false,
    'Google Gmail tokens never cross IPC events');
  assert.deepEqual(workWindow.sent.map((entry) => entry.payload.type), [
    'gmail-connecting', 'signed-in', 'gmail-connected'
  ]);
});

test('authBridge: different profiles may complete OAuth concurrently while duplicate work in one profile is rejected', async () => {
  const ipcMain = fakeIpcMain();
  const stores = new Map([['default', fakeAuthStore()], ['profile-work', fakeAuthStore()]]);
  const resolvers = [];
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => fakeWindow(),
    authStore: stores.get('default'),
    getAuthStore: (profileId) => stores.get(profileId),
    clientId: 'c',
    clientSecret: 's',
    signInImpl: async () => new Promise((resolve) => resolvers.push(resolve))
  });

  const personal = ipcMain.invoke('yayra:auth-sign-in', null, { profileId: 'default' });
  const duplicate = await ipcMain.invoke('yayra:auth-sign-in', null, { profileId: 'default' });
  const work = ipcMain.invoke('yayra:auth-sign-in', null, { profileId: 'profile-work' });
  assert.deepEqual(duplicate, { ok: false, error: 'sign_in_already_in_progress' });
  assert.equal(resolvers.length, 2, 'separate profiles are not blocked by each other');
  resolvers[0]({ profile: { sub: 'p' }, tokens: {} });
  resolvers[1]({ profile: { sub: 'w' }, tokens: {} });
  assert.equal((await personal).ok, true);
  assert.equal((await work).ok, true);
});

test('authBridge: sign-in failure emits an error event and does not persist a session', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const shell = { openExternal: async () => {} };
  const signInImpl = async () => { throw new Error('oauth_error:access_denied'); };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'client-123', clientSecret: 'secret-123', signInImpl });

  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.equal(result.ok, false);
  assert.match(result.error, /access_denied/);

  const events = win.sent.filter((e) => e.channel === AUTH_EVENT_CHANNEL).map((e) => e.payload.type);
  assert.deepEqual(events, ['signing-in', 'error']);

  const session = await ipcMain.invoke('yayra:auth-get-session');
  assert.deepEqual(session, { signedIn: false });
});

test('authBridge: sign-in fails fast with not_configured when no Client ID is set, without ever opening a browser', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  let openedUrl = null;
  const shell = { openExternal: async (url) => { openedUrl = url; } };
  const signInImpl = async () => { throw new Error('should never be called'); };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: null, signInImpl });

  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(result, { ok: false, error: 'not_configured' });
  assert.equal(openedUrl, null);
});

test('authBridge: sign-in fails fast with not_configured when Client ID is set but Client Secret is missing', async () => {
  // Google's token endpoint requires a client_secret for Desktop-app clients
  // even with PKCE, so a Client ID alone is not enough configuration.
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  let openedUrl = null;
  const shell = { openExternal: async (url) => { openedUrl = url; } };
  const signInImpl = async () => { throw new Error('should never be called'); };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'client-123', clientSecret: null, signInImpl });

  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(result, { ok: false, error: 'not_configured' });
  assert.equal(openedUrl, null);
});

test('authBridge: sign-in passes the Client Secret and a custom fetchImpl through to the OAuth implementation', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const shell = { openExternal: async () => {} };
  let receivedArgs = null;
  const customFetch = async () => {};
  const signInImpl = async (args) => {
    receivedArgs = args;
    return { profile: { sub: '1' }, tokens: {} };
  };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'client-123', clientSecret: 'secret-123', fetchImpl: customFetch, signInImpl });
  await ipcMain.invoke('yayra:auth-sign-in');

  assert.equal(receivedArgs.clientId, 'client-123');
  assert.equal(receivedArgs.clientSecret, 'secret-123');
  assert.equal(receivedArgs.fetchImpl, customFetch);
});

test('authBridge: app-level Google OAuth always uses the OS external user-agent', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const opened = [];
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  const signInImpl = async (args) => {
    assert.equal('signal' in args, false, 'the system browser is not controlled by an Electron-window abort signal');
    await args.openExternal(authUrl);
    return { profile: { sub: '1', email: 'external@yayra.test' }, tokens: { access_token: 'private' } };
  };

  createAuthBridge({
    ipcMain,
    shell: { openExternal: async (url) => { opened.push(url); } },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl
  });
  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.equal(result.ok, true);
  assert.deepEqual(opened, [authUrl]);
});

test('authBridge: a system-browser launch failure is reported without persisting a session', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const signInImpl = async (args) => {
    await args.openExternal('https://accounts.google.com/o/oauth2/v2/auth');
    throw new Error('must_not_reach');
  };
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => { throw new Error('no system browser'); } },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl,
    logger: { error() {} }
  });
  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(result, { ok: false, error: 'no system browser' });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });
});

test('authBridge: a second concurrent sign-in call is rejected while one is already in progress', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const shell = { openExternal: async () => {} };
  let resolveFirst;
  const signInImpl = async () => new Promise((resolve) => { resolveFirst = resolve; });

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl });

  const firstCallPromise = ipcMain.invoke('yayra:auth-sign-in');
  const secondResult = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(secondResult, { ok: false, error: 'sign_in_already_in_progress' });

  resolveFirst({ profile: { sub: '1' }, tokens: {} });
  const firstResult = await firstCallPromise;
  assert.equal(firstResult.ok, true);
});

test('authBridge: sign-out clears the stored session and emits signed-out', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  authStore.save({ profile: { sub: '1' }, tokens: { access_token: 'access-x', refresh_token: 'refresh-y' } });
  const shell = { openExternal: async () => {} };
  const revocations = [];
  const fetchImpl = async (url, options) => {
    revocations.push({ url, options });
    return new Response('', { status: 200 });
  };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', fetchImpl, signInImpl: async () => ({}) });

  const result = await ipcMain.invoke('yayra:auth-sign-out');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });
  assert.equal(revocations.length, 1);
  assert.equal(revocations[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(revocations[0].options.body).get('token'), 'refresh-y');

  const events = win.sent.filter((e) => e.channel === AUTH_EVENT_CHANNEL).map((e) => e.payload.type);
  assert.deepEqual(events, ['signed-out']);
});

test('authBridge: local sign-out stays successful when Google revocation is unavailable', async () => {
  const ipcMain = fakeIpcMain();
  const authStore = fakeAuthStore();
  authStore.save({ profile: { sub: '1' }, tokens: { access_token: 'access-x' } });
  const warnings = [];
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => fakeWindow(),
    authStore,
    clientId: 'c',
    clientSecret: 's',
    fetchImpl: () => { throw new Error('offline'); },
    signInImpl: async () => ({}),
    logger: { warn: (message) => warnings.push(message), error: () => {} }
  });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-sign-out'), { ok: true });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });
  assert.equal(warnings.length, 1);
});

test('authBridge: Google account management always opens the one hardcoded URL in the system browser', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  let openedUrl = null;
  const shell = { openExternal: async (url) => { openedUrl = url; } };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl: async () => ({}) });

  const result = await ipcMain.invoke('yayra:auth-open-account-page');
  assert.deepEqual(result, { ok: true });
  assert.equal(openedUrl, 'https://myaccount.google.com/');
});

test('authBridge: open-account-page reports an error instead of throwing when shell.openExternal rejects', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const shell = { openExternal: async () => { throw new Error('no handler registered'); } };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl: async () => ({}), logger: { error: () => {} } });

  const result = await ipcMain.invoke('yayra:auth-open-account-page');
  assert.equal(result.ok, false);
  assert.match(result.error, /no handler registered/);
});

test('authBridge: Google product continuation accepts only credential-free owned HTTPS origins', () => {
  assert.equal(normalizeGoogleProductOrigin('https://mail.google.com/mail/u/0/?secret=x#inbox'), 'https://mail.google.com/');
  assert.equal(normalizeGoogleProductOrigin('https://drive.google.com/drive/my-drive'), 'https://drive.google.com/');
  assert.equal(normalizeGoogleProductOrigin('https://www.youtube.com/watch?v=x'), 'https://www.youtube.com/');
  for (const unsafe of [
    'http://mail.google.com/',
    'https://accounts.google.com/ServiceLogin',
    'https://google.com.evil.example/',
    'https://user:pass@mail.google.com/',
    'https://mail.google.com:444/'
  ]) assert.equal(normalizeGoogleProductOrigin(unsafe), null, unsafe);
});

test('authBridge: product continuation strips paths and rejects arbitrary renderer URLs', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const opened = [];
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async (url) => { opened.push(url); } },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl: async () => ({})
  });

  assert.deepEqual(
    await ipcMain.invoke('yayra:auth-open-google-product', null, { origin: 'https://mail.google.com/mail/u/0/?token=private' }),
    { ok: true }
  );
  assert.deepEqual(opened, ['https://mail.google.com/']);
  assert.deepEqual(
    await ipcMain.invoke('yayra:auth-open-google-product', null, { origin: 'https://evil.example/' }),
    { ok: false, error: 'invalid_google_product_origin' }
  );
  assert.deepEqual(opened, ['https://mail.google.com/']);
});

test('authBridge: get-session reflects no prior session as signedIn: false', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  createAuthBridge({ ipcMain, shell: { openExternal: async () => {} }, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl: async () => ({}) });

  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });
});

test('Google services OAuth uses the Yayra-owned Chrome profile as external user-agent while app sign-in stays on the OS browser', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const systemOpened = [];
  const chromeOpened = [];
  const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=client&redirect_uri=http%3A%2F%2F127.0.0.1%3A45123%2Fcallback&state=one-time&code_challenge=pkce';
  const profile = { sub: 'google-subject', email: 'owner@example.com', emailVerified: true };
  const scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'];
  const signInImpl = async ({ openExternal }) => {
    await openExternal(consentUrl);
    return { profile, tokens: { access_token: 'private-token', refresh_token: 'private-refresh', scope: scopes.join(' ') } };
  };
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async (url) => systemOpened.push(url) },
    getMainWindow: () => win,
    authStore,
    clientId: 'client',
    clientSecret: 'secret',
    fetchImpl: async () => new Response('{}', { status: 200 }),
    signInImpl,
    openGoogleAuthorization: (url, profileId) => { chromeOpened.push({ url, profileId }); return { ok: true }; }
  });

  const result = await ipcMain.invoke('yayra:auth-connect-google-services', null, { profileId: 'profile-work' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.profile.email, 'owner@example.com');
  assert.deepEqual(chromeOpened, [{ url: consentUrl, profileId: 'profile-work' }]);
  assert.deepEqual(systemOpened, [], 'Google services OAuth uses the isolated real Chrome profile');
  assert.equal(win.sent.some((entry) => JSON.stringify(entry.payload).includes('private-token')), false, 'tokens never cross IPC');

  // The existing Yayra account sign-in path remains deliberately untouched.
  await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(systemOpened, [consentUrl], 'Yayra sign-in continues to use the OS system browser');
});
