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
    load: () => (session ? { profile: session.profile, savedAt: '2026-01-01T00:00:00.000Z' } : null),
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
  assert.deepEqual(mainWindow.sent.map((entry) => entry.payload.type), ['signing-in', 'signed-in'],
    'the shared main account state stays synchronized too');
  assert.deepEqual(requestWindow.sent.map((entry) => entry.payload.type), ['signing-in', 'signed-in']);
  assert.equal(requestWindow.shown, 1);
  assert.equal(requestWindow.focused, 1);
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
  authStore.save({ profile: { sub: '1' }, tokens: { access_token: 'x' } });
  const shell = { openExternal: async () => {} };

  createAuthBridge({ ipcMain, shell, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl: async () => ({}) });

  const result = await ipcMain.invoke('yayra:auth-sign-out');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });

  const events = win.sent.filter((e) => e.channel === AUTH_EVENT_CHANNEL).map((e) => e.payload.type);
  assert.deepEqual(events, ['signed-out']);
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
