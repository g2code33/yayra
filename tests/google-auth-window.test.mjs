import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  APP_GOOGLE_AUTH_PARTITION,
  APP_GOOGLE_AUTH_WINDOW_KEY,
  callbackMatchesExpected,
  createGoogleAuthWindowManager,
  extractOAuthRedirect,
  isGoogleIdentitySurfaceUrl
} from '../electron/googleAuthWindow.cjs';

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = '';
    this.userAgent = '';
    this.windowOpenHandler = null;
  }
  getURL() { return this.url; }
  setUserAgent(value) { this.userAgent = value; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  isDestroyed() { return false; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.shown = false;
    this.focused = false;
    this.maximized = false;
    this.loaded = [];
    FakeBrowserWindow.instances.push(this);
  }
  async loadURL(url) {
    this.loaded.push(url);
    this.webContents.url = url;
  }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  maximize() { this.maximized = true; }
}

function makeManager(options = {}) {
  FakeBrowserWindow.instances.length = 0;
  const owner = {
    focused: false,
    isDestroyed: () => false,
    isMaximized: () => false,
    show() {},
    focus() { this.focused = true; }
  };
  const manager = createGoogleAuthWindowManager({
    BrowserWindow: FakeBrowserWindow,
    getMainWindow: () => owner,
    buildUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    callbackSettleMs: 1,
    logger: { error() {} },
    ...options
  });
  return { manager, owner };
}

test('Google auth window helpers recognize identity surfaces and exact callback origins', () => {
  assert.equal(isGoogleIdentitySurfaceUrl('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isGoogleIdentitySurfaceUrl('https://consent.google.com/'), true);
  assert.equal(isGoogleIdentitySurfaceUrl('https://accounts.google.com.evil.example/'), false);
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fgithub.com%2Fsessions%2Fsocial%2Fcallback';
  assert.deepEqual(extractOAuthRedirect(authUrl), { origin: 'https://github.com', pathname: '/sessions/social/callback' });
  assert.equal(callbackMatchesExpected('https://github.com/sessions/social/callback?code=x', extractOAuthRedirect(authUrl)), true);
  assert.equal(callbackMatchesExpected('https://github.com/sessions/social/callback/?code=x', extractOAuthRedirect(authUrl)), true);
  assert.equal(callbackMatchesExpected('https://github.com/sessions/social/callback/evil?code=x', extractOAuthRedirect(authUrl)), false);
  assert.equal(callbackMatchesExpected('https://evil.example/sessions/social/callback?code=x', extractOAuthRedirect(authUrl)), false);
  const nested = new URL('https://accounts.google.com/v3/signin');
  nested.searchParams.set('continue', 'https://app.example/oauth/callback');
  const wrapped = new URL('https://accounts.google.com/gsi/select');
  wrapped.searchParams.set('continue', nested.toString());
  assert.deepEqual(extractOAuthRedirect(wrapped.toString()), { origin: 'https://app.example', pathname: '/oauth/callback' });
});

test('Yayra app sign-in uses a full top-level BrowserWindow with a persistent Google auth session', async () => {
  const { manager, owner } = makeManager();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=yayra';
  const result = manager.openAppAuth(url);
  assert.deepEqual(result, { ok: true, reused: false, key: APP_GOOGLE_AUTH_WINDOW_KEY });
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.options.webPreferences.partition, APP_GOOGLE_AUTH_PARTITION);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.doesNotMatch(win.webContents.userAgent, /Electron/i);
  assert.deepEqual(win.loaded, [url]);
  win.emit('ready-to-show');
  assert.equal(win.shown, true);
  assert.equal(win.focused, true);
  assert.equal(manager.close(), true);
  assert.equal(win.destroyed, true);
  assert.equal(owner.focused, true, 'Yayra regains focus after its loopback flow completes');
});

test('website Google OAuth shares the source profile Session and resumes the source tab after callback redirects settle', async () => {
  const { manager } = makeManager();
  const sharedSession = { id: 'profile-session' };
  const sourceLoads = [];
  const source = {
    session: sharedSession,
    getURL: () => 'https://github.com/login',
    isDestroyed: () => false,
    loadURL: async (url) => sourceLoads.push(url)
  };
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=github&redirect_uri=https%3A%2F%2Fgithub.com%2Fsessions%2Fsocial%2Fcallback';
  manager.openWebsiteAuth({ key: 'website:1', url: authUrl, sourceWebContents: source });
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.options.webPreferences.session, sharedSession, 'cookies/storage stay in the originating Yayra profile');
  assert.equal(win.options.webPreferences.partition, undefined);

  win.webContents.url = 'https://accounts.google.com/v3/signin/challenge/pwd';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.webContents.emit('did-stop-loading');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sourceLoads, [], 'internal Google sign-in routes never return early to the embedded tab');

  win.webContents.url = 'https://github.com/sessions/social/callback?code=one&state=two';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.webContents.url = 'https://github.com/settings/profile';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.webContents.emit('did-stop-loading');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sourceLoads, ['https://github.com/settings/profile']);
  assert.equal(win.destroyed, true);
});

test('a callback URL that still contains a one-time code is never replayed in the source tab', async () => {
  let scheduled = null;
  const fakeTimer = (callback, delay) => {
    scheduled = { callback, delay, unref() {} };
    return scheduled;
  };
  const { manager } = makeManager({ setTimeoutImpl: fakeTimer, clearTimeoutImpl: () => {} });
  const sourceLoads = [];
  const source = {
    session: {},
    getURL: () => 'https://app.example/login',
    isDestroyed: () => false,
    loadURL: async (url) => sourceLoads.push(url)
  };
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fapp.example%2Foauth%2Fcallback';
  manager.openWebsiteAuth({ key: 'website:code', url: authUrl, sourceWebContents: source });
  const win = FakeBrowserWindow.instances[0];
  win.webContents.url = 'https://app.example/oauth/callback?code=single-use&state=s';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.webContents.emit('did-stop-loading');
  assert.ok(scheduled.delay >= 3200, 'callback SPAs receive time to consume and redirect');
  scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sourceLoads, ['https://app.example/login'], 'shared session state is reused without replaying the code');
});

test('a provider that closes its callback window still resumes the original website tab', async () => {
  const { manager, owner } = makeManager();
  const sourceLoads = [];
  let completed = null;
  let closed = null;
  const source = {
    session: {},
    getURL: () => 'https://app.example/login',
    isDestroyed: () => false,
    loadURL: async (url) => sourceLoads.push(url)
  };
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fapp.example%2Foauth%2Fcallback';
  manager.openWebsiteAuth({
    key: 'website:self-close',
    url: authUrl,
    sourceWebContents: source,
    onComplete: (value) => { completed = value; },
    onClosed: (value) => { closed = value; }
  });
  const win = FakeBrowserWindow.instances[0];
  win.webContents.url = 'https://app.example/oauth/callback?code=single-use&state=s';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sourceLoads, ['https://app.example/login']);
  assert.equal(completed.url, 'https://app.example/login');
  assert.equal(closed, null, 'provider-driven close after callback is completion, not cancellation');
  assert.equal(owner.focused, true);
});

test('closing the full auth window cancels cleanly, while provider popups stay in the same window', async () => {
  const { manager } = makeManager();
  let closed = null;
  const source = { session: {}, getURL: () => 'https://site.example/', isDestroyed: () => false, loadURL: async () => {} };
  manager.openWebsiteAuth({
    key: 'website:close',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    sourceWebContents: source,
    onClosed: (value) => { closed = value; }
  });
  const win = FakeBrowserWindow.instances[0];
  win.webContents.url = 'https://support.google.com/accounts/';
  win.webContents.emit('did-navigate', {}, win.webContents.url);
  win.webContents.emit('did-stop-loading');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(win.destroyed, false, 'an arbitrary link away from Google is not mistaken for an OAuth callback');
  const response = win.webContents.windowOpenHandler({ url: 'https://accounts.google.com/signin/challenge' });
  assert.deepEqual(response, { action: 'deny' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.loaded.at(-1), 'https://accounts.google.com/signin/challenge');
  win.close();
  assert.deepEqual(closed, { reason: 'window-closed', completed: false });
  assert.equal(manager.has('website:close'), false);
});
