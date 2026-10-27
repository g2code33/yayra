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
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_SERVICES_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/classroom.courses.readonly'
];
const GOOGLE_SERVICE_SCOPES = GOOGLE_SERVICES_SCOPES.slice(3);
const serviceCatalogPromise = import('../src/services/googleServiceCatalog.js');
const DRIVE_MAX_FILE_BYTES = 300 * 1024 * 1024;
const GMAIL_LIST_MAX_RESULTS = 30;
const GMAIL_BODY_MAX_CHARS = 2 * 1024 * 1024;
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

function cleanGmailText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength);
}

function gmailHeaders(payload) {
  const values = new Map();
  for (const header of Array.isArray(payload?.headers) ? payload.headers : []) {
    const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
    if (['subject', 'from', 'to', 'date'].includes(name) && !values.has(name)) {
      values.set(name, cleanGmailText(header.value, name === 'subject' ? 998 : 2000));
    }
  }
  return {
    subject: values.get('subject') || '(no subject)',
    from: values.get('from') || '',
    to: values.get('to') || '',
    date: values.get('date') || ''
  };
}

function normalizeGmailMessageMetadata(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id)) return null;
  const threadId = typeof value.threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.threadId)
    ? value.threadId
    : value.id;
  const labelIds = (Array.isArray(value.labelIds) ? value.labelIds : [])
    .filter((label) => typeof label === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(label))
    .slice(0, 50);
  const internalDate = typeof value.internalDate === 'string' && /^\d{1,20}$/.test(value.internalDate)
    ? value.internalDate
    : null;
  return {
    id: value.id,
    threadId,
    labelIds,
    snippet: cleanGmailText(value.snippet, 1000),
    internalDate,
    headers: gmailHeaders(value.payload)
  };
}

function decodeGmailPartData(value) {
  if (typeof value !== 'string' || !value || value.length > GMAIL_BODY_MAX_CHARS * 2
    || !/^[A-Za-z0-9_-]+$/.test(value)) return '';
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8')
      .replace(/\u0000/g, '')
      .slice(0, GMAIL_BODY_MAX_CHARS);
  } catch {
    return '';
  }
}

function gmailPayloadText(payload) {
  let plain = '';
  let html = '';
  const visit = (part, depth = 0) => {
    if (!part || depth > 20 || plain) return;
    const mimeType = String(part.mimeType || '').toLowerCase();
    const decoded = decodeGmailPartData(part?.body?.data);
    if (decoded && mimeType === 'text/plain') plain = decoded;
    else if (decoded && mimeType === 'text/html' && !html) html = decoded;
    for (const child of Array.isArray(part.parts) ? part.parts.slice(0, 200) : []) visit(child, depth + 1);
  };
  visit(payload);
  if (plain) return cleanGmailText(plain, GMAIL_BODY_MAX_CHARS);
  if (!html) return '';
  // Gmail HTML is never inserted as markup in the renderer. This fallback is
  // deliberately converted to bounded plain text before crossing IPC.
  return cleanGmailText(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n'), GMAIL_BODY_MAX_CHARS);
}

function normalizeGmailMessage(value, { includeBody = false } = {}) {
  const metadata = normalizeGmailMessageMetadata(value);
  if (!metadata) return null;
  return includeBody
    ? { ...metadata, bodyText: gmailPayloadText(value.payload), bodyTruncated: Boolean(value?.payload?.body?.size > GMAIL_BODY_MAX_CHARS) }
    : metadata;
}

async function readBoundedJson(response, maxBytes, errorCode) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 0 || declared > maxBytes)) throw new Error(errorCode);
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(errorCode);
    try { return JSON.parse(text); } catch { throw new Error(errorCode); }
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    total += chunk.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(errorCode); } catch { /* best effort */ }
      throw new Error(errorCode);
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw new Error(errorCode); }
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
  // Optional dedicated REAL Chrome profile. When provided, the Google
  // services consent ceremony uses it as the RFC 8252 external user-agent
  // instead of the default system browser. The one-shot loopback callback
  // still returns only the authorization code to this main process, so the
  // verified app identity is unchanged - but real Google website cookies now
  // also live in that Chrome profile. No cookies are copied into Yayra.
  // Signature: (authorizationUrl, profileId) => { ok: boolean }.
  openGoogleAuthorization = null,
  // Signature: (googleUrl, profileId) => { ok: boolean }. Opens a Google
  // product in that same dedicated Chrome profile so it is genuinely signed
  // in. Optional; falls back to the OS browser when absent.
  openGoogleProductInChromeProfile = null,
  logger = console
}) {
  const signingInProfiles = new Set();

  function openAuthorizationUrl(url, profileId) {
    if (typeof openGoogleAuthorization === 'function') {
      try {
        const result = openGoogleAuthorization(url, profileId);
        if (result?.ok) return;
        // Fall through to the OS external user-agent when the dedicated
        // Chrome is unavailable; RFC 8252 is still satisfied.
      } catch { /* fall through */ }
    }
    return shell.openExternal(url);
  }

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
      const saved = storeForProfile(profileId).save({ profile, tokens });
      const savedAt = saved?.savedAt || null;
      send('signed-in', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
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
      return { ok: true, profile, ...(savedAt ? { savedAt } : {}) };
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
      const saved = storeForProfile(profileId).save({ profile, tokens: scopedTokens });
      const savedAt = saved?.savedAt || null;
      send('signed-in', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      send('drive-connected', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      const matchingWindow = firstWindowForProfile(profileId);
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : (matchingWindow || (!event?.sender ? getMainWindow?.() : null));
      try { win?.show?.(); win?.focus?.(); } catch { /* best effort */ }
      return { ok: true, profile, ...(savedAt ? { savedAt } : {}) };
    } catch (err) {
      const message = err?.message || String(err);
      logger?.error?.(`[yayra:drive] connection failed: ${message}`);
      send('drive-error', { message }, requestWindow, profileId);
      return { ok: false, error: message };
    } finally {
      signingInProfiles.delete(profileId);
    }
  }

  async function handleConnectGmail(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    if (signingInProfiles.has(profileId)) return { ok: false, error: 'sign_in_already_in_progress' };
    if (!clientId || !clientSecret || typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    signingInProfiles.add(profileId);
    const requestWindow = resolveRequestWindow(event);
    send('gmail-connecting', {}, requestWindow, profileId);
    try {
      const { profile, tokens } = await signInImpl({
        clientId,
        clientSecret,
        scopes: ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE],
        openExternal: (url) => shell.openExternal(url),
        fetchImpl,
        logger
      });
      const scopedTokens = {
        ...tokens,
        scope: typeof tokens?.scope === 'string' && tokens.scope
          ? tokens.scope
          : `openid email profile ${GMAIL_READONLY_SCOPE}`,
        obtained_at_ms: Date.now()
      };
      if (!tokenScopes(scopedTokens).has(GMAIL_READONLY_SCOPE)) throw new Error('gmail_scope_not_granted');
      const previous = storeForProfile(profileId).load();
      if (previous?.profile?.sub === profile?.sub && !scopedTokens.refresh_token && previous?.tokens?.refresh_token) {
        scopedTokens.refresh_token = previous.tokens.refresh_token;
      }
      const saved = storeForProfile(profileId).save({ profile, tokens: scopedTokens });
      const savedAt = saved?.savedAt || null;
      send('signed-in', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      send('gmail-connected', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      const matchingWindow = firstWindowForProfile(profileId);
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : (matchingWindow || (!event?.sender ? getMainWindow?.() : null));
      try { win?.show?.(); win?.focus?.(); } catch { /* best effort */ }
      return { ok: true, profile, ...(savedAt ? { savedAt } : {}) };
    } catch (err) {
      const message = err?.message || String(err);
      logger?.error?.(`[yayra:gmail] connection failed: ${message}`);
      send('gmail-error', { message }, requestWindow, profileId);
      return { ok: false, error: message };
    } finally {
      signingInProfiles.delete(profileId);
    }
  }

  async function handleConnectGoogleServices(event, payload = {}) {
    const profileId = resolveProfileId(event, payload);
    if (signingInProfiles.has(profileId)) return { ok: false, error: 'sign_in_already_in_progress' };
    if (!clientId || !clientSecret || typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    signingInProfiles.add(profileId);
    const requestWindow = resolveRequestWindow(event);
    send('google-services-connecting', {}, requestWindow, profileId);
    try {
      const { profile, tokens } = await signInImpl({
        clientId,
        clientSecret,
        scopes: GOOGLE_SERVICES_SCOPES,
        // Use Yayra's dedicated real Chrome profile as the external
        // user-agent when available. One sign-in then yields BOTH the
        // verified app identity (loopback callback) and genuinely usable
        // Google website cookies (in that Chrome profile).
        openExternal: (url) => openAuthorizationUrl(url, profileId),
        fetchImpl,
        logger
      });
      const grantedScopes = new Set(String(tokens?.scope || '').split(/\s+/).filter(Boolean));
      const serviceScopes = GOOGLE_SERVICE_SCOPES.filter((scope) => grantedScopes.has(scope));
      if (!serviceScopes.length) throw new Error('google_services_scope_not_granted');
      const scopedTokens = {
        ...tokens,
        scope: typeof tokens?.scope === 'string' && tokens.scope ? tokens.scope : GOOGLE_SERVICES_SCOPES.join(' '),
        obtained_at_ms: Date.now()
      };
      const previous = storeForProfile(profileId).load();
      if (previous?.profile?.sub === profile?.sub && !scopedTokens.refresh_token && previous?.tokens?.refresh_token) {
        scopedTokens.refresh_token = previous.tokens.refresh_token;
      }
      const saved = storeForProfile(profileId).save({ profile, tokens: scopedTokens });
      const savedAt = saved?.savedAt || null;
      send('signed-in', { profile, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      send('google-services-connected', { profile, grantedScopes: serviceScopes, ...(savedAt ? { savedAt } : {}) }, requestWindow, profileId);
      const matchingWindow = firstWindowForProfile(profileId);
      const win = requestWindow && !requestWindow.isDestroyed?.()
        ? requestWindow
        : (matchingWindow || (!event?.sender ? getMainWindow?.() : null));
      try { win?.show?.(); win?.focus?.(); } catch { /* best effort */ }
      return { ok: true, profile, grantedScopes: serviceScopes, ...(savedAt ? { savedAt } : {}) };
    } catch (err) {
      const message = err?.message || String(err);
      logger?.error?.(`[yayra:google-services] connection failed: ${message}`);
      send('google-services-error', { message }, requestWindow, profileId);
      return { ok: false, error: message };
    } finally {
      signingInProfiles.delete(profileId);
    }
  }

  async function usableGoogleServicesSession(profileId) {
    const store = storeForProfile(profileId);
    const session = store.load();
    const scopes = tokenScopes(session?.tokens);
    const firstGranted = GOOGLE_SERVICE_SCOPES.find((scope) => scopes.has(scope));
    if (!session?.profile || !firstGranted) throw new Error('google_services_reconnect_required');
    return usableScopedSession(profileId, firstGranted, 'google_services_reconnect_required');
  }

  async function handleGetGoogleServiceItems(event, { serviceId, profileId: claimedProfileId } = {}) {
    const profileId = resolveProfileId(event, { profileId: claimedProfileId });
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    if (typeof serviceId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(serviceId)) return { ok: false, error: 'invalid_google_service' };
    try {
      const catalog = await serviceCatalogPromise;
      const service = catalog.googleServiceById(serviceId);
      if (!service) return { ok: false, error: 'invalid_google_service' };
      if (!service.api) return { ok: true, items: [], count: 0, truncated: false };
      const session = await usableGoogleServicesSession(profileId);
      const grantedScopes = tokenScopes(session.tokens);
      if (service.scope && !grantedScopes.has(service.scope)) return { ok: false, error: 'service_scope_required', scope: service.scope };
      const apiUrl = catalog.googleServiceApiUrl(serviceId, Date.now());
      if (!apiUrl) return { ok: false, error: 'invalid_google_service' };
      const response = await fetchImpl(apiUrl, {
        headers: { Authorization: `Bearer ${session.tokens.access_token}`, Accept: 'application/json' }
      });
      if (response.status === 401) throw new Error('google_services_reconnect_required');
      if (response.status === 403) return { ok: false, error: 'google_service_permission_denied' };
      if (!response.ok) return { ok: false, error: 'google_service_upstream_failed' };
      const payload = await readBoundedJson(response, 1024 * 1024, 'google_service_response_too_large');
      const normalized = catalog.normalizeGoogleServiceItems(serviceId, payload);
      return { ok: true, ...normalized };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function usableScopedSession(profileId, requiredScope, reconnectError) {
    const store = storeForProfile(profileId);
    const session = store.load();
    if (!session?.profile || !session.tokens || !tokenScopes(session.tokens).has(requiredScope)) {
      throw new Error(reconnectError);
    }
    const tokens = { ...session.tokens };
    const obtainedAt = Number(tokens.obtained_at_ms);
    const expiresIn = Number(tokens.expires_in);
    const expiresAt = Number.isFinite(obtainedAt) && Number.isFinite(expiresIn)
      ? obtainedAt + expiresIn * 1000
      : Number.POSITIVE_INFINITY;
    if (expiresAt > Date.now() + 60_000) return { ...session, tokens };
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error(reconnectError);
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
    if (!response.ok) throw new Error(reconnectError);
    const refreshed = await response.json();
    if (typeof refreshed?.access_token !== 'string' || !refreshed.access_token
      || refreshed.access_token.length > 8192 || /[\u0000-\u0020\u007f]/.test(refreshed.access_token)) {
      throw new Error(reconnectError);
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

  async function usableDriveSession(profileId) {
    return usableScopedSession(profileId, DRIVE_READONLY_SCOPE, 'drive_reconnect_required');
  }

  async function usableGmailSession(profileId) {
    return usableScopedSession(profileId, GMAIL_READONLY_SCOPE, 'gmail_reconnect_required');
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

  async function handleListGmailMessages(event, {
    profileId: claimedProfileId,
    query = '',
    pageToken = '',
    maxResults = 25
  } = {}) {
    const profileId = resolveProfileId(event, { profileId: claimedProfileId });
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    const cleanQuery = typeof query === 'string' && query.length <= 500 && !/[\u0000-\u001f\u007f]/.test(query)
      ? query.trim()
      : null;
    const cleanPageToken = pageToken === ''
      ? ''
      : (typeof pageToken === 'string' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(pageToken) ? pageToken : null);
    const count = Number(maxResults);
    if (cleanQuery === null || cleanPageToken === null || !Number.isInteger(count)
      || count < 1 || count > GMAIL_LIST_MAX_RESULTS) {
      return { ok: false, error: 'invalid_gmail_list_request' };
    }
    try {
      const session = await usableGmailSession(profileId);
      const params = new URLSearchParams({ maxResults: String(count) });
      if (cleanQuery) params.set('q', cleanQuery);
      if (cleanPageToken) params.set('pageToken', cleanPageToken);
      const authorization = { Authorization: `Bearer ${session.tokens.access_token}`, Accept: 'application/json' };
      const listResponse = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: authorization });
      if (!listResponse.ok) {
        if (listResponse.status === 401 || listResponse.status === 403) throw new Error('gmail_reconnect_required');
        throw new Error('gmail_list_failed');
      }
      const list = await readBoundedJson(listResponse, 256 * 1024, 'gmail_response_too_large');
      const ids = (Array.isArray(list?.messages) ? list.messages : [])
        .map((message) => message?.id)
        .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id))
        .slice(0, count);
      const details = await Promise.all(ids.map(async (id) => {
        const detailParams = new URLSearchParams({
          format: 'metadata',
          metadataHeaders: 'Subject'
        });
        detailParams.append('metadataHeaders', 'From');
        detailParams.append('metadataHeaders', 'To');
        detailParams.append('metadataHeaders', 'Date');
        const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${detailParams}`, {
          headers: authorization
        });
        if (response.status === 401 || response.status === 403) throw new Error('gmail_reconnect_required');
        if (!response.ok) return null;
        return normalizeGmailMessageMetadata(await readBoundedJson(response, 256 * 1024, 'gmail_response_too_large'));
      }));
      const nextPageToken = typeof list?.nextPageToken === 'string'
        && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(list.nextPageToken)
        ? list.nextPageToken
        : null;
      return {
        ok: true,
        messages: details.filter(Boolean),
        nextPageToken,
        resultSizeEstimate: Number.isSafeInteger(Number(list?.resultSizeEstimate))
          ? Math.max(0, Number(list.resultSizeEstimate))
          : null
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleGetGmailMessage(event, { messageId, profileId: claimedProfileId } = {}) {
    const profileId = resolveProfileId(event, { profileId: claimedProfileId });
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'not_configured' };
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) {
      return { ok: false, error: 'invalid_gmail_message_id' };
    }
    try {
      const session = await usableGmailSession(profileId);
      const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, {
        headers: { Authorization: `Bearer ${session.tokens.access_token}`, Accept: 'application/json' }
      });
      if (response.status === 401 || response.status === 403) throw new Error('gmail_reconnect_required');
      if (response.status === 404) throw new Error('gmail_message_not_found');
      if (!response.ok) throw new Error('gmail_message_failed');
      const message = normalizeGmailMessage(await readBoundedJson(response, 6 * 1024 * 1024, 'gmail_response_too_large'), { includeBody: true });
      if (!message) throw new Error('gmail_message_malformed');
      return { ok: true, message };
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
    const scopes = tokenScopes(session.tokens);
    const grantedScopes = GOOGLE_SERVICE_SCOPES.filter((scope) => scopes.has(scope));
    const result = { signedIn: true, profile: session.profile, savedAt: session.savedAt };
    return grantedScopes.length
      ? { ...result, servicesConnected: true, scopes: grantedScopes }
      : result;
  }

  /**
   * Opens one hardcoded Google account-management URL in the system browser.
   * This is not a generic renderer-controlled external-URL capability, and no
   * browser cookies or bearer credentials are copied back into Yayra.
   */
  async function handleOpenAccountPage(event, payload = {}) {
    const url = 'https://myaccount.google.com/';
    try {
      if (payload?.useChromeProfile !== false && typeof openGoogleProductInChromeProfile === 'function') {
        const result = openGoogleProductInChromeProfile(url, resolveProfileId(event, payload));
        if (result?.ok) return { ok: true, chromeProfile: true };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger?.error?.(`[yayra:auth] failed to open Google account page: ${message}`);
      return { ok: false, error: message };
    }
  }

  async function handleOpenGoogleProduct(event, { origin, useChromeProfile } = {}) {
    const safeOrigin = normalizeGoogleProductOrigin(origin);
    if (!safeOrigin) return { ok: false, error: 'invalid_google_product_origin' };
    try {
      // Google products opened from the services hub go to the dedicated real
      // Chrome profile (where the user is genuinely signed in) when available.
      if (useChromeProfile !== false && typeof openGoogleProductInChromeProfile === 'function') {
        const result = openGoogleProductInChromeProfile(safeOrigin, resolveProfileId(event, {}));
        if (result?.ok) return { ok: true, chromeProfile: true };
      }
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
  ipcMain.handle('yayra:auth-connect-gmail', handleConnectGmail);
  ipcMain.handle('yayra:auth-connect-google-services', handleConnectGoogleServices);
  ipcMain.handle('yayra:auth-get-google-service-items', handleGetGoogleServiceItems);
  ipcMain.handle('yayra:auth-list-gmail-messages', handleListGmailMessages);
  ipcMain.handle('yayra:auth-get-gmail-message', handleGetGmailMessage);
  ipcMain.handle('yayra:auth-sign-out', handleSignOut);
  ipcMain.handle('yayra:auth-get-session', handleGetSession);
  ipcMain.handle('yayra:auth-open-account-page', handleOpenAccountPage);
  ipcMain.handle('yayra:auth-open-google-product', handleOpenGoogleProduct);

  return {
    handleSignIn,
    handleConnectDrive,
    handleDownloadDriveFile,
    handleConnectGmail,
    handleConnectGoogleServices,
    handleGetGoogleServiceItems,
    handleListGmailMessages,
    handleGetGmailMessage,
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
  normalizeAuthProfileId,
  normalizeGmailMessageMetadata,
  normalizeGmailMessage,
  GMAIL_READONLY_SCOPE
};
