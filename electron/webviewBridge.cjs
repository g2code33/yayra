'use strict';

const { popupMenuWithRecovery } = require('./nativeMenuGuard.cjs');
const { buildMediaCompatibilityScript, installMediaCompatibility } = require('./mediaCompatibility.cjs');
const {
  DEFAULT_PRIVACY_POLICY,
  sanitizePrivacyPolicy,
  hostnameFromUrl,
  upgradedHttpsUrl,
  isTrackerRequest,
  isUnsafeRequest,
  isThirdPartyRequest,
  applyPrivacyRequestHeaders,
  applyPrivacyResponseHeaders,
  permissionKey,
  policyDecisionForPermission
} = require('./privacyShield.cjs');
const {
  isGoogleAuthSurface,
  isGoogleSignInRejectedUrl,
  googleSignInFallbackUrl,
  isFirstPartyGoogleSignInUrl,
  isThirdPartyGoogleOAuthUrl,
  isGoogleAccountPortalUrl,
  applyGoogleAuthClientHints,
  safeGoogleDestination
} = require('./googleAuthParity.cjs');

/**
 * Yayra Floating Browser - Native Web Content Engine Bridge (Electron main process)
 *
 * ROOT CAUSE THIS FILE FIXES
 * --------------------------
 * The renderer UI (packages/shared-ui/src/components/BrowserShell.js) used to
 * render every visited website inside a plain HTML <iframe>. Real sites
 * (Google, GitHub, Facebook, ...) send X-Frame-Options / CSP frame-ancestors
 * headers that forbid ANY iframe embedding, so navigating to
 * https://www.google.com/ inside that iframe always failed with:
 *   "Refused to display 'https://www.google.com/' in a frame because it set
 *    'X-Frame-Options' to 'sameorigin'."
 * No amount of Yayra-side CSP configuration can override a restriction the
 * TARGET site itself enforces against iframes.
 *
 * The fix is architectural: on Electron (Linux + Windows desktop builds),
 * external websites are now rendered in a dedicated `WebContentsView`
 * (Electron's modern, non-deprecated replacement for `BrowserView`) attached
 * directly to the application window's content view, NOT nested inside the
 * HTML document as an <iframe>. A WebContentsView is a first-class sibling
 * surface, not a nested browsing context, so X-Frame-Options / frame-ancestors
 * never apply to it - the same mechanism every other desktop "browser shell"
 * app (and Electron's own official guidance for embedding arbitrary web
 * content) relies on.
 *
 * The HTML/CSS UI (tabs, address bar, buttons, floating window chrome) is
 * untouched; the renderer just tells this bridge where on screen to position
 * a transparent native layer for the active tab's real content.
 *
 * GOOGLE / IDENTITY PROVIDER AUTHENTICATION
 * -----------------------------------------
 * Google's OAuth policy and RFC 8252 prohibit authorization requests in an
 * embedded user agent (see
 * https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews).
 * A separate Electron BrowserWindow is still controlled by the app, so it is
 * not the OS external user-agent required by that policy. Yayra therefore
 * cancels recognized OAuth and interactive Google Account sign-in routes
 * before they enter a WebContentsView. Third-party OAuth requests continue in
 * the user's default secure browser. First-party Google Account entry/sign-in
 * instead requests Yayra's own Authorization Code + PKCE connection flow, so
 * the verified callback can actually update Yayra's account state rather than
 * abandoning the user on a dead embedded page. Browser cookies are never
 * copied or imported.
 *
 * This classifier is deliberately route-scoped to trusted Google account
 * entry points. Ordinary Search, Gmail content, logout, and other product
 * navigation are not hijacked. Apple and Microsoft retain the same external-
 * browser handoff. A third-party website's OAuth callback remains owned by
 * that website; Yayra's first-party identity callback returns only Yayra's
 * sanitized Google profile.
 */

// Identity-provider endpoints that cannot safely complete in an embedded
// page. Keep these exact predicates in sync with BrowserShell and Android.
const SYSTEM_BROWSER_AUTH_HOSTS = Object.freeze([
  'accounts.google.com',
  'appleid.apple.com',
  'login.live.com',
  'login.microsoftonline.com'
]);
const GOOGLE_OAUTH_PATH = /^\/(?:o\/oauth2(?:\/|$)|oauth2(?:\/|$)|signin\/oauth(?:\/|$)|gsi\/select(?:\/|$))/i;
const GOOGLE_INTERACTIVE_SIGNIN_PATH = /^\/(?:signin\/(?:v2|challenge|identifier|rejected)(?:\/|$)|v3\/signin(?:\/|$)|ServiceLogin(?:\/|$)|InteractiveLogin(?:\/|$)|AccountChooser(?:\/|$)|AddSession(?:\/|$))/i;
const GOOGLE_ACCOUNT_PORTAL_PATH = /^\/(?:ManageAccount(?:\/|$)|signin\/?$)?$/i;
const GOOGLE_REJECTED_SIGNIN_PATH = /^\/(?:signin\/rejected|v3\/signin\/rejected)(?:\/|$)/i;
const MAX_AUTH_HANDOFF_URL_LENGTH = 8192;
const DOWNLOAD_HANDOFF_GRACE_MS = 2_000;
const DOWNLOAD_HANDOFF_TTL_MS = 10_000;

/**
 * Google Drive turns authenticated /uc download navigations into a native
 * Content-Disposition handoff. Chromium reports that canceled document load
 * as ERR_FAILED (-2) even though the download is healthy. Keep the predicate
 * deliberately narrow so ordinary Drive page failures remain visible.
 */
function isGoogleDriveDownloadUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if ((host === 'drive.google.com' || host === 'docs.google.com') && path === '/uc') {
      return parsed.searchParams.get('export') === 'download' || parsed.searchParams.has('confirm');
    }
    return host === 'drive.usercontent.google.com'
      && (path === '/download' || path.startsWith('/download/'));
  } catch {
    return false;
  }
}

const WEBVIEW_EVENT_CHANNEL = 'yayra:webview-event';
const PAGE_UNRESPONSIVE_RELOAD_DELAY_MS = 15_000;
const PAGE_UNRESPONSIVE_RELOAD_COOLDOWN_MS = 60_000;
const EMAIL_FIELD_FOCUSED_CHANNEL = 'yayra:email-field-focused';
const EMAIL_ADDRESS_CAPTURED_CHANNEL = 'yayra:email-address-captured';
const EMAIL_SUGGESTIONS_CHANNEL = 'yayra:email-suggestions';
// Main-world WebAuthn observer -> isolated page preload -> this bridge.
// Payloads contain only RP/action/status metadata, never challenges, user
// handles, credential IDs, authenticator data, or signatures.
const SITE_PASSKEY_REQUEST_CHANNEL = 'yayra:site-passkey-request';
// Trusted main -> isolated preload -> capability-gated main-world observer.
// This arms/cancels the native call without exposing ceremony data to chrome.
const SITE_PASSKEY_CONTROL_CHANNEL = 'yayra:site-passkey-control';
// Once Yayra has released a verified native request, it should settle almost
// immediately. This bound is deliberately shorter than the provider's UP/UV
// window; a broken Chromium/site exchange is aborted instead of leaving
// “Completing passkey” on screen forever.
const SITE_PASSKEY_COMPLETION_TIMEOUT_MS = 20_000;

function sanitizeEmailAddress(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at >= email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  if (domain.split('.').some((label) => !label || label.length > 63)) return null;
  return email;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

// Sentinel pseudo-scheme the in-page WebAuthn helper uses to ask the main
// process to open the CURRENT page in the user's default system browser
// (window.open with this scheme -> setWindowOpenHandler below). Only
// http(s) targets are honored.
const OPEN_EXTERNAL_SCHEME = 'yayra-openexternal://';

/**
 * Decodes a `yayra-openexternal://<encodeURIComponent(url)>` request from
 * the in-page WebAuthn helper. Returns the decoded http(s) URL, or null
 * for anything else (wrong scheme, non-web target like javascript:/file:,
 * malformed encoding) - this is a security gate, not just parsing.
 */
function decodeOpenExternalRequest(url) {
  if (typeof url !== 'string' || !url.startsWith(OPEN_EXTERNAL_SCHEME)) return null;
  try {
    const target = decodeURIComponent(url.slice(OPEN_EXTERNAL_SCHEME.length));
    return /^https?:\/\//i.test(target) ? target : null;
  } catch (_err) {
    return null;
  }
}

const YAYRA_GOOGLE_ACCOUNT_ELEMENT_ID = 'yayra-google-service-account';
const YAYRA_GOOGLE_ACCOUNT_STATE = '__yayraGoogleServicesAccountV1';

function isGoogleProductHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'google.com' || host.endsWith('.google.com')
    || host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'blogger.com' || host.endsWith('.blogger.com');
}

function sanitizeGoogleServiceAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const email = String(value.email || '').trim().toLowerCase();
  const name = String(value.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return { email, name: name.slice(0, 100) };
}

function buildGoogleServiceAccountScript(profile) {
  const account = sanitizeGoogleServiceAccount(profile);
  if (!account) {
    return `(function(){try{document.getElementById(${JSON.stringify(YAYRA_GOOGLE_ACCOUNT_ELEMENT_ID)})?.remove();delete window[${JSON.stringify(YAYRA_GOOGLE_ACCOUNT_STATE)}];}catch(_err){}})();`;
  }
  const email = JSON.stringify(account.email);
  const name = JSON.stringify(account.name || account.email);
  const elementId = JSON.stringify(YAYRA_GOOGLE_ACCOUNT_ELEMENT_ID);
  const stateKey = JSON.stringify(YAYRA_GOOGLE_ACCOUNT_STATE);
  return `(function(){
  try {
    var host = String(location.hostname || '').toLowerCase();
    var googleHost = host === 'google.com' || /\\.google\\.com$/.test(host) || host === 'youtube.com' || /\\.youtube\\.com$/.test(host) || /\\.blogger\\.com$/.test(host);
    if (!googleHost) return;
    var email = ${email};
    var name = ${name};
    var id = ${elementId};
    var stateKey = ${stateKey};
    window[stateKey] = { connected: true, email: email, name: name, source: 'yayra-oauth' };
    var apply = function () {
      var root = document.getElementById(id);
      if (!root) {
        root = document.createElement('div');
        root.id = id;
        root.setAttribute('role', 'status');
        root.setAttribute('aria-label', 'Yayra Google account ' + email);
        root.style.cssText = 'position:fixed;top:10px;right:14px;z-index:2147483646;display:flex;align-items:center;gap:8px;max-width:min(420px,calc(100vw - 28px));padding:8px 12px;border-radius:999px;border:1px solid rgba(138,180,248,.55);background:rgba(20,28,42,.94);color:#f7f9fc;font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.28);pointer-events:auto;';
        var shield = document.createElement('span');
        shield.textContent = '◆';
        shield.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#1a73e8;color:white;font-size:12px;';
        var text = document.createElement('span');
        text.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        text.textContent = email;
        var label = document.createElement('small');
        label.textContent = 'Yayra connected';
        label.style.cssText = 'color:#a8c7fa;font-weight:700;white-space:nowrap;';
        root.appendChild(shield);
        root.appendChild(text);
        root.appendChild(label);
        (document.body || document.documentElement).appendChild(root);
      }
      // Deliberately do NOT rewrite Google's own Sign in button, avatar,
      // account menu, or DOM state. This strip reports only Yayra's verified
      // OAuth identity; the genuine Google website cookie session is owned by
      // the dedicated Chrome profile and may still be signed out in this tab.
    };
    apply();
    if (!window.__yayraGoogleAccountObserver) {
      var previous = window.__yayraGoogleAccountObserver;
      try { previous && previous.disconnect && previous.disconnect(); } catch (_err) {}
      if (typeof MutationObserver === 'function') {
        var observer = new MutationObserver(function () { apply(); });
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true, characterData: true });
        window.__yayraGoogleAccountObserver = observer;
      }
    }
  } catch (_err) {}
})();`;
}

const POINTER_STYLE_ID = 'yayra-custom-pointer-theme';
const POINTER_TEXT_CURSOR_ATTRIBUTE = 'data-yayra-selectable-text';
const POINTER_TEXT_CURSOR_STATE = '__yayraSelectableTextCursorState';
const TEXT_SELECTION_ACTIONS_STATE = '__yayraTextSelectionActionsState';

// Keep the Yayra shell and native website views aligned. Many sites put the
// actual hovered target (an SVG, icon, or text span) inside the control, so
// buildPointerThemeCss applies the hand cursor to both each control and all of
// its descendants.
const POINTER_INTERACTIVE_SELECTORS = Object.freeze([
  'a', 'area[href]', 'button',
  'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', 'input[type="image"]',
  'input[type="checkbox"]', 'input[type="radio"]', 'input[type="range"]', 'input[type="file"]', 'input[type="color"]',
  'select', 'option', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="slider"]', '[role="treeitem"]', '[role="gridcell"]',
  '[aria-haspopup]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
]);

/** Builds the same custom cursor rules for a native website view as the UI uses. */
function buildPointerThemeCss(theme, size = 'normal') {
  if (theme !== 'yayra' && theme !== 'high-visibility') return '';
  const normalizedSize = size === 'large' || size === 'xlarge' ? size : 'normal';
  const dimension = normalizedSize === 'xlarge' ? 48 : normalizedSize === 'large' ? 36 : 24;
  const scale = dimension / 24;
  const color = theme === 'yayra' ? '#6d5df2' : '#111a2e';
  const outline = theme === 'yayra' ? '#ffffff' : '#ffd400';
  const arrowStroke = (theme === 'yayra' ? 1.6 : 2.4) / scale;
  const handStroke = (theme === 'yayra' ? 1.6 : 2.4) / scale;
  const arrowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 24 24"><path d="M5 2l14 10-6 1 3.5 7-2.6 1.2L10.5 14 5 18z" fill="${color}" stroke="${outline}" stroke-width="${arrowStroke}" stroke-linejoin="round"/></svg>`;
  const handSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 24 24"><path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V10l4.6.9c1.1.2 1.9 1.2 1.9 2.3v3.3c0 2.5-2 4.5-4.5 4.5h-3.4c-1.3 0-2.6-.6-3.4-1.7L4 15.5c-.6-.9-.4-2 .5-2.6.8-.5 1.9-.3 2.5.5l2 2.6z" fill="${color}" stroke="${outline}" stroke-width="${handStroke}" stroke-linejoin="round"/></svg>`;
  const arrowHotspot = `${Math.round(4 * scale)} ${Math.round(2 * scale)}`;
  const handHotspot = `${Math.round(9 * scale)} ${Math.round(2 * scale)}`;
  const arrowCursor = `url("data:image/svg+xml,${encodeURIComponent(arrowSvg)}") ${arrowHotspot}, auto`;
  const handCursor = `url("data:image/svg+xml,${encodeURIComponent(handSvg)}") ${handHotspot}, pointer`;
  const interactiveSelector = `:where(${POINTER_INTERACTIVE_SELECTORS.join(', ')})`;
  // :not(html) gives the hand rule the same specificity as body * in the
  // arrow rule, allowing it to win by source order without overpowering the
  // native I-beam rules on text inputs.
  const handTargetSelector = `${interactiveSelector}:not(html)`;

  return [
    `html, body, body * { cursor: ${arrowCursor} !important; }`,
    `${handTargetSelector}, ${handTargetSelector} * { cursor: ${handCursor} !important; }`,
    `input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="password"], input[type="number"], input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"], input[type="week"], textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"] { cursor: text !important; }`,
    // The pointer-move helper marks only selectable, non-interactive text
    // under the actual hit point. Use the native I-beam and preserve normal
    // drag selection, even when a site styles its content with user-select:none.
    `[${POINTER_TEXT_CURSOR_ATTRIBUTE}="true"] { cursor: text !important; user-select: text !important; -webkit-user-select: text !important; }`
  ].join('\n');
}

/**
 * Best-effort page-owned fallback for frame APIs that do not support
 * user-origin CSS insertion. It is nonce-aware and resilient to navigation,
 * route changes and a site's own DOM replacing its <head>.
 */
function buildPointerThemeScript(theme, size = 'normal') {
  const normalizedTheme = theme === 'yayra' || theme === 'high-visibility' ? theme : 'system';
  if (normalizedTheme === 'system') {
    return `(function () { try { window.__yayraPointerThemeObserver?.disconnect(); delete window.__yayraPointerThemeObserver; document.getElementById(${JSON.stringify(POINTER_STYLE_ID)})?.remove(); } catch (_err) {} })();`;
  }
  const css = buildPointerThemeCss(normalizedTheme, size);
  return `(function () {
    try {
      var id = ${JSON.stringify(POINTER_STYLE_ID)};
      var css = ${JSON.stringify(css)};
      try { window.__yayraPointerThemeObserver?.disconnect(); } catch (_err) {}
      var install = function () {
        var root = document.documentElement;
        if (!root) return;
        var style = document.getElementById(id);
        if (!style) { style = document.createElement('style'); style.id = id; }
        var nonceNode = document.querySelector('style[nonce],script[nonce]');
        var nonce = nonceNode && (nonceNode.nonce || nonceNode.getAttribute('nonce'));
        if (nonce) style.setAttribute('nonce', nonce);
        if (style.textContent !== css) style.textContent = css;
        var parent = document.head || root;
        if (style.parentNode !== parent) parent.appendChild(style);
      };
      install();
      if (typeof MutationObserver === 'function' && document.documentElement) {
        var observer = new MutationObserver(install);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__yayraPointerThemeObserver = observer;
      }
    } catch (_err) { /* some pages lock down DOM mutation; keep the site usable */ }
  })();`;
}

/**
 * Custom arrows normally hide Chromium's context-sensitive I-beam. This
 * page-local helper restores it only when the hit-tested point is over real
 * selectable text outside an interactive control. Pointerdown marks the text
 * synchronously so native drag-to-select starts with user-select enabled.
 */
function buildPointerTextCursorScript(theme) {
  const enabled = theme === 'yayra' || theme === 'high-visibility';
  const stateKey = JSON.stringify(POINTER_TEXT_CURSOR_STATE);
  const attribute = JSON.stringify(POINTER_TEXT_CURSOR_ATTRIBUTE);
  if (!enabled) {
    return `(function () { try { window[${stateKey}]?.cleanup?.(); } catch (_err) {} })();`;
  }
  const interactiveSelector = JSON.stringify(POINTER_INTERACTIVE_SELECTORS.join(', '));
  return `(function () {
    try {
      var stateKey = ${stateKey};
      var attribute = ${attribute};
      var interactiveSelector = ${interactiveSelector};
      try { window[stateKey]?.cleanup?.(); } catch (_err) {}
      var current = null;
      var pending = false;
      var scheduledFrame = null;
      var latestPoint = null;
      var clear = function () {
        if (current) { try { current.removeAttribute(attribute); } catch (_err) {} }
        current = null;
      };
      var isInteractive = function (target) {
        var element = target && target.nodeType === 1 ? target : target && target.parentElement;
        try {
          while (element) {
            if (element.closest && element.closest(interactiveSelector)) return true;
            var root = element.getRootNode && element.getRootNode();
            element = root && root.host ? root.host : null;
          }
        } catch (_err) { return false; }
        return false;
      };
      var textElementAt = function (x, y) {
        var range = null;
        try {
          if (typeof document.caretRangeFromPoint === 'function') {
            range = document.caretRangeFromPoint(x, y);
          } else if (typeof document.caretPositionFromPoint === 'function') {
            var position = document.caretPositionFromPoint(x, y);
            if (position && position.offsetNode) {
              range = document.createRange();
              range.setStart(position.offsetNode, position.offset);
              range.collapse(true);
            }
          }
        } catch (_err) { range = null; }
        var node = range && range.startContainer;
        if (!node || node.nodeType !== 3 || !String(node.nodeValue || '').trim()) return null;
        var element = node.parentElement;
        if (!element || isInteractive(element)) return null;
        try {
          var check = document.createRange();
          check.selectNodeContents(node);
          var rects = check.getClientRects();
          var hit = false;
          for (var i = 0; i < rects.length; i += 1) {
            var rect = rects[i];
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) { hit = true; break; }
          }
          if (!hit) return null;
        } catch (_err) { return null; }
        return element;
      };
      var update = function (point) {
        var next = textElementAt(point.x, point.y);
        if (next === current) return;
        clear();
        if (next) {
          try { next.setAttribute(attribute, 'true'); current = next; } catch (_err) {}
        }
      };
      var onMove = function (event) {
        if (!event) { clear(); return; }
        // Touch has no visible cursor, but pointerdown must still opt the text
        // into user-select before the native long-press/highlight gesture.
        if (event.pointerType === 'touch' && event.type !== 'pointerdown') return;
        if (isInteractive(event.target)) { latestPoint = null; clear(); return; }
        latestPoint = { x: event.clientX, y: event.clientY };
        if (event.type === 'pointerdown') { update(latestPoint); return; }
        if (pending) return;
        pending = true;
        var run = function () {
          pending = false;
          scheduledFrame = null;
          var point = latestPoint;
          latestPoint = null;
          if (point) update(point);
        };
        if (typeof window.requestAnimationFrame === 'function') scheduledFrame = window.requestAnimationFrame(run);
        else scheduledFrame = setTimeout(run, 16);
      };
      var onPointerOut = function (event) { if (!event.relatedTarget) clear(); };
      var cleanup = function () {
        if (scheduledFrame !== null) {
          if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(scheduledFrame);
          else clearTimeout(scheduledFrame);
          scheduledFrame = null;
        }
        pending = false;
        latestPoint = null;
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('pointerdown', onMove, true);
        document.removeEventListener('pointerout', onPointerOut, true);
        window.removeEventListener('blur', clear, true);
        clear();
        try { delete window[stateKey]; } catch (_err) { window[stateKey] = null; }
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('pointerdown', onMove, true);
      document.addEventListener('pointerout', onPointerOut, true);
      window.addEventListener('blur', clear, true);
      window[stateKey] = { cleanup: cleanup };
    } catch (_err) { /* cursor enhancement is best-effort; never block page interaction */ }
  })();`;
}

/**
 * Builds a self-contained, page-local text-selection toolbar for native
 * website surfaces. Selection text never crosses IPC: Copy/Cut stay in the
 * guest page, and Search/Ask AI leave only after an explicit button click via
 * the existing new-window routing. Password fields and unbounded selections
 * are deliberately excluded.
 */
function buildTextSelectionActionsScript() {
  const stateKey = JSON.stringify(TEXT_SELECTION_ACTIONS_STATE);
  return `(function () {
    try {
      var stateKey = ${stateKey};
      try { window[stateKey]?.cleanup?.(); } catch (_err) {}
      var toolbar = null;
      var toolbarSnapshot = null;
      var pointerSelecting = false;
      var updateHandle = null;
      var dismissedSignature = '';
      var nodeIds = typeof WeakMap === 'function' ? new WeakMap() : null;
      var nextNodeId = 0;
      var MAX_COPY = 100000;
      var MAX_QUERY = 2000;
      var listeners = [];
      var nodeId = function (node) {
        if (!node || !nodeIds) return '0';
        var current = nodeIds.get(node);
        if (!current) { current = String(++nextNodeId); nodeIds.set(node, current); }
        return current;
      };
      var bind = function (target, type, listener, options) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, listener, options);
        listeners.push([target, type, listener, options]);
      };
      var selectedField = function () {
        var field = document.activeElement;
        if (!field || (field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA') || field.disabled || field.readOnly) return null;
        var type = String(field.type || field.getAttribute('type') || 'text').toLowerCase();
        if (field.tagName === 'INPUT' && ['password','hidden','checkbox','radio','button','submit','reset','file','image','range','color'].indexOf(type) >= 0) return null;
        return typeof field.selectionStart === 'number' && typeof field.selectionEnd === 'number' ? field : null;
      };
      var readSnapshot = function () {
        var field = selectedField();
        if (field && field.selectionEnd > field.selectionStart) {
          var fieldText = String(field.value || '').slice(field.selectionStart, field.selectionEnd);
          if (!fieldText.trim() || fieldText.length > MAX_COPY) return null;
          return {
            kind: 'field', text: fieldText, editable: true, field: field,
            start: field.selectionStart, end: field.selectionEnd,
            rect: field.getBoundingClientRect()
          };
        }
        var selection = null;
        try { selection = window.getSelection(); } catch (_err) { selection = null; }
        if (!selection || selection.isCollapsed || selection.rangeCount < 1) return null;
        var text = String(selection || '');
        if (!text.trim() || text.length > MAX_COPY) return null;
        var range;
        try { range = selection.getRangeAt(selection.rangeCount - 1); } catch (_err) { return null; }
        var element = range.commonAncestorContainer;
        if (element && element.nodeType !== 1) element = element.parentElement || element.parentNode;
        if (toolbar && toolbar.contains(element)) return null;
        var editableRoot = null;
        try { editableRoot = element && element.closest ? element.closest('[contenteditable]:not([contenteditable="false"])') : null; } catch (_err) {}
        if (!editableRoot && element && element.isContentEditable) editableRoot = element;
        var rect = null;
        try {
          rect = range.getBoundingClientRect();
          if ((!rect || (!rect.width && !rect.height)) && range.getClientRects) rect = range.getClientRects()[0] || rect;
        } catch (_err) {}
        return {
          kind: 'range', text: text, editable: Boolean(editableRoot), editableRoot: editableRoot,
          range: range, rect: rect,
          anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode, focusOffset: selection.focusOffset
        };
      };
      var signature = function (snapshot) {
        if (!snapshot) return '';
        if (snapshot.kind === 'field') return 'f:' + nodeId(snapshot.field) + ':' + snapshot.start + ':' + snapshot.end + ':' + snapshot.text;
        return 'r:' + nodeId(snapshot.anchorNode) + ':' + snapshot.anchorOffset + ':' + nodeId(snapshot.focusNode) + ':' + snapshot.focusOffset + ':' + snapshot.text;
      };
      var hide = function (remember) {
        var snapshot = toolbarSnapshot || readSnapshot();
        if (remember && snapshot) dismissedSignature = signature(snapshot);
        try { toolbar?.remove(); } catch (_err) {}
        toolbar = null;
        toolbarSnapshot = null;
      };
      var important = function (element, rules) {
        Object.keys(rules).forEach(function (name) {
          try { element.style.setProperty(name, rules[name], 'important'); } catch (_err) {}
        });
      };
      var copyText = async function (snapshot) {
        try { if (document.execCommand && document.execCommand('copy')) return true; } catch (_err) {}
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(snapshot.text);
            return true;
          }
        } catch (_err) {}
        return false;
      };
      var cutText = async function (snapshot) {
        try { if (document.execCommand && document.execCommand('cut')) return true; } catch (_err) {}
        if (!(await copyText(snapshot))) return false;
        if (snapshot.kind === 'field') {
          if (typeof snapshot.field.setRangeText === 'function') snapshot.field.setRangeText('', snapshot.start, snapshot.end, 'end');
          else snapshot.field.value = String(snapshot.field.value || '').slice(0, snapshot.start) + String(snapshot.field.value || '').slice(snapshot.end);
          try { snapshot.field.dispatchEvent(new Event('input', { bubbles: true, inputType: 'deleteByCut' })); } catch (_err) {}
        } else {
          try { snapshot.range.deleteContents(); } catch (_err) {}
          try { snapshot.editableRoot?.dispatchEvent(new Event('input', { bubbles: true, inputType: 'deleteByCut' })); } catch (_err) {}
        }
        return true;
      };
      var pasteText = async function (snapshot) {
        var text = '';
        try {
          if (!navigator.clipboard || !navigator.clipboard.readText) return false;
          text = await navigator.clipboard.readText();
        } catch (_err) { return false; }
        if (!text) return false;
        if (snapshot.kind === 'field') {
          if (typeof snapshot.field.setRangeText === 'function') snapshot.field.setRangeText(text, snapshot.start, snapshot.end, 'end');
          else snapshot.field.value = String(snapshot.field.value || '').slice(0, snapshot.start) + text + String(snapshot.field.value || '').slice(snapshot.end);
          try { snapshot.field.dispatchEvent(new Event('input', { bubbles: true, inputType: 'insertFromPaste', data: text })); } catch (_err) {}
        } else {
          try {
            snapshot.range.deleteContents();
            var node = document.createTextNode(text);
            snapshot.range.insertNode(node);
            snapshot.range.setStartAfter(node);
            snapshot.range.collapse(true);
          } catch (_err) { return false; }
          try { snapshot.editableRoot?.dispatchEvent(new Event('input', { bubbles: true, inputType: 'insertFromPaste', data: text })); } catch (_err) {}
        }
        return true;
      };
      var openAction = function (url) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_err) {}
      };
      var applySelectionHighlight = function (snapshot, color) {
        try {
          if (snapshot.kind !== 'range' || !window.CSS?.highlights || !window.Highlight) return false;
          var name = 'yayra-selection-highlight';
          var highlight = window.CSS.highlights.get(name);
          if (!highlight) {
            highlight = new window.Highlight();
            window.CSS.highlights.set(name, highlight);
          }
          highlight.add(snapshot.range.cloneRange());
          if (!document.getElementById('yayra-selection-highlight-style')) {
            var style = document.createElement('style');
            style.id = 'yayra-selection-highlight-style';
            style.textContent = '::highlight(' + name + ') { background-color: ' + color + '; color: inherit; }';
            (document.head || document.documentElement).appendChild(style);
          }
          return true;
        } catch (_err) { return false; }
      };
      var addButton = function (parent, label, action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-label', label);
        important(button, {
          appearance: 'none', border: '0', 'border-radius': '7px', background: 'transparent', color: '#f8fafc',
          cursor: 'pointer', padding: '6px 10px', 'min-height': '30px', 'white-space': 'nowrap',
          font: '600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        });
        button.addEventListener('pointerdown', function (event) { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('mouseenter', function () { button.style.setProperty('background', 'rgba(255,255,255,.13)', 'important'); });
        button.addEventListener('mouseleave', function () { button.style.setProperty('background', 'transparent', 'important'); });
        button.addEventListener('click', function (event) {
          event.preventDefault(); event.stopPropagation();
          dismissedSignature = signature(toolbarSnapshot);
          hide(true);
          try { Promise.resolve(action()).catch(function () {}); } catch (_err) {}
        });
        parent.appendChild(button);
      };
      var show = function (snapshot) {
        if (!snapshot || signature(snapshot) === dismissedSignature) return;
        if (toolbarSnapshot && signature(toolbarSnapshot) === signature(snapshot) && toolbar && toolbar.isConnected) return;
        hide(false);
        var bar = document.createElement('div');
        bar.id = 'yayra-text-selection-actions';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Text selection actions');
        important(bar, {
          position: 'fixed', display: 'inline-flex', 'align-items': 'center', gap: '3px', 'z-index': '2147483647',
          padding: '4px', 'min-height': '38px', 'max-width': 'calc(100vw - 16px)', overflow: 'auto',
          border: '1px solid rgba(255,255,255,.18)', 'border-radius': '11px', background: 'rgba(24,26,33,.98)',
          color: '#f8fafc', 'box-shadow': '0 10px 32px rgba(0,0,0,.44)', 'user-select': 'none',
          '-webkit-user-select': 'none', 'white-space': 'nowrap', margin: '0', 'box-sizing': 'border-box'
        });
        bar.addEventListener('pointerdown', function (event) { event.preventDefault(); event.stopPropagation(); });
        toolbar = bar;
        toolbarSnapshot = snapshot;
        addButton(bar, 'Copy', function () { return copyText(snapshot); });
        if (snapshot.editable) {
          addButton(bar, 'Cut', function () { return cutText(snapshot); });
          addButton(bar, 'Paste', function () { return pasteText(snapshot); });
        }
        if (snapshot.text.length <= MAX_QUERY) {
          addButton(bar, 'Search', function () { openAction('https://www.google.com/search?q=' + encodeURIComponent(snapshot.text.trim())); });
          addButton(bar, 'Ask Yayra AI', function () { openAction('yayra://ai?q=' + encodeURIComponent(snapshot.text.trim())); });
          addButton(bar, 'Ask Yayra Dictionary', function () { openAction('yayra://dictionary?q=' + encodeURIComponent(snapshot.text.trim())); });
          addButton(bar, 'Highlight selection', function () {
            var safeSource = '';
            try {
              var sourceUrl = new URL(location.href);
              if ((sourceUrl.protocol === 'https:' || sourceUrl.protocol === 'http:') && !sourceUrl.username && !sourceUrl.password) safeSource = sourceUrl.origin + sourceUrl.pathname;
            } catch (_sourceError) {}
            var color = '#ffe08a';
            applySelectionHighlight(snapshot, color);
            var params = new URLSearchParams({
              text: snapshot.text.trim(),
              sourceUrl: safeSource.slice(0, 2000),
              sourceTitle: document.title.slice(0, 300),
              highlightColor: color
            });
            openAction('yayra://selection-highlight?' + params.toString());
          });
          addButton(bar, 'Save selection', function () {
            var safeSource = '';
            try {
              var sourceUrl = new URL(location.href);
              if ((sourceUrl.protocol === 'https:' || sourceUrl.protocol === 'http:') && !sourceUrl.username && !sourceUrl.password) safeSource = sourceUrl.origin + sourceUrl.pathname;
            } catch (_sourceError) {}
            var params = new URLSearchParams({ view: 'saved', save: snapshot.text.trim(), source: safeSource.slice(0, 2000), title: document.title.slice(0, 300) });
            openAction('yayra://dictionary?' + params.toString());
          });
        }
        (document.body || document.documentElement).appendChild(bar);
        var rect = snapshot.rect || {};
        var width = bar.offsetWidth || Math.min(390, window.innerWidth - 16);
        var height = bar.offsetHeight || 42;
        var center = Number.isFinite(rect.left) && Number.isFinite(rect.right) ? (rect.left + rect.right) / 2 : window.innerWidth / 2;
        var left = Math.max(8, Math.min(window.innerWidth - width - 8, center - width / 2));
        var top = (Number.isFinite(rect.top) ? rect.top : window.innerHeight / 2) - height - 10;
        if (top < 8) top = Math.min(window.innerHeight - height - 8, (Number(rect.bottom) || 8) + 10);
        bar.style.setProperty('left', Math.round(Math.max(8, left)) + 'px', 'important');
        bar.style.setProperty('top', Math.round(Math.max(8, top)) + 'px', 'important');
      };
      var update = function () {
        updateHandle = null;
        var snapshot = readSnapshot();
        if (!snapshot) { dismissedSignature = ''; hide(false); return; }
        show(snapshot);
      };
      var schedule = function () {
        if (pointerSelecting || updateHandle !== null) return;
        if (typeof window.requestAnimationFrame === 'function') updateHandle = window.requestAnimationFrame(update);
        else updateHandle = setTimeout(update, 0);
      };
      var onPointerDown = function (event) {
        if (toolbar && (event.target === toolbar || toolbar.contains(event.target))) return;
        hide(true);
        pointerSelecting = true;
      };
      var onPointerUp = function () { pointerSelecting = false; schedule(); };
      var onSelectionChange = function () { schedule(); };
      var onKeyDown = function (event) {
        if (event.key === 'Escape') { hide(true); return; }
        var key = String(event.key || '').toLowerCase();
        if (!(key === 'd' && (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey)) return;
        var snapshot = readSnapshot();
        var selected = String(snapshot?.text || '').trim().slice(0, MAX_QUERY);
        if (!selected) return;
        event.preventDefault(); event.stopPropagation();
        hide(true);
        openAction('yayra://dictionary?q=' + encodeURIComponent(selected));
      };
      var onScroll = function () { hide(true); };
      var cleanup = function () {
        if (updateHandle !== null) {
          try { window.cancelAnimationFrame?.(updateHandle); } catch (_err) {}
          try { clearTimeout(updateHandle); } catch (_err) {}
        }
        updateHandle = null;
        listeners.forEach(function (entry) { try { entry[0].removeEventListener(entry[1], entry[2], entry[3]); } catch (_err) {} });
        listeners = [];
        hide(false);
        try { delete window[stateKey]; } catch (_err) { window[stateKey] = null; }
      };
      bind(document, 'pointerdown', onPointerDown, true);
      bind(document, 'pointerup', onPointerUp, true);
      bind(document, 'pointercancel', onPointerUp, true);
      bind(document, 'selectionchange', onSelectionChange, true);
      bind(document, 'select', onSelectionChange, true);
      bind(document, 'keyup', onSelectionChange, true);
      bind(document, 'keydown', onKeyDown, true);
      bind(window, 'scroll', onScroll, true);
      bind(window, 'blur', function () { hide(true); }, true);
      window[stateKey] = { cleanup: cleanup };
    } catch (_err) { /* selection actions are progressive enhancement */ }
  })();`;
}

/**
 * Main-world script injected into every page-rendering WebContentsView on
 * dom-ready (executeJavaScript - a preload CANNOT do this job, because
 * with contextIsolation the page calls its OWN navigator.credentials, not
 * the isolated world's copy).
 *
 * WHY: passkey/WebAuthn sign-in steps (GitHub 2FA, etc.) can hang forever
 * inside Electron. Chromium's content layer gives Electron working USB
 * security keys everywhere, Windows Hello on Windows and Touch ID on
 * macOS - but the "hybrid" flows browsers add on top (QR code to use a
 * phone, passkeys synced in Chrome/Google Password Manager) are browser
 * UI that does not exist in Electron, most visibly on Linux. The site
 * just awaits navigator.credentials.get() while showing "Waiting for
 * input from browser interaction..." with no way out.
 *
 * This observer wraps navigator.credentials.get/create for publicKey
 * requests only. Every genuine request is identified by relying-party ID and
 * reported (metadata only) to Yayra chrome. If the ceremony is not instantly
 * completed, an in-page helper explains the active device/security-key path
 * and provides a one-click system-browser fallback for phone/synced passkeys.
 * Success removes it immediately; an honest failure remains briefly with the
 * fallback instead of leaving the user at a dead spinner. Passive conditional
 * mediation stays silent, and password-manager credentials.get() calls (no
 * publicKey) are untouched.
 */
function buildWebAuthnWatchdogScript() {
  return `(function () {
  if (window.__yayraWebauthnWatchdog) return;
  window.__yayraWebauthnWatchdog = true;
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  var WAIT_MS = Number(window.__yayraWebauthnWaitMs) > 0 ? Number(window.__yayraWebauthnWaitMs) : 350;
  var LONG_WAIT_MS = Number(window.__yayraWebauthnLongWaitMs) > WAIT_MS ? Number(window.__yayraWebauthnLongWaitMs) : 8000;
  var banner = null;
  var bannerMessage = null;
  var currentRequest = null;
  var pending = Object.create(null);
  var sequence = 0;
  var platformAuthenticator = null;
  var linuxSession = /Linux/i.test(String(navigator.userAgent || navigator.platform || ''));

  function requestCount() { return Object.keys(pending).length; }
  function safeRpId(options) {
    var value = '';
    try {
      value = options.publicKey.rpId || (options.publicKey.rp && options.publicKey.rp.id) || '';
      if (!value && window.location && window.location.hostname) value = window.location.hostname;
    } catch (_err) { value = ''; }
    value = String(value || '').trim().toLowerCase();
    return value && value.length <= 253 && /^[a-z0-9.-]+$/.test(value) ? value : 'this site';
  }
  function requestMeta(action, options) {
    var selection = options && options.publicKey && options.publicKey.authenticatorSelection;
    var attachment = selection && selection.authenticatorAttachment;
    return {
      requestId: 'yayra-wa-' + Date.now().toString(36) + '-' + (++sequence),
      action: action,
      rpId: safeRpId(options),
      conditional: Boolean(options && options.mediation === 'conditional'),
      attachment: attachment === 'platform' || attachment === 'cross-platform' ? attachment : 'any',
      dismissed: false,
      timer: null,
      longTimer: null
    };
  }
  function notify(phase, meta, success, errorName) {
    if (typeof window.postMessage !== 'function') return;
    try {
      window.postMessage({
        source: 'yayra-site-passkey',
        version: 1,
        phase: phase,
        requestId: meta.requestId,
        action: meta.action,
        rpId: meta.rpId,
        conditional: meta.conditional,
        attachment: meta.attachment,
        success: typeof success === 'boolean' ? success : undefined,
        errorName: errorName ? String(errorName).slice(0, 64) : undefined
      }, '*');
    } catch (_err) { /* notification is an enhancement; WebAuthn keeps running */ }
  }
  function removeBanner() {
    if (!banner) return;
    if (banner.remove) banner.remove();
    else if (banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
    bannerMessage = null;
    currentRequest = null;
  }
  function description(meta, state, errorName) {
    var site = meta.rpId === 'this site' ? 'This site' : meta.rpId;
    var verb = meta.action === 'create' ? 'create a new passkey' : 'use a passkey';
    if (state === 'failed') {
      return 'Yayra recognized the passkey request from ' + site + ', but the authenticator did not complete it' +
        (errorName ? ' (' + errorName + ')' : '') + '. Try your device prompt or a USB/NFC security key, or open this page in your system browser for a phone or synced passkey.';
    }
    var text = site + ' is asking to ' + verb + '. The secure Chromium WebAuthn request is active in Yayra. ';
    if (platformAuthenticator === true) {
      text += linuxSession
        ? 'Use the passkey action in Yayra’s address bar. Yayra will verify with your configured PIN, Touch ID, or system-lock method, or offer the exact-page fallback when this profile has no matching local credential.'
        : 'Complete the Windows Hello or Touch ID prompt, or use a security key.';
    } else if (platformAuthenticator === false) {
      text += 'A built-in device authenticator is not exposed in this session; a compatible USB/NFC security key can still work when no unsupported PIN prompt is needed. Phone and synced passkeys can be used by opening this page in your system browser.';
    } else {
      text += 'Complete your device prompt or insert and touch your security key.';
    }
    if (state === 'waiting') text += ' Yayra is still waiting without blocking the page.';
    return text;
  }
  function renderBanner(meta, state, errorName) {
    if (!meta || meta.dismissed || !document.body) return;
    currentRequest = meta;
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'yayra-webauthn-helper';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483647;width:min(560px,calc(100vw - 32px));box-sizing:border-box;background:#111827;color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:12px;padding:14px 16px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.55);');
      var heading = document.createElement('strong');
      heading.textContent = 'Passkey request active';
      heading.setAttribute('style', 'display:block;margin-bottom:4px;color:#f8fafc;font-size:13px;');
      bannerMessage = document.createElement('div');
      bannerMessage.id = 'yayra-webauthn-message';
      var row = document.createElement('div');
      row.setAttribute('style', 'margin-top:10px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;');
      var openBtn = document.createElement('button');
      openBtn.id = 'yayra-webauthn-open-external';
      openBtn.textContent = 'Use system browser';
      openBtn.setAttribute('style', 'border:none;border-radius:8px;padding:6px 12px;background:#3b82f6;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;');
      openBtn.addEventListener('click', function () {
        window.open('yayra-openexternal://' + encodeURIComponent(window.location.href));
      });
      var dismissBtn = document.createElement('button');
      dismissBtn.id = 'yayra-webauthn-dismiss';
      dismissBtn.textContent = 'Continue here';
      dismissBtn.setAttribute('style', 'border:none;border-radius:8px;padding:6px 12px;background:rgba(255,255,255,0.12);color:#e5e7eb;cursor:pointer;font:600 12px system-ui,sans-serif;');
      dismissBtn.addEventListener('click', function () {
        if (currentRequest) currentRequest.dismissed = true;
        removeBanner();
      });
      row.appendChild(openBtn);
      row.appendChild(dismissBtn);
      banner.appendChild(heading);
      banner.appendChild(bannerMessage);
      banner.appendChild(row);
      document.body.appendChild(banner);
    }
    if (bannerMessage) bannerMessage.textContent = description(meta, state, errorName);
  }
  function scheduleHelper(meta) {
    if (meta.conditional) return;
    meta.timer = setTimeout(function () {
      meta.timer = null;
      if (pending[meta.requestId]) renderBanner(meta, 'active');
    }, WAIT_MS);
    if (meta.timer && typeof meta.timer.unref === 'function') meta.timer.unref();
    meta.longTimer = setTimeout(function () {
      meta.longTimer = null;
      if (pending[meta.requestId]) renderBanner(meta, 'waiting');
    }, LONG_WAIT_MS);
    if (meta.longTimer && typeof meta.longTimer.unref === 'function') meta.longTimer.unref();
  }
  function scheduleFailureRemoval(meta) {
    var timer = setTimeout(function () { if (currentRequest === meta) removeBanner(); }, 15000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function settle(meta, success, error, alreadyReported) {
    if (!pending[meta.requestId]) return;
    if (meta.timer) clearTimeout(meta.timer);
    if (meta.longTimer) clearTimeout(meta.longTimer);
    delete pending[meta.requestId];
    var errorName = typeof error === 'string' ? error : (error && error.name ? String(error.name) : '');
    if (!alreadyReported) notify('settled', meta, success, errorName);
    if (!success && !meta.conditional && !meta.dismissed) {
      renderBanner(meta, 'failed', errorName);
      scheduleFailureRemoval(meta);
    } else if (requestCount() === 0) {
      removeBanner();
    }
  }
  function watch(original, action) {
    return function (options) {
      if (!options || !options.publicKey) return original.apply(navigator.credentials, arguments);
      var meta = requestMeta(action, options);
      notify('started', meta);
      var result;
      try {
        result = original.apply(navigator.credentials, arguments);
      } catch (error) {
        notify('settled', meta, false, error && error.name);
        if (!meta.conditional) {
          renderBanner(meta, 'failed', error && error.name);
          scheduleFailureRemoval(meta);
        }
        throw error;
      }
      if (!result || typeof result.then !== 'function') {
        notify('settled', meta, false, 'InvalidStateError');
        return result;
      }
      pending[meta.requestId] = meta;
      scheduleHelper(meta);
      result.then(function () { settle(meta, true); }, function (error) { settle(meta, false, error); });
      return result;
    };
  }
  function install(name, action) {
    var original = navigator.credentials[name];
    if (typeof original !== 'function') return;
    var wrapped = watch(original, action);
    try {
      Object.defineProperty(navigator.credentials, name, { configurable: true, writable: true, value: wrapped });
    } catch (_err) {
      try { navigator.credentials[name] = wrapped; } catch (_ignored) { /* frozen by site/embedder */ }
    }
  }
  try {
    var capability = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof capability === 'function') {
      Promise.resolve(capability.call(window.PublicKeyCredential)).then(function (available) {
        platformAuthenticator = Boolean(available);
        if (currentRequest && bannerMessage) bannerMessage.textContent = description(currentRequest, 'active');
      }, function () { platformAuthenticator = false; });
    }
  } catch (_err) { platformAuthenticator = null; }

  // Electron 44+ installs a tiny main-world observer from the isolated preload
  // at document start. Subscribe to it so even requests made before dom-ready
  // are recognized, while this script remains the helper-UI owner. Older
  // Electron/test hosts fall back to wrapping the native methods here.
  var earlyObserver = window.__yayraSitePasskeyObserver;
  var subscribed = false;
  if (earlyObserver && earlyObserver.version === 1 && typeof earlyObserver.subscribe === 'function') {
    try {
      earlyObserver.subscribe(function (event) {
        if (!event || typeof event.requestId !== 'string' || !/^yayra-wa-[a-z0-9-]{1,80}$/i.test(event.requestId)) return;
        if (event.phase === 'started') {
          if (pending[event.requestId]) return;
          var meta = {
            requestId: event.requestId,
            action: event.action === 'create' ? 'create' : 'get',
            rpId: typeof event.rpId === 'string' ? event.rpId : 'this site',
            conditional: Boolean(event.conditional),
            attachment: event.attachment === 'platform' || event.attachment === 'cross-platform' ? event.attachment : 'any',
            dismissed: false,
            timer: null,
            longTimer: null
          };
          pending[meta.requestId] = meta;
          scheduleHelper(meta);
          return;
        }
        if (event.phase === 'settled' && pending[event.requestId]) {
          settle(pending[event.requestId], event.success === true, String(event.errorName || ''), true);
        }
      });
      subscribed = true;
    } catch (_err) { subscribed = false; }
  }
  if (!subscribed || (earlyObserver.methods && earlyObserver.methods.get === false)) install('get', 'get');
  if (!subscribed || (earlyObserver.methods && earlyObserver.methods.create === false)) install('create', 'create');
})();`;
}

/**
 * Google Search can finish its document load while an AI Overview is still
 * displaying its standalone "Thinking" status. That request is page-level
 * activity (not WebContents.isLoading()), so the browser's ordinary loading
 * watchdog cannot see it. Watch only Google Search results, and only reload
 * after the visible status remains continuous for the configured timeout.
 *
 * A per-query sessionStorage cooldown makes this a single recovery attempt,
 * not a reload loop. It stores only a short hash of the query URL, never the
 * query itself. If storage is unavailable, the watchdog opts out rather than
 * risk a reload loop.
 */
function buildGoogleSearchThinkingWatchdogScript({
  timeoutMs = 120_000,
  pollIntervalMs = 5_000,
  reloadCooldownMs = 30 * 60_000
} = {}) {
  const safeDelay = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
  };
  const config = {
    timeoutMs: safeDelay(timeoutMs, 120_000),
    pollIntervalMs: safeDelay(pollIntervalMs, 5_000),
    reloadCooldownMs: safeDelay(reloadCooldownMs, 30 * 60_000)
  };
  return `(function () {
  if (window.__yayraGoogleSearchThinkingWatchdog) return;
  window.__yayraGoogleSearchThinkingWatchdog = true;
  var initialHost = String(window.location && window.location.hostname || '').toLowerCase();
  var googleHost = /^(?:www\\.)?google\\.[a-z]{2,}(?:\\.[a-z]{2,})?$/.test(initialHost);
  if (!googleHost) return;

  var WAIT_MS = ${config.timeoutMs};
  var POLL_MS = ${config.pollIntervalMs};
  var COOLDOWN_MS = ${config.reloadCooldownMs};
  var storage;
  try {
    storage = window.sessionStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return;
    var probe = '__yayra_google_thinking_probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
  } catch (_err) {
    return;
  }

  function isGoogleSearch() {
    var location = window.location || {};
    var host = String(location.hostname || '').toLowerCase();
    return /^(?:www\\.)?google\\.[a-z]{2,}(?:\\.[a-z]{2,})?$/.test(host)
      && /^\\/search\\/?$/.test(String(location.pathname || ''));
  }
  function hash(value) {
    var result = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }
  function hasStandaloneThinkingStatus() {
    var text = document.body && typeof document.body.innerText === 'string' ? document.body.innerText : '';
    return /(?:^|\\n)\\s*Thinking(?:\\s*(?:\\.{3}|…))?\\s*(?:\\n|$)/i.test(text);
  }
  function recentlyReloaded(key, now) {
    try {
      var raw = storage.getItem(key);
      if (raw === null) return false;
      var last = Number(raw);
      return !Number.isFinite(last) || now - last < COOLDOWN_MS;
    } catch (_err) {
      return true;
    }
  }

  var thinkingSince = 0;
  var observedUrl = String(window.location.href || '');
  window.setInterval(function () {
    try {
      var location = window.location || {};
      var currentUrl = String(location.href || '');
      if (currentUrl !== observedUrl) {
        observedUrl = currentUrl;
        thinkingSince = 0;
      }
      if (!isGoogleSearch() || document.visibilityState === 'hidden' || !hasStandaloneThinkingStatus()) {
        thinkingSince = 0;
        return;
      }

      var now = Date.now();
      if (!thinkingSince) {
        thinkingSince = now;
        return;
      }
      if (now - thinkingSince < WAIT_MS) return;

      var searchUrl = String(location.pathname || '') + String(location.search || '');
      var markerKey = '__yayra_google_thinking_reload_' + hash(searchUrl);
      if (recentlyReloaded(markerKey, now)) {
        thinkingSince = 0;
        return;
      }
      try { storage.setItem(markerKey, String(now)); }
      catch (_err) { thinkingSince = 0; return; }

      // Normal reload: preserve the current tab, URL, profile and cookies.
      // This intentionally does not clear site data or cache.
      thinkingSince = 0;
      if (location && typeof location.reload === 'function') location.reload();
    } catch (_err) {
      thinkingSince = 0;
    }
  }, POLL_MS);
})();`;
}

/**
 * Builds a standard desktop Chrome User-Agent string for the current
 * platform/Chromium version, deliberately omitting the "Electron/x.y.z"
 * token Electron appends by default. Pure function (reads only static
 * `process.versions`/`process.platform`), fully unit-testable. Used only for
 * general site compatibility - see the "GOOGLE / IDENTITY PROVIDER SIGN-IN"
 * note above.
 */
function buildBrowserUserAgent({ platform = process.platform, chromeVersion = process.versions.chrome } = {}) {
  const platformToken = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * Chrome reload-shortcut matrix for key events arriving INSIDE a web
 * page (the embedded native view gets the keystrokes, not the shell):
 *   Ctrl/Cmd+R, F5                     -> 'reload'
 *   Ctrl/Cmd+Shift+R, Ctrl+F5, Shift+F5 -> 'hard-reload' (cache cleared)
 * Returns null for everything else. Pure - unit tested directly.
 */
function reloadActionForInput(input = {}) {
  if (!input || (input.type && input.type !== 'keyDown')) return null;
  const key = String(input.key || '');
  const primary = Boolean(input.control || input.meta);
  if (key.toLowerCase() === 'r' && primary && !input.alt) {
    return input.shift ? 'hard-reload' : 'reload';
  }
  if (key === 'F5' && !input.alt) {
    return (primary || input.shift) ? 'hard-reload' : 'reload';
  }
  return null;
}

function parseBoundedAuthUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_AUTH_HANDOFF_URL_LENGTH) return null;
  try {
    const parsed = new URL(rawUrl);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isGoogleOAuthAuthorizationUrl(rawUrl) {
  const parsed = parseBoundedAuthUrl(rawUrl);
  return Boolean(parsed
    && parsed.hostname.toLowerCase() === 'accounts.google.com'
    && GOOGLE_OAUTH_PATH.test(parsed.pathname));
}

/**
 * Google-owned account entry points for which Yayra can complete its own
 * verified OAuth loop. This is intentionally disjoint from third-party OAuth
 * authorization URLs: those must preserve the relying party's client_id and
 * callback in the external browser. Account root/management and Google's
 * first-party interactive login routes otherwise cannot establish cookies in
 * an Electron partition, so loading or merely reopening them externally would
 * leave Yayra signed out forever.
 */
function requiresYayraGoogleAccountConnection(rawUrl) {
  const parsed = parseBoundedAuthUrl(rawUrl);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'myaccount.google.com') return true;
  if (hostname !== 'accounts.google.com' || GOOGLE_OAUTH_PATH.test(parsed.pathname)) return false;
  return GOOGLE_ACCOUNT_PORTAL_PATH.test(parsed.pathname)
    || GOOGLE_INTERACTIVE_SIGNIN_PATH.test(parsed.pathname);
}

/**
 * Exact Google identity routes that require an external user-agent. This is
 * intentionally narrower than accounts.google.com as a whole: logout and
 * ordinary product browsing remain ordinary web navigation. First-party
 * account routes are connected through Yayra OAuth by the separate predicate
 * above, while third-party OAuth remains an exact external handoff.
 */
function isGoogleInteractiveAuthenticationUrl(rawUrl) {
  const parsed = parseBoundedAuthUrl(rawUrl);
  return Boolean(parsed
    && parsed.hostname.toLowerCase() === 'accounts.google.com'
    && (GOOGLE_OAUTH_PATH.test(parsed.pathname) || GOOGLE_INTERACTIVE_SIGNIN_PATH.test(parsed.pathname)));
}

function requiresSystemBrowserAuth(rawUrl, hosts = SYSTEM_BROWSER_AUTH_HOSTS) {
  const parsed = parseBoundedAuthUrl(rawUrl);
  if (!parsed) return false;

  const hostname = parsed.hostname.toLowerCase();
  return hosts.some((host) => {
    const normalizedHost = String(host).toLowerCase();
    if (normalizedHost === 'accounts.google.com') {
      return hostname === normalizedHost && isGoogleInteractiveAuthenticationUrl(rawUrl);
    }
    return hostname === normalizedHost || hostname.endsWith(`.${normalizedHost}`);
  });
}

function safeGoogleContinueUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Upgrades provider handoffs to HTTPS. Google's embedded-user-agent rejection
 * URL is not useful when reopened as-is, so convert only that exact route to
 * a fresh ServiceLogin entry point and preserve a bounded HTTPS continuation.
 * No code, access token, refresh token, or custom-scheme value is synthesized.
 */
function secureSystemBrowserAuthUrl(rawUrl, hosts = SYSTEM_BROWSER_AUTH_HOSTS) {
  if (!requiresSystemBrowserAuth(rawUrl, hosts)) return rawUrl;
  const parsed = parseBoundedAuthUrl(rawUrl);
  if (!parsed) return rawUrl;
  parsed.protocol = 'https:';

  if (parsed.hostname.toLowerCase() === 'accounts.google.com'
    && GOOGLE_REJECTED_SIGNIN_PATH.test(parsed.pathname)) {
    const clean = new URL('https://accounts.google.com/ServiceLogin');
    const continueUrl = safeGoogleContinueUrl(parsed.searchParams.get('continue'));
    if (continueUrl) clean.searchParams.set('continue', continueUrl);
    const language = parsed.searchParams.get('hl');
    if (language && /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)) clean.searchParams.set('hl', language);
    return clean.toString();
  }

  parsed.hash = '';
  return parsed.toString();
}

/**
 * History navigation helpers.
 * Electron 32 deprecated webContents.canGoBack/goBack/canGoForward/goForward
 * in favor of the webContents.navigationHistory object, and the legacy
 * methods can be removed in any future major. Prefer the new API whenever
 * the webContents exposes it, but keep the legacy call as a fallback so
 * dependency-injected test doubles (and any embedder that still provides
 * only the old shape) keep working unchanged.
 */
function historyCanGoBack(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.canGoBack === 'function') return h.canGoBack();
  return typeof wc.canGoBack === 'function' ? wc.canGoBack() : false;
}

function historyCanGoForward(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.canGoForward === 'function') return h.canGoForward();
  return typeof wc.canGoForward === 'function' ? wc.canGoForward() : false;
}

function historyGoBack(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.goBack === 'function') return h.goBack();
  if (typeof wc.goBack === 'function') wc.goBack();
}

function historyGoForward(wc) {
  const h = wc.navigationHistory;
  if (h && typeof h.goForward === 'function') return h.goForward();
  if (typeof wc.goForward === 'function') wc.goForward();
}

/**
 * Builds a Chrome-equivalent native right-click context menu template for a
 * WebContentsView, from the `params` Electron's own `context-menu` webContents
 * event already hands us (link/image/selection/editable info - no manual
 * DOM inspection needed). Pure(ish) function - only touches the passed-in
 * `wc` (to read canGoBack/canGoForward and to run the actual action when a
 * user clicks an item) and `clipboard`/`send` - so it is fully unit-testable
 * without a real Electron `Menu`. See tests/electron-webview-bridge.test.mjs.
 */
function safeSelectionSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.origin}${url.pathname}`.slice(0, 2000);
  } catch { return ''; }
}

function buildContextMenuTemplate({ params, wc, tabId, send, clipboard, navigationState = null, useTabNavigation = false }) {
  const template = [];
  const isLink = !!(params && params.linkURL);
  const isImage = !!(params && params.mediaType === 'image' && params.srcURL);
  const isVideo = !!(params && params.mediaType === 'video' && params.srcURL);
  const isEditable = !!(params && params.isEditable);
  const hasSelection = !!(params && params.selectionText && params.selectionText.trim());

  if (isLink) {
    template.push(
      { label: 'Open Link in New Tab', click: () => send(tabId, 'new-window-request', { url: params.linkURL }) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }
    );
  }

  if (isImage || isVideo) {
    if (template.length) template.push({ type: 'separator' });
    const kind = isVideo ? 'video' : 'image';
    const label = isVideo ? 'Video' : 'Image';
    template.push(
      { label: `Open ${label} in New Tab`, click: () => send(tabId, 'new-window-request', { url: params.srcURL, mediaType: kind }) },
      ...(!isVideo ? [{ label: 'Save Image As\u2026', click: () => wc.downloadURL(params.srcURL) }] : []),
      { label: `Copy ${label} Address`, click: () => clipboard.writeText(params.srcURL) }
    );
  }

  if (isEditable) {
    if (template.length) template.push({ type: 'separator' });
    const flags = params.editFlags || {};
    template.push(
      { label: 'Undo', enabled: flags.canUndo !== false, click: () => wc.undo() },
      { label: 'Redo', enabled: flags.canRedo === true, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: flags.canCut !== false, click: () => wc.cut() },
      { label: 'Copy', enabled: flags.canCopy !== false, click: () => wc.copy() },
      { label: 'Paste', enabled: flags.canPaste !== false, click: () => wc.paste() },
      { type: 'separator' },
      { label: 'Select All', enabled: flags.canSelectAll !== false, click: () => wc.selectAll() }
    );
  } else if (hasSelection) {
    if (template.length) template.push({ type: 'separator' });
    const trimmed = params.selectionText.trim().slice(0, 2000);
    const shortText = trimmed.length > 32 ? `${trimmed.slice(0, 32)}\u2026` : trimmed;
    template.push(
      { label: 'Copy', click: () => wc.copy() },
      {
        label: `Search Google for "${shortText}"`,
        click: () => send(tabId, 'new-window-request', { url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}` })
      },
      {
        // Chrome-style AI option on selected text: hands the selection to
        // the yayra://ai page, which auto-asks it (see BrowserShell
        // renderInternalAiPage + services/aiService.js).
        label: `Ask Yayra AI about "${shortText}"`,
        click: () => send(tabId, 'new-window-request', { url: `yayra://ai?q=${encodeURIComponent(trimmed)}` })
      },
      {
        label: `Ask Yayra Dictionary about "${shortText}"`,
        click: () => send(tabId, 'new-window-request', { url: `yayra://dictionary?q=${encodeURIComponent(trimmed)}` })
      },
      {
        label: 'Highlight selected text',
        click: () => {
          const query = new URLSearchParams({ view: 'saved', highlight: trimmed });
          const sourceUrl = safeSelectionSourceUrl(params.pageURL);
          if (sourceUrl) query.set('source', sourceUrl);
          send(tabId, 'new-window-request', { url: `yayra://dictionary?${query.toString()}` });
        }
      },
      {
        label: 'Save selection to vocabulary',
        click: () => {
          const query = new URLSearchParams({ view: 'saved', save: trimmed });
          const sourceUrl = safeSelectionSourceUrl(params.pageURL);
          if (sourceUrl) query.set('source', sourceUrl);
          send(tabId, 'new-window-request', { url: `yayra://dictionary?${query.toString()}` });
        }
      }
    );
  }

  if (template.length) template.push({ type: 'separator' });
  template.push(
    // Always available, Chrome-style: open the in-browser AI chat.
    { label: 'Ask Yayra AI', click: () => send(tabId, 'new-window-request', { url: 'yayra://ai' }) },
    { type: 'separator' },
    {
      label: 'Back',
      enabled: useTabNavigation ? navigationState?.canGoBack === true : historyCanGoBack(wc),
      click: () => useTabNavigation ? send(tabId, 'context-menu-navigation', { direction: 'back' }) : historyGoBack(wc)
    },
    {
      label: 'Forward',
      enabled: useTabNavigation ? navigationState?.canGoForward === true : historyCanGoForward(wc),
      click: () => useTabNavigation ? send(tabId, 'context-menu-navigation', { direction: 'forward' }) : historyGoForward(wc)
    },
    { label: 'Reload', click: () => useTabNavigation ? send(tabId, 'context-menu-navigation', { direction: 'reload' }) : wc.reload() },
    { type: 'separator' },
    { label: 'Inspect', click: () => wc.inspectElement((params && params.x) || 0, (params && params.y) || 0) }
  );

  return template;
}

function sanitizeBounds(bounds) {
  const safeNumber = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
  return {
    x: safeNumber(bounds && bounds.x),
    y: safeNumber(bounds && bounds.y),
    width: safeNumber(bounds && bounds.width),
    height: safeNumber(bounds && bounds.height)
  };
}

// Native WebContentsViews are sibling OS surfaces above the renderer. Even
// if a stale ResizeObserver reports y=0 during a re-render, a website must
// never be allowed to own the custom title/tab row's hit-testing area.
const MIN_NATIVE_PAGE_Y = 36;
function sanitizePageBounds(bounds) {
  const clean = sanitizeBounds(bounds);
  // Preserve the zero rectangle used by setVisible(false).
  if (clean.width === 0 || clean.height === 0 || clean.y >= MIN_NATIVE_PAGE_Y) return clean;
  const covered = MIN_NATIVE_PAGE_Y - clean.y;
  return {
    ...clean,
    y: MIN_NATIVE_PAGE_Y,
    height: Math.max(0, clean.height - covered)
  };
}

/**
 * Creates and wires the IPC surface used by the renderer's native-engine
 * bridge (see BrowserShell.js's `createWebContentFrame`). Dependency-injected
 * so the business logic (hostname auth handoff, bounds sanitizing, tab
 * lifecycle bookkeeping) stays unit-testable without a real Electron runtime
 * - see tests/electron-webview-bridge.test.mjs.
 */
function createWebviewBridge({
  WebContentsView,
  ipcMain,
  shell,
  getMainWindow,
  // Recognized provider authorization and interactive sign-in routes always
  // use the OS external user-agent. A BrowserWindow is still app-controlled
  // and does not satisfy RFC 8252 / Google's embedded-user-agent policy.
  authHosts = SYSTEM_BROWSER_AUTH_HOSTS,
  // Resolves the BrowserWindow that owns a given webContents, so views
  // created by the floating mini-shell window attach to THAT window instead
  // of the main one. Injected for testability; when absent (older tests,
  // direct _internal calls) everything falls back to getMainWindow().
  getWindowForWebContents = null,
  // Injected (rather than `require('electron')`'d directly) so this stays
  // unit-testable with fakes - see tests/electron-webview-bridge.test.mjs.
  // Both are optional: if a host app doesn't pass them, right-click simply
  // does nothing instead of throwing.
  Menu = null,
  clipboard = null,
  // Electron's dialog module, injected for "Save page as..." and the
  // printerless Print -> PDF fallback. Optional: without it those operations
  // report { ok:false } instead of guessing a path.
  dialog = null,
  // Injected fs writer for generated PDFs. Keeping filesystem access outside
  // renderer IPC makes the fallback testable and prevents arbitrary writes.
  writeFile = null,
  // Absolute path to electron/autofillPreload.cjs. When provided, every
  // page view gets sandboxed password capture/fill and email suggestion hooks
  // (context-isolated, nothing exposed to the page). Optional for test hosts.
  autofillPreloadPath = null,
  // Optional Linux software platform authenticator. It uses Chromium's real
  // WebAuthn machinery, encrypted per-profile credentials, and an explicit
  // browser-chrome confirmation before releasing user presence.
  websitePasskeyProvider = null,
  // Main-process one-shot grant consumer from passkeyBridge.cjs. Renderer
  // booleans are never trusted as user verification.
  consumeWebsitePasskeyGrant = null,
  // Main wires every per-profile/private Session into downloadsBridge. This
  // callback is optional in tests and non-Electron hosts.
  attachDownloadSession = null,
  // Trusted profile/session resolvers power privacy controls before the first
  // native page exists. Renderer-provided profile ids are never trusted.
  getProfileIdForWebContents = null,
  sessionModule = null,
  // Google auth-surface parity (see electron/googleAuthParity.cjs). Injected
  // so hosts/tests can opt in without changing the default behavior of every
  // other WebContentsView user. `googleAuthParityEnabled` is a function so a
  // live Security Center setting takes effect without recreating views.
  googleAuthParityEnabled = null,
  // Main-owned callback: open a Google destination in Yayra's dedicated,
  // Yayra-owned real Chrome profile. Used only as a fallback when Google
  // rejects the in-Yayra attempt, and for explicit "open in Chrome" actions.
  openGoogleChromeProfile = null,
  // Main-owned callback: apply honest UA client-hint metadata to a view via
  // CDP `Emulation.setUserAgentOverride`. Best effort; never an automation
  // flag. See googleAuthParity.cjs for the header-level half.
  applyGoogleAuthUserAgentMetadata = null,
  sitePasskeyCompletionTimeoutMs = SITE_PASSKEY_COMPLETION_TIMEOUT_MS,
  logger = console,
  pageUnresponsiveReloadDelayMs = PAGE_UNRESPONSIVE_RELOAD_DELAY_MS,
  pageUnresponsiveReloadCooldownMs = PAGE_UNRESPONSIVE_RELOAD_COOLDOWN_MS,
  downloadHandoffGraceMs = DOWNLOAD_HANDOFF_GRACE_MS
}) {
  // key -> { view, lastUrl, tabId, hostWc, hostWin }
  // key namespaces the renderer-chosen tabId by the webContents that asked
  // for it: the main window and the floating mini window each run their own
  // BrowserShell instance whose generated ids ("tab-1", "tab-2", ...) would
  // otherwise collide and steal each other's native views.
  const views = new Map();
  const entriesByWebContents = new WeakMap();
  // One discoverable-credential chooser per persistent/private Session.
  // Without this Electron cancels navigator.credentials.get() whenever an
  // authenticator returns accounts, making valid site passkeys look broken.
  const webAuthnSessionListeners = new WeakMap();
  // Per-shell-window policy. WeakMaps keep preferences scoped to the renderer
  // that owns native views without retaining closed shell windows.
  const backgroundThrottlingByHost = new WeakMap();
  const privacyPolicyByHost = new WeakMap();
  // Per-host + per-profile Google auth parity. Default OFF: nothing changes
  // for hosts that do not opt in. Enabling it removes the embedded signals
  // Google rejects (script injection, header rewriting, mismatched client
  // hints) on accounts.google.com / consent.google.com / myaccount.google.com.
  const googleAuthParityByHost = new WeakMap();
  const googleAuthParityByProfile = new Map();
  const rejectedSignInByEntry = new WeakSet();
  const authSurfaceActiveByEntry = new WeakSet();

  function parityEnabled(profileId = 'default') {
    // Explicit per-profile override wins over the host-wide default. Both are
    // set by trusted main-process IPC, never by renderer page content.
    const key = String(profileId || 'default');
    if (googleAuthParityByProfile.has(key)) return googleAuthParityByProfile.get(key);
    if (typeof googleAuthParityEnabled === 'function') {
      try { return Boolean(googleAuthParityEnabled(profileId)); } catch { return false; }
    }
    return Boolean(googleAuthParityEnabled);
  }

  function currentUrlForEntry(entry) {
    try {
      return entry?.view?.webContents?.getURL?.() || entry?.lastUrl || entry?.requestedUrl || '';
    } catch { return entry?.lastUrl || entry?.requestedUrl || ''; }
  }

  /** True when this view is actually showing a Google authentication page. */
  function isAuthSurfaceEntry(entry) {
    return isGoogleAuthSurface(currentUrlForEntry(entry));
  }

  /**
   * Whether Yayra should try to complete a first-party Google sign-in inside
   * its own persistent per-profile session. Third-party OAuth is NEVER allowed
   * here: that request carries another site's client_id and callback.
   */
  function allowNativeGoogleSignIn(rawUrl, profileId = 'default', isPrivate = false) {
    // A private tab must never be given access to the persistent Chrome
    // profile/cookie jar. It keeps the historical external-browser handoff.
    if (isPrivate || !parityEnabled(profileId)) return false;
    if (isThirdPartyGoogleOAuthUrl(rawUrl)) return false;
    return isFirstPartyGoogleSignInUrl(rawUrl) || isGoogleAccountPortalUrl(rawUrl);
  }

  function safeOriginForUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''));
      return parsed.protocol === 'https:' ? parsed.origin : '';
    } catch { return ''; }
  }

  /**
   * Emit a verified-origin indicator only when the auth-surface state
   * CHANGES. Sending it on every navigation would add a spurious event to
   * every ordinary page load and break event-count contracts in the shell.
   */
  function emitAuthSurfaceState(entry, rawUrl) {
    const active = parityEnabled(entry?.profileId) && isGoogleAuthSurface(rawUrl);
    const wasActive = authSurfaceActiveByEntry.has(entry);
    if (active === wasActive) return;
    if (active) authSurfaceActiveByEntry.add(entry);
    else authSurfaceActiveByEntry.delete(entry);
    sendTo(entry, 'google-auth-surface', {
      active,
      origin: active ? safeOriginForUrl(rawUrl) : ''
    });
  }

  function openChromeProfileFallback(entry, rawUrl, reason = 'rejected') {
    const target = reason === 'google-rejected-embedded-browser'
      ? googleSignInFallbackUrl(rawUrl)
      : (safeGoogleDestination(rawUrl) || 'https://accounts.google.com/ServiceLogin');
    if (entry?.isPrivate) {
      // Do not launch the persistent per-profile Chrome jar from a private
      // tab. A normal system-browser handoff is the explicit user-visible
      // escape hatch, and no private-tab cookies/URLs enter Yayra storage.
      try {
        Promise.resolve(shell.openExternal(target)).catch(() => {});
        return { opened: true, chromeProfileOpened: false };
      } catch { return { opened: false, chromeProfileOpened: false }; }
    }
    if (typeof openGoogleChromeProfile !== 'function') return { opened: false, chromeProfileOpened: false };
    try {
      const result = openGoogleChromeProfile({
        url: target,
        profileId: String(entry?.profileId || 'default'),
        tabId: entry?.tabId || null,
        reason
      });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
        return { opened: true, chromeProfileOpened: true };
      }
      return {
        opened: Boolean(result?.ok || result?.systemFallback),
        chromeProfileOpened: Boolean(result?.ok)
      };
    } catch { return { opened: false, chromeProfileOpened: false }; }
  }

  /**
   * Parity item 6: Google explicitly says "This browser or app may not be
   * secure" by navigating to /signin/rejected (or returning
   * disallowed_useragent). Detect it in the trusted main process and hand the
   * SAME destination to Yayra's dedicated real Chrome profile instead of
   * stranding the user on a dead page or looping the OAuth flow forever.
   */
  function handleRejectedSignIn(entry, rawUrl) {
    if (!parityEnabled(entry?.profileId) || !isGoogleSignInRejectedUrl(rawUrl)) return false;
    if (rejectedSignInByEntry.has(entry)) return true;
    rejectedSignInByEntry.add(entry);
    const fallback = openChromeProfileFallback(entry, rawUrl, 'google-rejected-embedded-browser');
    emitAuthSurfaceState(entry, '');
    sendTo(entry, 'google-sign-in-rejected', {
      provider: 'google',
      origin: safeOriginForUrl(rawUrl),
      fallbackOpened: fallback.opened,
      chromeProfileOpened: fallback.chromeProfileOpened
    });
    return true;
  }
  const privacyPolicyByProfile = new Map();
  const privacyStatsByProfile = new Map();
  const runtimeSitePermissionsByProfile = new Map();
  const entriesByWebContentsId = new Map();
  const permissionConfiguredSessions = new WeakSet();
  const googleServiceAccountByHost = new WeakMap();

  function googleServiceAccountForEntry(entry) {
    return entry?.hostWc ? googleServiceAccountByHost.get(entry.hostWc) || null : null;
  }

  function injectGoogleServiceAccount(entry) {
    const wc = entry?.view?.webContents;
    if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') return;
    // Parity item 2: Yayra's connected-account marker is an injected page
    // script. It must NEVER run on accounts.google.com / consent.google.com /
    // myaccount.google.com - that is precisely the "insert arbitrary scripts"
    // capability Google's secure-browser policy calls out. The verified
    // account is shown in Yayra's own browser chrome instead.
    if (isAuthSurfaceEntry(entry)) return;
    try {
      const currentUrl = wc.getURL?.() || entry.lastUrl || entry.requestedUrl || '';
      let host = '';
      try { host = new URL(currentUrl).hostname; } catch { /* no committed page yet */ }
      if (!isGoogleProductHost(host)) return;
      const result = wc.executeJavaScript(buildGoogleServiceAccountScript(googleServiceAccountForEntry(entry)), true);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* page navigated away */ }
  }

  function privacyPolicyForEntry(entry) {
    return (entry?.hostWc && privacyPolicyByHost.get(entry.hostWc))
      || privacyPolicyByProfile.get(String(entry?.profileId || 'default'))
      || DEFAULT_PRIVACY_POLICY;
  }

  function entryForRequestDetails(details = {}) {
    const id = Number(details.webContentsId);
    return Number.isInteger(id) ? entriesByWebContentsId.get(id) || null : null;
  }

  function privacyPolicyForRequest(details, fallbackProfileId = 'default') {
    const entry = entryForRequestDetails(details);
    return entry ? privacyPolicyForEntry(entry) : (privacyPolicyByProfile.get(String(fallbackProfileId)) || DEFAULT_PRIVACY_POLICY);
  }

  function topLevelUrlForRequest(details = {}) {
    const entry = entryForRequestDetails(details);
    if (!entry) return '';
    try { return entry.view?.webContents?.getURL?.() || entry.lastUrl || entry.requestedUrl || ''; }
    catch { return entry.lastUrl || entry.requestedUrl || ''; }
  }

  function notePrivacyBlock(details, kind, fallbackProfileId = 'default') {
    const entry = entryForRequestDetails(details);
    const profileId = String(entry?.profileId || fallbackProfileId || 'default');
    const current = privacyStatsByProfile.get(profileId) || { blockedTrackers: 0, blockedCookies: 0, blockedUnsafe: 0, blockedImages: 0 };
    const key = kind === 'tracker' ? 'blockedTrackers'
      : kind === 'cookie' ? 'blockedCookies'
        : kind === 'image' ? 'blockedImages'
          : 'blockedUnsafe';
    current[key] += 1;
    privacyStatsByProfile.set(profileId, current);
  }

  function buildPrivacyRequestPolicy(profileId) {
    function authSurfaceRequest(details = {}) {
      if (!parityEnabled(profileId)) return false;
      const topLevel = topLevelUrlForRequest(details);
      return isGoogleAuthSurface(details.url) || isGoogleAuthSurface(topLevel);
    }

    return {
      // Advertised to mediaCompatibility.cjs so it can bypass its own
      // Cache-Control / Cloudinary rewriting on Google auth traffic.
      authSurfaceParity: true,
      isAuthSurfaceRequest: (details = {}) => authSurfaceRequest(details),
      isGoogleAuthRequest: (details = {}) => parityEnabled(profileId) && isGoogleAuthSurface(details.url),
      beforeRequest(details = {}) {
        // Parity item 3: do not rewrite, upgrade, block or redirect ANY
        // request belonging to a Google authentication surface. Tracker
        // rules, HTTPS-first redirects and third-party cookie stripping can
        // break Google's own sign-in and are themselves "embedded proxy"
        // signals. Client hints are added separately in beforeSendHeaders.
        if (authSurfaceRequest(details)) return {};
        const policy = privacyPolicyForRequest(details, profileId);
        if (policy.httpsFirst && details.resourceType === 'mainFrame') {
          const redirectURL = upgradedHttpsUrl(details.url);
          if (redirectURL && redirectURL !== details.url) return { redirectURL };
        }
        if (isUnsafeRequest(details, policy)) {
          notePrivacyBlock(details, 'unsafe', profileId);
          return { cancel: true };
        }
        if (!policy.imagesEnabled && details.resourceType === 'image') {
          notePrivacyBlock(details, 'image', profileId);
          return { cancel: true };
        }
        if (isTrackerRequest(details, policy)) {
          notePrivacyBlock(details, 'tracker', profileId);
          return { cancel: true };
        }
        return {};
      },
      beforeSendHeaders(details = {}, headers = {}) {
        // Parity items 1 + 3: on the Google auth request itself, add honest,
        // internally consistent UA client hints and nothing else. For other
        // resources on an auth page, preserve the headers untouched (the
        // top-level auth page still exempts them from Yayra's privacy rules).
        // No DNT/GPC injection, topic/attribution stripping, cookie removal,
        // or cache-control overrides.
        if (authSurfaceRequest(details)) {
          return isGoogleAuthSurface(details.url)
            ? applyGoogleAuthClientHints(headers)
            : headers;
        }
        const policy = privacyPolicyForRequest(details, profileId);
        const topLevelUrl = topLevelUrlForRequest(details);
        const blockedCookie = policy.thirdPartyCookies === 'block'
          && isThirdPartyRequest({ ...details, requestHeaders: headers }, topLevelUrl);
        const next = applyPrivacyRequestHeaders(details, headers, policy, topLevelUrl);
        if (blockedCookie && Object.keys(headers).some((name) => /^cookie$/i.test(name))
          && !Object.keys(next).some((name) => /^cookie$/i.test(name))) {
          notePrivacyBlock(details, 'cookie', profileId);
        }
        return next;
      },
      headersReceived(details = {}, headers = {}) {
        // Parity item 3: never strip Google's Set-Cookie / ad-privacy response
        // headers on an auth surface. Those cookies ARE the sign-in session.
        if (authSurfaceRequest(details)) return headers;
        const policy = privacyPolicyForRequest(details, profileId);
        const topLevelUrl = topLevelUrlForRequest(details);
        const hadCookie = Object.keys(headers).some((name) => /^set-cookie\d*$/i.test(name));
        const next = applyPrivacyResponseHeaders(details, headers, policy, topLevelUrl);
        if (hadCookie && !Object.keys(next).some((name) => /^set-cookie\d*$/i.test(name))) {
          notePrivacyBlock(details, 'cookie', profileId);
        }
        return next;
      }
    };
  }

  function requestOriginForPermission(webContents, details = {}) {
    const candidates = [details.requestingUrl, details.securityOrigin, details.embeddingOrigin];
    try { candidates.push(webContents?.getURL?.()); } catch { /* destroyed */ }
    for (const value of candidates) {
      try {
        const parsed = new URL(String(value || ''));
        if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(parsed.hostname))) {
          return parsed.origin;
        }
      } catch { /* continue */ }
    }
    return '';
  }

  function permissionLabel(key) {
    return ({
      location: 'your location', camera: 'your camera', microphone: 'your microphone',
      notifications: 'notifications', clipboard: 'your clipboard', midi: 'MIDI devices',
      usb: 'USB devices', serial: 'serial devices', bluetooth: 'Bluetooth devices',
      hid: 'human-interface devices', pointerLock: 'pointer lock', idleDetection: 'idle activity'
    })[key] || 'this capability';
  }

  function installWebsitePermissionPolicy(ses) {
    if (!ses || permissionConfiguredSessions.has(ses)) return;
    const canRequest = typeof ses.setPermissionRequestHandler === 'function';
    const canCheck = typeof ses.setPermissionCheckHandler === 'function';
    if (!canRequest && !canCheck) return;
    const resolve = (webContents, permission, details = {}) => {
      const entry = webContents ? entriesByWebContents.get(webContents) : null;
      const policy = privacyPolicyForEntry(entry);
      const origin = requestOriginForPermission(webContents, details);
      const runtime = runtimeSitePermissionsByProfile.get(String(entry?.profileId || 'default')) || {};
      const result = policyDecisionForPermission(policy, origin, { permission, details }, runtime);
      return { entry, policy, origin, ...result };
    };
    if (canCheck) {
      ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => {
        // Chromium-owned capabilities needed for ordinary rendering are safe
        // without a persistent website grant. Sensitive APIs flow through the
        // explicit policy below.
        if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true;
        const result = resolve(webContents, permission, details);
        return Boolean(result.origin && result.key && result.decision === 'allow');
      });
    }
    if (canRequest) {
      ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
        let settled = false;
        const finish = (allowed) => {
          if (settled) return;
          settled = true;
          try { callback(Boolean(allowed)); } catch { /* request navigated away */ }
        };
        if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') {
          finish(true);
          return;
        }
        const result = resolve(webContents, permission, details);
        if (!result.origin || !result.key || result.decision === 'block') {
          finish(false);
          return;
        }
        if (result.decision === 'allow') {
          finish(true);
          return;
        }
        const owner = result.entry?.hostWin && !result.entry.hostWin.isDestroyed?.()
          ? result.entry.hostWin
          : getMainWindow();
        if (!dialog || typeof dialog.showMessageBox !== 'function') {
          finish(false);
          return;
        }
        const hostname = hostnameFromUrl(result.origin) || 'This site';
        const options = {
          type: 'question',
          title: 'Website permission',
          message: `${hostname} wants to use ${permissionLabel(result.key)}`,
          detail: 'Allow only when you trust this site. You can review or remove saved decisions in Settings > Privacy & Security > Site settings.',
          buttons: ['Allow once', 'Always allow', 'Block'],
          defaultId: 2,
          cancelId: 2,
          noLink: true
        };
        let prompt;
        try {
          prompt = owner && !owner.isDestroyed?.()
            ? dialog.showMessageBox(owner, options)
            : dialog.showMessageBox(options);
        } catch {
          finish(false);
          return;
        }
        Promise.resolve(prompt).then(({ response } = {}) => {
          if (response === 1 || response === 2) {
            const profileId = String(result.entry?.profileId || 'default');
            const runtime = runtimeSitePermissionsByProfile.get(profileId) || {};
            runtime[result.origin] = { ...(runtime[result.origin] || {}), [result.key]: response === 1 ? 'allow' : 'block' };
            runtimeSitePermissionsByProfile.set(profileId, runtime);
            if (result.entry) {
              sendTo(result.entry, 'site-permission-decision', {
                origin: result.origin,
                permission: result.key,
                decision: response === 1 ? 'allow' : 'block'
              });
            }
          }
          finish(response === 0 || response === 1);
        }, () => finish(false));
      });
    }
    permissionConfiguredSessions.add(ses);
  }

  function cancelPageUnresponsiveReload(entry) {
    if (!entry) return;
    entry.pageUnresponsive = false;
    if (entry.pageUnresponsiveReloadTimer !== null) {
      clearTimeout(entry.pageUnresponsiveReloadTimer);
      entry.pageUnresponsiveReloadTimer = null;
    }
  }

  function cancelDownloadFailureTimer(entry) {
    if (!entry?.downloadFailureTimer) return;
    clearTimeout(entry.downloadFailureTimer);
    entry.downloadFailureTimer = null;
  }

  function noteDownloadHandoff(webContents, details = {}) {
    const entry = webContents ? entriesByWebContents.get(webContents) : null;
    if (!entry) return false;
    cancelDownloadFailureTimer(entry);
    entry.mainFrameFailed = false;
    entry.lastDownloadHandoffAt = Date.now();
    entry.lastDownloadUrl = typeof details.url === 'string' ? details.url : '';
    sendTo(entry, 'loading-stop');
    sendTo(entry, 'download-handoff', {
      url: entry.lastDownloadUrl || entry.requestedUrl || entry.lastUrl || '',
      filename: typeof details.filename === 'string' ? details.filename : '',
      mimeType: typeof details.mimeType === 'string' ? details.mimeType : ''
    });
    return true;
  }

  function recentDownloadHandoff(entry) {
    return Boolean(entry?.lastDownloadHandoffAt
      && Date.now() - entry.lastDownloadHandoffAt <= DOWNLOAD_HANDOFF_TTL_MS);
  }

  function deferGoogleDownloadFailure(entry, failure) {
    if (!isGoogleDriveDownloadUrl(failure.url) && !recentDownloadHandoff(entry)) return false;
    if (recentDownloadHandoff(entry)) return true;
    cancelDownloadFailureTimer(entry);
    const failedGeneration = entry.loadGeneration;
    // Suppress did-finish-load for Chromium's internal error page while the
    // native download event gets its bounded chance to prove success.
    entry.mainFrameFailed = true;
    entry.downloadFailureTimer = setTimeout(() => {
      entry.downloadFailureTimer = null;
      if (entry.loadGeneration !== failedGeneration
        || recentDownloadHandoff(entry) || entry.view.webContents.isDestroyed?.()) return;
      sendTo(entry, 'fail-load', failure);
    }, Math.max(0, Number(downloadHandoffGraceMs) || DOWNLOAD_HANDOFF_GRACE_MS));
    entry.downloadFailureTimer?.unref?.();
    return true;
  }

  function websitePasskeyInfo(entry, request = null) {
    if (!websitePasskeyProvider || typeof websitePasskeyProvider.describe !== 'function') {
      return { mode: 'native', available: false, reason: 'native-platform-authenticator' };
    }
    try {
      const describe = request && typeof websitePasskeyProvider.describeRequest === 'function'
        ? websitePasskeyProvider.describeRequest
        : websitePasskeyProvider.describe;
      const info = describe({
        webContents: entry?.view?.webContents,
        profileId: entry?.profileId,
        isPrivate: entry?.isPrivate,
        action: request?.action,
        rpId: request?.rpId
      }) || {};
      const mode = info.mode === 'local' || info.mode === 'external' ? info.mode : 'native';
      return {
        mode,
        available: mode === 'local' && info.available === true,
        reason: typeof info.reason === 'string' ? info.reason.slice(0, 120) : '',
        ...(Number.isSafeInteger(info.credentialCount) ? { credentialCount: info.credentialCount } : {})
      };
    } catch {
      return { mode: 'external', available: false, reason: 'provider-unavailable' };
    }
  }

  function clearSitePasskeyCompletionTimer(request) {
    if (!request?.completionTimer) return;
    clearTimeout(request.completionTimer);
    request.completionTimer = null;
  }

  function controlSitePasskeyRequest(entry, requestId, command) {
    const request = entry?.sitePasskeyRequests?.get(requestId);
    if (!request?.controlled || !['hold', 'release', 'cancel'].includes(command)) return false;
    const wc = entry?.view?.webContents;
    if (!wc || wc.isDestroyed?.() || typeof wc.send !== 'function') return false;
    try {
      wc.send(SITE_PASSKEY_CONTROL_CHANNEL, { requestId, command });
      request.controlState = command;
      return true;
    } catch {
      return false;
    }
  }

  function armSitePasskeyCompletionTimer(entry, request) {
    clearSitePasskeyCompletionTimer(request);
    const delay = Math.max(100, Number(sitePasskeyCompletionTimeoutMs) || SITE_PASSKEY_COMPLETION_TIMEOUT_MS);
    request.completionTimer = setTimeout(async () => {
      const active = entry?.sitePasskeyRequests?.get(request.requestId);
      if (active !== request) return;
      request.completionTimer = null;
      // Publish the terminal reason before aborting the page promise; the
      // AbortError settlement can otherwise arrive first and erase the active
      // request before chrome has a chance to render the timeout.
      sendTo(entry, 'webauthn-provider-state', {
        requestId: request.requestId,
        state: 'declined',
        reason: 'ceremony-timeout'
      });
      finishPendingPasskeySelection(entry, request.requestId, false);
      controlSitePasskeyRequest(entry, request.requestId, 'cancel');
      try {
        await websitePasskeyProvider?.settle?.({
          webContents: entry.view?.webContents,
          requestId: request.requestId
        });
      } catch { /* provider is already detached */ }
    }, delay);
    request.completionTimer?.unref?.();
  }

  function finishPendingPasskeySelection(entry, requestId, approved) {
    const pending = entry?.pendingSitePasskeySelections?.get(requestId);
    if (!pending) return false;
    entry.pendingSitePasskeySelections.delete(requestId);
    try {
      if (approved) pending.approve();
      else pending.cancel();
    } catch { /* Electron invalidated the chooser callback */ }
    return true;
  }

  function cancelSitePasskeyRequests(entry, errorName = 'AbortError') {
    if (!entry?.sitePasskeyRequests?.size) return;
    for (const [requestId, meta] of entry.sitePasskeyRequests) {
      clearSitePasskeyCompletionTimer(meta);
      finishPendingPasskeySelection(entry, requestId, false);
      if (meta.controlled && meta.controlState !== 'cancel') controlSitePasskeyRequest(entry, requestId, 'cancel');
      try {
        websitePasskeyProvider?.settle?.({ webContents: entry.view?.webContents, requestId });
      } catch { /* provider is already detached */ }
      sendTo(entry, 'webauthn-request', {
        phase: 'settled',
        requestId,
        action: meta.action,
        rpId: meta.rpId,
        conditional: meta.conditional,
        attachment: meta.attachment,
        provider: meta.provider,
        success: false,
        errorName
      });
    }
    entry.sitePasskeyRequests.clear();
  }

  function viewKey(event, tabId) {
    const senderId = event && event.sender && typeof event.sender.id === 'number' ? event.sender.id : null;
    return senderId === null ? String(tabId) : `wc${senderId}:${tabId}`;
  }

  function resolveHost(event) {
    const hostWc = (event && event.sender) || null;
    let hostWin = null;
    if (hostWc && typeof getWindowForWebContents === 'function') {
      try { hostWin = getWindowForWebContents(hostWc) || null; } catch { hostWin = null; }
    }
    if (!hostWin) hostWin = getMainWindow();
    return { hostWc, hostWin };
  }

  function sendTo(entry, type, payload = {}) {
    const message = { tabId: entry.tabId, type, ...payload };
    const wc = entry.hostWc && !entry.hostWc.isDestroyed?.() ? entry.hostWc : null;
    if (wc) {
      wc.send(WEBVIEW_EVENT_CHANNEL, message);
      return;
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(WEBVIEW_EVENT_CHANNEL, message);
  }

  function providerForAuthUrl(rawUrl) {
    const parsed = parseBoundedAuthUrl(rawUrl);
    const host = parsed?.hostname?.toLowerCase() || '';
    if (host === 'accounts.google.com') return 'google';
    if (host === 'appleid.apple.com') return 'apple';
    if (host === 'login.live.com' || host === 'login.microsoftonline.com' || host.endsWith('.login.microsoftonline.com')) return 'microsoft';
    return 'identity-provider';
  }

  /**
   * Ask the renderer to start Yayra's own verified Google OAuth loop. Only
   * provider/reason metadata crosses IPC: a captured ServiceLogin URL may
   * carry opaque continuation data and is never echoed into renderer events.
   */
  function requestYayraGoogleAccountConnection(entry, reason = 'navigation') {
    if (!entry) return false;
    sendTo(entry, 'google-account-auth-required', { provider: 'google', reason });
    return true;
  }

  /**
   * Open a recognized third-party auth URL in the OS external user-agent.
   * Only provider metadata crosses IPC afterwards; the authorization URL
   * (which can contain state and a PKCE challenge) is not echoed to renderer
   * code or logs.
   */
  async function openAuthInSystemBrowser(entry, rawUrl, reason = 'navigation') {
    if (!entry || !requiresSystemBrowserAuth(rawUrl, authHosts)) return false;
    const externalUrl = secureSystemBrowserAuthUrl(rawUrl, authHosts);
    const provider = providerForAuthUrl(externalUrl);
    try {
      await shell.openExternal(externalUrl);
      sendTo(entry, 'system-browser-handoff', { provider, reason });
      return true;
    } catch (error) {
      logger.error?.(`[yayra:webview] failed to open ${provider} authentication in the system browser: ${error?.message || error}`);
      sendTo(entry, 'system-browser-handoff-failed', { provider, reason });
      return false;
    }
  }

  async function routeAuthentication(entry, rawUrl, reason = 'navigation') {
    if (entry?.isPrivate && requiresYayraGoogleAccountConnection(rawUrl)) {
      // OAuth/API capabilities are durable and profile-scoped, so a private
      // tab must not create them. Hand the Google destination to the normal
      // system browser without opening the persistent Yayra Chrome profile.
      const target = safeGoogleDestination(rawUrl) || 'https://accounts.google.com/ServiceLogin';
      try {
        await shell.openExternal(target);
        sendTo(entry, 'system-browser-handoff', { provider: 'google', reason });
        return 'external';
      } catch {
        sendTo(entry, 'system-browser-handoff-failed', { provider: 'google', reason });
        return 'failed';
      }
    }
    if (requiresYayraGoogleAccountConnection(rawUrl)) {
      requestYayraGoogleAccountConnection(entry, reason);
      return 'yayra-google-account';
    }
    return (await openAuthInSystemBrowser(entry, rawUrl, reason)) ? 'external' : 'failed';
  }

  function entryForWebAuthnFrame(ses, frame) {
    let target = null;
    try { target = frame?.top || frame || null; } catch { return null; }
    if (!target) return null;
    for (const entry of views.values()) {
      const wc = entry.view?.webContents;
      if (!wc || wc.session !== ses) continue;
      try {
        if (wc.mainFrame === target || wc.mainFrame?.framesInSubtree?.includes?.(target)) return entry;
      } catch { /* frame navigated while the chooser opened */ }
    }
    return null;
  }

  function passkeyAccountLabel(account, index) {
    const clean = (value) => String(value || '')
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gi, '')
      .trim()
      .slice(0, 96);
    const displayName = clean(account?.displayName);
    const name = clean(account?.name);
    if (displayName && name && displayName !== name) return `${displayName} (${name})`;
    return displayName || name || `Passkey ${index + 1}`;
  }

  function installWebAuthnAccountChooser(ses) {
    if (!ses || typeof ses.on !== 'function' || webAuthnSessionListeners.has(ses)) return;
    const listener = (_event, details = {}, callback) => {
      // Parity item 4: on Google auth surfaces let Chromium's own WebAuthn
      // account chooser run. Yayra's virtual passkey provider / account sheet
      // is an app-controlled intermediary that Google can detect, and it can
      // break Google's own passkey and 2FA challenges.
      const authFrameEntry = entryForWebAuthnFrame(ses, details?.frame);
      if (authFrameEntry && isAuthSurfaceEntry(authFrameEntry)) {
        // Electron's select-webauthn-account callback is app-mediated. Do not
        // show Yayra's own account chooser on Google sign-in; cancel this
        // embedded attempt and move the current Google page to real Chrome,
        // whose native passkey/password-manager UI is the supported path.
        const currentUrl = currentUrlForEntry(authFrameEntry);
        const fallback = openChromeProfileFallback(authFrameEntry, currentUrl, 'google-webauthn-native-fallback');
        sendTo(authFrameEntry, 'google-webauthn-fallback', {
          origin: safeOriginForUrl(currentUrl),
          fallbackOpened: fallback.opened,
          chromeProfileOpened: fallback.chromeProfileOpened
        });
        try { callback(undefined); } catch { /* request expired */ }
        return;
      }
      let completed = false;
      let entry = null;
      let requestId = '';
      let requestMeta = null;
      let chooserTimer = null;
      const finish = (credentialId = undefined) => {
        if (completed) return;
        if (chooserTimer) clearTimeout(chooserTimer);
        chooserTimer = null;
        const selectedId = typeof credentialId === 'string' ? credentialId : undefined;
        // Conditional mediation must run far enough for Chromium to discover
        // resident accounts before Yayra can show a chooser. Once an account
        // is picked, however, do not return it to Chromium while the virtual
        // authenticator still reports no presence: that CTAP command would be
        // left pending and cannot be revived by toggling presence later.
        if (selectedId && entry && requestId && websitePasskeyInfo(entry, requestMeta).mode === 'local') {
          completed = true;
          // Explicit requests are already Yayra-verified before Chromium can
          // discover resident accounts. Return the user's chosen credential
          // immediately and restart the short completion watchdog. Conditional
          // autofill discovers accounts before verification, so it remains
          // deferred behind the trusted toolbar action below.
          if (requestMeta?.userVerified) {
            try { callback(selectedId); } catch { /* request expired */ }
            armSitePasskeyCompletionTimer(entry, requestMeta);
            return;
          }
          entry.pendingSitePasskeySelections ||= new Map();
          finishPendingPasskeySelection(entry, requestId, false);
          let finalized = false;
          const complete = (approved) => {
            if (finalized) return;
            finalized = true;
            try { callback(approved ? selectedId : undefined); } catch { /* request expired */ }
          };
          entry.pendingSitePasskeySelections.set(requestId, {
            approve: () => complete(true),
            cancel: () => complete(false)
          });
          return;
        }
        completed = true;
        try { callback(selectedId); } catch { /* request expired */ }
        if (entry && requestMeta?.userVerified) armSitePasskeyCompletionTimer(entry, requestMeta);
      };
      const accounts = (Array.isArray(details.accounts) ? details.accounts : [])
        .filter((account) => typeof account?.credentialId === 'string'
          && account.credentialId.length > 0 && account.credentialId.length <= 4096);
      if (!accounts.length) { finish(); return; }

      const rawRelyingPartyId = typeof details.relyingPartyId === 'string'
        ? details.relyingPartyId.trim().toLowerCase()
        : '';
      const relyingPartyId = rawRelyingPartyId.length <= 253 && /^[a-z0-9.-]+$/i.test(rawRelyingPartyId)
        ? rawRelyingPartyId
        : 'this site';
      entry = entryForWebAuthnFrame(ses, details.frame);
      // Electron documents a null frame after navigation/destruction. Do not
      // attach an account chooser to an unrelated tab/window in that race.
      if (!entry) { finish(); return; }
      for (const [candidateId, meta] of entry.sitePasskeyRequests || []) {
        if (meta?.action !== 'get' || meta.rpId !== relyingPartyId) continue;
        // Prefer the conditional request that caused account discovery, but
        // retain explicit get() metadata too so its account-sheet delay can be
        // bounded and its already-completed Yayra verification reused.
        if (!requestMeta || meta.conditional === true) {
          requestId = candidateId;
          requestMeta = meta;
        }
        if (meta.conditional === true) break;
      }
      if (requestMeta?.conditional) {
        requestMeta.conditional = false;
      }
      if (requestMeta?.userVerified) clearSitePasskeyCompletionTimer(requestMeta);
      sendTo(entry, 'webauthn-account-selection', {
        relyingPartyId,
        accountCount: accounts.length,
        ...(requestId ? { requestId } : {})
      });
      const owner = entry.hostWin && !entry.hostWin.isDestroyed?.() ? entry.hostWin : getMainWindow();
      chooserTimer = setTimeout(() => finish(), 55_000);
      chooserTimer?.unref?.();

      // Match a mainstream browser's account sheet. The WebAuthn operation
      // remains pending until one callback is made, so every error/cancel
      // path below funnels through finish() exactly once.
      if (dialog && typeof dialog.showMessageBox === 'function' && accounts.length <= 8) {
        const labels = accounts.map(passkeyAccountLabel);
        const cancelId = labels.length;
        const options = {
          type: 'question',
          title: 'Choose a passkey',
          message: `Choose a passkey for ${relyingPartyId}`,
          detail: 'The site requested a discoverable passkey. Yayra will send only your selected credential to the site’s secure WebAuthn ceremony.',
          buttons: [...labels, 'Cancel'],
          defaultId: 0,
          cancelId,
          noLink: true
        };
        let prompt;
        try {
          prompt = owner && !owner.isDestroyed?.()
            ? dialog.showMessageBox(owner, options)
            : dialog.showMessageBox(options);
        } catch (err) {
          logger.warn?.(`[yayra:webauthn] account chooser failed: ${err?.message || err}`);
          finish();
          return;
        }
        Promise.resolve(prompt).then((result) => {
          const index = Number(result?.response);
          finish(Number.isInteger(index) && index >= 0 && index < accounts.length
            ? accounts[index].credentialId
            : undefined);
        }, () => finish());
        return;
      }

      if (Menu && typeof Menu.buildFromTemplate === 'function') {
        try {
          const template = [
            { label: `Choose a passkey for ${relyingPartyId}`, enabled: false },
            { type: 'separator' },
            ...accounts.map((account, index) => ({
              label: passkeyAccountLabel(account, index),
              click: () => finish(account.credentialId)
            })),
            { type: 'separator' },
            { label: 'Cancel', click: () => finish() }
          ];
          const menu = Menu.buildFromTemplate(template);
          popupMenuWithRecovery({
            menu,
            window: owner && !owner.isDestroyed?.() ? owner : null,
            callback: () => finish()
          });
          return;
        } catch (err) {
          logger.warn?.(`[yayra:webauthn] account menu failed: ${err?.message || err}`);
        }
      }

      // A single unambiguous account remains usable in stripped-down hosts
      // without dialog/Menu implementations. Never guess among many users.
      finish(accounts.length === 1 ? accounts[0].credentialId : undefined);
    };
    webAuthnSessionListeners.set(ses, listener);
    ses.on('select-webauthn-account', listener);
  }

  function navState(webContents) {
    return {
      canGoBack: historyCanGoBack(webContents),
      canGoForward: historyCanGoForward(webContents),
      // Engine-truth loading state rides along with every navigation so
      // the renderer's optimistic X/refresh toggle can self-correct.
      isLoading: typeof webContents.isLoading === 'function' ? Boolean(webContents.isLoading()) : undefined
    };
  }

  function removePointerCss(target, key, wc) {
    const owner = target && typeof target.removeInsertedCSS === 'function' ? target : wc;
    if (!owner || typeof owner.removeInsertedCSS !== 'function' || !key) return;
    try {
      const result = owner.removeInsertedCSS(key);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* a navigated frame may have already discarded its style */ }
  }

  function pageFrames(webContents) {
    const frames = [];
    const seen = new Set();
    try {
      const mainFrame = webContents?.mainFrame;
      if (mainFrame) {
        frames.push(mainFrame);
        seen.add(mainFrame);
      }
      const subtree = mainFrame?.framesInSubtree;
      if (subtree && typeof subtree[Symbol.iterator] === 'function') {
        for (const frame of subtree) {
          if (frame && !seen.has(frame)) {
            frames.push(frame);
            seen.add(frame);
          }
        }
      }
    } catch { /* about:blank or a tearing-down frame */ }
    if (!frames.length && webContents) frames.push(webContents);
    return frames;
  }

  function installTextSelectionActions(entry) {
    const wc = entry?.view?.webContents;
    // Parity item 2: no arbitrary page scripts on Google auth surfaces.
    if (!wc || isAuthSurfaceEntry(entry)) return;
    const script = buildTextSelectionActionsScript();
    for (const frame of pageFrames(wc)) {
      if (!frame || typeof frame.executeJavaScript !== 'function') continue;
      try {
        const result = frame.executeJavaScript(script, true);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* progressive enhancement: native Ctrl+C still works */ }
    }
  }

  function installMediaCompatibilityInFrames(entry) {
    const wc = entry?.view?.webContents;
    // Parity item 2: no arbitrary page scripts on Google auth surfaces.
    if (!wc || isAuthSurfaceEntry(entry)) return;
    const script = buildMediaCompatibilityScript();
    for (const frame of pageFrames(wc)) {
      if (!frame || typeof frame.executeJavaScript !== 'function') continue;
      try {
        const result = frame.executeJavaScript(script, true);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* one hostile frame must not affect its tab or sibling frames */ }
    }
  }

  function executePointerThemeFallback(frames, theme, size) {
    const script = buildPointerThemeScript(theme, size);
    for (const frame of frames) {
      if (!frame || typeof frame.executeJavaScript !== 'function') continue;
      try {
        const result = frame.executeJavaScript(script, true);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* best-effort fallback for older Electron surfaces */ }
    }
  }

  function executePointerTextCursorFallback(frames, theme) {
    const script = buildPointerTextCursorScript(theme);
    for (const frame of frames) {
      if (!frame || typeof frame.executeJavaScript !== 'function') continue;
      try {
        const result = frame.executeJavaScript(script, true);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* keep cursor enhancement best-effort */ }
    }
  }

  function applyPointerThemeToPage(entry) {
    const wc = entry && entry.view && entry.view.webContents;
    // Google auth parity keeps the page completely untouched, including
    // Yayra's user stylesheet and cursor scripts.
    if (!wc || isAuthSurfaceEntry(entry)) return;

    const frames = pageFrames(wc);

    const theme = entry.pointerTheme === 'yayra' || entry.pointerTheme === 'high-visibility'
      ? entry.pointerTheme
      : 'system';
    const size = entry.pointerSize === 'large' || entry.pointerSize === 'xlarge'
      ? entry.pointerSize
      : 'normal';
    // CSS alone cannot distinguish a text node from blank space in a div.
    // Use Chromium's caret hit-test in every frame to apply an I-beam only
    // over selectable non-interactive text, including cross-origin frames.
    executePointerTextCursorFallback(frames, theme);
    const revision = (entry.pointerCssRevision || 0) + 1;
    entry.pointerCssRevision = revision;
    const installed = entry.pointerCssEntries || new Map();
    entry.pointerCssEntries = installed;

    // User-origin CSS is installed by Chromium rather than as a page-owned
    // <style> tag, so the site's style-src CSP cannot block the stylesheet;
    // user-important rules also outrank site cursor declarations. Prefer
    // per-frame insertion where Electron exposes it. The WebContents API
    // styles the main page; nonce-aware page injection supplements child
    // frames and did-frame-finish-load reapplies after navigation. A child
    // frame without a usable nonce, or a site that blocks data-backed cursor
    // images, can still prevent the custom graphic from rendering.
    const frameTargets = frames.filter((frame) => typeof frame.insertCSS === 'function');
    let targets = [];
    if (frames.length > 0 && frameTargets.length === frames.length) targets = frameTargets;
    else if (typeof wc.insertCSS === 'function') targets = [wc];
    else if (frameTargets.length > 0) targets = frameTargets;

    if (theme === 'system') {
      const previous = Array.from(installed.entries());
      installed.clear();
      for (const [target, key] of previous) removePointerCss(target, key, wc);
      // Remove a page-owned stylesheet left by older/limited Electron APIs.
      executePointerThemeFallback(frames, 'system', size);
      return;
    }

    if (!targets.length) {
      executePointerThemeFallback(frames, theme, size);
      return;
    }

    const css = buildPointerThemeCss(theme, size);
    for (const [target, oldKey] of Array.from(installed.entries())) {
      if (!targets.includes(target)) {
        installed.delete(target);
        removePointerCss(target, oldKey, wc);
      }
    }

    for (const target of targets) {
      let insertion;
      try { insertion = target.insertCSS(css, { cssOrigin: 'user' }); }
      catch {
        executePointerThemeFallback(frames, theme, size);
        continue;
      }
      Promise.resolve(insertion).then((key) => {
        if (!key) return;
        // A quick theme change/navigation may finish a prior insertion late.
        // Remove stale CSS instead of allowing it to override the new choice.
        if (entry.pointerCssRevision !== revision || entry.pointerTheme !== theme || entry.pointerSize !== size) {
          removePointerCss(target, key, wc);
          return;
        }
        const previousKey = installed.get(target);
        installed.set(target, key);
        if (previousKey && previousKey !== key) removePointerCss(target, previousKey, wc);
      }).catch(() => executePointerThemeFallback(frames, theme, size));
    }
    if (targets.includes(wc) && wc.mainFrame) {
      executePointerThemeFallback(frames.filter((frame) => frame !== wc.mainFrame), theme, size);
    }
  }

  function attachListeners(key, entry) {
    const wc = entry.view.webContents;
    // Passkey/WebAuthn stuck-request watchdog - injected into the page's
    // MAIN world on every document (see buildWebAuthnWatchdogScript for
    // the full rationale). Guarded: test fakes may not implement
    // executeJavaScript.
    wc.on('dom-ready', () => {
      // Parity items 2 + 4: on Google auth surfaces Yayra injects NOTHING
      // into the page - no text-selection shim, no account marker, no WebAuthn
      // watchdog, no Google-Search thinking watchdog, no media shim, and no
      // pointer-theme CSS. Google's native WebAuthn/passkey flow runs
      // untouched. Only the main-process CDP metadata override (which is not
      // a page script) is applied, and only when the host opted in.
      if (isAuthSurfaceEntry(entry)) {
        // Remove Yayra's Linux software platform authenticator first: it uses
        // the same CDP debugger the UA-metadata override needs, and a virtual
        // authenticator is itself a detectable non-native WebAuthn signal.
        try { websitePasskeyProvider?.detach?.(wc); } catch { /* optional host */ }
        if (typeof applyGoogleAuthUserAgentMetadata === 'function') {
          Promise.resolve(applyGoogleAuthUserAgentMetadata(wc, {
            userAgent: buildBrowserUserAgent()
          })).catch(() => {});
        }
        emitAuthSurfaceState(entry, currentUrlForEntry(entry));
        return;
      }
      emitAuthSurfaceState(entry, currentUrlForEntry(entry));
      if (entry.pointerTheme !== 'system') applyPointerThemeToPage(entry);
      installTextSelectionActions(entry);
      injectGoogleServiceAccount(entry);
      if (typeof wc.executeJavaScript === 'function') {
        const watchdogs = [
          buildWebAuthnWatchdogScript(),
          buildGoogleSearchThinkingWatchdogScript(),
          // Match Firefox-grade media resilience: recover Cloudinary format
          // mismatches and retire decorative broken-image glyphs without
          // changing meaningful image alt text or the site's chosen design.
          buildMediaCompatibilityScript()
        ].join('\n');
        wc.executeJavaScript(watchdogs, true).catch(() => {});
      }
    });
    // Apply page-level enhancements to cross-origin child frames as each one
    // finishes loading; a main-frame script/style cannot cross an iframe
    // boundary. Each installer is idempotent inside its own frame.
    wc.on('did-frame-finish-load', () => {
      if (entry.pointerTheme !== 'system') applyPointerThemeToPage(entry);
      installTextSelectionActions(entry);
      installMediaCompatibilityInFrames(entry);
    });
    // Reload shortcuts pressed while the PAGE has focus (which is most
    // of the time): the guest WebContents swallows keystrokes, so
    // Ctrl+R / Ctrl+Shift+R / F5 / Ctrl+F5 must be caught here. Hard
    // reloads genuinely clear this site's caches first (Chrome parity).
    wc.on('before-input-event', (event, input) => {
      const action = reloadActionForInput(input);
      if (!action) return;
      event.preventDefault();
      if (action === 'hard-reload') {
        hardReload(key).then((res) => {
          sendTo(entry, 'hard-reloaded', { origin: (res && res.origin) || null });
        }).catch(() => {});
      } else {
        wc.reload();
      }
    });
    wc.on('unresponsive', () => {
      const newlyUnresponsive = !entry.pageUnresponsive;
      entry.pageUnresponsive = true;
      if (entry.pageUnresponsiveReloadTimer !== null) {
        if (newlyUnresponsive) sendTo(entry, 'page-unresponsive', { url: wc.getURL?.() || entry.lastUrl || '', recoveryScheduled: true });
        return;
      }
      const lastReload = entry.lastPageUnresponsiveReloadAt || 0;
      const recoveryScheduled = !(lastReload && Date.now() - lastReload < pageUnresponsiveReloadCooldownMs);
      if (newlyUnresponsive) {
        sendTo(entry, 'page-unresponsive', { url: wc.getURL?.() || entry.lastUrl || '', recoveryScheduled });
      }
      if (!recoveryScheduled) return;

      // The shell remains usable while an individual site renderer hangs.
      // Give Chromium a short chance to recover itself before reloading only
      // that tab. This is delayed and rate-limited to avoid disrupting slow
      // but healthy pages or creating a reload loop.
      entry.pageUnresponsiveReloadTimer = setTimeout(() => {
        entry.pageUnresponsiveReloadTimer = null;
        if (!entry.pageUnresponsive || wc.isDestroyed?.()) return;
        const now = Date.now();
        if (entry.lastPageUnresponsiveReloadAt && now - entry.lastPageUnresponsiveReloadAt < pageUnresponsiveReloadCooldownMs) return;
        entry.lastPageUnresponsiveReloadAt = now;
        logger.warn?.(`[yayra:webview] page renderer unresponsive in tab ${entry.tabId}; reloading that page`);
        sendTo(entry, 'page-recovery-start', { url: wc.getURL?.() || entry.lastUrl || '', reason: 'unresponsive-page' });
        try { wc.reload(); }
        catch (err) {
          logger.error?.(`[yayra:webview] failed to recover unresponsive tab ${entry.tabId}`, err);
          sendTo(entry, 'page-recovery-failed', { url: wc.getURL?.() || entry.lastUrl || '' });
        }
      }, pageUnresponsiveReloadDelayMs);
      entry.pageUnresponsiveReloadTimer?.unref?.();
    });
    wc.on('responsive', () => {
      const wasUnresponsive = entry.pageUnresponsive;
      cancelPageUnresponsiveReload(entry);
      if (wasUnresponsive) sendTo(entry, 'page-responsive', { url: wc.getURL?.() || entry.lastUrl || '' });
    });
    wc.on('did-start-loading', () => {
      // Each top-level loading generation must prove itself independently.
      // Electron can emit did-finish-load for its own network error document
      // after did-fail-load, so the failure listener below latches that state.
      entry.loadGeneration += 1;
      cancelDownloadFailureTimer(entry);
      entry.mainFrameFailed = false;
      // A user-initiated reload/navigation is already the recovery action.
      const wasUnresponsive = entry.pageUnresponsive;
      cancelPageUnresponsiveReload(entry);
      cancelSitePasskeyRequests(entry, 'AbortError');
      if (wasUnresponsive) sendTo(entry, 'page-recovery-start', { url: wc.getURL?.() || entry.lastUrl || '', reason: 'navigation' });
      sendTo(entry, 'loading-start');
    });
    wc.on('did-stop-loading', () => sendTo(entry, 'loading-stop'));
    // did-stop-loading also follows failed navigations, so it cannot prove a
    // recovery succeeded. Electron may additionally finish Chromium's own
    // error document after did-fail-load; only an unfailed loading generation
    // is a positive main-frame signal that can retire recovery UI.
    wc.on('did-finish-load', () => {
      if (entry.mainFrameFailed) return;
      const url = wc.getURL?.() || entry.lastUrl || entry.requestedUrl || '';
      injectGoogleServiceAccount(entry);
      sendTo(entry, 'load-succeeded', { url });
    });
    const handoffAuthNavigation = (...args) => {
      const event = args[0];
      // Electron 44 exposes navigation details on the event (or as a details
      // object); keep accepting the legacy positional signature used by older
      // Electron releases and test fakes.
      const details = args.find((value) => value && typeof value === 'object' && typeof value.url === 'string');
      const url = details?.url || args.find((value, index) => index > 0 && typeof value === 'string') || '';
      const isMainFrame = typeof details?.isMainFrame === 'boolean'
        ? details.isMainFrame
        : (typeof args[3] === 'boolean' ? args[3] : true);
      if (!isMainFrame) return;
      // Parity: allow first-party Google sign-in to load natively in Yayra's
      // persistent per-profile session when the user opted in. Third-party
      // OAuth (a different site's client_id/callback) is NEVER allowed here.
      if (allowNativeGoogleSignIn(url, entry?.profileId, entry?.isPrivate)) {
        if (isGoogleAuthSurface(url)) {
          // This is a page-initiated navigation (not ensureView). Retire the
          // virtual authenticator before the auth document commits, and
          // preconfigure the honest UAData metadata. Chromium's own native
          // passkey behavior is then used for the Google challenge.
          try { websitePasskeyProvider?.detach?.(wc); } catch { /* optional host */ }
          entry.websitePasskeyReady = null;
          if (typeof applyGoogleAuthUserAgentMetadata === 'function') {
            try {
              Promise.resolve(applyGoogleAuthUserAgentMetadata(wc, {
                userAgent: buildBrowserUserAgent()
              })).catch(() => {});
            } catch { /* header-level hints remain active */ }
          }
        }
        return;
      }
      if (!requiresSystemBrowserAuth(url, authHosts)
        && !requiresYayraGoogleAccountConnection(url)) return;

      event?.preventDefault?.();
      // Prevent the canceled navigation from leaving a stale loading spinner
      // in the original tab. No URL/history event is emitted: the in-app page
      // stays where it was before the provider redirect. Third-party OAuth is
      // external; first-party Google account entry starts Yayra's callback-
      // returning OAuth loop instead of abandoning the app session.
      sendTo(entry, 'loading-stop');
      void routeAuthentication(entry, url, 'navigation');
    };
    wc.on('will-navigate', handoffAuthNavigation);
    wc.on('will-redirect', handoffAuthNavigation);
    wc.on('did-navigate', (_event, url) => {
      entry.lastUrl = url;
      // Parity item 6: Google rejected the in-Yayra attempt -> open a fresh
      // ServiceLogin entry point in the dedicated real Chrome profile.
      if (handleRejectedSignIn(entry, url)) return;
      rejectedSignInByEntry.delete(entry);
      // Parity item 5: surface a main-process-verified origin to Yayra's
      // browser chrome so the user can see exactly who they are signing into.
      // Only the origin crosses IPC - never the full URL, query, or tokens.
      // Emitted only on state change (see emitAuthSurfaceState).
      emitAuthSurfaceState(entry, url);
      sendTo(entry, 'navigated', { url, ...navState(wc) });
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      entry.lastUrl = url;
      injectGoogleServiceAccount(entry);
      sendTo(entry, 'navigated', { url, ...navState(wc) });
    });
    wc.on('page-title-updated', (_event, title) => sendTo(entry, 'title-updated', { title }));
    wc.on('page-favicon-updated', (_event, favicons) => {
      sendTo(entry, 'favicon-updated', { favicon: (favicons && favicons[0]) || null });
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED: almost always a navigation superseded by another
      // one (e.g. the user typed a new URL before the previous one settled)
      // and is not a real failure worth surfacing.
      if (!isMainFrame || errorCode === -3) return;
      const failure = { errorCode, errorDescription, url: validatedUrl };
      // Drive's successful Content-Disposition handoff is surfaced by
      // Electron as ERR_FAILED (-2). Give will-download a short correlation
      // window; if no download arrives the genuine failure still appears.
      if (errorCode === -2 && deferGoogleDownloadFailure(entry, failure)) return;
      entry.mainFrameFailed = true;
      sendTo(entry, 'fail-load', failure);
    });
    // Chrome-equivalent native right-click menu. A WebContentsView (unlike
    // a plain <webview> tag) shows NO context menu at all by default, so
    // without this, right-clicking any real website inside Yayra would
    // silently do nothing.
    wc.on('context-menu', (_event, params) => {
      if (!Menu) return;
      const template = buildContextMenuTemplate({
        params,
        wc,
        tabId: entry.tabId,
        send: (tabId, type, payload) => sendTo(entry, type, payload),
        clipboard: clipboard || { writeText: () => {} }
      });
      const win = (entry.hostWin && !entry.hostWin.isDestroyed?.()) ? entry.hostWin : getMainWindow();
      if (!win || win.isDestroyed()) return;
      popupMenuWithRecovery({ menu: Menu.buildFromTemplate(template), window: win });
    });
    wc.setWindowOpenHandler((openDetails = {}) => {
      const { url } = openDetails;
      // Selection highlighting is handled locally: the injected page script
      // paints the live range, then sends bounded text/source metadata to the
      // browser shell for profile-owned persistence. It must never navigate.
      try {
        const requested = new URL(String(url || ''));
        if (requested.protocol === 'yayra:' && requested.hostname === 'selection-highlight') {
          sendTo(entry, 'selection-highlight', {
            text: (requested.searchParams.get('text') || '').slice(0, 2000),
            sourceUrl: String(wc.getURL?.() || entry.lastUrl || '').slice(0, 4000),
            sourceTitle: String(wc.getTitle?.() || '').slice(0, 300),
            highlightColor: '#ffe08a'
          });
          return { action: 'deny' };
        }
      } catch { /* continue through normal popup handling */ }
      // In-page WebAuthn helper asking to reopen this page in the user's
      // real browser (where phone/synced passkeys actually work).
      const externalTarget = decodeOpenExternalRequest(url);
      if (externalTarget) {
        shell.openExternal(externalTarget).catch((err) => logger.error('[yayra:webview] failed to open external url', err));
        sendTo(entry, 'system-browser-handoff', { url: externalTarget });
        return { action: 'deny' };
      }
      if (!allowNativeGoogleSignIn(url, entry?.profileId, entry?.isPrivate)
        && (requiresSystemBrowserAuth(url, authHosts) || requiresYayraGoogleAccountConnection(url))) {
        void routeAuthentication(entry, url, 'popup');
        return { action: 'deny' };
      }
      const policy = privacyPolicyForEntry(entry);
      const disposition = String(openDetails.disposition || '');
      if (!policy.allowWebsitePopups && disposition
        && !['foreground-tab', 'background-tab', 'new-window'].includes(disposition)) {
        sendTo(entry, 'popup-blocked', { url: '' });
        return { action: 'deny' };
      }
      // Let the renderer decide (usually: open as a new Yayra tab).
      sendTo(entry, 'new-window-request', { url });
      return { action: 'deny' };
    });
  }

  // Browser profiles: each non-default profile gets its OWN persistent
  // Chromium session partition, so cookies, logins, storage and caches are
  // fully separated per person (the Chrome "profiles" model). The default
  // profile keeps the legacy partition name so existing users' sessions
  // survive the upgrade. Incognito stays per-tab and in-memory, unchanged.
  function partitionForProfile(profileId) {
    const id = String(profileId || 'default');
    if (id === 'default') return 'persist:yayra-webview';
    return `persist:yayra-profile-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }

  function createView(key, tabId, isPrivate, hostWc, hostWin, profileId = 'default', initialUrl = '') {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: isPrivate ? `incognito-${tabId}` : partitionForProfile(profileId),
        ...(autofillPreloadPath ? { preload: autofillPreloadPath } : {})
      }
    });
    if (typeof view.webContents.setUserAgent === 'function') {
      view.webContents.setUserAgent(buildBrowserUserAgent());
    }
    // Install before loadURL/cache lookup. Privacy enforcement and Cloudinary
    // media compatibility share one composed WebRequest listener per Session;
    // Electron would otherwise let the later registration replace the first.
    const normalizedProfileId = String(profileId || 'default');
    const hostPolicy = hostWc ? privacyPolicyByHost.get(hostWc) : null;
    if (hostPolicy) privacyPolicyByProfile.set(normalizedProfileId, hostPolicy);
    installMediaCompatibility(
      view.webContents.session,
      logger,
      buildPrivacyRequestPolicy(normalizedProfileId)
    );
    try { attachDownloadSession?.(view.webContents.session); } catch { /* download tracking remains optional */ }
    // Pre-paint background: Chromium's default surface is WHITE, which
    // flashes whenever a view is created/hidden/resized inside Yayra's
    // dark chrome. Pages paint their own background the moment they
    // render, so this only affects the un-painted instants.
    if (typeof view.setBackgroundColor === 'function') {
      try { view.setBackgroundColor('#101218'); } catch { /* older electron */ }
    }
    const entry = {
      key,
      view,
      lastUrl: null,
      tabId,
      hostWc,
      hostWin,
      isPrivate: Boolean(isPrivate),
      profileId: normalizedProfileId,
      requestedUrl: null,
      mainFrameFailed: false,
      loadGeneration: 0,
      downloadFailureTimer: null,
      lastDownloadHandoffAt: 0,
      lastDownloadUrl: '',
      pointerTheme: 'system',
      pointerSize: 'normal',
      pageUnresponsive: false,
      pageUnresponsiveReloadTimer: null,
      lastPageUnresponsiveReloadAt: 0
    };
    views.set(key, entry);
    entriesByWebContents.set(view.webContents, entry);
    try {
      const webContentsId = Number(view.webContents.id);
      if (Number.isInteger(webContentsId)) entriesByWebContentsId.set(webContentsId, entry);
    } catch { /* test fakes may not expose an id */ }
    installWebsitePermissionPolicy(view.webContents.session);
    const privacyPolicy = privacyPolicyForEntry(entry);
    if (typeof view.webContents.setJavaScriptEnabled === 'function') {
      try { view.webContents.setJavaScriptEnabled(privacyPolicy.javascriptEnabled !== false); } catch { /* unsupported host */ }
    }
    const initialGoogleAuthSurface = parityEnabled(entry.profileId) && isGoogleAuthSurface(initialUrl);
    if (initialGoogleAuthSurface && typeof applyGoogleAuthUserAgentMetadata === 'function') {
      // Set navigator.userAgentData metadata before the first Google page
      // script runs. The header-level client hints are installed in the
      // Session listener and do not need CDP.
      try {
        entry.googleAuthMetadataReady = Promise.resolve(applyGoogleAuthUserAgentMetadata(view.webContents, {
          userAgent: buildBrowserUserAgent()
        })).catch(() => false);
      } catch { entry.googleAuthMetadataReady = Promise.resolve(false); }
    }
    // Never attach Yayra's virtual authenticator to the initial Google
    // sign-in document. The native Chromium WebAuthn implementation must be
    // present from the first document script onward.
    if (!initialGoogleAuthSurface && websitePasskeyProvider && typeof websitePasskeyProvider.attach === 'function') {
      try {
        entry.websitePasskeyReady = Promise.resolve(websitePasskeyProvider.attach({
          webContents: view.webContents,
          profileId: entry.profileId,
          isPrivate: entry.isPrivate
        })).catch((error) => {
          logger.warn?.(`[yayra:site-passkeys] provider attach failed: ${error?.message || error}`);
          return { ok: false, reason: 'provider-unavailable' };
        });
      } catch (error) {
        logger.warn?.(`[yayra:site-passkeys] provider attach failed: ${error?.message || error}`);
      }
    }
    installWebAuthnAccountChooser(view.webContents.session);
    attachListeners(key, entry);
    return entry;
  }

  async function ensureView(key, tabId, url, {
    isPrivate = false,
    hostWc = null,
    hostWin = null,
    profileId = 'default',
    pointerTheme = 'system',
    pointerSize = 'normal'
  } = {}) {
    const win = (hostWin && !hostWin.isDestroyed?.()) ? hostWin : getMainWindow();
    if (!win || win.isDestroyed() || !tabId || !url) return { handedOffToSystemBrowser: false };

    // Parity: when the user opted in, load first-party Google sign-in and
    // Google Account pages in this view's persistent per-profile session so
    // Google can accept them as a standalone browser. If Google rejects, the
    // did-navigate handler opens the dedicated Chrome profile instead.
    const nativeGoogleAllowed = allowNativeGoogleSignIn(url, profileId, isPrivate);

    if (!nativeGoogleAllowed && requiresYayraGoogleAccountConnection(url)) {
      if (isPrivate) {
        const mode = await routeAuthentication({ tabId, hostWc, isPrivate: true }, url, 'direct-navigation');
        return { handedOffToSystemBrowser: mode === 'external' };
      }
      // Root/Manage Account/first-party login cannot establish a Google
      // website cookie in this isolated partition. Request Yayra's callback-
      // returning OAuth flow instead; unlike the old raw ServiceLogin handoff,
      // this can update the account avatar/session when the user comes back.
      requestYayraGoogleAccountConnection({ tabId, hostWc }, 'direct-navigation');
      return { handedOffToSystemBrowser: false, googleAccountConnectionRequired: true };
    }

    if (!nativeGoogleAllowed && requiresSystemBrowserAuth(url, authHosts)) {
      // No native website view is needed merely to launch the provider. Use a
      // minimal entry-shaped target so the completion event returns only to
      // the shell window that requested this tab.
      const mode = await routeAuthentication({ tabId, hostWc }, url, 'direct-navigation');
      return { handedOffToSystemBrowser: mode === 'external' };
    }

    let entry = views.get(key);
    // A view created for another profile can't be reused - the partition
    // is fixed at construction. Destroy and recreate in the right one.
    if (entry && !entry.isPrivate && entry.profileId !== String(profileId || 'default')) {
      destroyView(key);
      entry = undefined;
    }
    if (!entry) {
      entry = createView(key, tabId, isPrivate, hostWc, win, profileId, url);
      const configuredBackgroundThrottling = hostWc ? backgroundThrottlingByHost.get(hostWc) : undefined;
      // Live-sites is fail-open: even if the renderer's startup preference
      // IPC raced or an older preload never sent it, background pages keep
      // timers/media/sockets active instead of silently freezing. A user can
      // still explicitly enable throttling from Performance settings.
      const backgroundThrottling = typeof configuredBackgroundThrottling === 'boolean'
        ? configuredBackgroundThrottling
        : false;
      if (typeof entry.view.webContents.setBackgroundThrottling === 'function') {
        try { entry.view.webContents.setBackgroundThrottling(backgroundThrottling); } catch { /* unsupported Electron host */ }
      }
      win.contentView.addChildView(entry.view);
    }

    const nextPointerTheme = pointerTheme === 'yayra' || pointerTheme === 'high-visibility' ? pointerTheme : 'system';
    const nextPointerSize = pointerSize === 'large' || pointerSize === 'xlarge' ? pointerSize : 'normal';
    const pointerChanged = entry.pointerTheme !== nextPointerTheme || entry.pointerSize !== nextPointerSize;
    entry.pointerTheme = nextPointerTheme;
    entry.pointerSize = nextPointerSize;
    if (pointerChanged && entry.lastUrl) applyPointerThemeToPage(entry);

    // The virtual authenticator must exist before any page JavaScript runs.
    // Loading first creates a race where an early navigator.credentials call
    // enters Chromium's silent Linux path and remains stuck even though the
    // provider finishes attaching a few milliseconds later. Keep only the
    // newest URL when rapid navigation arrives while initialization waits.
    entry.requestedUrl = url;
    if (nativeGoogleAllowed && isGoogleAuthSurface(url)) {
      // A reused page view may already have Yayra's Linux virtual
      // authenticator attached. Detach it before starting a Google auth
      // document, then install honest UA metadata before loadURL.
      try { websitePasskeyProvider?.detach?.(entry.view.webContents); } catch { /* optional host */ }
      entry.websitePasskeyReady = null;
      if (!entry.googleAuthMetadataReady && typeof applyGoogleAuthUserAgentMetadata === 'function') {
        try {
          entry.googleAuthMetadataReady = Promise.resolve(applyGoogleAuthUserAgentMetadata(entry.view.webContents, {
            userAgent: buildBrowserUserAgent()
          })).catch(() => false);
        } catch { entry.googleAuthMetadataReady = Promise.resolve(false); }
      }
    }
    if (entry.websitePasskeyReady && !nativeGoogleAllowed) await entry.websitePasskeyReady;
    if (nativeGoogleAllowed && isGoogleAuthSurface(url) && entry.googleAuthMetadataReady) {
      await entry.googleAuthMetadataReady;
    }
    if (entry.requestedUrl !== url) return { handedOffToSystemBrowser: false };

    if (entry.lastUrl !== url) {
      entry.lastUrl = url;
      entry.mainFrameFailed = false;
      entry.view.webContents.loadURL(url).catch((err) => {
        const description = String((err && err.message) || err || 'load failed');
        // Electron rejects a superseded loadURL() with ERR_ABORTED when the
        // user navigates again before it settles. This is expected control
        // flow, not a failed final navigation; did-fail-load also filters -3.
        if (/ERR_ABORTED\s*\(-3\)|net::ERR_ABORTED/i.test(description)) return;
        const failure = { errorCode: -2, errorDescription: description.slice(0, 240), url };
        if (/ERR_FAILED\s*\(-2\)|net::ERR_FAILED/i.test(description)
          && deferGoogleDownloadFailure(entry, failure)) return;
        entry.mainFrameFailed = true;
        let host = '';
        try { host = new URL(url).host; } catch { /* never log full user query text */ }
        logger.error(`[yayra:webview] failed to load ${host || 'page'} (loadURL rejected)`);
        sendTo(entry, 'fail-load', failure);
      });
    }
    return { handedOffToSystemBrowser: false };
  }

  function setPointerTheme(key, theme, size) {
    const entry = views.get(key);
    if (!entry) return { ok: false, reason: 'no-view' };
    const nextTheme = theme === 'yayra' || theme === 'high-visibility' ? theme : 'system';
    const nextSize = size === 'large' || size === 'xlarge' ? size : 'normal';
    if (entry.pointerTheme === nextTheme && entry.pointerSize === nextSize) return { ok: true };
    entry.pointerTheme = nextTheme;
    entry.pointerSize = nextSize;
    if (entry.lastUrl) applyPointerThemeToPage(entry);
    return { ok: true };
  }

  function withView(key, fn) {
    const entry = views.get(key);
    if (!entry) return undefined;
    return fn(entry.view);
  }

  function setBounds(key, bounds) {
    // Main-process enforcement: renderer mistakes/races can shrink the page,
    // but can never place a native website surface over the tab/caption row.
    withView(key, (view) => view.setBounds(sanitizePageBounds(bounds)));
  }

  /**
   * Preserve the page under Yayra overlays at native resolution. The old
   * 1440px / quality-78 JPEG path softened text and made the whole website
   * look deliberately blurred whenever a menu or dialog opened. Electron's
   * NativeImage data URL is lossless PNG, so the snapshot remains pixel-clear
   * while the live sibling surface is temporarily hidden beneath HTML chrome.
   * Capture is still asynchronous and cached per tab, preserving the existing
   * no-freeze lifecycle without applying visual blur or lossy downscaling.
   */
  function snapshotDataUrl(image) {
    return image.toDataURL();
  }

  /**
   * Snapshot the page WITHOUT touching its visibility/bounds. The renderer
   * uses this to paint the still image UNDER its chrome BEFORE asking for
   * the hide - eliminating the blank flash between "native view gone" and
   * "snapshot painted" that the combined hide+capture round-trip had.
   */
  async function capture(key) {
    const entry = views.get(key);
    if (!entry) return undefined;
    const wc = entry.view.webContents;
    if (wc && typeof wc.capturePage === 'function') {
      try {
        const image = await wc.capturePage();
        if (image && typeof image.toDataURL === 'function' && !(typeof image.isEmpty === 'function' && image.isEmpty())) {
          return { snapshot: snapshotDataUrl(image) };
        }
      } catch (err) {
        logger.error?.(`[yayra:webview] capturePage failed for ${key}`, err);
      }
    }
    return undefined;
  }

  async function setVisible(key, visible, { capture = false } = {}) {
    const entry = views.get(key);
    if (!entry) return undefined;
    const view = entry.view;
    if (visible) {
      // Restoring a previously zeroed-out view just needs its real bounds
      // back; the caller (renderer ResizeObserver) sends those right after.
      return undefined;
    }
    // Overlay-aware hiding: the renderer's own chrome (menu drawer, modals,
    // dropdowns) are HTML that a native WebContentsView would otherwise
    // cover, because native views always paint above the page document.
    // When the renderer asks for a capture, grab a snapshot of the page
    // BEFORE zeroing the bounds so the renderer can show a pixel-identical
    // still image underneath its overlay UI - making the chrome truly
    // overlay the page instead of the page covering the chrome.
    let snapshot = null;
    if (capture && view.webContents && typeof view.webContents.capturePage === 'function') {
      try {
        const image = await view.webContents.capturePage();
        if (image && typeof image.toDataURL === 'function' && !(typeof image.isEmpty === 'function' && image.isEmpty())) {
          snapshot = snapshotDataUrl(image);
        }
      } catch (err) {
        logger.error?.(`[yayra:webview] capturePage failed for ${key}`, err);
      }
    }
    // Zeroing bounds (rather than removing/re-adding the child view) hides
    // the surface without destroying the guest page or losing its state.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return snapshot ? { snapshot } : undefined;
  }

  function goBack(key) {
    withView(key, (view) => {
      if (historyCanGoBack(view.webContents)) historyGoBack(view.webContents);
    });
  }

  function goForward(key) {
    withView(key, (view) => {
      if (historyCanGoForward(view.webContents)) historyGoForward(view.webContents);
    });
  }

  function reload(key) {
    withView(key, (view) => view.webContents.reload());
  }

  function retryFailedUrl(key, url) {
    const entry = views.get(key);
    const wc = entry?.view?.webContents;
    let target = null;
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') target = parsed.toString();
    } catch { /* invalid recovery target */ }
    if (!wc || wc.isDestroyed?.() || !target) return { ok: false, reason: 'invalid-target' };
    // A failed navigation is not guaranteed to become webContents.getURL().
    // Explicitly load the renderer-retained target instead of asking reload()
    // to guess between the last committed document and Chromium's error page.
    entry.requestedUrl = target;
    entry.lastUrl = target;
    entry.mainFrameFailed = false;
    Promise.resolve(wc.loadURL(target)).catch((error) => {
      const description = String(error?.message || error || 'load failed');
      if (/ERR_ABORTED\s*\(-3\)|net::ERR_ABORTED/i.test(description)) return;
      entry.mainFrameFailed = true;
      sendTo(entry, 'fail-load', {
        errorCode: -2,
        errorDescription: description.slice(0, 240),
        url: target
      });
    });
    return { ok: true, url: target };
  }

  /**
   * Chrome's Ctrl+Shift+R / Ctrl+F5: genuinely drop this site's cached
   * data (HTTP-cache bypass on the reload itself + compiled code caches
   * + Cache Storage + service workers for the origin), then reload the
   * page from the network. Cookies/logins are NOT touched - exactly how
   * a Chrome hard reload behaves.
   */
  async function clearSiteCache(key) {
    const entry = views.get(key);
    const wc = entry && entry.view && entry.view.webContents;
    if (!wc || wc.isDestroyed?.()) return { ok: false, reason: 'no-view' };
    const rawUrl = entry.lastUrl || (typeof wc.getURL === 'function' ? wc.getURL() : null);
    let origin = null;
    try { origin = new URL(rawUrl).origin; } catch { /* internal/blank page */ }
    if (!origin || !/^https?:/i.test(origin)) return { ok: false, reason: 'no-site' };
    const ses = wc.session;
    try {
      if (ses && typeof ses.clearCodeCaches === 'function') {
        await ses.clearCodeCaches({ urls: [origin] });
      }
      if (ses && typeof ses.clearStorageData === 'function') {
        // Cache-like storages only - NOT cookies/localstorage, so the
        // user stays signed in (Chrome hard-reload semantics).
        await ses.clearStorageData({ origin, storages: ['cachestorage', 'serviceworkers', 'shadercache'] });
      }
      return { ok: true, origin };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
  }

  async function hardReload(key) {
    const result = await clearSiteCache(key);
    withView(key, (view) => {
      const wc = view.webContents;
      if (typeof wc.reloadIgnoringCache === 'function') wc.reloadIgnoringCache();
      else wc.reload();
    });
    return result;
  }

  function stop(key) {
    withView(key, (view) => view.webContents.stop());
  }

  function destroyView(key) {
    const entry = views.get(key);
    if (!entry) return;
    cancelPageUnresponsiveReload(entry);
    cancelDownloadFailureTimer(entry);
    cancelSitePasskeyRequests(entry, 'AbortError');
    const win = (entry.hostWin && !entry.hostWin.isDestroyed?.()) ? entry.hostWin : getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view);
      } catch (err) {
        logger.error(`[yayra:webview] failed to detach view for ${key}`, err);
      }
    }
    try { websitePasskeyProvider?.detach?.(entry.view.webContents); } catch { /* view is closing */ }
    try {
      const webContentsId = Number(entry.view?.webContents?.id);
      if (Number.isInteger(webContentsId)) entriesByWebContentsId.delete(webContentsId);
    } catch { /* view is closing */ }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    views.delete(key);
  }

  function destroyAll() {
    for (const key of Array.from(views.keys())) destroyView(key);
    for (const [ses, listener] of webAuthnSessionListeners) {
      try { ses.removeListener?.('select-webauthn-account', listener); } catch { /* app is quitting */ }
    }
    webAuthnSessionListeners.clear();
  }

  // Destroys only the views owned by one shell window (used when the main
  // window or the floating mini window closes, WITHOUT tearing down the
  // other window's tabs - they are independent).
  function destroyForWebContents(wc) {
    if (!wc) return;
    for (const [key, entry] of Array.from(views.entries())) {
      if (entry.hostWc === wc) destroyView(key);
    }
  }

  function trustedProfileIdForSender(sender) {
    try {
      const id = typeof getProfileIdForWebContents === 'function'
        ? getProfileIdForWebContents(sender)
        : null;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)) return id;
    } catch { /* use default */ }
    return 'default';
  }

  function sessionsForSender(sender) {
    const sessions = new Set();
    for (const entry of views.values()) {
      if (entry.hostWc === sender && entry.view?.webContents?.session) sessions.add(entry.view.webContents.session);
    }
    if (sessionModule && typeof sessionModule.fromPartition === 'function') {
      try { sessions.add(sessionModule.fromPartition(partitionForProfile(trustedProfileIdForSender(sender)))); }
      catch { /* unavailable in stripped-down test hosts */ }
    }
    return sessions;
  }

  function cookieRemovalUrl(cookie) {
    const domain = String(cookie?.domain || '').replace(/^\./, '');
    if (!domain) return null;
    const scheme = cookie?.secure ? 'https' : 'http';
    const path = String(cookie?.path || '/').startsWith('/') ? String(cookie.path || '/') : '/';
    return `${scheme}://${domain}${path}`;
  }

  // Trusted, per-profile Google auth-surface parity switch. The renderer can
  // opt in/out (Security Center), but the profile scope is resolved from the
  // pinned shell window - a renderer cannot enable parity for another
  // profile or inject arbitrary policy values.
  ipcMain.handle('yayra:webview-google-auth-parity-set', (event, payload = {}) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'untrusted-sender' };
    const enabled = payload?.enabled === true;
    const profileId = trustedProfileIdForSender(sender);
    googleAuthParityByHost.set(sender, enabled);
    googleAuthParityByProfile.set(profileId, enabled);
    return { ok: true, enabled, profileId };
  });

  ipcMain.handle('yayra:webview-privacy-set', (event, payload = {}) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'untrusted-sender' };
    const policy = sanitizePrivacyPolicy(payload);
    const profileId = trustedProfileIdForSender(sender);
    const previous = privacyPolicyByHost.get(sender);
    if (policy.autoRemoveUnusedPermissions && previous?.autoRemoveUnusedPermissions === false) {
      runtimeSitePermissionsByProfile.delete(profileId);
    }
    privacyPolicyByHost.set(sender, policy);
    privacyPolicyByProfile.set(profileId, policy);
    let updated = 0;
    let reloadRecommended = false;
    for (const entry of views.values()) {
      if (entry.hostWc !== sender) continue;
      entry.profileId = profileId;
      const wc = entry.view?.webContents;
      if (!wc || wc.isDestroyed?.()) continue;
      if (typeof wc.setJavaScriptEnabled === 'function') {
        try {
          const previous = typeof wc.isJavaScriptEnabled === 'function' ? wc.isJavaScriptEnabled() : null;
          wc.setJavaScriptEnabled(policy.javascriptEnabled !== false);
          reloadRecommended ||= previous !== null && previous !== (policy.javascriptEnabled !== false);
        } catch { /* setting applies to newly created views */ }
      }
      updated += 1;
    }
    return {
      ok: true,
      updated,
      reloadRecommended,
      policy: {
        httpsFirst: policy.httpsFirst,
        safeBrowsingLevel: policy.safeBrowsingLevel,
        adBlockEnabled: policy.adBlockEnabled,
        doNotTrack: policy.doNotTrack,
        globalPrivacyControl: policy.globalPrivacyControl,
        thirdPartyCookies: policy.thirdPartyCookies,
        secureDnsEnabled: policy.secureDnsEnabled
      }
    };
  });

  ipcMain.handle('yayra:webview-set-google-service-account', (event, payload = null) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'untrusted-sender' };
    const account = payload ? sanitizeGoogleServiceAccount(payload) : null;
    if (account) googleServiceAccountByHost.set(sender, account);
    else googleServiceAccountByHost.delete(sender);
    let updated = 0;
    for (const entry of views.values()) {
      if (entry.hostWc !== sender) continue;
      injectGoogleServiceAccount(entry);
      updated += 1;
    }
    return { ok: true, connected: Boolean(account), updated };
  });

  ipcMain.handle('yayra:webview-privacy-status', (event) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'untrusted-sender' };
    const profileId = trustedProfileIdForSender(sender);
    const policy = privacyPolicyByHost.get(sender) || privacyPolicyByProfile.get(profileId) || DEFAULT_PRIVACY_POLICY;
    const stats = privacyStatsByProfile.get(profileId) || { blockedTrackers: 0, blockedCookies: 0, blockedUnsafe: 0, blockedImages: 0 };
    const recommendations = [];
    if (!policy.httpsFirst) recommendations.push('https-first');
    if (policy.safeBrowsingLevel !== 'enhanced') recommendations.push('safe-browsing');
    if (!policy.adBlockEnabled) recommendations.push('tracker-protection');
    if (policy.thirdPartyCookies !== 'block') recommendations.push('third-party-cookies');
    if (!policy.doNotTrack || !policy.globalPrivacyControl) recommendations.push('privacy-signals');
    if (!policy.secureDnsEnabled) recommendations.push('secure-dns');
    if (policy.preloadPages) recommendations.push('disable-preload');
    if (policy.allowWebsitePopups) recommendations.push('website-popups');
    if (policy.javascriptEnabled === false) recommendations.push('javascript-disabled');
    return { ok: true, profileId, recommendations, stats: { ...stats } };
  });

  ipcMain.handle('yayra:webview-site-data-list', async (event) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'untrusted-sender', sites: [] };
    const byHost = new Map();
    for (const ses of sessionsForSender(sender)) {
      if (!ses?.cookies?.get) continue;
      let cookies = [];
      try { cookies = await ses.cookies.get({}); } catch { continue; }
      for (const cookie of cookies.slice(0, 20_000)) {
        const host = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
        if (!host || !/^[a-z0-9.-]{1,253}$/i.test(host)) continue;
        const current = byHost.get(host) || { host, cookies: 0, secureCookies: 0 };
        current.cookies += 1;
        if (cookie.secure) current.secureCookies += 1;
        byHost.set(host, current);
      }
    }
    const sites = Array.from(byHost.values())
      .sort((a, b) => b.cookies - a.cookies || a.host.localeCompare(b.host))
      .slice(0, 1_000);
    return { ok: true, sites, totalSites: byHost.size, truncated: byHost.size > sites.length };
  });

  ipcMain.handle('yayra:webview-site-data-remove', async (event, { host } = {}) => {
    const sender = event?.sender;
    const cleanHost = String(host || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!sender || !cleanHost || cleanHost.length > 253 || !/^[a-z0-9.-]+$/i.test(cleanHost)) {
      return { ok: false, reason: 'invalid-host' };
    }
    let removed = 0;
    for (const ses of sessionsForSender(sender)) {
      if (!ses) continue;
      if (ses.cookies?.get && ses.cookies?.remove) {
        let cookies = [];
        try { cookies = await ses.cookies.get({}); } catch { cookies = []; }
        for (const cookie of cookies) {
          const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
          if (domain !== cleanHost && !domain.endsWith(`.${cleanHost}`) && !cleanHost.endsWith(`.${domain}`)) continue;
          const url = cookieRemovalUrl(cookie);
          if (!url) continue;
          try { await ses.cookies.remove(url, cookie.name); removed += 1; } catch { /* continue */ }
        }
      }
      if (typeof ses.clearStorageData === 'function') {
        const storages = ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'];
        for (const scheme of ['https', 'http']) {
          try { await ses.clearStorageData({ origin: `${scheme}://${cleanHost}`, storages }); } catch { /* best effort */ }
        }
      }
    }
    return { ok: true, removed };
  });

  ipcMain.handle('yayra:webview-ensure', (event, { tabId, url, isPrivate, profileId, pointerTheme, pointerSize } = {}) => {
    const { hostWc, hostWin } = resolveHost(event);
    const trustedProfileId = typeof getProfileIdForWebContents === 'function'
      ? trustedProfileIdForSender(hostWc)
      : profileId;
    return ensureView(viewKey(event, tabId), tabId, url, {
      isPrivate, hostWc, hostWin, profileId: trustedProfileId, pointerTheme, pointerSize
    });
  });
  ipcMain.handle('yayra:webview-continue-passkey', async (event, {
    tabId,
    requestId,
    external = false,
    authorizationToken = ''
  } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const id = typeof requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(requestId)
      ? requestId
      : null;
    const request = id ? entry?.sitePasskeyRequests?.get(id) : null;
    if (!entry || !request || request.conditional) return { ok: false, reason: 'request-ended' };

    const provider = websitePasskeyInfo(entry, request);
    const localCeremony = request.provider?.mode === 'local' && provider.mode === 'local';
    if (external || !localCeremony) {
      const currentUrl = String(entry.view?.webContents?.getURL?.() || entry.lastUrl || '');
      if (!isHttpUrl(currentUrl)) return { ok: false, reason: 'invalid-url' };
      try {
        await shell.openExternal(currentUrl);
        // A locally gated ceremony has not entered Chromium yet. Once the
        // same page is handed to the system browser, cancel that dormant
        // promise (and any deferred account callback) instead of leaving a
        // fake active indicator behind in Yayra.
        clearSitePasskeyCompletionTimer(request);
        finishPendingPasskeySelection(entry, id, false);
        if (request.controlled && request.controlState !== 'cancel') controlSitePasskeyRequest(entry, id, 'cancel');
        sendTo(entry, 'system-browser-handoff', { url: currentUrl, reason: 'passkey' });
        return { ok: true, handedOff: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message || 'open-failed').slice(0, 120) };
      }
    }

    let userVerification = null;
    const token = typeof authorizationToken === 'string' && authorizationToken.length <= 128
      ? authorizationToken
      : '';
    if (token) {
      let grant;
      try {
        grant = typeof consumeWebsitePasskeyGrant === 'function'
          ? consumeWebsitePasskeyGrant({
            token,
            event,
            tabId: entry.tabId,
            requestId: id,
            rpId: request.rpId,
            profileId: entry.profileId || 'default',
            action: request.action
          })
          : { ok: false, reason: 'yayra-authorization-unavailable' };
      } catch {
        grant = { ok: false, reason: 'yayra-authorization-unavailable' };
      }
      if (!grant?.ok) {
        const reason = grant?.reason || 'yayra-authorization-expired';
        sendTo(entry, 'webauthn-provider-state', { requestId: id, state: 'declined', reason });
        return { ok: false, reason, canUseSystemBrowser: true };
      }
      userVerification = { verified: true, method: 'yayra-passkey' };
    }

    sendTo(entry, 'webauthn-provider-state', { requestId: id, state: 'prompting' });
    let result;
    try {
      result = await websitePasskeyProvider.confirm({
        webContents: entry.view.webContents,
        requestId: id,
        action: request.action,
        rpId: request.rpId,
        userVerification,
        isStillActive: () => entry.sitePasskeyRequests?.has(id) === true
      });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || 'provider-unavailable').slice(0, 120) };
    }
    if (result?.ok) {
      // PIN/PolicyKit/browser-chrome interaction can move focus away from the
      // site. WebAuthn rejects an unfocused top-level document, so restore both
      // the owning window and requesting view before entering the native API.
      try {
        entry.hostWin?.show?.();
        entry.hostWin?.focus?.();
        entry.view?.webContents?.focus?.();
      } catch { /* view closed while the prompt was up */ }
      // Presence is armed *before* the untouched native WebAuthn operation is
      // started. Chromium's virtual CTAP device does not replay a transaction
      // that already returned "no touch", which was the reason GitHub reached
      // Yayra's “Completing passkey” state and then ended in NotAllowedError.
      request.userVerified = true;
      const continued = finishPendingPasskeySelection(entry, id, true)
        || (request.controlState === 'hold' && controlSitePasskeyRequest(entry, id, 'release'));
      if (!continued) {
        request.userVerified = false;
        try { await websitePasskeyProvider?.settle?.({ webContents: entry.view?.webContents, requestId: id }); } catch { /* fail closed */ }
        result = { ok: false, reason: 'request-gate-unavailable' };
      } else {
        armSitePasskeyCompletionTimer(entry, request);
      }
    }
    sendTo(entry, 'webauthn-provider-state', {
      requestId: id,
      state: result?.ok ? 'approved' : 'declined',
      reason: result?.ok ? '' : String(result?.reason || 'provider-unavailable').slice(0, 120),
      verification: result?.ok && result?.verification === 'yayra-passkey' ? 'yayra-passkey' : 'system-auth'
    });
    return result?.ok
      ? {
        ok: true,
        prompted: Boolean(result.prompted),
        verification: result.verification === 'yayra-passkey' ? 'yayra-passkey' : 'system-auth',
        ...(Number(result.presenceExpiresInMs) > 0
          ? { presenceExpiresInMs: Math.min(60000, Number(result.presenceExpiresInMs)) }
          : {})
      }
      : { ok: false, reason: result?.reason || 'provider-unavailable', canUseSystemBrowser: true };
  });
  ipcMain.handle('yayra:webview-set-background-throttling', (event, { enabled } = {}) => {
    const sender = event?.sender;
    if (!sender || typeof enabled !== 'boolean') return { ok: false, reason: 'invalid-request', updated: 0 };
    backgroundThrottlingByHost.set(sender, enabled);
    let updated = 0;
    for (const entry of views.values()) {
      if (entry.hostWc !== sender) continue;
      const wc = entry.view?.webContents;
      if (!wc || wc.isDestroyed?.() || typeof wc.setBackgroundThrottling !== 'function') continue;
      try { wc.setBackgroundThrottling(enabled); updated += 1; } catch { /* report only successful updates */ }
    }
    return { ok: true, enabled, updated };
  });
  ipcMain.handle('yayra:webview-list-task-tabs', (event) => {
    const sender = event?.sender;
    if (!sender) return { ok: false, reason: 'unavailable', tabs: [] };
    const tabs = [];
    for (const entry of views.values()) {
      if (entry.hostWc !== sender) continue;
      const wc = entry.view?.webContents;
      if (!wc || wc.isDestroyed?.()) continue;
      let pid = null;
      try {
        const rawPid = wc.getOSProcessId?.();
        if (Number.isInteger(rawPid) && rawPid > 0) pid = rawPid;
      } catch { /* renderer may be tearing down */ }
      tabs.push({ tabId: String(entry.tabId), pid });
    }
    return { ok: true, tabs };
  });
  ipcMain.handle('yayra:webview-set-pointer-theme', (event, { tabId, theme, size } = {}) => setPointerTheme(viewKey(event, tabId), theme, size));
  ipcMain.handle('yayra:webview-set-bounds', (event, { tabId, bounds } = {}) => setBounds(viewKey(event, tabId), bounds));
  ipcMain.handle('yayra:webview-set-visible', (event, { tabId, visible, capture } = {}) => setVisible(viewKey(event, tabId), visible, { capture }));
  ipcMain.handle('yayra:webview-capture', (event, { tabId } = {}) => capture(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-go-back', (event, { tabId } = {}) => goBack(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-go-forward', (event, { tabId } = {}) => goForward(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-reload', (event, { tabId } = {}) => reload(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-retry', (event, { tabId, url } = {}) => retryFailedUrl(viewKey(event, tabId), url));
  ipcMain.handle('yayra:webview-hard-reload', (event, { tabId } = {}) => hardReload(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-clear-site-cache', (event, { tabId } = {}) => clearSiteCache(viewKey(event, tabId)));
  ipcMain.handle('yayra:webview-stop', (event, { tabId } = {}) => stop(viewKey(event, tabId)));
  // Engine-truth loading probe: the renderer's stuck-X watchdog asks the
  // REAL webContents whether the page is still loading, so a missed
  // loading-stop event can never leave the refresh button stuck as an X.
  ipcMain.handle('yayra:webview-is-loading', (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry?.view?.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) || typeof wc.isLoading !== 'function') {
      return { isLoading: false };
    }
    return { isLoading: Boolean(wc.isLoading()) };
  });
  ipcMain.handle('yayra:webview-destroy', (event, { tabId } = {}) => destroyView(viewKey(event, tabId)));

  // ---- Menu > More tools: real page-level actions -------------------
  // Each works on the tab's native view when it exists; DevTools falls
  // back to the SHELL's own webContents so internal yayra:// pages are
  // inspectable too.
  ipcMain.handle('yayra:webview-open-devtools', (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = (entry && entry.view && entry.view.webContents) || (event && event.sender) || null;
    if (!wc || typeof wc.openDevTools !== 'function') return { ok: false, reason: 'unavailable' };
    try {
      wc.openDevTools({ mode: 'detach' });
      return { ok: true };
    } catch (err) {
      logger.error?.('[yayra:webview] openDevTools failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  async function savePrintAsPdf(event, wc, fallbackReason = 'no-printers') {
    if (!wc || typeof wc.printToPDF !== 'function' || !dialog || typeof dialog.showSaveDialog !== 'function'
      || typeof writeFile !== 'function') {
      return { ok: false, reason: fallbackReason, pdfFallbackUnavailable: true };
    }
    try {
      const title = (typeof wc.getTitle === 'function' && wc.getTitle()) || 'page';
      const safeName = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 80) || 'page';
      const owner = (typeof getWindowForWebContents === 'function' && event?.sender
        && getWindowForWebContents(event.sender)) || getMainWindow?.() || null;
      const result = await dialog.showSaveDialog(owner, {
        title: 'Save print as PDF',
        defaultPath: `${safeName}.pdf`,
        filters: [{ name: 'PDF document', extensions: ['pdf'] }]
      });
      if (result?.canceled || !result?.filePath) {
        return { ok: false, canceled: true, mode: 'pdf', fallbackReason };
      }
      const filePath = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
      const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
      if (!pdf || !Number(pdf.length)) throw new Error('empty_pdf');
      await writeFile(filePath, pdf);
      return { ok: true, mode: 'pdf', path: filePath, fallbackReason };
    } catch (err) {
      logger.error?.('[yayra:webview] PDF print fallback failed', err);
      return { ok: false, reason: 'pdf-fallback-failed', fallbackReason };
    }
  }

  ipcMain.handle('yayra:webview-print', async (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = (entry && entry.view && entry.view.webContents) || (event && event.sender) || null;
    if (!wc || typeof wc.print !== 'function') return { ok: false, reason: 'unavailable' };

    // Electron exposes the actual destination list. Do not send Linux to a
    // synthetic/nonexistent "default" queue: when there is no printer, save
    // a PDF directly and avoid Chromium's Failed to Print Document dialog.
    if (typeof wc.getPrintersAsync === 'function') {
      try {
        const printers = await wc.getPrintersAsync();
        if (!Array.isArray(printers) || printers.length === 0) {
          return savePrintAsPdf(event, wc, 'no-printers');
        }
      } catch (err) {
        logger.warn?.('[yayra:webview] printer discovery failed; native print will verify the destination', err);
      }

      try {
        return await new Promise((resolve) => {
          wc.print({}, (success, failureReason = '') => {
            if (success) {
              resolve({ ok: true, mode: 'printer' });
              return;
            }
            // Closing the dialog is an intentional cancel, not evidence that
            // the machine lacks a printer. All actual destination failures
            // (including Linux's missing "default") get the PDF fallback.
            if (/cancel/i.test(String(failureReason))) {
              resolve({ ok: false, canceled: true, mode: 'printer' });
              return;
            }
            Promise.resolve(savePrintAsPdf(event, wc, String(failureReason || 'printer-failed'))).then(resolve);
          });
        });
      } catch (err) {
        logger.error?.('[yayra:webview] native print failed; using PDF fallback', err);
        return savePrintAsPdf(event, wc, 'printer-threw');
      }
    }

    // Compatibility path for older Electron/test hosts that do not expose
    // printer discovery. Preserve their existing native print behavior.
    try {
      wc.print({});
      return { ok: true, mode: 'printer' };
    } catch (err) {
      logger.error?.('[yayra:webview] print failed; using PDF fallback', err);
      return savePrintAsPdf(event, wc, 'printer-threw');
    }
  });

  ipcMain.handle('yayra:webview-save-page', async (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry && entry.view && entry.view.webContents;
    if (!wc || typeof wc.savePage !== 'function') return { ok: false, reason: 'no-native-page' };
    if (!dialog || typeof dialog.showSaveDialog !== 'function') return { ok: false, reason: 'unavailable' };
    try {
      const title = (typeof wc.getTitle === 'function' && wc.getTitle()) || 'page';
      const safeName = String(title).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'page';
      const owner = (typeof getWindowForWebContents === 'function' && event && event.sender
        && getWindowForWebContents(event.sender)) || getMainWindow?.() || null;
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        title: 'Save page as',
        defaultPath: `${safeName}.html`,
        filters: [{ name: 'Web page, complete', extensions: ['html'] }]
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      await wc.savePage(filePath, 'HTMLComplete');
      return { ok: true, path: filePath };
    } catch (err) {
      logger.error?.('[yayra:webview] savePage failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  ipcMain.handle('yayra:webview-set-zoom', (event, { tabId, factor } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry && entry.view && entry.view.webContents;
    const f = Number(factor);
    if (!wc || typeof wc.setZoomFactor !== 'function' || !Number.isFinite(f) || f <= 0) {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      wc.setZoomFactor(Math.min(5, Math.max(0.25, f)));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  });

  // Reading mode: pull the page's readable text blocks out of the real
  // document (main world, read-only query).
  ipcMain.handle('yayra:webview-reader-extract', async (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry && entry.view && entry.view.webContents;
    if (!wc || typeof wc.executeJavaScript !== 'function') return { ok: false, reason: 'no-native-page' };
    if (isAuthSurfaceEntry(entry)) return { ok: false, reason: 'protected-auth-surface' };
    const script = `(() => {
      const title = String(document.title || '').trim();
      const url = String(location.href || '');
      const siteName = document.querySelector('meta[property="og:site_name"]')?.content || location.hostname || '';
      const hiddenByReader = (el) => {
        if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
        try {
          const style = getComputedStyle(el);
          return style.display === 'none' || style.visibility === 'hidden';
        } catch { return false; }
      };
      const candidates = Array.from(document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"], .article-body, .post-content, .entry-content'));
      let root = null;
      let rootScore = 0;
      for (const candidate of candidates.slice(0, 40)) {
        const text = String(candidate.innerText || '').trim();
        const score = text.length + (candidate.matches('article,[itemprop="articleBody"]') ? 400 : 0);
        if (score > rootScore) { root = candidate; rootScore = score; }
      }
      root = root || document.body;
      if (!root) return { title, url, siteName, language: '', wordCount: 0, blocks: [] };
      const excluded = 'script, style, noscript, nav, header, footer, aside, form, button, input, select, textarea, [hidden], [aria-hidden="true"], [role="navigation"], [role="contentinfo"], [role="complementary"], .advertisement, .advert, .ads, .cookie-banner';
      const safeHref = (raw) => {
        try {
          const resolved = new URL(raw, url);
          return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : '';
        } catch { return ''; }
      };
      const segmentsFor = (el) => {
        const segments = [];
        try {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode()) && segments.length < 240) {
            const text = String(node.nodeValue || '');
            if (!text.trim()) { if (segments.length) segments[segments.length - 1].text += text; continue; }
            const anchor = node.parentElement?.closest('a');
            segments.push({ text, href: anchor ? safeHref(anchor.getAttribute('href') || anchor.href || '') : '' });
          }
        } catch { /* text fallback is returned below */ }
        return segments;
      };
      const nodes = root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, figure, img');
      const blocks = [];
      let wordCount = 0;
      for (const el of nodes) {
        if (blocks.length >= 600 || hiddenByReader(el) || el.closest(excluded)) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'img' && el.closest('figure')) continue;
        if (tag === 'p' && el.closest('li')) continue;
        let text = String(el.innerText || el.alt || '').trim();
        if (tag === 'img') {
          const src = safeHref(el.currentSrc || el.src || el.getAttribute('src') || '');
          const alt = String(el.alt || '').trim();
          if (src) blocks.push({ tag: 'img', type: 'image', src, alt, text: alt });
          continue;
        }
        if (tag === 'figure') {
          const image = el.querySelector('img');
          const src = image ? safeHref(image.currentSrc || image.src || image.getAttribute('src') || '') : '';
          const caption = String(el.querySelector('figcaption')?.innerText || image?.alt || '').trim();
          if (src) { blocks.push({ tag: 'figure', type: 'figure', src, alt: String(image?.alt || ''), text: caption }); continue; }
        }
        if (text.length < 2) continue;
        text = text.slice(0, 5000);
        const segments = segmentsFor(el);
        const type = tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'code' : tag === 'li' ? 'list-item' : 'text';
        blocks.push({ tag, type, level: /^h[1-4]$/.test(tag) ? Number(tag.slice(1)) : undefined, text, segments });
        wordCount += text.split(/\\s+/).filter(Boolean).length;
      }
      return {
        title, url, siteName,
        language: String(document.documentElement?.lang || ''),
        wordCount,
        readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
        blocks
      };
    })()`;
    try {
      const result = await wc.executeJavaScript(script, true);
      return {
        ok: true,
        title: result?.title || '',
        url: result?.url || '',
        siteName: result?.siteName || '',
        language: result?.language || '',
        wordCount: Number.isFinite(result?.wordCount) ? result.wordCount : 0,
        readingMinutes: Number.isFinite(result?.readingMinutes) ? result.readingMinutes : null,
        blocks: Array.isArray(result?.blocks) ? result.blocks : []
      };
    } catch (err) {
      logger.error?.('[yayra:webview] reader extract failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  // Media Controller: real per-tab audio state + mute.
  ipcMain.handle('yayra:webview-media-state', (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry && entry.view && entry.view.webContents;
    if (!wc) return { ok: false, reason: 'no-native-page' };
    return {
      ok: true,
      audible: typeof wc.isCurrentlyAudible === 'function' ? Boolean(wc.isCurrentlyAudible()) : false,
      muted: typeof wc.isAudioMuted === 'function' ? Boolean(wc.isAudioMuted()) : false
    };
  });

  ipcMain.handle('yayra:webview-set-muted', (event, { tabId, muted } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = entry && entry.view && entry.view.webContents;
    if (!wc || typeof wc.setAudioMuted !== 'function') return { ok: false, reason: 'unavailable' };
    try {
      wc.setAudioMuted(Boolean(muted));
      return { ok: true, muted: Boolean(muted) };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  });

  // ---- Chrome-style password autofill + email recall routing ---------
  // The isolated page preload sends on these channels; the sender is the
  // VIEW's webContents, so locate its entry and forward to the shell window
  // that owns the tab. Private tabs never forward captures or receive saved
  // email suggestions (defense in depth).
  function entryForViewSender(event) {
    const sender = event && event.sender;
    if (!sender) return null;
    for (const entry of views.values()) {
      if (entry.view && entry.view.webContents === sender) return entry;
    }
    return null;
  }

  if (typeof ipcMain.on === 'function') {
    ipcMain.on('yayra:autofill-captured', (event, payload = {}) => {
      const entry = entryForViewSender(event);
      if (!entry || entry.isPrivate) return;
      const { url, username, password } = payload;
      if (!url || !password) return;
      sendTo(entry, 'autofill-captured', { url: String(url), username: String(username || ''), password: String(password) });
    });
    ipcMain.on('yayra:autofill-form-detected', (event, payload = {}) => {
      const entry = entryForViewSender(event);
      if (!entry || entry.isPrivate) return;
      sendTo(entry, 'autofill-form-detected', { url: String(payload.url || entry.lastUrl || '') });
    });
    ipcMain.on(EMAIL_FIELD_FOCUSED_CHANNEL, (event, payload = {}) => {
      const entry = entryForViewSender(event);
      if (!entry || entry.isPrivate) return;
      const url = String(payload?.url || entry.lastUrl || '');
      if (!isHttpUrl(url)) return;
      const currentUrl = entry.view?.webContents?.getURL?.() || entry.lastUrl || '';
      if (isHttpUrl(currentUrl)) {
        try { if (new URL(currentUrl).origin !== new URL(url).origin) return; } catch { return; }
      }
      sendTo(entry, 'email-field-focused', { url });
    });
    ipcMain.on(EMAIL_ADDRESS_CAPTURED_CHANNEL, (event, payload = {}) => {
      const entry = entryForViewSender(event);
      if (!entry || entry.isPrivate) return;
      const email = sanitizeEmailAddress(payload?.email);
      const url = String(payload?.url || entry.lastUrl || '');
      if (!email || !isHttpUrl(url)) return;
      sendTo(entry, 'email-address-captured', { email, url });
    });
    ipcMain.on(SITE_PASSKEY_REQUEST_CHANNEL, (event, payload = {}) => {
      const entry = entryForViewSender(event);
      if (!entry) return;
      const phase = payload.phase === 'started' || payload.phase === 'settled' ? payload.phase : null;
      const action = payload.action === 'create' || payload.action === 'get' ? payload.action : null;
      const requestId = typeof payload.requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(payload.requestId)
        ? payload.requestId
        : null;
      const rpId = typeof payload.rpId === 'string' && payload.rpId.length <= 253
        && /^[a-z0-9.-]+$/i.test(payload.rpId)
        ? payload.rpId.toLowerCase()
        : null;
      if (!phase || !action || !requestId || !rpId) return;

      let page;
      try { page = new URL(entry.view?.webContents?.getURL?.() || entry.lastUrl || ''); } catch { return; }
      const trustworthy = page.protocol === 'https:'
        || ((page.protocol === 'http:' || page.protocol === 'https:')
          && /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(page.hostname));
      const host = page.hostname.toLowerCase();
      if (!trustworthy || (rpId !== host && !host.endsWith(`.${rpId}`))) return;

      entry.sitePasskeyRequests ||= new Map();
      let requestMeta = {
        requestId,
        action,
        rpId,
        conditional: Boolean(payload.conditional),
        attachment: payload.attachment === 'platform' || payload.attachment === 'cross-platform'
          ? payload.attachment
          : 'any',
        controlled: payload.controlled === true,
        controlState: 'none',
        userVerified: false,
        completionTimer: null
      };
      if (phase === 'started') {
        if (entry.sitePasskeyRequests.size >= 8 || entry.sitePasskeyRequests.has(requestId)) return;
        requestMeta.provider = websitePasskeyInfo(entry, requestMeta);
        // The local software authenticator is safe only when the preload can
        // start native WebAuthn *after* approval. An older observer that has
        // already entered CTAP cannot be repaired by toggling virtual touch,
        // so expose the honest system-browser fallback instead.
        if (requestMeta.provider.mode === 'local' && !requestMeta.controlled) {
          requestMeta.provider = { mode: 'external', available: false, reason: 'request-gate-unavailable' };
        }
        entry.sitePasskeyRequests.set(requestId, requestMeta);
        if (requestMeta.controlled) {
          const shouldHold = requestMeta.provider.mode !== 'native' && !requestMeta.conditional;
          controlSitePasskeyRequest(entry, requestId, shouldHold ? 'hold' : 'release');
        }
      } else {
        requestMeta = entry.sitePasskeyRequests.get(requestId);
        if (!requestMeta) return;
        entry.sitePasskeyRequests.delete(requestId);
        clearSitePasskeyCompletionTimer(requestMeta);
        finishPendingPasskeySelection(entry, requestId, false);
        try {
          websitePasskeyProvider?.settle?.({ webContents: entry.view?.webContents, requestId });
        } catch { /* provider is already detached */ }
      }
      sendTo(entry, 'webauthn-request', {
        phase,
        requestId,
        action: requestMeta.action,
        rpId: requestMeta.rpId,
        conditional: requestMeta.conditional,
        attachment: requestMeta.attachment,
        provider: requestMeta.provider,
        success: phase === 'settled' ? payload.success === true : undefined,
        errorName: typeof payload.errorName === 'string' && /^[A-Za-z]+Error$/.test(payload.errorName)
          ? payload.errorName.slice(0, 64)
          : ''
      });
    });
  }

  ipcMain.handle('yayra:webview-fill-credentials', (event, { tabId, username, password } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    if (!entry || entry.isPrivate) return { filled: false };
    try {
      entry.view.webContents.send('yayra:autofill-fill', {
        username: String(username || ''),
        password: String(password || '')
      });
      return { filled: true };
    } catch {
      return { filled: false };
    }
  });

  ipcMain.handle('yayra:webview-suggest-email-addresses', (event, { tabId, emails } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    if (!entry || entry.isPrivate) return { suggested: false, count: 0 };
    const seen = new Set();
    const safeEmails = (Array.isArray(emails) ? emails : [])
      .map(sanitizeEmailAddress)
      .filter((email) => {
        if (!email) return false;
        const key = email.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 25);
    try {
      entry.view.webContents.send(EMAIL_SUGGESTIONS_CHANNEL, { emails: safeEmails });
      return { suggested: true, count: safeEmails.length };
    } catch {
      return { suggested: false, count: 0 };
    }
  });

  return {
    destroyAll,
    destroyForWebContents,
    noteDownloadHandoff,
    // Exposed for tests and for main.cjs lifecycle hooks only.
    _internal: { views, ensureView, setBounds, setVisible, capture, goBack, goForward, reload, hardReload, clearSiteCache, stop, destroyView, noteDownloadHandoff }
  };
}

// Hoisted (not an inline nested literal) so Node's CJS -> ESM static export
// scanner keeps detecting every named export for the .mjs test suites.
const GOOGLE_AUTH_PARITY_HELPERS = Object.freeze({
  isGoogleAuthSurface,
  isGoogleSignInRejectedUrl,
  googleSignInFallbackUrl,
  isFirstPartyGoogleSignInUrl,
  isThirdPartyGoogleOAuthUrl,
  isGoogleAccountPortalUrl
});

module.exports = {
  WEBVIEW_EVENT_CHANNEL,
  SITE_PASSKEY_REQUEST_CHANNEL,
  SYSTEM_BROWSER_AUTH_HOSTS,
  OPEN_EXTERNAL_SCHEME,
  isGoogleOAuthAuthorizationUrl,
  isGoogleInteractiveAuthenticationUrl,
  requiresYayraGoogleAccountConnection,
  requiresSystemBrowserAuth,
  secureSystemBrowserAuthUrl,
  isGoogleDriveDownloadUrl,
  decodeOpenExternalRequest,
  buildWebAuthnWatchdogScript,
  buildGoogleSearchThinkingWatchdogScript,
  buildPointerThemeCss,
  buildPointerThemeScript,
  buildPointerTextCursorScript,
  buildTextSelectionActionsScript,
  buildGoogleServiceAccountScript,
  sanitizeGoogleServiceAccount,
  sanitizeBounds,
  sanitizePageBounds,
  MIN_NATIVE_PAGE_Y,
  buildBrowserUserAgent,
  buildContextMenuTemplate,
  reloadActionForInput,
  googleAuthParity: GOOGLE_AUTH_PARITY_HELPERS,
  createWebviewBridge
};
