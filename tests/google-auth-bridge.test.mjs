import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthBridge, AUTH_EVENT_CHANNEL } from '../electron/authBridge.cjs';

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
    isDestroyed: () => false,
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

  const events = win.sent.filter((e) => e.channel === AUTH_EVENT_CHANNEL).map((e) => e.payload.type);
  assert.deepEqual(events, ['signing-in', 'signed-in']);

  // Never leak tokens to the renderer under any event.
  const anyTokenLeak = win.sent.some((e) => JSON.stringify(e.payload).includes('secret-'));
  assert.equal(anyTokenLeak, false);

  const session = await ipcMain.invoke('yayra:auth-get-session');
  assert.deepEqual(session, { signedIn: true, profile: { sub: '1', email: 'a@b.com' }, savedAt: '2026-01-01T00:00:00.000Z' });
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

test('authBridge: app-level Google OAuth opens inside a full Yayra window and closes it after success', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const calls = [];
  const googleAuthWindow = {
    openAppAuth(url, options) {
      calls.push(['open', url]);
      this.onClosed = options.onClosed;
      return { ok: true };
    },
    close(_key, options) { calls.push(['close', options.reason]); return true; }
  };
  const signInImpl = async (args) => {
    assert.equal(args.signal.aborted, false);
    await args.openExternal('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    return { profile: { sub: '1', email: 'inside@yayra.test' }, tokens: { access_token: 'private' } };
  };

  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => { throw new Error('must stay inside Yayra'); } },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl,
    googleAuthWindow
  });
  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['open', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'],
    ['close', 'sign-in-finished']
  ]);
});

test('authBridge: closing the full Yayra auth window cancels the pending sign-in without waiting for timeout', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  const googleAuthWindow = {
    openAppAuth(_url, options) {
      queueMicrotask(() => options.onClosed());
      return { ok: true };
    },
    close() { return false; }
  };
  const signInImpl = async (args) => {
    await args.openExternal('https://accounts.google.com/o/oauth2/v2/auth');
    await new Promise((resolve, reject) => {
      const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      if (args.signal.aborted) reject(abortError());
      else args.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl,
    googleAuthWindow,
    logger: { error() {} }
  });
  const result = await ipcMain.invoke('yayra:auth-sign-in');
  assert.deepEqual(result, { ok: false, error: 'sign_in_cancelled' });
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

test('authBridge: open-account-page reuses the top-level Yayra Google window when available', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  let openedUrl = null;
  const googleAuthWindow = {
    openGoogleAccount(url) { openedUrl = url; return { ok: true }; }
  };
  createAuthBridge({
    ipcMain,
    shell: { openExternal: async () => { throw new Error('must stay in Yayra'); } },
    getMainWindow: () => win,
    authStore,
    clientId: 'c',
    clientSecret: 's',
    signInImpl: async () => ({}),
    googleAuthWindow
  });
  const result = await ipcMain.invoke('yayra:auth-open-account-page');
  assert.deepEqual(result, { ok: true });
  assert.equal(openedUrl, 'https://myaccount.google.com/');
});

test('authBridge: older hosts fall back to opening Google account management in the system browser', async () => {
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

test('authBridge: get-session reflects no prior session as signedIn: false', async () => {
  const ipcMain = fakeIpcMain();
  const win = fakeWindow();
  const authStore = fakeAuthStore();
  createAuthBridge({ ipcMain, shell: { openExternal: async () => {} }, getMainWindow: () => win, authStore, clientId: 'c', clientSecret: 's', signInImpl: async () => ({}) });

  assert.deepEqual(await ipcMain.invoke('yayra:auth-get-session'), { signedIn: false });
});
