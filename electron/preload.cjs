const { contextBridge, ipcRenderer } = require('electron');

const WEBVIEW_EVENT_CHANNEL = 'yayra:webview-event';
const AUTH_EVENT_CHANNEL = 'yayra:auth-event';
const DOWNLOADS_EVENT_CHANNEL = 'yayra:downloads-event';
const UPDATES_EVENT_CHANNEL = 'yayra:updates-event';
const CHROME_INPUT_RECOVERY_CHANNEL = 'yayra:chrome-input-recover';
const CONTEXT_MENU_ACTION_CHANNEL = 'yayra:context-menu-action';
const CONTEXT_MENU_NAV_STATE_CHANNEL = 'yayra:context-menu-navigation-state';
const dictionaryLookupListeners = new Set();
let pendingDictionaryLookup = null;
ipcRenderer.on('yayra:overlay-dictionary-lookup', (_event, payload) => {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  if (!dictionaryLookupListeners.size) pendingDictionaryLookup = safePayload;
  for (const callback of dictionaryLookupListeners) {
    try { callback(safePayload); } catch { /* isolated renderer listener */ }
  }
});

const api = {
  getLaunchInfo: () => ipcRenderer.invoke('yayra:get-launch-info'),
  contextMenu: {
    updateNavigationState: (state = {}) => ipcRenderer.send(CONTEXT_MENU_NAV_STATE_CHANNEL, {
      canGoBack: state.canGoBack === true,
      canGoForward: state.canGoForward === true
    }),
    onAction: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on(CONTEXT_MENU_ACTION_CHANNEL, listener);
      return () => ipcRenderer.removeListener(CONTEXT_MENU_ACTION_CHANNEL, listener);
    }
  },
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
    onInputRecovery: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on(CHROME_INPUT_RECOVERY_CHANNEL, listener);
      return () => ipcRenderer.removeListener(CHROME_INPUT_RECOVERY_CHANNEL, listener);
    },
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
    setPrivacySettings: (settings = {}) => ipcRenderer.invoke('yayra:webview-privacy-set', settings),
    // Best-effort standalone-browser parity on Google auth surfaces. Default
    // off; the Security Center sets it per Yayra profile. See
    // electron/googleAuthParity.cjs for exactly what changes.
    setGoogleAuthParity: (enabled = false) => ipcRenderer.invoke('yayra:webview-google-auth-parity-set', { enabled: enabled === true }),
    setGoogleServiceAccount: (profile = null) => ipcRenderer.invoke('yayra:webview-set-google-service-account', profile),
    privacyStatus: () => ipcRenderer.invoke('yayra:webview-privacy-status'),
    listSiteData: () => ipcRenderer.invoke('yayra:webview-site-data-list'),
    removeSiteData: (host) => ipcRenderer.invoke('yayra:webview-site-data-remove', { host }),
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
    // Recovery uses the retained requested URL explicitly. Chromium may have
    // no committed URL after ERR_INTERNET_DISCONNECTED, so plain reload()
    // alone can otherwise reload about:blank/the previous document.
    retry: (tabId, url) => ipcRenderer.invoke('yayra:webview-retry', { tabId, url }),
    // Chrome Ctrl+Shift+R: clear this site's caches, then reload from
    // the network. clearSiteCache does the cache part without reloading.
    hardReload: (tabId) => ipcRenderer.invoke('yayra:webview-hard-reload', { tabId }),
    clearSiteCache: (tabId) => ipcRenderer.invoke('yayra:webview-clear-site-cache', { tabId }),
    stop: (tabId) => ipcRenderer.invoke('yayra:webview-stop', { tabId }),
    isLoading: (tabId) => ipcRenderer.invoke('yayra:webview-is-loading', { tabId }),
    destroy: (tabId) => ipcRenderer.invoke('yayra:webview-destroy', { tabId }),
    // Linux website passkeys: an explicit toolbar click supplies a one-shot
    // Yayra-passkey grant (or intentionally falls back to PolicyKit), then
    // releases the exact held WebAuthn call. No credential data crosses IPC.
    continuePasskey: (tabId, requestId, options = {}) => {
      const normalized = typeof options === 'boolean' ? { external: options } : (options || {});
      return ipcRenderer.invoke('yayra:webview-continue-passkey', {
        tabId,
        requestId,
        external: Boolean(normalized.external),
        authorizationToken: typeof normalized.authorizationToken === 'string'
          ? normalized.authorizationToken
          : ''
      });
    },
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
  // Callback-returning Google OAuth. Chrome owns the provider ceremony;
  // the verified result returns to Yayra and persists through the encrypted
  // main-process store. Scoped Gmail/Drive API access stays behind IPC, so
  // neither Google bearer tokens nor refresh tokens enter renderer JavaScript.
  auth: {
    // Every app-account operation carries this shell window's browsing
    // profile. The main process pre-pins native shell windows (or resolves an
    // auxiliary shell from its trusted boot URL), so renderer code cannot
    // read or clear another open profile's encrypted credentials.
    signIn: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-sign-in', { profileId }),
    connectDrive: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-connect-drive', { profileId }),
    downloadDriveFile: (fileId, profileId = 'default') => ipcRenderer.invoke('yayra:auth-download-drive-file', { fileId, profileId }),
    connectGmail: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-connect-gmail', { profileId }),
    connectGoogleServices: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-connect-google-services', { profileId }),
    getGoogleServiceItems: (serviceId, profileId = 'default') => ipcRenderer.invoke('yayra:auth-get-google-service-items', { serviceId, profileId }),
    getGoogleServicesSession: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-get-session', { profileId }),
    listGmailMessages: (options = {}, profileId = 'default') => ipcRenderer.invoke('yayra:auth-list-gmail-messages', { ...options, profileId }),
    getGmailMessage: (messageId, profileId = 'default') => ipcRenderer.invoke('yayra:auth-get-gmail-message', { messageId, profileId }),
    signOut: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-sign-out', { profileId }),
    getSession: (profileId = 'default') => ipcRenderer.invoke('yayra:auth-get-session', { profileId }),
    openAccountPage: () => ipcRenderer.invoke('yayra:auth-open-account-page'),
    // Credential-free product origins only; main validates exact HTTPS Google
    // ownership before invoking the OS browser (or the dedicated Chrome
    // profile when available - see googleChromeProfile below).
    openGoogleProduct: (origin, options = {}) => ipcRenderer.invoke('yayra:auth-open-google-product', { origin, ...options }),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(AUTH_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(AUTH_EVENT_CHANNEL, listener);
    }
  },
  // Dedicated REAL Chrome profile for genuinely signed-in Google websites.
  // Yayra never reads or copies its cookies; it only launches Chrome with a
  // Yayra-owned --user-data-dir and opens allow-listed Google destinations.
  // Presence of `window.yayra.googleChromeProfile` is how BrowserShell knows
  // the desktop build can offer "Open in Chrome" instead of a fake session.
  googleChromeProfile: {
    status: () => ipcRenderer.invoke('yayra:chrome-profile-status'),
    open: (url) => ipcRenderer.invoke('yayra:chrome-profile-open', { url }),
    // Opens myaccount.google.com in the dedicated profile to perform the
    // actual Google website sign-in once. Cookies persist across restarts.
    signIn: () => ipcRenderer.invoke('yayra:chrome-profile-sign-in'),
    close: () => ipcRenderer.invoke('yayra:chrome-profile-close')
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
    // "Open in Yayra": read a completed supported download as bytes only.
    // Keep openPdf as a compatibility alias for older renderer builds.
    openDocument: (id) => ipcRenderer.invoke('yayra:downloads-open-pdf', { id }),
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
    // Optional URL powers Chrome-style tab tear-off: the new Yayra window
    // boots directly on that site while preserving the selected profile.
    openWindow: (profileId, url = null, options = {}) => ipcRenderer.invoke('yayra:open-profile-window', {
      profileId,
      url,
      isPrivate: Boolean(options && options.isPrivate)
    })
  },
  // User-opt-in clipboard dictionary shortcut. The main process reads
  // clipboard text only when this explicit global shortcut is pressed.
  dictionary: {
    setGlobalLookupShortcut: (enabled, accelerator) => ipcRenderer.invoke('yayra:dictionary-set-global-shortcut', { enabled: Boolean(enabled), accelerator })
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
    // Explicit dictionary lookup handoff: preserves an existing mini window and its tabs.
    openDictionaryLookup: (url) => ipcRenderer.invoke('yayra:overlay-open-dictionary-lookup', { url }),
    onDictionaryLookup: (callback) => {
      if (typeof callback !== 'function') return () => {};
      dictionaryLookupListeners.add(callback);
      if (pendingDictionaryLookup) {
        const payload = pendingDictionaryLookup;
        pendingDictionaryLookup = null;
        queueMicrotask(() => { try { callback(payload); } catch { /* isolated listener */ } });
      }
      return () => dictionaryLookupListeners.delete(callback);
    },
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
    // Direct image bytes/URL -> Google's official Lens endpoints. The image
    // never passes through a Yayra server; main validates payload and result.
    googleLensUpload: ({ name, type, data, imageUrl, language, startedAt, width, height, viewportWidth, viewportHeight, tabId, isPrivate, profileId } = {}) => ipcRenderer.invoke('yayra:google-lens-upload', {
      name, type, data, imageUrl, language, startedAt, width, height, viewportWidth, viewportHeight,
      tabId, isPrivate, profileId
    }),
    createShortcut: ({ url, title } = {}) => ipcRenderer.invoke('yayra:create-shortcut', { url, title }),
    // Chrome-style "Install page as app...": real launcher entries that
    // reopen the site in its own minimal app window (yayra --app=<url>).
    installPageAsApp: ({ url, title, nameOverride, favicon } = {}) => ipcRenderer.invoke('yayra:install-page-as-app', { url, title, nameOverride, favicon }),
    installPageAsAppPreview: ({ url, title, favicon } = {}) => ipcRenderer.invoke('yayra:install-page-as-app-preview', { url, title, favicon }),
    // Local document workspace. Paths stay in the trusted main process: this
    // surface exposes opaque catalog ids, safe display metadata and (only
    // when opening a supported format) the explicitly requested file bytes.
    documents: {
      openFile: () => ipcRenderer.invoke('yayra:doc-open'),
      // Backward-compatible alias for existing renderer/tests and older minis.
      openPdf: () => ipcRenderer.invoke('yayra:doc-open'),
      list: () => ipcRenderer.invoke('yayra:doc-library-list'),
      reopen: (id) => ipcRenderer.invoke('yayra:doc-library-open', { id, external: false }),
      openLibraryExternal: (id) => ipcRenderer.invoke('yayra:doc-library-open', { id, external: true }),
      showInFolder: (id) => ipcRenderer.invoke('yayra:doc-library-show', { id }),
      locate: (id) => ipcRenderer.invoke('yayra:doc-library-locate', { id }),
      remove: (id) => ipcRenderer.invoke('yayra:doc-library-remove', { id }),
      clear: () => ipcRenderer.invoke('yayra:doc-library-clear'),
      clearMissing: () => ipcRenderer.invoke('yayra:doc-library-clear-missing'),
      prune: (olderThanDays) => ipcRenderer.invoke('yayra:doc-library-prune', { olderThanDays }),
      // "Open with desktop app" for session-only files: write the current
      // unchanged bytes to a temp file. Catalog files use openLibraryExternal.
      openExternal: ({ name, data } = {}) => ipcRenderer.invoke('yayra:doc-open-externally', { name, data }),
      // Download is separate from Desktop app: save the unchanged source
      // bytes to a user-selected destination instead of opening a temp copy.
      saveCopy: ({ name, data } = {}) => ipcRenderer.invoke('yayra:doc-save-copy', { name, data }),
      // OS "Open with > yayra" launches: the main process pushes the
      // user-chosen file's bytes; the shell opens them in its viewer.
      onOpenPdfFile: (callback) => {
        const listener = (_event, payload) => { try { callback(payload); } catch { /* shell not ready */ } };
        ipcRenderer.on('yayra:open-pdf-file', listener);
        return () => { try { ipcRenderer.removeListener('yayra:open-pdf-file', listener); } catch { /* gone */ } };
      }
    },
    // Real Chromium cache/site-data clearing across all Yayra sessions.
    clearBrowsingData: ({ cache = true, cookies = false, since = null, form = false } = {}) => ipcRenderer.invoke('yayra:clear-browsing-data', { cache, cookies, since, form }),
    configureSecureDns: ({ enabled = true, provider = 'automatic' } = {}) => ipcRenderer.invoke('yayra:configure-secure-dns', { enabled, provider })
  }
};

contextBridge.exposeInMainWorld('yayra', api);
contextBridge.exposeInMainWorld('ibrowse', api);
