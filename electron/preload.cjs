const { contextBridge, ipcRenderer } = require('electron');

const WEBVIEW_EVENT_CHANNEL = 'yayra:webview-event';
const AUTH_EVENT_CHANNEL = 'yayra:auth-event';
const DOWNLOADS_EVENT_CHANNEL = 'yayra:downloads-event';
const UPDATES_EVENT_CHANNEL = 'yayra:updates-event';

const api = {
  getLaunchInfo: () => ipcRenderer.invoke('yayra:get-launch-info'),
  // Frameless-window controls: the OS title bar + menu block are removed
  // (electron/main.cjs createWindow), so the renderer's tab strip renders
  // real minimize/maximize/close buttons through these.
  windowControls: {
    minimize: () => ipcRenderer.invoke('yayra:window-minimize'),
    toggleMaximize: () => ipcRenderer.invoke('yayra:window-maximize-toggle'),
    isMaximized: () => ipcRenderer.invoke('yayra:window-is-maximized'),
    close: () => ipcRenderer.invoke('yayra:window-close'),
    // Manual dragging keeps the complete tab strip out of Electron's native
    // app-region path, which can swallow input and leave Linux chrome stuck.
    dragStart: (point) => ipcRenderer.send('yayra:window-drag-start', point),
    dragMove: (point) => ipcRenderer.send('yayra:window-drag-move', point),
    dragEnd: () => ipcRenderer.send('yayra:window-drag-end'),
    // Explicit menu > Exit: unlike close(), this quits the whole app and
    // its floating bubble/tray process, not only this BrowserWindow.
    quit: () => ipcRenderer.invoke('yayra:app-quit')
  },
  updates: {
    check: () => ipcRenderer.invoke('yayra:updates-check'),
    // Streams the release artifact into the staging dir and verifies
    // byte-length + sha256 in the main process before reporting it staged.
    // See electron/desktopUpdater.cjs.
    download: (payload) => ipcRenderer.invoke('yayra:updates-download', payload),
    install: (payload) => ipcRenderer.invoke('yayra:updates-install', payload),
    // How THIS running copy was installed (deb/appimage/windows/dev),
    // plus the version actually on disk - detects "a newer version is
    // already installed, just relaunch" (e.g. after a terminal dpkg -i
    // while the old Yayra process was still resident).
    installInfo: () => ipcRenderer.invoke('yayra:updates-install-info'),
    relaunch: () => ipcRenderer.invoke('yayra:updates-relaunch'),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(UPDATES_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(UPDATES_EVENT_CHANNEL, listener);
    }
  },
  // Native website-rendering engine bridge. See electron/webviewBridge.cjs.
  // Presence of `window.yayra.webview` is how the renderer
  // (packages/shared-ui/src/components/BrowserShell.js) detects it is
  // running inside Electron and should use the native WebContentsView engine
  // instead of an <iframe> for rendering visited websites.
  webview: {
    ensure: (tabId, url, isPrivate = false, profileId = 'default', pointer = {}) => ipcRenderer.invoke('yayra:webview-ensure', {
      tabId, url, isPrivate, profileId,
      pointerTheme: pointer && pointer.theme,
      pointerSize: pointer && pointer.size
    }),
    setPointerTheme: (tabId, theme, size) => ipcRenderer.invoke('yayra:webview-set-pointer-theme', { tabId, theme, size }),
    setBackgroundThrottling: (enabled) => ipcRenderer.invoke('yayra:webview-set-background-throttling', { enabled }),
    taskTabs: () => ipcRenderer.invoke('yayra:webview-list-task-tabs'),
    setBounds: (tabId, bounds) => ipcRenderer.invoke('yayra:webview-set-bounds', { tabId, bounds }),
    setVisible: (tabId, visible, options = {}) => ipcRenderer.invoke('yayra:webview-set-visible', { tabId, visible, capture: Boolean(options && options.capture) }),
    // Snapshot the live page WITHOUT hiding it - lets the renderer paint
    // the still image first and only then hide the native surface, so
    // opening the menu/modals never flashes a blank frame.
    capture: (tabId) => ipcRenderer.invoke('yayra:webview-capture', { tabId }),
    goBack: (tabId) => ipcRenderer.invoke('yayra:webview-go-back', { tabId }),
    goForward: (tabId) => ipcRenderer.invoke('yayra:webview-go-forward', { tabId }),
    reload: (tabId) => ipcRenderer.invoke('yayra:webview-reload', { tabId }),
    // Chrome Ctrl+Shift+R: clear this site's caches, then reload from
    // the network. clearSiteCache does the cache part without reloading.
    hardReload: (tabId) => ipcRenderer.invoke('yayra:webview-hard-reload', { tabId }),
    clearSiteCache: (tabId) => ipcRenderer.invoke('yayra:webview-clear-site-cache', { tabId }),
    stop: (tabId) => ipcRenderer.invoke('yayra:webview-stop', { tabId }),
    isLoading: (tabId) => ipcRenderer.invoke('yayra:webview-is-loading', { tabId }),
    destroy: (tabId) => ipcRenderer.invoke('yayra:webview-destroy', { tabId }),
    // Linux passkeys: an explicit toolbar click authorizes the pending real
    // WebAuthn ceremony (PolicyKit) or hands the exact page to the system
    // browser when no secure local provider is available.
    continuePasskey: (tabId, requestId, external = false) => ipcRenderer.invoke('yayra:webview-continue-passkey', {
      tabId, requestId, external: Boolean(external)
    }),
    // Autofill saved credentials into the page's login form (Chrome-style).
    fillCredentials: (tabId, { username, password } = {}) => ipcRenderer.invoke('yayra:webview-fill-credentials', { tabId, username, password }),
    // Suggest this profile's saved email addresses in a focused email field.
    // The main process rejects private-tab requests and validates the list.
    suggestEmailAddresses: (tabId, emails = []) => ipcRenderer.invoke('yayra:webview-suggest-email-addresses', { tabId, emails }),
    // Menu > More tools: REAL page-level actions on the native engine.
    openDevTools: (tabId) => ipcRenderer.invoke('yayra:webview-open-devtools', { tabId }),
    print: (tabId) => ipcRenderer.invoke('yayra:webview-print', { tabId }),
    savePage: (tabId) => ipcRenderer.invoke('yayra:webview-save-page', { tabId }),
    setZoom: (tabId, factor) => ipcRenderer.invoke('yayra:webview-set-zoom', { tabId, factor }),
    readerExtract: (tabId) => ipcRenderer.invoke('yayra:webview-reader-extract', { tabId }),
    mediaState: (tabId) => ipcRenderer.invoke('yayra:webview-media-state', { tabId }),
    setMuted: (tabId, muted) => ipcRenderer.invoke('yayra:webview-set-muted', { tabId, muted }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(WEBVIEW_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(WEBVIEW_EVENT_CHANNEL, listener);
    }
  },
  // "Sign in with Google" for Yayra's own app-level identity (not for
  // browsing Google services logged in - Google forbids that for any
  // embedded surface, see electron/webviewBridge.cjs). Presence of
  // `window.yayra.auth` is how the renderer knows this desktop build
  // supports real Google sign-in; it is absent on web/PWA/mobile builds
  // until those platforms get their own implementation. See
  // electron/googleAuth.cjs for the full flow.
  auth: {
    signIn: () => ipcRenderer.invoke('yayra:auth-sign-in'),
    signOut: () => ipcRenderer.invoke('yayra:auth-sign-out'),
    getSession: () => ipcRenderer.invoke('yayra:auth-get-session'),
    openAccountPage: () => ipcRenderer.invoke('yayra:auth-open-account-page'),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(AUTH_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(AUTH_EVENT_CHANNEL, listener);
    }
  },
  // Real download tracking (see electron/downloadsBridge.cjs). Presence of
  // `window.yayra.downloads` is how the renderer knows this build can show
  // real download history/open/show-in-folder/custom storage root instead
  // of the old decorative placeholder list.
  downloads: {
    list: () => ipcRenderer.invoke('yayra:downloads-list'),
    clear: () => ipcRenderer.invoke('yayra:downloads-clear'),
    remove: (id) => ipcRenderer.invoke('yayra:downloads-remove', { id }),
    open: (id) => ipcRenderer.invoke('yayra:downloads-open', { id }),
    // "Open in Yayra": read a COMPLETED pdf download's bytes so the
    // in-app document viewer can show it (bytes only - never a path).
    openPdf: (id) => ipcRenderer.invoke('yayra:downloads-open-pdf', { id }),
    showInFolder: (id) => ipcRenderer.invoke('yayra:downloads-show-in-folder', { id }),
    getRoot: () => ipcRenderer.invoke('yayra:downloads-get-root'),
    chooseRoot: () => ipcRenderer.invoke('yayra:downloads-choose-root'),
    cancel: (id) => ipcRenderer.invoke('yayra:downloads-cancel', { id }),
    pause: (id) => ipcRenderer.invoke('yayra:downloads-pause', { id }),
    resume: (id) => ipcRenderer.invoke('yayra:downloads-resume', { id }),
    retry: (id) => ipcRenderer.invoke('yayra:downloads-retry', { id }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(DOWNLOADS_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(DOWNLOADS_EVENT_CHANNEL, listener);
    }
  },
  // Device passkey for the desktop shell (see electron/passkeyBridge.cjs):
  // Chromium refuses real WebAuthn on the custom yayra:// scheme, so the
  // desktop uses an OS-keychain-bound credential (safeStorage; real Touch
  // ID prompt on supporting Macs). Web/PWA builds keep genuine WebAuthn.
  passkeys: {
    status: () => ipcRenderer.invoke('yayra:passkey-status'),
    // options: { method: 'device'|'pin', pin: '123456' } - the fallback
    // ladder for devices without biometrics/keychain access.
    register: (label, options) => ipcRenderer.invoke('yayra:passkey-register', { label, ...(options || {}) }),
    verify: (options) => ipcRenderer.invoke('yayra:passkey-verify', options || {}),
    remove: () => ipcRenderer.invoke('yayra:passkey-remove'),
    // Phone QR approval: scan a one-time LAN QR and approve on the phone.
    phoneStart: () => ipcRenderer.invoke('yayra:passkey-phone-start'),
    phoneStatus: () => ipcRenderer.invoke('yayra:passkey-phone-status'),
    phoneCancel: () => ipcRenderer.invoke('yayra:passkey-phone-cancel')
  },
  // Chrome-style profiles: open a profile in its OWN new Yayra window
  // while the current window stays on its profile.
  profiles: {
    openWindow: (profileId) => ipcRenderer.invoke('yayra:open-profile-window', { profileId })
  },
  // System-wide floating overlay bubble settings (see
  // electron/overlayWindow.cjs). The overlay window itself is a completely
  // separate native window/renderer - this is just the Settings-facing
  // control surface for it.
  overlay: {
    getSettings: () => ipcRenderer.invoke('yayra:overlay-get-settings'),
    setEnabled: (enabled) => ipcRenderer.invoke('yayra:overlay-set-enabled', enabled),
    setLaunchAtStartup: (enabled) => ipcRenderer.invoke('yayra:overlay-set-launch-at-startup', enabled),
    setOverlayAllApps: (enabled) => ipcRenderer.invoke('yayra:overlay-set-overlay-all-apps', enabled),
    setBubbleSize: (size) => ipcRenderer.invoke('yayra:overlay-set-bubble-size', size),
    setBubbleOpacity: (opacity) => ipcRenderer.invoke('yayra:overlay-set-bubble-opacity', opacity),
    setBubbleShadow: (shadowPx) => ipcRenderer.invoke('yayra:overlay-set-bubble-shadow', shadowPx),
    // Mirrors the bubble's triple-click position lock from Settings.
    setPositionLocked: (locked) => ipcRenderer.invoke('yayra:overlay-set-position-locked', locked),
    // "Minimize to bubble" on desktop hides the real OS window; the native
    // always-on-top bubble (a separate window) is the way back in.
    minimizeMainWindow: () => ipcRenderer.send('yayra:overlay-minimize-main'),
    // Used by the floating mini-shell window's own slim chrome.
    closeMini: () => ipcRenderer.send('yayra:overlay-mini-close'),
    // Carries the mini's current site so the full browser continues it.
    openFullFromMini: (url = null) => ipcRenderer.send('yayra:overlay-mini-open-full', { url }),
    // Main window: receive "open this url" handoffs (e.g. from mini).
    onOpenUrl: (callback) => {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('yayra:open-url', listener);
      return () => ipcRenderer.removeListener('yayra:open-url', listener);
    },
    // Keep the native bubble's double-tap radial in lockstep with the
    // in-app customizable action wheel (items are {id,title,url,type}).
    setWheelItems: (items) => ipcRenderer.invoke('yayra:overlay-set-wheel-items', items),
    // Wheel actions the native ring can't run itself are forwarded to
    // the main renderer (e.g. 'notes', 'duplicate', 'customize').
    onWheelAction: (callback) => {
      const listener = (_event, actionId) => callback(actionId);
      ipcRenderer.on('yayra:wheel-action', listener);
      return () => ipcRenderer.removeListener('yayra:wheel-action', listener);
    }
  },
  // Desktop-only system facilities: real process metrics for the task
  // manager and real desktop shortcuts for "Create desktop shortcut...".
  system: {
    appMetrics: () => ipcRenderer.invoke('yayra:app-metrics'),
    // Google-owned feature handoffs. The main process accepts only this
    // bounded enum; arbitrary external URLs are deliberately not exposed.
    openGoogleFeature: (feature) => ipcRenderer.invoke('yayra:open-google-feature', { feature }),
    // Direct image bytes -> Google's official Lens endpoint. The image never
    // passes through a Yayra server and the main process validates type/size.
    googleLensUpload: ({ name, type, data, language, startedAt } = {}) => ipcRenderer.invoke('yayra:google-lens-upload', {
      name, type, data, language, startedAt
    }),
    createShortcut: ({ url, title } = {}) => ipcRenderer.invoke('yayra:create-shortcut', { url, title }),
    // Chrome-style "Install page as app...": real launcher entries that
    // reopen the site in its own minimal app window (yayra --app=<url>).
    installPageAsApp: ({ url, title, nameOverride } = {}) => ipcRenderer.invoke('yayra:install-page-as-app', { url, title, nameOverride }),
    installPageAsAppPreview: ({ url, title } = {}) => ipcRenderer.invoke('yayra:install-page-as-app-preview', { url, title }),
    // Local document workspace: open ONE user-picked PDF; the renderer
    // receives only the bytes (never a filesystem path).
    documents: {
      openPdf: () => ipcRenderer.invoke('yayra:doc-open'),
      // "Open with desktop app": hand the CURRENT document's bytes to the
      // OS default pdf reader (main process writes a temp file).
      openExternal: ({ name, data } = {}) => ipcRenderer.invoke('yayra:doc-open-externally', { name, data }),
      // OS "Open with > yayra" launches: the main process pushes the
      // user-chosen file's bytes; the shell opens them in its viewer.
      onOpenPdfFile: (callback) => {
        const listener = (_event, payload) => { try { callback(payload); } catch { /* shell not ready */ } };
        ipcRenderer.on('yayra:open-pdf-file', listener);
        return () => { try { ipcRenderer.removeListener('yayra:open-pdf-file', listener); } catch { /* gone */ } };
      }
    },
    // Real Chromium cache/site-data clearing across all Yayra sessions.
    clearBrowsingData: ({ cache = true, cookies = false } = {}) => ipcRenderer.invoke('yayra:clear-browsing-data', { cache, cookies })
  }
};

contextBridge.exposeInMainWorld('yayra', api);
contextBridge.exposeInMainWorld('ibrowse', api);
