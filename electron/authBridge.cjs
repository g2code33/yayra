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
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_MAX_FILE_BYTES = 300 * 1024 * 1024;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_PROFILE_ID = 'default';
const MAX_PROFILE_ID_LENGTH = 160;
const DRIVE_EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx'
  },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', extension: '.pdf' }
});

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

function safeDriveFilename(value, fallback = 'Google Drive download') {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 180);
  return clean || fallback;
}

function tokenScopes(tokens) {
  return new Set(String(tokens?.scope || '').split(/\s+/).filter(Boolean));
}

function normalizeAuthProfileId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > MAX_PROFILE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(id)) return DEFAULT_PROFILE_ID;
  return id;
}

function createAuthBridge({
  ipcMain,
  shell,
  getMainWindow,
  getWindowForWebContents,
  getProfileIdForWebContents,
  getWindowsForProfile,
  authStore,
  getAuthStore,
  clientId,
  clientSecret,
  fetchImpl,
  signInImpl,
  logger = console
}) {
  const signingInProfiles = new Set();

  function resolveRequestWindow(event) {
    try {
      const win = event?.sender && getWindowForWebContents?.(event.sender);
      if (win && !win.isDestroyed?.()) return win;
      // An IPC event with a sender must never fall through to an unrelated
      // main window when that sender is already detached/closing.
      if (event?.sender) return null;
    } catch { return null; }
    return getMainWindow?.() || null;
  }

  function resolveProfileId(event, payload = {}) {
    const claimed = normalizeAuthProfileId(payload?.profileId);
    try {
      if (event?.sender && typeof getProfileIdForWebContents === 'function') {
        return normalizeAuthProfileId(getProfileIdForWebContents(event.sender, claimed));
      }
    } catch {
      // A resolver failure cannot grant access to a different profile.
      return DEFAULT_PROFILE_ID;
    }
    return claimed;
  }

  function storeForProfile(profileId) {
    const store = typeof getAuthStore === 'function' ? getAuthStore(profileId) : authStore;
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.clear !== 'function') {
      throw new Error('auth_store_unavailable');
    }
    return store;
  }

  function firstWindowForProfile(profileId) {
    if (typeof getWindowsForProfile !== 'function') return null;
    try {
      return (getWindowsForProfile(normalizeAuthProfileId(profileId)) || [])
        .find((candidate) => candidate && !candidate.isDestroyed?.()) || null;
    } catch {
      return null;
    }
  }

  function send(type, payload = {}, preferredWindow = null, profileId = DEFAULT_PROFILE_ID) {
    const normalizedProfileId = normalizeAuthProfileId(profileId);
    const windows = [];
    if (preferredWindow && !preferredWindow.isDestroyed?.()) windows.push(preferredWindow);
    if (typeof getWindowsForProfile === 'function') {
      try {
        for (const win of getWindowsForProfile(normalizedProfileId) || []) {
          if (win && !win.isDestroyed?.() && !windows.includes(win)) windows.push(win);
        }
      } catch { /* the initiating window still receives the event */ }
    }
    // Deliberately no unconditional main-window fan-out. That old behavior
    // replaced one open profile window's account when another signed in.
    for (const win of windows) {
      win.webContents?.send?.(AUTH_EVENT_CHANNEL, { type, ...payload, profileId: normalizedProfileId });
    }
  }

  async function handleSignIn(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    if (signingInProfiles.has(profileId)) return { ok: false, error: 'sign_in_already_in_progress' };
    if (!clientId || !clientSecret) return { ok: false, error: 'not_configured' };

    signingInProfiles.add(profileId);
    const requestWindow = resolveRequestWindow(event);
    send('signing-in', {}, requestWindow, profileId);
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
      storeForProfile(profileId).save({ profile, tokens });
      send('signed-in', { profile }, requestWindow, profileId);
      // The verified loopback callback means the browser ceremony is done.
      // Bring the Yayra window that initiated it back so detached/profile
      // windows update themselves instead of sending the result elsewhere.
      const matchingWindow = firstWindowForProfile(profileId);
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : (matchingWindow || (!event?.sender ? getMainWindow?.() : null));
      if (win && !win.isDestroyed?.()) {
        try { win.show?.(); } catch { /* platform/window may not expose show */ }
        try { win.focus?.(); } catch { /* best effort only */ }
      }
      return { ok: true, profile };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger?.error?.(`[yayra:auth] sign-in failed: ${message}`);
      send('error', { message }, requestWindow, profileId);
      return { ok: false, error: message };
    } finally {
      signingInProfiles.delete(profileId);
    }
  }

  async function handleConnectDrive(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    if (signingInProfiles.has(profileId)) return { ok: false, error: 'sign_in_already_in_progress' };
    if (!clientId || !clientSecret || typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    signingInProfiles.add(profileId);
    const requestWindow = resolveRequestWindow(event);
    send('drive-connecting', {}, requestWindow, profileId);
    try {
      const { profile, tokens } = await signInImpl({
        clientId,
        clientSecret,
        scopes: ['openid', 'email', 'profile', DRIVE_READONLY_SCOPE],
        openExternal: (url) => shell.openExternal(url),
        fetchImpl,
        logger
      });
      const scopedTokens = {
        ...tokens,
        scope: typeof tokens?.scope === 'string' && tokens.scope
          ? tokens.scope
          : `openid email profile ${DRIVE_READONLY_SCOPE}`,
        obtained_at_ms: Date.now()
      };
      if (!tokenScopes(scopedTokens).has(DRIVE_READONLY_SCOPE)) throw new Error('drive_scope_not_granted');
      storeForProfile(profileId).save({ profile, tokens: scopedTokens });
      send('signed-in', { profile }, requestWindow, profileId);
      send('drive-connected', { profile }, requestWindow, profileId);
      const matchingWindow = firstWindowForProfile(profileId);
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : (matchingWindow || (!event?.sender ? getMainWindow?.() : null));
      try { win?.show?.(); win?.focus?.(); } catch { /* best effort */ }
      return { ok: true, profile };
    } catch (err) {
      const message = err?.message || String(err);
      logger?.error?.(`[yayra:drive] connection failed: ${message}`);
      send('drive-error', { message }, requestWindow, profileId);
      return { ok: false, error: message };
    } finally {
      signingInProfiles.delete(profileId);
    }
  }

  async function usableDriveSession(profileId) {
    const store = storeForProfile(profileId);
    const session = store.load();
    if (!session?.profile || !session.tokens || !tokenScopes(session.tokens).has(DRIVE_READONLY_SCOPE)) {
      throw new Error('drive_reconnect_required');
    }
    const tokens = { ...session.tokens };
    const obtainedAt = Number(tokens.obtained_at_ms);
    const expiresIn = Number(tokens.expires_in);
    const expiresAt = Number.isFinite(obtainedAt) && Number.isFinite(expiresIn)
      ? obtainedAt + expiresIn * 1000
      : Number.POSITIVE_INFINITY;
    if (expiresAt > Date.now() + 60_000) return { ...session, tokens };
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('drive_reconnect_required');
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    });
    const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!response.ok) throw new Error('drive_reconnect_required');
    const refreshed = await response.json();
    if (typeof refreshed?.access_token !== 'string' || !refreshed.access_token
      || refreshed.access_token.length > 8192 || /[\u0000-\u0020\u007f]/.test(refreshed.access_token)) {
      throw new Error('drive_reconnect_required');
    }
    const nextTokens = {
      ...tokens,
      ...refreshed,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      scope: refreshed.scope || tokens.scope,
      obtained_at_ms: Date.now()
    };
    store.save({ profile: session.profile, tokens: nextTokens });
    return { ...session, tokens: nextTokens };
  }

  async function handleDownloadDriveFile(event, { fileId, profileId: claimedProfileId } = {}) {
    const profileId = resolveProfileId(event, { profileId: claimedProfileId });
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
      return { ok: false, error: 'invalid_drive_file_id' };
    }
    try {
      const session = await usableDriveSession(profileId);
      const authorization = { Authorization: `Bearer ${session.tokens.access_token}` };
      const metadataUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,capabilities%28canDownload%29&supportsAllDrives=true`;
      const metadataResponse = await fetchImpl(metadataUrl, { headers: { ...authorization, Accept: 'application/json' } });
      if (!metadataResponse.ok) {
        if (metadataResponse.status === 401) throw new Error('drive_reconnect_required');
        throw new Error(metadataResponse.status === 404 ? 'drive_file_not_found' : 'drive_file_not_downloadable');
      }
      const metadata = await metadataResponse.json();
      if (metadata?.capabilities?.canDownload === false) throw new Error('drive_file_not_downloadable');
      const size = Number(metadata?.size);
      if (Number.isFinite(size) && size > DRIVE_MAX_FILE_BYTES) throw new Error('drive_file_too_large');
      const exportInfo = DRIVE_EXPORTS[metadata?.mimeType];
      const mediaUrl = exportInfo
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportInfo.mimeType)}`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const mediaResponse = await fetchImpl(mediaUrl, { headers: authorization });
      if (!mediaResponse.ok) {
        if (mediaResponse.status === 401) throw new Error('drive_reconnect_required');
        throw new Error('drive_download_failed');
      }
      const declared = Number(mediaResponse.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > DRIVE_MAX_FILE_BYTES) throw new Error('drive_file_too_large');
      const data = Buffer.from(await mediaResponse.arrayBuffer());
      if (!data.length || data.length > DRIVE_MAX_FILE_BYTES) throw new Error('drive_file_too_large');
      let name = safeDriveFilename(metadata?.name);
      if (exportInfo && !name.toLowerCase().endsWith(exportInfo.extension)) name += exportInfo.extension;
      return {
        ok: true,
        name,
        filename: name,
        mimeType: exportInfo?.mimeType || mediaResponse.headers?.get?.('content-type') || metadata?.mimeType || 'application/octet-stream',
        data
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleSignOut(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    const store = storeForProfile(profileId);
    const session = store.load();
    store.clear();
    send('signed-out', {}, resolveRequestWindow(event), profileId);

    // Local sign-out is authoritative and immediate. Revoke the strongest
    // surviving Google credential best-effort without ever exposing it over
    // IPC or restoring the encrypted store when Google is unavailable.
    const token = session?.tokens?.refresh_token || session?.tokens?.access_token;
    if (typeof fetchImpl === 'function' && typeof token === 'string' && token) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timeout = null;
      try {
        const request = Promise.resolve().then(() => fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          ...(controller ? { signal: controller.signal } : {})
        })).catch(() => null);
        const deadline = new Promise((resolve) => {
          timeout = setTimeout(() => {
            try { controller?.abort(); } catch { /* best effort */ }
            resolve(null);
          }, 5_000);
          timeout?.unref?.();
        });
        const response = await Promise.race([request, deadline]);
        if (!response?.ok) logger?.warn?.('[yayra:auth] Google credential revocation was unavailable after local sign-out');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    return { ok: true };
  }

  async function handleGetSession(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    const session = storeForProfile(profileId).load();
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
  ipcMain.handle('yayra:auth-connect-drive', handleConnectDrive);
  ipcMain.handle('yayra:auth-download-drive-file', handleDownloadDriveFile);
  ipcMain.handle('yayra:auth-sign-out', handleSignOut);
  ipcMain.handle('yayra:auth-get-session', handleGetSession);
  ipcMain.handle('yayra:auth-open-account-page', handleOpenAccountPage);
  ipcMain.handle('yayra:auth-open-google-product', handleOpenGoogleProduct);

  return {
    handleSignIn,
    handleConnectDrive,
    handleDownloadDriveFile,
    handleSignOut,
    handleGetSession,
    handleOpenAccountPage,
    handleOpenGoogleProduct
  };
}

module.exports = {
  createAuthBridge,
  AUTH_EVENT_CHANNEL,
  normalizeGoogleProductOrigin,
  normalizeAuthProfileId
};
