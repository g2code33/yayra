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
 * GOOGLE / IDENTITY PROVIDER SIGN-IN
 * -----------------------------------
 * Google (and several other identity providers) actively detect and refuse
 * to complete sign-in inside embedded browser surfaces as an anti-phishing
 * measure - see https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews.
 * An earlier version of this file tried presenting a desktop-Chrome identity
 * string (see `buildBrowserUserAgent()` below) specifically to get Google
 * sign-in itself to complete embedded. That did not work: Google also
 * inspects Client Hints (`navigator.userAgentData`, `Sec-CH-UA*` headers),
 * which a simple User-Agent string override does not change, and multiple
 * independent reports confirm Google has been actively closing this
 * loophole even for full Client Hints spoofing. Chasing that further is a
 * fragile, ever-escalating fight against Google's own anti-phishing system
 * for uncertain payoff, so Google sign-in is back on the system-browser
 * handoff path here, same as Apple/Microsoft, per Google's own
 * recommendation and RFC 8252 ("OAuth 2.0 for Native Apps").
 *
 * `buildBrowserUserAgent()` is kept and still applied to every tab, but only
 * for ordinary general-purpose site compatibility (many sites show "upgrade
 * your browser" nags or misrender for a Electron/x.y.z identity string) -
 * not as an attempt to defeat any site's anti-phishing/anti-automation
 * checks, which remain in effect and are handled by the handoff below.
 */

// Apex hostnames (and all subdomains) that must be completed in the user's
// default system browser instead of the embedded WebContentsView.
const SYSTEM_BROWSER_AUTH_HOSTS = Object.freeze([
  'accounts.google.com',
  'appleid.apple.com',
  'login.live.com',
  'login.microsoftonline.com'
]);

const WEBVIEW_EVENT_CHANNEL = 'yayra:webview-event';

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

  return [
    `html, body, body * { cursor: ${arrowCursor} !important; }`,
    `button, a, [role="button"], [role="tab"], [role="menuitem"], select, summary, input[type="button"], input[type="submit"], input[type="reset"] { cursor: ${handCursor} !important; }`,
    `input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], input[type="number"], textarea, [contenteditable="true"], [role="textbox"] { cursor: text !important; }`
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
 * This watchdog wraps navigator.credentials.get/create for publicKey
 * requests only. If a request is still unsettled after ~6s it shows a
 * small in-page banner explaining what works (USB key / picking another
 * 2FA method on the page) and offering to reopen the page in the user's
 * real browser. The banner removes itself the moment the request settles
 * either way, so working flows (Windows Hello, a touched USB key) never
 * see it. Password-manager credentials.get() calls (no publicKey) are
 * untouched.
 */
function buildWebAuthnWatchdogScript() {
  return `(function () {
  if (window.__yayraWebauthnWatchdog) return;
  window.__yayraWebauthnWatchdog = true;
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  var WAIT_MS = window.__yayraWebauthnWaitMs || 6000;
  var banner = null;
  var pending = 0;
  var timer = null;
  function removeBanner() {
    if (!banner) return;
    if (banner.remove) banner.remove();
    else if (banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }
  function showBanner() {
    if (banner || !document.body) return;
    banner = document.createElement('div');
    banner.id = 'yayra-webauthn-helper';
    banner.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483647;max-width:540px;background:#111827;color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:12px;padding:14px 16px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.55);');
    var msg = document.createElement('div');
    msg.textContent = 'Still waiting for a passkey. If you have a USB security key, plug it in and touch it now. Passkeys saved on a phone or synced in another browser are not available inside the desktop app - choose a different option on this page (such as an authenticator code), or finish this step in your regular browser.';
    var row = document.createElement('div');
    row.setAttribute('style', 'margin-top:10px;display:flex;gap:8px;justify-content:flex-end;');
    var openBtn = document.createElement('button');
    openBtn.id = 'yayra-webauthn-open-external';
    openBtn.textContent = 'Open in my browser';
    openBtn.setAttribute('style', 'border:none;border-radius:8px;padding:6px 12px;background:#3b82f6;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;');
    openBtn.addEventListener('click', function () {
      window.open('yayra-openexternal://' + encodeURIComponent(window.location.href));
    });
    var dismissBtn = document.createElement('button');
    dismissBtn.id = 'yayra-webauthn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.setAttribute('style', 'border:none;border-radius:8px;padding:6px 12px;background:rgba(255,255,255,0.12);color:#e5e7eb;cursor:pointer;font:600 12px system-ui,sans-serif;');
    dismissBtn.addEventListener('click', removeBanner);
    row.appendChild(openBtn);
    row.appendChild(dismissBtn);
    banner.appendChild(msg);
    banner.appendChild(row);
    document.body.appendChild(banner);
  }
  function watch(original) {
    return function (options) {
      var result = original.apply(navigator.credentials, arguments);
      if (!options || !options.publicKey || !result || typeof result.then !== 'function') return result;
      pending += 1;
      if (!timer) {
        timer = setTimeout(function () {
          timer = null;
          if (pending > 0) showBanner();
        }, WAIT_MS);
      }
      var settle = function () {
        pending = pending > 0 ? pending - 1 : 0;
        if (pending === 0) {
          if (timer) { clearTimeout(timer); timer = null; }
          removeBanner();
        }
      };
      result.then(settle, settle);
      return result;
    };
  }
  try {
    navigator.credentials.get = watch(navigator.credentials.get.bind(navigator.credentials));
    navigator.credentials.create = watch(navigator.credentials.create.bind(navigator.credentials));
  } catch (_err) {
    // Site froze the credentials container - leave it untouched.
  }
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

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function requiresSystemBrowserAuth(rawUrl, hosts = SYSTEM_BROWSER_AUTH_HOSTS) {
  const hostname = hostnameOf(rawUrl);
  if (!hostname) return false;
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
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
  // page view gets Chrome-style password capture/fill hooks (sandboxed,
  // context-isolated, nothing exposed to the page). Optional so existing
  // tests without it keep working.
  autofillPreloadPath = null,
  logger = console
}) {
  // key -> { view, lastUrl, tabId, hostWc, hostWin }
  // key namespaces the renderer-chosen tabId by the webContents that asked
  // for it: the main window and the floating mini window each run their own
  // BrowserShell instance whose generated ids ("tab-1", "tab-2", ...) would
  // otherwise collide and steal each other's native views.
  const views = new Map();

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
        wc.executeJavaScript(buildWebAuthnWatchdogScript(), true).catch(() => {});
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
    wc.on('did-start-loading', () => sendTo(entry, 'loading-start'));
    wc.on('did-stop-loading', () => sendTo(entry, 'loading-stop'));
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
        shell.openExternal(url).catch((err) => logger.error('[yayra:webview] failed to open external auth url', err));
        sendTo(entry, 'system-browser-handoff', { url });
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
      pointerTheme: 'system',
      pointerSize: 'normal'
    };
    views.set(key, entry);
    attachListeners(key, entry);
    return entry;
  }

  function ensureView(key, tabId, url, {
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
      shell.openExternal(url).catch((err) => logger.error('[yayra:webview] failed to open external auth url', err));
      sendTo({ tabId, hostWc }, 'system-browser-handoff', { url });
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
      win.contentView.addChildView(entry.view);
    }

    const nextPointerTheme = pointerTheme === 'yayra' || pointerTheme === 'high-visibility' ? pointerTheme : 'system';
    const nextPointerSize = pointerSize === 'large' || pointerSize === 'xlarge' ? pointerSize : 'normal';
    const pointerChanged = entry.pointerTheme !== nextPointerTheme || entry.pointerSize !== nextPointerSize;
    entry.pointerTheme = nextPointerTheme;
    entry.pointerSize = nextPointerSize;
    if (pointerChanged && entry.lastUrl) applyPointerThemeToPage(entry);

    if (entry.lastUrl !== url) {
      entry.lastUrl = url;
      entry.view.webContents.loadURL(url).catch((err) => {
        logger.error(`[yayra:webview] failed to load ${url}`, err);
        sendTo(entry, 'fail-load', { errorCode: -2, errorDescription: String((err && err.message) || err), url });
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
    const win = (entry.hostWin && !entry.hostWin.isDestroyed?.()) ? entry.hostWin : getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view);
      } catch (err) {
        logger.error(`[yayra:webview] failed to detach view for ${key}`, err);
      }
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    views.delete(key);
  }

  function destroyAll() {
    for (const key of Array.from(views.keys())) destroyView(key);
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
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      if (!root) return { title: document.title, url: location.href, blocks: [] };
      const nodes = root.querySelectorAll('h1, h2, h3, p, li');
      const blocks = [];
      for (const el of nodes) {
        const text = (el.innerText || '').trim();
        if (text.length < 2) continue;
        blocks.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 4000) });
        if (blocks.length >= 400) break;
      }
      return { title: document.title, url: location.href, blocks };
    })()`;
    try {
      const result = await wc.executeJavaScript(script, true);
      return { ok: true, title: result?.title || '', url: result?.url || '', blocks: Array.isArray(result?.blocks) ? result.blocks : [] };
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

  // ---- Chrome-style password capture / autofill routing -------------
  // The autofill preload inside a page view sends on these channels; the
  // sender is the VIEW's webContents, so locate its entry and forward to
  // the shell window that owns the tab. Private tabs never forward
  // captures (the vault refuses them anyway - defense in depth).
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

  return {
    destroyAll,
    destroyForWebContents,
    // Exposed for tests and for main.cjs lifecycle hooks only.
    _internal: { views, ensureView, setBounds, setVisible, capture, goBack, goForward, reload, hardReload, clearSiteCache, stop, destroyView }
  };
}

module.exports = {
  WEBVIEW_EVENT_CHANNEL,
  SYSTEM_BROWSER_AUTH_HOSTS,
  OPEN_EXTERNAL_SCHEME,
  requiresSystemBrowserAuth,
  decodeOpenExternalRequest,
  buildWebAuthnWatchdogScript,
  buildPointerThemeCss,
  buildPointerThemeScript,
  sanitizeBounds,
  buildBrowserUserAgent,
  buildContextMenuTemplate,
  reloadActionForInput,
  createWebviewBridge
};
