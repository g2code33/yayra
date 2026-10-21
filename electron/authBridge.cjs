'use strict';

/**
 * Yayra "Sign in with Google" - main-process IPC bridge.
 *
 * Wires electron/googleAuth.cjs (the OAuth flow) and electron/authStore.cjs
 * (encrypted-at-rest session persistence) to the IPC channels the preload
 * script exposes as `window.yayra.auth` (see electron/preload.cjs). Follows
 * the same dependency-injection + factory pattern as createWebviewBridge in
 * electron/webviewBridge.cjs so it stays unit-testable without a real
 * Electron runtime, a real browser, or live network access to Google - see
 * tests/google-oauth.test.mjs and tests/google-auth-bridge.test.mjs.
 *
 * IMPORTANT: this requires a real Google Cloud "Desktop app" OAuth Client ID
 * AND Client Secret that only the person deploying Yayra can create (see
 * docs/GOOGLE_SIGNIN.md for the exact console steps - Google's token
 * endpoint requires the secret for Desktop-app clients even with PKCE).
 * Without both YAYRA_GOOGLE_CLIENT_ID and YAYRA_GOOGLE_CLIENT_SECRET
 * configured, sign-in fails fast with a clear 'not_configured' error rather
 * than silently doing nothing or failing deep inside the token exchange.
 */

const AUTH_EVENT_CHANNEL = 'yayra:auth-event';
const MAX_GOOGLE_PRODUCT_ORIGIN_LENGTH = 512;

/**
 * Renderer requests may open only a credential-free HTTPS Google product
 * origin. Paths, queries, fragments, URL credentials, lookalike hosts, and
 * provider auth endpoints are never accepted across this convenience IPC.
 */
function normalizeGoogleProductOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GOOGLE_PRODUCT_ORIGIN_LENGTH) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const googleOwned = host === 'google.com' || host.endsWith('.google.com')
    || host === 'youtube.com' || host.endsWith('.youtube.com');
  if (!googleOwned || host === 'accounts.google.com' || parsed.port) return null;
  return `${parsed.origin}/`;
}

function createAuthBridge({
  ipcMain,
  shell,
  getMainWindow,
  getWindowForWebContents,
  authStore,
  clientId,
  clientSecret,
  fetchImpl,
  signInImpl,
  logger = console
}) {
  let signingIn = false;

  function resolveRequestWindow(event) {
    try {
      const win = event?.sender && getWindowForWebContents?.(event.sender);
      if (win && !win.isDestroyed?.()) return win;
    } catch { /* detached/closing renderer: fall back to the main window */ }
    return getMainWindow?.() || null;
  }

  function send(type, payload = {}, preferredWindow = null) {
    const windows = [];
    if (preferredWindow && !preferredWindow.isDestroyed?.()) windows.push(preferredWindow);
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed?.() && !windows.includes(mainWindow)) windows.push(mainWindow);
    for (const win of windows) {
      win.webContents?.send?.(AUTH_EVENT_CHANNEL, { type, ...payload });
    }
  }

  async function handleSignIn(event) {
    if (signingIn) return { ok: false, error: 'sign_in_already_in_progress' };
    if (!clientId || !clientSecret) return { ok: false, error: 'not_configured' };

    signingIn = true;
    const requestWindow = resolveRequestWindow(event);
    send('signing-in', {}, requestWindow);
    try {
      const { profile, tokens } = await signInImpl({
        clientId,
        clientSecret,
        // RFC 8252 requires the OS external user-agent. A BrowserWindow is
        // still controlled by Electron and can be rejected as an embedded
        // browser even when it occupies a separate top-level window.
        openExternal: (url) => shell.openExternal(url),
        ...(fetchImpl ? { fetchImpl } : {}),
        logger
      });
      authStore.save({ profile, tokens });
      send('signed-in', { profile }, requestWindow);
      // The verified loopback callback means the browser ceremony is done.
      // Bring the Yayra window that initiated it back so detached/profile
      // windows update themselves instead of sending the result elsewhere.
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : getMainWindow?.();
      if (win && !win.isDestroyed?.()) {
        try { win.show?.(); } catch { /* platform/window may not expose show */ }
        try { win.focus?.(); } catch { /* best effort only */ }
      }
      return { ok: true, profile };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger?.error?.(`[yayra:auth] sign-in failed: ${message}`);
      send('error', { message }, requestWindow);
      return { ok: false, error: message };
    } finally {
      signingIn = false;
    }
  }

  async function handleSignOut(event) {
    authStore.clear();
    send('signed-out', {}, resolveRequestWindow(event));
    return { ok: true };
  }

  async function handleGetSession() {
    const session = authStore.load();
    if (!session || !session.profile) return { signedIn: false };
    return { signedIn: true, profile: session.profile, savedAt: session.savedAt };
  }

  /**
   * Opens one hardcoded Google account-management URL in the system browser.
   * This is not a generic renderer-controlled external-URL capability, and no
   * browser cookies or bearer credentials are copied back into Yayra.
   */
  async function handleOpenAccountPage() {
    try {
      await shell.openExternal('https://myaccount.google.com/');
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger?.error?.(`[yayra:auth] failed to open Google account page: ${message}`);
      return { ok: false, error: message };
    }
  }

  async function handleOpenGoogleProduct(_event, { origin } = {}) {
    const safeOrigin = normalizeGoogleProductOrigin(origin);
    if (!safeOrigin) return { ok: false, error: 'invalid_google_product_origin' };
    try {
      await shell.openExternal(safeOrigin);
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger?.error?.(`[yayra:auth] failed to open Google product: ${message}`);
      return { ok: false, error: message };
    }
  }

  ipcMain.handle('yayra:auth-sign-in', handleSignIn);
  ipcMain.handle('yayra:auth-sign-out', handleSignOut);
  ipcMain.handle('yayra:auth-get-session', handleGetSession);
  ipcMain.handle('yayra:auth-open-account-page', handleOpenAccountPage);
  ipcMain.handle('yayra:auth-open-google-product', handleOpenGoogleProduct);

  return { handleSignIn, handleSignOut, handleGetSession, handleOpenAccountPage, handleOpenGoogleProduct };
}

module.exports = { createAuthBridge, AUTH_EVENT_CHANNEL, normalizeGoogleProductOrigin };
