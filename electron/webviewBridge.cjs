'use strict';

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
 * Google's OAuth policy prohibits authorization requests in embedded user
 * agents (see https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews).
 * Yayra therefore hands off explicit Google OAuth authorization endpoints to
 * the system browser. Ordinary account pages, including the accounts.google.com
 * landing page and direct account sign-in routes, are allowed to render in the
 * WebContentsView; Google may still reject an interactive sign-in there, and
 * Yayra does not bypass that policy or transfer the system browser's cookies.
 * The app's own Google sign-in uses its separate external-browser + PKCE flow.
 *
 * Apple and Microsoft keep their existing system-browser handoff behavior.
 * `buildBrowserUserAgent()` remains a general site-compatibility setting only;
 * it is not used to spoof browser identity or defeat provider checks.
 */

// Identity-provider endpoints that must be completed in the user's default
// system browser. Google is deliberately OAuth-path-scoped: account browsing
// and basic sign-in routes stay in the native view, while authorization paths
// are handed off. Keep this predicate in sync with BrowserShell and Android.
const SYSTEM_BROWSER_AUTH_HOSTS = Object.freeze([
  'accounts.google.com',
  'appleid.apple.com',
  'login.live.com',
  'login.microsoftonline.com'
]);
const GOOGLE_OAUTH_PATH = /^\/(?:o\/oauth2(?:\/|$)|oauth2(?:\/|$)|signin\/oauth(?:\/|$)|gsi\/select(?:\/|$))/i;

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

const POINTER_STYLE_ID = 'yayra-custom-pointer-theme';
const POINTER_TEXT_CURSOR_ATTRIBUTE = 'data-yayra-selectable-text';
const POINTER_TEXT_CURSOR_STATE = '__yayraSelectableTextCursorState';

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
        if (!event || event.pointerType === 'touch') { clear(); return; }
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
        ? 'Click Confirm passkey in Yayra’s address bar, then approve the system-password prompt.'
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

function requiresSystemBrowserAuth(rawUrl, hosts = SYSTEM_BROWSER_AUTH_HOSTS) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const hostname = parsed.hostname.toLowerCase();
  return hosts.some((host) => {
    const normalizedHost = String(host).toLowerCase();
    if (normalizedHost === 'accounts.google.com') {
      return hostname === normalizedHost && GOOGLE_OAUTH_PATH.test(parsed.pathname);
    }
    return hostname === normalizedHost || hostname.endsWith(`.${normalizedHost}`);
  });
}

function secureSystemBrowserAuthUrl(rawUrl, hosts = SYSTEM_BROWSER_AUTH_HOSTS) {
  if (!requiresSystemBrowserAuth(rawUrl, hosts)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:') return rawUrl;
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
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
function buildContextMenuTemplate({ params, wc, tabId, send, clipboard }) {
  const template = [];
  const isLink = !!(params && params.linkURL);
  const isImage = !!(params && params.mediaType === 'image' && params.srcURL);
  const isEditable = !!(params && params.isEditable);
  const hasSelection = !!(params && params.selectionText && params.selectionText.trim());

  if (isLink) {
    template.push(
      { label: 'Open Link in New Tab', click: () => send(tabId, 'new-window-request', { url: params.linkURL }) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }
    );
  }

  if (isImage) {
    if (template.length) template.push({ type: 'separator' });
    template.push(
      { label: 'Open Image in New Tab', click: () => send(tabId, 'new-window-request', { url: params.srcURL }) },
      { label: 'Save Image As\u2026', click: () => wc.downloadURL(params.srcURL) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }
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
    const trimmed = params.selectionText.trim();
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
      }
    );
  }

  if (template.length) template.push({ type: 'separator' });
  template.push(
    // Always available, Chrome-style: open the in-browser AI chat.
    { label: 'Ask Yayra AI', click: () => send(tabId, 'new-window-request', { url: 'yayra://ai' }) },
    { type: 'separator' },
    { label: 'Back', enabled: historyCanGoBack(wc), click: () => historyGoBack(wc) },
    { label: 'Forward', enabled: historyCanGoForward(wc), click: () => historyGoForward(wc) },
    { label: 'Reload', click: () => wc.reload() },
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
  // Electron's dialog module, injected for the "Save page as..." OS save
  // dialog. Optional: without it savePage reports { ok:false }.
  dialog = null,
  // Absolute path to electron/autofillPreload.cjs. When provided, every
  // page view gets sandboxed password capture/fill and email suggestion hooks
  // (context-isolated, nothing exposed to the page). Optional for test hosts.
  autofillPreloadPath = null,
  // Optional Linux software platform authenticator. It uses Chromium's real
  // WebAuthn machinery, encrypted per-profile credentials, and an explicit
  // browser-chrome confirmation before releasing user presence.
  websitePasskeyProvider = null,
  logger = console,
  pageUnresponsiveReloadDelayMs = PAGE_UNRESPONSIVE_RELOAD_DELAY_MS,
  pageUnresponsiveReloadCooldownMs = PAGE_UNRESPONSIVE_RELOAD_COOLDOWN_MS
}) {
  // key -> { view, lastUrl, tabId, hostWc, hostWin }
  // key namespaces the renderer-chosen tabId by the webContents that asked
  // for it: the main window and the floating mini window each run their own
  // BrowserShell instance whose generated ids ("tab-1", "tab-2", ...) would
  // otherwise collide and steal each other's native views.
  const views = new Map();
  // One discoverable-credential chooser per persistent/private Session.
  // Without this Electron cancels navigator.credentials.get() whenever an
  // authenticator returns accounts, making valid site passkeys look broken.
  const webAuthnSessionListeners = new WeakMap();
  // Per-shell-window policy. WeakMap keeps the preference scoped to the
  // renderer that owns the native views without retaining destroyed windows.
  const backgroundThrottlingByHost = new WeakMap();

  function cancelPageUnresponsiveReload(entry) {
    if (!entry) return;
    entry.pageUnresponsive = false;
    if (entry.pageUnresponsiveReloadTimer !== null) {
      clearTimeout(entry.pageUnresponsiveReloadTimer);
      entry.pageUnresponsiveReloadTimer = null;
    }
  }

  function websitePasskeyInfo(entry) {
    if (!websitePasskeyProvider || typeof websitePasskeyProvider.describe !== 'function') {
      return { mode: 'native', available: false, reason: 'native-platform-authenticator' };
    }
    try {
      const info = websitePasskeyProvider.describe({
        webContents: entry?.view?.webContents,
        profileId: entry?.profileId,
        isPrivate: entry?.isPrivate
      }) || {};
      const mode = info.mode === 'local' || info.mode === 'external' ? info.mode : 'native';
      return {
        mode,
        available: mode === 'local' && info.available === true,
        reason: typeof info.reason === 'string' ? info.reason.slice(0, 120) : ''
      };
    } catch {
      return { mode: 'external', available: false, reason: 'provider-unavailable' };
    }
  }

  function cancelSitePasskeyRequests(entry, errorName = 'AbortError') {
    if (!entry?.sitePasskeyRequests?.size) return;
    for (const [requestId, meta] of entry.sitePasskeyRequests) {
      try {
        websitePasskeyProvider?.settle?.({ webContents: entry.view?.webContents, requestId });
      } catch { /* provider is already detached */ }
      sendTo(entry, 'webauthn-request', {
        phase: 'settled',
        requestId,
        ...meta,
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
      let completed = false;
      const finish = (credentialId = undefined) => {
        if (completed) return;
        completed = true;
        try { callback(typeof credentialId === 'string' ? credentialId : undefined); } catch { /* request expired */ }
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
      const entry = entryForWebAuthnFrame(ses, details.frame);
      // Electron documents a null frame after navigation/destruction. Do not
      // attach an account chooser to an unrelated tab/window in that race.
      if (!entry) { finish(); return; }
      let requestId = '';
      for (const [candidateId, meta] of entry.sitePasskeyRequests || []) {
        if (meta?.action === 'get' && meta.conditional === true && meta.rpId === relyingPartyId) {
          // Conditional mediation stays silent until Chromium asks the user to
          // choose an account. From this point it is an active ceremony and
          // the trusted toolbar may release presence after explicit approval.
          meta.conditional = false;
          requestId = candidateId;
          break;
        }
      }
      sendTo(entry, 'webauthn-account-selection', {
        relyingPartyId,
        accountCount: accounts.length,
        ...(requestId ? { requestId } : {})
      });
      const owner = entry.hostWin && !entry.hostWin.isDestroyed?.() ? entry.hostWin : getMainWindow();

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
          menu.popup({
            ...(owner && !owner.isDestroyed?.() ? { window: owner } : {}),
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
    if (!wc) return;

    const frames = [];
    const seen = new Set();
    try {
      const mainFrame = wc.mainFrame;
      if (mainFrame) {
        frames.push(mainFrame);
        seen.add(mainFrame);
      }
      const subtree = mainFrame && mainFrame.framesInSubtree;
      if (subtree && typeof subtree[Symbol.iterator] === 'function') {
        for (const frame of subtree) {
          if (frame && !seen.has(frame)) {
            frames.push(frame);
            seen.add(frame);
          }
        }
      }
    } catch { /* an about:blank or tearing-down frame may not be traversable */ }
    if (!frames.length) frames.push(wc);

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
      if (entry.pointerTheme !== 'system') applyPointerThemeToPage(entry);
      if (typeof wc.executeJavaScript === 'function') {
        const watchdogs = [
          buildWebAuthnWatchdogScript(),
          buildGoogleSearchThinkingWatchdogScript()
        ].join('\n');
        wc.executeJavaScript(watchdogs, true).catch(() => {});
      }
    });
    // Apply the selected pointer to cross-origin child frames as each one
    // finishes loading; a main-frame style cannot cross an iframe boundary.
    wc.on('did-frame-finish-load', () => {
      if (entry.pointerTheme !== 'system') applyPointerThemeToPage(entry);
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
      // A user-initiated reload/navigation is already the recovery action.
      const wasUnresponsive = entry.pageUnresponsive;
      cancelPageUnresponsiveReload(entry);
      cancelSitePasskeyRequests(entry, 'AbortError');
      if (wasUnresponsive) sendTo(entry, 'page-recovery-start', { url: wc.getURL?.() || entry.lastUrl || '', reason: 'navigation' });
      sendTo(entry, 'loading-start');
    });
    wc.on('did-stop-loading', () => sendTo(entry, 'loading-stop'));
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
      if (!isMainFrame || !requiresSystemBrowserAuth(url, authHosts)) return;

      event?.preventDefault?.();
      const externalUrl = secureSystemBrowserAuthUrl(url, authHosts);
      Promise.resolve(shell.openExternal(externalUrl)).catch((err) => logger.error('[yayra:webview] failed to open external auth url', err));
      // Prevent the canceled navigation from leaving a stale loading spinner
      // in the original tab. No URL/history event is emitted: the in-app page
      // stays where it was before the provider redirect.
      sendTo(entry, 'loading-stop');
      sendTo(entry, 'system-browser-handoff', { url: externalUrl, sourceUrl: entry.lastUrl || null, reason: 'navigation' });
    };
    wc.on('will-navigate', handoffAuthNavigation);
    wc.on('will-redirect', handoffAuthNavigation);
    wc.on('did-navigate', (_event, url) => {
      entry.lastUrl = url;
      sendTo(entry, 'navigated', { url, ...navState(wc) });
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      entry.lastUrl = url;
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
      sendTo(entry, 'fail-load', { errorCode, errorDescription, url: validatedUrl });
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
      Menu.buildFromTemplate(template).popup({ window: win });
    });
    wc.setWindowOpenHandler(({ url }) => {
      // In-page WebAuthn helper asking to reopen this page in the user's
      // real browser (where phone/synced passkeys actually work).
      const externalTarget = decodeOpenExternalRequest(url);
      if (externalTarget) {
        shell.openExternal(externalTarget).catch((err) => logger.error('[yayra:webview] failed to open external url', err));
        sendTo(entry, 'system-browser-handoff', { url: externalTarget });
        return { action: 'deny' };
      }
      if (requiresSystemBrowserAuth(url, authHosts)) {
        const externalUrl = secureSystemBrowserAuthUrl(url, authHosts);
        shell.openExternal(externalUrl).catch((err) => logger.error('[yayra:webview] failed to open external auth url', err));
        sendTo(entry, 'system-browser-handoff', { url: externalUrl });
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

  function createView(key, tabId, isPrivate, hostWc, hostWin, profileId = 'default') {
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
    // Pre-paint background: Chromium's default surface is WHITE, which
    // flashes whenever a view is created/hidden/resized inside Yayra's
    // dark chrome. Pages paint their own background the moment they
    // render, so this only affects the un-painted instants.
    if (typeof view.setBackgroundColor === 'function') {
      try { view.setBackgroundColor('#101218'); } catch { /* older electron */ }
    }
    const entry = {
      view,
      lastUrl: null,
      tabId,
      hostWc,
      hostWin,
      isPrivate: Boolean(isPrivate),
      profileId: String(profileId || 'default'),
      requestedUrl: null,
      pointerTheme: 'system',
      pointerSize: 'normal',
      pageUnresponsive: false,
      pageUnresponsiveReloadTimer: null,
      lastPageUnresponsiveReloadAt: 0
    };
    views.set(key, entry);
    if (websitePasskeyProvider && typeof websitePasskeyProvider.attach === 'function') {
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

    if (requiresSystemBrowserAuth(url, authHosts)) {
      const externalUrl = secureSystemBrowserAuthUrl(url, authHosts);
      shell.openExternal(externalUrl).catch((err) => logger.error('[yayra:webview] failed to open external auth url', err));
      sendTo({ tabId, hostWc }, 'system-browser-handoff', { url: externalUrl });
      return { handedOffToSystemBrowser: true };
    }

    let entry = views.get(key);
    // A view created for another profile can't be reused - the partition
    // is fixed at construction. Destroy and recreate in the right one.
    if (entry && !entry.isPrivate && entry.profileId !== String(profileId || 'default')) {
      destroyView(key);
      entry = undefined;
    }
    if (!entry) {
      entry = createView(key, tabId, isPrivate, hostWc, win, profileId);
      const backgroundThrottling = hostWc ? backgroundThrottlingByHost.get(hostWc) : undefined;
      if (typeof backgroundThrottling === 'boolean'
        && typeof entry.view.webContents.setBackgroundThrottling === 'function') {
        try { entry.view.webContents.setBackgroundThrottling(backgroundThrottling); } catch { /* keep Electron's default */ }
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
    if (entry.websitePasskeyReady) await entry.websitePasskeyReady;
    if (entry.requestedUrl !== url) return { handedOffToSystemBrowser: false };

    if (entry.lastUrl !== url) {
      entry.lastUrl = url;
      entry.view.webContents.loadURL(url).catch((err) => {
        const description = String((err && err.message) || err || 'load failed');
        // Electron rejects a superseded loadURL() with ERR_ABORTED when the
        // user navigates again before it settles. This is expected control
        // flow, not a failed final navigation; did-fail-load also filters -3.
        if (/ERR_ABORTED\s*\(-3\)|net::ERR_ABORTED/i.test(description)) return;
        let host = '';
        try { host = new URL(url).host; } catch { /* never log full user query text */ }
        logger.error(`[yayra:webview] failed to load ${host || 'page'} (loadURL rejected)`);
        sendTo(entry, 'fail-load', { errorCode: -2, errorDescription: description.slice(0, 240), url });
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
    withView(key, (view) => view.setBounds(sanitizeBounds(bounds)));
  }

  /**
   * Encode a page snapshot CHEAPLY. toDataURL() alone produces a
   * full-resolution PNG - a multi-megabyte base64 string per tab switch
   * or menu open, which hammered the IPC channel and left the renderer
   * collecting giant strings (GC pauses = micro-freezes). A snapshot is
   * a transient still under the chrome, so a width-capped JPEG is
   * visually identical at ~3% of the bytes. Falls back to PNG when the
   * image object lacks resize/toJPEG (older fakes, odd platforms).
   */
  function snapshotDataUrl(image) {
    try {
      if (image && typeof image.getSize === 'function' && typeof image.resize === 'function' && typeof image.toJPEG === 'function') {
        const { width } = image.getSize() || {};
        const scaled = Number(width) > 1440 ? image.resize({ width: 1440 }) : image;
        const buf = scaled.toJPEG(78);
        if (buf && buf.length) return `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    } catch { /* fall through to PNG */ }
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

  ipcMain.handle('yayra:webview-ensure', (event, { tabId, url, isPrivate, profileId, pointerTheme, pointerSize } = {}) => {
    const { hostWc, hostWin } = resolveHost(event);
    return ensureView(viewKey(event, tabId), tabId, url, { isPrivate, hostWc, hostWin, profileId, pointerTheme, pointerSize });
  });
  ipcMain.handle('yayra:webview-continue-passkey', async (event, { tabId, requestId, external = false } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const id = typeof requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(requestId)
      ? requestId
      : null;
    const request = id ? entry?.sitePasskeyRequests?.get(id) : null;
    if (!entry || !request || request.conditional) return { ok: false, reason: 'request-ended' };

    const provider = websitePasskeyInfo(entry);
    if (external || provider.mode !== 'local') {
      const currentUrl = String(entry.view?.webContents?.getURL?.() || entry.lastUrl || '');
      if (!isHttpUrl(currentUrl)) return { ok: false, reason: 'invalid-url' };
      try {
        await shell.openExternal(currentUrl);
        sendTo(entry, 'system-browser-handoff', { url: currentUrl, reason: 'passkey' });
        return { ok: true, handedOff: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message || 'open-failed').slice(0, 120) };
      }
    }

    sendTo(entry, 'webauthn-provider-state', { requestId: id, state: 'prompting' });
    let result;
    try {
      result = await websitePasskeyProvider.confirm({
        webContents: entry.view.webContents,
        requestId: id,
        action: request.action,
        rpId: request.rpId,
        isStillActive: () => entry.sitePasskeyRequests?.has(id) === true
      });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || 'provider-unavailable').slice(0, 120) };
    }
    sendTo(entry, 'webauthn-provider-state', {
      requestId: id,
      state: result?.ok ? 'approved' : 'declined',
      reason: result?.ok ? '' : String(result?.reason || 'provider-unavailable').slice(0, 120)
    });
    return result?.ok
      ? {
        ok: true,
        prompted: Boolean(result.prompted),
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

  ipcMain.handle('yayra:webview-print', (event, { tabId } = {}) => {
    const entry = views.get(viewKey(event, tabId));
    const wc = (entry && entry.view && entry.view.webContents) || (event && event.sender) || null;
    if (!wc || typeof wc.print !== 'function') return { ok: false, reason: 'unavailable' };
    try {
      wc.print({});
      return { ok: true };
    } catch (err) {
      logger.error?.('[yayra:webview] print failed', err);
      return { ok: false, reason: 'failed' };
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
        action,
        rpId,
        conditional: Boolean(payload.conditional),
        attachment: payload.attachment === 'platform' || payload.attachment === 'cross-platform'
          ? payload.attachment
          : 'any'
      };
      if (phase === 'started') {
        if (entry.sitePasskeyRequests.size >= 8 || entry.sitePasskeyRequests.has(requestId)) return;
        requestMeta.provider = websitePasskeyInfo(entry);
        entry.sitePasskeyRequests.set(requestId, requestMeta);
      } else {
        requestMeta = entry.sitePasskeyRequests.get(requestId);
        if (!requestMeta) return;
        entry.sitePasskeyRequests.delete(requestId);
        try {
          websitePasskeyProvider?.settle?.({ webContents: entry.view?.webContents, requestId });
        } catch { /* provider is already detached */ }
      }
      sendTo(entry, 'webauthn-request', {
        phase,
        requestId,
        ...requestMeta,
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
    // Exposed for tests and for main.cjs lifecycle hooks only.
    _internal: { views, ensureView, setBounds, setVisible, capture, goBack, goForward, reload, hardReload, clearSiteCache, stop, destroyView }
  };
}

module.exports = {
  WEBVIEW_EVENT_CHANNEL,
  SITE_PASSKEY_REQUEST_CHANNEL,
  SYSTEM_BROWSER_AUTH_HOSTS,
  OPEN_EXTERNAL_SCHEME,
  requiresSystemBrowserAuth,
  secureSystemBrowserAuthUrl,
  decodeOpenExternalRequest,
  buildWebAuthnWatchdogScript,
  buildGoogleSearchThinkingWatchdogScript,
  buildPointerThemeCss,
  buildPointerThemeScript,
  buildPointerTextCursorScript,
  sanitizeBounds,
  buildBrowserUserAgent,
  buildContextMenuTemplate,
  reloadActionForInput,
  createWebviewBridge
};
