'use strict';

/**
 * Top-level Google authentication windows for desktop Yayra.
 *
 * A website tab is a WebContentsView attached to Yayra's chrome. Google may
 * reject OAuth in that embedded surface, while sending the same authorization
 * URL to the system browser loses the originating Yayra profile and leaves the
 * provider callback outside Yayra. A standalone BrowserWindow fixes both:
 * Google receives a top-level user-agent and the window uses the exact Session
 * of the originating tab, so callback cookies/storage belong to that Yayra
 * profile. Once the callback settles, the source tab resumes automatically.
 *
 * Yayra's own account sign-in uses the same full window with its existing
 * loopback + PKCE flow. The loopback page is therefore reached inside Yayra,
 * after which the window closes and the main app regains focus.
 */

const { URL } = require('node:url');

const APP_GOOGLE_AUTH_WINDOW_KEY = 'yayra-app-google-auth';
const APP_GOOGLE_AUTH_PARTITION = 'persist:yayra-google-auth';
const DEFAULT_CALLBACK_SETTLE_MS = 1400;
const OAUTH_QUERY_KEYS = Object.freeze(['code', 'state', 'error', 'error_description']);

function parseHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

function isGoogleIdentitySurfaceUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'accounts.google.com' || host === 'consent.google.com';
}

function extractOAuthRedirect(rawUrl, depth = 0) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed || depth > 3) return null;
  for (const key of ['redirect_uri', 'redirect_url']) {
    const value = parsed.searchParams.get(key);
    const redirect = parseHttpUrl(value);
    if (redirect) return { origin: redirect.origin, pathname: redirect.pathname };
  }
  // Some GSI routes wrap the registered callback in one or more Google
  // `continue` URLs. Unwrap a bounded number of levels without ever accepting
  // non-HTTP schemes.
  for (const key of ['continue', 'continue_url']) {
    const nested = parseHttpUrl(parsed.searchParams.get(key));
    if (!nested) continue;
    const inner = extractOAuthRedirect(nested.toString(), depth + 1);
    if (inner) return inner;
    if (!isGoogleIdentitySurfaceUrl(nested.toString())) {
      return { origin: nested.origin, pathname: nested.pathname };
    }
  }
  return null;
}

function hasOAuthResponseParameters(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return false;
  return OAUTH_QUERY_KEYS.some((key) => parsed.searchParams.has(key));
}

function callbackMatchesExpected(rawUrl, expected) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed || !expected) return false;
  if (parsed.origin !== expected.origin) return false;
  // Callback acceptance is exact: query/fragment values may vary, while the
  // registered origin and normalized path may not. A single trailing slash is
  // treated as equivalent because providers commonly canonicalize it.
  const normalizePath = (value) => String(value || '/').replace(/\/+$/, '') || '/';
  return normalizePath(parsed.pathname) === normalizePath(expected.pathname);
}

function focusWindow(win) {
  try {
    if (!win || win.isDestroyed?.()) return;
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    win.focus?.();
  } catch { /* window raced destruction */ }
}

function createGoogleAuthWindowManager({
  BrowserWindow,
  getMainWindow,
  buildUserAgent,
  iconPath = null,
  logger = console,
  callbackSettleMs = DEFAULT_CALLBACK_SETTLE_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow_required');
  const windows = new Map();

  function safeClose(record, { focusOwner = true, reason = 'completed', notify = false } = {}) {
    if (!record || record.closed) return;
    record.closed = true;
    record.programmaticClose = true;
    if (record.settleTimer) clearTimeoutImpl(record.settleTimer);
    windows.delete(record.key);
    try {
      if (!record.window.isDestroyed?.()) record.window.close?.();
    } catch { /* already closing */ }
    if (notify) {
      try { record.onClosed?.({ reason, completed: record.completed === true }); } catch { /* caller-owned */ }
    }
    if (focusOwner) focusWindow(record.ownerWindow || getMainWindow?.());
  }

  function finishWebsiteAuth(record, finalUrl, windowAlreadyClosed = false) {
    if (!record || record.closed || record.completed) return;
    const final = parseHttpUrl(finalUrl);
    if (!final || isGoogleIdentitySurfaceUrl(final.toString())) return;
    record.completed = true;

    let destination = final.toString();
    // A callback page that still visibly carries a one-shot code may already
    // have consumed it in this window. Never replay that code in the source
    // tab; shared cookies/storage are already available there, so refresh the
    // relying page instead. Normal server callbacks redirect to their final
    // destination and therefore take the direct path above.
    if (hasOAuthResponseParameters(destination)
        && (!record.expectedRedirect || callbackMatchesExpected(destination, record.expectedRedirect))) {
      destination = record.sourceUrl || `${final.origin}/`;
    }

    Promise.resolve().then(async () => {
      const source = record.sourceWebContents;
      if (source && !source.isDestroyed?.()) {
        try { await source.loadURL(destination); }
        catch (error) {
          logger?.error?.(`[yayra:google-auth-window] could not resume source tab: ${error?.message || error}`);
        }
      }
      try { record.onComplete?.({ url: destination, callbackUrl: final.toString() }); } catch { /* caller-owned */ }
      if (windowAlreadyClosed) {
        record.closed = true;
        focusWindow(record.ownerWindow || getMainWindow?.());
      } else {
        safeClose(record, { focusOwner: true, reason: 'completed' });
      }
    });
  }

  function inspectWebsiteNavigation(record, rawUrl) {
    if (!record || record.mode !== 'website' || record.closed || record.completed) return;
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed || isGoogleIdentitySurfaceUrl(parsed.toString())) {
      record.completionCandidate = null;
      return;
    }

    if (record.expectedRedirect) {
      if (callbackMatchesExpected(parsed.toString(), record.expectedRedirect)) record.callbackReached = true;
      if (!record.callbackReached) return;
    } else if (!record.callbackReached) {
      // OAuth URLs normally expose redirect_uri. If a provider variant hides
      // it, accept only a response-bearing navigation or a return to the
      // source site's own origin—not an arbitrary help/link destination.
      const source = parseHttpUrl(record.sourceUrl);
      const returnedToSource = Boolean(source && source.origin === parsed.origin);
      if (!returnedToSource && !hasOAuthResponseParameters(parsed.toString())) return;
      record.callbackReached = true;
    }
    record.completionCandidate = parsed.toString();
  }

  function scheduleWebsiteCompletion(record) {
    if (!record || record.mode !== 'website' || !record.completionCandidate || record.closed || record.completed) return;
    if (record.settleTimer) clearTimeoutImpl(record.settleTimer);
    // Callback SPAs can exchange their one-shot code and redirect client-side;
    // wait longer while those response parameters remain in the address.
    const delay = hasOAuthResponseParameters(record.completionCandidate)
      ? Math.max(callbackSettleMs, 3200)
      : callbackSettleMs;
    record.settleTimer = setTimeoutImpl(() => {
      record.settleTimer = null;
      let current = record.completionCandidate;
      try { current = record.window.webContents.getURL?.() || current; } catch { /* keep candidate */ }
      inspectWebsiteNavigation(record, current);
      if (record.completionCandidate) finishWebsiteAuth(record, current);
    }, delay);
    record.settleTimer?.unref?.();
  }

  function open({
    key,
    url,
    mode = 'website',
    sourceWebContents = null,
    ownerWindow = null,
    partition = null,
    onComplete = null,
    onClosed = null
  }) {
    const target = parseHttpUrl(url);
    if (!target) throw new Error('invalid_google_auth_url');
    const normalizedKey = String(key || (mode === 'app' ? APP_GOOGLE_AUTH_WINDOW_KEY : `website:${Date.now()}`));
    const existing = windows.get(normalizedKey);
    if (existing && !existing.window.isDestroyed?.()) {
      existing.sourceWebContents = sourceWebContents || existing.sourceWebContents;
      existing.sourceUrl = existing.sourceWebContents?.getURL?.() || existing.sourceUrl;
      existing.onComplete = onComplete || existing.onComplete;
      existing.onClosed = onClosed || existing.onClosed;
      focusWindow(existing.window);
      const current = existing.window.webContents.getURL?.() || '';
      if (current !== target.toString()) {
        if (mode === 'website') {
          existing.expectedRedirect = extractOAuthRedirect(target.toString());
          existing.callbackReached = false;
          existing.completionCandidate = null;
          if (existing.settleTimer) clearTimeoutImpl(existing.settleTimer);
          existing.settleTimer = null;
        }
        existing.window.loadURL?.(target.toString()).catch?.(() => {});
      }
      return { ok: true, reused: true, key: normalizedKey };
    }

    const owner = ownerWindow && !ownerWindow.isDestroyed?.() ? ownerWindow : getMainWindow?.();
    const sourceSession = sourceWebContents && sourceWebContents.session;
    const webPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      ...(sourceSession ? { session: sourceSession } : partition ? { partition } : {})
    };
    const authWindow = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 720,
      minHeight: 560,
      title: 'Sign in - Google Accounts',
      backgroundColor: '#ffffff',
      show: false,
      autoHideMenuBar: true,
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences
    });
    const record = {
      key: normalizedKey,
      mode,
      window: authWindow,
      ownerWindow: owner,
      sourceWebContents,
      sourceUrl: sourceWebContents?.getURL?.() || '',
      expectedRedirect: mode === 'website' ? extractOAuthRedirect(target.toString()) : null,
      callbackReached: false,
      completionCandidate: null,
      settleTimer: null,
      onComplete,
      onClosed,
      completed: false,
      closed: false,
      programmaticClose: false
    };
    windows.set(normalizedKey, record);

    try {
      const ua = typeof buildUserAgent === 'function' ? buildUserAgent() : '';
      if (ua && typeof authWindow.webContents.setUserAgent === 'function') authWindow.webContents.setUserAgent(ua);
    } catch { /* default UA still yields a top-level window */ }

    authWindow.webContents.setWindowOpenHandler?.(({ url: popupUrl }) => {
      const popup = parseHttpUrl(popupUrl);
      if (popup) {
        // Keep provider-owned popup/continue links in the SAME top-level auth
        // window, preserving its Session and callback tracking.
        Promise.resolve(authWindow.loadURL(popup.toString())).catch((error) => {
          logger?.error?.(`[yayra:google-auth-window] popup navigation failed: ${error?.message || error}`);
        });
      } else if (popupUrl) {
        logger?.warn?.('[yayra:google-auth-window] blocked non-HTTP popup from authentication surface');
      }
      return { action: 'deny' };
    });

    authWindow.webContents.on?.('will-navigate', (event, navigation) => {
      const navigationUrl = navigation && typeof navigation === 'object' ? navigation.url : navigation;
      if (parseHttpUrl(navigationUrl)) return;
      event?.preventDefault?.();
      if (navigationUrl) logger?.warn?.('[yayra:google-auth-window] blocked non-HTTP navigation from authentication surface');
    });
    authWindow.webContents.on?.('did-navigate', (_event, navigationUrl) => {
      inspectWebsiteNavigation(record, navigationUrl);
    });
    authWindow.webContents.on?.('did-navigate-in-page', (_event, navigationUrl) => {
      inspectWebsiteNavigation(record, navigationUrl);
    });
    authWindow.webContents.on?.('did-stop-loading', () => {
      let current = '';
      try { current = authWindow.webContents.getURL?.() || ''; } catch { /* destroyed */ }
      inspectWebsiteNavigation(record, current);
      scheduleWebsiteCompletion(record);
    });

    authWindow.once?.('ready-to-show', () => {
      try {
        if (owner?.isMaximized?.()) authWindow.maximize?.();
      } catch { /* cosmetic */ }
      focusWindow(authWindow);
    });
    authWindow.on?.('closed', () => {
      if (record.settleTimer) clearTimeoutImpl(record.settleTimer);
      record.settleTimer = null;
      windows.delete(record.key);
      // Popup-style relying parties often execute window.close() immediately
      // after their exact callback loads. The callback Session is already the
      // source tab's Session, so treat that as completion and resume the tab
      // instead of misreporting a user cancellation.
      if (!record.programmaticClose
          && record.mode === 'website'
          && record.callbackReached
          && record.completionCandidate
          && !record.completed) {
        finishWebsiteAuth(record, record.completionCandidate, true);
        return;
      }
      record.closed = true;
      if (!record.programmaticClose) {
        try { record.onClosed?.({ reason: 'window-closed', completed: record.completed === true }); } catch { /* caller-owned */ }
        focusWindow(record.ownerWindow || getMainWindow?.());
      }
    });

    Promise.resolve(authWindow.loadURL(target.toString())).catch((error) => {
      logger?.error?.(`[yayra:google-auth-window] could not load sign-in: ${error?.message || error}`);
      try { record.onClosed?.({ reason: 'load-failed', completed: false, error: error?.message || String(error) }); } catch { /* caller-owned */ }
      safeClose(record, { focusOwner: true, reason: 'load-failed' });
    });
    return { ok: true, reused: false, key: normalizedKey };
  }

  function openWebsiteAuth(options) {
    return open({ ...options, mode: 'website' });
  }

  function openAppAuth(url, { onClosed } = {}) {
    return open({
      key: APP_GOOGLE_AUTH_WINDOW_KEY,
      url,
      mode: 'app',
      partition: APP_GOOGLE_AUTH_PARTITION,
      ownerWindow: getMainWindow?.(),
      onClosed
    });
  }

  function openGoogleAccount(url = 'https://myaccount.google.com/') {
    return open({
      key: APP_GOOGLE_AUTH_WINDOW_KEY,
      url,
      mode: 'account',
      partition: APP_GOOGLE_AUTH_PARTITION,
      ownerWindow: getMainWindow?.()
    });
  }

  function close(key = APP_GOOGLE_AUTH_WINDOW_KEY, options = {}) {
    const record = windows.get(String(key));
    if (!record) return false;
    safeClose(record, { focusOwner: options.focusOwner !== false, reason: options.reason || 'completed' });
    return true;
  }

  function closeAll() {
    for (const record of [...windows.values()]) safeClose(record, { focusOwner: false, reason: 'app-quit' });
  }

  return {
    openWebsiteAuth,
    openAppAuth,
    openGoogleAccount,
    close,
    closeAll,
    has: (key) => windows.has(String(key)),
    _windows: windows
  };
}

module.exports = {
  APP_GOOGLE_AUTH_PARTITION,
  APP_GOOGLE_AUTH_WINDOW_KEY,
  DEFAULT_CALLBACK_SETTLE_MS,
  callbackMatchesExpected,
  createGoogleAuthWindowManager,
  extractOAuthRedirect,
  hasOAuthResponseParameters,
  isGoogleIdentitySurfaceUrl,
  parseHttpUrl
};
