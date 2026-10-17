/**
 * Yayra Floating Browser - Mainstream Browser-First Shell
 * Full Chrome-style Desktop Top Tab Strip & Omnibox + Safari-style Mobile Layout
 * Features:
 *  - Radial AI & Quick Actions Wheel on Bubble Double-Click (Gemini, ChatGPT, Claude, Perplexity, Crop, Notes, etc.)
 *  - Standalone Floating Mini-Browser Window Overlay on Bubble Single-Click with "Open Full Browser" button
 *  - Omnibox Security Lock Dropdown with Instant Search Engine Switcher (Google Default, DuckDuckGo, Bing, etc.)
 *  - Yayra App Logo & Brand Badge Beside Security Lock in Toolbar
 *  - Right-Side Full Drawer 3-Dot Menu with ZERO Blur on User Workspace
 *  - Frequently Used Sites with Authentic SVG Logos (DuckDuckGo, Wikipedia, GitHub, Yayra Docs)
 *  - Featured & Sponsored Links Banner Section Above Yayra Logo on New Tab Page with In-App Customizer
 *  - Cute Compact Tab Strip with Low-Profile Tabs
 *  - Transparent, Compact Toolbar Action Buttons (Downloads & Extensions matching Star size)
 *  - Downloads Page with Working "Visit File Location" and List vs Card View Mode Toggle
 *  - Complete In-Tab Internal Pages (yayra://settings, yayra://history, yayra://bookmarks,
 *    yayra://downloads, yayra://passwords, yayra://extensions, yayra://permissions, yayra://about, yayra://newtab)
 */

import { Icons } from '../icons/icons.js';
import qrcode from '../vendor/qrcode.js';
import { classifyDocument, DocumentStore, createPdfViewer, createDocumentViewerState, DOCUMENT_ENGINES } from '../services/documentWorkspace.js';
import { PasswordManager } from '../../../persistence/src/PasswordManager.js';
import { PasskeyService } from '../services/passkeyService.js';
import { ProfileService } from '../services/profileService.js';
import {
  createProfileScopedStorage,
  createHistoryRepo,
  createBookmarksRepo,
  createSettingsRepo,
  createEmailAddressesRepo,
  DEFAULT_BOOKMARK_GROUPS,
  DEFAULT_BOOKMARK_GROUP_ID,
  createWheelRepo,
  createShortcutsRepo,
  createSessionRepo
} from '../services/profileStorage.js';
import { YayraAiService, AI_DEFAULTS, describeAiReason } from '../services/aiService.js';
import { ExtensionManager, BUILT_IN_EXTENSIONS } from '../../../browser-contract/src/extensions/ExtensionManager.js';

/**
 * =========================================================================
 * DEVELOPER ADVERTISEMENT & FEATURED SPONSORED LINKS CONFIGURATION
 * =========================================================================
 * DEVELOPER GUIDE:
 * Add, edit, or remove advertisement & sponsored links directly in this array.
 * When built, Yayra displays authentic brand logos automatically above the
 * Yayra logo in a sleek, non-overshadowing badge row.
 *
 * Structure:
 *   - id: Unique key
 *   - title: Name / Tooltip on hover
 *   - url: Destination URL opened on click
 *   - domain: Host domain used for brand favicon resolution
 *
 * Example:
 *   { id: 'ad-google', title: 'Google AI & Cloud', url: 'https://cloud.google.com', domain: 'cloud.google.com' }
 * =========================================================================
 */
export const DEVELOPER_AD_LINKS = [
  { id: 'ad-rx-store', title: 'RX Store — Developer Sponsor', url: 'https://rx-store-web.pages.dev', domain: 'rx-store-web.pages.dev' },
  { id: 'ad-pharmatrack', title: 'PharmaTrack', url: 'https://pharmatrack-web.pages.dev/', domain: 'pharmatrack-web.pages.dev' },
  { id: 'ad-coderxsociety', title: 'CoderX Society', url: 'https://coderxsociety.pages.dev/', domain: 'coderxsociety.pages.dev' },
  { id: 'ad-cgpapilot', title: 'CGPA Pilot', url: 'https://cgpapilot.pages.dev/', domain: 'cgpapilot.pages.dev' },
  { id: 'ad-clinicalrx30', title: 'Clinical RX 30', url: 'https://clinicalrx30.vercel.app/', domain: 'clinicalrx30.vercel.app' }
];

// Escape a value for safe embedding inside an HTML attribute.
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Human wording for PasskeyService failure reasons.
function describePasskeyReason(reason) {
  switch (reason) {
    case 'passkeys-unsupported': return 'this device/browser does not support passkeys';
    case 'user-declined-or-timeout': return 'the request was cancelled or timed out';
    case 'authenticator-already-registered': return 'a passkey already exists on this authenticator';
    case 'insecure-context': return 'passkeys require a secure (HTTPS) context';
    case 'no-passkey-registered': return 'no passkey is registered yet';
    case 'keychain-unavailable': return 'the OS keychain is locked or unavailable on this device';
    case 'verification-failed': return 'the device passkey could not be verified';
    case 'device-storage-failed': return 'the passkey could not be saved on this device (check disk/app-data permissions)';
    case 'pin-invalid': return 'the PIN must be exactly 6 digits';
    case 'pin-required': return 'enter your 6-digit PIN';
    case 'wrong-pin': return 'wrong PIN';
    case 'pin-locked': return 'too many wrong PIN attempts - PIN entry is locked for a minute';
    case 'verification-cancelled': return 'the verification was cancelled';
    case 'system-auth-unavailable': return 'the system password prompt is unavailable on this device';
    case 'no-lan': return 'phone approval needs your PC to be on a Wi-Fi/LAN network the phone can reach';
    default: return reason || 'unknown error';
  }
}

// Apex hostnames (and all their subdomains) that are known to send
// X-Frame-Options / CSP frame-ancestors headers forbidding ANY iframe
// embedding — enforced by the target site itself, not something Yayra's
// own CSP can override. Kept as a static list so the floating browser can
// proactively fall back to "open in a new tab" instead of ever attempting
// (and visibly failing) to embed these.
const FRAME_EMBEDDING_BLOCKED_HOSTS = [
  'google.com', 'youtube.com',
  'facebook.com', 'instagram.com', 'threads.net', 'twitter.com', 'x.com', 'linkedin.com',
  'github.com',
  'amazon.com',
  'microsoft.com', 'live.com', 'outlook.com', 'office.com',
  'apple.com', 'icloud.com',
  'paypal.com',
  'netflix.com',
  'pinterest.com',
  'reddit.com',
  'yahoo.com',
  'duckduckgo.com', 'startpage.com',
  'stackoverflow.com', 'stackexchange.com',
  'nytimes.com', 'wsj.com',
  'twitch.tv',
  'bing.com'
];

// Keep in sync with GOOGLE_SIGN_IN_PATH in electron/webviewBridge.cjs.
// accounts.google.com has account pages as well as OAuth/sign-in endpoints,
// so host matching alone would send ordinary account browsing outside Yayra.
const GOOGLE_SIGN_IN_PATH = /^\/(?:o\/oauth2(?:\/|$)|oauth2(?:\/|$)|signin(?:\/|$)|servicelogin(?:\/|$)|accountchooser(?:\/|$)|v\d+\/signin(?:\/|$)|gsi\/select(?:\/|$))/i;

export class BrowserShell {
  static FRAME_EMBEDDING_BLOCKED_HOSTS = FRAME_EMBEDDING_BLOCKED_HOSTS;

  constructor(options = {}) {
    this.options = options;
    this.platform = options.platform || this.detectPlatform();
    this.container = options.container || null;

    // Navigation and repositories
    this.navigationController = options.navigationController || null;
    this.historyRepo = options.historyRepo || null;
    this.bookmarksRepo = options.bookmarksRepo || null;
    this.emailAddressesRepo = options.emailAddressesRepo || null;
    this.downloadsRepo = options.downloadsRepo || null;
    this.settingsRepo = options.settingsRepo || null;
    this.privacyManager = options.privacyManager || null;
    this.updateService = options.updateService || null;
    this.storageAdapter = options.storageAdapter || null;

    // Browser profiles + the Chrome-style "keep your browsing separate"
    // smart prompt. Created BEFORE the storage wiring below because all
    // real persistence is scoped to the current profile.
    this.profileService = options.profileService
      || new ProfileService({ storage: typeof localStorage !== 'undefined' ? localStorage : null });
    // Per-profile windows boot with ?profile=<id> (Electron
    // createProfileWindow / web window.open fallback): bind this window
    // to that profile before anything renders, so "Add profile" opens a
    // NEW window already living as the new profile while the original
    // window keeps its own.
    if (options.windowProfileId && this.profileService) {
      try {
        const exists = (this.profileService.list() || []).some((p) => p.id === options.windowProfileId);
        if (exists) this.profileService.switchTo(options.windowProfileId);
      } catch { /* unknown profile id - stay on the stored current one */ }
    }

    // REAL per-profile persistence. The shipped app used to construct
    // the shell with NO repositories at all, so bookmarks, history,
    // saved passwords and extension state silently went nowhere. When
    // the host didn't inject repos (production web + Electron), build
    // them here over localStorage, namespaced per profile. Tests that
    // inject fakes (or run without localStorage) are untouched.
    if (typeof localStorage !== 'undefined') {
      const scoped = createProfileScopedStorage({
        backing: localStorage,
        getProfileId: () => {
          try { return this.profileService.current().id; } catch { return 'default'; }
        },
        legacyKeys: { settings: 'yayra:settings', 'radial-wheel': 'yayra_radial_actions' }
      });
      this.profileStorage = scoped;
      if (!this.historyRepo) this.historyRepo = createHistoryRepo(scoped);
      if (!this.bookmarksRepo) this.bookmarksRepo = createBookmarksRepo(scoped);
      if (!this.emailAddressesRepo) this.emailAddressesRepo = createEmailAddressesRepo(scoped);
      if (!this.settingsRepo) this.settingsRepo = createSettingsRepo(scoped);
      if (!this.storageAdapter) this.storageAdapter = scoped;
      this.wheelRepo = options.wheelRepo || createWheelRepo(scoped);
      this.shortcutsRepo = options.shortcutsRepo || createShortcutsRepo(scoped);
      this.sessionRepo = options.sessionRepo || createSessionRepo(scoped);
    } else {
      this.profileStorage = null;
      this.wheelRepo = options.wheelRepo || null;
      this.shortcutsRepo = options.shortcutsRepo || null;
      this.sessionRepo = options.sessionRepo || null;
    }

    if (!this.emailAddressesRepo && this.storageAdapter
      && typeof this.storageAdapter.get === 'function' && typeof this.storageAdapter.set === 'function') {
      this.emailAddressesRepo = createEmailAddressesRepo(this.storageAdapter);
    }
    this.passwordManager = options.passwordManager || new PasswordManager(this.storageAdapter);
    this.extensionManager = options.extensionManager || new ExtensionManager(this.storageAdapter);
    // Passkey for the Yayra account: biometric/PIN gate for revealing
    // vault secrets + account security. Web/PWA uses real WebAuthn; the
    // Electron desktop (custom yayra:// scheme, where Chromium refuses
    // WebAuthn) uses the OS-keychain device-passkey bridge instead - see
    // get passkeysBridge() + electron/passkeyBridge.cjs. DI for tests.
    this.passkeyService = options.passkeyService
      || new PasskeyService({ storage: this.storageAdapter, nativeBridge: this.passkeysBridge });
    // Yayra AI (Chrome-style "AI options on every search"): omnibox "Ask
    // Yayra AI" row, the yayra://ai chat page, and Settings > Yayra AI.
    // See packages/shared-ui/src/services/aiService.js. DI for tests.
    this.aiService = options.aiService || new YayraAiService({ storage: this.storageAdapter });
    // One suggestion per account per session, even before "No thanks".
    this._profileSignalsSeen = new Set();
    // Guards so a page is only auto-filled once per navigation target.
    this._autofilledFor = new Set();
    // Set after a successful passkey ceremony so one unlock covers the
    // whole passwords-page visit instead of prompting per reveal.
    this._vaultUnlockedAt = 0;

    // Initial tabs setup
    const initialTabs = options.tabs && options.tabs.length > 0
      ? options.tabs.map((t) => ({ ...t, title: this.getTabTitle(t), favicon: this.getTabFavicon(t) }))
      : [
          {
            id: 'tab-1',
            title: options.initialUrl ? this.getTabTitle({ url: options.initialUrl }) : 'New Tab',
            url: options.initialUrl || 'yayra://newtab',
            isSecure: true,
            canGoBack: false,
            canGoForward: false,
            isLoading: false,
            isPrivate: false,
            favicon: null
          }
        ];

    let locallyPersistedSettings = {};
    if (typeof localStorage !== 'undefined') {
      try {
        locallyPersistedSettings = JSON.parse(localStorage.getItem('yayra:settings') || '{}');
      } catch {
        locallyPersistedSettings = {};
      }
    }

    // Reactive State
    this.state = {
      tabs: initialTabs,
      activeTabId: options.activeTabId || initialTabs[0]?.id || 'tab-1',
      desktopFloatingMode: options.desktopFloatingMode || 'browser-first',
      isMinimizedToBubble: false,
      // True while the native Android system-wide bubble service is live
      // (YayraOverlayPlugin) - suppresses the duplicate in-page bubble.
      systemBubbleActive: false,
      // Chrome-style "keep your browsing separate" card:
      // { email, action: 'suggest-create'|'suggest-switch', profileId? }
      profileSuggestion: null,
      isMobile: options.isMobile !== undefined ? options.isMobile : this.checkMobileViewport(),
      urlInputValue: initialTabs[0]?.url || 'yayra://newtab',
      activeModal: null, // 'menu', 'tab-switcher', 'sponsored-manager', etc.
      isSideDrawerOpen: false,
      isSecurityDropdownOpen: false,
      isRadialLauncherOpen: false,
      isFloatingMiniOpen: false,
      isBookmarked: false,
      zoomLevel: 100,
      isFullscreen: false,
      downloadsViewMode: 'list', // 'list' | 'card'
      findInPage: {
        isOpen: false,
        query: '',
        matchesCount: 0,
        currentMatch: 0
      },
      closedTabsHistory: [],
      historyItems: [],
      bookmarksItems: [],
      bookmarkGroups: DEFAULT_BOOKMARK_GROUPS.map((group) => ({ ...group })),
      bookmarkDefaultGroupId: DEFAULT_BOOKMARK_GROUP_ID,
      bookmarksActiveGroupId: DEFAULT_BOOKMARK_GROUP_ID,
      // Profile-scoped email addresses saved from submitted web forms.
      rememberedEmails: [],
      // Full previous-session snapshot, kept separately from the compact
      // five-item Continue prompt so a group click can reopen every member
      // recorded in that session.
      tabGroupRestoreTabs: [],
      // Chrome-style new tab: the user's own pinned shortcut tiles and
      // the previous session's not-manually-closed tabs ("Continue with
      // these tabs").
      userShortcuts: [],
      continueTabs: [],
      // Starts empty - no seeded/sample rows. On the Electron desktop build
      // this is populated from real `will-download` history (see
      // electron/downloadsBridge.cjs) in initialize() below; on builds
      // without that bridge (web/PWA/mobile) it honestly stays empty rather
      // than showing fake placeholder downloads.
      downloadsItems: [],
      downloadRoot: null,
      // System-wide floating overlay bubble (see electron/overlayWindow.cjs).
      // These mirror the Electron-side defaults so the UI shows sane values
      // even before overlayBridge.getSettings() resolves.
      overlaySettings: { enabled: true, launchAtStartup: true, overlayAllApps: true, positionLocked: false, shadowPx: 0 },
      passwordsItems: [],
      // API keys / tokens / secure notes living in the same encrypted vault.
      vaultKeysItems: [],
      // Vault behaviour flags mirrored from PasswordManager.getConfig().
      passwordsConfig: null,
      // Chrome-style "Save password?" bar (set when a login submission is
      // captured in a page; cleared on save / never / dismiss).
      pendingPasswordSave: null,
      // Which vault section is active on yayra://passwords.
      passwordsActiveSection: 'passwords',
      // Registered Yayra account passkey metadata (null = none yet).
      passkeyInfo: null,
      // Desktop device-passkey bridge report (availability, method,
      // Linux weak-keyring honesty flag). Null off-desktop.
      passkeyDeviceStatus: null,
      // Yayra AI: synchronous config snapshot (renders can't await), the
      // yayra://ai conversation of this session, and the busy flag while
      // an answer is being generated. ChatGPT-style, the conversation is
      // one CHAT out of many (aiChats, persisted to localStorage):
      // aiConversation is the ACTIVE chat's live messages array (same
      // object reference, so streaming paints into the chat directly).
      aiConfig: { ...AI_DEFAULTS },
      aiConversation: [],
      aiChats: [],
      aiActiveChatId: null,
      aiBusy: false,
      extensionsItems: [...BUILT_IN_EXTENSIONS],
      sponsoredLinks: DEVELOPER_AD_LINKS.map((item) => ({
        ...item,
        tag: 'Developer Sponsor'
      })),
      settingsActiveCategory: 'floating',
      activeSettingsCategory: 'floating',
      settingsSearchQuery: '',
      historySearchQuery: '',
      bookmarksSearchQuery: '',
      downloadsSearchQuery: '',
      passwordsSearchQuery: '',
      settings: {
        theme: 'dark',
        colorTheme: 'blue',
        searchEngine: 'google', // Requirement 13: Default search engine is Google
        floatingEnabledByDefault: true,
        startFloatingOnLaunch: true,
        alwaysOnTop: true,
        rememberPosition: true,
        rememberSize: true,
        minimizeToBubble: true,
        closeToTray: true,
        bubbleOpacity: 0.88,
        bubbleSizePx: 64,
        bubbleShadowPx: 0,
        frameOpacity: 0.85,
        glassmorphismBlurRadius: 24,
        savePasswordsEnabled: true,
        autofillEnabled: true,
        httpsFirst: true,
        adBlockEnabled: true,
        clearHistoryOnExit: false,
        restoreSessionOnLaunch: true,
        showBookmarksBar: false,
        // Pointer customization (Settings > Pointer): 'system' keeps the
        // native OS cursors (always the OS pointer size); custom themes
        // swap in SVG cursors at a chosen size. See applyPointerTheme().
        pointerTheme: 'system',
        pointerSize: 'normal',
        ...locallyPersistedSettings,
        ...options.initialSettings
      },
      updateState: {
        status: 'idle', // 'idle' | 'checking' | 'available' | 'ready' | 'uptodate'
        // Prefer the real installed version carried by the UpdateService (set
        // from the build's injected version at startup - see src/browser/main.js).
        // Falling back to a hardcoded literal here previously caused every
        // check to treat the live install as "behind" forever - see
        // checkForUpdates() below for the full fix.
        installedVersion: options.updateService?.installedVersion || null,
        availableVersion: null,
        notes: null
      },
      updatePromptShown: false,
      // In-app "Update available" card: { version, notes, desktopPipeline }
      updatePrompt: null,
      // Post-download install choice card: { path, version }
      updateInstallPrompt: null,
      // "Close Yayra?" prompt (close all / just close / keep all tabs)
      closePrompt: false,
      // Menu > Exit quits the whole desktop app after the session choice;
      // the tab-strip close button still closes only the current window.
      closePromptExitsApp: false,
      // "Reopen recent tabs?" offer after a plain close: [{url,title}]
      recentTabsOffer: null,
      // Real "Sign in with Google" app-level identity (Electron desktop only
      // for now - see electron/googleAuth.cjs + electron/authBridge.cjs).
      // This is unrelated to, and does not attempt, signing in to Google
      // services INSIDE the embedded browsing view, which Google's own
      // policy forbids for any embedded surface.
      googleAccount: {
        status: 'idle', // 'idle' | 'checking' | 'signing-in' | 'signed-in' | 'error'
        signedIn: false,
        profile: null,
        error: null,
        savedAt: null
      },
      // Persistent top-right account menu (see renderAccountDropdown()) -
      // separate from the Settings > Account page, which stays available too.
      isAccountMenuOpen: false,
      // Chrome-style downloads dropdown under the toolbar download button
      // (see renderDownloadsDropdown()) - tracks downloads without ever
      // yanking the user to the yayra://downloads page. The More toggle
      // expands all items inline without changing tabs.
      isDownloadsDropdownOpen: false,
      isDownloadsDropdownExpanded: false,
      // True while a transient popup that is NOT part of render() (omnibox
      // search-suggestion dropdown) is covering the page area. On Electron
      // the native page surface must be hidden for the popup to be seen at
      // all - see hasBlockingOverlay().
      isPageObscured: false
    };

    this.state.tabs.forEach((tab) => this.ensureNavigationState(tab));

    // DOM Elements
    this.rootElement = null;
    this.tabStripElement = null;
    this.omniboxInput = null;
    this.viewportElement = null;
    this.bubbleOverlay = null;
    // Persistent web-frame layer (web/PWA): survives re-renders so embedded
    // pages never reload when the chrome re-renders. See ensureWebFrameLayer().
    this.webFrameLayer = null;
    this.webFrames = new Map();
    // Strictly-increasing mount counter: pooled-frame LRU ordering must be
    // deterministic BY CONSTRUCTION - wall-clock Date.now() can tie or jitter
    // under load, which made eviction order (rarely) non-deterministic.
    this._pooledFrameEpoch = 0;
    this.activeWebFrameSlot = null;
    this.activeWebFrameTabId = null;
    this.lastRenderTarget = null;
    this._updateCheckTimer = null;
    this._overlayPermissionPromptShown = false;

    this.boundResizeHandler = () => this.handleViewportResize();
    this.boundKeyHandler = (e) => this.handleGlobalKeyDown(e);
    this._bookmarkCheckId = 0;
    // PRODUCTION SHIELD: one stray exception in any handler must never
    // look like a frozen app - errors are logged (rate-limited) and the
    // UI loop keeps running (see installGlobalErrorShield).
    this.installGlobalErrorShield();

    // Native website-rendering engine bridge (Electron desktop only - see
    // electron/webviewBridge.cjs). Subscribed once here, not per-render,
    // because the underlying native views persist across this class's
    // frequent full-DOM re-renders.
    this._nativeWebviewTabIds = new Set();
    // A handoff belongs to a tab and its auth URL, not to the whole shell.
    // Keeping it here prevents chrome re-renders from reopening the system
    // browser while the original tab URL/history remain intact.
    this._systemBrowserHandoffs = new Map();
    this._nativeWebviewResizeObservers = new Map();
    this._lastAppliedNativePointerConfig = null;
    this._lastAppliedAndroidPointerConfig = null;
    this._unsubscribeNativeWebview = null;
    // Last captured still image of each tab's native view, shown underneath
    // Yayra's own chrome (menu drawer, modals, mini window, dropdowns)
    // while the native surface is hidden - a native WebContentsView always
    // paints ABOVE the HTML document, so this snapshot swap is what makes
    // in-app panels genuinely overlay the page instead of the page covering
    // (and visually "carding over") the panels.
    this._pageSnapshots = new Map();
    if (this.nativeWebview) {
      this._unsubscribeNativeWebview = this.nativeWebview.onEvent((evt) => this.handleNativeWebviewEvent(evt));
    }

    // Live desktop update progress (electron/desktopUpdater.cjs events).
    this._unsubscribeUpdatesBridge = null;
    const updatesBridge = this.desktopUpdatesBridge;
    if (updatesBridge && typeof updatesBridge.onEvent === 'function') {
      this._unsubscribeUpdatesBridge = updatesBridge.onEvent((evt) => this.handleDesktopUpdateEvent(evt));
    }

    // "Sign in with Google" bridge (Electron desktop only - see get authBridge()
    // below). Restores any previously-signed-in session and keeps the UI in
    // sync with sign-in/sign-out/error events fired from the main process.
    this._unsubscribeAuthBridge = null;
    if (this.authBridge) {
      this._unsubscribeAuthBridge = this.authBridge.onEvent((evt) => this.handleGoogleAuthEvent(evt));
      this.authBridge.getSession()
        .then((session) => {
          if (session?.signedIn) {
            this.state.googleAccount = { status: 'signed-in', signedIn: true, profile: session.profile, error: null, savedAt: session.savedAt || null };
            this.handleAccountSignal(session.profile?.email, { source: 'yayra-account' });
            this.render();
          }
        })
        .catch(() => {
          // No prior session or the bridge isn't ready yet - leave the
          // default signed-out state as-is.
        });
    }

    if (typeof window !== 'undefined') {
      setTimeout(() => {
        this.checkForUpdates(false);
      }, 1200);
      this.startBackgroundUpdateChecks();
      // Android (Capacitor): bring up the REAL system-wide bubble so it
      // floats over every opened app from the moment Yayra starts.
      setTimeout(() => {
        this.ensureSystemOverlayBubble();
      }, 600);
    }

    // When the theme preference is "system", follow live OS light/dark
    // switches. Guarded: dom-shim/test environments may lack matchMedia
    // or its event API.
    try {
      if (typeof matchMedia === 'function') {
        const mq = matchMedia('(prefers-color-scheme: light)');
        const onSchemeChange = () => {
          if ((this.state.settings.theme || 'dark') === 'system') this.render();
        };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSchemeChange);
        else if (typeof mq.addListener === 'function') mq.addListener(onSchemeChange);
      }
    } catch {
      // Theme still resolves correctly at each render; live OS tracking
      // is a progressive enhancement.
    }
  }

  // window.yayra.webview (exposed by electron/preload.cjs) only exists when
  // running inside the Electron desktop shell. Its absence (plain web/PWA
  // tab, or Android/iOS Capacitor WebView) is the signal to fall back to the
  // <iframe>-based renderer, which is the only option available there.
  get nativeWebview() {
    if (typeof window === 'undefined') return null;
    return (window.yayra && window.yayra.webview) || (window.ibrowse && window.ibrowse.webview) || null;
  }

  // window.yayra.auth (exposed by electron/preload.cjs, backed by
  // electron/authBridge.cjs + electron/googleAuth.cjs) only exists on the
  // Electron desktop build. Its absence is the signal that real "Sign in
  // with Google" app-level identity isn't wired up for this build yet (web/
  // PWA/mobile), so the Settings UI shows an honest "not available on this
  // build" message instead of a button that would silently do nothing.
  get authBridge() {
    if (typeof window === 'undefined') return null;
    return (window.yayra && window.yayra.auth) || (window.ibrowse && window.ibrowse.auth) || null;
  }

  // window.yayra.downloads (exposed by electron/preload.cjs, backed by
  // electron/downloadsBridge.cjs) only exists on the Electron desktop
  // build. Its absence means there is no real OS-level download tracking
  // available for this build, so the Downloads page honestly shows an
  // empty list instead of decorative placeholder rows.
  get downloadsBridge() {
    if (typeof window === 'undefined') return null;
    return (window.yayra && window.yayra.downloads) || (window.ibrowse && window.ibrowse.downloads) || null;
  }

  // window.yayra.passkeys (exposed by electron/preload.cjs, backed by
  // electron/passkeyBridge.cjs): OS-keychain device passkey for the
  // Electron desktop, where Chromium refuses real WebAuthn on the custom
  // yayra:// scheme. Web/PWA builds (real https origin) keep genuine
  // WebAuthn and this getter returns null there.
  get passkeysBridge() {
    if (typeof window === 'undefined') return null;
    const bridge = (window.yayra && window.yayra.passkeys) || (window.ibrowse && window.ibrowse.passkeys) || null;
    return bridge && typeof bridge.register === 'function' ? bridge : null;
  }

  // window.yayra.profiles (electron/preload.cjs → yayra:open-profile-window
  // in electron/main.cjs): opens a profile in its OWN new Yayra window,
  // Chrome-style, while this window stays on its current profile.
  get profileWindowsBridge() {
    if (typeof window === 'undefined') return null;
    const bridge = (window.yayra && window.yayra.profiles) || (window.ibrowse && window.ibrowse.profiles) || null;
    return bridge && typeof bridge.openWindow === 'function' ? bridge : null;
  }

  // window.yayra.overlay (exposed by electron/preload.cjs, backed by
  // electron/overlayWindow.cjs) - the system-wide floating overlay bubble's
  // settings. See Settings > Floating Overlay.
  get overlayBridge() {
    if (typeof window === 'undefined') return null;
    return (window.yayra && window.yayra.overlay) || (window.ibrowse && window.ibrowse.overlay) || null;
  }

  // window.yayra.windowControls (electron/preload.cjs): real minimize/
  // maximize/close for the frameless Electron main window. The OS title
  // bar (which just said "yayra") and the File/Edit/View/Window menu block
  // are removed - Yayra's own tab strip is the title bar, so it shows the
  // brand wordmark image and these controls instead. Absent on web/PWA,
  // where the browser provides the window chrome.
  get windowControls() {
    if (typeof window === 'undefined') return null;
    const bridge = (window.yayra && window.yayra.windowControls) || (window.ibrowse && window.ibrowse.windowControls) || null;
    return bridge && typeof bridge.close === 'function' ? bridge : null;
  }

  // window.yayra.updates (exposed by electron/preload.cjs, backed by
  // electron/desktopUpdater.cjs): main-process download+verify+install for
  // desktop updates. Only treated as present when the REAL pipeline
  // (download) exists - older builds exposed check/install stubs only.
  get desktopUpdatesBridge() {
    if (typeof window === 'undefined') return null;
    const bridge = (window.yayra && window.yayra.updates) || (window.ibrowse && window.ibrowse.updates) || null;
    return bridge && typeof bridge.download === 'function' ? bridge : null;
  }

  /**
   * True whenever any piece of Yayra chrome that must appear ABOVE the page
   * is open. On Electron the page is a native WebContentsView - a sibling
   * OS surface that always paints over the HTML document - so while any of
   * these are open the native surface is hidden and replaced by its last
   * snapshot (see attachNativeWebviewSlot/syncNativeWebviewVisibility).
   * On web/PWA/mobile builds this has no effect: iframes stack normally
   * under positioned/z-indexed chrome.
   */
  hasBlockingOverlay() {
    const s = this.state;
    return Boolean(
      s.isSideDrawerOpen ||
      s.activeModal ||
      s.isSecurityDropdownOpen ||
      s.isAccountMenuOpen ||
      s.isDownloadsDropdownOpen ||
      s.isFloatingMiniOpen ||
      s.isRadialLauncherOpen ||
      (s.findInPage && s.findInPage.isOpen) ||
      Boolean(s.pendingPasswordSave) ||
      // The close-session prompt ("Close all tabs / Just close / Keep
      // all tabs") was MISSING here: with a real site open, the native
      // page surface painted right over it, so the close button looked
      // dead on desktop - "sometimes the close button misbehaves".
      s.closePrompt ||
      // A body-mounted install confirmation is outside render(), but it must
      // still keep the desktop native page surface out of the way.
      Boolean(typeof document !== 'undefined' && document.getElementById('yayra-install-app-overlay')) ||
      // Text prompts are body-mounted so they can sit above the renderer
      // tree; on desktop they also need the native page surface hidden.
      Boolean(typeof document !== 'undefined' && document.querySelector('.fb-text-prompt-overlay')) ||
      // The update prompt cards ("Update available - now or later?" and
      // "Update downloaded - install when?") were missing for the SAME
      // reason: with a real site open the native page surface painted
      // right over the prompt, so on desktop it never really appeared.
      // While either is up the page is held back - THE update prompt must
      // overlay anything.
      s.updatePrompt ||
      s.updateInstallPrompt ||
      s.isPageObscured
    );
  }

  async signInWithGoogle() {
    if (!this.authBridge) return;
    this.state.googleAccount = { ...this.state.googleAccount, status: 'signing-in', error: null };
    this.render();
    const result = await this.authBridge.signIn();
    if (!result?.ok) {
      this.state.googleAccount = { status: 'error', signedIn: false, profile: null, error: result?.error || 'sign_in_failed', savedAt: null };
      this.render();
    }
    // On success the 'signed-in' event from handleGoogleAuthEvent() already
    // updates state + re-renders; nothing further to do here.
  }

  // "Switch account" reuses the exact same sign-in flow: the authorization
  // URL built in electron/googleAuth.cjs already passes
  // `prompt=consent select_account`, so Google shows its account chooser
  // again even though a session is already saved, and the newly chosen
  // profile simply overwrites the old one on success.
  async switchGoogleAccount() {
    this.state.isAccountMenuOpen = false;
    return this.signInWithGoogle();
  }

  async signOutOfGoogle() {
    if (!this.authBridge) return;
    this.state.isAccountMenuOpen = false;
    await this.authBridge.signOut();
  }

  // Opens Google's own "Manage your Account" page in the user's system
  // browser (never embedded - see electron/authBridge.cjs for why).
  async openGoogleAccountPage() {
    if (!this.authBridge?.openAccountPage) return;
    this.state.isAccountMenuOpen = false;
    this.render();
    await this.authBridge.openAccountPage();
  }

  toggleAccountMenu() {
    this.state.isAccountMenuOpen = !this.state.isAccountMenuOpen;
    this.render();
  }

  handleGoogleAuthEvent(evt) {
    if (!evt) return;
    switch (evt.type) {
      case 'signing-in':
        this.state.googleAccount = { ...this.state.googleAccount, status: 'signing-in', error: null };
        break;
      case 'signed-in':
        this.state.googleAccount = { status: 'signed-in', signedIn: true, profile: evt.profile, error: null, savedAt: new Date().toISOString() };
        this.handleAccountSignal(evt.profile?.email, { source: 'yayra-account' });
        break;
      case 'signed-out':
        this.state.googleAccount = { status: 'idle', signedIn: false, profile: null, error: null, savedAt: null };
        break;
      case 'error':
        this.state.googleAccount = { status: 'error', signedIn: false, profile: null, error: evt.message || 'sign_in_failed', savedAt: null };
        break;
      default:
        return;
    }
    this.render();
  }

  // Capacitor's native in-app browser (SFSafariViewController on iOS, Chrome
  // Custom Tabs on Android) — used on Android/iOS builds, which run the
  // whole app (including this file) inside ONE Capacitor WebView. That outer
  // WebView is still a real Chromium/WebKit engine and enforces the exact
  // same X-Frame-Options / frame-ancestors restrictions against any nested
  // <iframe> as a desktop browser would, and Google/Apple/Microsoft apply
  // the same embedded-webview sign-in block there too. Only active when
  // actually running as a packaged native app (`Capacitor.isNativePlatform()`),
  // never for the plain web/PWA build, where window.Capacitor is absent.
  get capacitorBrowser() {
    if (typeof window === 'undefined') return null;
    const capacitor = window.Capacitor;
    if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
    return (capacitor.Plugins && capacitor.Plugins.Browser) || null;
  }

  // Native Android system-wide floating bubble bridge (YayraOverlayPlugin -
  // see packages/floating-android/src/kotlin and
  // scripts/ensure-capacitor-platform.mjs). When present AND the user has
  // granted "Display over other apps", the bubble is a REAL OS overlay that
  // floats above every other application - the Android equivalent of the
  // Electron native overlay window. Feature-detected, so plain web/PWA and
  // test environments without the plugin fall back to the in-page bubble.
  get capacitorOverlay() {
    if (typeof window === 'undefined') return null;
    const capacitor = window.Capacitor;
    if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
    const plugin = capacitor.Plugins && capacitor.Plugins.YayraOverlay;
    if (!plugin || typeof plugin.show !== 'function') return null;
    return plugin;
  }

  // ANDROID NATIVE TAB WEBVIEW ENGINE (YayraOverlayPlugin.tabWeb* backed
  // by YayraTabWebviewManager.kt): real WebViews layered INSIDE Yayra's
  // own activity window - the Android equivalent of the desktop
  // WebContentsView engine. A top-level WebView navigation has no
  // iframe/X-Frame-Options restrictions, so frame-hostile sites (Google,
  // YouTube, X, Facebook, ...) genuinely render IN the app instead of
  // being handed off to Chrome Custom Tabs ("open in other app").
  get capacitorTabWeb() {
    if (typeof window === 'undefined') return null;
    const capacitor = window.Capacitor;
    if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
    const plugin = capacitor.Plugins && capacitor.Plugins.YayraOverlay;
    if (!plugin || typeof plugin.tabWebAttach !== 'function') return null;
    return plugin;
  }

  /**
   * Start the Android system-wide bubble so it floats over EVERY opened
   * app, not just inside Yayra. Called once shortly after startup and
   * again from minimizeToBubble(). If the overlay permission hasn't been
   * granted yet, the user is told why and taken to the system "Display
   * over other apps" page (once per session - never a nag loop).
   */
  async ensureSystemOverlayBubble({ fromUserAction = false } = {}) {
    const overlay = this.capacitorOverlay;
    if (!overlay) return false;
    try {
      const res = typeof overlay.hasPermission === 'function' ? await overlay.hasPermission() : { granted: true };
      if (res && res.granted) {
        await overlay.show();
        if (!this.state.systemBubbleActive) {
          this.state.systemBubbleActive = true;
          // The native bubble replaces the in-page one - re-render so
          // ensurePersistentAssistiveBubble can remove the duplicate.
          this.render();
        }
        return true;
      }
      if (!this._overlayPermissionPromptShown && (fromUserAction || typeof overlay.requestPermission === 'function')) {
        this._overlayPermissionPromptShown = true;
        this.showTransientNotice('Allow "Display over other apps" so the Yayra bubble can float over everything.');
        await overlay.requestPermission?.();
      }
      // THE FIX for "granted the permission but the bubble never appears":
      // Android grants this permission on a separate Settings page, so
      // requestPermission() always resolves with the PRE-grant state. Watch
      // for the grant (app-resume + a bounded poll) and start the bubble
      // the moment it lands - no restart, no second tap needed.
      this._watchOverlayPermissionGrant();
    } catch (err) {
      this.logger?.(`[overlay] system bubble unavailable: ${err?.message || err}`);
    }
    return false;
  }

  /**
   * Watches for the "Display over other apps" grant after the user has been
   * sent to the system Settings page, and starts the system bubble the
   * instant the permission turns up. Three triggers, all feature-detected:
   * document visibilitychange (user returns to the app), Capacitor's
   * App.appStateChange, and a bounded 1.5s poll (3 minutes max) for OEMs
   * that show Settings as a floating pane without a visibility change.
   * Idempotent - only one watcher runs at a time; stopped on grant,
   * timeout, or destroy().
   */
  _watchOverlayPermissionGrant() {
    if (this._overlayGrantWatchActive) return;
    const overlay = this.capacitorOverlay;
    if (!overlay || typeof overlay.hasPermission !== 'function') return;
    this._overlayGrantWatchActive = true;

    let pollTimer = null;
    let appListener = null;
    const doc = typeof document !== 'undefined' ? document : null;

    const stopWatch = () => {
      this._overlayGrantWatchActive = false;
      this._stopOverlayGrantWatch = null;
      if (pollTimer && typeof clearInterval === 'function') clearInterval(pollTimer);
      pollTimer = null;
      try { doc?.removeEventListener?.('visibilitychange', onVisible); } catch { /* shim */ }
      try { appListener?.remove?.(); } catch { /* plugin gone */ }
      appListener = null;
    };
    this._stopOverlayGrantWatch = stopWatch;

    const recheck = async () => {
      try {
        const res = await overlay.hasPermission();
        if (!res || !res.granted) return false;
        stopWatch();
        await overlay.show();
        this.state.systemBubbleActive = true;
        this.showTransientNotice?.('Yayra bubble is on - it now floats over your other apps.');
        this.render();
        return true;
      } catch {
        return false;
      }
    };
    const onVisible = () => {
      if (!doc || doc.hidden !== true) recheck();
    };

    try { doc?.addEventListener?.('visibilitychange', onVisible); } catch { /* shim */ }
    try {
      const app = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
      if (app && typeof app.addListener === 'function') {
        appListener = app.addListener('appStateChange', (state) => {
          if (state && state.isActive) recheck();
        });
      }
    } catch { /* plugin optional */ }
    if (typeof setInterval === 'function') {
      let polls = 0;
      pollTimer = setInterval(() => {
        polls += 1;
        if (polls > 120) { stopWatch(); return; } // 3 minutes, then stand down
        recheck();
      }, 1500);
      // Node-only (no-op in browsers/WebViews): never keep a test runner's
      // event loop alive just because a permission poll is pending.
      if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    }
  }

  // Keep in sync with SYSTEM_BROWSER_AUTH_HOSTS and GOOGLE_SIGN_IN_PATH in
  // electron/webviewBridge.cjs. Duplicated rather than imported because that
  // module is CommonJS/Electron-only and this file ships in web/PWA/Capacitor.
  static SYSTEM_BROWSER_AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.live.com', 'login.microsoftonline.com'];

  // Chrome-style keep-alive: loaded pages are never reloaded in the
  // background; the live-page pool is bounded by an LRU cap instead
  // (memory saver). 8 live pages is Chrome-grade generosity while keeping
  // a lid on memory on low-end Android devices.
  static MAX_POOLED_FRAMES = 8;

  isSystemBrowserAuthHost(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      const hostname = parsed.hostname.toLowerCase();
      return BrowserShell.SYSTEM_BROWSER_AUTH_HOSTS.some((host) => {
        if (host === 'accounts.google.com') {
          return hostname === host && GOOGLE_SIGN_IN_PATH.test(parsed.pathname);
        }
        return hostname === host || hostname.endsWith(`.${host}`);
      });
    } catch (_err) {
      return false;
    }
  }

  // Opens a URL using the best available system-level surface: Capacitor's
  // native in-app browser on Android/iOS, or a plain new browser tab/window
  // everywhere else (desktop web/PWA). Electron has its own main-process
  // handoff (shell.openExternal, see electron/webviewBridge.cjs) and never
  // reaches this method for auth hosts.
  async openExternally(url) {
    let externalUrl = url;
    if (this.isSystemBrowserAuthHost(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:') {
          parsed.protocol = 'https:';
          externalUrl = parsed.toString();
        }
      } catch { /* the classifier already rejects malformed URLs */ }
    }
    const capacitorBrowser = this.capacitorBrowser;
    if (capacitorBrowser && typeof capacitorBrowser.open === 'function') {
      try {
        await capacitorBrowser.open({ url: externalUrl });
        return;
      } catch (err) {
        console.warn('[yayra] Capacitor Browser.open() failed, falling back to window.open', err);
      }
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(externalUrl, '_blank', 'noopener,noreferrer');
    }
  }

  detectPlatform() {
    if (typeof navigator === 'undefined') return 'linux';
    const ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua)) return 'linux';
    return 'desktop';
  }

  checkMobileViewport() {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768;
  }

  async initialize() {
    // Honour last session's close choice (keep all tabs -> reopen them;
    // just close -> offer them) and any "install update when opened
    // again" scheduled last run. Both are consumed exactly once.
    this.restoreCloseSession();
    // ChatGPT-style AI chats: restore every saved conversation so any of
    // them can be continued later (the active thread starts fresh).
    this._loadAiChats();
    // Web/PWA: capture the browser's install prompt so "Install page as
    // app..." can trigger the REAL install flow (see installPageAsApp).
    this._capturePwaInstallPrompt();
    this._armConnectivityAwareness();
    // Local document workspace (Phase 1: PDF) - in-memory, local-first.
    this.documentStore = new DocumentStore();
    // Keep one PDF.js controller per document tab. The shell rebuilds its DOM
    // on tab switches/resizes; the controller is reattached instead of
    // reparsing the same bytes or leaving a spinner on a stale DOM node.
    this._documentViewerSessions = new Map();
    // Android native tab webview engine bookkeeping (tab id -> engine).
    this._androidTabWebIds = new Set();
    this._androidTabWebResizeObservers = new Map();
    // Android: "installed site" home-screen shortcuts deep-link back into
    // Yayra via com.yayra.app:/browse?url=... - handle them on launch and
    // on every cold/warm reopen.
    this._handleAppModeLaunchUrls();
    // Android native tab engine: engine events (loading, address changes,
    // titles, nav state) + the hardware Back button (which must walk the
    // NATIVE webview's history before it can exit the app).
    this._unsubscribeTabWebEvents = null;
    this._unsubscribeAndroidBackButton = null;
    try {
      const tabPlugin = this.capacitorTabWeb;
      if (tabPlugin && typeof tabPlugin.addListener === 'function') {
        const handle = tabPlugin.addListener('tabWebEvent', (evt) => this.handleAndroidTabWebEvent(evt));
        this._unsubscribeTabWebEvents = () => {
          try { Promise.resolve(handle).then((h) => h?.remove?.()).catch(() => {}); } catch { /* gone */ }
        };
      }
      const app = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
      if (app && typeof app.addListener === 'function') {
        const backHandle = app.addListener('backButton', () => this.handleAndroidBackButton());
        this._unsubscribeAndroidBackButton = () => {
          try { Promise.resolve(backHandle).then((h) => h?.remove?.()).catch(() => {}); } catch { /* gone */ }
        };
      }
    } catch { /* optional plugin surface */ }
    // Desktop "Open with > yayra" launches: the main process pushes the
    // chosen file's bytes - open them straight in the document viewer.
    this._unsubscribeOpenPdfFile = null;
    try {
      const docBridge = this.systemBridge && this.systemBridge.documents;
      if (docBridge && typeof docBridge.onOpenPdfFile === 'function') {
        this._unsubscribeOpenPdfFile = docBridge.onOpenPdfFile(({ name, data } = {}) => {
          if (!data) return;
          this.addDocumentTab({ name: name || 'document.pdf', bytes: data });
        });
      }
    } catch { /* optional bridge */ }
    // Drag any PDF onto ANY part of Yayra -> it opens in the viewer.
    this._armPdfDropZone();
    this.processPendingInstallOnLaunch().catch(() => {});

    if (this.settingsRepo) {
      try {
        const stored = await this.settingsRepo.getSettings();
        if (stored) {
          this.state.settings = { ...this.state.settings, ...stored };
          if (stored.desktopFloatingMode && !this.options.desktopFloatingMode) {
            this.state.desktopFloatingMode = stored.desktopFloatingMode;
          }
        }
      } catch (err) {
        console.warn('Failed to load settings in BrowserShell:', err);
      }
    }

    if (this.historyRepo && typeof this.historyRepo.getEntries === 'function') {
      try {
        this.state.historyItems = await this.historyRepo.getEntries(100);
      } catch (err) {
        console.warn('Failed to load history in BrowserShell:', err);
      }
    }

    if (this.bookmarksRepo && typeof this.bookmarksRepo.getAllBookmarks === 'function') {
      try {
        await this.refreshBookmarksState();
      } catch (err) {
        console.warn('Failed to load bookmarks in BrowserShell:', err);
      }
    }
    if (this.emailAddressesRepo && typeof this.emailAddressesRepo.getAllEmails === 'function') {
      try { await this.refreshEmailAddressesState(); } catch (err) {
        console.warn('Failed to load saved email addresses in BrowserShell:', err);
      }
    }

    // New-tab shortcut tiles (Chrome's "Add shortcut" row).
    if (this.shortcutsRepo && typeof this.shortcutsRepo.getShortcuts === 'function') {
      try {
        this.state.userShortcuts = await this.shortcutsRepo.getShortcuts();
      } catch (err) {
        console.warn('Failed to load new-tab shortcuts in BrowserShell:', err);
      }
    }

    // "Continue with these tabs": what the PREVIOUS run left open (tabs
    // the user closed by hand were already dropped from the snapshot).
    // Read BEFORE this run's own snapshot starts overwriting it.
    if (this.sessionRepo && typeof this.sessionRepo.getLastSession === 'function') {
      try {
        const prev = await this.sessionRepo.getLastSession();
        const openNow = new Set(this.state.tabs.map((t) => t.url));
        const previousTabs = (prev.tabs || []).filter((t) => !t?.isPrivate && /^https?:\/\//i.test(t?.url || ''));
        this.state.tabGroupRestoreTabs = previousTabs;
        this.state.continueTabs = previousTabs.filter((t) => !openNow.has(t.url)).slice(0, 5);
        // Identifies THIS snapshot so "No thanks" dismisses exactly it
        // (a future session's tabs will prompt again).
        this.state.continueSavedAt = prev.savedAt || null;
      } catch (err) {
        console.warn('Failed to load the previous session in BrowserShell:', err);
      }
    }

    // Radial action wheel: load this profile's saved customization (the
    // old build wrote customizations to localStorage but never read them
    // back, so every restart silently reset the wheel).
    if (this.wheelRepo) {
      try {
        const storedWheel = await this.wheelRepo.getItems();
        if (storedWheel && storedWheel.length) {
          this.state.customRadialActions = this.hydrateWheelItems(storedWheel);
        }
      } catch (err) {
        console.warn('Failed to load the radial wheel in BrowserShell:', err);
      }
    }

    // Real download history + the user's chosen storage root (Electron
    // desktop build only - see electron/downloadsBridge.cjs). Also listens
    // for live progress/completion events so the Downloads page updates in
    // real time while something is downloading, instead of only on next
    // render.
    if (this.downloadsBridge) {
      try {
        const { items, downloadRoot } = await this.downloadsBridge.list();
        this.state.downloadsItems = items || [];
        this.state.downloadRoot = downloadRoot || null;
      } catch (err) {
        console.warn('Failed to load downloads in BrowserShell:', err);
      }
      if (typeof this.downloadsBridge.onEvent === 'function') {
        // Smart handling: per-chunk progress updates the toolbar ring and
        // any visible dropdown row IN PLACE; only started/done (structural
        // changes) trigger a full render. See handleDownloadEvent().
        this.downloadsBridge.onEvent((payload) => this.handleDownloadEvent(payload));
      }
    }

    // System-wide floating overlay bubble settings (Electron desktop build
    // only - see electron/overlayWindow.cjs). The overlay window itself
    // runs independently of this renderer; this just reflects/edits its
    // settings from Settings > Floating & Transparency.
    if (this.overlayBridge) {
      try {
        const settings = await this.overlayBridge.getSettings();
        if (settings) {
          this.state.overlaySettings = { ...this.state.overlaySettings, ...settings };
          // Keep the Settings sliders in sync with the native bubble's
          // persisted size so the UI shows what's actually on screen.
          if (Number.isFinite(Number(settings.size)) && Number(settings.size) > 0) {
            this.state.settings.bubbleSizePx = Number(settings.size);
          }
          if (Number.isFinite(Number(settings.shadowPx))) {
            this.state.settings.bubbleShadowPx = Math.max(0, Math.min(24, Number(settings.shadowPx)));
          }
        }
      } catch (err) {
        console.warn('Failed to load overlay settings in BrowserShell:', err);
      }
      // Keep the native bubble's double-tap radial in lockstep with the
      // in-app customizable wheel, and execute wheel actions the native
      // ring can't run itself (notes, duplicate window, customize, ...).
      this.syncWheelToOverlay();
      if (typeof this.overlayBridge.onWheelAction === 'function') {
        try {
          this.overlayBridge.onWheelAction((actionId) => {
            this.executeWheelActionById(actionId);
          });
        } catch { /* older preload without the channel */ }
      }
    }

    // Yayra AI config snapshot for synchronous renders (omnibox row,
    // settings section, yayra://ai page).
    if (this.aiService) {
      try {
        this.state.aiConfig = await this.aiService.getConfig();
      } catch {
        this.state.aiConfig = { ...AI_DEFAULTS };
      }
    }

    if (this.passwordManager && typeof this.passwordManager.getAllCredentials === 'function') {
      try {
        this.state.passwordsItems = await this.passwordManager.getAllCredentials();
      } catch (err) {
        console.warn('Failed to load passwords in BrowserShell:', err);
      }
    }
    await this.refreshVaultState();

    if (this.extensionManager && typeof this.extensionManager.getExtensions === 'function') {
      try {
        this.state.extensionsItems = await this.extensionManager.getExtensions();
      } catch (err) {
        console.warn('Failed to load extensions in BrowserShell:', err);
        this.state.extensionsItems = [...BUILT_IN_EXTENSIONS];
      }
    } else if (!this.state.extensionsItems || this.state.extensionsItems.length === 0) {
      this.state.extensionsItems = [...BUILT_IN_EXTENSIONS];
    }

    const activeTab = this.getActiveTab();
    if (activeTab) {
      await this.updateBookmarkState(activeTab.url);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.boundResizeHandler);
      window.addEventListener('keydown', this.boundKeyHandler);
    }

    // First open on a NEW version (i.e. right after an update installed):
    // celebrate with the quick Yayra-orb animation + the freshly
    // installed version number.
    this.maybeShowUpdateSplash();

    // Chrome-style live pages: internal data pages keep refreshing
    // themselves in the background (poll + cross-window storage events).
    this.startBackgroundRefresh();
  }

  /**
   * Compare the running version against the one recorded last run; when
   * it moved forward, the update that was installed gets its moment. The
   * marker updates every launch, so the splash shows exactly once per
   * new version - honest: no stored previous version (first install) =
   * no "updated" claim.
   */
  maybeShowUpdateSplash() {
    if (typeof localStorage === 'undefined') return false;
    const current = this.state.updateState?.installedVersion;
    if (!current) return false;
    let previous = null;
    try {
      previous = localStorage.getItem('yayra:last-run-version');
      localStorage.setItem('yayra:last-run-version', current);
    } catch {
      return false;
    }
    if (!previous || previous === current) return false;
    this.showUpdateSplash(current, previous);
    return true;
  }

  /** The animation itself: spinning/glowing Yayra orb + installed version. */
  showUpdateSplash(version, previousVersion = null) {
    if (typeof document === 'undefined' || !document.body) return;
    // Never stack two splashes (e.g. re-init in the same session).
    document.querySelector('.fb-update-splash')?.remove();
    const splash = document.createElement('div');
    splash.className = 'fb-update-splash';
    splash.setAttribute('role', 'status');
    splash.setAttribute('aria-label', `Yayra updated to version ${version}`);
    splash.innerHTML = `
      <div class="fb-update-splash-stage">
        <span class="fb-update-splash-ring"></span>
        <span class="fb-update-splash-ring fb-update-splash-ring-2"></span>
        <div class="fb-update-splash-orb">${Icons.officialOrb}</div>
        <div class="fb-update-splash-text">
          <strong class="fb-update-splash-title">Yayra updated</strong>
          <span class="fb-update-splash-version">v${version}</span>
          ${previousVersion ? `<span class="fb-update-splash-from">from v${previousVersion}</span>` : ''}
        </div>
      </div>`;
    // FREEZE FIX: stamp the birth time - render() force-retires any splash
    // still on screen after 10s, no matter what happened to its timers.
    try { splash.dataset.shownAt = String(Date.now()); } catch { /* dataset is a plain object in shims */ }
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      // Hand the live page surface back (desktop) the instant the splash
      // starts leaving - every dismiss path restores it, and the page is
      // interactive again immediately (the leave state ignores input).
      try { if (this.nativeWebview) this.setPageObscured(false); } catch { /* no native view */ }
      // The leave state must stop eating input IMMEDIATELY: an animated
      // but present splash still swallows every click and wheel event, and
      // its removal timer can be throttled away in a hidden window.
      splash.classList.add('fb-update-splash-leave');
      const kill = () => { try { splash.remove(); } catch { /* already gone */ } };
      // Hidden page: don't wait for an animation or a follow-up timer -
      // both are frozen/throttled in background windows. Remove NOW.
      if (typeof document !== 'undefined' && document.hidden === true) {
        kill();
        return;
      }
      splash.addEventListener?.('animationend', kill);
      setTimeout(kill, 600); // belt and braces: removal never hangs on one timer
    };
    splash.addEventListener('click', dismiss);
    document.body.appendChild(splash);
    // Desktop: the native page surface paints above ALL HTML - without
    // yielding it the splash could not appear over the content area.
    // Every dismiss path restores it, and healStuckPageSurface() catches
    // any restore that a frozen timer might have eaten.
    try { if (this.nativeWebview) this.setPageObscured(true); } catch { /* no native view */ }
    // Quick by design: ~2.6s on screen, then it fades itself away.
    setTimeout(dismiss, 2600);
    // FREEZE FIX (the reported one): timers in a backgrounded/minimized
    // window are throttled or FROZEN by the engine, so the 2.6s dismiss
    // above could simply never fire - leaving a full-screen blur that ate
    // every click and scroll until the app was restarted. Three
    // independent recovery triggers, any one of which is sufficient:
    try {
      document.addEventListener('visibilitychange', () => {
        // The user just came back - retire the splash this instant.
        if (typeof document === 'undefined' || document.hidden !== true) dismiss();
      }, { once: true });
      window.addEventListener?.('pointerdown', dismiss, { once: true });
      window.addEventListener?.('keydown', dismiss, { once: true });
    } catch { /* older shims */ }
  }

  getActiveTab() {
    return this.state.tabs.find((t) => t.id === this.state.activeTabId) || this.state.tabs[0];
  }

  render(container = null) {
    // Global theme tokens must reach body-mounted dialogs too, not just
    // the shell node that render() rebuilds. Pointer preference follows the
    // same lifecycle and is also forwarded to the native website surfaces.
    try { this.applyDocumentTheme(); } catch { /* headless */ }
    try { this.applyPointerTheme(); } catch { /* headless */ }
    const target = container || this.container || (this.rootElement && this.rootElement.parentElement);
    if (!target) return null;

    this.lastRenderTarget = target;

    // FREEZE FIX (stuck update splash): if every one of its dismissal
    // triggers somehow failed (frozen timers, exotic embedders), any
    // render force-retires a splash that is past its welcome - the UI can
    // never be left behind a dead full-screen blur.
    try {
      if (typeof document !== 'undefined' && document.querySelector) {
        const staleSplash = document.querySelector('.fb-update-splash');
        if (staleSplash && Date.now() - Number(staleSplash.dataset?.shownAt || 0) > 10000) {
          staleSplash.remove();
        }
      }
    } catch { /* the sweep is best-effort */ }

    // FREEZE FIX (stuck page surface): a sticky obscured flag with no
    // overlay on screen = a dead snapshot instead of the live page.
    // Truth-check it on EVERY render - the page stays live, always.
    try { this.healStuckPageSurface(); } catch { /* best-effort heal */ }

    // Keep the "last session" snapshot rolling: every render follows a
    // state change, and the JSON-compare inside makes no-op calls free.
    this.queueSessionSnapshot();

    // CRITICAL (web/PWA no-blink fix): the persistent web-frame layer holds
    // the live <iframe> for each external tab. It must SURVIVE re-renders -
    // recreating (or even reparenting) an <iframe> forces the embedded page
    // to fully reload, which users saw as a white flash of the whole page
    // every time any piece of chrome re-rendered (opening the Yayra menu,
    // pressing "Check for updates", toggling a dropdown...). So instead of
    // wiping the container wholesale, every child EXCEPT the frame layer is
    // removed and rebuilt as before.
    if (this.webFrameLayer && this.webFrameLayer.parentElement === target) {
      for (const child of [...(target.children || [])]) {
        if (child !== this.webFrameLayer) child.remove();
      }
    } else {
      target.innerHTML = '';
    }
    const activeTab = this.getActiveTab();
    const isPrivate = activeTab?.isPrivate;

    const shell = document.createElement('div');
    shell.className = `fb-browser-shell ${this.state.isMobile ? 'fb-mobile-layout' : 'fb-desktop-layout'} ${isPrivate ? 'fb-incognito-mode' : ''}`;
    shell.setAttribute('data-theme', this.resolveEffectiveTheme());
    shell.setAttribute('data-color-theme', this.state.settings.colorTheme || 'blue');
    shell.setAttribute('data-floating-mode', this.state.desktopFloatingMode);

    // Apply frame transparency
    const frameOpacity = this.state.settings.frameOpacity || 0.85;
    const blurRadius = this.state.settings.glassmorphismBlurRadius || 24;
    shell.style.setProperty('--fb-frame-opacity', String(frameOpacity));
    shell.style.setProperty('--fb-blur-radius', `${blurRadius}px`);

    if (this.state.isMinimizedToBubble) {
      shell.style.display = 'none';
      this.renderFloatingBubbleOverlay();
    } else {
      shell.style.display = 'flex';
      if (this.bubbleOverlay) {
        this.bubbleOverlay.remove();
        this.bubbleOverlay = null;
      }
      const legacyOverlay = typeof document !== 'undefined' ? document.getElementById('yayra-floating-bubble-overlay') : null;
      if (legacyOverlay) {
        legacyOverlay.remove();
      }
    }

    if (this.state.isMobile) {
      this.renderMobileLayout(shell, activeTab);
    } else {
      this.renderDesktopLayout(shell, activeTab);
    }

    // Modal / Dialog Overlay (Menu, Tab Switcher, etc.)
    this.renderActiveModal(shell);

    // Right Side Drawer Menu (No Blur)
    if (this.state.isSideDrawerOpen) {
      this.renderSideDrawer(shell);
    }

    // Security Dropdown & Search Engine Switcher
    if (this.state.isSecurityDropdownOpen) {
      this.renderSecurityDropdown(shell);
    }

    // Persistent Account Dropdown (top-right account button)
    if (this.state.isAccountMenuOpen) {
      this.renderAccountDropdown(shell);
    }

    // Downloads dropdown (latest 5 + state-aware actions) under the
    // toolbar download button - tracking without leaving the page.
    if (this.state.isDownloadsDropdownOpen) {
      this.renderDownloadsDropdown(shell);
    }

    // Chrome-style "Keep your browsing separate?" profile suggestion
    if (this.state.profileSuggestion) {
      this.renderProfileSuggestionCard(shell);
    }

    // "Update available - now or later?" card (auto background checks)
    // and "Update downloaded - install now / next launch / later" card.
    // BOTH are window-level overlays pinned to the top right corner and
    // mounted on document.body (see renderUpdatePromptCard) - they are
    // re-created/cleaned up on EVERY render whether or not prompt state
    // is live, so a dismissed prompt never lingers on screen.
    this.renderUpdatePromptCard(shell);
    this.renderUpdateInstallPromptCard(shell);

    // "Close Yayra?" prompt (close all tabs / just close / keep all tabs)
    if (this.state.closePrompt) {
      this.renderClosePromptModal(shell);
    }

    // "Reopen recent tabs?" offer after a plain close last session
    if (this.state.recentTabsOffer && this.state.recentTabsOffer.length) {
      this.renderRecentTabsOffer(shell);
    }

    // Find in Page Toolbar
    if (this.state.findInPage.isOpen) {
      this.renderFindInPageBar(shell);
    }

    // Chrome-style "Save password?" bar (captured login submission)
    if (this.state.pendingPasswordSave) {
      this.renderPasswordSaveBar(shell);
    }

    // Floating Mini-Browser Window Popup
    if (this.state.isFloatingMiniOpen) {
      this.renderFloatingMiniWindow();
    }

    // Radial AI & Actions Wheel Overlay
    if (this.state.isRadialLauncherOpen) {
      this.renderRadialLauncher();
    }

    target.appendChild(shell);
    this.rootElement = shell;

    // Maintain persistent assistive bubble in the DOM
    this.ensurePersistentAssistiveBubble();

    // Site logos in tabs: attach the CSP-safe load/error fallbacks to
    // every logo image this render just produced.
    this.bindTabLogoFallbacks(target);

    // Position/show/hide the persistent web-frame layer so the live iframe
    // lines up exactly with the viewport slot rendered above. A second pass
    // on the next animation frame catches post-layout geometry.
    this.syncWebFrameLayer();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this.syncWebFrameLayer());
    }

    return shell;
  }

  /* -------------------------------------------------------------
   * PERSISTENT WEB-FRAME LAYER (WEB/PWA - NO-RELOAD RENDERING)
   * -----------------------------------------------------------
   * On web/PWA builds external pages render in an <iframe>. Browsers
   * reload an iframe whenever it is recreated OR reparented, so the frames
   * live in a fixed-position layer that is a SIBLING of the re-rendered
   * shell (never torn down by render()) and the viewport only renders a
   * transparent slot whose on-screen rectangle the layer copies. Yayra's
   * own chrome (drawer z-600000, dropdowns/modals z-1000+, bubble z-99999)
   * all stack far above the layer's z-index of 10, so overlays still
   * paint over the page exactly as before. This mirrors the Electron
   * native-WebContentsView architecture (see attachNativeWebviewSlot),
   * which is why Electron never had the reload bug.
   * ----------------------------------------------------------- */
  ensureWebFrameLayer() {
    if (typeof document === 'undefined') return null;
    const target = this.lastRenderTarget || this.container || (this.rootElement && this.rootElement.parentElement);
    if (!target) return null;
    if (!this.webFrameLayer || this.webFrameLayer.parentElement !== target) {
      if (this.webFrameLayer) this.webFrameLayer.remove();
      const layer = document.createElement('div');
      layer.className = 'fb-web-frame-layer';
      layer.style.cssText = 'position:fixed; left:0; top:0; width:0; height:0; z-index:10; display:none; overflow:hidden; background:transparent;';
      target.appendChild(layer);
      this.webFrameLayer = layer;
      this.webFrames = new Map();
    }
    return this.webFrameLayer;
  }

  // Returns true when the pooled persistent frame was mounted for this tab;
  // false means the caller must fall back to the classic one-shot
  // createWebContentFrame() path (native engine, auth handoff, known
  // frame-blocked hosts, zoomed viewports, non-DOM test environments).
  mountPooledWebFrame(webViewContainer, tab) {
    if (typeof document === 'undefined') return false;
    if (this.nativeWebview) return false;
    if (this.isSystemBrowserAuthHost(tab.url)) return false;
    if (this.isKnownFrameBlockedUrl(tab.url)) return false;
    // OFFLINE: a tab with an EXISTING live frame keeps it (loaded pages
    // stay live offline); a NEW frame while offline must not be created -
    // fall through to createWebContentFrame's honest offline card.
    if (!this._onLine() && /^https?:\/\//i.test(String(tab.url || '')) && !this.webFrames?.has(tab.id)) return false;
    // Internal pages (yayra://...) are DOM-rendered and must never occupy a
    // pooled live-page slot (defense in depth for future internal schemes).
    if (/^yayra:/i.test(String(tab.url || ''))) return false;
    if (this.state.zoomLevel !== 100) return false;
    const layer = this.ensureWebFrameLayer();
    if (!layer) return false;

    const slot = document.createElement('div');
    slot.className = 'fb-web-frame-slot';
    slot.style.cssText = 'flex:1; width:100%; height:100%; min-height:0;';
    slot.setAttribute('data-tab-id', tab.id);
    webViewContainer.appendChild(slot);
    this.activeWebFrameSlot = slot;
    this.activeWebFrameTabId = tab.id;

    let frame = this.webFrames.get(tab.id);
    if (!frame) {
      const host = document.createElement('div');
      host.className = 'fb-web-frame-host';
      host.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; display:flex;';
      const iframe = document.createElement('iframe');
      iframe.className = 'fb-webview-frame';
      iframe.style.cssText = 'flex:1; border:none; width:100%; height:100%; background:transparent;';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      iframe.setAttribute('allow', 'fullscreen');
      frame = { host, iframe, url: null, tabId: tab.id, blockedFallbackShown: false };
      iframe.addEventListener('load', () => {
        this.updateTabLoading(tab.id, false);
        // Same best-effort blocked-framing net as createWebContentFrame():
        // a site that refuses framing never actually replaces the frame's
        // initial same-origin document.
        const loadedUrl = frame.url;
        setTimeout(() => {
          try {
            const frameDoc = iframe.contentDocument || iframe.contentWindow?.document;
            const blocked = !!frameDoc && (!frameDoc.location || frameDoc.location.href === 'about:blank');
            if (blocked && !frame.blockedFallbackShown && frame.url === loadedUrl) {
              frame.blockedFallbackShown = true;
              host.appendChild(this.buildFrameBlockedFallback(loadedUrl));
            }
          } catch (_err) {
            // Cross-origin document present - navigation succeeded.
          }
        }, 450);
      });
      host.appendChild(iframe);
      layer.appendChild(host);
      this.webFrames.set(tab.id, frame);
    }

    // Only touch src when the tab's URL actually changed - re-renders with
    // an unchanged URL must NEVER reset the iframe (that's the reload bug).
    if (frame.url !== tab.url) {
      frame.url = tab.url;
      frame.blockedFallbackShown = false;
      const stale = frame.host.querySelector ? frame.host.querySelector('.fb-frame-blocked-fallback') : null;
      if (stale) stale.remove();
      frame.iframe.src = tab.url;
    }
    frame.lastMountedAt = ++this._pooledFrameEpoch; // monotonic: eviction order is always exact mount order
    this.evictIdlePooledFrames();
    return true;
  }

  /**
   * Chrome "memory saver" semantics for the iframe pool: keep at most
   * MAX_POOLED_FRAMES live pages (the most recently used ones), discard the
   * rest. A discarded tab simply mounts FRESH when the user switches back
   * to it - a visible, on-demand load, exactly like Chrome rehydrating a
   * discarded tab - and never a silent background reload of a live page.
   * The active tab's frame is untouchable.
   */
  evictIdlePooledFrames() {
    if (!this.webFrames || this.webFrames.size <= BrowserShell.MAX_POOLED_FRAMES) return;
    const candidates = Array.from(this.webFrames.entries())
      .filter(([tabId]) => tabId !== this.state.activeTabId)
      .sort((a, b) => (a[1].lastMountedAt || 0) - (b[1].lastMountedAt || 0));
    const excess = this.webFrames.size - BrowserShell.MAX_POOLED_FRAMES;
    for (let i = 0; i < Math.min(excess, candidates.length); i += 1) {
      const [tabId, frame] = candidates[i];
      try { frame.host.remove(); } catch { /* already detached */ }
      this.webFrames.delete(tabId);
    }
  }

  syncWebFrameLayer() {
    const layer = this.webFrameLayer;
    if (!layer) return;

    // Drop frames for tabs that no longer exist.
    if (this.webFrames) {
      for (const [tabId, frame] of Array.from(this.webFrames.entries())) {
        if (!this.state.tabs.some((t) => t.id === tabId)) {
          frame.host.remove();
          this.webFrames.delete(tabId);
        }
      }
    }

    const slot = this.activeWebFrameSlot;
    const activeId = this.activeWebFrameTabId;
    const showing = Boolean(
      slot &&
      activeId &&
      this.webFrames &&
      this.webFrames.has(activeId) &&
      !this.state.isMinimizedToBubble &&
      (slot.isConnected !== false)
    );

    if (!showing) {
      layer.style.display = 'none';
      return;
    }

    layer.style.display = 'block';
    for (const [tabId, frame] of this.webFrames.entries()) {
      frame.host.style.display = tabId === activeId ? 'flex' : 'none';
    }

    if (typeof slot.getBoundingClientRect === 'function') {
      const rect = slot.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        layer.style.left = `${rect.left}px`;
        layer.style.top = `${rect.top}px`;
        layer.style.width = `${rect.width}px`;
        layer.style.height = `${rect.height}px`;
      }
    }
  }

  /* -------------------------------------------------------------
   * DESKTOP LAYOUT (COMPACT TABS, OMNIBOX, BRANDING, NO-BLUR DRAWER)
   * ----------------------------------------------------------- */
  renderDesktopLayout(root, activeTab) {
    // 1. Top Tab Strip (Requirement 8: Compact, Low-Profile, Cute Tabs)
    const tabStrip = document.createElement('header');
    tabStrip.className = 'fb-chrome-tabstrip';
    tabStrip.setAttribute('role', 'tablist');
    tabStrip.setAttribute('aria-label', 'Open tabs');

    // Brand wordmark at the very top of the app - replaces the removed OS
    // title bar text ("yayra") with the official wordmark image.
    const tabstripBrand = document.createElement('span');
    tabstripBrand.className = 'fb-tabstrip-brand';
    tabstripBrand.innerHTML = Icons.officialWordmark;
    tabstripBrand.setAttribute('aria-hidden', 'true');
    tabStrip.appendChild(tabstripBrand);

    const tabsScroll = document.createElement('div');
    tabsScroll.className = 'fb-tabs-scroll-container';

    this.state.tabs.forEach((tab, index) => {
      const isActive = tab.id === this.state.activeTabId;
      const tabEl = document.createElement('div');
      tabEl.className = `fb-tab-item ${isActive ? 'active' : ''} ${tab.isPrivate ? 'fb-tab-incognito' : ''}`;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tabEl.setAttribute('draggable', 'true');
      tabEl.dataset.tabId = tab.id;

      // Favicon / Orb Icon
      const faviconWrap = document.createElement('span');
      faviconWrap.className = 'fb-tab-favicon';
      faviconWrap.innerHTML = this.getTabFavicon(tab);
      tabEl.appendChild(faviconWrap);

      // Tab-group colour dot (menu > Tab groups): same colour = same group.
      if (tab.group && tab.group.color) {
        const groupDot = document.createElement('span');
        groupDot.className = 'fb-tab-group-dot';
        groupDot.style.background = tab.group.color;
        groupDot.setAttribute('title', `Group: ${tab.group.name}`);
        groupDot.setAttribute('aria-label', `Tab group ${tab.group.name}`);
        tabEl.appendChild(groupDot);
      }

      // Title
      const titleEl = document.createElement('span');
      titleEl.className = 'fb-tab-title';
      titleEl.textContent = this.getTabTitle(tab);
      tabEl.appendChild(titleEl);

      // Cute Close "x" Button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'fb-tab-close-btn';
      closeBtn.setAttribute('title', 'Close tab (Ctrl+W)');
      closeBtn.setAttribute('aria-label', `Close ${this.getTabTitle(tab)}`);
      closeBtn.innerHTML = Icons.close;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      tabEl.addEventListener('click', () => {
        this.selectTab(tab.id);
      });

      // Middle click to close tab
      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.closeTab(tab.id);
        }
      });

      // Right-click: Chrome-style tab context menu (New Tab, Reload,
      // Duplicate, Close Tab / Other Tabs / Tabs to the Right).
      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.renderTabContextMenu(e.clientX, e.clientY, tab);
      });

      // Tab drag reordering
      tabEl.addEventListener('dragstart', (e) => {
        if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', String(index));
        }
      });
      tabEl.addEventListener('dragover', (e) => e.preventDefault());
      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIdx = Number(e.dataTransfer?.getData('text/plain'));
        if (!isNaN(fromIdx) && fromIdx !== index) {
          this.reorderTabs(fromIdx, index);
        }
      });

      tabsScroll.appendChild(tabEl);
    });

    // New Tab "+" Button - lives OUTSIDE the scrollable tab row, pinned
    // right after it, so it NEVER scrolls out of sight no matter how many
    // tabs are open (the tab row scrolls horizontally behind it).
    const newTabBtn = document.createElement('button');
    newTabBtn.className = 'fb-btn-newtab';
    newTabBtn.setAttribute('title', 'New Tab (Ctrl+T)');
    newTabBtn.setAttribute('aria-label', 'Create new tab');
    newTabBtn.innerHTML = Icons.plus;
    newTabBtn.addEventListener('click', () => {
      this.createNewTab();
    });

    tabStrip.appendChild(tabsScroll);
    tabStrip.appendChild(newTabBtn);

    // Keep the active tab visible inside the scrollable row (e.g. a tab
    // just opened at the far end while many tabs are already open).
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const activeEl = tabsScroll.querySelector?.('.fb-tab-item.active');
        if (activeEl && typeof activeEl.scrollIntoView === 'function') {
          activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        }
      });
    }

    // REAL window controls for the frameless Electron window. The OS title
    // bar and menu block are removed (electron/main.cjs), so the tab strip
    // IS the title bar now: it is draggable (CSS -webkit-app-region) and
    // these buttons genuinely minimize/maximize/close the window via IPC -
    // unlike the old decorative cluster that was removed when the native
    // frame was still present. Web/PWA builds never render them (the
    // browser provides the window chrome there).
    // The frameless mini window has its own slim titlebar (expand/hide) -
    // never render a second min/max/close cluster there.
    const winControls = this.options?.isMiniShell ? null : this.windowControls;
    if (winControls) {
      const controls = document.createElement('div');
      controls.className = 'fb-window-controls';
      const buttons = [
        { cls: 'fb-wc-minimize', title: 'Minimize', icon: '<svg viewBox="0 0 12 12" width="12" height="12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>', action: () => winControls.minimize() },
        { cls: 'fb-wc-maximize', title: 'Maximize / Restore', icon: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>', action: () => winControls.toggleMaximize() },
        { cls: 'fb-wc-close', title: 'Close window', icon: '<svg viewBox="0 0 12 12" width="12" height="12" stroke="currentColor" stroke-width="1.2"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>', action: () => this.requestAppClose() }
      ];
      for (const { cls, title, icon, action } of buttons) {
        const btn = document.createElement('button');
        btn.className = `fb-wc-btn ${cls}`;
        btn.setAttribute('title', title);
        btn.setAttribute('aria-label', title);
        btn.innerHTML = icon;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          action();
        });
        controls.appendChild(btn);
      }
      tabStrip.appendChild(controls);
    }
    root.appendChild(tabStrip);
    this.tabStripElement = tabStrip;

    // 2. Browser Navigation Toolbar (Back, Forward, Reload/Stop, Brand, Lock + Search Engine, Omnibox, Star, Downloads, Extensions, Menu)
    const navbar = document.createElement('nav');
    navbar.className = 'fb-chrome-navbar';
    navbar.setAttribute('role', 'toolbar');
    navbar.setAttribute('aria-label', 'Navigation and address bar');

    // Navigation Controls
    const navControls = document.createElement('div');
    navControls.className = 'fb-nav-controls';

    const backBtn = document.createElement('button');
    backBtn.className = 'fb-nav-btn fb-nav-back';
    backBtn.setAttribute('title', 'Click to go back');
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.disabled = !activeTab.canGoBack;
    backBtn.innerHTML = Icons.arrowLeft;
    backBtn.addEventListener('click', () => {
      this.goBack();
      this.render();
    });
    navControls.appendChild(backBtn);

    const fwdBtn = document.createElement('button');
    fwdBtn.className = 'fb-nav-btn fb-nav-forward';
    fwdBtn.setAttribute('title', 'Click to go forward');
    fwdBtn.setAttribute('aria-label', 'Forward');
    fwdBtn.disabled = !activeTab.canGoForward;
    fwdBtn.innerHTML = Icons.arrowRight;
    fwdBtn.addEventListener('click', () => {
      this.goForward();
      this.render();
    });
    navControls.appendChild(fwdBtn);

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'fb-nav-btn fb-nav-reload';
    reloadBtn.setAttribute('title', activeTab.isLoading ? 'Stop loading this page (Esc)' : 'Reload this page (Ctrl+R)');
    reloadBtn.setAttribute('aria-label', activeTab.isLoading ? 'Stop' : 'Reload');
    reloadBtn.innerHTML = activeTab.isLoading ? Icons.stop : Icons.refresh;
    reloadBtn.addEventListener('click', () => {
      if (activeTab.isLoading) this.stopLoading();
      else this.reload();
    });
    navControls.appendChild(reloadBtn);

    navbar.appendChild(navControls);

    // 3. Combined Address & Search Field (Omnibox with Brand & Security Selector)
    const omnibox = document.createElement('div');
    omnibox.className = 'fb-omnibox-container';

    // Requirement 4: App Logo and "yayra" Brand beside the Security Button
    const toolbarBrand = document.createElement('div');
    toolbarBrand.className = 'fb-toolbar-brand';
    toolbarBrand.innerHTML = `
      <span class="fb-toolbar-brand-orb">${Icons.officialOrb}</span>
      <span class="fb-toolbar-brand-text">${Icons.officialWordmark}<span class="fb-brand-text-fallback">yayra</span></span>
    `;
    toolbarBrand.setAttribute('title', this.state.updateState.installedVersion ? `Yayra Floating Browser v${this.state.updateState.installedVersion}` : 'Yayra Floating Browser');
    toolbarBrand.addEventListener('click', () => this.openInternalPage('yayra://newtab'));
    omnibox.appendChild(toolbarBrand);

    // Requirement 3: Security Lock Button (Opens Search Engine Selector & Security Info)
    const securityBadge = document.createElement('button');
    securityBadge.className = 'fb-omnibox-security fb-omnibox-security-badge fb-security-lock-btn';
    securityBadge.setAttribute('title', 'Site Security & Default Search Engine');
    securityBadge.setAttribute('aria-label', 'Security and Search Engine Options');
    securityBadge.innerHTML = activeTab.isSecure ? Icons.lock : Icons.alertTriangle;
    securityBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.state.isSecurityDropdownOpen = !this.state.isSecurityDropdownOpen;
      this.render();
    });
    omnibox.appendChild(securityBadge);

    const tabGroupsBtn = document.createElement('button');
    tabGroupsBtn.type = 'button';
    tabGroupsBtn.className = `fb-omnibox-group-btn${activeTab.group ? ' is-grouped' : ''}`;
    tabGroupsBtn.setAttribute('title', activeTab.group?.name ? `Tab group: ${activeTab.group.name}` : 'Tab groups');
    tabGroupsBtn.setAttribute('aria-label', activeTab.group?.name ? `Open tab groups; current group ${activeTab.group.name}` : 'Open tab groups');
    tabGroupsBtn.setAttribute('aria-haspopup', 'dialog');
    tabGroupsBtn.innerHTML = Icons.tabGroup;
    tabGroupsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openModal('tab-groups');
    });
    omnibox.appendChild(tabGroupsBtn);

    // Omnibox Input
    const omniboxInput = document.createElement('input');
    omniboxInput.type = 'text';
    omniboxInput.className = 'fb-omnibox-input';
    omniboxInput.value = this.getDisplayUrl(activeTab.url);
    const currentEngine = this.state.settings.searchEngine || 'google';
    omniboxInput.placeholder = `Search with ${currentEngine.charAt(0).toUpperCase() + currentEngine.slice(1)} or enter address`;
    omniboxInput.setAttribute('aria-label', 'Address and search bar');
    omniboxInput.setAttribute('spellcheck', 'false');
    omniboxInput.setAttribute('autocomplete', 'off');

    omniboxInput.addEventListener('focus', () => {
      omniboxInput.select();
    });

    omniboxInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigateActiveTab(omniboxInput.dataset.selectedSuggestion || omniboxInput.value);
        omniboxInput.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        omniboxInput.value = this.getDisplayUrl(this.getActiveTab().url);
        omniboxInput.blur();
      }
    });

    omnibox.appendChild(omniboxInput);
    this.bindSearchSuggestions(omniboxInput);
    this.omniboxInput = omniboxInput;

    // Bookmark Star Icon
    const starBtn = document.createElement('button');
    starBtn.className = `fb-omnibox-star ${this.state.isBookmarked ? 'bookmarked' : ''}`;
    starBtn.setAttribute('title', this.state.isBookmarked ? 'Remove bookmark' : 'Bookmark this tab (Ctrl+D)');
    starBtn.setAttribute('aria-label', 'Bookmark tab');
    starBtn.innerHTML = this.state.isBookmarked ? Icons.starFilled : Icons.star;
    starBtn.addEventListener('click', () => this.toggleBookmarkCurrentTab());
    omnibox.appendChild(starBtn);

    navbar.appendChild(omnibox);

    // 4. Action Buttons (Downloads, Extensions, Mode Switcher, 3-Dot Menu)
    const toolbarActions = document.createElement('div');
    toolbarActions.className = 'fb-toolbar-actions';

    // Persistent "Update available" chip: background update checks (see
    // startBackgroundUpdateChecks) can discover a release at any time, and
    // the one-per-session confirm dialog is easy to dismiss - this chip
    // stays visible until the update is actually applied.
    if (this.state.updateState.status === 'ready' || this.state.updateState.status === 'staged') {
      const staged = this.state.updateState.status === 'staged';
      const updateChip = document.createElement('button');
      updateChip.className = 'fb-update-chip';
      updateChip.setAttribute(
        'title',
        staged
          ? `Yayra v${this.state.updateState.availableVersion || 'latest'} is downloaded & verified - click to install`
          : `Update Yayra to v${this.state.updateState.availableVersion || 'latest'} - click to download & install`
      );
      updateChip.setAttribute('aria-label', staged ? 'Install downloaded update' : 'Download and install available update');
      // Downloaded & verified -> the remaining action is INSTALL, and the
      // chip says exactly that (never "Download and install" again).
      updateChip.innerHTML = `${Icons.download}<span class="fb-update-chip-label">${staged ? 'Install' : 'Update'}</span>`;
      updateChip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.applyUpdate();
      });
      toolbarActions.appendChild(updateChip);
    }

    // Requirement 10: Downloads Button (Transparent, Compact, Matching Star Size)
    // Smart: while anything is downloading it wears a revolving progress
    // ring tracking the live percentage (updated in place - see
    // updateDownloadIndicator()). Clicking opens the downloads DROPDOWN
    // (latest 5 + actions), never yanking the user to a new tab - the
    // full yayra://downloads page is one button away inside it.
    const dlBtn = document.createElement('button');
    dlBtn.className = 'fb-action-btn fb-btn-downloads fb-toolbar-downloads-btn fb-toolbar-action-btn';
    dlBtn.setAttribute('aria-label', 'Downloads');
    dlBtn.innerHTML = `${this.renderDownloadRingHtml()}${Icons.download}`;
    dlBtn.setAttribute('title', this.describeDownloadActivity());
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.state.isDownloadsDropdownOpen = !this.state.isDownloadsDropdownOpen;
      if (!this.state.isDownloadsDropdownOpen) this.state.isDownloadsDropdownExpanded = false;
      this.render();
    });
    toolbarActions.appendChild(dlBtn);

    // Requirement 10: Extensions & Shields Button (Transparent, Compact, Matching Star Size)
    const extBtn = document.createElement('button');
    extBtn.className = 'fb-action-btn fb-btn-extensions fb-toolbar-extensions-btn fb-toolbar-action-btn';
    extBtn.setAttribute('title', 'Extensions & Shields');
    extBtn.setAttribute('aria-label', 'Extensions and Content Shields');
    extBtn.innerHTML = Icons.shield;
    extBtn.addEventListener('click', () => this.openInternalPage('yayra://extensions'));
    toolbarActions.appendChild(extBtn);

    // NOTE: the old "floating mode" switcher pill used to live here. It
    // hid the whole main window when toggled to circle-first, which users
    // experienced as Yayra "disappearing". Removed entirely: the native
    // bubble is ALWAYS available and opening it never touches this window.

    // Persistent Top-Right Account Button (Yayra app-level "Sign in with
    // Google" - see electron/authBridge.cjs - plus the browser-profile
    // switcher). Lives here, next to the 3-dot menu, so it stays in the
    // same place across every tab/page. Rendered on EVERY build now:
    // Google sign-in is Electron-only, but profiles work everywhere.
    {
      const account = this.state.googleAccount || { status: 'idle' };
      const currentProfile = this.profileService ? this.profileService.current() : null;
      const acctBtn = document.createElement('button');
      acctBtn.className = `fb-action-btn fb-account-btn fb-toolbar-action-btn${account.status === 'signing-in' ? ' fb-account-btn-busy' : ''}`;
      acctBtn.setAttribute(
        'title',
        account.signedIn
          ? `Yayra account: ${account.profile?.name || account.profile?.email || 'Signed in'}`
          : (account.status === 'signing-in'
            ? 'Signing in with Google…'
            : `Profile: ${currentProfile?.name || 'My profile'} - account & profiles`)
      );
      acctBtn.setAttribute('aria-label', 'Account');
      acctBtn.innerHTML = account.signedIn
        ? this.renderAccountAvatarHtml(account.profile, 26)
        : (currentProfile ? this.profileAvatarHtml(currentProfile, 26) : this.renderAccountAvatarHtml(null, 26));
      acctBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleAccountMenu();
      });
      toolbarActions.appendChild(acctBtn);
    }

    // Requirement 5: 3-Dot Browser Menu Button (Opens Full Right-Side Drawer without Blur)
    const menuBtn = document.createElement('button');
    menuBtn.className = 'fb-action-btn fb-menu-btn fb-toolbar-action-btn';
    menuBtn.setAttribute('title', 'Customize and control Yayra');
    menuBtn.setAttribute('aria-label', 'Main menu');
    menuBtn.innerHTML = Icons.moreVertical;
    menuBtn.addEventListener('click', () => {
      this.state.isSideDrawerOpen = !this.state.isSideDrawerOpen;
      this.render();
    });
    toolbarActions.appendChild(menuBtn);

    navbar.appendChild(toolbarActions);
    root.appendChild(navbar);

    // Persistent "Restore pages?" bar: docked INTO the chrome (never
    // overlaid by the native page surface), on EVERY page and tab,
    // until the user explicitly answers it - searching, switching tabs
    // and clicking around never dismiss it.
    this.renderRestoreBar(root);

    // 4b. Bookmarks bar (menu > Bookmarks > Show bookmarks bar) - a real
    // strip of this profile's bookmarks, not a decorative toggle.
    if (this.state.settings.showBookmarksBar) {
      root.appendChild(this.renderBookmarksBar());
    }

    // 5. Main Browser Viewport
    const viewport = document.createElement('main');
    viewport.className = 'fb-browser-viewport';
    viewport.setAttribute('role', 'main');

    this.renderViewportContent(viewport, activeTab);

    root.appendChild(viewport);
    this.viewportElement = viewport;
  }

  attachMobilePullToRefresh(viewport) {
    if (!viewport || typeof viewport.addEventListener !== 'function') return;

    const indicator = document.createElement('div');
    indicator.className = 'fb-mobile-pull-indicator';
    indicator.setAttribute('aria-live', 'polite');
    indicator.innerHTML = `<span class="fb-mobile-pull-icon">${Icons.refresh}</span><span class="fb-mobile-pull-label">Pull to refresh</span>`;
    viewport.appendChild(indicator);

    let startY = null;
    let distance = 0;
    let tracking = false;
    const reset = () => {
      startY = null;
      distance = 0;
      tracking = false;
      indicator.classList.remove('pulling', 'ready', 'refreshing');
      indicator.style.setProperty('--fb-pull-distance', '0px');
      const label = indicator.querySelector('.fb-mobile-pull-label');
      if (label) label.textContent = 'Pull to refresh';
    };

    viewport.addEventListener('touchstart', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      const scrollable = event.target?.closest?.('.fb-newtab-page, .fb-internal-page, .fb-mobile-viewport') || viewport;
      if ((scrollable.scrollTop || 0) > 0) return;
      startY = touch.clientY;
      tracking = true;
    }, { passive: true });

    viewport.addEventListener('touchmove', (event) => {
      if (!tracking || startY === null) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      distance = Math.max(0, Math.min(112, touch.clientY - startY));
      if (distance <= 0) return;
      indicator.style.setProperty('--fb-pull-distance', `${distance}px`);
      indicator.classList.add('pulling');
      const ready = distance >= 72;
      indicator.classList.toggle('ready', ready);
      const label = indicator.querySelector('.fb-mobile-pull-label');
      if (label) label.textContent = ready ? 'Release to refresh' : 'Pull to refresh';
      if (event.cancelable && distance > 8) event.preventDefault();
    }, { passive: false });

    viewport.addEventListener('touchend', () => {
      if (!tracking) return;
      if (distance >= 72) {
        indicator.classList.add('refreshing');
        const label = indicator.querySelector('.fb-mobile-pull-label');
        if (label) label.textContent = 'Refreshing…';
        this.reload();
        return;
      }
      reset();
    }, { passive: true });

    viewport.addEventListener('touchcancel', reset, { passive: true });
  }

  /* -------------------------------------------------------------
   * MOBILE LAYOUT (SAFARI-STYLE BOTTOM BAR) (PHASE 2B)
   * ----------------------------------------------------------- */
  renderMobileLayout(root, activeTab) {
    // Safari-inspired mobile chrome: a compact tab/tool rail above the page,
    // then the address and navigation controls at the bottom. All Yayra
    // actions remain available; the layout only changes their placement.
    const topBar = document.createElement('header');
    topBar.className = 'fb-mobile-topbar';
    topBar.setAttribute('aria-label', 'Safari-style browser tools');

    const safariTabbar = document.createElement('nav');
    safariTabbar.className = 'fb-mobile-safari-tabbar';
    const topActions = [
      { className: 'fb-mobile-tab-overview', icon: Icons.tabs, title: 'Show all tabs', action: () => this.openModal('tab-switcher') },
      { className: 'fb-mobile-tab-bookmarks', icon: Icons.bookmark, title: 'Bookmarks', action: () => this.openInternalPage('yayra://bookmarks') },
      { className: 'fb-mobile-tab-privacy', icon: Icons.shield, title: 'Privacy and shields', action: () => this.openInternalPage('yayra://permissions') },
      { className: 'fb-mobile-tab-history', icon: Icons.history, title: 'History', action: () => this.openInternalPage('yayra://history') }
    ];
    topActions.forEach(({ className, icon, title, action }) => {
      const button = document.createElement('button');
      button.className = `fb-mobile-safari-tab-btn ${className}`;
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.innerHTML = icon;
      button.addEventListener('click', action);
      safariTabbar.appendChild(button);
    });
    topBar.appendChild(safariTabbar);
    root.appendChild(topBar);
    // Same persistent restore prompt on mobile - docked, never lost.
    this.renderRestoreBar(root);

    // Main viewport remains the same shared renderer used by desktop so all
    // internal pages, tools, privacy controls, and web content are preserved.
    const viewport = document.createElement('main');
    viewport.className = 'fb-browser-viewport fb-mobile-viewport';
    this.renderViewportContent(viewport, activeTab);
    this.attachMobilePullToRefresh(viewport);
    root.appendChild(viewport);
    this.viewportElement = viewport;

    const bottomBar = document.createElement('nav');
    bottomBar.className = 'fb-mobile-bottombar';

    const addressRow = document.createElement('div');
    addressRow.className = 'fb-mobile-address-row';

    const bRefresh = document.createElement('button');
    bRefresh.className = 'fb-mobile-nav-btn fb-mobile-refresh-btn';
    bRefresh.type = 'button';
    bRefresh.title = activeTab.isLoading ? 'Stop loading' : 'Refresh page';
    bRefresh.setAttribute('aria-label', activeTab.isLoading ? 'Stop loading' : 'Refresh page');
    bRefresh.innerHTML = activeTab.isLoading ? Icons.stop : Icons.refresh;
    bRefresh.addEventListener('click', () => {
      if (activeTab.isLoading) this.stopLoading();
      else this.reload();
    });
    addressRow.appendChild(bRefresh);

    const addressPill = document.createElement('div');
    addressPill.className = 'fb-mobile-address-pill';
    addressPill.setAttribute('role', 'button');
    addressPill.setAttribute('tabindex', '0');
    addressPill.setAttribute('aria-label', 'Search or enter website address');

    const secIcon = document.createElement('span');
    secIcon.className = 'fb-mobile-sec-icon';
    secIcon.innerHTML = activeTab.isSecure ? Icons.lock : Icons.alertTriangle;
    addressPill.appendChild(secIcon);

    const mobileTabGroupsBtn = document.createElement('button');
    mobileTabGroupsBtn.type = 'button';
    mobileTabGroupsBtn.className = `fb-mobile-group-btn${activeTab.group ? ' is-grouped' : ''}`;
    mobileTabGroupsBtn.setAttribute('title', 'Tab groups');
    mobileTabGroupsBtn.setAttribute('aria-label', 'Open tab groups');
    mobileTabGroupsBtn.setAttribute('aria-haspopup', 'dialog');
    mobileTabGroupsBtn.innerHTML = Icons.tabGroup;
    mobileTabGroupsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openModal('tab-groups');
    });
    mobileTabGroupsBtn.addEventListener('keydown', (event) => event.stopPropagation());
    addressPill.appendChild(mobileTabGroupsBtn);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'fb-mobile-pill-text';
    titleWrap.innerHTML = `
      <span class="fb-mobile-pill-host">${this.getDisplayUrl(activeTab.url)}</span>
      <span class="fb-mobile-pill-sub">${this.getTabTitle(activeTab)}</span>
    `;
    addressPill.appendChild(titleWrap);

    const openSearch = () => this.openModal('search-overlay');
    addressPill.addEventListener('click', openSearch);
    addressPill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSearch();
      }
    });
    addressRow.appendChild(addressPill);

    const tabsBtn = document.createElement('button');
    tabsBtn.className = 'fb-mobile-nav-btn fb-mobile-tabs-btn';
    tabsBtn.type = 'button';
    tabsBtn.title = 'Show all tabs';
    tabsBtn.setAttribute('aria-label', 'Show all tabs');
    tabsBtn.innerHTML = `
      <span class="fb-tabs-icon-wrapper">
        ${Icons.tabs}
        <span class="fb-tabs-count-badge">${this.state.tabs.length}</span>
      </span>
    `;
    tabsBtn.addEventListener('click', () => this.openModal('tab-switcher'));
    addressRow.appendChild(tabsBtn);
    bottomBar.appendChild(addressRow);

    const toolRow = document.createElement('div');
    toolRow.className = 'fb-mobile-secondary-tools';

    const bBack = document.createElement('button');
    bBack.className = 'fb-mobile-nav-btn';
    bBack.type = 'button';
    bBack.title = 'Back';
    bBack.setAttribute('aria-label', 'Back');
    bBack.innerHTML = Icons.arrowLeft;
    bBack.disabled = !activeTab.canGoBack;
    bBack.addEventListener('click', () => {
      this.goBack();
      this.render();
    });
    toolRow.appendChild(bBack);

    const bFwd = document.createElement('button');
    bFwd.className = 'fb-mobile-nav-btn';
    bFwd.type = 'button';
    bFwd.title = 'Forward';
    bFwd.setAttribute('aria-label', 'Forward');
    bFwd.innerHTML = Icons.arrowRight;
    bFwd.disabled = !activeTab.canGoForward;
    bFwd.addEventListener('click', () => {
      this.goForward();
      this.render();
    });
    toolRow.appendChild(bFwd);

    const bShare = document.createElement('button');
    bShare.className = 'fb-mobile-nav-btn';
    bShare.type = 'button';
    bShare.title = 'Share';
    bShare.setAttribute('aria-label', 'Share current page');
    bShare.innerHTML = Icons.share;
    bShare.addEventListener('click', () => this.shareCurrentPage());
    toolRow.appendChild(bShare);

    const bBook = document.createElement('button');
    bBook.className = `fb-mobile-nav-btn ${this.state.isBookmarked ? 'active' : ''}`;
    bBook.type = 'button';
    bBook.title = this.state.isBookmarked ? 'Remove bookmark' : 'Bookmark';
    bBook.setAttribute('aria-label', this.state.isBookmarked ? 'Remove bookmark' : 'Bookmark current page');
    bBook.innerHTML = this.state.isBookmarked ? Icons.starFilled : Icons.star;
    bBook.addEventListener('click', () => this.toggleBookmarkCurrentTab());
    toolRow.appendChild(bBook);

    const bMenu = document.createElement('button');
    bMenu.className = 'fb-mobile-nav-btn';
    bMenu.type = 'button';
    bMenu.title = 'More tools';
    bMenu.setAttribute('aria-label', 'More tools');
    bMenu.innerHTML = Icons.moreVertical;
    bMenu.addEventListener('click', () => {
      this.state.isSideDrawerOpen = !this.state.isSideDrawerOpen;
      this.render();
    });
    toolRow.appendChild(bMenu);

    bottomBar.appendChild(toolRow);
    root.appendChild(bottomBar);
  }

  /* -------------------------------------------------------------
   * VIEWPORT CONTENT ROUTER (IN-TAB INTERNAL PAGES OR WEBVIEW)
   * ----------------------------------------------------------- */
  renderViewportContent(viewport, activeTab) {
    // Assume no external pooled frame is on screen until the external
    // branch below proves otherwise - internal pages must hide the layer.
    this.activeWebFrameSlot = null;
    this.activeWebFrameTabId = null;
    if (!activeTab) return;

    // Page Loading Progress Bar
    if (activeTab.isLoading) {
      const progressBar = document.createElement('div');
      progressBar.className = 'fb-page-loading-bar';
      viewport.appendChild(progressBar);
    }

    const url = activeTab.url || '';
    const isInternalPage = !url || url === 'about:blank' || url.startsWith('yayra://');
    // The native engine (Electron WebContentsView) renders as a separate
    // on-screen surface above the HTML document, not inside it - so it must
    // be explicitly shown/hidden to match whichever tab/page is actually
    // on screen right now (internal pages like Settings must not have a
    // leftover native surface floating over them), AND it must get out of
    // the way whenever Yayra's own chrome (menu drawer, modals, dropdowns,
    // mini window) needs to appear above the page - capturing a snapshot
    // first so the page still appears present underneath the chrome.
    const overlayOpen = this.hasBlockingOverlay();
    const authHandoffOnly = this.isSystemBrowserAuthHost(url);
    this.syncNativeWebviewVisibility(activeTab.id, !isInternalPage && !overlayOpen && !authHandoffOnly, {
      captureActive: overlayOpen && !isInternalPage && !authHandoffOnly
    });
    // Same rule for the Android native tab engine (its hide path captures
    // the page frame natively, so the chrome keeps a page underneath it).
    // Provider sign-in URLs are rendered as an in-tab handoff card instead.
    this.syncAndroidTabWebVisibility(activeTab.id, !isInternalPage && !overlayOpen && !authHandoffOnly);

    // LOCAL DOCUMENT TABS (yayra://doc/<id>): the integrated document
    // viewer - never the web frame path, never the native engine. This is
    // what guarantees opening a document can never navigate a browsing tab
    // away from its site.
    if (url.startsWith('yayra://doc/')) {
      this.renderDocumentViewer(viewport, activeTab);
    } else if (!url || url === 'yayra://newtab' || url === 'about:blank') {
      this.renderNewTabPage(viewport, activeTab);
    } else if (url === 'yayra://settings') {
      this.renderInternalSettingsPage(viewport, activeTab);
    } else if (url === 'yayra://history') {
      this.renderInternalHistoryPage(viewport, activeTab);
    } else if (url === 'yayra://bookmarks') {
      this.renderInternalBookmarksPage(viewport, activeTab);
    } else if (url === 'yayra://downloads') {
      this.renderInternalDownloadsPage(viewport, activeTab);
    } else if (url === 'yayra://passwords') {
      this.renderInternalPasswordsPage(viewport, activeTab);
    } else if (url === 'yayra://extensions') {
      this.renderInternalExtensionsPage(viewport, activeTab);
    } else if (url === 'yayra://permissions') {
      this.renderInternalPermissionsPage(viewport, activeTab);
    } else if (url === 'yayra://ai' || url.startsWith('yayra://ai?')) {
      this.renderInternalAiPage(viewport, activeTab);
    } else if (url === 'yayra://about') {
      this.renderInternalAboutPage(viewport, activeTab);
    } else {
      // External Web Content Frame
      const webViewContainer = document.createElement('div');
      webViewContainer.className = 'fb-webview-container';
      // CSS-transform zoom is the web/iframe fallback only; the native
      // engine zooms for real via applyNativeZoom() and must keep its
      // untransformed container so setBounds stays accurate.
      if (this.state.zoomLevel !== 100 && !this.nativeWebview) {
        webViewContainer.style.transform = `scale(${this.state.zoomLevel / 100})`;
        webViewContainer.style.transformOrigin = 'top left';
        webViewContainer.style.width = `${(100 / this.state.zoomLevel) * 100}%`;
        webViewContainer.style.height = `${(100 / this.state.zoomLevel) * 100}%`;
      }

      // Web/PWA: reuse the persistent pooled iframe for this tab so chrome
      // re-renders never reload the page (no more white flash when opening
      // the menu or checking for updates). Falls back to the classic
      // one-shot frame for the native engine, auth handoff, known
      // frame-blocked hosts and zoomed viewports.
      const pooled = this.mountPooledWebFrame(webViewContainer, activeTab);
      if (!pooled) {
        const { wrapper } = this.createWebContentFrame(activeTab.url, {
          frameClassName: 'fb-webview-frame',
          onLoaded: () => this.updateTabLoading(activeTab.id, false),
          tabId: activeTab.id,
          isPrivate: activeTab.isPrivate,
          allowNative: true
        });

        webViewContainer.appendChild(wrapper);
      }
      viewport.appendChild(webViewContainer);
    }
  }

  /* -------------------------------------------------------------
   * EXTERNAL WEB CONTENT FRAME HELPER
   * -----------------------------------------------------------
   * Many real-world sites (Google, GitHub, Facebook, etc.) send their own
   * X-Frame-Options / CSP frame-ancestors headers that forbid being
   * embedded in ANY iframe. That restriction is enforced by the target
   * site and by the browser itself — Yayra's own CSP (frame-src) cannot
   * override it, and modern Chrome now renders its own inline
   * "<site> refused to connect." error INSIDE the frame rather than
   * failing silently, which also defeats any contentDocument-based
   * runtime detection (the error document itself is cross-origin, so
   * reading it throws exactly like a real successful navigation would).
   * The only reliable fix is to proactively recognize known
   * frame-hostile hosts before ever attempting to embed them, and show a
   * clear in-app fallback with an explicit "Open in new tab" action
   * instead of a dead/blocked frame.
   * ----------------------------------------------------------- */
  isKnownFrameBlockedUrl(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return BrowserShell.FRAME_EMBEDDING_BLOCKED_HOSTS.some(
        (blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`)
      );
    } catch (_err) {
      return false;
    }
  }

  buildFrameBlockedFallback(url, { autoOpened = false } = {}) {
    const fallback = document.createElement('div');
    fallback.className = 'fb-frame-blocked-fallback';
    fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; background:var(--fb-bg-elevated,#15171c); color:var(--fb-text-primary,#d7dbe3); text-align:center; padding:24px; z-index:1;';
    const surface = this.capacitorBrowser ? 'a secure browser view' : 'a new browser tab';
    const message = autoOpened
      ? `This site doesn\u2019t allow embedded browsing, so it was opened for you in ${surface}.`
      : 'This site doesn\u2019t allow embedded browsing and must be opened in its own tab.';
    const buttonLabel = autoOpened ? 'Open again' : 'Open in new tab';
    fallback.innerHTML = `
      <div style="font-size:0.9rem; max-width:360px; line-height:1.5;">${message}</div>
      <button type="button" class="fb-btn fb-frame-blocked-open-btn" style="padding:8px 16px; border-radius:8px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-size:0.875rem;">${buttonLabel}</button>
    `;
    fallback.querySelector('.fb-frame-blocked-open-btn')?.addEventListener('click', () => {
      this.openExternally(url);
    });
    return fallback;
  }

  /**
   * Recognise a SEARCH-RESULTS url and extract its query: Google, Bing,
   * Yahoo, Startpage and DuckDuckGo SERPs. Returns { engine, query } or
   * null. VERIFIED Oct 2026: NO major search engine - including
   * DuckDuckGo's lite and html endpoints - allows its results to be
   * embedded in another app's frame anymore (lite.duckduckgo.com and
   * html.duckduckgo.com now send X-Frame-Options: SAMEORIGIN plus
   * CSP frame-ancestors 'self'). So a blocked SERP gets a real HANDOFF
   * (the search opens outside the frame - see
   * maybeAutoOpenSerpExternally), never a dead embedded results page.
   */
  getSearchIntent(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      const q = (param) => (u.searchParams.get(param) || '').trim();
      if ((host === 'google.com' || host.endsWith('.google.com')) && u.pathname.startsWith('/search')) {
        if (q('q')) return { engine: 'Google', query: q('q') };
      } else if (host === 'bing.com' && u.pathname.startsWith('/search')) {
        if (q('q')) return { engine: 'Bing', query: q('q') };
      } else if ((host === 'yahoo.com' || host === 'search.yahoo.com') && u.pathname.startsWith('/search')) {
        const query = q('p') || q('q');
        if (query) return { engine: 'Yahoo', query };
      } else if (host === 'startpage.com' && (u.pathname.startsWith('/do/dsearch') || u.pathname.startsWith('/sp/search'))) {
        if (q('query')) return { engine: 'Startpage', query: q('query') };
      } else if (host === 'duckduckgo.com') {
        if (q('q')) return { engine: 'DuckDuckGo', query: q('q') };
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * SEARCH HANDOFF: open the REAL search url outside the embedded frame.
   * - Android/iOS: the secure system browser view (Chrome Custom Tab /
   *   SFSafariViewController) - always works, feels in-app.
   * - Web/PWA: a new browser tab via window.open - real search
   *   navigations carry the user's activation (they pressed Enter or
   *   picked a suggestion), so popup blockers allow it; session restores
   *   and other activation-less loads fall back to the in-tab card's
   *   button. Once per tab+url (re-renders never reopen anything).
   */
  maybeAutoOpenSerpExternally(url, tabId) {
    if (!this._autoExternalOpened) this._autoExternalOpened = new Set();
    const key = `${tabId || 'tab'}::serp::${url}`;
    if (this._autoExternalOpened.has(key)) return true;
    this._autoExternalOpened.add(key);
    if (this.capacitorBrowser && typeof this.capacitorBrowser.open === 'function') {
      Promise.resolve(this.openExternally(url)).catch(() => {});
      return true;
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (opened) return true;
      } catch { /* popup-blocked - the card's button covers it */ }
    }
    return false;
  }

  /** Honest in-tab card for a handed-off search (the tab URL stays the
   *  original engine url; one click re-opens the search). */
  buildSerpHandoffFallback(url, intent, { autoOpened = false } = {}) {
    const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const fallback = document.createElement('div');
    fallback.className = 'fb-frame-blocked-fallback fb-serp-handoff-fallback';
    fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; background:var(--fb-bg-elevated,#15171c); color:var(--fb-text-primary,#d7dbe3); text-align:center; padding:24px; z-index:1;';
    const message = autoOpened
      ? `${intent.engine} doesn\u2019t allow its results inside other apps, so your search for \u201C${escapeHtml(intent.query)}\u201D opened in your browser.`
      : `${intent.engine} doesn\u2019t allow its results inside other apps.`;
    fallback.innerHTML = `
      <div style="font-size:0.9rem; max-width:380px; line-height:1.5;">${message}</div>
      <button type="button" class="fb-btn fb-frame-blocked-open-btn" style="padding:8px 16px; border-radius:8px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-size:0.875rem;">Open search</button>
    `;
    fallback.querySelector('.fb-frame-blocked-open-btn')?.addEventListener('click', () => {
      this.openExternally(url);
    });
    return fallback;
  }

  /**
   * On the Capacitor native apps, frame-blocked sites are opened
   * AUTOMATICALLY in the system secure browser view (Chrome Custom Tab /
   * SFSafariViewController) the first time a tab lands on them - the user
   * asked for google.com, so google.com opens, instead of a dead card.
   * Once per tab+url (re-renders never reopen it); returns whether the
   * auto-open happened for the fallback card's wording.
   */
  maybeAutoOpenBlockedExternally(url, tabId) {
    if (!this._autoExternalOpened) this._autoExternalOpened = new Set();
    const key = `${tabId || 'tab'}::${url}`;
    if (this._autoExternalOpened.has(key)) return true;
    // Capacitor native apps: Chrome Custom Tab / SFSafariViewController.
    if (this.capacitorBrowser && typeof this.capacitorBrowser.open === 'function') {
      this._autoExternalOpened.add(key);
      Promise.resolve(this.openExternally(url)).catch(() => {});
      return true;
    }
    // Web/PWA: a web page physically cannot embed a frame-hostile site -
    // the BEST it can do is actually OPEN the site. Try a real new
    // browser tab while the user's activation is still live (they just
    // typed/chose the URL); when the popup blocker wins, the honest
    // card with its one-click button stays as the fallback.
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      this._autoExternalOpened.add(key);
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (opened) return true;
      } catch { /* popup blocked - the card's button covers it */ }
      return false;
    }
    return false;
  }

  buildSystemBrowserHandoffFallback(url, { tabId = null, native = false } = {}) {
    const fallback = document.createElement('div');
    fallback.className = 'fb-frame-blocked-fallback fb-auth-handoff-fallback';
    fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; background:var(--fb-bg-elevated,#15171c); color:var(--fb-text-primary,#d7dbe3); text-align:center; padding:24px; z-index:1;';
    fallback.innerHTML = `
      <div style="font-size:0.9rem; max-width:380px; line-height:1.5;">Identity-provider sign-in opens in a separate secure browser. This Yayra tab and its URL stay intact. Browser cookies are not copied into Yayra, so a third-party site may not reflect the sign-in here unless it completes its own supported callback.</div>
      <button type="button" class="fb-btn fb-auth-handoff-open-btn" style="padding:8px 16px; border-radius:8px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-size:0.875rem;">Open sign-in in browser</button>
    `;
    fallback.querySelector('.fb-auth-handoff-open-btn')?.addEventListener('click', () => {
      if (native && tabId) {
        // Re-enter the normal native ensure path to ask the main process to
        // retry shell.openExternal(), without changing this tab or history.
        this._systemBrowserHandoffs.delete(tabId);
        if (this.state.activeTabId === tabId) this.render();
        return;
      }
      this.openExternally(url);
    });
    return fallback;
  }

  createWebContentFrame(url, { frameClassName = '', onLoaded, tabId = null, isPrivate = false, allowNative = true } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fb-webview-frame-wrapper';
    wrapper.style.cssText = 'position:relative; flex:1; width:100%; height:100%; display:flex; min-height:0;';

    // PRIMARY FIX: on Electron (Linux/Windows desktop builds) real website
    // content is rendered by a native WebContentsView, not an <iframe> -
    // see electron/webviewBridge.cjs for the full rationale. A WebContentsView
    // is a sibling OS surface, not a nested browsing context, so a target
    // site's X-Frame-Options/frame-ancestors headers (which only govern
    // frame/iframe embedding) never come into play.
    if (allowNative && tabId && this.nativeWebview) {
      this.attachNativeWebviewSlot(wrapper, tabId, url, isPrivate);
      // Do NOT call onLoaded() here. The native engine reports loading
      // through loading-start/loading-stop events; this blanket "loaded"
      // on every chrome render forced the X back to the refresh icon in
      // the middle of real loads (and generally fought the event-driven
      // state). Stuck states are healed by the loading watchdog and the
      // engine-truth isLoading carried on 'navigated' events instead.
      return { wrapper, iframe: null };
    }

    // No native Electron bridge here: plain web/PWA tab, or an Android/iOS
    // Capacitor build (which still runs this file inside ONE WebView, so a
    // nested <iframe> is subject to the exact same restrictions a desktop
    // browser tab would see). Google/Apple/Microsoft refuse to complete
    // sign-in inside ANY embedded webview on these platforms too - hand off
    // to the real system/in-app browser instead of attempting (and failing)
    // to embed the sign-in page. See the matching Electron-side handoff in
    // electron/webviewBridge.cjs for the desktop equivalent of this check.
    if (this.isSystemBrowserAuthHost(url)) {
      let handoff = this._systemBrowserHandoffs.get(tabId);
      if (!handoff || handoff.url !== url) {
        handoff = { url, status: 'opening' };
        this._systemBrowserHandoffs.set(tabId, handoff);
        Promise.resolve(this.openExternally(url)).then(() => {
          if (this._systemBrowserHandoffs.get(tabId) === handoff) handoff.status = 'opened';
        }).catch((err) => {
          if (this._systemBrowserHandoffs.get(tabId) === handoff) handoff.status = 'failed';
          console.warn('[yayra] system-browser auth handoff failed:', err);
        });
      }
      wrapper.appendChild(this.buildSystemBrowserHandoffFallback(url, { tabId }));
      if (typeof onLoaded === 'function') onLoaded();
      return { wrapper, iframe: null };
    }

    // OFFLINE PROMPT: never render a silent blank frame. While there is
    // no connection, any fresh http(s) frame shows the honest offline
    // card (with Retry) instead. Tabs that already hold a live pooled
    // frame never reach this method - loaded pages stay live offline.
    if (!this._onLine() && /^https?:\/\//i.test(String(url || ''))) {
      wrapper.appendChild(this.buildOfflineFallback(url));
      if (typeof onLoaded === 'function') onLoaded();
      return { wrapper, iframe: null };
    }

    // Known case: don't even attempt to embed it — avoids the raw browser
    // "refused to connect" error ever flashing inside the frame.
    if (this.isKnownFrameBlockedUrl(url)) {
      // ANDROID NATIVE TAB ENGINE: frame-hostile sites render in Yayra's
      // OWN native webview layer, inside the app - Google, YouTube, X,
      // Facebook genuinely open IN Yayra, no "open in other app" handoff.
      if (tabId && this.capacitorTabWeb) {
        this.attachAndroidTabWebview(wrapper, tabId, url);
        return { wrapper, iframe: null };
      }
      // SEARCHES: no major engine allows embedded results anymore
      // (verified Oct 2026 - even DuckDuckGo's lite/html endpoints send
      // X-Frame-Options: SAMEORIGIN), so the old "render DuckDuckGo
      // results in the frame" fallback produced a DEAD blank frame. The
      // search now genuinely OPENS - the secure system browser view on
      // Android/iOS, a user-activated new browser tab on web - with an
      // honest one-click "Open search" card kept in the tab.
      const intent = this.getSearchIntent(url);
      if (intent) {
        const autoOpened = this.maybeAutoOpenSerpExternally(url, tabId);
        wrapper.appendChild(this.buildSerpHandoffFallback(url, intent, { autoOpened }));
        if (typeof onLoaded === 'function') onLoaded();
        return { wrapper, iframe: null };
      }
      // Everything else that refuses embedding: on the Capacitor native
      // apps it opens AUTOMATICALLY in the secure system browser view
      // (Chrome Custom Tab) - the user asked for the site, so the site
      // opens; the card stays behind with an "Open again" button.
      const autoOpened = this.maybeAutoOpenBlockedExternally(url, tabId);
      wrapper.appendChild(this.buildFrameBlockedFallback(url, { autoOpened }));
      if (typeof onLoaded === 'function') onLoaded();
      return { wrapper, iframe: null };
    }

    const iframe = document.createElement('iframe');
    if (frameClassName) iframe.className = frameClassName;
    iframe.src = url;
    iframe.style.cssText = 'flex:1; border:none; width:100%; height:100%;';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    iframe.setAttribute('allow', 'fullscreen');

    let settled = false;
    const showBlockedFallback = () => {
      if (settled) return;
      settled = true;
      wrapper.appendChild(this.buildFrameBlockedFallback(url));
    };

    iframe.addEventListener('load', () => {
      if (typeof onLoaded === 'function') onLoaded();
      // Best-effort secondary net for hosts not in the known-blocked list:
      // a site that refuses framing never actually navigates — the
      // browser silently keeps the frame on its pre-navigation
      // same-origin document instead. A genuinely framed cross-origin
      // page throws a SecurityError on contentDocument access; a blocked
      // one does not, because it was never replaced. Note this does NOT
      // catch every case (some browsers render the inline refusal error
      // as a cross-origin document too, which is why the proactive
      // hostname list above is the primary defense).
      setTimeout(() => {
        try {
          const frameDoc = iframe.contentDocument || iframe.contentWindow?.document;
          const blocked = !!frameDoc && (!frameDoc.location || frameDoc.location.href === 'about:blank');
          if (blocked) showBlockedFallback();
        } catch (_err) {
          // Threw because the frame now holds a real cross-origin document
          // — navigation succeeded, nothing to do.
        }
      }, 450);
    });

    wrapper.appendChild(iframe);
    return { wrapper, iframe };
  }

  /* -------------------------------------------------------------
   * NATIVE WEBSITE-RENDERING ENGINE (ELECTRON DESKTOP)
   * -----------------------------------------------------------
   * See electron/webviewBridge.cjs for the main-process side. This is the
   * renderer half: it keeps a transparent placeholder <div> in the normal
   * HTML layout (so flexbox/grid sizing, the tab strip, address bar, etc.
   * all work completely unchanged) and tells the main process to position a
   * real native WebContentsView exactly on top of that placeholder's
   * on-screen bounds.
   * ----------------------------------------------------------- */
  attachNativeWebviewSlot(wrapper, tabId, url, isPrivate) {
    wrapper.className += ' fb-native-webview-slot';

    // OAuth/sign-in is handled outside the embedded WebContentsView. Keep
    // the original tab, URL and navigationState authoritative; only the
    // provider URL is sent to Electron for shell.openExternal(). The record
    // is installed BEFORE the async IPC call so a fast re-render cannot open
    // another system-browser window for the same tab+URL.
    if (this.isSystemBrowserAuthHost(url)) {
      let handoff = this._systemBrowserHandoffs.get(tabId);
      if (!handoff || handoff.url !== url) {
        handoff = { url, status: 'opening' };
        this._systemBrowserHandoffs.set(tabId, handoff);
        wrapper.appendChild(this.buildSystemBrowserHandoffFallback(url, { tabId, native: true }));

        const activeProfileId = this.profileService ? this.profileService.current().id : 'default';
        Promise.resolve(this.nativeWebview.ensure(tabId, url, isPrivate, activeProfileId, {
          theme: this.state.settings.pointerTheme || 'system',
          size: this.state.settings.pointerSize || 'normal'
        })).then((result) => {
          if (this._systemBrowserHandoffs.get(tabId) !== handoff) return;
          const tab = this.state.tabs.find((item) => item.id === tabId);
          if (result && result.handedOffToSystemBrowser) {
            handoff.status = 'opened';
            if (tab && tab.url === url) this.updateTabLoading(tabId, false);
          } else {
            handoff.status = 'failed';
            if (tab && tab.url === url) this.updateTabLoading(tabId, false);
            this.showTransientNotice('Could not open the sign-in browser. This tab was kept unchanged.');
          }
        }).catch((err) => {
          if (this._systemBrowserHandoffs.get(tabId) === handoff) handoff.status = 'failed';
          const tab = this.state.tabs.find((item) => item.id === tabId);
          if (tab && tab.url === url) this.updateTabLoading(tabId, false);
          console.warn('[yayra] native auth handoff failed:', err);
        });
      } else {
        wrapper.appendChild(this.buildSystemBrowserHandoffFallback(url, { tabId, native: true }));
      }
      return;
    }

    this._systemBrowserHandoffs.delete(tabId);
    this._nativeWebviewTabIds.add(tabId);

    // While chrome is overlaying the page the native surface stays hidden;
    // show the last captured snapshot in its place so the page is still
    // "there" visually underneath the drawer/modal/mini window.
    if (this.hasBlockingOverlay() && typeof document !== 'undefined') {
      const snapshot = this._pageSnapshots.get(tabId);
      const still = document.createElement('img');
      still.className = 'fb-page-snapshot-img';
      still.dataset.tabId = tabId;
      still.alt = '';
      still.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:top left; background:var(--fb-bg-glass-input,#101218);';
      if (snapshot) still.src = snapshot;
      wrapper.appendChild(still);
    }

    // Pass the active browsing profile so Electron places this view in
    // that profile's own session partition (real cookie/login separation).
    const activeProfileId = this.profileService ? this.profileService.current().id : 'default';
    this.nativeWebview.ensure(tabId, url, isPrivate, activeProfileId, {
      theme: this.state.settings.pointerTheme || 'system',
      size: this.state.settings.pointerSize || 'normal'
    }).catch((err) => console.warn('[yayra] native webview ensure() failed:', err));

    const reportBounds = () => {
      // Never reposition (and thereby re-show) the native surface while
      // chrome is overlaying the page - the next render after the overlay
      // closes re-reports real bounds via the fresh ResizeObserver below.
      if (this.hasBlockingOverlay()) return;
      try {
        const rect = wrapper.getBoundingClientRect();
        this.nativeWebview.setBounds(tabId, {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        });
      } catch (_err) {
        // Non-browser/test environment without a real layout engine - safe
        // to ignore, there is nothing to position on screen.
      }
    };

    const previousObserver = this._nativeWebviewResizeObservers.get(tabId);
    if (previousObserver) previousObserver.disconnect();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(reportBounds);
      observer.observe(wrapper);
      this._nativeWebviewResizeObservers.set(tabId, observer);
    } else {
      // No ResizeObserver (very old WebKit/test environments): best-effort
      // one-shot placement plus the existing window resize handler.
      setTimeout(reportBounds, 0);
    }
  }

  /* -------------------------------------------------------------
   * ANDROID NATIVE TAB WEBVIEW ENGINE (see get capacitorTabWeb)
   * ----------------------------------------------------------- */
  attachAndroidTabWebview(wrapper, tabId, url) {
    wrapper.className += ' fb-android-tabweb-slot';
    this._androidTabWebIds.add(tabId);
    const plugin = this.capacitorTabWeb;

    const reportBounds = () => {
      try {
        const rect = wrapper.getBoundingClientRect();
        plugin.tabWebUpdate({
          id: tabId,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        }).catch(() => {});
      } catch (_err) {
        // No layout engine (tests/headless) - nothing to position.
      }
    };

    // Attach at a 1px placeholder; the ResizeObserver below reports the
    // real DOM bounds the moment the wrapper is mounted.
    plugin.tabWebAttach({
      id: tabId,
      url,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      pointerTheme: this.state.settings.pointerTheme || 'system',
      pointerSize: this.state.settings.pointerSize || 'normal'
    }).then((res) => {
      if (res && res.ok === false) {
        this._androidTabWebEngineUnavailable(wrapper, tabId, url);
        return;
      }
      reportBounds();
      // The render-time visibility sync ran BEFORE this attach (it is
      // called at the top of the viewport render) - set the freshly
      // attached surface's own visibility now, honouring overlays.
      this.syncAndroidTabWebVisibility(tabId, !this.hasBlockingOverlay() && this.state.activeTabId === tabId);
    }).catch(() => {
      this._androidTabWebEngineUnavailable(wrapper, tabId, url);
    });

    const previousObserver = this._androidTabWebResizeObservers.get(tabId);
    if (previousObserver) previousObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(reportBounds);
      observer.observe(wrapper);
      this._androidTabWebResizeObservers.set(tabId, observer);
    } else {
      setTimeout(reportBounds, 0);
    }
  }

  /** The native engine could not be created (very old app shell): fall
   *  back to the honest card + auto-open, exactly like a build without
   *  the engine. */
  _androidTabWebEngineUnavailable(wrapper, tabId, url) {
    this._androidTabWebIds.delete(tabId);
    const autoOpened = this.maybeAutoOpenBlockedExternally(url, tabId);
    wrapper.appendChild(this.buildFrameBlockedFallback(url, { autoOpened }));
  }

  /** Mirrors syncNativeWebviewVisibility for the Android engine: only the
   *  active tab's surface is visible; everything else is hidden (it is a
   *  sibling native layer, it would otherwise float over the wrong page). */
  syncAndroidTabWebVisibility(activeTabId, showActive) {
    if (!this._androidTabWebIds || this._androidTabWebIds.size === 0) return;
    const plugin = this.capacitorTabWeb;
    if (!plugin) return;
    for (const tabId of this._androidTabWebIds) {
      plugin.tabWebSetVisible({ id: tabId, visible: tabId === activeTabId && Boolean(showActive) }).catch(() => {});
    }
  }

  /** Normalizes the Android engine's tabWebEvent into the desktop engine's
   *  event shape - one handler (handleNativeWebviewEvent) drives both. */
  handleAndroidTabWebEvent(evt) {
    if (!evt || !evt.id) return;
    this.handleNativeWebviewEvent({
      tabId: evt.id,
      type: evt.type,
      url: evt.url,
      title: evt.title,
      canGoBack: evt.canGoBack,
      canGoForward: evt.canGoForward,
      isLoading: evt.isLoading
    });
  }

  /** Android hardware Back: inside a native-engine page it walks THAT
   *  page's history first; otherwise the standard app exit. */
  handleAndroidBackButton() {
    // Standard Android back-stack, outermost chrome first: an open side
    // drawer closes, then the floating mini window, then the page's own
    // history walks, and only at the page root does Back leave the app.
    if (this.state.isSideDrawerOpen) {
      this.state.isSideDrawerOpen = false;
      this.render();
      return;
    }
    if (this.state.isFloatingMiniOpen) {
      this.state.isFloatingMiniOpen = false;
      this.render();
      return;
    }
    const tab = this.getActiveTab();
    if (tab && this._androidTabWebIds.has(tab.id)) {
      if (tab.canGoBack) {
        this.capacitorTabWeb?.tabWebGoBack({ id: tab.id }).catch(() => {});
        return;
      }
    }
    try { window.Capacitor?.Plugins?.App?.exitApp?.(); } catch { /* older builds */ }
  }

  destroyAndroidTabWebview(tabId) {
    if (!this._androidTabWebIds || !this._androidTabWebIds.has(tabId)) return;
    this._androidTabWebIds.delete(tabId);
    const observer = this._androidTabWebResizeObservers.get(tabId);
    if (observer) {
      observer.disconnect();
      this._androidTabWebResizeObservers.delete(tabId);
    }
    this.capacitorTabWeb?.tabWebRemove({ id: tabId }).catch(() => {});
  }

  /**
   * Shows only the active tab's native view (when it should be visible -
   * i.e. the active tab is actually rendering external web content, not an
   * internal yayra:// page) and hides every other tab's native view. Native
   * views are sibling OS surfaces layered above the HTML document, so any
   * tab not currently on screen must be explicitly hidden or it would float
   * over whatever IS on screen.
   */
  syncNativeWebviewVisibility(activeTabId, showActive, { captureActive = false } = {}) {
    if (!this.nativeWebview || this._nativeWebviewTabIds.size === 0) return;
    for (const tabId of this._nativeWebviewTabIds) {
      const visible = tabId === activeTabId && showActive;
      if (visible) {
        this.nativeWebview.setVisible(tabId, true).catch(() => {});
        continue;
      }
      // Hiding the ACTIVE tab because chrome needs to overlay it. Start a
      // snapshot capture, but never make the UI wait for it: native views
      // paint above every HTML overlay, so wait-for-snapshot made menus
      // appear behind the page (sometimes for hundreds of milliseconds).
      // The placeholder already contains the last available still; a fresh
      // one is painted asynchronously when capturePage resolves.
      const wantsCapture = captureActive && tabId === activeTabId;
      if (wantsCapture && typeof this.nativeWebview.capture === 'function') {
        if (!this._nativeSnapshotCaptures) this._nativeSnapshotCaptures = new Set();
        const capturePending = this._nativeSnapshotCaptures;
        let capturePromise = null;
        if (!capturePending.has(tabId)) {
          capturePending.add(tabId);
          try {
            capturePromise = Promise.resolve(this.nativeWebview.capture(tabId));
          } catch {
            capturePending.delete(tabId);
          }
        }

        // Hide immediately, independently of the snapshot's completion.
        const hiddenResult = this.nativeWebview.setVisible(tabId, false);
        if (hiddenResult && typeof hiddenResult.catch === 'function') hiddenResult.catch(() => {});

        if (capturePromise) {
          capturePromise.then((res) => {
            if (res && res.snapshot) {
              this._pageSnapshots.set(tabId, res.snapshot);
              this.applyPageSnapshot(tabId);
              // The tab switcher may already be on screen showing a stale
              // or placeholder preview for this tab - paint the fresh one.
              this.refreshTabSwitcherPreviews();
            }
          }).catch(() => {}).finally(() => capturePending.delete(tabId));
        }
        continue;
      }
      // Legacy combined path (older preloads without capture()): the main
      // process snapshots before zeroing bounds and returns the image.
      const result = this.nativeWebview.setVisible(tabId, false, wantsCapture ? { capture: true } : undefined);
      if (wantsCapture && result && typeof result.then === 'function') {
        result.then((res) => {
          if (res && res.snapshot) {
            this._pageSnapshots.set(tabId, res.snapshot);
            this.applyPageSnapshot(tabId);
            this.refreshTabSwitcherPreviews();
          }
        }).catch(() => {});
      } else if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    }
  }

  /**
   * Live-updates an OPEN tab-switcher's preview cards with the latest
   * captured snapshots. The switcher renders before the async
   * capturePage() of the active tab resolves, so without this the
   * just-opened switcher would show a placeholder for the very page the
   * user is looking at.
   */
  refreshTabSwitcherPreviews() {
    if (this.state.activeModal !== 'tab-switcher' || typeof document === 'undefined') return;
    const cards = document.querySelectorAll('.fb-mobile-tab-card');
    if (!cards || typeof cards.forEach !== 'function') return;
    cards.forEach((card) => {
      const tabId = card.dataset?.tabId || card.getAttribute?.('data-tab-id');
      const snapshot = tabId ? this._pageSnapshots.get(tabId) : null;
      if (!snapshot) return;
      const slot = card.querySelector('.fb-mobile-tab-preview');
      if (!slot) return;
      const img = slot.querySelector('.fb-tab-preview-img');
      if (img) {
        if (img.src !== snapshot) img.src = snapshot;
      } else {
        slot.innerHTML = `<img class="fb-tab-preview-img" src="${snapshot}" alt="" draggable="false" />`;
      }
    });
  }

  /**
   * Paints the latest captured snapshot into the (already-rendered)
   * placeholder slot for a tab. Runs after the async capture resolves, and
   * only while chrome is actually overlaying the page.
   */
  applyPageSnapshot(tabId, onPainted = null) {
    const done = () => { if (typeof onPainted === 'function') onPainted(); };
    if (typeof document === 'undefined' || !this.hasBlockingOverlay()) { done(); return; }
    const snapshot = this._pageSnapshots.get(tabId);
    if (!snapshot) { done(); return; }
    // Search the shell's own rendered tree first (works for the main
    // window, the mini window, and detached test containers), falling
    // back to the whole document.
    let img = null;
    for (const root of [this.viewportElement, this.rootElement, document]) {
      if (!root || typeof root.querySelectorAll !== 'function') continue;
      const stills = Array.from(root.querySelectorAll('.fb-page-snapshot-img') || []);
      img = stills.find((el) => (el.dataset && el.dataset.tabId === tabId)
        || (typeof el.getAttribute === 'function' && el.getAttribute('data-tab-id') === tabId)) || null;
      if (img) break;
    }
    if (!img) { done(); return; }
    if (img.src === snapshot) { done(); return; }
    if (typeof onPainted === 'function') {
      // Signal readiness only after the data-URL actually decodes and
      // paints, so the native view hides UNDER an already-visible still.
      let signalled = false;
      const signal = () => { if (!signalled) { signalled = true; done(); } };
      img.onload = () => { img.onload = null; signal(); };
      setTimeout(signal, 250); // decode fail-safe
      img.src = snapshot;
      if (img.complete) signal();
      return;
    }
    img.src = snapshot;
  }

  /**
   * Lightweight page-obscuring toggle for transient popups that live
   * OUTSIDE the render() cycle (the omnibox suggestion dropdown): hides/
   * restores the native page surface in place, without a full re-render
   * that would destroy the focused input mid-typing.
   */
  setPageObscured(obscured) {
    const flag = Boolean(obscured);
    if (this.state.isPageObscured === flag) return;
    this.state.isPageObscured = flag;
    if (!this.nativeWebview) return;
    const tab = this.getActiveTab();
    if (!tab) return;
    const url = tab.url || '';
    const isInternal = !url || url === 'about:blank' || url.startsWith('yayra://');
    if (isInternal) return;

    if (flag) {
      // FREEZE FIX: surfaces obscured while the window is hidden are the
      // ones whose close paths can freeze - arm the return-to-window heal.
      this.ensureSurfaceHealOnReturn();
      this.syncNativeWebviewVisibility(tab.id, false, { captureActive: true });
      this.syncAndroidTabWebVisibility(tab.id, false);
      if (typeof document !== 'undefined') {
        const slot = this.viewportElement?.querySelector('.fb-native-webview-slot');
        if (slot && !slot.querySelector('.fb-page-snapshot-img')) {
          const still = document.createElement('img');
          still.className = 'fb-page-snapshot-img';
          still.dataset.tabId = tab.id;
          still.alt = '';
          still.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:top left; background:var(--fb-bg-glass-input,#101218);';
          const snapshot = this._pageSnapshots.get(tab.id);
          if (snapshot) still.src = snapshot;
          slot.appendChild(still);
        }
      }
    } else {
      if (typeof document !== 'undefined') {
        this.viewportElement?.querySelectorAll('.fb-page-snapshot-img').forEach((el) => el.remove());
      }
      const restored = this.nativeWebview.setVisible(tab.id, true);
      if (restored && typeof restored.catch === 'function') restored.catch(() => {});
      this.restoreActiveNativeBounds(tab.id);
    }
  }

  /**
   * FREEZE FIX (stuck page surface - "everything frozen, not even
   * scrolling, refresh does not even work, until I ran a new search and
   * all the remaining pages snapped back with it"): on desktop the live
   * page is a native surface that is hidden and swapped for a still
   * snapshot whenever Yayra chrome overlays it. That "obscured" flag is
   * sticky STATE - if a popup's close path was ever missed (frozen
   * background timer, exception, re-render mid-interaction), the flag
   * outlives its overlay: the user stares at a dead snapshot that
   * swallows every click and wheel event, refresh runs invisibly behind
   * the hidden surface, and only a fresh navigation happens to repair
   * it. This invariant replaces trust with truth: if the flag says
   * obscured but no genuine obscuring overlay EXISTS on screen right
   * now, restore the live surface immediately. Called from render(),
   * reload(), hardReload() and the moment the user returns to the
   * window - a loaded page must REMAIN live, always.
   */
  healStuckPageSurface() {
    if (!this.state.isPageObscured) return false;
    const s = this.state;
    // Render-tracked chrome that legitimately obscures the page.
    if (s.isSideDrawerOpen || s.activeModal || s.isSecurityDropdownOpen ||
        s.isAccountMenuOpen || s.isDownloadsDropdownOpen || s.isFloatingMiniOpen ||
        s.isRadialLauncherOpen || (s.findInPage && s.findInPage.isOpen) ||
        s.pendingPasswordSave || s.closePrompt) return false;
    // Transient popups that live OUTSIDE render() (they obscure too).
    if (typeof document !== 'undefined' && document.body) {
      try {
        const up = (el) => Boolean(el) && el.hidden !== true;
        if (up(document.querySelector('.fb-update-splash'))) return false;
        if (up(document.querySelector('.fb-text-prompt-overlay'))) return false;
        if (up(document.querySelector('.fb-tab-context-menu'))) return false;
        if (up(document.querySelector('.fb-dropdown-scrim'))) return false;
        if (up(document.querySelector('.fb-passkey-dialog-overlay'))) return false;
        if (up(document.getElementById('yayra-reader-overlay'))) return false;
        if (up(document.getElementById('yayra-taskmgr-overlay'))) return false;
        if (up(document.getElementById('yayra-url-qr-overlay'))) return false;
        if (up(document.getElementById('yayra-install-app-overlay'))) return false;
        const lists = document.querySelectorAll('.fb-search-suggestions');
        for (const list of (lists || [])) {
          if (up(list)) return false; // omnibox / new-tab suggestion dropdown
        }
      } catch { /* best-effort DOM probe */ }
    }
    // Nothing on screen justifies hiding the page: restore the live
    // surface (drops the still image, shows the native view again).
    this.setPageObscured(false);
    this.logger?.('[overlays] healed a stuck page-obscured flag - live surface restored');
    return true;
  }

  /**
   * Arms a one-shot heal for the moment the user returns to the window.
   * Page surfaces obscured while the window was hidden (update relaunch,
   * mid-typing relaunch) are exactly the ones whose close paths can
   * freeze - the return itself must repair them. Re-arms on the next
   * obscure; the heal is a no-op unless the flag is truly stuck.
   */
  ensureSurfaceHealOnReturn() {
    if (this._surfaceHealOnReturnBound) return;
    this._surfaceHealOnReturnBound = true;
    try {
      document.addEventListener('visibilitychange', () => {
        if (typeof document === 'undefined' || document.hidden === true) return;
        this._surfaceHealOnReturnBound = false; // re-arm on the next obscure
        try { this.healStuckPageSurface(); } catch { /* best-effort */ }
      });
    } catch { /* embedders/shims without document events */ }
  }

  restoreActiveNativeBounds(tabId) {
    if (typeof document === 'undefined' || !this.nativeWebview) return;
    const slot = this.viewportElement?.querySelector('.fb-native-webview-slot');
    if (!slot) return;
    try {
      const rect = slot.getBoundingClientRect();
      this.nativeWebview.setBounds(tabId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    } catch {
      // No layout engine (tests) - nothing on screen to reposition.
    }
  }

  handleNativeWebviewEvent(evt) {
    if (!evt || !evt.tabId) return;
    const { tabId, type } = evt;
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    switch (type) {
      case 'loading-start':
        this.updateTabLoading(tabId, true);
        break;
      case 'loading-stop':
        this.updateTabLoading(tabId, false);
        break;
      case 'navigated': {
        const previousUrl = tab.url;
        const pendingHandoff = this._systemBrowserHandoffs.get(tabId);
        if (pendingHandoff && evt.url && pendingHandoff.url !== evt.url) this._systemBrowserHandoffs.delete(tabId);
        tab.url = evt.url || tab.url;
        tab.isSecure = (tab.url || '').startsWith('https://');
        tab.canGoBack = Boolean(evt.canGoBack);
        tab.canGoForward = Boolean(evt.canGoForward);
        // Engine-truth loading state rides with every navigation: if a
        // loading-stop event was ever missed, this snaps the X/refresh
        // button back to reality instead of leaving it stuck.
        if (typeof evt.isLoading === 'boolean') this.updateTabLoading(tabId, evt.isLoading);
        const navigationState = this.ensureNavigationState(tab);
        const currentUrl = navigationState.historyStack[navigationState.currentIndex];
        if (currentUrl !== tab.url) {
          navigationState.historyStack = navigationState.historyStack.slice(0, navigationState.currentIndex + 1);
          navigationState.historyStack.push(tab.url);
          navigationState.currentIndex = navigationState.historyStack.length - 1;
        }
        if (!tab.isPrivate && this.historyRepo && tab.url !== 'yayra://newtab') {
          const recorded = typeof this.historyRepo.recordVisit === 'function'
            ? this.historyRepo.recordVisit(tab.url, tab.title, tab.favicon)
            : (typeof this.historyRepo.addEntry === 'function' ? this.historyRepo.addEntry(tab.url, tab.title, tab.favicon) : null);
          Promise.resolve(recorded).then(() => this.refreshHistoryState()).catch(() => {});
        }
        if (tabId === this.state.activeTabId) {
          this.state.urlInputValue = this.getDisplayUrl(tab.url);
          this.updateBookmarkState(tab.url);
          // A reload reports the SAME url - rebuilding the whole chrome
          // for it is the "blink on refresh". Only a real address change
          // needs a full render; reloads update surgically in place. Real
          // changes go through requestRender() so a restore/navigate storm
          // (many tabs landing at once) collapses into ONE rebuild.
          if (tab.url === previousUrl) this.refreshNavigationUi(tab);
          else this.requestRender();
        }
        break;
      }
      case 'title-updated':
        tab.title = evt.title || tab.title;
        // Surgical in-place label update - a full render here made every
        // page load (and every SPA title tick) flash the whole chrome.
        this.refreshTabTitleUi(tabId);
        break;
      case 'favicon-updated':
        tab.favicon = evt.favicon || tab.favicon;
        break;
      case 'fail-load':
        this.updateTabLoading(tabId, false);
        console.warn(`[yayra] native webview failed to load ${evt.url}: ${evt.errorDescription} (${evt.errorCode})`);
        break;
      case 'system-browser-handoff': {
        // Direct auth URLs have an in-tab fallback card; popups and blocked
        // redirects leave the relying site visible and get this non-blocking
        // notice instead. Never claim browser cookies/session state are shared.
        const sameTabAuthUrl = evt.url && evt.url === tab.url
          && this._systemBrowserHandoffs.get(tabId)?.url === evt.url;
        if (!sameTabAuthUrl) {
          this.showTransientNotice('Sign-in opened in a separate browser; this tab may not receive the site’s login state.');
        }
        break;
      }
      case 'auth-navigation-blocked': {
        // Android's native TabWebView cancels top-level provider sign-in
        // navigations before loading them, then asks the Capacitor Browser
        // plugin for its secure system-browser surface. The current tab and
        // its history are deliberately left untouched.
        if (evt.url && this.isSystemBrowserAuthHost(evt.url)) {
          this.showTransientNotice('Sign-in opened in a separate browser; this tab may not receive the site’s login state.');
          Promise.resolve(this.openExternally(evt.url)).catch(() => {});
        }
        break;
      }
      case 'hard-reloaded': {
        // Ctrl+Shift+R / Ctrl+F5 pressed INSIDE the page (the native view
        // owns those keystrokes) - cache already cleared main-side.
        let host = evt.origin || '';
        try { host = new URL(evt.origin).hostname; } catch { /* keep raw */ }
        this.showTransientNotice(host ? `Cache cleared for ${host} - reloading from the network.` : 'Hard reload - cache bypassed.');
        break;
      }
      case 'autofill-captured':
        // Chrome-style: a login was submitted inside the page. Offer to
        // remember it (never for private tabs - checked again in the vault).
        this.handleAutofillCaptured(tab, evt);
        break;
      case 'autofill-form-detected':
        this.handleAutofillFormDetected(tab, evt);
        break;
      case 'email-field-focused':
        this.handleEmailFieldFocused(tab, evt);
        break;
      case 'email-address-captured':
        this.rememberEmailAddress(evt.email, tab, evt.url).catch(() => {});
        break;
      case 'new-window-request':
        if (evt.url) {
          // Links and window.open requests belong beside the tab that
          // launched them, not at the end of the strip. Keep the source
          // profile/privacy scope and existing tab group as well.
          this.createNewTab(Boolean(tab.isPrivate), {
            afterTabId: tab.id,
            group: tab.group || null
          });
          this.navigateActiveTab(evt.url);
        }
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------
   * PASSWORD VAULT: Chrome-style remember prompt, autofill, passkeys
   * ----------------------------------------------------------- */

  async refreshBookmarksState() {
    if (this.bookmarksRepo && typeof this.bookmarksRepo.getAllBookmarks === 'function') {
      this.state.bookmarksItems = await this.bookmarksRepo.getAllBookmarks() || [];
    }
    if (this.bookmarksRepo && typeof this.bookmarksRepo.getGroups === 'function') {
      const groups = await this.bookmarksRepo.getGroups();
      if (Array.isArray(groups) && groups.length) this.state.bookmarkGroups = groups;
    }
    if (this.bookmarksRepo && typeof this.bookmarksRepo.getDefaultGroupId === 'function') {
      this.state.bookmarkDefaultGroupId = await this.bookmarksRepo.getDefaultGroupId() || DEFAULT_BOOKMARK_GROUP_ID;
    }
    const groups = Array.isArray(this.state.bookmarkGroups) && this.state.bookmarkGroups.length
      ? this.state.bookmarkGroups
      : DEFAULT_BOOKMARK_GROUPS;
    if (!groups.some((group) => group.id === this.state.bookmarkDefaultGroupId)) {
      this.state.bookmarkDefaultGroupId = DEFAULT_BOOKMARK_GROUP_ID;
    }
    if (!groups.some((group) => group.id === this.state.bookmarksActiveGroupId)) {
      this.state.bookmarksActiveGroupId = this.state.bookmarkDefaultGroupId;
    }
    return this.state.bookmarksItems;
  }

  async refreshEmailAddressesState() {
    if (!this.emailAddressesRepo || typeof this.emailAddressesRepo.getAllEmails !== 'function') return [];
    this.state.rememberedEmails = await this.emailAddressesRepo.getAllEmails() || [];
    return this.state.rememberedEmails;
  }

  async pushEmailSuggestionsToOpenTabs() {
    const native = this.nativeWebview;
    if (!native || typeof native.suggestEmailAddresses !== 'function') return;
    const values = (Array.isArray(this.state.rememberedEmails) ? this.state.rememberedEmails : [])
      .map((item) => typeof item === 'string' ? item : item?.email)
      .filter((value) => typeof value === 'string');
    const pending = this.state.tabs
      .filter((tab) => !tab.isPrivate && /^https?:\/\//i.test(String(tab.url || '')))
      .map((tab) => Promise.resolve(native.suggestEmailAddresses(tab.id, values)).catch(() => {}));
    await Promise.all(pending);
  }

  async rememberEmailAddress(email, tab = null, pageUrl = '') {
    if (!this.emailAddressesRepo || typeof this.emailAddressesRepo.addEmail !== 'function' || !tab || tab.isPrivate) return null;
    const url = String(pageUrl || tab.url || '');
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const saved = await this.emailAddressesRepo.addEmail(email);
    if (!saved) return null;
    try { await this.refreshEmailAddressesState(); } catch { /* the stored address remains saved */ }
    try { await this.pushEmailSuggestionsToOpenTabs(); } catch { /* a suggestion refresh must not block form handling */ }
    const active = this.getActiveTab();
    if (active?.url === 'yayra://passwords') this.requestRender();
    return saved;
  }

  async handleEmailFieldFocused(tab, evt = {}) {
    if (!tab || tab.isPrivate || !this.emailAddressesRepo) return;
    const native = this.nativeWebview;
    if (!native || typeof native.suggestEmailAddresses !== 'function') return;
    const url = String(evt.url || tab.url || '');
    let pageOrigin;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      pageOrigin = parsed.origin;
    } catch { return; }
    // Ignore a stale focus event from the document that was just navigated
    // away from. This also prevents another page from requesting this tab's
    // profile data during a navigation race.
    try {
      const current = new URL(tab.url || '');
      if ((current.protocol === 'http:' || current.protocol === 'https:') && current.origin !== pageOrigin) return;
    } catch { /* the first navigation event may not have reached the shell */ }
    let emails = [];
    try {
      emails = typeof this.emailAddressesRepo.getAllEmails === 'function'
        ? await this.emailAddressesRepo.getAllEmails()
        : [];
    } catch { return; }
    const values = (Array.isArray(emails) ? emails : [])
      .map((item) => typeof item === 'string' ? item : item?.email)
      .filter((value) => typeof value === 'string');
    try { await native.suggestEmailAddresses(tab.id, values); } catch { /* page may have navigated away */ }
  }

  async refreshVaultState() {
    if (this.passwordManager) {
      try {
        if (typeof this.passwordManager.getAllCredentials === 'function') {
          this.state.passwordsItems = await this.passwordManager.getAllCredentials();
        }
        if (typeof this.passwordManager.getAllKeys === 'function') {
          this.state.vaultKeysItems = await this.passwordManager.getAllKeys();
        }
        if (typeof this.passwordManager.getConfig === 'function') {
          this.state.passwordsConfig = await this.passwordManager.getConfig();
        }
      } catch (err) {
        console.warn('Failed to refresh vault state:', err);
      }
    }
    if (this.passkeyService && typeof this.passkeyService.getRegisteredPasskey === 'function') {
      try {
        // Desktop: reconcile the renderer's record with the device
        // bridge's ground truth FIRST (adopts a bridge record after a
        // localStorage wipe; drops a stale record after the device file
        // vanished), so the card below never claims "Passkey active"
        // when verify would honestly fail with "nothing registered".
        if (typeof this.passkeyService.syncWithNativeBridge === 'function') {
          const sync = await this.passkeyService.syncWithNativeBridge();
          this.state.passkeyDeviceStatus = sync.status || null;
          if (sync.action === 'cleared-stale') {
            this.showTransientNotice('Your device passkey record was missing from this computer - create it again from Passwords & Keys.');
          }
        }
        this.state.passkeyInfo = await this.passkeyService.getRegisteredPasskey();
      } catch {
        this.state.passkeyInfo = null;
      }
    }
  }

  async handleAutofillCaptured(tab, evt) {
    if (!this.passwordManager || !tab || tab.isPrivate) return;
    const { url, username, password } = evt || {};
    if (!url || !username || !password) return;
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    // Never offer to save Yayra's own internal pages.
    if (origin.startsWith('yayra://')) return;
    // Login identifiers are useful email suggestions too. Save only to this
    // profile, and never when the source tab is Incognito (guarded above).
    try { await this.rememberEmailAddress(username, tab, url); } catch { /* email recall must not block password handling */ }
    // Smart profile separation: an email-shaped sign-in on a real page is
    // the signal Chrome uses for "someone else is using this browser".
    this.handleAccountSignal(username, { source: 'site-signin' });
    try {
      const offer = typeof this.passwordManager.shouldOfferToSave === 'function'
        ? await this.passwordManager.shouldOfferToSave({ origin, username, password, isPrivate: tab.isPrivate })
        : this.passwordManager.shouldPromptToSave(origin, tab.isPrivate);
      if (!offer) return;
    } catch { return; }
    const existing = (await this.passwordManager.getCredentialsForOrigin(origin))
      .find((c) => c.username === username);
    this.state.pendingPasswordSave = {
      tabId: tab.id,
      origin,
      username,
      password,
      isUpdate: Boolean(existing)
    };
    this.render();
  }

  async handleAutofillFormDetected(tab, evt) {
    if (!this.passwordManager || !tab || tab.isPrivate) return;
    if (!this.nativeWebview || typeof this.nativeWebview.fillCredentials !== 'function') return;
    const config = this.state.passwordsConfig || (await this.passwordManager.getConfig());
    if (!config.autofillEnabled) return;
    const url = (evt && evt.url) || tab.url;
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    const guardKey = `${tab.id}|${origin}`;
    if (this._autofilledFor.has(guardKey)) return;
    const matches = await this.passwordManager.getCredentialsForOrigin(origin);
    if (matches.length === 0) return;
    this._autofilledFor.add(guardKey);
    // Chrome behaviour: a single saved credential fills silently; multiple
    // matches fill the most recently used one and say so.
    const chosen = [...matches].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
    try {
      await this.nativeWebview.fillCredentials(tab.id, {
        username: chosen.username,
        password: chosen.password
      });
      const host = origin.replace(/^https?:\/\//, '');
      this.showTransientNotice(matches.length > 1
        ? `Filled most recent sign-in for ${host} (${matches.length} saved)`
        : `Filled saved sign-in for ${host}`);
    } catch { /* page may have navigated away */ }
  }

  async resolvePendingPasswordSave(action) {
    const pending = this.state.pendingPasswordSave;
    this.state.pendingPasswordSave = null;
    if (!pending) { this.render(); return; }
    if (action === 'save' && this.passwordManager) {
      const result = await this.passwordManager.saveCredential({
        origin: pending.origin,
        username: pending.username,
        password: pending.password
      });
      if (result && result.success) {
        await this.refreshVaultState();
        this.showTransientNotice(pending.isUpdate
          ? `Updated password for ${pending.origin.replace(/^https?:\/\//, '')}`
          : `Password saved to your encrypted vault`);
      } else {
        this.showTransientNotice(`Couldn't save password: ${result?.reason || 'unknown error'}`);
      }
    } else if (action === 'never' && this.passwordManager
      && typeof this.passwordManager.addNeverSaveOrigin === 'function') {
      await this.passwordManager.addNeverSaveOrigin(pending.origin);
      await this.refreshVaultState();
      this.showTransientNotice(`Yayra won't offer to save passwords for ${pending.origin.replace(/^https?:\/\//, '')}`);
    }
    this.render();
  }

  renderPasswordSaveBar(root) {
    const pending = this.state.pendingPasswordSave;
    if (!pending) return;
    const host = pending.origin.replace(/^https?:\/\//, '');
    const bar = document.createElement('div');
    bar.className = 'fb-password-save-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Save password');
    bar.innerHTML = `
      <div class="fb-password-save-icon">${Icons.lock}</div>
      <div class="fb-password-save-text">
        <strong>${pending.isUpdate ? 'Update password?' : 'Save password?'}</strong>
        <span>${pending.username} &middot; ${host}</span>
      </div>
      <div class="fb-password-save-actions">
        <button class="fb-btn fb-btn-primary fb-pwd-save-yes">${pending.isUpdate ? 'Update' : 'Save'}</button>
        <button class="fb-btn fb-btn-secondary fb-pwd-save-never">Never</button>
        <button class="fb-action-btn fb-pwd-save-dismiss" title="Not now" aria-label="Not now">${Icons.close}</button>
      </div>
    `;
    bar.querySelector('.fb-pwd-save-yes')?.addEventListener('click', () => this.resolvePendingPasswordSave('save'));
    bar.querySelector('.fb-pwd-save-never')?.addEventListener('click', () => this.resolvePendingPasswordSave('never'));
    bar.querySelector('.fb-pwd-save-dismiss')?.addEventListener('click', () => this.resolvePendingPasswordSave('dismiss'));
    root.appendChild(bar);
  }

  /**
   * Passkey gate for revealing/copying vault secrets. One successful
   * OS-level ceremony unlocks the vault for 5 minutes. Returns true when
   * access is allowed.
   */
  async unlockVaultIfNeeded() {
    const config = this.state.passwordsConfig
      || (this.passwordManager ? await this.passwordManager.getConfig() : null);
    if (!config || !config.requirePasskeyToReveal) return true;
    if (!this.state.passkeyInfo) return true; // gate enabled but no passkey yet
    if (Date.now() - this._vaultUnlockedAt < 5 * 60 * 1000) return true;
    if (!this.passkeyService) return false;
    const result = await this._performPasskeyCeremony();
    if (result && result.success) {
      this._vaultUnlockedAt = Date.now();
      return true;
    }
    this.showTransientNotice('Passkey verification needed to reveal vault secrets.');
    return false;
  }

  /**
   * Small promise-based dialog for the passkey fallback ladder (PIN entry,
   * method choice). Self-contained DOM overlay - usable from both the full
   * and mini shells, independent of the render cycle. Overridable in tests.
   * Resolves { action, values } where values holds any input contents.
   */
  _passkeyDialog({ title, description, inputs = [], buttons = [] }) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) { resolve({ action: 'cancel', values: {} }); return; }
      const overlay = document.createElement('div');
      overlay.className = 'fb-passkey-dialog-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,10,16,0.62);display:flex;align-items:center;justify-content:center;';
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--fb-bg-elevated,#171a22);color:var(--fb-text-primary,#f3f4f6);border-radius:16px;padding:22px;max-width:380px;width:92%;box-shadow:0 18px 60px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;';
      const h = document.createElement('strong');
      h.textContent = title;
      h.style.cssText = 'font-size:1.05rem;';
      card.appendChild(h);
      if (description) {
        const p = document.createElement('p');
        p.textContent = description;
        p.style.cssText = 'margin:0;font-size:0.84rem;color:var(--fb-text-secondary,#9ca3af);line-height:1.5;';
        card.appendChild(p);
      }
      const fields = {};
      for (const input of inputs) {
        const el = document.createElement('input');
        el.type = 'password';
        el.inputMode = 'numeric';
        el.maxLength = 6;
        el.autocomplete = 'off';
        el.placeholder = input.placeholder || '6-digit PIN';
        el.style.cssText = 'font-size:1.3rem;letter-spacing:0.5em;text-align:center;padding:10px;border-radius:10px;border:1px solid var(--fb-border,#2a2f3b);background:var(--fb-bg,#101218);color:inherit;';
        fields[input.id] = el;
        card.appendChild(el);
      }
      const done = (action) => {
        const values = {};
        for (const [id, el] of Object.entries(fields)) values[id] = el.value || '';
        try { overlay.remove(); } catch { /* already gone */ }
        resolve({ action, values });
      };
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      for (const btn of buttons) {
        const b = document.createElement('button');
        b.textContent = btn.label;
        b.style.cssText = btn.primary
          ? 'padding:11px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-accent,#6d5df2);color:#fff;'
          : 'padding:11px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-bg,#232734);color:inherit;';
        b.addEventListener('click', () => done(btn.action));
        row.appendChild(b);
      }
      card.appendChild(row);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(buttons.find((b) => b.primary)?.action || 'cancel'); });
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) done('cancel'); });
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const firstField = Object.values(fields)[0];
      if (firstField && typeof firstField.focus === 'function') firstField.focus();
    });
  }

  /**
   * Which protection method should a NEW passkey use? Devices with a
   * usable OS keychain choose between system lock and a 6-digit PIN;
   * devices without one (no biometrics, no keyring, no security key)
   * go straight to the PIN - exactly the fallback the card promises.
   * Returns { method: 'device'|'pin', pin? } or null when cancelled.
   */
  async _choosePasskeyMethod() {
    const status = this.state.passkeyDeviceStatus;
    const deviceLockAvailable = status?.methods ? Boolean(status.methods.deviceLock) : Boolean(status?.available ?? true);
    const touchId = Boolean(status?.methods?.touchId);
    if (deviceLockAvailable) {
      const choice = await this._passkeyDialog({
        title: 'Choose how to protect your vault',
        description: touchId
          ? 'System lock uses Touch ID and your Mac\u2019s Keychain. The 6-digit PIN works on any device - 5 wrong tries locks it for a minute.'
          : 'System lock asks you to confirm your computer\u2019s own password (the one you log in with) whenever the vault needs unlocking. The 6-digit PIN works on any device - 5 wrong tries locks it for a minute.',
        buttons: [
          { action: 'device', label: touchId ? 'Use Touch ID + system lock (recommended)' : 'Use system lock (recommended)', primary: true },
          { action: 'pin', label: 'Create a 6-digit PIN instead' },
          { action: 'cancel', label: 'Cancel' }
        ]
      });
      if (choice.action === 'device') return { method: 'device' };
      if (choice.action !== 'pin') return null;
    } else {
      this.showTransientNotice('No fingerprint, Face ID or OS keychain found on this device - create a 6-digit PIN instead.');
    }
    const pin = await this._promptNewPin();
    return pin ? { method: 'pin', pin } : null;
  }

  /** Ask for a new 6-digit PIN twice (typo protection). Returns pin or null. */
  async _promptNewPin() {
    const first = await this._passkeyDialog({
      title: 'Create your 6-digit PIN',
      description: 'This PIN protects your Yayra vault on this device. It is stored only as a salted scrypt hash - never the digits themselves.',
      inputs: [{ id: 'pin', placeholder: '6-digit PIN' }],
      buttons: [{ action: 'confirm', label: 'Continue', primary: true }, { action: 'cancel', label: 'Cancel' }]
    });
    if (first.action !== 'confirm') return null;
    if (!/^\d{6}$/.test(first.values.pin || '')) {
      this.showTransientNotice('The PIN must be exactly 6 digits.');
      return null;
    }
    const second = await this._passkeyDialog({
      title: 'Confirm your PIN',
      description: 'Type the same 6 digits again.',
      inputs: [{ id: 'pin', placeholder: 'Repeat PIN' }],
      buttons: [{ action: 'confirm', label: 'Create PIN', primary: true }, { action: 'cancel', label: 'Cancel' }]
    });
    if (second.action !== 'confirm') return null;
    if (second.values.pin !== first.values.pin) {
      this.showTransientNotice('The PINs did not match - try again.');
      return null;
    }
    return first.values.pin;
  }

  /**
   * One verification ceremony, method-aware:
   *  - 'pin' records show the PIN dialog (with a phone-QR escape hatch);
   *  - everything else runs the silent device/Touch ID ceremony.
   * Returns the service's { success, reason } result.
   */
  async _performPasskeyCeremony() {
    const stored = this.state.passkeyInfo;
    if (stored?.method === 'pin') {
      const entry = await this._passkeyDialog({
        title: 'Enter your 6-digit PIN',
        description: 'Unlock the Yayra vault on this device.',
        inputs: [{ id: 'pin', placeholder: '6-digit PIN' }],
        buttons: [
          { action: 'confirm', label: 'Unlock', primary: true },
          ...(this.passkeyService?.supportsPhoneApproval ? [{ action: 'phone', label: 'Approve from my phone (QR)' }] : []),
          { action: 'cancel', label: 'Cancel' }
        ]
      });
      if (entry.action === 'phone') {
        const ok = await this.verifyWithPhoneQr();
        return ok ? { success: true } : { success: false, reason: 'verification-cancelled' };
      }
      if (entry.action !== 'confirm') return { success: false, reason: 'verification-cancelled' };
      return this.passkeyService.verifyPasskey({ pin: entry.values.pin });
    }
    return this.passkeyService.verifyPasskey();
  }

  /**
   * Phone QR approval: shows a one-time QR served by the PC itself (LAN,
   * 2-minute expiry - electron/phoneApproval.cjs); approving on the phone
   * counts as the vault verification ceremony. Returns true on approval.
   */
  async verifyWithPhoneQr() {
    if (!this.passkeyService?.supportsPhoneApproval) {
      this.showTransientNotice('Phone approval is only available in the Yayra desktop app.');
      return false;
    }
    const start = await this.passkeyService.startPhoneApproval();
    if (!start || !start.ok) {
      this.showTransientNotice(`Couldn't start phone approval: ${describePasskeyReason(start?.reason)}`);
      return false;
    }
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) { resolve(false); return; }
      const overlay = document.createElement('div');
      overlay.className = 'fb-passkey-dialog-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,10,16,0.62);display:flex;align-items:center;justify-content:center;';
      let svg = '';
      try {
        const qr = qrcode(0, 'M');
        qr.addData(start.url, 'Byte');
        qr.make();
        svg = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
      } catch {
        svg = '';
      }
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--fb-bg-elevated,#171a22);color:var(--fb-text-primary,#f3f4f6);border-radius:16px;padding:22px;max-width:380px;width:92%;box-shadow:0 18px 60px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;text-align:center;';
      card.innerHTML = `
        <strong style="font-size:1.05rem;">Scan with your phone</strong>
        <div style="background:#fff;border-radius:12px;padding:10px;align-self:center;width:220px;height:220px;display:flex;align-items:center;justify-content:center;">
          <div style="width:200px;height:200px;">${svg || ''}</div>
        </div>
        <p style="margin:0;font-size:0.8rem;color:var(--fb-text-secondary,#9ca3af);line-height:1.5;">
          Your phone must be on the same Wi-Fi/network as this PC. The code is one-time and expires in 2 minutes.
          ${svg ? '' : `No QR renderer - open this address on the phone instead:`}
          <br /><code style="font-size:0.75rem;word-break:break-all;">${start.url}</code>
        </p>
        <button class="fb-phone-qr-cancel" style="padding:11px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-bg,#232734);color:inherit;">Cancel</button>`;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      let timer = null;
      const finish = async (approved, message) => {
        if (timer) clearInterval(timer);
        timer = null;
        try { overlay.remove(); } catch { /* already gone */ }
        if (message) this.showTransientNotice(message);
        if (approved) {
          await this.passkeyService.markVerifiedViaPhone();
          this._vaultUnlockedAt = Date.now();
          this.state.passkeyInfo = await this.passkeyService.getRegisteredPasskey();
        }
        resolve(approved);
      };
      card.querySelector('.fb-phone-qr-cancel')?.addEventListener('click', async () => {
        await this.passkeyService.cancelPhoneApproval();
        finish(false, null);
      });
      // PRODUCTION HARDENING: every tick is error-guarded (a failing status
      // call ends the wait cleanly instead of rejecting every 1.5s forever)
      // and a hard 2.5-minute failsafe stops the poll even if the service
      // never reports an end state - no leaked intervals, ever.
      const startedAt = Date.now();
      timer = setInterval(async () => {
        try {
          if (Date.now() - startedAt > 150000) {
            finish(false, 'The phone approval expired - try again.');
            return;
          }
          const { state } = await this.passkeyService.phoneApprovalStatus();
          if (state === 'approved') finish(true, 'Approved from your phone - vault unlocked.');
          else if (state === 'denied') finish(false, 'The request was denied on the phone.');
          else if (state === 'expired' || state === 'idle' || state === 'unavailable') finish(false, 'The phone approval expired - try again.');
        } catch {
          finish(false, 'The phone approval connection dropped - try again.');
        }
      }, 1500);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  async registerAccountPasskey() {
    if (!this.passkeyService) return;
    if (!this.passkeyService.isSupported()) {
      this.showTransientNotice('Passkeys need a device with biometrics/PIN and a secure (HTTPS) context, or the Yayra desktop app (OS keychain).');
      return;
    }
    const profile = this.state.googleAccount?.signedIn ? this.state.googleAccount.profile : null;
    const label = (profile && (profile.email || profile.name)) || 'Yayra user';
    // Desktop: walk the fallback ladder (system lock -> 6-digit PIN).
    // Web/PWA keeps real WebAuthn, where the browser itself offers
    // biometrics/PIN/security-key - no extra chooser needed.
    let registerArgs = { accountLabel: label };
    if (this.passkeyService.usesNativeBridge) {
      const choice = await this._choosePasskeyMethod();
      if (!choice) return;
      registerArgs = { accountLabel: label, ...choice };
    }
    const result = await this.passkeyService.registerPasskey(registerArgs);
    if (result.success) {
      this.state.passkeyInfo = result.passkey;
      this._vaultUnlockedAt = Date.now();
      this.showTransientNotice(result.passkey?.method === 'pin'
        ? 'Passkey created - your vault is protected by your 6-digit PIN on this device.'
        : 'Passkey created - your Yayra account is now protected by this device.');
    } else {
      this.showTransientNotice(`Couldn't create passkey: ${describePasskeyReason(result.reason)}`);
    }
    this.render();
  }

  async verifyAccountPasskey() {
    if (!this.passkeyService) return false;
    const result = await this._performPasskeyCeremony();
    if (result.success) {
      this._vaultUnlockedAt = Date.now();
      if (result.repaired) {
        // The device record had to be re-created (lost/corrupted file) -
        // the user re-proved themselves via the OS ceremony, so the
        // passkey is intact rather than "removed".
        this.state.passkeyInfo = await this.passkeyService.getRegisteredPasskey();
        this.showTransientNotice('Passkey verified - the device record was repaired automatically.');
      } else {
        this.showTransientNotice('Passkey verified.');
      }
      this.render();
      return true;
    }
    if (result.reason === 'no-passkey-registered') {
      // The service self-healed (dropped the stale record); refresh the
      // card so it offers "Create passkey" again instead of a dead
      // "Passkey active" state, and say exactly what happened.
      this.state.passkeyInfo = await this.passkeyService.getRegisteredPasskey();
      this.showTransientNotice('This device\u2019s passkey record is gone (app data may have been cleared). Click "Create passkey" to set it up again.');
      this.render();
      return false;
    }
    this.showTransientNotice(`Passkey check failed: ${describePasskeyReason(result.reason)}`);
    return false;
  }

  async removeAccountPasskey() {
    if (!this.passkeyService) return;
    // Removing the protector requires proving you still hold it.
    if (this.state.passkeyInfo) {
      const ok = await this.verifyAccountPasskey();
      if (!ok) return;
    }
    await this.passkeyService.removePasskey();
    this.state.passkeyInfo = null;
    if (this.passwordManager) {
      await this.passwordManager.updateConfig({ requirePasskeyToReveal: false });
      await this.refreshVaultState();
    }
    this.showTransientNotice('Passkey removed.');
    this.render();
  }

  destroyNativeWebview(tabId) {
    // The Android native tab engine rides the same teardown: whichever
    // engine the tab used, its surface must go with the tab.
    this.destroyAndroidTabWebview(tabId);
    if (!this._nativeWebviewTabIds.has(tabId)) return;
    this._nativeWebviewTabIds.delete(tabId);
    const observer = this._nativeWebviewResizeObservers.get(tabId);
    if (observer) {
      observer.disconnect();
      this._nativeWebviewResizeObservers.delete(tabId);
    }
    this.nativeWebview?.destroy(tabId).catch(() => {});
  }

  showTransientNotice(message) {
    if (typeof document === 'undefined') return;
    const notice = document.createElement('div');
    notice.className = 'fb-transient-notice';
    notice.textContent = message;
    notice.style.cssText = 'position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#1f2430; color:#e7eaf0; padding:10px 18px; border-radius:10px; font-size:0.85rem; box-shadow:0 8px 24px rgba(0,0,0,0.35); z-index:999999; opacity:0; transition:opacity 0.2s ease;';
    document.body.appendChild(notice);
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => { notice.style.opacity = '1'; });
    setTimeout(() => {
      notice.style.opacity = '0';
      setTimeout(() => notice.remove(), 250);
    }, 4000);
  }

  /* -------------------------------------------------------------
   * 1. NEW TAB PAGE (PHASE 7, REQ 6 & REQ 7)
   * ----------------------------------------------------------- */
  renderNewTabPage(viewport, activeTab) {
    const newTabPage = document.createElement('div');
    newTabPage.className = `fb-newtab-page ${this.state.isMobile ? 'fb-mobile-safari-start-page' : ''}`;

    // Requirement 5 & 7: Developer Sponsor cards — prominent, glassy cards
    // (icon tile + name + domain) that read clearly on web, PWA and Android.
    const adLinks = DEVELOPER_AD_LINKS || this.state.sponsoredLinks || [];
    if (!activeTab.isPrivate && adLinks.length > 0) {
      const sponsoredSection = document.createElement('section');
      sponsoredSection.className = 'fb-dev-ad-showcase fb-sponsored-showcase';
      sponsoredSection.setAttribute('aria-label', 'Developer sponsors');
      const cardsHtml = adLinks.map((item) => {
        const host = item.domain || item.url.replace(/^https?:\/\//, '').split('/')[0];
        return `
        <a class="fb-dev-ad-card fb-sponsored-card" href="${item.url}" data-url="${item.url}" target="_blank" rel="noopener" aria-label="${item.title}" title="${item.title}">
          <img class="fb-dev-ad-icon fb-sponsored-icon" src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" loading="lazy" />
          <span class="fb-dev-ad-text">
            <span class="fb-dev-ad-label">${item.title}</span>
            <span class="fb-dev-ad-domain">${host}</span>
          </span>
          <span class="fb-dev-ad-tooltip">${item.title}</span>
        </a>`;
      }).join('');
      sponsoredSection.innerHTML = `
        <h2 class="fb-dev-ad-heading">Developer Sponsors</h2>
        <div class="fb-dev-ad-row">${cardsHtml}</div>
      `;

      sponsoredSection.querySelectorAll('.fb-sponsored-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          e.preventDefault();
          this.navigateActiveTab(card.dataset.url);
        });
      });

      newTabPage.appendChild(sponsoredSection);
    }

    // Hero Header with Brand Logo
    const hero = document.createElement('div');
    hero.className = 'fb-newtab-hero';

    const logoOrb = document.createElement('div');
    logoOrb.className = 'fb-newtab-logo';
    logoOrb.innerHTML = Icons.officialOrb;
    hero.appendChild(logoOrb);

    const title = document.createElement('div');
    title.className = 'fb-newtab-title';
    title.setAttribute('role', 'img');
    title.setAttribute('aria-label', activeTab.isPrivate ? 'Incognito' : 'yayra');
    title.innerHTML = activeTab.isPrivate
      ? `<span class="fb-incognito-title">${Icons.incognito}<span>Incognito</span></span>`
      : Icons.officialWordmark;
    hero.appendChild(title);
    newTabPage.appendChild(hero);

    if (activeTab.isPrivate) {
      const privacyNote = document.createElement('p');
      privacyNote.className = 'fb-incognito-notice';
      privacyNote.textContent = 'This tab is excluded from Yayra history and session restore. Downloads and bookmarks can still be saved.';
      newTabPage.appendChild(privacyNote);
    }

    // Search Form (Google Default Search)
    const searchForm = document.createElement('form');
    searchForm.className = 'fb-newtab-searchbox';
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = searchForm.querySelector('input');
      if (input && input.value.trim()) {
        this.navigateActiveTab(input.value.trim());
      }
    });

    const searchEngine = this.state.settings.searchEngine || 'google';
    const engineCap = searchEngine.charAt(0).toUpperCase() + searchEngine.slice(1);
    searchForm.innerHTML = `
      <span class="fb-newtab-search-icon">${Icons.search}</span>
      <input type="text" placeholder="${activeTab.isPrivate ? 'Search securely in Incognito' : `Search with ${engineCap} or type a URL`}" class="fb-newtab-input fb-newtab-search-input" autofocus />
    `;
    newTabPage.appendChild(searchForm);
    this.bindSearchSuggestions(searchForm.querySelector('.fb-newtab-search-input'));

    // Chrome-style AI entry point right under the search box: asks the
    // typed query (or just opens the yayra://ai chat when empty).
    if (this.state.aiConfig?.enabled) {
      const aiChip = document.createElement('button');
      aiChip.type = 'button';
      aiChip.className = 'fb-newtab-ai-chip';
      aiChip.innerHTML = `${Icons.sparkles} <span>Ask Yayra AI</span>`;
      aiChip.addEventListener('click', () => {
        const typed = searchForm.querySelector('.fb-newtab-search-input')?.value?.trim() || '';
        this.openAiPage(typed);
      });
      newTabPage.appendChild(aiChip);
    }

    if (this.state.isMobile && !activeTab.isPrivate) {
      this.renderMobileSafariExtensionCard(newTabPage);
    }

    if (!activeTab.isPrivate) {
      // REAL "Frequently Used Sites": built from this profile's actual
      // browsing (visit counts in the history repo), capped at 5. A
      // fresh install or a brand-new profile has none - the section is
      // Chrome-style user shortcuts: the tiles the user pinned here
      // themselves, plus an "Add shortcut" tile (always present - this
      // is where shortcuts LIVE, like Chrome's new tab page).
      const shortcutsSection = document.createElement('div');
      shortcutsSection.className = 'fb-newtab-shortcuts-section';
      shortcutsSection.style.width = '100%';
      shortcutsSection.style.maxWidth = '680px';
      const shortcutsGrid = document.createElement('div');
      shortcutsGrid.className = 'fb-frequent-grid fb-shortcuts-grid';
      (this.state.userShortcuts || []).forEach((shortcut) => {
        const card = document.createElement('button');
        card.className = 'fb-frequent-card fb-newtab-shortcut fb-user-shortcut';
        card.title = shortcut.url;
        card.innerHTML = `
          <div class="fb-frequent-icon-wrap">${this.frequentSiteIconHtml(shortcut)}</div>
          <span class="fb-frequent-title">${String(shortcut.title || shortcut.url).replace(/</g, '&lt;')}</span>
          <span class="fb-shortcut-edit-btn" title="Edit shortcut" data-shortcut-id="${shortcut.id}">⋮</span>
        `;
        card.addEventListener('click', (e) => {
          if (e.target && e.target.classList && e.target.classList.contains('fb-shortcut-edit-btn')) {
            e.stopPropagation();
            this._editingShortcut = shortcut;
            this.openModal('edit-shortcut');
            return;
          }
          this.navigateActiveTab(shortcut.url);
        });
        shortcutsGrid.appendChild(card);
      });
      if ((this.state.userShortcuts || []).length < 12) {
        const addCard = document.createElement('button');
        // NOT fb-newtab-shortcut: that class means "a real site tile"
        // (tests assert a fresh profile shows zero of them) - the Add
        // affordance is chrome, not a site.
        addCard.className = 'fb-frequent-card fb-add-shortcut-card';
        addCard.title = 'Add shortcut';
        addCard.innerHTML = `
          <div class="fb-frequent-icon-wrap fb-add-shortcut-icon">${Icons.plus}</div>
          <span class="fb-frequent-title">Add shortcut</span>
        `;
        addCard.addEventListener('click', () => {
          this._editingShortcut = null;
          this.openModal('edit-shortcut');
        });
        shortcutsGrid.appendChild(addCard);
      }
      shortcutsSection.appendChild(shortcutsGrid);
      newTabPage.appendChild(shortcutsSection);

      // REAL "Frequently Used Sites" (visit-count driven, cap 5).
      const frequentSites = this.getFrequentSites();

      // (The "Restore pages?" prompt is a persistent bar docked into
      // the chrome - renderRestoreBar - so it survives navigation; the
      // "Continue with these tabs?" card below the tiles completes it.)
      if (frequentSites.length > 0) {
        const frequentSection = document.createElement('div');
        frequentSection.style.width = '100%';
        frequentSection.style.maxWidth = '680px';
        frequentSection.innerHTML = `
          <h3 style="font-size:0.85rem; font-weight:700; color:var(--fb-text-muted); text-transform:uppercase; letter-spacing:0.05em; margin:20px 0 8px 8px;">${this.state.isMobile ? 'Favorites' : 'Frequently Used Sites'}</h3>
        `;

        const frequentGrid = document.createElement('div');
        frequentGrid.className = 'fb-frequent-grid';

        frequentSites.forEach((site) => {
          const card = document.createElement('button');
          // Logo-only tiles: the title lives in the tooltip, never as
          // visible text (long page titles made the grid unreadable).
          card.className = 'fb-frequent-card fb-newtab-shortcut fb-icon-only';
          card.title = site.title ? `${site.title}\n${site.url}` : site.url;
          card.setAttribute('aria-label', site.title || site.url);
          card.innerHTML = `
            <div class="fb-frequent-icon-wrap">${this.frequentSiteIconHtml(site)}</div>
          `;
          card.addEventListener('click', () => {
            this.navigateActiveTab(site.url);
          });
          frequentGrid.appendChild(card);
        });

        frequentSection.appendChild(frequentGrid);
        newTabPage.appendChild(frequentSection);
      }

      // "Continue with these tabs?" card - below the tiles, where it
      // reads naturally (the floating toast above handles urgency).
      this.appendContinueCard(newTabPage, frequentSites);

      // Recent History: a proper card (same design language as the
      // continue-tabs card) - click a row to open it, or copy its link.
      if (this.state.historyItems.length > 0) {
        const recentHist = document.createElement('div');
        recentHist.className = 'fb-continue-card fb-newtab-history';
        recentHist.innerHTML = `
          <div class="fb-continue-card-head">${this.state.isMobile ? 'Suggestions' : 'Recent history'}</div>
          ${this.state.historyItems.slice(0, 5).map((h) => {
            let host = h.url;
            try { host = new URL(h.url).hostname; } catch { /* keep url */ }
            const safeUrl = String(h.url).replace(/"/g, '&quot;');
            return `
            <div class="fb-continue-item fb-history-quick-item" data-url="${safeUrl}" role="button" tabindex="0" title="${safeUrl}">
              <img class="fb-continue-favicon" src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
              <span class="fb-continue-text">
                <span class="fb-continue-title">${String(h.title || h.url).replace(/</g, '&lt;')}</span>
                <span class="fb-continue-meta">${host}</span>
              </span>
              <button class="fb-history-copy-btn" data-url="${safeUrl}" title="Copy link">${Icons.copy}</button>
            </div>`;
          }).join('')}
        `;

        recentHist.querySelectorAll('.fb-history-copy-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyLinkToClipboard(btn.dataset.url);
          });
        });
        recentHist.querySelectorAll('.fb-history-quick-item').forEach((item) => {
          item.addEventListener('click', () => {
            this.navigateActiveTab(item.dataset.url);
          });
        });

        newTabPage.appendChild(recentHist);
      }
    }

    if (this.state.isMobile && !activeTab.isPrivate) {
      this.renderMobileSafariStartSections(newTabPage);
    }

    viewport.appendChild(newTabPage);

    // Auto-focus the search bar
    setTimeout(() => {
      newTabPage.querySelector('.fb-newtab-input')?.focus();
    }, 50);
  }

  renderMobileSafariExtensionCard(container) {
    const card = document.createElement('section');
    card.className = 'fb-mobile-safari-extension-card';
    card.innerHTML = `
      <div class="fb-mobile-safari-extension-art" aria-hidden="true">
        <span>${Icons.shield}</span><span>${Icons.lock}</span><span>${Icons.starFilled}</span>
      </div>
      <h2>Extensions</h2>
      <p>Supercharge your Yayra browsing with extensions that can find discounts, block ads, and more.</p>
      <button type="button" class="fb-btn fb-btn-primary fb-mobile-safari-extension-btn">Browse Extensions</button>
    `;
    card.querySelector('button')?.addEventListener('click', () => this.openInternalPage('yayra://extensions'));
    container.appendChild(card);
  }

  renderMobileSafariStartSections(container) {
    const privacy = document.createElement('section');
    privacy.className = 'fb-mobile-safari-section fb-mobile-safari-privacy-card';
    privacy.innerHTML = `
      <h2>${Icons.shield} Privacy Report</h2>
      <div class="fb-mobile-safari-report-body">
        <span class="fb-mobile-safari-report-icon">${Icons.shield}</span>
        <p>Yayra's tracker and ad shield is active for your browsing session.</p>
      </div>
    `;
    container.appendChild(privacy);

    const reading = document.createElement('section');
    reading.className = 'fb-mobile-safari-section fb-mobile-safari-reading-list';
    reading.innerHTML = '<h2>Reading List</h2>';
    const readingItems = this.state.historyItems.slice(0, 3);
    if (readingItems.length) {
      readingItems.forEach((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'fb-mobile-safari-list-row';
        row.innerHTML = `<span class="fb-mobile-safari-list-icon">${Icons.bookmark}</span><span class="fb-mobile-safari-list-copy"><strong></strong><small></small></span>`;
        row.querySelector('strong').textContent = item.title || item.url;
        row.querySelector('small').textContent = item.url;
        row.addEventListener('click', () => this.navigateActiveTab(item.url));
        reading.appendChild(row);
      });
    } else {
      const empty = document.createElement('p');
      empty.className = 'fb-mobile-safari-empty';
      empty.textContent = 'Save pages here to read them later.';
      reading.appendChild(empty);
    }
    container.appendChild(reading);

    const recently = document.createElement('section');
    recently.className = 'fb-mobile-safari-section fb-mobile-safari-recently-closed';
    recently.innerHTML = '<div class="fb-mobile-safari-section-heading"><h2>Recently Closed Tabs</h2><button type="button" class="fb-mobile-safari-clear">Clear All</button></div>';
    const closedTabs = this.state.closedTabsHistory.slice(0, 4);
    if (closedTabs.length) {
      closedTabs.forEach((tab) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'fb-mobile-safari-closed-row';
        row.textContent = tab.title || tab.url;
        row.addEventListener('click', () => {
          this.restoreLastClosedTab();
          this.render();
        });
        recently.appendChild(row);
      });
    } else {
      const empty = document.createElement('p');
      empty.className = 'fb-mobile-safari-empty';
      empty.textContent = 'Closed tabs will appear here.';
      recently.appendChild(empty);
    }
    recently.querySelector('.fb-mobile-safari-clear')?.addEventListener('click', () => {
      this.state.closedTabsHistory = [];
      this.render();
    });
    container.appendChild(recently);
  }

  /* -------------------------------------------------------------
   * 2. FIREFOX-STYLE SETTINGS IN-TAB PAGE (PHASE 9 & 10)
   * ----------------------------------------------------------- */
  // Renders the body of the Settings > Account section for "Sign in with
  // Google". Kept as a small standalone helper (rather than inline in the
  // giant settings template literal) so the sign-in/signing-in/signed-in/
  // error states stay easy to follow. See get authBridge() above for why
  // this is Electron-desktop-only for now.
  // Shared avatar renderer used by both the Settings > Account page and the
  // persistent top-right account button. Google profile photo URLs
  // occasionally 404/expire or fail to load (offline, blocked tracker
  // lists, etc.), so this always has a solid fallback: the signed-in
  // user's initials on a colored circle, never a broken-image icon.
  renderAccountAvatarHtml(profile, size = 32) {
    if (!profile) {
      return `<span class="fb-avatar fb-avatar-signed-out" style="width:${size}px; height:${size}px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,0.08); color:var(--fb-text-secondary);">${Icons.userCircle}</span>`;
    }
    const label = (profile.name || profile.email || '?').trim();
    const initials = label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?';
    const fallback = `<span class="fb-avatar-fallback" style="width:${size}px; height:${size}px; border-radius:50%; display:${profile.picture ? 'none' : 'flex'}; align-items:center; justify-content:center; background:linear-gradient(135deg,#06b6d4,#3b82f6); color:#fff; font-weight:700; font-size:${Math.max(11, Math.round(size * 0.4))}px;">${initials}</span>`;
    const img = profile.picture
      ? `<img src="${profile.picture}" alt="" class="fb-avatar-img" style="width:${size}px; height:${size}px; border-radius:50%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />`
      : '';
    return `<span class="fb-avatar" style="position:relative; width:${size}px; height:${size}px; display:inline-flex;">${img}${fallback}</span>`;
  }

  renderGoogleAccountSectionHtml() {
    if (!this.authBridge) {
      return `
        <p>Sign in with Google is available in the Yayra desktop app. This build of Yayra doesn't support it yet.</p>
      `;
    }

    const account = this.state.googleAccount || { status: 'idle' };

    if (account.status === 'signing-in') {
      return `
        <p>Continue in the browser window that just opened to finish signing in to Google.</p>
        <button class="fb-btn fb-btn-secondary" disabled>Waiting for sign-in&hellip;</button>
      `;
    }

    if (account.status === 'signed-in' && account.profile) {
      const { name, email } = account.profile;
      const sinceLabel = account.savedAt
        ? new Date(account.savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
      return `
        <div style="display:flex; align-items:center; gap:12px;">
          ${this.renderAccountAvatarHtml(account.profile, 40)}
          <div>
            <strong>${name || email || 'Signed in'}</strong>
            ${email ? `<p style="margin:2px 0 0;">${email}</p>` : ''}
            ${sinceLabel ? `<p style="margin:2px 0 0; font-size:0.8rem; color:var(--fb-text-muted);">Signed in since ${sinceLabel}</p>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="fb-btn fb-btn-secondary fb-in-google-manage-btn">Manage Google Account ${Icons.externalLink || '↗'}</button>
          <button class="fb-btn fb-btn-secondary fb-in-google-switch-btn">Switch account</button>
          <button class="fb-btn fb-btn-secondary fb-in-google-signout-btn">Sign out</button>
        </div>
      `;
    }

    const errorNote = account.status === 'error'
      ? `<p class="fb-settings-error-note" style="color:#f66;">Couldn't sign in: ${account.error === 'not_configured' ? 'Google sign-in isn\u2019t configured for this build yet.' : (account.error || 'please try again.')}</p>`
      : '';

    return `
      <p>Sign in with your Google account to personalize Yayra. Sign-in opens in your default browser for security, per Google's own policy.</p>
      ${errorNote}
      <button class="fb-btn fb-btn-primary fb-in-google-signin-btn" style="align-self:flex-start;">Sign in with Google</button>
    `;
  }

  /**
   * Yayra mini's view preference: 'desktop' (the DEFAULT - the same tab
   * strip and toolbar as the main browser) or 'mobile' (the compact
   * layout with controls at the bottom). Its own shared-profile storage
   * key so the mini window can read it at boot; Settings > Floating
   * toggles it.
   */
  getMiniLayoutPref() {
    if (typeof localStorage === 'undefined') return 'desktop';
    try {
      return localStorage.getItem('yayra:mini-layout') === 'mobile' ? 'mobile' : 'desktop';
    } catch { return 'desktop'; }
  }

  setMiniLayoutPref(pref) {
    const value = pref === 'mobile' ? 'mobile' : 'desktop';
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('yayra:mini-layout', value);
    } catch { /* storage unavailable - the choice still applies this session */ }
    // Apply live when THIS shell is the mini panel itself (Settings opened
    // inside yayra mini): the storage event only fires in OTHER windows.
    if (this.options?.isMiniShell && this.state.isMobile !== (value === 'mobile')) {
      this.state.isMobile = value === 'mobile';
      this.render();
    }
    return value;
  }

  renderInternalSettingsPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-settings-app fb-settings-inpage-layout';

    const activeCat = this.state.settingsActiveCategory || this.state.activeSettingsCategory || 'floating';

    page.innerHTML = `
      <nav class="fb-settings-sidebar">
        <h2 style="font-size:1.15rem; font-weight:800; margin:0 0 12px 6px;">Settings</h2>
        <div class="fb-internal-search" style="margin-bottom:12px;">
          <span class="fb-internal-search-icon">${Icons.search}</span>
          <input type="text" id="fb-in-settings-search" class="fb-settings-search-input" placeholder="Search settings" value="${this.state.settingsSearchQuery || ''}" style="width:100%; box-sizing:border-box;" />
        </div>
        <button class="fb-settings-nav-item ${activeCat === 'account' ? 'active' : ''}" data-cat="account" data-category="account">
          ${Icons.info} <span>Account</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'floating' ? 'active' : ''}" data-cat="floating" data-category="floating">
          ${Icons.bubble} <span>Floating & Transparency</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'ai' ? 'active' : ''}" data-cat="ai" data-category="ai">
          ${Icons.sparkles} <span>Yayra AI</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'appearance' ? 'active' : ''}" data-cat="appearance" data-category="appearance">
          ${Icons.moon} <span>Appearance</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'pointer' ? 'active' : ''}" data-cat="pointer" data-category="pointer">
          ${Icons.lens} <span>Pointer</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'privacy' ? 'active' : ''}" data-cat="privacy" data-category="privacy">
          ${Icons.shield} <span>Privacy & Security</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'passwords' ? 'active' : ''}" data-cat="passwords" data-category="passwords">
          ${Icons.lock} <span>Passwords & Autofill</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'tabs' ? 'active' : ''}" data-cat="tabs" data-category="tabs">
          ${Icons.tabs} <span>Tabs & Startup</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'tab-groups' ? 'active' : ''}" data-cat="tab-groups" data-category="tab-groups">
          ${Icons.tabGroup} <span>Tab Groups</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'shortcuts' ? 'active' : ''}" data-cat="shortcuts" data-category="shortcuts">
          ${Icons.lightning || Icons.settings} <span>Shortcuts</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'downloads' ? 'active' : ''}" data-cat="downloads" data-category="downloads">
          ${Icons.download} <span>Downloads</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'extensions' ? 'active' : ''}" data-cat="extensions" data-category="extensions">
          ${Icons.shield} <span>Extensions & Shields</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'updates' ? 'active' : ''}" data-cat="updates" data-category="updates">
          ${Icons.download} <span>Yayra Updates</span>
        </button>
        <button class="fb-settings-nav-item ${activeCat === 'about' ? 'active' : ''}" data-cat="about" data-category="about">
          ${Icons.info} <span>About Yayra</span>
        </button>
      </nav>

      <main class="fb-settings-content-pane">
        <div class="fb-settings-category-panel">
          <!-- Account -->
          <section class="fb-settings-group-card" id="sec-account" style="${activeCat === 'account' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.info} Account</h3>
            ${this.renderGoogleAccountSectionHtml()}
          </section>

          <!-- Floating & Transparency -->
          <section class="fb-settings-group-card" id="sec-floating" style="${activeCat === 'floating' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.bubble} Floating Browser & Assistive Bubble</h3>
            
            <div class="fb-setting-toggle-row">
              <div>
                <strong>Floating Mode Enabled by Default</strong>
                <p>Launches directly into the floating browser window without opening a dashboard.</p>
              </div>
              <input type="checkbox" id="fb-in-set-floating-default" ${this.state.settings.floatingEnabledByDefault ? 'checked' : ''} />
            </div>

            <div class="fb-setting-toggle-row">
              <div>
                <strong>Yayra mini: desktop view</strong>
                <p>On: the mini window uses the same desktop tab strip and toolbar as the main browser. Off: the compact mobile view with the controls at the bottom. Applies to an open mini window immediately.</p>
              </div>
              <input type="checkbox" id="fb-in-set-mini-desktop" ${this.getMiniLayoutPref() === 'desktop' ? 'checked' : ''} />
            </div>

            <div class="fb-setting-slider-row">
              <div class="fb-slider-header">
                <label for="fb-in-bubble-opacity">Collapsed Bubble Opacity</label>
                <span id="fb-in-val-bubble-opacity">${Math.round((this.state.settings.bubbleOpacity || 0.88) * 100)}%</span>
              </div>
              <input type="range" id="fb-in-bubble-opacity" min="20" max="100" value="${Math.round((this.state.settings.bubbleOpacity || 0.88) * 100)}" class="fb-range-slider" />
            </div>

            <div class="fb-setting-slider-row">
              <div class="fb-slider-header">
                <label for="fb-in-bubble-size">Floating Bubble Size</label>
                <span id="fb-in-val-bubble-size">${this.state.settings.bubbleSizePx || 64}px</span>
              </div>
              <input type="range" id="fb-in-bubble-size" min="40" max="120" value="${this.state.settings.bubbleSizePx || 64}" class="fb-range-slider" />
            </div>

            <div class="fb-setting-slider-row">
              <div class="fb-slider-header">
                <label for="fb-in-bubble-shadow">Floating Bubble Shadow</label>
                <span id="fb-in-val-bubble-shadow">${Math.max(0, Math.min(24, Number(this.state.settings.bubbleShadowPx) || 0))}px</span>
              </div>
              <input type="range" id="fb-in-bubble-shadow" min="0" max="24" step="1" value="${Math.max(0, Math.min(24, Number(this.state.settings.bubbleShadowPx) || 0))}" class="fb-range-slider" />
              <small style="color:var(--fb-text-muted);">0px removes the shadow entirely.</small>
            </div>

            <div class="fb-setting-slider-row">
              <div class="fb-slider-header">
                <label for="fb-in-frame-opacity">Floating Browser Frame Opacity</label>
                <span id="fb-in-val-frame-opacity">${Math.round((this.state.settings.frameOpacity || 0.85) * 100)}%</span>
              </div>
              <input type="range" id="fb-in-frame-opacity" min="50" max="100" value="${Math.round((this.state.settings.frameOpacity || 0.85) * 100)}" class="fb-range-slider" />
            </div>

            <div class="fb-setting-slider-row">
              <div class="fb-slider-header">
                <label for="fb-in-slider-blur">Glass Blur Radius</label>
                <span id="fb-in-val-blur">${this.state.settings.glassmorphismBlurRadius || 24}px</span>
              </div>
              <input type="range" id="fb-in-slider-blur" min="0" max="40" value="${this.state.settings.glassmorphismBlurRadius || 24}" class="fb-range-slider" />
            </div>

            <div class="fb-transparency-preview-card" id="fb-in-transparency-live-preview">
              <div class="fb-preview-content">
                <strong>Live Transparency Preview</strong>
                <p>Web content remains high-contrast and crystal-clear above the glassmorphism frame.</p>
              </div>
            </div>

            <div style="display:flex; gap:12px;">
              <button class="fb-btn fb-btn-secondary fb-in-reset-transparency-btn">Reset Defaults</button>
              <button class="fb-btn fb-btn-primary fb-in-save-btn">Save Changes</button>
            </div>
          </section>

          <!-- System-Wide Floating Overlay Bubble -->
          <section class="fb-settings-group-card" id="sec-overlay" style="${activeCat === 'floating' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.bubble} System-Wide Overlay Bubble</h3>
            <p style="font-size:0.82rem; color:var(--fb-text-muted); margin:0;">
              ${this.overlayBridge
                ? 'A small Yayra bubble that floats on top of every other window on your desktop - like Apple\u2019s AssistiveTouch - so you can jump back into Yayra without digging through your taskbar. It starts automatically, before you ever open Yayra.'
                : 'This build can\u2019t run a true system-wide overlay yet. On the Yayra desktop app this runs as its own always-on-top window outside the browser. On Android it needs the "draw over other apps" permission (not wired up in this build); Apple does not allow any third-party app to overlay other apps on iOS, so it will never be available there.'}
            </p>

            <div class="fb-setting-toggle-row">
              <div>
                <strong>Enable floating overlay</strong>
                <p>Shows the bubble right after Yayra starts - no need to open the app first.</p>
              </div>
              <input type="checkbox" id="fb-in-set-overlay-enabled" ${this.state.overlaySettings.enabled ? 'checked' : ''} ${this.overlayBridge ? '' : 'disabled'} />
            </div>

            <div class="fb-setting-toggle-row">
              <div>
                <strong>Open on boot (start with your computer)</strong>
                <p>On: the Yayra bubble appears automatically right after you log in or reboot. Off: nothing launches at boot - no bubble, no window - until you open Yayra yourself.</p>
              </div>
              <input type="checkbox" id="fb-in-set-overlay-autostart" ${this.state.overlaySettings.launchAtStartup ? 'checked' : ''} ${this.overlayBridge ? '' : 'disabled'} />
            </div>

            <div class="fb-setting-toggle-row">
              <div>
                <strong>Overlay on top of every app or window</strong>
                <p>Keeps the bubble above other applications (desktop-only). Turning this off keeps it only above Yayra's own window.</p>
              </div>
              <input type="checkbox" id="fb-in-set-overlay-allapps" ${this.state.overlaySettings.overlayAllApps ? 'checked' : ''} ${this.overlayBridge ? '' : 'disabled'} />
            </div>

            <div class="fb-setting-toggle-row">
              <div>
                <strong>Lock bubble position</strong>
                <p>Keeps the bubble exactly where it is - dragging is disabled until unlocked. Tip: triple-click the bubble to toggle this anywhere.</p>
              </div>
              <input type="checkbox" id="fb-in-set-overlay-poslock" ${this.state.overlaySettings.positionLocked ? 'checked' : ''} ${this.overlayBridge ? '' : 'disabled'} />
            </div>
          </section>

          <!-- Yayra AI -->
          <section class="fb-settings-group-card" id="sec-ai" style="${activeCat === 'ai' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.sparkles} Yayra AI</h3>
            <p style="margin:0; font-size:0.82rem; color:var(--fb-text-secondary);">
              Chrome-style AI across the browser: every search offers an \u201cAsk Yayra AI\u201d option, and <strong>yayra://ai</strong> is a full AI chat page.
              Yayra\u2019s built-in backend is coming online soon${this.state.aiConfig.provider === 'yayra' ? ' (it will answer honestly that it\u2019s not live yet until then)' : ''};
              connecting your own OpenAI-compatible provider below works today.
            </p>
            <div class="fb-setting-toggle-row">
              <div>
                <strong>Enable Yayra AI</strong>
                <p>Turns all AI features on or off everywhere in the browser.</p>
              </div>
              <input type="checkbox" id="fb-in-set-ai-enabled" ${this.state.aiConfig.enabled ? 'checked' : ''} />
            </div>
            <div class="fb-setting-toggle-row">
              <div>
                <strong>Offer \u201cAsk Yayra AI\u201d in search suggestions</strong>
                <p>Adds an AI row above normal suggestions whenever you type in the address bar, like Chrome\u2019s AI search options.</p>
              </div>
              <input type="checkbox" id="fb-in-set-ai-omnibox" ${this.state.aiConfig.suggestInOmnibox ? 'checked' : ''} ${this.state.aiConfig.enabled ? '' : 'disabled'} />
            </div>
            <div class="fb-setting-row">
              <label>Provider</label>
              <select id="fb-in-set-ai-provider" class="fb-select" ${this.state.aiConfig.enabled ? '' : 'disabled'}>
                <option value="yayra" ${this.state.aiConfig.provider === 'yayra' ? 'selected' : ''}>Yayra built-in (no key needed)</option>
                <option value="openai-compatible" ${this.state.aiConfig.provider === 'openai-compatible' ? 'selected' : ''}>OpenAI-compatible endpoint (your own)</option>
              </select>
            </div>
            <div id="fb-ai-provider-custom" style="display:${this.state.aiConfig.provider === 'openai-compatible' ? 'flex' : 'none'}; flex-direction:column; gap:10px;">
              <div class="fb-setting-row">
                <label>Endpoint URL</label>
                <input type="text" class="fb-input" id="fb-in-set-ai-endpoint" placeholder="https://api.openai.com/v1 (or Ollama/Groq/OpenRouter/vLLM...)" value="${escapeAttr(this.state.aiConfig.endpoint)}" />
              </div>
              <div class="fb-setting-row">
                <label>API key</label>
                <input type="password" class="fb-input" id="fb-in-set-ai-key" placeholder="sk-... (stored locally, sent only to YOUR endpoint)" value="${escapeAttr(this.state.aiConfig.apiKey)}" />
              </div>
              <div class="fb-setting-row">
                <label>Model</label>
                <input type="text" class="fb-input" id="fb-in-set-ai-model" placeholder="e.g. gpt-4o-mini, llama3.1, mixtral..." value="${escapeAttr(this.state.aiConfig.model)}" />
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="fb-btn fb-btn-secondary" id="fb-in-set-ai-test" ${this.state.aiConfig.enabled ? '' : 'disabled'}>Test connection</button>
              <button class="fb-btn fb-btn-primary" id="fb-in-set-ai-open">Open Yayra AI</button>
            </div>
          </section>

          <!-- Appearance -->
          <section class="fb-settings-group-card" id="sec-appearance" style="${activeCat === 'appearance' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.moon} Appearance</h3>
            <div class="fb-setting-row">
              <label>Theme</label>
              <select id="fb-in-set-theme" class="fb-select">
                <option value="dark" ${this.state.settings.theme === 'dark' ? 'selected' : ''}>Dark (Default)</option>
                <option value="light" ${this.state.settings.theme === 'light' ? 'selected' : ''}>Light</option>
                <option value="system" ${this.state.settings.theme === 'system' ? 'selected' : ''}>System</option>
              </select>
            </div>
            <div class="fb-setting-row">
              <label>Accent theme</label>
              <select id="fb-in-set-color-theme" class="fb-select">
                <option value="blue" ${(this.state.settings.colorTheme || 'blue') === 'blue' ? 'selected' : ''}>Blue (Default)</option>
                <option value="purple" ${this.state.settings.colorTheme === 'purple' ? 'selected' : ''}>Violet</option>
                <option value="green" ${this.state.settings.colorTheme === 'green' ? 'selected' : ''}>Emerald</option>
                <option value="rose" ${this.state.settings.colorTheme === 'rose' ? 'selected' : ''}>Rose</option>
                <option value="amber" ${this.state.settings.colorTheme === 'amber' ? 'selected' : ''}>Amber</option>
              </select>
            </div>
            <div class="fb-setting-row">
              <label>Default Search Engine</label>
              <select id="fb-in-set-engine" class="fb-select">
                <option value="google" ${this.state.settings.searchEngine === 'google' ? 'selected' : ''}>Google (Default)</option>
                <option value="duckduckgo" ${this.state.settings.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo</option>
                <option value="bing" ${this.state.settings.searchEngine === 'bing' ? 'selected' : ''}>Bing</option>
                <option value="startpage" ${this.state.settings.searchEngine === 'startpage' ? 'selected' : ''}>Startpage</option>
              </select>
            </div>
          </section>

          <!-- Privacy & Security -->
          <section class="fb-settings-group-card" id="sec-pointer" style="${activeCat === 'pointer' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.lens} Pointer</h3>
            <div class="fb-setting-row">
              <label>Pointer style</label>
              <select id="fb-in-set-pointer-theme" class="fb-select">
                <option value="system" ${(this.state.settings.pointerTheme || 'system') === 'system' ? 'selected' : ''}>System (native, recommended)</option>
                <option value="yayra" ${this.state.settings.pointerTheme === 'yayra' ? 'selected' : ''}>Yayra accent</option>
                <option value="high-visibility" ${this.state.settings.pointerTheme === 'high-visibility' ? 'selected' : ''}>High visibility</option>
              </select>
            </div>
            <div class="fb-setting-row">
              <label>Pointer size <small style="color:var(--fb-text-muted);">(custom styles)</small></label>
              <select id="fb-in-set-pointer-size" class="fb-select">
                <option value="normal" ${(this.state.settings.pointerSize || 'normal') === 'normal' ? 'selected' : ''}>Normal</option>
                <option value="large" ${this.state.settings.pointerSize === 'large' ? 'selected' : ''}>Large</option>
                <option value="xlarge" ${this.state.settings.pointerSize === 'xlarge' ? 'selected' : ''}>Extra large</option>
              </select>
            </div>
            <div class="fb-pointer-preview" id="fb-pointer-preview" style="margin-top:10px; padding:14px;">
              <div style="font-size:0.78rem; color:var(--fb-text-muted); margin-bottom:8px;">Live preview - move your pointer over this area:</div>
              <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap;">
                <button type="button" class="fb-btn fb-btn-secondary" style="padding:6px 12px;">A button</button>
                <a href="#" onclick="return false;" style="color:var(--fb-accent-primary);">A link</a>
                <input type="text" placeholder="A text field" style="padding:6px 10px; border-radius:8px; border:1px solid var(--fb-border-glass,rgba(255,255,255,0.14)); background:var(--fb-bg-glass-input,#101218); color:var(--fb-text-primary,#f3f4f6);" />
              </div>
            </div>
            <p style="font-size:0.75rem; color:var(--fb-text-muted); margin:10px 0 0; line-height:1.5;">
              Custom styles apply to Yayra's interface and websites opened in Yayra's built-in web views. The
              System style keeps the native operating-system pointer and its configured size. In web/PWA mode,
              browser security prevents restyling external sites inside cross-origin frames.
            </p>
          </section>
          <section class="fb-settings-group-card" id="sec-privacy" style="${activeCat === 'privacy' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.shield} Privacy & Security</h3>
            <div class="fb-setting-toggle-row">
              <div>
                <strong>HTTPS-First Mode</strong>
                <p>Automatically upgrades connections to secure HTTPS whenever available.</p>
              </div>
              <input type="checkbox" id="fb-in-set-https" ${this.state.settings.httpsFirst !== false ? 'checked' : ''} />
            </div>
            <div class="fb-setting-toggle-row">
              <div>
                <strong>Ad & Tracker Shield</strong>
                <p>Blocks intrusive advertising, third-party analytics, and telemetry beacons.</p>
              </div>
              <input type="checkbox" id="fb-in-set-adblock" ${this.state.settings.adBlockEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="fb-setting-row" style="margin-top:10px;">
              <div>
                <strong>Clear Browsing Data</strong>
                <p>Deletes history, cookies, cache, and cached credentials.</p>
              </div>
              <button class="fb-btn fb-btn-danger fb-in-open-cleardata-btn">Clear Data Now</button>
            </div>
          </section>

          <!-- Passwords & Autofill Link -->
          <section class="fb-settings-group-card" id="sec-passwords" style="${activeCat === 'passwords' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.lock} Passwords & Autofill</h3>
            <p>Manage origin-scoped encrypted credentials in your local-first vault.</p>
            <button class="fb-btn fb-btn-primary fb-in-jump-passwords" style="align-self:flex-start;">Open Passwords Vault</button>
          </section>

          <!-- Tabs & Startup -->
          <section class="fb-settings-group-card" id="sec-tabs" style="${activeCat === 'tabs' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.tabs} Tabs & Startup</h3>
            <div class="fb-setting-toggle-row">
              <div>
                <strong>Restore Previous Session</strong>
                <p>Reopens all tabs from your previous session upon startup.</p>
              </div>
              <input type="checkbox" id="fb-in-set-restore-session" ${this.state.settings.restoreSessionOnLaunch !== false ? 'checked' : ''} />
            </div>
          </section>

          <!-- Tab Groups: view, open, rename, or ungroup existing groups. -->
          <section class="fb-settings-group-card" id="sec-tab-groups" style="${activeCat === 'tab-groups' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.tabGroup} Tab Groups</h3>
            <p>Open a group with one click, rename it, or ungroup its tabs without closing them.</p>
            <div class="fb-tab-group-settings-toolbar">
              <button type="button" class="fb-btn fb-btn-primary fb-in-create-tab-group">${Icons.plus} New tab group</button>
              <button type="button" class="fb-btn fb-btn-secondary fb-in-group-current-tab">${Icons.tabs} Group current tab</button>
              <button type="button" class="fb-btn fb-btn-secondary fb-in-open-tab-groups">${Icons.tabGroup} Open group picker</button>
            </div>
            <div class="fb-tab-groups-settings-list" id="fb-in-tab-groups-list"></div>
          </section>

          <!-- Shortcuts: every keyboard shortcut, system-wide hotkey and
               bubble gesture in one reference. -->
          <section class="fb-settings-group-card" id="sec-shortcuts" style="${activeCat === 'shortcuts' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.settings} Shortcuts</h3>
            <p style="margin:0; font-size:0.82rem; color:var(--fb-text-secondary);">Everything Yayra answers to - in the browser, system-wide anywhere on your PC, and on the floating bubble.</p>
            <h4 class="fb-shortcuts-subhead">In the browser</h4>
            <div class="fb-shortcuts-table">
              <div class="fb-shortcut-row"><span>New tab</span><kbd>Ctrl+T</kbd></div>
              <div class="fb-shortcut-row"><span>Close tab</span><kbd>Ctrl+W</kbd></div>
              <div class="fb-shortcut-row"><span>Reopen last closed tab</span><kbd>Ctrl+Shift+T</kbd></div>
              <div class="fb-shortcut-row"><span>New private window</span><kbd>Ctrl+Shift+N</kbd></div>
              <div class="fb-shortcut-row"><span>Focus the address bar</span><kbd>Ctrl+L</kbd> <span class="fb-shortcut-alt">or</span> <kbd>Alt+D</kbd></div>
              <div class="fb-shortcut-row"><span>Bookmark this page</span><kbd>Ctrl+D</kbd></div>
              <div class="fb-shortcut-row"><span>Bookmark all open tabs</span><kbd>Ctrl+Shift+D</kbd></div>
              <div class="fb-shortcut-row"><span>Toggle the bookmarks bar</span><kbd>Ctrl+Shift+B</kbd></div>
              <div class="fb-shortcut-row"><span>Reload</span><kbd>Ctrl+R</kbd> <span class="fb-shortcut-alt">or</span> <kbd>F5</kbd></div>
              <div class="fb-shortcut-row"><span>Hard reload (clear this site's cache)</span><kbd>Ctrl+Shift+R</kbd> <span class="fb-shortcut-alt">or</span> <kbd>Ctrl+F5</kbd></div>
              <div class="fb-shortcut-row"><span>History</span><kbd>Ctrl+H</kbd></div>
              <div class="fb-shortcut-row"><span>Downloads</span><kbd>Ctrl+J</kbd></div>
              <div class="fb-shortcut-row"><span>Find in page</span><kbd>Ctrl+F</kbd></div>
              <div class="fb-shortcut-row"><span>Open tab groups</span><kbd>Ctrl+Shift+G</kbd></div>
              <div class="fb-shortcut-row"><span>Stop loading / close menus &amp; overlays</span><kbd>Esc</kbd></div>
            </div>
            <h4 class="fb-shortcuts-subhead">System-wide (work anywhere on your PC)</h4>
            <div class="fb-shortcuts-table">
              <div class="fb-shortcut-row"><span>Open main Yayra from anywhere</span><kbd>Ctrl+Alt+Y</kbd></div>
              <div class="fb-shortcut-row"><span>Open/restore main Yayra (low-level hook)</span><kbd>CapsLock+Y</kbd></div>
              <div class="fb-shortcut-row"><span>Open yayra mini</span><kbd>CapsLock+Shift+R</kbd></div>
              <div class="fb-shortcut-row"><span>Hide / bring back yayra mini</span><kbd>Esc (hold) + F1</kbd></div>
            </div>
            <h4 class="fb-shortcuts-subhead">Floating bubble gestures</h4>
            <div class="fb-shortcuts-table">
              <div class="fb-shortcut-row"><span>Open / hide yayra mini</span><kbd>Single click</kbd></div>
              <div class="fb-shortcut-row"><span>Radial quick menu</span><kbd>Double click</kbd></div>
              <div class="fb-shortcut-row"><span>Lock / unlock bubble position</span><kbd>Triple click</kbd></div>
              <div class="fb-shortcut-row"><span>Full bubble menu</span><kbd>Right-click</kbd></div>
              <div class="fb-shortcut-row"><span>Move the bubble</span><kbd>Drag</kbd></div>
            </div>
          </section>

          <!-- Downloads -->
          <section class="fb-settings-group-card" id="sec-downloads" style="${activeCat === 'downloads' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.download} Downloads</h3>
            <div class="fb-setting-row">
              <label>Save files to</label>
              <input type="text" class="fb-input" value="${this.downloadsBridge ? (this.state.downloadRoot || 'Default Downloads folder') : 'Requires the Yayra desktop app'}" readonly style="flex:1;" />
              <button class="fb-btn fb-btn-secondary fb-in-set-dl-choose-root" ${this.downloadsBridge ? '' : 'disabled'}>Change…</button>
            </div>
            <p style="font-size:0.78rem; color:var(--fb-text-muted); margin:0;">Every new download is saved here. ${this.downloadsBridge ? '' : 'Picking a custom folder (e.g. an external drive) requires the Yayra desktop app.'}</p>
          </section>

          <!-- Extensions -->
          <section class="fb-settings-group-card" id="sec-extensions" style="${activeCat === 'extensions' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.shield} Extensions & Content Shields</h3>
            <p>Manage installed privacy extensions, user scripts, and content modifiers.</p>
            <button class="fb-btn fb-btn-primary fb-in-jump-extensions" style="align-self:flex-start;">
              Manage Extensions (${this.state.extensionsItems.length})
            </button>
          </section>

          <!-- About -->
          <!-- Yayra Updates -->
          <section class="fb-settings-group-card" id="sec-updates" style="${activeCat === 'updates' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.download} Yayra Updates</h3>
            ${this.renderUpdatesSettingsHtml()}
          </section>

          <!-- About -->
          <section class="fb-settings-group-card" id="sec-about" style="${activeCat === 'about' || this.state.settingsSearchQuery ? 'display:flex;' : 'display:none;'}">
            <h3 class="fb-settings-group-title">${Icons.info} About Yayra</h3>
            <p>Version ${this.state.updateState.installedVersion || 'unknown'} • Fast, Private Floating Browser with Glassmorphism Overlay.</p>
            <button class="fb-btn fb-btn-secondary fb-in-jump-about" style="align-self:flex-start;">View Release Information</button>
          </section>
        </div>
      </main>
    `;

    this.renderTabGroupSettingsList(page.querySelector('#fb-in-tab-groups-list'));
    page.querySelector('.fb-in-create-tab-group')?.addEventListener('click', () => this.createTabGroup());
    page.querySelector('.fb-in-group-current-tab')?.addEventListener('click', () => this.groupCurrentTab());
    page.querySelector('.fb-in-open-tab-groups')?.addEventListener('click', () => this.openModal('tab-groups'));

    // Sidebar navigation clicks
    page.querySelectorAll('.fb-settings-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.getAttribute('data-cat') || btn.getAttribute('data-category') || btn.dataset.cat;
        this.state.settingsActiveCategory = cat;
        this.state.activeSettingsCategory = cat;
        this.render();
      });
    });

    // Yayra Updates section actions
    this.bindUpdatesSettingsActions(page);

    // Search filter
    const searchInput = page.querySelector('#fb-in-settings-search') || page.querySelector('#fb-settings-search-input');
    searchInput?.addEventListener('input', (e) => {
      this.state.settingsSearchQuery = e.target.value.toLowerCase().trim();
      const q = this.state.settingsSearchQuery;
      page.querySelectorAll('.fb-settings-group-card').forEach((card) => {
        if (!q || card.textContent.toLowerCase().includes(q)) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    });

    // Sliders & Live Preview
    const bSlider = page.querySelector('#fb-in-bubble-opacity') || page.querySelector('#fb-in-slider-bubble-opacity');
    const sizeSlider = page.querySelector('#fb-in-bubble-size');
    const shadowSlider = page.querySelector('#fb-in-bubble-shadow');
    const fSlider = page.querySelector('#fb-in-frame-opacity') || page.querySelector('#fb-in-slider-frame-opacity');
    const blurSlider = page.querySelector('#fb-in-slider-blur');
    const previewBox = page.querySelector('#fb-in-transparency-live-preview');

    const updatePreview = () => {
      const bOp = Number(bSlider?.value || 88) / 100;
      const bSize = Math.max(40, Math.min(120, Number(sizeSlider?.value || this.state.settings.bubbleSizePx || 64)));
      const shadowPx = Math.max(0, Math.min(24, Number(shadowSlider?.value ?? this.state.settings.bubbleShadowPx ?? 0) || 0));
      const fOp = Number(fSlider?.value || 85) / 100;
      const blurVal = Number(blurSlider?.value || 24);

      this.state.settings.bubbleOpacity = bOp;
      this.state.settings.bubbleSizePx = bSize;
      this.state.settings.bubbleShadowPx = shadowPx;
      this.state.settings.frameOpacity = fOp;
      this.state.settings.glassmorphismBlurRadius = blurVal;

      if (page.querySelector('#fb-in-val-bubble-size')) page.querySelector('#fb-in-val-bubble-size').textContent = `${bSize}px`;
      if (page.querySelector('#fb-in-val-bubble-shadow')) page.querySelector('#fb-in-val-bubble-shadow').textContent = `${shadowPx}px`;
      if (page.querySelector('#fb-in-val-bubble-opacity')) page.querySelector('#fb-in-val-bubble-opacity').textContent = `${Math.round(bOp * 100)}%`;
      if (page.querySelector('#fb-in-val-frame-opacity')) page.querySelector('#fb-in-val-frame-opacity').textContent = `${Math.round(fOp * 100)}%`;
      if (page.querySelector('#fb-in-val-blur')) page.querySelector('#fb-in-val-blur').textContent = `${blurVal}px`;

      if (previewBox) {
        previewBox.style.setProperty('--fb-frame-preview-opacity', String(fOp));
        previewBox.style.backdropFilter = `blur(${blurVal}px)`;
      }
      this.ensurePersistentAssistiveBubble();
      this.updateCssCustomProperties();
    };

    bSlider?.addEventListener('input', updatePreview);
    sizeSlider?.addEventListener('input', updatePreview);
    shadowSlider?.addEventListener('input', updatePreview);
    fSlider?.addEventListener('input', updatePreview);
    blurSlider?.addEventListener('input', updatePreview);

    page.querySelector('.fb-in-reset-transparency-btn')?.addEventListener('click', () => {
      if (bSlider) bSlider.value = '88';
      if (sizeSlider) sizeSlider.value = '64';
      if (shadowSlider) shadowSlider.value = '0';
      if (fSlider) fSlider.value = '85';
      if (blurSlider) blurSlider.value = '24';
      updatePreview();
      this.persistSettings();
      this.overlayBridge?.setBubbleSize?.(64);
      this.overlayBridge?.setBubbleOpacity?.(0.88);
      this.overlayBridge?.setBubbleShadow?.(0);
    });

    page.querySelector('.fb-in-save-btn')?.addEventListener('click', async () => {
      const floatingDefault = page.querySelector('#fb-in-set-floating-default')?.checked;
      const theme = page.querySelector('#fb-in-set-theme')?.value;
      const colorTheme = page.querySelector('#fb-in-set-color-theme')?.value;
      const engine = page.querySelector('#fb-in-set-engine')?.value;

      this.state.settings.floatingEnabledByDefault = floatingDefault;
      if (theme) this.state.settings.theme = theme;
      if (colorTheme) this.state.settings.colorTheme = colorTheme;
      if (engine) this.state.settings.searchEngine = engine;

      if (this.settingsRepo) {
        await this.settingsRepo.updateSettings(this.state.settings);
      }
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('yayra:settings', JSON.stringify(this.state.settings));
        } catch {
          // Keep the browser usable when storage is unavailable or full.
        }
      }
      alert('Settings saved successfully.');
      this.render();
    });

    // -----------------------------------------------------------------
    // Immediate-apply controls: every dropdown/toggle takes effect the
    // moment it is changed (Chrome-style) and is persisted right away.
    // The Save button above remains as an explicit "save everything"
    // affordance but is no longer required for changes to stick.
    // -----------------------------------------------------------------
    const bindSelect = (selector, apply) => {
      const el = page.querySelector(selector);
      el?.addEventListener('change', (e) => {
        const value = e?.target?.value !== undefined ? e.target.value : el.value;
        apply(value);
        this.persistSettings();
        this.render();
      });
    };

    // POINTER SETTINGS: immediate-apply, persisted, live everywhere.
    bindSelect('#fb-in-set-pointer-theme', (value) => {
      this.state.settings.pointerTheme = value;
      this.applyPointerTheme();
    });
    bindSelect('#fb-in-set-pointer-size', (value) => {
      this.state.settings.pointerSize = value;
      this.applyPointerTheme();
    });

    const bindToggle = (selector, apply) => {
      const el = page.querySelector(selector);
      el?.addEventListener('change', (e) => {
        const checked = e?.target?.checked !== undefined ? e.target.checked : el.checked;
        apply(!!checked);
        this.persistSettings();
      });
    };

    bindSelect('#fb-in-set-theme', (v) => { this.state.settings.theme = v || 'dark'; });
    bindSelect('#fb-in-set-color-theme', (v) => { this.state.settings.colorTheme = v || 'blue'; });
    bindSelect('#fb-in-set-engine', (v) => { if (v) this.state.settings.searchEngine = v; });

    bindToggle('#fb-in-set-https', (on) => { this.state.settings.httpsFirst = on; });
    bindToggle('#fb-in-set-adblock', (on) => { this.state.settings.adBlockEnabled = on; });
    bindToggle('#fb-in-set-restore-session', (on) => { this.state.settings.restoreSessionOnLaunch = on; });
    // (Chrome-style keep-alive: loaded pages are never auto-refreshed -
    // see mountPooledWebFrame(). The old auto-refresh toggle is gone.)
    bindToggle('#fb-in-set-floating-default', (on) => { this.state.settings.floatingEnabledByDefault = on; });

    // Yayra mini view: desktop chrome (default) or the compact mobile
    // layout. Persisted to the shared profile storage so the mini window
    // boots in the chosen view - and switches live while it is open.
    page.querySelector('#fb-in-set-mini-desktop')?.addEventListener('change', (e) => {
      const desktop = !!(e?.target?.checked ?? page.querySelector('#fb-in-set-mini-desktop')?.checked);
      this.setMiniLayoutPref(desktop ? 'desktop' : 'mobile');
    });

    // Transparency, size and shadow sliders preview live on 'input'; persist
    // their final values once the user releases the handle ('change'). Bubble
    // size, opacity and shadow are also pushed to the native desktop bubble
    // so the real always-on-top overlay updates with the in-page preview.
    bSlider?.addEventListener('change', () => {
      this.persistSettings();
      this.overlayBridge?.setBubbleOpacity?.(this.state.settings.bubbleOpacity);
    });
    sizeSlider?.addEventListener('change', () => {
      this.persistSettings();
      this.overlayBridge?.setBubbleSize?.(this.state.settings.bubbleSizePx);
    });
    shadowSlider?.addEventListener('change', () => {
      this.persistSettings();
      this.overlayBridge?.setBubbleShadow?.(this.state.settings.bubbleShadowPx);
    });
    fSlider?.addEventListener('change', () => this.persistSettings());
    blurSlider?.addEventListener('change', () => this.persistSettings());

    page.querySelector('.fb-in-open-cleardata-btn')?.addEventListener('click', () => {
      this.openModal('clear-data');
    });

    page.querySelector('#fb-in-set-overlay-enabled')?.addEventListener('change', async (e) => {
      if (!this.overlayBridge) return;
      const next = await this.overlayBridge.setEnabled(e.target.checked);
      this.state.overlaySettings = { ...this.state.overlaySettings, ...next };
      this.render();
    });

    page.querySelector('#fb-in-set-overlay-autostart')?.addEventListener('change', async (e) => {
      if (!this.overlayBridge) return;
      const next = await this.overlayBridge.setLaunchAtStartup(e.target.checked);
      this.state.overlaySettings = { ...this.state.overlaySettings, ...next };
      this.render();
    });

    // --- Yayra AI (see services/aiService.js) ---
    const saveAiConfig = async (partial) => {
      if (!this.aiService) return;
      this.state.aiConfig = await this.aiService.updateConfig(partial);
    };
    page.querySelector('#fb-in-set-ai-enabled')?.addEventListener('change', async (e) => {
      await saveAiConfig({ enabled: e.target.checked });
      this.render();
    });
    page.querySelector('#fb-in-set-ai-omnibox')?.addEventListener('change', async (e) => {
      await saveAiConfig({ suggestInOmnibox: e.target.checked });
    });
    page.querySelector('#fb-in-set-ai-provider')?.addEventListener('change', async (e) => {
      await saveAiConfig({ provider: e.target.value });
      const custom = page.querySelector('#fb-ai-provider-custom');
      if (custom) custom.style.display = e.target.value === 'openai-compatible' ? 'flex' : 'none';
    });
    page.querySelector('#fb-in-set-ai-endpoint')?.addEventListener('change', async (e) => {
      await saveAiConfig({ endpoint: e.target.value.trim() });
    });
    page.querySelector('#fb-in-set-ai-key')?.addEventListener('change', async (e) => {
      await saveAiConfig({ apiKey: e.target.value.trim() });
    });
    page.querySelector('#fb-in-set-ai-model')?.addEventListener('change', async (e) => {
      await saveAiConfig({ model: e.target.value.trim() });
    });
    page.querySelector('#fb-in-set-ai-test')?.addEventListener('click', async (e) => {
      if (!this.aiService) return;
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Testing\u2026';
      const result = await this.aiService.testConnection();
      btn.disabled = false;
      btn.textContent = 'Test connection';
      this.showTransientNotice(result.success
        ? 'Yayra AI is connected and answering.'
        : `AI test failed: ${describeAiReason(result.reason)}`);
    });
    page.querySelector('#fb-in-set-ai-open')?.addEventListener('click', () => this.openAiPage());

    page.querySelector('#fb-in-set-overlay-poslock')?.addEventListener('change', async (e) => {
      if (!this.overlayBridge?.setPositionLocked) return;
      const next = await this.overlayBridge.setPositionLocked(e.target.checked);
      this.state.overlaySettings = { ...this.state.overlaySettings, ...next };
      this.showTransientNotice(next.positionLocked
        ? 'Bubble position locked - triple-click the bubble (or untick this) to unlock.'
        : 'Bubble movement unlocked.');
    });

    page.querySelector('#fb-in-set-overlay-allapps')?.addEventListener('change', async (e) => {
      if (!this.overlayBridge) return;
      const next = await this.overlayBridge.setOverlayAllApps(e.target.checked);
      this.state.overlaySettings = { ...this.state.overlaySettings, ...next };
      this.render();
    });

    page.querySelector('.fb-in-set-dl-choose-root')?.addEventListener('click', async () => {
      if (!this.downloadsBridge) return;
      const result = await this.downloadsBridge.chooseRoot();
      if (result?.ok) {
        this.state.downloadRoot = result.root;
        this.render();
      }
    });

    page.querySelector('.fb-in-jump-passwords')?.addEventListener('click', () => {
      this.openInternalPage('yayra://passwords');
    });

    page.querySelector('.fb-in-jump-extensions')?.addEventListener('click', () => {
      this.openInternalPage('yayra://extensions');
    });

    page.querySelector('.fb-in-jump-about')?.addEventListener('click', () => {
      this.openInternalPage('yayra://about');
    });

    page.querySelector('.fb-in-google-signin-btn')?.addEventListener('click', () => {
      this.signInWithGoogle();
    });

    page.querySelector('.fb-in-google-signout-btn')?.addEventListener('click', () => {
      this.signOutOfGoogle();
    });

    page.querySelector('.fb-in-google-switch-btn')?.addEventListener('click', () => {
      this.switchGoogleAccount();
    });

    page.querySelector('.fb-in-google-manage-btn')?.addEventListener('click', () => {
      this.openGoogleAccountPage();
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 3. HISTORY IN-TAB PAGE (PHASE 11)
   * ----------------------------------------------------------- */
  renderInternalHistoryPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page';

    const q = (this.state.historySearchQuery || '').toLowerCase().trim();
    const items = this.state.historyItems.filter((h) => !q || (h.title && h.title.toLowerCase().includes(q)) || (h.url && h.url.toLowerCase().includes(q)));

    page.innerHTML = `
      <div class="fb-internal-container">
        <header class="fb-internal-header">
          <div class="fb-internal-title-group">
            <span class="fb-internal-icon">${Icons.history}</span>
            <h1 class="fb-internal-title">History</h1>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <div class="fb-internal-search">
              <span class="fb-internal-search-icon">${Icons.search}</span>
              <input type="text" id="fb-in-history-search" placeholder="Search history" value="${this.state.historySearchQuery || ''}" />
            </div>
            <button class="fb-btn fb-btn-danger fb-in-clear-history-btn">Clear history</button>
          </div>
        </header>

        <div class="fb-history-date-group">
          <span class="fb-history-date-header">Recently Visited (${items.length})</span>
          ${items.length > 0 ? items.map((item) => `
            <div class="fb-history-item-row fb-history-row" data-url="${item.url}" data-id="${item.id}">
              <div class="fb-history-item-main" data-action="navigate" data-url="${item.url}">
                <span class="fb-history-item-time">${new Date(item.lastVisitedAt || item.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span class="fb-history-item-title">${item.title || item.url}</span>
                <span class="fb-history-item-url">${item.url}</span>
              </div>
              <div class="fb-history-item-actions">
                <button class="fb-btn fb-btn-secondary fb-in-hist-newtab" data-url="${item.url}" title="Open in New Tab">${Icons.plus}</button>
                <button class="fb-btn fb-btn-secondary fb-in-hist-del" data-id="${item.id}" title="Delete from history">${Icons.close}</button>
              </div>
            </div>
          `).join('') : '<div class="fb-empty-state">No browsing history matches your search.</div>'}
        </div>
      </div>
    `;

    const searchInput = page.querySelector('#fb-in-history-search');
    searchInput?.addEventListener('input', (e) => {
      this.state.historySearchQuery = e.target.value;
      this.render();
    });

    page.querySelector('.fb-in-clear-history-btn')?.addEventListener('click', async () => {
      if (confirm('Clear all browsing history?')) {
        if (this.historyRepo && typeof this.historyRepo.clearHistory === 'function') {
          await this.historyRepo.clearHistory();
        }
        this.state.historyItems = [];
        this.render();
      }
    });

    page.querySelectorAll('.fb-history-item-main').forEach((el) => {
      el.addEventListener('click', () => {
        const url = el.dataset.url;
        if (url) this.navigateActiveTab(url);
      });
    });

    page.querySelectorAll('.fb-in-hist-newtab').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.dataset.url;
        if (url) {
          this.createNewTab();
          this.navigateActiveTab(url);
        }
      });
    });

    page.querySelectorAll('.fb-in-hist-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (this.historyRepo && typeof this.historyRepo.deleteEntry === 'function' && id) {
          await this.historyRepo.deleteEntry(id);
        }
        this.state.historyItems = this.state.historyItems.filter((h) => h.id !== id);
        this.render();
      });
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 4. BOOKMARKS IN-TAB PAGE (PHASE 12)
   * ----------------------------------------------------------- */
  renderInternalBookmarksPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page';
    const groups = Array.isArray(this.state.bookmarkGroups) && this.state.bookmarkGroups.length
      ? this.state.bookmarkGroups
      : DEFAULT_BOOKMARK_GROUPS;
    const defaultGroupId = groups.some((group) => group.id === this.state.bookmarkDefaultGroupId)
      ? this.state.bookmarkDefaultGroupId
      : DEFAULT_BOOKMARK_GROUP_ID;
    const activeGroupId = groups.some((group) => group.id === this.state.bookmarksActiveGroupId)
      ? this.state.bookmarksActiveGroupId
      : defaultGroupId;
    this.state.bookmarkDefaultGroupId = defaultGroupId;
    this.state.bookmarksActiveGroupId = activeGroupId;
    const allItems = Array.isArray(this.state.bookmarksItems) ? this.state.bookmarksItems : [];
    const q = String(this.state.bookmarksSearchQuery || '').toLocaleLowerCase().trim();
    const groupItems = allItems.filter((bookmark) => (bookmark.groupId || DEFAULT_BOOKMARK_GROUP_ID) === activeGroupId);
    const items = groupItems.filter((bookmark) => !q
      || String(bookmark.title || '').toLocaleLowerCase().includes(q)
      || String(bookmark.url || '').toLocaleLowerCase().includes(q));

    const container = document.createElement('div');
    container.className = 'fb-internal-container';
    const header = document.createElement('header');
    header.className = 'fb-internal-header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'fb-internal-title-group';
    const titleIcon = document.createElement('span');
    titleIcon.className = 'fb-internal-icon';
    titleIcon.innerHTML = Icons.bookmark;
    const title = document.createElement('h1');
    title.className = 'fb-internal-title';
    title.textContent = 'Bookmarks';
    titleGroup.appendChild(titleIcon);
    titleGroup.appendChild(title);

    const headerActions = document.createElement('div');
    headerActions.className = 'fb-bookmark-header-actions';
    const search = document.createElement('div');
    search.className = 'fb-internal-search';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'fb-internal-search-icon';
    searchIcon.innerHTML = Icons.search;
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'fb-in-bm-search';
    searchInput.placeholder = 'Search bookmarks';
    searchInput.value = this.state.bookmarksSearchQuery || '';
    search.appendChild(searchIcon);
    search.appendChild(searchInput);
    const addButton = document.createElement('button');
    addButton.className = 'fb-btn fb-btn-primary fb-in-add-bm-btn';
    addButton.innerHTML = `${Icons.plus} Add Bookmark`;
    headerActions.appendChild(search);
    headerActions.appendChild(addButton);
    header.appendChild(titleGroup);
    header.appendChild(headerActions);
    container.appendChild(header);

    const folderBar = document.createElement('div');
    folderBar.className = 'fb-bookmarks-folder-bar';
    for (const group of groups) {
      const pill = document.createElement('button');
      pill.className = `fb-folder-pill${group.id === activeGroupId ? ' active' : ''}`;
      pill.type = 'button';
      pill.dataset.groupId = group.id;
      pill.setAttribute('aria-pressed', String(group.id === activeGroupId));
      pill.textContent = group.id === defaultGroupId ? `${group.name} · Default` : group.name;
      pill.addEventListener('click', () => {
        this.state.bookmarksActiveGroupId = group.id;
        this.render();
      });
      folderBar.appendChild(pill);
    }
    container.appendChild(folderBar);

    const groupActions = document.createElement('div');
    groupActions.className = 'fb-bookmark-group-actions';
    const currentGroupLabel = document.createElement('span');
    currentGroupLabel.className = 'fb-bookmark-default-label';
    const defaultGroup = groups.find((group) => group.id === defaultGroupId);
    currentGroupLabel.textContent = `New bookmarks default to ${defaultGroup?.name || 'Bookmarks Bar'}.`;
    const groupButtons = document.createElement('div');
    groupButtons.className = 'fb-bookmark-group-buttons';
    const setDefaultButton = document.createElement('button');
    setDefaultButton.className = 'fb-btn fb-btn-secondary fb-in-bm-set-default';
    setDefaultButton.type = 'button';
    setDefaultButton.textContent = activeGroupId === defaultGroupId ? 'Default group' : 'Make default for new bookmarks';
    setDefaultButton.disabled = activeGroupId === defaultGroupId || typeof this.bookmarksRepo?.setDefaultGroup !== 'function';
    setDefaultButton.addEventListener('click', async () => {
      if (typeof this.bookmarksRepo?.setDefaultGroup !== 'function') return;
      const result = await this.bookmarksRepo.setDefaultGroup(activeGroupId);
      if (!result?.ok) {
        this.showTransientNotice('Could not change the default bookmark group.');
        return;
      }
      await this.refreshBookmarksState();
      this.render();
      this.showTransientNotice(`New bookmarks will go to ${groups.find((group) => group.id === activeGroupId)?.name || 'that group'}.`);
    });
    const newGroupButton = document.createElement('button');
    newGroupButton.className = 'fb-btn fb-btn-secondary fb-in-bm-new-group';
    newGroupButton.type = 'button';
    newGroupButton.textContent = 'New group';
    newGroupButton.disabled = typeof this.bookmarksRepo?.createGroup !== 'function';
    newGroupButton.addEventListener('click', async () => {
      if (typeof this.bookmarksRepo?.createGroup !== 'function') return;
      const name = await this._textPromptDialog({
        title: 'Create bookmark group',
        description: 'Keep related bookmarks together. You can choose this group as the default for new bookmarks.',
        placeholder: 'e.g. Work, Research, Shopping',
        initialValue: ''
      });
      if (name === null) return;
      const result = await this.bookmarksRepo.createGroup(name);
      if (!result?.ok) {
        this.showTransientNotice(result?.reason === 'duplicate-name'
          ? 'A bookmark group with that name already exists.'
          : 'Enter a name for the new bookmark group.');
        return;
      }
      await this.refreshBookmarksState();
      this.state.bookmarksActiveGroupId = result.group.id;
      this.render();
    });
    const activeGroup = groups.find((group) => group.id === activeGroupId);
    const removeGroupButton = document.createElement('button');
    removeGroupButton.className = 'fb-btn fb-btn-secondary fb-in-bm-remove-group';
    removeGroupButton.type = 'button';
    removeGroupButton.textContent = 'Remove group';
    removeGroupButton.disabled = Boolean(activeGroup?.builtIn) || typeof this.bookmarksRepo?.removeGroup !== 'function';
    removeGroupButton.addEventListener('click', async () => {
      if (removeGroupButton.disabled || typeof this.bookmarksRepo?.removeGroup !== 'function') return;
      const confirmed = typeof confirm !== 'function' || confirm(`Remove “${activeGroup?.name || 'this group'}”? Its bookmarks will be kept in the default group.`);
      if (!confirmed) return;
      const result = await this.bookmarksRepo.removeGroup(activeGroupId);
      if (!result?.ok) {
        this.showTransientNotice('Could not remove that bookmark group.');
        return;
      }
      await this.refreshBookmarksState();
      this.render();
      this.showTransientNotice('Group removed; its bookmarks were kept.');
    });
    groupButtons.appendChild(setDefaultButton);
    groupButtons.appendChild(newGroupButton);
    groupButtons.appendChild(removeGroupButton);
    groupActions.appendChild(currentGroupLabel);
    groupActions.appendChild(groupButtons);
    container.appendChild(groupActions);

    const grid = document.createElement('div');
    grid.className = 'fb-items-grid';
    const emptyState = document.createElement('div');
    emptyState.className = 'fb-empty-state fb-bookmarks-empty-state';
    emptyState.textContent = q
      ? 'No bookmarks match that search in this group.'
      : 'No bookmarks in this group yet. Star a page or use Add Bookmark to save one here.';
    emptyState.style.display = items.length ? 'none' : '';
    grid.appendChild(emptyState);
    for (const bookmark of groupItems) {
      const card = document.createElement('div');
      card.className = 'fb-library-card';
      card.dataset.url = bookmark.url || '';
      card.dataset.id = bookmark.id || '';
      card.dataset.searchText = `${bookmark.title || ''} ${bookmark.url || ''}`.toLocaleLowerCase();
      if (q && !card.dataset.searchText.includes(q)) card.style.display = 'none';
      const cardHeader = document.createElement('div');
      cardHeader.className = 'fb-card-header';
      const cardIcon = document.createElement('span');
      cardIcon.className = 'fb-card-icon';
      cardIcon.innerHTML = Icons.bookmark;
      const cardTitle = document.createElement('span');
      cardTitle.className = 'fb-card-title';
      cardTitle.textContent = bookmark.title || bookmark.url || 'Bookmark';
      cardHeader.appendChild(cardIcon);
      cardHeader.appendChild(cardTitle);
      const cardUrl = document.createElement('span');
      cardUrl.className = 'fb-card-url';
      cardUrl.textContent = bookmark.url || '';
      const moveLabel = document.createElement('label');
      moveLabel.className = 'fb-bookmark-move-label';
      moveLabel.textContent = 'Group';
      const moveSelect = document.createElement('select');
      moveSelect.className = 'fb-bookmark-move-select fb-in-bm-move';
      moveSelect.dataset.id = bookmark.id || '';
      moveSelect.setAttribute('aria-label', `Move ${bookmark.title || bookmark.url || 'bookmark'} to group`);
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        option.selected = group.id === (bookmark.groupId || DEFAULT_BOOKMARK_GROUP_ID);
        moveSelect.appendChild(option);
      }
      moveLabel.appendChild(moveSelect);
      moveSelect.addEventListener('change', async (event) => {
        const targetGroupId = event.target.value;
        if (typeof this.bookmarksRepo?.moveBookmark !== 'function') return;
        const result = await this.bookmarksRepo.moveBookmark(bookmark.id || bookmark.url, targetGroupId);
        if (!result?.ok) {
          this.showTransientNotice('Could not move that bookmark.');
          return;
        }
        await this.refreshBookmarksState();
        this.render();
      });
      const cardActions = document.createElement('div');
      cardActions.className = 'fb-card-actions';
      const openButton = document.createElement('button');
      openButton.className = 'fb-btn fb-btn-secondary fb-in-bm-open';
      openButton.type = 'button';
      openButton.textContent = 'Open';
      openButton.dataset.url = bookmark.url || '';
      openButton.addEventListener('click', () => {
        if (bookmark.url) this.navigateActiveTab(bookmark.url);
      });
      const removeButton = document.createElement('button');
      removeButton.className = 'fb-btn fb-btn-secondary fb-in-bm-del';
      removeButton.type = 'button';
      removeButton.title = 'Remove bookmark';
      removeButton.setAttribute('aria-label', `Remove ${bookmark.title || bookmark.url || 'bookmark'}`);
      removeButton.innerHTML = Icons.trash;
      removeButton.dataset.url = bookmark.url || '';
      removeButton.addEventListener('click', async () => {
        if (typeof this.bookmarksRepo?.removeBookmarkByUrl === 'function') {
          await this.bookmarksRepo.removeBookmarkByUrl(bookmark.url);
        } else if (typeof this.bookmarksRepo?.removeBookmark === 'function') {
          await this.bookmarksRepo.removeBookmark(bookmark.url);
        }
        await this.refreshBookmarksState();
        this.render();
      });
      cardActions.appendChild(openButton);
      cardActions.appendChild(removeButton);
      card.appendChild(cardHeader);
      card.appendChild(cardUrl);
      card.appendChild(moveLabel);
      card.appendChild(cardActions);
      grid.appendChild(card);
    }
    container.appendChild(grid);
    page.appendChild(container);

    searchInput.addEventListener('input', (event) => {
      const value = String(event.target?.value || '');
      const query = value.toLocaleLowerCase().trim();
      this.state.bookmarksSearchQuery = value;
      let visibleCount = 0;
      for (const card of grid.querySelectorAll('.fb-library-card')) {
        const matches = !query || String(card.dataset.searchText || '').includes(query);
        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount += 1;
      }
      emptyState.textContent = query
        ? 'No bookmarks match that search in this group.'
        : 'No bookmarks in this group yet. Star a page or use Add Bookmark to save one here.';
      emptyState.style.display = visibleCount ? 'none' : '';
    });
    addButton.addEventListener('click', async () => {
      if (!this.bookmarksRepo) return;
      const url = await this._textPromptDialog({
        title: 'Add bookmark',
        description: `Save a page to ${groups.find((group) => group.id === activeGroupId)?.name || 'this group'}.`,
        placeholder: 'https://example.com',
        initialValue: 'https://'
      });
      if (url === null || !String(url).trim()) return;
      const title = await this._textPromptDialog({
        title: 'Name this bookmark',
        description: 'Leave the title blank to use the page address.',
        placeholder: 'Bookmark title',
        initialValue: String(url).trim()
      });
      if (title === null) return;
      await this.bookmarksRepo.addBookmark({ url: String(url).trim(), title, groupId: activeGroupId });
      await this.refreshBookmarksState();
      this.render();
    });
    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 5. DOWNLOADS IN-TAB PAGE (PHASE 13 & REQ 11)
   * ----------------------------------------------------------- */
  renderInternalDownloadsPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-downloads-inpage-layout';

    const items = this.state.downloadsItems || [];
    const viewMode = this.state.downloadsViewMode || 'list';
    const hasRealBridge = Boolean(this.downloadsBridge);
    const root = this.state.downloadRoot;

    const actionButtons = (dl) => `
      <button class="fb-in-dl-location-btn" data-id="${dl.id}" title="Show in folder" ${hasRealBridge ? '' : 'disabled'}>${Icons.folder} Show in Folder</button>
      <button class="fb-btn fb-btn-secondary fb-in-dl-open" data-id="${dl.id}" ${hasRealBridge ? '' : 'disabled'}>Open</button>
      <button class="fb-btn fb-btn-secondary fb-in-dl-del" data-id="${dl.id}">${Icons.close}</button>
    `;

    page.innerHTML = `
      <div class="fb-internal-container">
        <header class="fb-internal-header">
          <div class="fb-internal-title-group">
            <span class="fb-internal-icon">${Icons.download}</span>
            <h1 class="fb-internal-title">Downloads</h1>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <!-- Requirement 11: View Mode Toggle -->
            <div class="fb-downloads-view-toggle">
              <button class="fb-dl-view-btn ${viewMode === 'list' ? 'active' : ''}" data-view="list" title="List View">${Icons.listView} List</button>
              <button class="fb-dl-view-btn ${viewMode === 'card' ? 'active' : ''}" data-view="card" title="Card View">${Icons.cardView} Cards</button>
            </div>
            <button class="fb-btn fb-btn-secondary fb-in-clear-dl-btn">Clear Downloads</button>
          </div>
        </header>

        <div class="fb-settings-group-card" style="margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div>
            <strong style="display:block; font-size:0.85rem;">Save files to</strong>
            <span style="font-size:0.78rem; color:var(--fb-text-muted);">${hasRealBridge ? (root || 'Default Downloads folder') : 'Choosing a custom folder requires the Yayra desktop app'}</span>
          </div>
          <button class="fb-btn fb-btn-secondary fb-in-dl-choose-root" ${hasRealBridge ? '' : 'disabled'}>Change…</button>
        </div>

        ${viewMode === 'list' ? `
          <!-- List View -->
          <div class="fb-downloads-list-layout" style="display:flex; flex-direction:column; gap:8px;">
            ${items.length > 0 ? items.map((dl) => `
              <div class="fb-download-item-row" data-dl-id="${dl.id}" style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:10px;">
                <div style="display:flex; align-items:center; gap:12px;">
                  <span style="color:var(--fb-accent-primary);">${Icons.download}</span>
                  <div>
                    <strong style="display:block; font-size:0.9rem;">${dl.filename}</strong>
                    <span style="font-size:0.75rem; color:var(--fb-text-muted);">${dl.size} • ${dl.state}${dl.progress != null && dl.state === 'Downloading' ? ` (${dl.progress}%)` : ''} • ${dl.date || 'Today'}</span>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  ${actionButtons(dl)}
                </div>
              </div>
            `).join('') : `<div class="fb-empty-state">No downloads yet${hasRealBridge ? '' : ' (download tracking requires the Yayra desktop app)'}.</div>`}
          </div>
        ` : `
          <!-- Card Grid View -->
          <div class="fb-downloads-grid-layout">
            ${items.length > 0 ? items.map((dl) => `
              <div class="fb-library-card">
                <div class="fb-card-header">
                  <span class="fb-card-icon">${Icons.download}</span>
                  <span class="fb-card-title">${dl.filename}</span>
                </div>
                <span class="fb-card-meta">${dl.size} • ${dl.state}</span>
                <div class="fb-card-actions" style="margin-top:12px;">
                  ${actionButtons(dl)}
                </div>
              </div>
            `).join('') : `<div class="fb-empty-state">No downloads yet${hasRealBridge ? '' : ' (download tracking requires the Yayra desktop app)'}.</div>`}
          </div>
        `}
      </div>
    `;

    // View mode toggle listeners
    page.querySelectorAll('.fb-dl-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.downloadsViewMode = btn.dataset.view;
        this.render();
      });
    });

    page.querySelector('.fb-in-clear-dl-btn')?.addEventListener('click', async () => {
      if (this.downloadsBridge) {
        const result = await this.downloadsBridge.clear();
        this.state.downloadsItems = result?.items || [];
      } else {
        this.state.downloadsItems = [];
      }
      this.render();
    });

    page.querySelector('.fb-in-dl-choose-root')?.addEventListener('click', async () => {
      if (!this.downloadsBridge) return;
      const result = await this.downloadsBridge.chooseRoot();
      if (result?.ok) {
        this.state.downloadRoot = result.root;
        this.render();
      }
    });

    // Requirement 11: Visit Location Button - now a real OS "reveal in file
    // manager" call (electron shell.showItemInFolder) instead of a
    // clipboard+alert placeholder.
    // RIGHT-CLICK anywhere on a download row (list view): the same
    // per-download menu as the toolbar dropdown ("Open in Yayra"...).
    page.querySelectorAll('[data-dl-id]').forEach((row) => {
      const rowId = (row.dataset && row.dataset.dlId) || row.getAttribute?.('data-dl-id');
      const item = (this.state.downloadsItems || []).find((it) => it.id === rowId);
      if (!item) return;
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showDownloadsContextMenu(e, item);
      });
    });

    page.querySelectorAll('.fb-in-dl-location-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!this.downloadsBridge) return;
        await this.downloadsBridge.showInFolder(btn.dataset.id);
      });
    });

    page.querySelectorAll('.fb-in-dl-open').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!this.downloadsBridge) return;
        await this.downloadsBridge.open(btn.dataset.id);
      });
    });

    page.querySelectorAll('.fb-in-dl-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (this.downloadsBridge) {
          const result = await this.downloadsBridge.remove(id);
          this.state.downloadsItems = result?.items || [];
        } else {
          this.state.downloadsItems = this.state.downloadsItems.filter((d) => d.id !== id);
        }
        this.render();
      });
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 6. PASSWORDS IN-TAB PAGE (PHASE 14)
   * ----------------------------------------------------------- */
  renderInternalPasswordsPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-passwords-inpage-layout';

    const section = this.state.passwordsActiveSection === 'keys' ? 'keys' : 'passwords';
    const q = (this.state.passwordsSearchQuery || '').toLowerCase().trim();
    const match = (p) => !q
      || (p.origin && p.origin.toLowerCase().includes(q))
      || (p.username && p.username.toLowerCase().includes(q))
      || (p.title && p.title.toLowerCase().includes(q));
    const items = (section === 'keys' ? this.state.vaultKeysItems : this.state.passwordsItems).filter(match);
    const config = this.state.passwordsConfig || { savePasswordsEnabled: true, autofillEnabled: true, requirePasskeyToReveal: false, neverSaveOrigins: [] };
    const rememberedEmails = (Array.isArray(this.state.rememberedEmails) ? this.state.rememberedEmails : [])
      .map((item) => typeof item === 'string' ? { email: item, id: item } : item)
      .filter((item) => item && typeof item.email === 'string');
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const passkey = this.state.passkeyInfo;
    const passkeySupported = Boolean(this.passkeyService && this.passkeyService.isSupported());

    const hostOf = (origin) => String(origin || '').replace(/^https?:\/\//, '');
    const rowHtml = (p) => section === 'keys' ? `
      <div class="fb-password-row fb-pwd-row fb-key-row" data-id="${p.id}">
        <div class="fb-password-meta">
          <strong class="fb-password-origin">${p.title || p.origin}</strong>
          <span class="fb-password-user">${p.username}</span>
        </div>
        <div class="fb-password-actions">
          <span class="fb-pwd-masked" data-pwd="${escapeAttr(p.password || '')}">••••••••</span>
          <button class="fb-pwd-action fb-pwd-reveal-btn fb-in-pwd-reveal" title="Reveal secret">&#128065;</button>
          <button class="fb-pwd-action fb-in-pwd-copy" data-copy="${escapeAttr(p.password || '')}" title="Copy secret">&#10697;</button>
          <button class="fb-pwd-action fb-pwd-delete-btn fb-in-pwd-delete" data-id="${p.id}" title="Delete">${Icons.trash}</button>
        </div>
      </div>` : `
      <div class="fb-password-row fb-pwd-row" data-id="${p.id}">
        <img class="fb-password-favicon" src="https://icons.duckduckgo.com/ip3/${hostOf(p.origin).split('/')[0]}.ico" alt="" loading="lazy" />
        <div class="fb-password-meta">
          <strong class="fb-password-origin">${hostOf(p.origin)}</strong>
          <span class="fb-password-user">${p.username}</span>
        </div>
        <div class="fb-password-actions">
          <span class="fb-pwd-masked" data-pwd="${escapeAttr(p.password || '')}">••••••••</span>
          <button class="fb-pwd-action fb-pwd-reveal-btn fb-in-pwd-reveal" title="Reveal password">&#128065;</button>
          <button class="fb-pwd-action fb-in-pwd-copy" data-copy="${escapeAttr(p.password || '')}" title="Copy password">&#10697;</button>
          <button class="fb-pwd-action fb-pwd-delete-btn fb-in-pwd-delete" data-id="${p.id}" title="Delete">${Icons.trash}</button>
        </div>
      </div>`;

    page.innerHTML = `
      <div class="fb-internal-container">
        <header class="fb-internal-header">
          <div class="fb-internal-title-group">
            <span class="fb-internal-icon">${Icons.lock}</span>
            <h1 class="fb-internal-title">Passwords &amp; Keys</h1>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <div class="fb-internal-search">
              <span class="fb-internal-search-icon">${Icons.search}</span>
              <input type="text" id="fb-in-pwd-search" placeholder="Search vault" value="${this.state.passwordsSearchQuery || ''}" />
            </div>
            <button class="fb-btn fb-btn-primary fb-in-add-pwd-btn">${Icons.plus} ${section === 'keys' ? 'Add Key' : 'Add Password'}</button>
          </div>
        </header>

        <div class="fb-vault-section-tabs" role="tablist">
          <button class="fb-vault-tab ${section === 'passwords' ? 'active' : ''}" data-section="passwords" role="tab" aria-selected="${section === 'passwords'}">
            ${Icons.lock} Passwords <span class="fb-vault-count">${this.state.passwordsItems.length}</span>
          </button>
          <button class="fb-vault-tab ${section === 'keys' ? 'active' : ''}" data-section="keys" role="tab" aria-selected="${section === 'keys'}">
            ${Icons.shield} Keys &amp; Tokens <span class="fb-vault-count">${this.state.vaultKeysItems.length}</span>
          </button>
        </div>

        <div class="fb-settings-group-card fb-vault-security-card" style="margin-bottom:12px;">
          <h3 class="fb-settings-group-title">${Icons.shield} Account Passkey</h3>
          <p style="margin:0; font-size:0.82rem; color:var(--fb-text-secondary);">
            ${passkey
              ? `Passkey active for <strong>${passkey.accountLabel || 'this device'}</strong> since ${new Date(passkey.createdAt).toLocaleDateString()}. ${passkey.method
                  ? (passkey.method === 'touch-id'
                    ? 'Touch ID and your Mac\u2019s Keychain protect this vault.'
                    : passkey.method === 'pin'
                      ? 'Your 6-digit PIN protects this vault (stored only as a salted scrypt hash; 5 wrong tries locks PIN entry for a minute).'
                      : 'Your OS keychain (this device, this OS user) protects this vault.')
                  : 'Your device\u2019s biometrics/PIN protect this vault.'}`
              : passkeySupported
                ? (this.passkeysBridge
                  ? 'Protect your Yayra account and vault with a device passkey. No fingerprint, Face ID or security key on this device? Fall back to a 6-digit PIN, your PC\u2019s system lock, or approve from your phone by scanning a QR code.'
                  : 'Protect your Yayra account and vault with your device\u2019s biometrics or PIN. Works like Windows Hello / Touch ID in Chrome.')
                : 'Passkeys need a secure (HTTPS) context and a device authenticator; this build/runtime does not expose one.'}
            ${this.state.passkeyDeviceStatus?.weakEncryption
              ? ' <span style="color:#fcd34d;">Note: no OS keyring service (gnome-keyring/KWallet) was detected on this Linux system, so the secret uses Electron\u2019s fallback encryption instead of being bound to your OS login - enable a keyring for full protection.</span>'
              : ''}
          </p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${passkey
              ? `<button class="fb-btn fb-btn-secondary fb-vault-passkey-verify">Verify now</button>
                 ${this.passkeyService?.supportsPhoneApproval ? '<button class="fb-btn fb-btn-secondary fb-vault-passkey-phone">Approve from phone (QR)</button>' : ''}
                 <button class="fb-btn fb-btn-secondary fb-vault-passkey-remove">Remove passkey</button>`
              : `<button class="fb-btn fb-btn-primary fb-vault-passkey-create" ${passkeySupported ? '' : 'disabled'}>Create passkey</button>`}
          </div>
          <div class="fb-setting-toggle-row">
            <div>
              <strong>Require passkey to reveal secrets</strong>
              <p>Ask for biometrics/PIN before showing or copying any stored password or key (5-minute unlock).</p>
            </div>
            <input type="checkbox" id="fb-in-toggle-passkey-gate" ${config.requirePasskeyToReveal ? 'checked' : ''} ${passkey ? '' : 'disabled'} />
          </div>
        </div>

        <div class="fb-settings-group-card" style="margin-bottom:12px;">
          <div class="fb-setting-toggle-row">
            <div>
              <strong>Offer to save passwords</strong>
              <p>Chrome-style prompt whenever you sign in to a site with new credentials</p>
            </div>
            <input type="checkbox" id="fb-in-toggle-savepwd" ${config.savePasswordsEnabled ? 'checked' : ''} />
          </div>
          <div class="fb-setting-toggle-row">
            <div>
              <strong>Auto Sign-in / Autofill</strong>
              <p>Fills saved usernames and passwords automatically on matching sites</p>
            </div>
            <input type="checkbox" id="fb-in-toggle-autofill" ${config.autofillEnabled ? 'checked' : ''} />
          </div>
          ${config.neverSaveOrigins.length > 0 ? `
            <div class="fb-vault-never-list">
              <strong style="font-size:0.8rem;">Never saved for:</strong>
              ${config.neverSaveOrigins.map((o) => `
                <span class="fb-vault-never-chip">${hostOf(o)}
                  <button class="fb-vault-never-remove" data-origin="${escapeAttr(o)}" title="Allow saving again">${Icons.close}</button>
                </span>`).join('')}
            </div>` : ''}
        </div>

        ${section === 'passwords' ? `
          <div class="fb-settings-group-card fb-saved-emails-card" style="margin-bottom:12px;">
            <div class="fb-saved-emails-header">
              <div>
                <strong>Remembered email addresses</strong>
                <p>Saved locally to this profile after you submit a form. Incognito tabs never save or suggest addresses. Focus an email field on a desktop webpage to choose one.</p>
              </div>
              <button type="button" class="fb-btn fb-btn-secondary fb-in-email-clear" ${rememberedEmails.length ? '' : 'disabled'}>Clear all</button>
            </div>
            <div class="fb-saved-email-list">
              ${rememberedEmails.length
                ? rememberedEmails.map((item) => `
                  <div class="fb-saved-email-row">
                    <span>${escapeText(item.email)}</span>
                    <button type="button" class="fb-btn fb-btn-secondary fb-in-email-remove" data-email-id="${escapeAttr(item.id || item.email)}" data-email="${escapeAttr(item.email)}" aria-label="Remove ${escapeAttr(item.email)}">Remove</button>
                  </div>`).join('')
                : '<div class="fb-empty-state">No saved email addresses yet. Use an email on a submitted form and Yayra will remember it for this profile.</div>'}
            </div>
          </div>` : ''}

        <form class="fb-vault-add-form" id="fb-vault-add-form" style="display:none;">
          ${section === 'keys' ? `
            <input type="text" id="fb-vault-add-label" class="fb-input" placeholder="Label (e.g. OpenAI API key)" />
            <input type="text" id="fb-vault-add-user" class="fb-input" placeholder="Key name / account (optional)" />
            <input type="password" id="fb-vault-add-secret" class="fb-input" placeholder="Secret value" />
          ` : `
            <input type="text" id="fb-vault-add-label" class="fb-input" placeholder="Website (e.g. https://github.com)" />
            <input type="text" id="fb-vault-add-user" class="fb-input" placeholder="Username / email" />
            <input type="password" id="fb-vault-add-secret" class="fb-input" placeholder="Password" />
          `}
          <button type="submit" class="fb-btn fb-btn-primary">Save</button>
        </form>

        <div class="fb-vault-rows" style="display:flex; flex-direction:column; gap:10px;">
          ${items.length > 0
            ? items.map(rowHtml).join('')
            : `<div class="fb-empty-state">${section === 'keys'
                ? 'No keys or tokens yet. Store API keys, recovery codes and tokens in the same encrypted vault.'
                : 'No saved passwords yet. Sign in to any site and Yayra will offer to remember it.'}</div>`}
        </div>
      </div>
    `;

    const searchInput = page.querySelector('#fb-in-pwd-search');
    searchInput?.addEventListener('input', (e) => {
      this.state.passwordsSearchQuery = e.target.value;
      this.render();
    });

    page.querySelectorAll('.fb-vault-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.state.passwordsActiveSection = tab.dataset.section;
        this.render();
      });
    });

    page.querySelector('#fb-in-toggle-savepwd')?.addEventListener('change', async (e) => {
      this.state.settings.savePasswordsEnabled = e.target.checked;
      if (this.passwordManager) {
        await this.passwordManager.updateConfig({ savePasswordsEnabled: e.target.checked });
        await this.refreshVaultState();
      }
    });

    page.querySelector('#fb-in-toggle-autofill')?.addEventListener('change', async (e) => {
      this.state.settings.autofillEnabled = e.target.checked;
      if (this.passwordManager) {
        await this.passwordManager.updateConfig({ autofillEnabled: e.target.checked });
        await this.refreshVaultState();
      }
    });

    page.querySelector('#fb-in-toggle-passkey-gate')?.addEventListener('change', async (e) => {
      if (this.passwordManager) {
        await this.passwordManager.updateConfig({ requirePasskeyToReveal: e.target.checked });
        await this.refreshVaultState();
        this.render();
      }
    });

    page.querySelector('.fb-vault-passkey-create')?.addEventListener('click', () => this.registerAccountPasskey());
    page.querySelector('.fb-vault-passkey-verify')?.addEventListener('click', () => this.verifyAccountPasskey());
    page.querySelector('.fb-vault-passkey-phone')?.addEventListener('click', () => this.verifyWithPhoneQr());
    page.querySelector('.fb-vault-passkey-remove')?.addEventListener('click', () => this.removeAccountPasskey());

    page.querySelectorAll('.fb-vault-never-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (this.passwordManager && typeof this.passwordManager.removeNeverSaveOrigin === 'function') {
          await this.passwordManager.removeNeverSaveOrigin(btn.dataset.origin);
          await this.refreshVaultState();
          this.render();
        }
      });
    });

    page.querySelectorAll('.fb-in-email-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!this.emailAddressesRepo || typeof this.emailAddressesRepo.removeEmail !== 'function') return;
        const target = btn.dataset.emailId || btn.dataset.email;
        await this.emailAddressesRepo.removeEmail(target);
        await this.refreshEmailAddressesState();
        await this.pushEmailSuggestionsToOpenTabs();
        this.render();
      });
    });
    page.querySelector('.fb-in-email-clear')?.addEventListener('click', async () => {
      if (!this.emailAddressesRepo || typeof this.emailAddressesRepo.clear !== 'function') return;
      await this.emailAddressesRepo.clear();
      await this.refreshEmailAddressesState();
      await this.pushEmailSuggestionsToOpenTabs();
      this.render();
      this.showTransientNotice('Saved email addresses cleared for this profile.');
    });

    // Inline add form (replaces the old triple prompt() flow).
    const addForm = page.querySelector('#fb-vault-add-form');
    page.querySelector('.fb-in-add-pwd-btn')?.addEventListener('click', () => {
      if (!addForm) return;
      addForm.style.display = addForm.style.display === 'none' ? 'flex' : 'none';
      addForm.querySelector('#fb-vault-add-label')?.focus();
    });
    addForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = addForm.querySelector('#fb-vault-add-label')?.value.trim();
      const user = addForm.querySelector('#fb-vault-add-user')?.value.trim();
      const secret = addForm.querySelector('#fb-vault-add-secret')?.value;
      if (!label || !secret || !this.passwordManager) return;
      if (section === 'keys') {
        await this.passwordManager.saveKey({ label, keyName: user || label, secret });
      } else {
        await this.passwordManager.saveCredential({ origin: label, username: user || '', password: secret, title: label });
      }
      await this.refreshVaultState();
      this.render();
    });

    // Reveal: synchronous when no passkey gate applies; otherwise verify
    // via the OS ceremony first (one unlock covers 5 minutes).
    const gateNeeded = () => Boolean(config.requirePasskeyToReveal && passkey
      && (Date.now() - this._vaultUnlockedAt >= 5 * 60 * 1000));
    page.querySelectorAll('.fb-in-pwd-reveal').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.fb-password-row');
        const masked = row?.querySelector('.fb-pwd-masked');
        if (!masked) return;
        const doToggle = () => {
          const rawPwd = masked.getAttribute('data-pwd') || '';
          masked.textContent = masked.textContent === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' ? rawPwd : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
        };
        if (!gateNeeded()) { doToggle(); return; }
        this.unlockVaultIfNeeded().then((ok) => { if (ok) doToggle(); });
      });
    });

    page.querySelectorAll('.fb-in-pwd-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const doCopy = () => {
          const value = btn.getAttribute('data-copy') || '';
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(value);
              this.showTransientNotice('Copied to clipboard');
            }
          } catch { /* clipboard unavailable */ }
        };
        if (!gateNeeded()) { doCopy(); return; }
        this.unlockVaultIfNeeded().then((ok) => { if (ok) doCopy(); });
      });
    });

    page.querySelectorAll('.fb-in-pwd-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (this.passwordManager && id) {
          await this.passwordManager.deleteCredential(id);
          await this.refreshVaultState();
          this.render();
        }
      });
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 7. EXTENSIONS IN-TAB PAGE (PHASE 15)
   * ----------------------------------------------------------- */
  renderInternalExtensionsPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-extensions-inpage-layout';

    page.innerHTML = `
      <div class="fb-internal-container">
        <header class="fb-internal-header">
          <div class="fb-internal-title-group">
            <span class="fb-internal-icon">${Icons.shield}</span>
            <h1 class="fb-internal-title">Extensions & Shields</h1>
          </div>
        </header>

        <section class="fb-extension-platform-notice">
          <div class="fb-extension-platform-notice-copy">
            <strong>Real website extension companion</strong>
            <p>The PWA can manage these preferences, but browser security prevents a website from injecting into arbitrary cross-origin pages. Install the companion extension to block real tracker requests and apply Dark Reader or Reader Mode on external websites.</p>
          </div>
          <a class="fb-btn fb-btn-primary" href="https://github.com/g2code33/yayra/tree/main/extensions/yayra-companion" target="_blank" rel="noopener">Open companion project</a>
        </section>

        <div class="fb-extensions-list">
          ${this.state.extensionsItems.map((ext) => `
            <div class="fb-extension-row fb-extension-card ${ext.enabled ? 'enabled' : ''}" data-ext-id="${ext.id}">
              <div class="fb-ext-header">
                <span class="fb-ext-icon">${Icons[ext.icon] || Icons.globe}</span>
                <div class="fb-ext-title-col">
                  <strong>${ext.name} <span class="fb-badge fb-badge-cyan">v${ext.version}</span></strong>
                  <span class="fb-ext-author">By ${ext.author}</span>
                </div>
                <label class="fb-toggle-switch">
                  <input type="checkbox" class="fb-ext-toggle fb-ext-toggle-input" data-id="${ext.id}" ${ext.enabled ? 'checked' : ''} />
                  <span class="fb-toggle-slider"></span>
                </label>
              </div>
              <p class="fb-ext-desc">${ext.description}</p>
              <div class="fb-ext-footer">
                <label class="fb-ext-private-toggle">
                  <input type="checkbox" class="fb-ext-private-check" data-id="${ext.id}" ${ext.allowedInPrivate ? 'checked' : ''} />
                  <span>Allow in Incognito</span>
                </label>
                <span class="fb-ext-perms">Permissions: ${ext.permissions.join(', ')}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    page.querySelectorAll('.fb-ext-toggle').forEach((chk) => {
      chk.addEventListener('change', async () => {
        const id = chk.dataset.id;
        if (this.extensionManager) {
          if (chk.checked) await this.extensionManager.enableExtension(id);
          else await this.extensionManager.disableExtension(id);
          this.state.extensionsItems = await this.extensionManager.getExtensions();
          this.render();
        }
      });
    });

    page.querySelectorAll('.fb-ext-private-check').forEach((chk) => {
      chk.addEventListener('change', async () => {
        const id = chk.dataset.id;
        if (this.extensionManager) {
          await this.extensionManager.setAllowedInPrivate(id, chk.checked);
          this.state.extensionsItems = await this.extensionManager.getExtensions();
        }
      });
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 8. SITE PERMISSIONS IN-TAB PAGE
   * ----------------------------------------------------------- */
  renderInternalPermissionsPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page';

    page.innerHTML = `
      <div class="fb-internal-container">
        <header class="fb-internal-header">
          <div class="fb-internal-title-group">
            <span class="fb-internal-icon">${Icons.lock}</span>
            <h1 class="fb-internal-title">Site Permissions</h1>
          </div>
        </header>

        <div class="fb-settings-group-card">
          <div class="fb-setting-row">
            <div><strong>Location</strong><p>Ask before accessing device geolocation</p></div>
            <select class="fb-select"><option>Ask (Default)</option><option>Block</option><option>Allow</option></select>
          </div>
          <div class="fb-setting-row">
            <div><strong>Camera</strong><p>Ask before accessing camera</p></div>
            <select class="fb-select"><option>Ask (Default)</option><option>Block</option><option>Allow</option></select>
          </div>
          <div class="fb-setting-row">
            <div><strong>Microphone</strong><p>Ask before accessing microphone</p></div>
            <select class="fb-select"><option>Ask (Default)</option><option>Block</option><option>Allow</option></select>
          </div>
          <div class="fb-setting-row">
            <div><strong>Notifications</strong><p>Ask before sending desktop notifications</p></div>
            <select class="fb-select"><option>Ask (Default)</option><option>Block</option><option>Allow</option></select>
          </div>
        </div>
      </div>
    `;

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * 9. ABOUT IN-TAB PAGE (PHASE 16)
   * ----------------------------------------------------------- */
  /* -------------------------------------------------------------
   * YAYRA AI - yayra://ai (Chrome-style "AI options on every search")
   * -----------------------------------------------------------
   * The in-tab AI page: a conversation with Yayra AI, reachable from the
   * omnibox "Ask Yayra AI" suggestion row, the new-tab chip, and directly
   * via yayra://ai. Opening yayra://ai?q=<query> asks the query
   * immediately (that is how omnibox searches hand over to AI).
   * Providers live in services/aiService.js - no provider, no fake
   * answers: the page says exactly what to configure instead.
   * ----------------------------------------------------------- */

  /* --------- ChatGPT-style chats: saved, listed, resumable --------- */

  // Direct localStorage (profile-independent), guarded for test shims.
  _aiChatsStore() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch { return null; }
  }

  static AI_CHATS_KEY = 'yayra:ai-chats';
  static AI_CHATS_CAP = 50; // most recent chats kept
  static AI_CHAT_MESSAGES_CAP = 200; // per chat, oldest pairs trimmed

  _loadAiChats() {
    const store = this._aiChatsStore();
    if (!store) return;
    try {
      const raw = JSON.parse(store.getItem(BrowserShell.AI_CHATS_KEY) || '[]');
      if (!Array.isArray(raw)) return;
      const now = Date.now();
      const chats = raw
        .filter((c) => c && typeof c === 'object' && Array.isArray(c.messages))
        .map((c) => ({
          id: String(c.id || `chat-${Math.random().toString(36).slice(2, 10)}`),
          title: String(c.title || 'New chat').slice(0, 120),
          createdAt: Number(c.createdAt) || now,
          updatedAt: Number(c.updatedAt) || Number(c.createdAt) || now,
          messages: c.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({ ...m, streaming: false })) // streaming never persists
        }))
        .filter((c) => c.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, BrowserShell.AI_CHATS_CAP);
      this.state.aiChats = chats;
      // ChatGPT opens on a FRESH chat; saved chats wait in the sidebar.
      this.state.aiActiveChatId = null;
      this.state.aiConversation = [];
    } catch { /* corrupted store - start clean, never crash */ }
  }

  _persistAiChats() {
    const store = this._aiChatsStore();
    if (!store) return;
    try {
      const chats = this.state.aiChats
        .filter((c) => c.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, BrowserShell.AI_CHATS_CAP)
        .map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messages: c.messages
            .slice(-BrowserShell.AI_CHAT_MESSAGES_CAP)
            .map(({ streaming, ...rest }) => rest) // transient flag never persists
        }));
      store.setItem(BrowserShell.AI_CHATS_KEY, JSON.stringify(chats));
    } catch { /* quota/serialization - chats stay alive in memory */ }
  }

  deriveAiChatTitle(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    if (clean.length <= 48) return clean;
    const cut = clean.slice(0, 48);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}\u2026`;
  }

  formatAiChatTime(ts) {
    const age = Date.now() - (Number(ts) || Date.now());
    if (age < 60 * 1000) return 'now';
    if (age < 60 * 60 * 1000) return `${Math.floor(age / 60000)}m`;
    if (age < 24 * 60 * 60 * 1000) return `${Math.floor(age / 3600000)}h`;
    if (age < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(age / 86400000)}d`;
    const d = new Date(Number(ts) || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _aiChatById(id) {
    return this.state.aiChats.find((c) => c.id === id) || null;
  }

  get activeAiChat() {
    return this._aiChatById(this.state.aiActiveChatId);
  }

  /** Fresh empty chat (ChatGPT "New chat"): the composer starts clean. */
  startNewAiChat() {
    if (this.state.aiBusy) {
      this.showTransientNotice?.('Wait for the current answer to finish first.');
      return;
    }
    this.state.aiActiveChatId = null;
    this.state.aiConversation = [];
    this.render();
  }

  /** Resume a saved chat: its messages become the live conversation. */
  openAiChat(id) {
    if (this.state.aiBusy) {
      this.showTransientNotice?.('Wait for the current answer to finish first.');
      return;
    }
    const chat = this._aiChatById(id);
    if (!chat) return;
    this.state.aiActiveChatId = chat.id;
    // SAME array reference: streaming/painting operate on the chat directly.
    this.state.aiConversation = chat.messages;
    this.render();
  }

  deleteAiChat(id) {
    const chat = this._aiChatById(id);
    if (!chat) return;
    if (this.state.aiBusy && id === this.state.aiActiveChatId) {
      this.showTransientNotice?.('Wait for the current answer to finish first.');
      return;
    }
    this.state.aiChats = this.state.aiChats.filter((c) => c.id !== id);
    if (this.state.aiActiveChatId === id) {
      this.state.aiActiveChatId = null;
      this.state.aiConversation = [];
    }
    this._persistAiChats();
    this.render();
  }

  async renameAiChat(id) {
    const chat = this._aiChatById(id);
    if (!chat || typeof this._textPromptDialog !== 'function') return;
    const name = await this._textPromptDialog({
      title: 'Rename chat',
      placeholder: 'Chat name',
      initialValue: chat.title
    });
    const clean = String(name || '').trim();
    if (!clean) return;
    chat.title = clean.slice(0, 120);
    this._persistAiChats();
    this.render();
  }

  /** Open the AI page, optionally pre-asking `query` (omnibox handoff). */
  openAiPage(query) {
    const q = String(query || '').trim();
    this.openInternalPage(q ? `yayra://ai?q=${encodeURIComponent(q)}` : 'yayra://ai');
  }

  /** The ?q= from a yayra://ai URL, or ''. */
  getAiQueryFromUrl(url) {
    const match = /^yayra:\/\/ai\?(.*)$/.exec(String(url || ''));
    if (!match) return '';
    try {
      return (new URLSearchParams(match[1]).get('q') || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Ask Yayra AI and append both sides to the ACTIVE chat, creating it on
   * demand. With { newChat: true } (every search-engine handoff: omnibox
   * "Ask Yayra AI", new-tab chip, yayra://ai?q=...) the question starts a
   * brand-new chat instead of continuing the current one - ChatGPT-style.
   * Errors become honest assistant-side notices (never fake answers).
   */
  async askYayraAi(prompt, { newChat = false } = {}) {
    const text = String(prompt || '').trim();
    if (!text || !this.aiService || this.state.aiBusy) return;
    // Resolve the chat this question belongs to.
    let chat = newChat ? null : this.activeAiChat;
    if (!chat) {
      chat = {
        id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: this.deriveAiChatTitle(text),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      };
      this.state.aiChats.unshift(chat);
      this.state.aiActiveChatId = chat.id;
      // aiConversation IS the active chat's messages array - streaming,
      // painting and tests all mutate the chat directly.
      this.state.aiConversation = chat.messages;
    }
    const history = this.state.aiConversation
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    this.state.aiConversation.push({ role: 'user', content: text, at: Date.now() });
    chat.updatedAt = Date.now();
    this._persistAiChats();
    // STREAMING (CLINICAL-RX output system): a live assistant bubble is
    // appended immediately and each token is painted into it the moment it
    // arrives - no waiting for the whole completion. Tokens update the DOM
    // SURGICALLY (textContent on the live bubble), never via full render(),
    // so streaming stays smooth with zero flicker.
    const live = { role: 'assistant', content: '', thinking: '', streaming: true, at: Date.now() };
    this.state.aiConversation.push(live);
    this.state.aiBusy = true;
    this.render();
    // Arena-agent-style live transparency: everything the model does in the
    // background is SHOWN as it happens - the stage ("Connecting...",
    // "Thinking...", then the answer), the actual reasoning text streaming
    // into the open thinking panel, and a live token count. All painted
    // surgically (textContent), never via full render() - zero flicker.
    const last = (list) => (list && list.length ? list[list.length - 1] : null);
    const paintLiveAiBubble = () => {
      try {
        const body = last(this.container?.querySelectorAll?.('.fb-ai-msg-body'));
        if (body) {
          body.textContent = live.content
            || (live.thinking ? 'Thinking\u2026' : 'Connecting\u2026');
        }
        const thinkBody = last(this.container?.querySelectorAll?.('.fb-ai-think-body'));
        if (thinkBody) thinkBody.textContent = live.thinking || '';
        const toggle = last(this.container?.querySelectorAll?.('.fb-ai-think-toggle'));
        if (toggle) {
          toggle.textContent = live.thinking
            ? `Thinking live\u2026 (${Math.max(1, Math.round(live.thinking.length / 4))} tokens)`
            : 'Thinking live\u2026';
        }
        const thread = this.container?.querySelector?.('.fb-ai-thread');
        if (thread && typeof thread.scrollHeight === 'number') thread.scrollTop = thread.scrollHeight;
      } catch { /* painting is best-effort; state holds the truth */ }
    };
    let result;
    try {
      result = await this.aiService.ask(text, {
        history,
        onToken: (token) => {
          live.content += token;
          paintLiveAiBubble();
        },
        onThinking: (delta) => {
          live.thinking += String(delta);
          paintLiveAiBubble();
        }
      });
    } catch (err) {
      result = { success: false, reason: 'provider-error', detail: String(err?.message || err) };
    }
    this.state.aiBusy = false;
    live.streaming = false;
    if (result && result.success) {
      live.content = result.answer;
    } else {
      live.error = true;
      live.reason = result?.reason;
      live.content = describeAiReason(result?.reason);
    }
    chat.updatedAt = Date.now();
    this._persistAiChats();
    this.render();
  }

  renderInternalAiPage(viewport, activeTab) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-ai-page';
    const cfg = this.state.aiConfig || { ...AI_DEFAULTS };
    const ready = Boolean(cfg.enabled && (cfg.provider !== 'openai-compatible' || cfg.endpoint));
    const providerLabel = cfg.provider === 'openai-compatible'
      ? `your provider${cfg.model ? ` (${cfg.model})` : ''}`
      : 'Yayra\u2019s built-in AI';

    // Arena-agent-style transparency: assistant messages carry their live
    // reasoning stream (m.thinking). While streaming, the thinking panel is
    // OPEN and fills in real time - you watch the model work. Finished
    // messages keep the transcript behind a "Show thinking" toggle.
    const approxTokens = (s) => Math.max(1, Math.round(String(s || '').length / 4));
    const messagesHtml = this.state.aiConversation.map((m, i) => {
      const hasThink = m.role === 'assistant' && !m.error && (m.thinking || m.streaming);
      return `
      <div class="fb-ai-msg fb-ai-msg-${m.role}${m.error ? ' fb-ai-msg-error' : ''}">
        <span class="fb-ai-msg-avatar">${m.role === 'user' ? Icons.finderFace : Icons.sparkles}</span>
        <div class="fb-ai-msg-main">
          ${hasThink ? `
          <div class="fb-ai-think${m.streaming ? ' fb-ai-think-open' : ''}" data-i="${i}">
            <button type="button" class="fb-ai-think-toggle">${m.streaming ? 'Thinking live\u2026' : `Show thinking (${approxTokens(m.thinking)} tokens)`}</button>
            <div class="fb-ai-think-body"></div>
          </div>` : ''}
          <div class="fb-ai-msg-body"></div>
        </div>
      </div>`;
    }).join('');

    const activeChat = this.activeAiChat;
    const chatItemsHtml = this.state.aiChats.length ? this.state.aiChats.map((c) => `
              <div class="fb-ai-chat-item${c.id === this.state.aiActiveChatId ? ' fb-ai-chat-active' : ''}" data-chat-id="${c.id}" role="listitem">
                <span class="fb-ai-chat-title"></span>
                <span class="fb-ai-chat-time">${this.formatAiChatTime(c.updatedAt)}</span>
                <button type="button" class="fb-ai-chat-rename" data-chat-id="${c.id}" title="Rename chat">\u270E</button>
                <button type="button" class="fb-ai-chat-delete" data-chat-id="${c.id}" title="Delete chat">\u2715</button>
              </div>`).join('')
      : '<div class="fb-ai-chat-empty">No saved chats yet \u2014 every conversation you have is kept here.</div>';

    page.innerHTML = `
      <div class="fb-internal-container fb-ai-container fb-ai-chat-layout">
        <aside class="fb-ai-sidebar">
          <button type="button" class="fb-btn fb-btn-primary fb-ai-new-chat">+ New chat</button>
          <div class="fb-ai-chat-list" role="list">
            ${chatItemsHtml}
          </div>
        </aside>
        <div class="fb-ai-main">
          <div class="fb-internal-header fb-ai-header">
            <h1>${Icons.sparkles} <span class="fb-ai-heading-title">Yayra AI</span></h1>
            <div style="display:flex; gap:8px; align-items:center;">
              <span class="fb-ai-provider-chip" title="Active provider">${cfg.enabled ? providerLabel : 'AI is off'}</span>
              <button class="fb-btn fb-btn-secondary fb-ai-settings">AI settings</button>
            </div>
          </div>
          ${cfg.enabled ? '' : `
          <div class="fb-ai-setup-note">
            Yayra AI is turned off. Enable it in <strong>Settings &gt; Yayra AI</strong>.
          </div>`}
          ${cfg.enabled && !ready ? `
          <div class="fb-ai-setup-note">
            No AI provider is configured yet - add an OpenAI-compatible endpoint in <strong>Settings &gt; Yayra AI</strong>.
          </div>` : ''}
          <div class="fb-ai-thread" aria-live="polite">
            ${this.state.aiConversation.length ? messagesHtml : `
            <div class="fb-ai-empty">
              <div class="fb-ai-empty-icon">${Icons.sparkles}</div>
              <h2>Ask anything</h2>
              <p>Yayra AI answers questions right inside the browser - type below, or pick \u201cAsk Yayra AI\u201d on any search suggestion, Chrome-style. Every conversation is saved in the sidebar and can be continued later.</p>
            </div>`}
            ${this.state.aiBusy && !this.state.aiConversation.some((m) => m.streaming) ? `
            <div class="fb-ai-msg fb-ai-msg-assistant fb-ai-msg-busy">
              <span class="fb-ai-msg-avatar">${Icons.sparkles}</span>
              <div class="fb-ai-msg-body">Thinking&hellip;</div>
            </div>` : ''}
          </div>
          <form class="fb-ai-form">
            <input type="text" class="fb-input fb-ai-input" placeholder="Ask Yayra AI&hellip;" autocomplete="off" ${this.state.aiBusy ? 'disabled' : ''} />
            <button type="submit" class="fb-btn fb-btn-primary fb-ai-send" ${this.state.aiBusy ? 'disabled' : ''}>Ask</button>
          </form>
        </div>
      </div>
    `;

    // User-derived text (chat titles, heading) is injected via textContent -
    // never parsed as HTML.
    const headingTitle = page.querySelector('.fb-ai-heading-title');
    if (headingTitle && activeChat) headingTitle.textContent = activeChat.title;
    for (const item of Array.from(page.querySelectorAll('.fb-ai-chat-item'))) {
      const chat = this._aiChatById(item.dataset?.chatId);
      if (!chat) continue;
      const titleEl = item.querySelector('.fb-ai-chat-title');
      if (titleEl) titleEl.textContent = chat.title;
    }

    // Message text is injected via textContent - AI/user content must
    // never be parsed as HTML.
    const bodies = page.querySelectorAll('.fb-ai-msg-body');
    const thinkBodies = page.querySelectorAll('.fb-ai-think-body');
    let thinkIdx = 0;
    this.state.aiConversation.forEach((m, i) => {
      // A still-empty streaming bubble reads "Thinking..." until the first
      // token lands (tokens then paint into it surgically, see askYayraAi).
      if (bodies[i]) bodies[i].textContent = m.content || (m.streaming ? 'Thinking\u2026' : '');
      const hasThink = m.role === 'assistant' && !m.error && (m.thinking || m.streaming);
      if (hasThink) {
        if (thinkBodies[thinkIdx]) thinkBodies[thinkIdx].textContent = m.thinking || '';
        thinkIdx += 1;
      }
    });

    // "Show thinking" toggles (programmatic listeners - shell CSP forbids
    // inline handlers).
    const thinkToggles = page.querySelectorAll('.fb-ai-think-toggle');
    for (const btn of Array.from(thinkToggles || [])) {
      btn.addEventListener('click', () => {
        const wrap = btn.parentElement;
        if (!wrap) return;
        const open = wrap.classList.contains('fb-ai-think-open');
        wrap.classList.toggle('fb-ai-think-open', !open);
        const msg = this.state.aiConversation[Number(wrap.dataset?.i)] || {};
        if (!msg.streaming) {
          btn.textContent = `${open ? 'Show' : 'Hide'} thinking (${approxTokens(msg.thinking)} tokens)`;
        }
      });
    }

    page.querySelector('.fb-ai-new-chat')?.addEventListener('click', () => {
      this.startNewAiChat();
    });
    for (const item of Array.from(page.querySelectorAll('.fb-ai-chat-item'))) {
      item.addEventListener('click', () => {
        this.openAiChat(item.dataset?.chatId);
      });
    }
    for (const btn of Array.from(page.querySelectorAll('.fb-ai-chat-rename'))) {
      btn.addEventListener('click', (e) => {
        if (typeof e?.stopPropagation === 'function') e.stopPropagation();
        this.renameAiChat(btn.dataset?.chatId);
      });
    }
    for (const btn of Array.from(page.querySelectorAll('.fb-ai-chat-delete'))) {
      btn.addEventListener('click', (e) => {
        if (typeof e?.stopPropagation === 'function') e.stopPropagation();
        this.deleteAiChat(btn.dataset?.chatId);
      });
    }
    page.querySelector('.fb-ai-settings')?.addEventListener('click', () => {
      this.state.settingsActiveCategory = 'ai';
      this.state.activeSettingsCategory = 'ai';
      this.openInternalPage('yayra://settings');
    });
    const form = page.querySelector('.fb-ai-form');
    const input = page.querySelector('.fb-ai-input');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input?.value?.trim();
      if (!value) return;
      input.value = '';
      this.askYayraAi(value);
    });

    viewport.appendChild(page);

    // yayra://ai?q=... auto-asks exactly once per navigation (the omnibox
    // "Ask Yayra AI" handoff) - guarded so re-renders never re-ask. Every
    // SEARCH-ENGINE handoff starts a BRAND-NEW chat (ChatGPT-style), never
    // continues the currently open one.
    const query = this.getAiQueryFromUrl(activeTab?.url);
    if (query && activeTab) {
      const guard = `${activeTab.id}::${query}`;
      if (!this._aiAutoAsked) this._aiAutoAsked = new Set();
      if (!this._aiAutoAsked.has(guard)) {
        this._aiAutoAsked.add(guard);
        this.askYayraAi(query, { newChat: true });
      }
    }
  }

  renderInternalAboutPage(viewport) {
    const page = document.createElement('div');
    page.className = 'fb-internal-page fb-about-inpage-layout';

    page.innerHTML = `
      <div class="fb-internal-container">
        <div class="fb-about-hero">
          <div class="fb-about-logo">${Icons.officialOrb}</div>
          <div class="fb-about-appname" role="img" aria-label="yayra">${Icons.officialWordmark}</div>
          <span class="fb-about-version fb-about-version-badge">Version ${this.state.updateState.installedVersion || 'unknown'} (Stable 64-bit Release)</span>
          <p style="max-width:480px; color:var(--fb-text-secondary); font-size:0.9rem; margin:8px 0 16px;">
            Fast, private floating browser with native glassmorphism overlay and persistent assistive bubble.
          </p>
          <button class="fb-btn fb-btn-primary fb-in-check-update-btn fb-about-check-updates-btn">Check for updates</button>
        </div>

        <div class="fb-about-details-card">
          <div class="fb-about-row">
            <strong>Architecture</strong>
            <span>Local-First • No Mandatory Cloud Sync</span>
          </div>
          <div class="fb-about-row">
            <strong>Platform Engine</strong>
            <span>Cross-Platform Floating Engine (${this.platform})</span>
          </div>
          <div class="fb-about-row">
            <strong>Update Channel</strong>
            <span>Stable Production Release</span>
          </div>
          <div class="fb-about-row">
            <strong>License</strong>
            <span>MIT Open Source License</span>
          </div>
        </div>
      </div>
    `;

    page.querySelector('.fb-in-check-update-btn')?.addEventListener('click', async () => {
      const btn = page.querySelector('.fb-in-check-update-btn');
      if (btn) btn.textContent = 'Checking for updates...';
      if (this.updateService) {
        await this.updateService.check({ manual: true });
      }
      setTimeout(() => {
        if (btn) btn.textContent = 'Yayra is up to date (0.1.0)';
      }, 600);
    });

    viewport.appendChild(page);
  }

  /* -------------------------------------------------------------
   * REQUIREMENT 1, 3: RADIAL AI & ACTIONS LAUNCHER WHEEL
   * ----------------------------------------------------------- */
  openRadialLauncher() {
    this.state.isRadialLauncherOpen = true;
    this.render();
  }

  closeRadialLauncher() {
    this.state.isRadialLauncherOpen = false;
    const existing = document.getElementById('yayra-radial-launcher-overlay');
    if (existing) existing.remove();
  }

  /**
   * The 12 built-in wheel actions. Link-backed entries carry their real
   * `url`, so the wheel shows the site's actual favicon (ask: "replace
   * all the logos with real logos") and stored customizations can
   * rebuild the live `action` by id after a restart.
   */
  getDefaultWheelDefs() {
    return [
      { id: 'play', title: 'Media Controller', icon: Icons.play, x: 0, y: -130, isDark: false, action: () => this.openMediaController() },
      { id: 'notes', title: 'Quick Notes', icon: Icons.edit, x: 55, y: -90, isDark: false, action: () => this.openQuickNotes() },
      { id: 'chatgpt', title: 'Ask ChatGPT', url: 'https://chatgpt.com', icon: Icons.chatgpt, x: 125, y: -125, isDark: false, action: () => this.executeAiAction('ChatGPT') },
      { id: 'claude', title: 'Claude Assistant', url: 'https://claude.ai', icon: Icons.claude, x: 150, y: -50, isDark: false, action: () => this.executeAiAction('Claude') },
      { id: 'sparkles', title: 'AI Assistant', icon: Icons.sparkles, x: 65, y: -20, isDark: true, action: () => this.openFloatingMini('yayra://ai') },
      { id: 'gemini', title: 'Rephrase with Gemini', url: 'https://gemini.google.com', icon: Icons.gemini, x: 145, y: 35, isDark: true, isFeatured: true, showPillAlways: true, action: () => this.executeAiAction('Gemini') },
      { id: 'perplexity', title: 'Perplexity Search', url: 'https://perplexity.ai', icon: Icons.perplexity, x: 120, y: 110, isDark: false, action: () => this.executeAiAction('Perplexity') },
      { id: 'shields', title: 'Security & Shields', icon: Icons.desktopLock, x: 55, y: 70, isDark: false, action: () => this.openInternalPage('yayra://extensions') },
      { id: 'touch', title: 'Assistive Touch', icon: Icons.mouseTouch, x: -35, y: 100, isDark: false, action: () => this.enableAssistiveTouch() },
      { id: 'screenshot', title: 'Capture Screenshot', icon: Icons.crop, x: -105, y: 65, isDark: false, action: () => this.captureScreenshot() },
      { id: 'duplicate', title: 'Duplicate Window', icon: Icons.tabs, x: -130, y: -15, isDark: false, action: () => this.duplicateFloatingMini() },
      { id: 'finder', title: 'Yayra Assistive', icon: Icons.finderFace, x: -85, y: -80, isDark: false, action: () => this.openFloatingMini() }
    ];
  }

  getRadialActions() {
    if (this.state.customRadialActions && this.state.customRadialActions.length > 0) {
      return this.state.customRadialActions;
    }
    return this.getDefaultWheelDefs();
  }

  /**
   * Rebuild live wheel items from the stored {id,title,url,type} shape:
   * builtin ids get their real action/icon back from the defaults
   * table; everything else is a user-added site opened in yayra mini.
   */
  hydrateWheelItems(stored) {
    const defaults = this.getDefaultWheelDefs();
    const items = (stored || []).map((raw) => {
      const def = defaults.find((d) => d.id === raw.id);
      if (def) return { ...def, title: raw.title || def.title };
      return { id: raw.id, title: raw.title, url: raw.url || null, type: raw.type || 'site', isDark: false };
    });
    return this.applyWheelLayout(items);
  }

  /** Even circle layout for customized wheels of any size. */
  applyWheelLayout(items) {
    const n = Math.max(items.length, 1);
    const R = 135;
    return items.map((item, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      return { ...item, x: Math.round(R * Math.cos(angle)), y: Math.round(R * Math.sin(angle)) };
    });
  }

  /**
   * Real logos on the wheel: link items render the site's actual
   * favicon (with the original glyph as fallback if the icon can't
   * load); non-link actions keep their custom Yayra glyphs.
   */
  wheelIconHtml(item) {
    const url = item.url || null;
    if (url && /^https?:/i.test(url)) {
      try {
        const host = new URL(url).hostname;
        const fallback = item.icon || Icons.globe;
        return `<img class="fb-wheel-favicon" src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" `
          + `style="width:22px;height:22px;border-radius:6px;" `
          + `onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='';" />`
          + `<span class="fb-wheel-glyph-fallback" style="display:none">${fallback}</span>`;
      } catch { /* malformed url - fall back to the glyph */ }
    }
    return item.icon || Icons.globe;
  }

  /** Persist the customized wheel per profile + mirror it to the native bubble ring. */
  saveWheelItems(items) {
    this.state.customRadialActions = items && items.length ? this.applyWheelLayout(items) : null;
    if (this.wheelRepo) {
      try {
        const plain = (items || []).map(({ id, title, url = null, type = null }) => ({ id, title, url, type }));
        const op = items && items.length ? this.wheelRepo.setItems(plain) : this.wheelRepo.reset();
        if (op && typeof op.catch === 'function') op.catch(() => {});
      } catch { /* persistence best-effort; the session keeps the wheel */ }
    }
    this.syncWheelToOverlay();
  }

  /** Mirror the wheel to the native bubble's double-tap radial (Electron). */
  syncWheelToOverlay() {
    const bridge = this.overlayBridge;
    if (!bridge || typeof bridge.setWheelItems !== 'function') return;
    const custom = this.state.customRadialActions;
    const items = custom && custom.length
      ? custom.map(({ id, title, url = null, type = null }) => ({ id, title, url, type }))
      : null; // null -> the native ring shows its own defaults
    try {
      const res = bridge.setWheelItems(items);
      if (res && typeof res.catch === 'function') res.catch(() => {});
    } catch { /* older preload without the channel */ }
  }

  /**
   * Run a wheel action by id - used by the native bubble's radial for
   * actions only the full renderer can do, and by the in-app wheel.
   */
  executeWheelActionById(actionId) {
    if (!actionId) return;
    if (actionId === 'customize') {
      this.openModal('radial-customizer');
      return;
    }
    const item = this.getRadialActions().find((i) => i.id === actionId);
    if (!item) return;
    if (typeof item.action === 'function') item.action();
    else if (item.url) this.openFloatingMini(item.url);
  }

  renderRadialLauncher() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('yayra-radial-launcher-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'yayra-radial-launcher-overlay';
    overlay.className = 'yayra-radial-launcher-overlay';

    const container = document.createElement('div');
    container.className = 'yayra-radial-container';

    // Center Close Button
    const centerBtn = document.createElement('button');
    centerBtn.className = 'yayra-radial-center-btn';
    centerBtn.innerHTML = '×';
    centerBtn.setAttribute('title', 'Close Launcher');
    centerBtn.addEventListener('click', () => this.closeRadialLauncher());
    container.appendChild(centerBtn);

    const radialActions = this.getRadialActions();

    radialActions.forEach((item) => {
      const x = item.x !== undefined ? item.x : 0;
      const y = item.y !== undefined ? item.y : 0;

      const btn = document.createElement('button');
      btn.className = `yayra-radial-item ${item.isFeatured ? 'dark-featured' : ''} ${item.isDark ? 'dark-orb' : ''} ${item.showPillAlways ? 'show-pill-always' : ''}`;
      btn.style.setProperty('--dx', `${x}px`);
      btn.style.setProperty('--dy', `${y}px`);
      btn.style.transform = `translate(${x}px, ${y}px)`;
      btn.setAttribute('aria-label', item.title);

      btn.innerHTML = `
        ${this.wheelIconHtml(item)}
        <span class="yayra-radial-tooltip-pill">${item.title}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeRadialLauncher();
        if (typeof item.action === 'function') {
          item.action();
        } else if (item.url) {
          this.openFloatingMini(item.url);
        }
      });

      container.appendChild(btn);
    });

    // Bottom Navigation Button (Down Arrow -> Opens Customizer & Bookmarks)
    const bottomBtn = document.createElement('button');
    bottomBtn.className = 'yayra-radial-bottom-btn';
    bottomBtn.innerHTML = Icons.arrowDown;
    bottomBtn.style.setProperty('--dx', '0px');
    bottomBtn.style.setProperty('--dy', '175px');
    bottomBtn.style.transform = 'translate(0px, 175px)';
    bottomBtn.setAttribute('title', 'Customize Wheel & Bookmarks');
    bottomBtn.addEventListener('click', () => {
      this.closeRadialLauncher();
      this.openModal('radial-customizer');
    });
    container.appendChild(bottomBtn);

    overlay.appendChild(container);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeRadialLauncher();
    });

    document.body.appendChild(overlay);
  }

  executeAiAction(provider) {
    const urls = {
      Gemini: 'https://gemini.google.com',
      ChatGPT: 'https://chatgpt.com',
      Claude: 'https://claude.ai',
      Perplexity: 'https://perplexity.ai'
    };
    const targetUrl = urls[provider] || 'https://google.com';
    this.openFloatingMini(targetUrl);
  }

  /**
   * Quick Notes: a real scratchpad overlay (window.prompt doesn't work
   * in Electron renderers), persisted per profile.
   */
  async openQuickNotes() {
    if (typeof document === 'undefined') return;
    let saved = '';
    try {
      saved = (this.profileStorage ? await this.profileStorage.get('quick-notes') : null)
        || (typeof localStorage !== 'undefined' ? localStorage.getItem('yayra-quick-note') : '')
        || '';
    } catch { saved = ''; }

    document.getElementById('yayra-quick-notes-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'yayra-quick-notes-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(10,12,20,0.55);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="width:min(440px,92vw);background:var(--fb-surface,#161923);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,0.5);">
        <div style="font:600 15px/1.3 system-ui;color:var(--fb-text-primary,#f2f4f8);margin-bottom:10px;">Quick Notes</div>
        <textarea id="yayra-quick-notes-text" style="width:100%;min-height:160px;resize:vertical;border-radius:10px;border:1px solid var(--fb-border-glass,rgba(255,255,255,0.12));background:rgba(255,255,255,0.04);color:var(--fb-text-primary,#f2f4f8);padding:10px;font:400 13px/1.5 system-ui;box-sizing:border-box;" placeholder="Jot something down - it stays on this profile."></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="yayra-quick-notes-cancel" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:var(--fb-text-primary,#f2f4f8);cursor:pointer;">Cancel</button>
          <button id="yayra-quick-notes-save" style="padding:8px 14px;border-radius:9px;border:none;background:#4f7cff;color:#fff;cursor:pointer;font-weight:600;">Save note</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const textarea = overlay.querySelector('#yayra-quick-notes-text');
    if (textarea) textarea.value = saved;
    textarea?.focus?.();
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#yayra-quick-notes-cancel')?.addEventListener('click', close);
    overlay.querySelector('#yayra-quick-notes-save')?.addEventListener('click', async () => {
      const value = textarea ? textarea.value : '';
      try {
        if (this.profileStorage) await this.profileStorage.set('quick-notes', value);
        else if (typeof localStorage !== 'undefined') localStorage.setItem('yayra-quick-note', value);
        this.showTransientNotice('Note saved to this profile.');
      } catch {
        this.showTransientNotice("Couldn't save the note - storage is unavailable.");
      }
      close();
    });
  }

  /**
   * Real screenshot: on the Electron desktop the active tab's native
   * page is snapshotted and saved as a PNG download; elsewhere we say
   * honestly that the build can't capture the screen itself.
   */
  async captureScreenshot() {
    const tab = this.getActiveTab();
    if (this.nativeWebview && typeof this.nativeWebview.capture === 'function' && tab) {
      try {
        const res = await this.nativeWebview.capture(tab.id);
        const dataUrl = res && (res.snapshot || res.dataUrl);
        if (dataUrl && typeof document !== 'undefined') {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `yayra-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          this.showTransientNotice('Screenshot captured - check your downloads.');
          return;
        }
      } catch { /* fall through to the honest message */ }
    }
    this.showTransientNotice('This page has no native capture here - use your system screenshot tool (PrtScn / Cmd+Shift+4).');
  }

  /**
   * Media Controller: a real panel listing every tab with live native
   * audio state (Electron), mute/unmute per tab and jump-to-tab.
   */
  async openMediaController() {
    if (typeof document === 'undefined') return;
    document.getElementById('yayra-media-controller-overlay')?.remove();

    const native = this.nativeWebview;
    const canAudio = Boolean(native && typeof native.mediaState === 'function');
    const rows = [];
    for (const tab of this.state.tabs) {
      let audible = false; let muted = false; let hasState = false;
      if (canAudio) {
        try {
          const s = await native.mediaState(tab.id);
          if (s && s.ok) { audible = Boolean(s.audible); muted = Boolean(s.muted); hasState = true; }
        } catch { /* internal page or gone - no audio state */ }
      }
      rows.push({ tab, audible, muted, hasState });
    }

    const overlay = document.createElement('div');
    overlay.id = 'yayra-media-controller-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(10,12,20,0.55);display:flex;align-items:center;justify-content:center;';
    const rowsHtml = rows.map(({ tab, audible, muted, hasState }) => `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fb-text-primary,#f2f4f8);font:500 13px/1.3 system-ui;">
          ${audible ? '🔊 ' : (muted ? '🔇 ' : '')}${(tab.title || tab.url || 'Tab').replace(/</g, '&lt;')}
        </span>
        ${hasState ? `<button data-media-mute="${tab.id}" data-muted="${muted ? '1' : '0'}" style="padding:5px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:var(--fb-text-primary,#f2f4f8);cursor:pointer;font:500 12px system-ui;">${muted ? 'Unmute' : 'Mute'}</button>` : ''}
        <button data-media-goto="${tab.id}" style="padding:5px 10px;border-radius:8px;border:none;background:#4f7cff;color:#fff;cursor:pointer;font:500 12px system-ui;">Go to tab</button>
      </div>`).join('');
    overlay.innerHTML = `
      <div style="width:min(480px,94vw);max-height:70vh;overflow:auto;background:var(--fb-surface,#161923);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,0.5);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font:600 15px system-ui;color:var(--fb-text-primary,#f2f4f8);">Media Controller</div>
          <button id="yayra-media-close" style="border:none;background:transparent;color:var(--fb-text-primary,#f2f4f8);font-size:18px;cursor:pointer;">×</button>
        </div>
        ${canAudio ? '' : '<div style="font:400 12px/1.4 system-ui;color:rgba(242,244,248,0.6);margin-bottom:8px;">Per-tab mute needs the desktop app - this build lists your tabs only.</div>'}
        ${rowsHtml || '<div style="color:rgba(242,244,248,0.6);font:400 13px system-ui;padding:8px 0;">No open tabs.</div>'}
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#yayra-media-close')?.addEventListener('click', close);
    overlay.querySelectorAll('[data-media-goto]').forEach((btn) => btn.addEventListener('click', () => {
      close();
      this.selectTab(btn.getAttribute('data-media-goto'));
    }));
    overlay.querySelectorAll('[data-media-mute]').forEach((btn) => btn.addEventListener('click', async () => {
      const tabId = btn.getAttribute('data-media-mute');
      const nextMuted = btn.getAttribute('data-muted') !== '1';
      try {
        await native.setMuted(tabId, nextMuted);
        btn.setAttribute('data-muted', nextMuted ? '1' : '0');
        btn.textContent = nextMuted ? 'Unmute' : 'Mute';
      } catch { this.showTransientNotice("Couldn't change that tab's audio."); }
    }));
  }

  /**
   * Assistive Touch: genuinely turn on the system-wide floating bubble
   * where the platform supports it; honest message where it can't.
   */
  async enableAssistiveTouch() {
    if (this.overlayBridge && typeof this.overlayBridge.setEnabled === 'function') {
      try {
        await this.overlayBridge.setEnabled(true);
        this.state.overlaySettings = { ...this.state.overlaySettings, enabled: true };
        this.showTransientNotice('Assistive Touch bubble enabled - it floats over every app.');
        return;
      } catch { /* fall through */ }
    }
    // In-app fallback: minimize the shell to its floating bubble.
    if (typeof this.minimizeToBubble === 'function') {
      this.minimizeToBubble();
      return;
    }
    this.showTransientNotice('The system-wide bubble needs the desktop or Android app.');
  }

  /** window.yayra.system (Electron): app metrics + desktop shortcuts. */
  /**
   * Apply the saved pointer to Yayra's chrome and every native site view.
   * Desktop uses a CSP-resilient user stylesheet on each native website view
   * and a nonce-aware best-effort fallback for child frames; Android applies
   * the same theme in its native WebView. A plain browser/PWA cannot reach
   * into cross-origin iframes.
   */
  applyPointerTheme() {
    const requestedTheme = this.state.settings.pointerTheme || 'system';
    const theme = ['yayra', 'high-visibility'].includes(requestedTheme) ? requestedTheme : 'system';
    const requestedSize = this.state.settings.pointerSize || 'normal';
    const size = ['large', 'xlarge'].includes(requestedSize) ? requestedSize : 'normal';

    if (typeof document !== 'undefined' && document.body) {
      if (theme === 'system') {
        document.body.removeAttribute?.('data-fb-pointer');
        document.body.removeAttribute?.('data-fb-pointer-size');
      } else {
        document.body.setAttribute?.('data-fb-pointer', theme);
        document.body.setAttribute?.('data-fb-pointer-size', size);
      }
    }

    const configKey = `${theme}:${size}`;
    const native = this.nativeWebview;
    if (native && typeof native.setPointerTheme === 'function' && this._lastAppliedNativePointerConfig !== configKey) {
      for (const tabId of this._nativeWebviewTabIds || []) {
        try {
          Promise.resolve(native.setPointerTheme(tabId, theme, size)).catch(() => {});
        } catch { /* a closing native page is best-effort */ }
      }
      this._lastAppliedNativePointerConfig = configKey;
    }

    const android = this.capacitorTabWeb;
    if (android && typeof android.tabWebSetPointerTheme === 'function' && this._lastAppliedAndroidPointerConfig !== configKey) {
      for (const tabId of this._androidTabWebIds || []) {
        try {
          Promise.resolve(android.tabWebSetPointerTheme({ id: tabId, theme, size })).catch(() => {});
        } catch { /* a closing Android page is best-effort */ }
      }
      this._lastAppliedAndroidPointerConfig = configKey;
    }
  }

  get systemBridge() {
    if (typeof window === 'undefined') return null;
    return (window.yayra && window.yayra.system) || (window.ibrowse && window.ibrowse.system) || null;
  }

  /** Generic single-line text prompt (window.prompt is dead in Electron renderers). */
  _textPromptDialog({ title, description = '', placeholder = '', initialValue = '' } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) { resolve(null); return; }
      const overlay = document.createElement('div');
      overlay.className = 'fb-text-prompt-overlay';
      overlay.setAttribute('role', 'presentation');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,10,16,0.62);display:flex;align-items:center;justify-content:center;';
      const promptTitleId = `yayra-text-prompt-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const card = document.createElement('div');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', promptTitleId);
      card.style.cssText = 'background:var(--fb-bg-elevated,#171a22);color:var(--fb-text-primary,#f3f4f6);border-radius:16px;padding:22px;max-width:380px;width:92%;box-shadow:0 18px 60px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;';
      const h = document.createElement('strong');
      h.id = promptTitleId;
      h.textContent = title;
      card.appendChild(h);
      if (description) {
        const p = document.createElement('p');
        p.textContent = description;
        p.style.cssText = 'margin:0;font-size:0.84rem;color:var(--fb-text-secondary,#9ca3af);line-height:1.5;';
        card.appendChild(p);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.value = initialValue;
      input.setAttribute('aria-label', title || 'Text input');
      input.style.cssText = 'padding:10px;border-radius:10px;border:1px solid var(--fb-border,#2a2f3b);background:var(--fb-bg,#101218);color:inherit;font-size:0.95rem;';
      card.appendChild(input);
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        try { overlay.remove(); } catch { /* gone */ }
        // Recompute without treating this prompt's own flag as another
        // overlay, then let setPageObscured perform the native visibility
        // transition (including the true -> false case).
        const wasObscured = Boolean(this.state.isPageObscured);
        this.state.isPageObscured = false;
        const shouldRemainObscured = this.hasBlockingOverlay();
        this.state.isPageObscured = wasObscured;
        this.setPageObscured(shouldRemainObscured);
        resolve(value);
      };
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:10px 14px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-bg,#232734);color:inherit;';
      cancel.addEventListener('click', () => done(null));
      const ok = document.createElement('button');
      ok.textContent = 'Save';
      ok.style.cssText = 'padding:10px 14px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-accent,#6d5df2);color:#fff;';
      ok.addEventListener('click', () => done(input.value.trim()));
      row.appendChild(cancel);
      row.appendChild(ok);
      card.appendChild(row);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        e.preventDefault?.();
        e.stopPropagation?.();
        done(e.key === 'Enter' ? input.value.trim() : null);
      });
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) done(null); });
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      // Electron website contents are a native surface above the HTML DOM;
      // hiding them makes this prompt visible and clickable there.
      this.setPageObscured(true);
      input.focus();
      input.select();
    });
  }

  /** Chrome-style confirmation for installing the active website as an app. */
  _installPageAsAppDialog({ title = '', url = '', iconHtml = '' } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) { resolve(null); return; }
      document.getElementById('yayra-install-app-overlay')?.remove();

      let domain = '';
      try { domain = new URL(url).hostname; } catch { domain = String(url || ''); }

      const overlay = document.createElement('div');
      overlay.id = 'yayra-install-app-overlay';
      overlay.className = 'fb-install-app-overlay';
      overlay.setAttribute('role', 'presentation');

      const dialog = document.createElement('section');
      dialog.className = 'fb-install-app-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'yayra-install-app-title');
      dialog.addEventListener('click', (event) => event.stopPropagation());

      const heading = document.createElement('h2');
      heading.id = 'yayra-install-app-title';
      heading.className = 'fb-install-app-title';
      heading.textContent = 'Install this page as an app';
      dialog.appendChild(heading);

      const hint = document.createElement('p');
      hint.className = 'fb-install-app-hint';
      hint.textContent = 'Apps open in a window';
      dialog.appendChild(hint);

      const identity = document.createElement('div');
      identity.className = 'fb-install-app-identity';
      const icon = document.createElement('div');
      icon.className = 'fb-install-app-icon';
      // getTabFavicon returns only Yayra-owned SVG markup and a sanitized
      // site favicon URL, so it is safe to reuse in this small preview.
      icon.innerHTML = iconHtml || Icons.globe;
      identity.appendChild(icon);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'fb-input fb-install-app-name';
      input.setAttribute('aria-label', 'App name');
      input.value = String(title || domain || 'Website').slice(0, 60);
      input.maxLength = 60;
      identity.appendChild(input);
      dialog.appendChild(identity);

      const site = document.createElement('div');
      site.className = 'fb-install-app-domain';
      site.textContent = domain;
      dialog.appendChild(site);

      const actions = document.createElement('div');
      actions.className = 'fb-install-app-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'fb-btn fb-btn-secondary';
      cancel.textContent = 'Cancel';
      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'fb-btn fb-btn-primary';
      install.textContent = 'Install';
      actions.appendChild(cancel);
      actions.appendChild(install);
      dialog.appendChild(actions);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { overlay.remove(); } catch { /* already gone */ }
        if (this.nativeWebview) this.setPageObscured(false);
        resolve(value);
      };
      overlay._yayraFinish = finish;
      cancel.addEventListener('click', () => finish(null));
      install.addEventListener('click', () => finish(input.value.trim() || null));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault?.(); finish(input.value.trim() || null); }
      });
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) finish(null);
      });
      overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault?.(); finish(null); }
      });

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      // Electron's native WebContentsView is a separate OS surface above
      // the HTML tree. Mark this body-mounted dialog as an obscuring layer
      // so the page is hidden immediately and the buttons receive clicks.
      if (this.nativeWebview) this.setPageObscured(true);
      input.focus();
      input.select();
      this.bindTabLogoFallbacks(icon);
    });
  }

  /**
   * Real QR code modal for the current page (vendored generator - no
   * network, works offline). Used by "Create QR Code" and the honest
   * version of "Send to your devices" (scan on the phone to open there).
   */
  showUrlQrModal(url, { title = 'QR code for this page', subtitle = 'Scan it with your phone camera to open the page there.' } = {}) {
    if (typeof document === 'undefined' || !document.body || !url) return;
    document.getElementById('yayra-url-qr-overlay')?.remove();
    let svg = '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url, 'Byte');
      qr.make();
      svg = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
    } catch { svg = ''; }
    const overlay = document.createElement('div');
    overlay.id = 'yayra-url-qr-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,10,16,0.62);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--fb-bg-elevated,#171a22);color:var(--fb-text-primary,#f3f4f6);border-radius:16px;padding:22px;max-width:380px;width:92%;box-shadow:0 18px 60px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;text-align:center;">
        <strong style="font-size:1.05rem;">${title}</strong>
        <div style="background:#fff;border-radius:12px;padding:10px;align-self:center;width:220px;height:220px;display:flex;align-items:center;justify-content:center;">
          <div style="width:200px;height:200px;">${svg || ''}</div>
        </div>
        <p style="margin:0;font-size:0.8rem;color:var(--fb-text-secondary,#9ca3af);line-height:1.5;">
          ${subtitle}
          <br /><code style="font-size:0.72rem;word-break:break-all;">${url.replace(/</g, '&lt;')}</code>
        </p>
        <div style="display:flex;gap:8px;">
          <button class="fb-qr-copy" style="flex:1;padding:11px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-bg,#232734);color:inherit;">Copy link</button>
          <button class="fb-qr-close" style="flex:1;padding:11px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-accent,#6d5df2);color:#fff;">Done</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // DESKTOP: the native page view paints above HTML - hide it (with a
    // snapshot) so this dialog is actually visible there.
    if (this.nativeWebview) this.setPageObscured(true);
    const close = () => {
      overlay.remove();
      if (this.nativeWebview) this.setPageObscured(false);
    };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.fb-qr-close')?.addEventListener('click', close);
    overlay.querySelector('.fb-qr-copy')?.addEventListener('click', () => {
      try { navigator.clipboard?.writeText(url); this.showTransientNotice('Link copied to clipboard.'); } catch { /* no clipboard */ }
    });
  }

  /** REAL developer tools: detached Chromium DevTools on desktop; honest elsewhere. */
  async openDevToolsForActiveTab() {
    const tab = this.getActiveTab();
    if (this.nativeWebview && typeof this.nativeWebview.openDevTools === 'function') {
      try {
        await this.nativeWebview.openDevTools(tab ? tab.id : null);
        return;
      } catch { /* fall through to honesty */ }
    }
    this.showTransientNotice("DevTools aren't available in the web build - use your browser's own (F12 / Ctrl+Shift+I).");
  }

  /** Print the actual page: the native view's print dialog on desktop, window.print on web. */
  printActivePage() {
    const tab = this.getActiveTab();
    if (this.nativeWebview && typeof this.nativeWebview.print === 'function' && tab) {
      try {
        const res = this.nativeWebview.print(tab.id);
        if (res && typeof res.catch === 'function') res.catch(() => {});
        return;
      } catch { /* fall through */ }
    }
    if (typeof window !== 'undefined' && window.print) window.print();
  }

  /** Save the real page (HTML + assets) through the OS save dialog on desktop. */
  async savePageAs() {
    const tab = this.getActiveTab();
    if (this.nativeWebview && typeof this.nativeWebview.savePage === 'function' && tab) {
      try {
        const res = await this.nativeWebview.savePage(tab.id);
        if (res && res.ok) { this.showTransientNotice(`Page saved to ${res.path}`); return; }
        if (res && res.canceled) return;
      } catch { /* fall through */ }
    }
    this.showTransientNotice("Saving full pages needs the desktop app - use your browser's Ctrl+S here.");
  }

  /**
   * OFFLINE PROMPTING ("when there is no internet connection, it must
   * prompt users so not to give blank pages"): without this, opening a
   * page while offline rendered a silent BLANK frame (the iframe request
   * fails and nothing explains why). Two guarantees:
   *   1. A NEW page opened while offline shows an honest offline card
   *      with a Retry button - never a blank page.
   *   2. A page that is ALREADY LOADED stays exactly as it is (the
   *      loaded-page contract) - the listeners below only INFORM and
   *      heal failed tabs; they never reload or touch live pages.
   */
  _onLine() {
    try {
      return !(typeof navigator !== 'undefined' && navigator.onLine === false);
    } catch {
      return true;
    }
  }

  _armConnectivityAwareness() {
    if (this._connectivityArmed) return;
    this._connectivityArmed = true;
    try {
      window.addEventListener?.('offline', () => {
        this.showTransientNotice('You\u2019re offline - new pages can\u2019t load until the connection is back. Pages you already opened stay available.');
      });
      window.addEventListener?.('online', () => {
        // Never reloads anything: pooled live frames survive re-renders
        // (the no-blink architecture); only tabs stuck on the offline
        // card get a fresh attempt because they never loaded at all.
        this.showTransientNotice('Back online.');
        try { this.render(); } catch { /* best-effort heal */ }
      });
    } catch { /* older shims */ }
  }

  /** The honest in-tab card shown instead of a blank frame. */
  buildOfflineFallback(url) {
    const fallback = document.createElement('div');
    fallback.className = 'fb-frame-blocked-fallback fb-offline-fallback';
    fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; background:var(--fb-bg-elevated,#15171c); color:var(--fb-text-primary,#d7dbe3); text-align:center; padding:24px; z-index:1;';
    fallback.innerHTML = `
      <div style="font-size:1.4rem;">\u26A1</div>
      <div style="font-size:0.95rem; font-weight:700;">You\u2019re offline</div>
      <div style="font-size:0.9rem; max-width:380px; line-height:1.5;">There\u2019s no internet connection, so \u201C${String(url).replace(/</g, '&lt;').slice(0, 80)}\u201D can\u2019t load. Pages you already have open keep working.</div>
      <button type="button" class="fb-btn fb-offline-retry-btn" style="padding:8px 16px; border-radius:8px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-size:0.875rem;">Retry</button>
      <div style="font-size:0.75rem; color:var(--fb-text-secondary,#9aa3b2);">Yayra reloads it automatically once you\u2019re back online.</div>
    `;
    fallback.querySelector('.fb-offline-retry-btn')?.addEventListener('click', () => {
      if (this._onLine()) {
        try { this.render(); } catch { /* best effort */ }
      } else {
        this.showTransientNotice('Still offline - reconnect and try again.');
      }
    });
    return fallback;
  }

  /**
   * Web/PWA: catch the browser's beforeinstallprompt so Yayra itself can be
   * installed from the menu (the only "install as app" a plain web page is
   * allowed to perform). No-op everywhere the event doesn't exist.
   */
  _capturePwaInstallPrompt() {
    if (typeof window === 'undefined') return;
    if (this._pwaPromptCaptured) return; // never install the listener twice
    this._pwaPromptCaptured = true;
    try {
      window.addEventListener?.('beforeinstallprompt', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        this._pwaInstallPrompt = e;
      });
    } catch { /* older shims */ }
  }

  /**
   * Android deep links from "installed site" home-screen shortcuts:
   * com.yayra.app:/browse?url=<encoded site URL> (created by
   * YayraOverlayPlugin.installSiteAsApp). Tapping the shortcut opens Yayra
   * straight on the site. OAuth redirects and everything else are ignored
   * here - they have their own handlers.
   */
  _handleAppModeLaunchUrls() {
    try {
      const app = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
      if (!app || typeof app.addListener !== 'function') return;
      const handle = async (raw) => {
        const url = String((raw && raw.url) || raw || '');
        const match = /^com\.yayra\.app:\/browse\?url=(.+)$/.exec(url);
        if (!match) return;
        let target = null;
        try { target = decodeURIComponent(match[1]); } catch { /* bad encoding */ }
        if (!target || !/^https?:\/\//i.test(target)) return;
        // Frame-hostile sites (Google, YouTube, X, ...) are exactly the
        // sites people install, and they can NEVER render in the in-shell
        // iframe engine - before this fix, tapping an installed shortcut
        // showed the "can't open site" card and jumped out to Chrome.
        // Yayra's OWN native floating browser window (a real WebView, no
        // iframe restrictions) opens them properly, inside Yayra.
        const overlay = this.capacitorOverlay;
        if (this.isKnownFrameBlockedUrl(target) && overlay && typeof overlay.openBrowserWindow === 'function') {
          try {
            const res = await overlay.openBrowserWindow({ url: target });
            if (res && res.ok) return; // the site is open in Yayra's window
          } catch { /* fall through to the in-shell tab */ }
        }
        if (this.state.isMinimizedToBubble && typeof this.restoreFromBubble === 'function') {
          this.restoreFromBubble();
        }
        this.navigateActiveTab(target);
      };
      app.addListener('appUrlOpen', (data) => handle(data));
      if (typeof app.getLaunchUrl === 'function') {
        Promise.resolve(app.getLaunchUrl()).then(handle).catch(() => {});
      }
    } catch { /* optional plugin */ }
  }

  /**
   * Chrome-style "Install page as app...": a REAL launcher entry on every
   * platform - Android gets a pinned home-screen shortcut that opens Yayra
   * straight on the site (YayraOverlayPlugin.installSiteAsApp); the desktop
   * app writes a real launcher entry (desktop icon + apps/Start menu) that
   * reopens the site in its own minimal app window; web/PWA can only
   * install Yayra itself, so it triggers the browser's own install flow
   * when available and is honest otherwise.
   */
  async installPageAsApp() {
    const tab = this.getActiveTab();
    if (!tab || !/^https?:\/\//i.test(String(tab.url || ''))) {
      this.showTransientNotice('Open a website first - internal pages can\'t be installed as apps.');
      return;
    }
    const title = String(tab.title || tab.url).slice(0, 60);
    // The user can EDIT the install name everywhere - pre-filled with the
    // site's own name (its manifest name on desktop, its page title on
    // Android), exactly like Chrome's install dialog.
    // 1. Android: REAL home-screen shortcut, deep-links back into Yayra.
    const overlay = this.capacitorOverlay;
    if (overlay && typeof overlay.installSiteAsApp === 'function') {
      let shortcutName = title;
      try {
        const editedName = await this._installPageAsAppDialog({
          title,
          url: tab.url,
          iconHtml: this.getTabFavicon(tab)
        });
        if (editedName === null) { this.showTransientNotice('Install cancelled.'); return; }
        shortcutName = editedName;
      } catch { /* prompt unavailable (tests/embedders) - keep the site title */ }
      try {
        const res = await overlay.installSiteAsApp({ url: tab.url, title: shortcutName });
        if (res && res.ok) {
          this.showTransientNotice(`Added \u201C${shortcutName}\u201D to your home screen - tap it to open Yayra straight on the site.`);
          return;
        }
        this.showTransientNotice(`Couldn\u2019t add the site to your home screen${res && res.reason ? ` (${res.reason})` : ''}.`);
        return;
      } catch { /* fall through to other platforms */ }
    }
    // 2. Desktop app: launcher entry + its own app window. The SITE'S OWN
    // PWA identity (manifest name/start url) is previewed first so the
    // editable name dialog starts from the site's own name.
    if (this.systemBridge && typeof this.systemBridge.installPageAsApp === 'function') {
      try {
        let installName = String(tab.title || tab.url).slice(0, 60);
        let startUrl = tab.url;
        if (typeof this.systemBridge.installPageAsAppPreview === 'function') {
          try {
            const preview = await this.systemBridge.installPageAsAppPreview({ url: tab.url, title: tab.title || tab.url });
            if (preview && preview.ok) {
              if (preview.name) installName = String(preview.name).slice(0, 60);
              if (preview.startUrl) startUrl = preview.startUrl;
            }
          } catch { /* preview is best-effort - plain install still works */ }
        }
        let finalName = installName;
        try {
          const editedName = await this._installPageAsAppDialog({
            title: installName,
            url: tab.url,
            iconHtml: this.getTabFavicon(tab)
          });
          if (editedName === null) { this.showTransientNotice('Install cancelled.'); return; }
          finalName = editedName;
        } catch { /* prompt unavailable (tests/embedders) - keep the site name */ }
        const res = await this.systemBridge.installPageAsApp({ url: startUrl, title: finalName, nameOverride: finalName });
        if (res && res.ok) {
          this.showTransientNotice(res.pwa
            ? `Installed "${res.name}" as an app - its own icon is on your desktop${res.inLauncher ? ' and in your apps menu' : ''}, and it opens in its own window.`
            : `Installed "${res.name}" - it's on your desktop${res.inLauncher ? ' and in your apps menu' : ''}, and opens in its own window.`);
          return;
        }
        if (res && res.reason === 'unsupported-platform') {
          this.showTransientNotice('Installing pages as apps is not supported on macOS yet - use "Create shortcut..." instead.');
          return;
        }
        this.showTransientNotice(`Couldn't install the app${res && res.reason ? ` (${res.reason})` : ''}.`);
        return;
      } catch { /* fall through to the web path */ }
    }
    // 3. Web/PWA: a web page may only install ITSELF. Trigger the browser's
    // real install flow for Yayra when it's available; be honest otherwise.
    if (this._pwaInstallPrompt && typeof this._pwaInstallPrompt.prompt === 'function') {
      try {
        await this._pwaInstallPrompt.prompt();
        const choice = await this._pwaInstallPrompt.userChoice;
        this._pwaInstallPrompt = null; // one-shot per the platform contract
        if (choice && choice.outcome === 'accepted') {
          this.showTransientNotice('Installing Yayra as an app - it gets its own window and taskbar entry.');
          return;
        }
        this.showTransientNotice('Install cancelled.');
        return;
      } catch { /* fall through to honesty */ }
    }
    this.showTransientNotice('A web page can\u2019t install another site as an app - use the Yayra desktop or Android app for that. To install Yayra itself, use your browser\u2019s install / add-to-home-screen option.');
  }

  /** Real desktop shortcut for the current page (desktop app only). */
  async createShortcutForActivePage() {
    const tab = this.getActiveTab();
    if (this.systemBridge && typeof this.systemBridge.createShortcut === 'function' && tab) {
      try {
        const res = await this.systemBridge.createShortcut({ url: tab.url, title: tab.title || tab.url });
        if (res && res.ok) { this.showTransientNotice(`Shortcut created on your desktop: ${res.path}`); return; }
        this.showTransientNotice(`Couldn't create the shortcut${res && res.reason ? ` (${res.reason})` : ''}.`);
        return;
      } catch { /* fall through */ }
    }
    this.showTransientNotice('Desktop shortcuts need the desktop app - on web, use your browser\'s "Install" / "Add to home screen".');
  }

  /**
   * Reading mode: on desktop the real page text is extracted from the
   * native view and shown in a clean article overlay; the web build is
   * honest that cross-origin frames can't be read.
   */
  async openReadingMode() {
    const tab = this.getActiveTab();
    if (this.nativeWebview && typeof this.nativeWebview.readerExtract === 'function' && tab) {
      try {
        const res = await this.nativeWebview.readerExtract(tab.id);
        if (res && res.ok && Array.isArray(res.blocks) && res.blocks.length) {
          this.renderReaderOverlay(res);
          return;
        }
      } catch { /* fall through */ }
      this.showTransientNotice("This page doesn't have readable article text.");
      return;
    }
    this.showTransientNotice('Reading mode needs the desktop app - web pages here live in frames Yayra may not read.');
  }

  renderReaderOverlay({ title, url, blocks }) {
    if (typeof document === 'undefined' || !document.body) return;
    document.getElementById('yayra-reader-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'yayra-reader-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--fb-bg,#101218);overflow:auto;';
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const body = blocks.map((b) => {
      if (b.tag === 'h1' || b.tag === 'h2' || b.tag === 'h3') return `<h2 style="font:700 1.25rem/1.4 Georgia,serif;margin:1.4em 0 0.4em;">${esc(b.text)}</h2>`;
      if (b.tag === 'li') return `<li style="margin:0.3em 0;">${esc(b.text)}</li>`;
      return `<p style="margin:0.8em 0;">${esc(b.text)}</p>`;
    }).join('');
    overlay.innerHTML = `
      <div style="position:sticky;top:0;display:flex;justify-content:flex-end;padding:12px;background:linear-gradient(var(--fb-bg,#101218),transparent);">
        <button class="fb-reader-close" style="padding:8px 16px;border:none;border-radius:10px;font-weight:600;cursor:pointer;background:var(--fb-bg-elevated,#232734);color:var(--fb-text-primary,#f3f4f6);">Close reader</button>
      </div>
      <article style="max-width:680px;margin:0 auto;padding:12px 20px 80px;color:var(--fb-text-primary,#e8eaf0);font:400 1.05rem/1.75 Georgia,serif;">
        <h1 style="font:700 1.7rem/1.3 Georgia,serif;">${esc(title)}</h1>
        <p style="font-size:0.8rem;color:var(--fb-text-secondary,#9ca3af);word-break:break-all;">${esc(url)}</p>
        ${body}
      </article>`;
    document.body.appendChild(overlay);
    // DESKTOP: hide the native page view (with snapshot) so the reader is
    // visible above it; restore the live page on close.
    if (this.nativeWebview) this.setPageObscured(true);
    overlay.querySelector('.fb-reader-close')?.addEventListener('click', () => {
      overlay.remove();
      if (this.nativeWebview) this.setPageObscured(false);
    });
  }

  /**
   * Performance / Task manager: REAL process metrics from
   * app.getAppMetrics() on desktop plus this renderer's own JS heap -
   * no invented numbers anywhere.
   */
  async openTaskManagerModal() {
    if (typeof document === 'undefined' || !document.body) return;
    document.getElementById('yayra-taskmgr-overlay')?.remove();

    let metrics = null;
    if (this.systemBridge && typeof this.systemBridge.appMetrics === 'function') {
      try { metrics = await this.systemBridge.appMetrics(); } catch { metrics = null; }
    }
    const heap = (typeof performance !== 'undefined' && performance.memory)
      ? Math.round(performance.memory.usedJSHeapSize / (1024 * 1024))
      : null;

    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    let rowsHtml = '';
    if (metrics && Array.isArray(metrics.processes) && metrics.processes.length) {
      rowsHtml = metrics.processes.map((p) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);">${esc(p.label || p.type)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;">${p.pid ?? '-'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;">${Number.isFinite(p.cpu) ? `${p.cpu.toFixed(1)}%` : '-'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;">${Number.isFinite(p.memoryMB) ? `${p.memoryMB} MB` : '-'}</td>
        </tr>`).join('');
    }
    const heapLine = heap !== null
      ? `<p style="margin:8px 0 0;font-size:0.8rem;color:var(--fb-text-secondary,#9ca3af);">This window's JS heap: ${heap} MB &middot; ${this.state.tabs.length} tab(s) open</p>`
      : `<p style="margin:8px 0 0;font-size:0.8rem;color:var(--fb-text-secondary,#9ca3af);">${this.state.tabs.length} tab(s) open</p>`;
    const table = rowsHtml
      ? `<table style="width:100%;border-collapse:collapse;font-size:0.84rem;">
           <thead><tr>
             <th style="text-align:left;padding:6px 10px;color:var(--fb-text-secondary,#9ca3af);font-weight:600;">Process</th>
             <th style="text-align:right;padding:6px 10px;color:var(--fb-text-secondary,#9ca3af);font-weight:600;">PID</th>
             <th style="text-align:right;padding:6px 10px;color:var(--fb-text-secondary,#9ca3af);font-weight:600;">CPU</th>
             <th style="text-align:right;padding:6px 10px;color:var(--fb-text-secondary,#9ca3af);font-weight:600;">Memory</th>
           </tr></thead><tbody>${rowsHtml}</tbody></table>`
      : '<p style="margin:0;font-size:0.84rem;color:var(--fb-text-secondary,#9ca3af);">Per-process metrics are only available in the desktop app. Your browser\'s own task manager (Shift+Esc in Chrome) covers this tab here.</p>';

    const overlay = document.createElement('div');
    overlay.id = 'yayra-taskmgr-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,10,16,0.62);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--fb-bg-elevated,#171a22);color:var(--fb-text-primary,#f3f4f6);border-radius:16px;padding:22px;max-width:560px;width:94%;max-height:72vh;overflow:auto;box-shadow:0 18px 60px rgba(0,0,0,0.5);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <strong style="font-size:1.05rem;">Performance &amp; Task Manager</strong>
          <button class="fb-taskmgr-close" style="border:none;background:transparent;color:inherit;font-size:18px;cursor:pointer;">×</button>
        </div>
        ${table}
        ${heapLine}
      </div>`;
    document.body.appendChild(overlay);
    if (this.nativeWebview) this.setPageObscured(true);
    const close = () => {
      overlay.remove();
      if (this.nativeWebview) this.setPageObscured(false);
    };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.fb-taskmgr-close')?.addEventListener('click', close);
  }

  /** Bookmark every open web tab (menu + Ctrl+Shift+D). */
  async bookmarkAllTabs() {
    let saved = 0;
    if (this.bookmarksRepo) {
      for (const t of this.state.tabs) {
        if (t.url && !t.url.startsWith('yayra://')) {
          await this.bookmarksRepo.addBookmark({ url: t.url, title: t.title, favicon: t.favicon || null });
          saved += 1;
        }
      }
      try { await this.refreshBookmarksState(); } catch { /* keep stale list */ }
      const active = this.getActiveTab();
      if (active) await this.updateBookmarkState(active.url);
    }
    this.render();
    this.showTransientNotice(saved > 0
      ? `Bookmarked ${saved} open tab${saved === 1 ? '' : 's'}.`
      : 'No web pages open to bookmark.');
  }

  /**
   * Parse an exported bookmarks file: Chrome/Firefox/Edge "Export
   * bookmarks" HTML (NETSCAPE-Bookmark-file format) or a JSON array of
   * {url,title}. Returns [{url,title}] - capped, http(s)-only, deduped.
   */
  parseBookmarksImport(text) {
    const raw = String(text || '');
    const found = [];
    const push = (url, title) => {
      const cleanUrl = String(url || '').trim();
      const cleanTitle = String(title || '').trim() || cleanUrl;
      if (!/^https?:\/\//i.test(cleanUrl)) return;
      if (found.some((b) => b.url === cleanUrl)) return;
      if (found.length >= 500) return;
      found.push({ url: cleanUrl, title: cleanTitle.slice(0, 120) });
    };
    const asJson = (() => {
      try { return JSON.parse(raw); } catch { return null; }
    })();
    if (Array.isArray(asJson)) {
      for (const item of asJson) {
        if (item && typeof item === 'object' && item.url) push(item.url, item.title);
        else if (typeof item === 'string') push(item);
      }
      return found;
    }
    // NETSCAPE-Bookmark-file: <A HREF="url" ...>title</A>
    const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(raw)) !== null) push(m[1], m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\''));
    return found;
  }

  /** Open the OS file picker (accepts .html/.json bookmark exports). */
  _openFilePicker({ accept = '.html,.htm,.json' } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) { resolve(null); return; }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { input.remove(); } catch { /* already gone */ }
        resolve(value || null);
      };
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) {
          Promise.resolve(file.text()).then((text) => finish(text)).catch(() => finish(null));
        } else {
          finish(null);
        }
      });
      input.addEventListener('cancel', () => finish(null));
      document.body.appendChild(input);
      try { input.click(); } catch { finish(null); }
    });
  }

  /**
   * Import bookmarks from an export file (real parser above) into the
   * bookmarks repo - Chrome/Firefox/Edge HTML exports and JSON arrays.
   */
  async importBookmarks() {
    if (!this.bookmarksRepo) {
      this.showTransientNotice('Bookmarks are unavailable on this device.');
      return;
    }
    const text = await this._openFilePicker();
    if (text === null || text === undefined || !String(text).trim()) return; // cancelled
    const parsed = this.parseBookmarksImport(text);
    if (!parsed.length) {
      this.showTransientNotice('No bookmarks found in that file - export bookmarks from Chrome/Firefox as HTML first.');
      return;
    }
    const before = new Set((await this.bookmarksRepo.getAllBookmarks()).map((b) => b.url));
    for (const b of parsed) {
      if (!before.has(b.url)) await this.bookmarksRepo.addBookmark({ url: b.url, title: b.title });
    }
    try { await this.refreshBookmarksState(); } catch { /* keep stale list */ }
    const added = this.state.bookmarksItems.filter((b) => !before.has(b.url)).length;
    this.render();
    this.showTransientNotice(added > 0
      ? `Imported ${added} bookmark${added === 1 ? '' : 's'} (${parsed.length - added} already existed).`
      : 'All those bookmarks already exist - nothing new to import.');
  }

  /* ---------------- Real tab groups (name + colour) ---------------- */

  static TAB_GROUP_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

  sanitizeTabGroup(group) {
    if (!group || typeof group !== 'object') return null;
    const name = String(group.name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!name) return null;
    const candidateColor = String(group.color || '').trim().toLowerCase();
    const color = BrowserShell.TAB_GROUP_COLORS.find((entry) => entry.toLowerCase() === candidateColor)
      || BrowserShell.TAB_GROUP_COLORS[0];
    return { name, color };
  }

  tabGroupIdentity(group, isPrivate = false) {
    const safeGroup = this.sanitizeTabGroup(group);
    if (!safeGroup) return null;
    const privacyScope = isPrivate ? 'private::' : '';
    return `${privacyScope}${safeGroup.name.toLocaleLowerCase()}::${safeGroup.color.toLowerCase()}`;
  }

  getTabGroups() {
    const groups = new Map();
    const addMember = (tab, fromRestore = false) => {
      const group = this.sanitizeTabGroup(tab?.group);
      if (!group) return;
      // Private groups are ephemeral and never merge with the normal
      // profile's groups, even when their names and colours are identical.
      const isPrivate = fromRestore ? false : Boolean(tab.isPrivate);
      const id = this.tabGroupIdentity(group, isPrivate);
      if (!groups.has(id)) groups.set(id, { id, name: group.name, color: group.color, isPrivate, tabs: [], _keys: new Set() });
      const record = groups.get(id);
      const url = String(tab.url || '');
      // A recovered session row and its already-open counterpart represent
      // one member. Live duplicate tabs still remain distinct by tab id.
      if (fromRestore && record.tabs.some((member) => member.url === url)) return;
      const key = tab.id ? `tab:${tab.id}` : `restore:${url}`;
      if (record._keys.has(key)) return;
      record._keys.add(key);
      record.tabs.push(tab);
    };
    for (const tab of this.state.tabs || []) addMember(tab);
    for (const tab of this.state.tabGroupRestoreTabs || []) addMember(tab, true);
    return Array.from(groups.values(), ({ _keys, ...group }) => group);
  }

  openTabGroup(groupId) {
    const group = this.getTabGroups().find((candidate) => candidate.id === groupId);
    if (!group || !group.tabs.length) return false;
    const groupData = { name: group.name, color: group.color };
    const openedMembers = [];
    const restoredEntries = [];

    for (const member of group.tabs) {
      const liveTab = member.id
        ? this.state.tabs.find((tab) => tab.id === member.id)
        : null;
      if (liveTab) {
        openedMembers.push(liveTab);
        continue;
      }

      const saved = (this.state.tabGroupRestoreTabs || []).find((entry) =>
        entry.url === member.url && this.tabGroupIdentity(entry.group, false) === group.id);
      if (!saved || !/^https?:\/\//i.test(String(saved.url || ''))) continue;

      const alreadyGrouped = this.state.tabs.find((tab) =>
        !tab.isPrivate && tab.url === saved.url
        && this.tabGroupIdentity(tab.group, false) === group.id);
      if (alreadyGrouped) {
        openedMembers.push(alreadyGrouped);
        restoredEntries.push(saved);
        continue;
      }

      // Reuse an identical ungrouped tab rather than opening a duplicate;
      // tabs in a different group are left alone and get their own copy.
      const ungrouped = this.state.tabs.find((tab) =>
        !tab.isPrivate && tab.url === saved.url && !this.sanitizeTabGroup(tab.group));
      if (ungrouped) {
        ungrouped.group = groupData;
        openedMembers.push(ungrouped);
        restoredEntries.push(saved);
        continue;
      }

      const restored = this.createNewTab(false, { group: groupData, render: false });
      this.navigateActiveTab(saved.url);
      if (saved.title) restored.title = String(saved.title).slice(0, 120);
      openedMembers.push(restored);
      restoredEntries.push(saved);
    }

    if (!openedMembers.length) return false;
    if (restoredEntries.length) {
      const restoredUrls = new Set(restoredEntries.map((entry) => entry.url));
      this.state.tabGroupRestoreTabs = (this.state.tabGroupRestoreTabs || []).filter((entry) =>
        !(this.tabGroupIdentity(entry.group, false) === group.id && restoredUrls.has(entry.url)));
      this.state.continueTabs = (this.state.continueTabs || []).filter((entry) =>
        !(this.tabGroupIdentity(entry.group, false) === group.id && restoredUrls.has(entry.url)));
    }

    const target = openedMembers[0];
    this.selectTab(target.id);
    if (restoredEntries.length) {
      this.showTransientNotice(`Opened ${restoredEntries.length} saved tab${restoredEntries.length === 1 ? '' : 's'} from “${group.name}”.`);
    }
    return true;
  }

  async renameTabGroup(groupId) {
    const group = this.getTabGroups().find((candidate) => candidate.id === groupId);
    if (!group) return false;
    const prompted = await this._textPromptDialog({
      title: 'Rename tab group',
      description: 'Choose a name for this group of tabs.',
      placeholder: 'e.g. Research, Shopping, Work',
      initialValue: group.name
    });
    if (prompted === null || prompted === undefined) return false;
    const name = String(prompted).replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!name) {
      this.showTransientNotice('Group name was empty - the group was not renamed.');
      return false;
    }
    for (const tab of this.state.tabs) {
      if (this.tabGroupIdentity(tab.group, tab.isPrivate) === groupId) {
        tab.group = { name, color: group.color };
      }
    }
    for (const tab of this.state.tabGroupRestoreTabs || []) {
      if (this.tabGroupIdentity(tab.group, false) === groupId) tab.group = { name, color: group.color };
    }
    for (const tab of this.state.continueTabs || []) {
      if (this.tabGroupIdentity(tab.group, false) === groupId) tab.group = { name, color: group.color };
    }
    this.render();
    this.showTransientNotice(`Tab group renamed to “${name}”.`);
    return true;
  }

  ungroupTabGroup(groupId) {
    const group = this.getTabGroups().find((candidate) => candidate.id === groupId);
    if (!group) return 0;
    let changed = 0;
    for (const tab of this.state.tabs) {
      if (this.tabGroupIdentity(tab.group, tab.isPrivate) === groupId) {
        tab.group = null;
        changed += 1;
      }
    }
    this.state.tabGroupRestoreTabs = (this.state.tabGroupRestoreTabs || []).filter((tab) =>
      this.tabGroupIdentity(tab.group, false) !== groupId);
    for (const tab of this.state.continueTabs || []) {
      if (this.tabGroupIdentity(tab.group, false) === groupId) tab.group = null;
    }
    this.render();
    this.showTransientNotice(`“${group.name}” ungrouped - its open tabs stay open.`);
    return changed;
  }

  ungroupTab(tabId) {
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.group) return false;
    const groupId = this.tabGroupIdentity(tab.group, tab.isPrivate);
    const name = this.sanitizeTabGroup(tab.group)?.name || 'Tab group';
    tab.group = null;
    // A previous-session copy of this same member should not make it appear
    // grouped again after this tab was explicitly ungrouped.
    this.state.tabGroupRestoreTabs = (this.state.tabGroupRestoreTabs || []).filter((entry) =>
      !(this.tabGroupIdentity(entry.group, false) === groupId && entry.url === tab.url));
    for (const entry of this.state.continueTabs || []) {
      if (this.tabGroupIdentity(entry.group, false) === groupId && entry.url === tab.url) entry.group = null;
    }
    this.render();
    this.showTransientNotice(`This tab was removed from “${name}”.`);
    return true;
  }

  ungroupCurrentTab() {
    const tab = this.getActiveTab();
    return tab ? this.ungroupTab(tab.id) : false;
  }

  openTabGroupsSettings() {
    this.state.settingsActiveCategory = 'tab-groups';
    this.state.activeSettingsCategory = 'tab-groups';
    this.openInternalPage('yayra://settings');
  }

  renderTabGroupPickerList(container) {
    if (!container) return;
    container.innerHTML = '';
    const groups = this.getTabGroups();
    if (!groups.length) {
      const empty = document.createElement('p');
      empty.className = 'fb-tab-groups-empty';
      empty.textContent = 'No tab groups yet. Create one or group the current tab to get started.';
      container.appendChild(empty);
      return;
    }
    for (const group of groups) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fb-tab-group-picker-item';
      item.setAttribute('aria-label', `Open ${group.name} group (${group.tabs.length} tabs)`);
      const swatch = document.createElement('span');
      swatch.className = 'fb-tab-group-swatch';
      swatch.style.background = group.color;
      const copy = document.createElement('span');
      copy.className = 'fb-tab-group-picker-copy';
      const title = document.createElement('strong');
      title.textContent = group.name;
      const details = document.createElement('small');
      details.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? '' : 's'} · ${group.tabs.map((tab) => this.getTabTitle(tab)).join(', ')}`;
      const open = document.createElement('span');
      open.className = 'fb-tab-group-picker-open';
      open.textContent = group.tabs.length > 1 ? 'Open all' : 'Open';
      copy.appendChild(title);
      copy.appendChild(details);
      item.appendChild(swatch);
      item.appendChild(copy);
      item.appendChild(open);
      item.addEventListener('click', () => {
        this.closeModal();
        this.openTabGroup(group.id);
      });
      container.appendChild(item);
    }
  }

  renderTabGroupSettingsList(container) {
    if (!container) return;
    container.innerHTML = '';
    const groups = this.getTabGroups();
    if (!groups.length) {
      const empty = document.createElement('p');
      empty.className = 'fb-tab-groups-empty';
      empty.textContent = 'No tab groups yet. Create a group or add the current tab to one.';
      container.appendChild(empty);
      return;
    }
    for (const group of groups) {
      const card = document.createElement('article');
      card.className = 'fb-tab-group-settings-card';
      const header = document.createElement('div');
      header.className = 'fb-tab-group-settings-header';
      const swatch = document.createElement('span');
      swatch.className = 'fb-tab-group-swatch';
      swatch.style.background = group.color;
      const copy = document.createElement('span');
      copy.className = 'fb-tab-group-settings-copy';
      const title = document.createElement('strong');
      title.textContent = group.name;
      const details = document.createElement('small');
      details.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? '' : 's'}: ${group.tabs.map((tab) => this.getTabTitle(tab)).join(', ')}`;
      copy.appendChild(title);
      copy.appendChild(details);
      header.appendChild(swatch);
      header.appendChild(copy);
      const actions = document.createElement('div');
      actions.className = 'fb-tab-group-settings-actions';
      const makeAction = (className, label, action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `fb-btn fb-btn-secondary ${className}`;
        button.textContent = label;
        button.addEventListener('click', action);
        actions.appendChild(button);
      };
      makeAction('fb-tab-group-open-btn', 'Open group', () => this.openTabGroup(group.id));
      makeAction('fb-tab-group-rename-btn', 'Rename', () => this.renameTabGroup(group.id));
      makeAction('fb-tab-group-ungroup-btn', 'Ungroup', () => this.ungroupTabGroup(group.id));
      card.appendChild(header);
      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  renderTabGroupsModal(modal) {
    modal.className = 'fb-modal-card fb-tab-groups-modal';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.tabGroup} Tab groups</h2>
        <button class="fb-modal-close-btn" aria-label="Close tab groups">${Icons.close}</button>
      </div>
      <div class="fb-modal-body fb-tab-groups-modal-body">
        <p class="fb-tab-groups-modal-description">Choose a group to open all of its tabs. Tabs already open stay open; the first group tab becomes active.</p>
        <div class="fb-tab-groups-picker-list"></div>
        <div class="fb-tab-groups-modal-actions">
          <button class="fb-btn fb-btn-primary fb-tab-groups-create-btn">${Icons.plus} New group</button>
          <button class="fb-btn fb-btn-secondary fb-tab-groups-current-btn">${Icons.tabs} Group current tab</button>
          <button class="fb-btn fb-btn-secondary fb-tab-groups-manage-btn">Manage in Settings</button>
          ${this.getActiveTab()?.group ? '<button class="fb-btn fb-btn-secondary fb-tab-groups-ungroup-current-btn">Remove current tab from group</button>' : ''}
        </div>
      </div>
    `;
    this.renderTabGroupPickerList(modal.querySelector('.fb-tab-groups-picker-list'));
    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-tab-groups-create-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.createTabGroup();
    });
    modal.querySelector('.fb-tab-groups-current-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.groupCurrentTab();
    });
    modal.querySelector('.fb-tab-groups-manage-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.openTabGroupsSettings();
    });
    modal.querySelector('.fb-tab-groups-ungroup-current-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.ungroupCurrentTab();
    });
  }

  _nextTabGroupColor() {
    const used = new Set(this.state.tabs.map((t) => t.group && t.group.color).filter(Boolean));
    const free = BrowserShell.TAB_GROUP_COLORS.find((c) => !used.has(c));
    return free || BrowserShell.TAB_GROUP_COLORS[this.state.tabs.length % BrowserShell.TAB_GROUP_COLORS.length];
  }

  /** Create a named group from the active tab and a fresh tab in one render. */
  async createTabGroup() {
    const tab = this.getActiveTab();
    if (!tab) return false;
    const prompted = await this._textPromptDialog({
      title: 'New tab group',
      description: 'Give this group a name. The current tab and a fresh tab will be added.',
      placeholder: 'e.g. Research, Shopping, Work',
      initialValue: ''
    });
    if (prompted === null || prompted === undefined) return false;
    const groupName = String(prompted).replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!groupName) {
      this.showTransientNotice('Enter a name to create the tab group.');
      return false;
    }
    const existing = this.getTabGroups().find((candidate) =>
      candidate.isPrivate === Boolean(tab.isPrivate)
      && candidate.name.toLocaleLowerCase() === groupName.toLocaleLowerCase());
    const group = existing
      ? { name: existing.name, color: existing.color }
      : { name: groupName, color: this._nextTabGroupColor() };
    tab.group = group;
    this.createNewTab(Boolean(tab.isPrivate), { group, render: false });
    this.render();
    this.showTransientNotice(`Group “${group.name}” created with the current tab and a new tab.`);
    return true;
  }

  async groupTabWithPrompt(tabId, { title, description, placeholder, initialValue = '' } = {}) {
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    const prompted = await this._textPromptDialog({ title, description, placeholder, initialValue });
    if (prompted === null || prompted === undefined) return false;
    const groupName = String(prompted).replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!groupName) {
      this.showTransientNotice('Group name was empty - tab left ungrouped.');
      return false;
    }
    const existing = this.getTabGroups().find((candidate) =>
      candidate.isPrivate === Boolean(tab.isPrivate)
      && candidate.name.toLocaleLowerCase() === groupName.toLocaleLowerCase());
    const group = existing
      ? { name: existing.name, color: existing.color }
      : { name: groupName, color: this._nextTabGroupColor() };
    tab.group = group;
    this.render();
    this.showTransientNotice(`“${this.getTabTitle(tab)}” added to group “${group.name}”.`);
    return true;
  }

  /** Add a tab to a selected existing group without prompting. */
  addTabToExistingGroup(tabId, groupId) {
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    const group = this.getTabGroups().find((candidate) => candidate.id === groupId);
    if (!tab || !group || Boolean(tab.isPrivate) !== Boolean(group.isPrivate)) return false;
    if (this.tabGroupIdentity(tab.group, tab.isPrivate) === group.id) return true;
    tab.group = { name: group.name, color: group.color };
    this.render();
    this.showTransientNotice(`“${this.getTabTitle(tab)}” added to group “${group.name}”.`);
    return true;
  }

  /** Add the active tab to a named group (Chrome's "Group current tab"). */
  groupCurrentTab() {
    const tab = this.getActiveTab();
    if (!tab) return false;
    return this.groupTabWithPrompt(tab.id, {
      title: 'Group current tab',
      description: 'Give the group a name - tabs in it share a colour dot.',
      placeholder: 'e.g. Research',
      initialValue: tab.group ? tab.group.name : ''
    });
  }

  /** Create a group around the tab that was right-clicked in the strip. */
  createTabGroupForTab(tabId) {
    return this.groupTabWithPrompt(tabId, {
      title: 'Create tab group',
      description: 'Add this tab to a new group. You can add more tabs from their right-click menus.',
      placeholder: 'e.g. Research',
      initialValue: ''
    });
  }

  /** Remove every tab from its group (Chrome's "Ungroup"). */
  ungroupAllTabs() {
    let count = 0;
    const openMembers = new Set();
    for (const tab of this.state.tabs) {
      if (tab.group) {
        const id = this.tabGroupIdentity(tab.group, tab.isPrivate);
        openMembers.add(`${id}::${tab.url}`);
        tab.group = null;
        count += 1;
      }
    }
    for (const tab of this.state.tabGroupRestoreTabs || []) {
      if (tab.group) {
        const key = `${this.tabGroupIdentity(tab.group, false)}::${tab.url}`;
        if (!openMembers.has(key)) count += 1;
        tab.group = null;
      }
    }
    for (const tab of this.state.continueTabs || []) tab.group = null;
    this.render();
    this.showTransientNotice(count > 0
      ? `${count} tab${count === 1 ? '' : 's'} removed from their group${count === 1 ? '' : 's'}.`
      : 'No grouped tabs to ungroup.');
  }

  /**
   * Translate the current page via Google's translate.goog proxy (the
   * current "translate this page" mechanism; the old
   * translate.google.com/translate?u= endpoint is dead). Prompts for the
   * target language, defaults to English.
   */
  buildTranslatedPageUrl(url, targetLang = 'en') {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
      if (u.hostname.endsWith('.translate.goog')) return null; // already translated
      const host = `${u.hostname.replace(/-/g, '--').replace(/\./g, '-')}.translate.goog`;
      const out = new URL(`${u.protocol}//${host}${u.pathname}${u.search}`);
      out.searchParams.set('_x_tr_sl', 'auto');
      out.searchParams.set('_x_tr_tl', String(targetLang || 'en').slice(0, 8));
      out.searchParams.set('_x_tr_hl', 'en');
      out.searchParams.set('_x_tr_pto', 'wapp');
      out.searchParams.set('_x_tr_u', url);
      return out.toString();
    } catch {
      return null;
    }
  }

  async translateActivePage() {
    const tab = this.getActiveTab();
    if (!tab || !/^https?:\/\//i.test(String(tab.url || ''))) {
      this.showTransientNotice('Open a web page first - internal pages can\'t be translated.');
      return;
    }
    const lang = await this._textPromptDialog({
      title: 'Translate this page',
      description: 'Translate the current page with Google Translate.',
      placeholder: 'Two-letter language code, e.g. en, fr, es, sw',
      initialValue: 'en'
    });
    if (lang === null) return;
    const target = String(lang || '').trim().toLowerCase() || 'en';
    const translated = this.buildTranslatedPageUrl(tab.url, target);
    if (!translated) {
      this.showTransientNotice('This page can\'t be translated.');
      return;
    }
    this.navigateActiveTab(translated);
    this.showTransientNotice(`Translating this page to \u201C${target}\u201D\u2026`);
  }

  /** The focused editable field, or null (shared by cut/copy/paste). */
  _focusedEditableField() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly ? el : null;
  }

  /** Whatever text is currently selected: page selection, or the selection
   *  inside the focused Yayra field. '' when nothing is selected. */
  _currentSelectionText() {
    try {
      if (typeof document !== 'undefined' && typeof document.getSelection === 'function') {
        const sel = String(document.getSelection() || '');
        if (sel) return sel;
      }
    } catch { /* shim without getSelection */ }
    const el = this._focusedEditableField();
    if (el) {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        return el.value.slice(start, end);
      }
    }
    return '';
  }

  /**
   * Menu > Copy: the modern way - the current selection via the async
   * clipboard API (execCommand('copy') is legacy and unreliable). Honest
   * notices when nothing is selected or the browser blocks the clipboard.
   */
  async copySelectionToClipboard() {
    const text = this._currentSelectionText();
    if (!text) {
      this.showTransientNotice('Select some text first - then Copy (or press Ctrl+C).');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.showTransientNotice('Copied to the clipboard.');
    } catch {
      this.showTransientNotice('This browser blocked clipboard access - press Ctrl+C instead.');
    }
  }

  /**
   * Menu > Cut: copies the current selection and removes it - fully works
   * inside Yayra's own text fields; page text (cross-origin) can only be
   * copied, never removed, and the user is told exactly that.
   */
  async cutSelectionToClipboard() {
    const text = this._currentSelectionText();
    if (!text) {
      this.showTransientNotice('Select some text first - then Cut (or press Ctrl+X).');
      return;
    }
    const el = this._focusedEditableField();
    try {
      await navigator.clipboard.writeText(text);
      if (el) {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        if (end > start) {
          el.value = el.value.slice(0, start) + el.value.slice(end);
          if (typeof Event === 'function') el.dispatchEvent?.(new Event('input', { bubbles: true }));
        }
        this.showTransientNotice('Cut to the clipboard.');
        return;
      }
      this.showTransientNotice('Copied - page text can\u2019t be removed from a website, only Yayra\u2019s own fields can be cut.');
    } catch {
      this.showTransientNotice('This browser blocked clipboard access - press Ctrl+X instead.');
    }
  }

  /**
   * Menu > Paste: execCommand('paste') is dead in every modern browser
   * (pages may never read the clipboard without a user gesture + the async
   * clipboard API). Do the real thing: read the clipboard (the browser
   * asks permission) and insert into the focused editable field; if no
   * Yayra field is focused, tell the user exactly what to do.
   */
  async pasteIntoFocusedField() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly ? el : null;
    if (!editable) {
      this.showTransientNotice('Tap into a text field first, then use Paste (or press Ctrl+V).');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        this.showTransientNotice('The clipboard is empty.');
        return;
      }
      const start = editable.selectionStart ?? editable.value.length;
      const end = editable.selectionEnd ?? editable.value.length;
      editable.value = editable.value.slice(0, start) + text + editable.value.slice(end);
      if (typeof Event === 'function') editable.dispatchEvent?.(new Event('input', { bubbles: true }));
      this.showTransientNotice('Pasted from the clipboard.');
    } catch {
      this.showTransientNotice('This browser blocked clipboard access - click the field and press Ctrl+V.');
    }
  }

  /**
   * The REAL top-5 most visited sites for the current profile, computed
   * from actual history (visit counts). Empty on a fresh install or a
   * brand-new profile - nothing is invented.
   */
  getFrequentSites() {
    const items = this.state.historyItems || [];
    return items
      .filter((i) => /^https?:\/\//i.test(String(i && i.url || '')))
      .slice()
      .sort((a, b) => ((Number(b.visitCount) || 1) - (Number(a.visitCount) || 1))
        || ((b.lastVisitedAt || 0) - (a.lastVisitedAt || 0)))
      .slice(0, 5);
  }

  /** Real favicon for a frequent-site tile, letter badge as fallback. */
  frequentSiteIconHtml(site) {
    let host = '';
    try { host = new URL(site.url).hostname; } catch { host = ''; }
    const letter = String(site.title || host || '?').trim().charAt(0).toUpperCase() || '?';
    const badge = `<span class="fb-frequent-letter" style="display:none;font:700 18px/1 system-ui;">${letter}</span>`;
    if (!host) return badge.replace('display:none;', '');
    return `<img src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" style="width:24px;height:24px;border-radius:6px;" `
      + `onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='';" />${badge}`;
  }

  /**
   * Re-pull history into state after a visit was recorded, so the new
   * tab page's frequent sites / recent history stay current without
   * forcing a re-render mid-navigation.
   */
  refreshHistoryState() {
    if (!this.historyRepo || typeof this.historyRepo.getEntries !== 'function') return;
    try {
      this.historyRepo.getEntries(100).then((items) => {
        this.state.historyItems = items || [];
      }).catch(() => {});
    } catch { /* repo unavailable */ }
  }

  /* -------------------------------------------------------------
   * CHROME-STYLE LIVE PAGES
   * -----------------------------------------------------------
   * Internal pages (history, bookmarks, downloads, the new tab page's
   * frequent sites, settings) keep themselves fresh in the background -
   * exactly like Chrome, where chrome://history or the downloads page
   * update live while you browse in another tab or window. Two signals:
   *  - a light poll (few seconds) re-reads the per-profile stores;
   *  - the browser's `storage` event gives INSTANT updates when another
   *    Yayra window of the same profile writes (mini shell, second
   *    window) - storage events only fire cross-window, never for this
   *    window's own writes, which the poll covers.
   * Repaints are smart, not blind: only when the data actually changed,
   * only when a live-data page is visible, never over an open menu or
   * modal, and never while the user is typing in an input. Real
   * websites are NOT reloaded - like Chrome, background tabs stay alive
   * untouched (pooled frames / native views).
   * ----------------------------------------------------------- */
  /**
   * Rolling "tabs that are still open" snapshot (profile-scoped). A tab
   * the user closes by hand leaves state.tabs and therefore the
   * snapshot - so whatever the snapshot holds when the app dies (quit,
   * crash, tray exit) is exactly "the tabs that were NOT closed
   * manually", which the next launch offers as "Continue with these
   * tabs". Debounced + JSON-compared so render() can call it freely.
   */
  queueSessionSnapshot() {
    if (!this.sessionRepo || typeof this.sessionRepo.saveSession !== 'function') return;
    if (typeof setTimeout !== 'function') return;
    // The bubble's mini panel runs its OWN shell over the SAME profile
    // storage: letting it snapshot its (empty) tab list silently wiped
    // the main window's last session every time the bubble was used -
    // the "recover recent tabs never comes" bug.
    if (this.options?.isMiniShell) return;
    const tabs = (this.state.tabs || [])
      .filter((t) => t && !t.isPrivate && /^https?:\/\//i.test(String(t.url || '')))
      .map((t) => {
        const group = this.sanitizeTabGroup(t.group);
        return { url: t.url, title: t.title || t.url, ...(group ? { group } : {}) };
      });
    // Launch-wipe protection: a fresh run opens on a lone newtab, and
    // 600ms later used to OVERWRITE the previous session's snapshot
    // with [] - if the user quit again without browsing (or the app
    // auto-reopened after an update), the recover offer was gone
    // forever. While the offer is still pending and this run has not
    // browsed anywhere yet, the on-disk snapshot is left untouched.
    if (tabs.length === 0 && !this._sessionHadRealTabs && (this.state.continueTabs || []).length > 0) return;
    if (tabs.length > 0) this._sessionHadRealTabs = true;
    const json = JSON.stringify(tabs);
    if (json === this._lastSessionSnapshotJson) return;
    this._lastSessionSnapshotJson = json;
    if (this._sessionSnapshotTimer) clearTimeout(this._sessionSnapshotTimer);
    this._sessionSnapshotTimer = setTimeout(() => {
      this._sessionSnapshotTimer = null;
      Promise.resolve(this.sessionRepo.saveSession(tabs)).catch(() => {});
    }, 600);
    if (typeof this._sessionSnapshotTimer?.unref === 'function') this._sessionSnapshotTimer.unref();
  }

  startBackgroundRefresh() {
    if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
    if (this._bgRefreshTimer) return;
    // 15s poll is the safety net; the 'storage' listener below is the
    // real-time path for same-profile changes. (The old 4s cadence
    // re-parsed history/bookmarks/downloads/settings/shortcuts almost
    // constantly - steady background churn for zero visible benefit.)
    this._bgRefreshTimer = window.setInterval(() => {
      // A hidden/minimized window repaints nothing - skip the whole pass.
      if (typeof document !== 'undefined' && document.hidden === true) return;
      this.backgroundRefreshTick().catch(() => {});
    }, 15000);
    // DELIBERATELY NO background-tab reload timer. Chrome never reloads a
    // loaded page: it stays exactly as the user left it - intact, alive and
    // instantly interactive on switch-back. Auto-reloading background tabs
    // (the old behaviour) destroyed SPA state, logged sessions out, and on
    // suspended mobile WebViews left half-discarded dead pages behind.
    // Frame memory is bounded the Chrome way instead: the pooled-frame LRU
    // in mountPooledWebFrame() discards only under real pressure and only
    // reloads a discarded tab ON SWITCH-BACK, visibly, never in background.
    this._bgStorageListener = (e) => {
      // Another same-profile window wrote shared state - sync right away.
      if (e && e.key && !String(e.key).startsWith('yayra')) return;
      this.backgroundRefreshTick().catch(() => {});
    };
    window.addEventListener('storage', this._bgStorageListener);
  }

  /**
   * Chrome-style tab keep-alive: a loaded page is NEVER reloaded in the
   * background - it stays exactly as the user left it (scroll position,
   * SPA state, playing media, open menus), instantly interactive the
   * moment they switch back. Memory is bounded by the pooled-frame LRU
   * cap in mountPooledWebFrame() (the Chrome "memory saver" equivalent:
   * discard only under pressure, reload only on the user's return, never
   * behind their back). Refreshing happens ONLY on explicit user action:
   * the reload button, F5/Ctrl-R, or the Refresh-all menu item.
   */

  stopBackgroundRefresh() {
    if (this._bgRefreshTimer && typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
      window.clearInterval(this._bgRefreshTimer);
    }
    this._bgRefreshTimer = null;
    if (this._bgStorageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this._bgStorageListener);
      this._bgStorageListener = null;
    }
  }

  /** One background sync pass: re-read stores, repaint only on change. */
  async backgroundRefreshTick() {
    if (this._bgRefreshBusy) return false;
    this._bgRefreshBusy = true;
    try {
      const fresh = {};
      if (this.historyRepo?.getEntries) {
        try { fresh.history = await this.historyRepo.getEntries(100); } catch { /* keep current */ }
      }
      if (this.bookmarksRepo?.getAllBookmarks) {
        try { fresh.bookmarks = await this.bookmarksRepo.getAllBookmarks(); } catch { /* keep current */ }
        if (this.bookmarksRepo.getGroups) {
          try { fresh.bookmarkGroups = await this.bookmarksRepo.getGroups(); } catch { /* keep current */ }
        }
        if (this.bookmarksRepo.getDefaultGroupId) {
          try { fresh.bookmarkDefaultGroupId = await this.bookmarksRepo.getDefaultGroupId(); } catch { /* keep current */ }
        }
      }
      if (this.downloadsBridge?.list) {
        try {
          const { items, downloadRoot } = await this.downloadsBridge.list();
          fresh.downloads = items || [];
          fresh.downloadRoot = downloadRoot || null;
        } catch { /* keep current */ }
      }
      if (this.settingsRepo?.getSettings) {
        try { fresh.settings = await this.settingsRepo.getSettings(); } catch { /* keep current */ }
      }
      if (this.shortcutsRepo?.getShortcuts) {
        try { fresh.shortcuts = await this.shortcutsRepo.getShortcuts(); } catch { /* keep current */ }
      }

      const snapshot = JSON.stringify([fresh.history, fresh.bookmarks, fresh.bookmarkGroups, fresh.bookmarkDefaultGroupId, fresh.downloads, fresh.settings, fresh.shortcuts]);
      if (snapshot === this._bgRefreshSnapshot) return false;
      const isFirstPass = this._bgRefreshSnapshot === undefined;
      this._bgRefreshSnapshot = snapshot;

      if (fresh.history) this.state.historyItems = fresh.history;
      if (fresh.bookmarks) this.state.bookmarksItems = fresh.bookmarks;
      if (fresh.bookmarkGroups) this.state.bookmarkGroups = fresh.bookmarkGroups;
      if (fresh.bookmarkDefaultGroupId) this.state.bookmarkDefaultGroupId = fresh.bookmarkDefaultGroupId;
      if (fresh.downloads) this.state.downloadsItems = fresh.downloads;
      if (fresh.downloadRoot !== undefined) this.state.downloadRoot = fresh.downloadRoot;
      if (fresh.settings) this.state.settings = { ...this.state.settings, ...fresh.settings };
      if (fresh.shortcuts) this.state.userShortcuts = fresh.shortcuts;

      // The very first pass just seeds the snapshot - initialize()
      // already rendered this exact data.
      if (!isFirstPass) this.maybeRepaintAfterBackgroundSync();
      return true;
    } finally {
      this._bgRefreshBusy = false;
    }
  }

  /** Repaint after a background sync ONLY when it's safe and useful. */
  maybeRepaintAfterBackgroundSync() {
    const tab = this.getActiveTab();
    if (!tab) return false;
    const url = String(tab.url || '');
    const livePages = ['yayra://history', 'yayra://bookmarks', 'yayra://downloads', 'yayra://newtab'];
    if (!livePages.some((p) => url === p || url.startsWith(`${p}?`))) return false;
    // Never repaint over an open menu/modal/find bar - and never yank
    // the cursor out from under someone typing (e.g. the history search).
    if (this.hasBlockingOverlay()) return false;
    if (typeof document !== 'undefined') {
      const ae = document.activeElement;
      const tag = ae && ae.tagName ? String(ae.tagName).toLowerCase() : '';
      // A focused EMPTY input is fine (the new tab page auto-focuses its
      // search box); only actual typed-in content blocks the repaint.
      if ((tag === 'input' || tag === 'textarea') && String(ae.value || '').length > 0) return false;
    }
    this.render();
    return true;
  }

  /** The real bookmarks bar strip rendered under the toolbar. */
  renderBookmarksBar() {
    const bar = document.createElement('div');
    bar.className = 'fb-bookmarks-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 10px;overflow-x:auto;white-space:nowrap;background:var(--fb-bg-elevated,rgba(255,255,255,0.03));border-bottom:1px solid var(--fb-border,rgba(255,255,255,0.07));min-height:28px;';
    const allItems = this.state.bookmarksItems || [];
    const items = allItems.filter((bookmark) => (bookmark.groupId || DEFAULT_BOOKMARK_GROUP_ID) === DEFAULT_BOOKMARK_GROUP_ID);
    if (!items.length) {
      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:0.75rem;color:var(--fb-text-secondary,#9ca3af);padding:2px 6px;';
      hint.textContent = allItems.length
        ? 'No bookmarks in Bookmarks Bar - choose that group to pin a page here.'
        : 'No bookmarks yet - star a page and it shows up here.';
      bar.appendChild(hint);
      return bar;
    }
    for (const bm of items.slice(0, 30)) {
      let host = '';
      try { host = new URL(bm.url).hostname; } catch { host = ''; }
      const chip = document.createElement('button');
      chip.className = 'fb-bookmarks-bar-item';
      chip.title = bm.url;
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;max-width:170px;padding:3px 8px;border:none;border-radius:8px;background:transparent;color:var(--fb-text-primary,#e8eaf0);cursor:pointer;font:500 12px/1.2 system-ui;overflow:hidden;';
      chip.innerHTML = `${host ? `<img src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" style="width:14px;height:14px;border-radius:4px;flex:none;" onerror="this.remove()" />` : ''}<span style="overflow:hidden;text-overflow:ellipsis;">${String(bm.title || bm.url).replace(/</g, '&lt;')}</span>`;
      chip.addEventListener('click', () => this.navigateActiveTab(bm.url));
      bar.appendChild(chip);
    }
    return bar;
  }

  /** Name window... - a real dialog + real window title change. */
  async nameThisWindow() {
    const current = this.state.windowName || '';
    const name = await this._textPromptDialog({
      title: 'Name this window',
      description: 'The name shows in the window title so you can tell your Yayra windows apart.',
      placeholder: 'e.g. Work, Research, Shopping',
      initialValue: current
    });
    if (name === null) return;
    this.state.windowName = name;
    if (typeof document !== 'undefined') document.title = name ? `${name} - yayra` : 'yayra';
    this.showTransientNotice(`Window named "${name}".`);
  }

  /* -------------------------------------------------------------
   * REQUIREMENT 1, 2, 4, 6: FULL INDEPENDENT FLOATING MINI-BROWSER
   * ----------------------------------------------------------- */
  openFloatingMini(url = null) {
    this.state.isFloatingMiniOpen = true;
    if (url) {
      this.navigateActiveTab(url);
    }
    this.render();
  }

  closeFloatingMini() {
    this.state.isFloatingMiniOpen = false;
    const existing = document.getElementById('yayra-floating-popup-window');
    if (existing) existing.remove();
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.fb-duplicate-popup-window').forEach((w) => w.remove());
    }
  }

  duplicateFloatingMini() {
    this.openFloatingMini();
    if (typeof document === 'undefined') return;
    const existingWindows = document.querySelectorAll('.fb-floating-popup-window');
    const dupCount = existingWindows.length;
    const offset = dupCount * 28;

    const dupWin = document.createElement('div');
    dupWin.className = 'fb-floating-popup-window fb-duplicate-popup-window';
    dupWin.style.bottom = `${84 + offset}px`;
    dupWin.style.right = `${24 + offset}px`;
    dupWin.style.zIndex = String(99998 + dupCount);

    const activeTab = this.getActiveTab();

    dupWin.innerHTML = `
      <header class="fb-floating-popup-header">
        <div class="fb-floating-popup-brand">
          <span style="width:20px; height:20px; display:inline-flex;">${Icons.officialOrb}</span>
          <span>yayra mini #${dupCount + 1}</span>
        </div>
        <div class="fb-floating-popup-actions">
          <button class="fb-floating-popup-btn primary-expand fb-open-full-btn" title="Open Full Yayra Browser">${Icons.expand}</button>
          <button class="fb-floating-popup-btn fb-mini-close-btn" title="Close">${Icons.close}</button>
        </div>
      </header>
      <div class="fb-floating-popup-body">
        <div style="display:flex; align-items:center; gap:8px; padding:6px 10px; background:rgba(0,0,0,0.3); border-bottom:1px solid rgba(255,255,255,0.08);">
          <input type="text" class="fb-input fb-mini-omnibox" value="${this.getDisplayUrl(activeTab.url)}" placeholder="Search or type address" style="flex:1; height:30px; font-size:0.825rem;" />
        </div>
        <div class="fb-mini-viewport" style="flex:1; display:flex; flex-direction:column; overflow:hidden;"></div>
      </div>
    `;

    const dupViewportUrl = activeTab.url && !activeTab.url.startsWith('yayra://') ? activeTab.url : 'about:blank';
    if (dupViewportUrl !== 'about:blank') {
      const { wrapper } = this.createWebContentFrame(dupViewportUrl);
      dupWin.querySelector('.fb-mini-viewport')?.appendChild(wrapper);
    }

    dupWin.querySelector('.fb-open-full-btn')?.addEventListener('click', () => {
      dupWin.remove();
      this.restoreFromBubble();
    });
    dupWin.querySelector('.fb-mini-close-btn')?.addEventListener('click', () => {
      dupWin.remove();
    });

    this.makeDraggable(dupWin, dupWin.querySelector('.fb-floating-popup-header'));
    document.body.appendChild(dupWin);
  }

  makeDraggable(element, handle) {
    if (!handle || !element) return;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target && (e.target.closest('button') || e.target.closest('input'))) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { left: 100, top: 100 };
      initialLeft = rect.left;
      initialTop = rect.top;
      element.style.left = `${initialLeft}px`;
      element.style.top = `${initialTop}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      if (handle.setPointerCapture && e.pointerId) handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      if (typeof window !== 'undefined') {
        newLeft = Math.max(10, Math.min(window.innerWidth - (element.offsetWidth || 400) - 10, newLeft));
        newTop = Math.max(10, Math.min(window.innerHeight - (element.offsetHeight || 500) - 10, newTop));
      }

      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
    });

    const stopDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      if (handle.releasePointerCapture && e?.pointerId) handle.releasePointerCapture(e.pointerId);
    };

    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
  }

  toggleMiniDrawer(win) {
    const body = win?.querySelector('.fb-floating-popup-body');
    if (!body) return;
    const current = body.querySelector('.fb-side-drawer-menu');
    if (current) {
      this.state.isSideDrawerOpen = false;
      current.remove();
      return;
    }
    this.state.isSideDrawerOpen = true;
    this.renderSideDrawer(body);
  }

  renderFloatingMiniWindow() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('yayra-floating-popup-window');
    if (existing) existing.remove();

    const win = document.createElement('div');
    win.id = 'yayra-floating-popup-window';
    win.className = 'fb-floating-popup-window';

    const activeTab = this.getActiveTab();

    win.innerHTML = `
      <header class="fb-floating-popup-header">
        <div class="fb-floating-popup-brand">
          <span style="width:20px; height:20px; display:inline-flex;">${Icons.officialOrb}</span>
          <span>yayra mini</span>
        </div>
        <div class="fb-floating-popup-actions">
          <button class="fb-floating-popup-btn fb-mini-duplicate-btn" title="Duplicate Mini Window">${Icons.tabs}</button>
          <button class="fb-floating-popup-btn primary-expand fb-open-full-btn" title="Open Full Yayra Browser">${Icons.expand}</button>
          <button class="fb-floating-popup-btn fb-mini-min-btn" title="Minimize to Bubble">${Icons.minimize}</button>
          <button class="fb-floating-popup-btn fb-mini-close-btn" title="Close">${Icons.close}</button>
        </div>
      </header>
      <div class="fb-mini-tabstrip fb-chrome-tabstrip" role="tablist" aria-label="Mini browser tabs">
        <div class="fb-tabs-scroll-container">
          ${this.state.tabs.map((tab) => `
            <div class="fb-tab-item fb-mini-tab-item ${tab.id === this.state.activeTabId ? 'active' : ''}" role="tab" aria-selected="${tab.id === this.state.activeTabId ? 'true' : 'false'}" data-tab-id="${tab.id}">
              <span class="fb-tab-favicon">${this.getTabFavicon(tab)}</span>
              ${tab.group && tab.group.color ? `<span class="fb-tab-group-dot" style="background:${tab.group.color}"></span>` : ''}
              <span class="fb-tab-title">${tab.title || 'New Tab'}</span>
              <button class="fb-tab-close-btn fb-mini-tab-close" data-tab-id="${tab.id}" title="Close tab" aria-label="Close tab">${Icons.close}</button>
            </div>
          `).join('')}
          <button class="fb-btn-newtab fb-mini-newtab-btn" title="New Tab (Ctrl+T)" aria-label="Create new tab">${Icons.plus}</button>
        </div>
      </div>
      <nav class="fb-mini-navbar fb-chrome-navbar" role="toolbar" aria-label="Mini navigation and address bar">
        <div class="fb-nav-controls">
          <button class="fb-nav-btn fb-mini-back-btn" title="Back" aria-label="Back" ${activeTab.canGoBack ? '' : 'disabled'}>${Icons.arrowLeft}</button>
          <button class="fb-nav-btn fb-mini-fwd-btn" title="Forward" aria-label="Forward" ${activeTab.canGoForward ? '' : 'disabled'}>${Icons.arrowRight}</button>
          <button class="fb-nav-btn fb-mini-reload-btn" title="Reload" aria-label="Reload">${Icons.refresh}</button>
        </div>
        <div class="fb-omnibox-container fb-mini-omnibox-container">
          <div class="fb-toolbar-brand" title="Yayra">
            <span class="fb-toolbar-brand-orb">${Icons.officialOrb}</span>
            <span class="fb-toolbar-brand-text">${Icons.officialWordmark}<span class="fb-brand-text-fallback">yayra</span></span>
          </div>
          <button class="fb-omnibox-security fb-mini-security-btn" title="Site security" aria-label="Site security">${activeTab.isSecure ? Icons.lock : Icons.alertTriangle}</button>
          <button class="fb-omnibox-group-btn fb-mini-group-btn${activeTab.group ? ' is-grouped' : ''}" title="Tab groups" aria-label="Open tab groups" aria-haspopup="dialog">${Icons.tabGroup}</button>
          <input type="text" class="fb-omnibox-input fb-mini-omnibox" value="${this.getDisplayUrl(activeTab.url)}" placeholder="Search with ${(this.state.settings.searchEngine || 'Google').replace(/^./, (letter) => letter.toUpperCase())} or enter address" aria-label="Mini address and search bar" />
          <button class="fb-omnibox-star fb-mini-star-btn" title="Bookmark" aria-label="Bookmark">${this.state.isBookmarked ? Icons.starFilled : Icons.star}</button>
        </div>
        <div class="fb-toolbar-actions">
          <button class="fb-action-btn fb-toolbar-action-btn fb-mini-download-btn" title="Downloads" aria-label="Downloads">${Icons.download}</button>
          <button class="fb-action-btn fb-toolbar-action-btn fb-mini-extensions-btn" title="Extensions and Shields" aria-label="Extensions and Shields">${Icons.shield}</button>
          ${this.authBridge ? `<button class="fb-action-btn fb-toolbar-action-btn fb-account-btn fb-mini-account-btn" title="Yayra account" aria-label="Account">${this.renderAccountAvatarHtml(this.state.googleAccount?.signedIn ? this.state.googleAccount.profile : null, 22)}</button>` : ''}
          <button class="fb-action-btn fb-menu-btn fb-toolbar-action-btn fb-mini-drawer-btn" title="Customize and control Yayra" aria-label="Main menu">${Icons.moreVertical}</button>
        </div>
      </nav>
      <div class="fb-floating-popup-body">
        <div class="fb-mini-viewport" style="flex:1; display:flex; flex-direction:column; overflow-y:auto; position:relative;"></div>
      </div>
    `;

    // Make movable anywhere on screen
    this.makeDraggable(win, win.querySelector('.fb-floating-popup-header'));

    // Header buttons
    win.querySelector('.fb-mini-duplicate-btn')?.addEventListener('click', () => {
      this.duplicateFloatingMini();
    });

    win.querySelector('.fb-open-full-btn')?.addEventListener('click', () => {
      this.closeFloatingMini();
      this.restoreFromBubble();
    });

    win.querySelector('.fb-mini-min-btn')?.addEventListener('click', () => {
      this.closeFloatingMini();
      this.minimizeToBubble();
    });

    win.querySelector('.fb-mini-close-btn')?.addEventListener('click', () => {
      this.closeFloatingMini();
    });

    // Toolbar Navigation
    win.querySelector('.fb-mini-back-btn')?.addEventListener('click', () => {
      this.goBack();
      this.render();
    });

    win.querySelector('.fb-mini-fwd-btn')?.addEventListener('click', () => {
      this.goForward();
      this.render();
    });

    win.querySelector('.fb-mini-reload-btn')?.addEventListener('click', () => {
      this.reload();
    });

    win.querySelector('.fb-mini-star-btn')?.addEventListener('click', async () => {
      await this.toggleBookmarkCurrentTab();
      this.render();
    });

    win.querySelector('.fb-mini-download-btn')?.addEventListener('click', () => {
      this.openInternalPage('yayra://downloads');
    });

    win.querySelector('.fb-mini-extensions-btn')?.addEventListener('click', () => {
      this.openInternalPage('yayra://extensions');
    });

    win.querySelector('.fb-mini-group-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openModal('tab-groups');
    });

    win.querySelector('.fb-mini-security-btn')?.addEventListener('click', () => {
      const existingDropdown = win.querySelector('.fb-security-dropdown');
      if (existingDropdown) {
        existingDropdown.remove();
        this.state.isSecurityDropdownOpen = false;
      } else {
        this.state.isSecurityDropdownOpen = true;
        this.renderSecurityDropdown(win);
      }
    });

    win.querySelector('.fb-mini-account-btn')?.addEventListener('click', () => {
      const existingDropdown = win.querySelector('.fb-account-dropdown');
      if (existingDropdown) {
        existingDropdown.remove();
        this.state.isAccountMenuOpen = false;
      } else {
        this.state.isAccountMenuOpen = true;
        this.renderAccountDropdown(win);
      }
    });

    win.querySelectorAll('.fb-mini-tab-item').forEach((tabEl) => {
      tabEl.addEventListener('click', (event) => {
        if (event.target.closest('.fb-mini-tab-close')) return;
        this.selectTab(tabEl.dataset.tabId);
      });
    });

    win.querySelectorAll('.fb-mini-tab-close').forEach((closeBtn) => {
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeTab(closeBtn.dataset.tabId);
      });
    });

    win.querySelector('.fb-mini-newtab-btn')?.addEventListener('click', () => {
      this.createNewTab();
    });

    win.querySelector('.fb-mini-drawer-btn')?.addEventListener('click', () => {
      this.toggleMiniDrawer(win);
    });

    const omni = win.querySelector('.fb-mini-omnibox');
    omni?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigateActiveTab(omni.value);
        this.renderFloatingMiniWindow();
      }
    });
    this.bindSearchSuggestions(omni);

    // Render In-Mini Viewport Content (Full features of Yayra)
    const miniViewport = win.querySelector('.fb-mini-viewport');
    if (miniViewport) {
      const url = activeTab.url || '';
      if (!url || url === 'yayra://newtab' || url === 'about:blank') {
        this.renderNewTabPage(miniViewport, activeTab);
      } else if (url === 'yayra://settings') {
        this.renderInternalSettingsPage(miniViewport, activeTab);
      } else if (url === 'yayra://history') {
        this.renderInternalHistoryPage(miniViewport, activeTab);
      } else if (url === 'yayra://bookmarks') {
        this.renderInternalBookmarksPage(miniViewport, activeTab);
      } else if (url === 'yayra://downloads') {
        this.renderInternalDownloadsPage(miniViewport, activeTab);
      } else if (url === 'yayra://passwords') {
        this.renderInternalPasswordsPage(miniViewport, activeTab);
      } else if (url === 'yayra://extensions') {
        this.renderInternalExtensionsPage(miniViewport, activeTab);
      } else if (url === 'yayra://permissions') {
        this.renderInternalPermissionsPage(miniViewport, activeTab);
      } else if (url === 'yayra://ai' || url.startsWith('yayra://ai?')) {
        this.renderInternalAiPage(miniViewport, activeTab);
      } else if (url === 'yayra://about') {
        this.renderInternalAboutPage(miniViewport, activeTab);
      } else {
        const { wrapper } = this.createWebContentFrame(activeTab.url);
        miniViewport.appendChild(wrapper);
      }
    }

    document.body.appendChild(win);
  }

  /* -------------------------------------------------------------
   * REQUIREMENT 3: SECURITY & SEARCH ENGINE DROPDOWN
   * ----------------------------------------------------------- */
  // Shared full-viewport scrim for lightweight dropdowns (security badge,
  // account menu). Unlike a plain "click outside" listener, this is a real
  // element that sits above everything else except the main side drawer, so
  // it reliably captures the click/scroll instead of letting it fall
  // through to whatever is rendered underneath - exactly how Chrome's own
  // toolbar dropdowns behave.
  appendDropdownScrim(root, onClose) {
    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.className = 'fb-dropdown-scrim';
    scrim.setAttribute('aria-label', 'Close menu');
    scrim.addEventListener('click', onClose);
    // A right-click (or long-press context menu) anywhere outside must
    // dismiss the open menu too - exactly like native browser menus.
    scrim.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onClose(e);
    });
    root.appendChild(scrim);
    return scrim;
  }

  renderSecurityDropdown(root) {
    this.appendDropdownScrim(root, () => {
      this.state.isSecurityDropdownOpen = false;
      this.render();
    });

    const dropdown = document.createElement('div');
    dropdown.className = 'fb-security-dropdown';

    const currentEngine = this.state.settings.searchEngine || 'google';

    dropdown.innerHTML = `
      <div class="fb-security-header">
        <span>${Icons.lock}</span>
        <span>Connection is Secure (HTTPS)</span>
      </div>

      <div>
        <strong style="display:block; font-size:0.8rem; color:var(--fb-text-muted); text-transform:uppercase; margin-bottom:6px;">Default Search Engine</strong>
        <div class="fb-search-engine-list">
          <div class="fb-search-engine-option ${currentEngine === 'google' ? 'active' : ''}" data-engine="google">
            <span>Google</span>
            ${currentEngine === 'google' ? `<span>${Icons.check}</span>` : ''}
          </div>
          <div class="fb-search-engine-option ${currentEngine === 'duckduckgo' ? 'active' : ''}" data-engine="duckduckgo">
            <span>DuckDuckGo</span>
            ${currentEngine === 'duckduckgo' ? `<span>${Icons.check}</span>` : ''}
          </div>
          <div class="fb-search-engine-option ${currentEngine === 'bing' ? 'active' : ''}" data-engine="bing">
            <span>Bing</span>
            ${currentEngine === 'bing' ? `<span>${Icons.check}</span>` : ''}
          </div>
          <div class="fb-search-engine-option ${currentEngine === 'startpage' ? 'active' : ''}" data-engine="startpage">
            <span>Startpage</span>
            ${currentEngine === 'startpage' ? `<span>${Icons.check}</span>` : ''}
          </div>
        </div>
      </div>

      <div style="border-top:1px solid rgba(255,255,255,0.08); padding-top:8px; display:flex; flex-direction:column; gap:6px;">
        <button class="fb-btn fb-btn-secondary fb-in-view-certs-btn" style="width:100%; font-size:0.8rem;">Site Permissions</button>
      </div>
    `;

    dropdown.querySelectorAll('.fb-search-engine-option').forEach((opt) => {
      opt.addEventListener('click', async () => {
        const engine = opt.dataset.engine;
        this.state.settings.searchEngine = engine;
        if (this.settingsRepo) {
          await this.settingsRepo.updateSettings({ searchEngine: engine });
        }
        this.state.isSecurityDropdownOpen = false;
        this.render();
      });
    });

    dropdown.querySelector('.fb-in-view-certs-btn')?.addEventListener('click', () => {
      this.state.isSecurityDropdownOpen = false;
      this.openInternalPage('yayra://permissions');
    });

    root.appendChild(dropdown);
  }

  /* -------------------------------------------------------------
   * PERSISTENT TOP-RIGHT ACCOUNT DROPDOWN
   * ----------------------------------------------------------- */
  /* -------------------------------------------------------------
   * BROWSER PROFILES - "KEEP YOUR BROWSING SEPARATE"
   * -----------------------------------------------------------
   * Chrome-style smart separation: when a sign-in happens with an
   * account that is NOT the one this profile belongs to, Yayra offers a
   * separate profile instead of silently mixing two people's cookies,
   * logins and saved passwords. Decision table + no-nag memory live in
   * profileService.js; on Electron each profile is a REAL separate
   * Chromium session partition (electron/webviewBridge.cjs).
   * ----------------------------------------------------------- */
  handleAccountSignal(email, { source = 'unknown' } = {}) {
    if (!this.profileService) return;
    const key = String(email || '').trim().toLowerCase();
    if (!key || this._profileSignalsSeen.has(key)) return;
    const verdict = this.profileService.evaluateSignIn(email);
    if (verdict.action === 'none') return;
    this._profileSignalsSeen.add(key);
    if (verdict.action === 'adopted') {
      // First account on a fresh profile: silently bind, exactly like
      // Chrome's first sign-in (no prompt, nothing to separate yet).
      return;
    }
    this.state.profileSuggestion = {
      email: key,
      action: verdict.action,
      profileId: verdict.profile ? verdict.profile.id : null,
      source
    };
    this.render();
  }

  acceptProfileSuggestion() {
    const suggestion = this.state.profileSuggestion;
    if (!suggestion || !this.profileService) return;
    let target = null;
    if (suggestion.action === 'suggest-switch' && suggestion.profileId) {
      target = (this.profileService.list() || []).find((p) => p.id === suggestion.profileId) || null;
    } else {
      target = this.profileService.createProfile({ email: suggestion.email });
    }
    this.state.profileSuggestion = null;
    // Chrome-style: the suggested profile opens in its OWN new window and
    // this window keeps browsing as-is. In-place switch only as fallback.
    if (target && this.openProfileWindow(target)) {
      this.showTransientNotice(`Opened ${target.name} in its own window - this window keeps its current profile.`);
      this.render();
      return;
    }
    if (target) target = this.profileService.switchTo(target.id) || target;
    this.applyProfileSwitch(target);
  }

  declineProfileSuggestion() {
    const suggestion = this.state.profileSuggestion;
    if (suggestion && this.profileService) {
      // Remembered forever - this exact prompt never nags again.
      this.profileService.dismissAccount(suggestion.email);
    }
    this.state.profileSuggestion = null;
    this.render();
  }

  /**
   * Open `profile` in its OWN new Yayra window - Chrome's model: the
   * window you clicked in STAYS on its current profile and the other
   * profile gets a fresh window. Electron uses the real native
   * window-per-profile bridge (yayra:open-profile-window); web/PWA falls
   * back to window.open with a ?profile= boot param. Returns false when
   * neither exists (tests, odd embeds) so callers keep the old in-place
   * switch as a last resort.
   */
  openProfileWindow(profile) {
    if (!profile || !profile.id) return false;
    const bridge = this.profileWindowsBridge;
    if (bridge) {
      Promise.resolve(bridge.openWindow(profile.id)).catch(() => {});
      return true;
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      let target = `?profile=${encodeURIComponent(profile.id)}`;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('profile', profile.id);
        target = url.toString();
      } catch { /* relative ?profile= still resolves against this page */ }
      // Click-initiated, same-origin open; popup blockers allow these.
      window.open(target, '_blank');
      return true;
    }
    return false;
  }

  switchProfile(profileId) {
    if (!this.profileService) return;
    const current = this.profileService.current();
    if (current && current.id === profileId) return;
    this.state.isAccountMenuOpen = false;
    const target = (this.profileService.list() || []).find((p) => p.id === profileId) || null;
    if (target && this.openProfileWindow(target)) {
      // New window carries the other profile; THIS window keeps its own.
      this.showTransientNotice(`Opened ${target.name} in its own window - this window stays on ${current ? current.name : 'its profile'}.`);
      this.render();
      return;
    }
    const switched = this.profileService.switchTo(profileId);
    if (!switched) return;
    this.applyProfileSwitch(switched);
  }

  // Tear down the old profile's live web surfaces and start the new one
  // on a clean slate. On Electron the per-profile session partition only
  // applies to NEWLY created native views, so every existing view must go.
  applyProfileSwitch(profile) {
    for (const tab of this.state.tabs) {
      this.destroyNativeWebview(tab.id);
    }
    if (this.webFrames) {
      for (const [tabId, frame] of Array.from(this.webFrames.entries())) {
        frame.host.remove();
        this.webFrames.delete(tabId);
      }
    }
    this.state.tabs = [{
      id: `tab-${Date.now()}`,
      title: 'New Tab',
      url: 'yayra://newtab',
      isSecure: true,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      isPrivate: false,
      favicon: null
    }];
    this.state.activeTabId = this.state.tabs[0].id;
    this.state.urlInputValue = '';
    this.state.isBookmarked = false;
    this.render();
    if (profile) {
      this.showTransientNotice(`Browsing as ${profile.name}${profile.email ? ` (${profile.email})` : ''} - separate from other profiles.`);
    }
    // All persistence is profile-scoped (see profileStorage.js): after a
    // switch, load the NEW profile's settings, history, bookmarks and
    // wheel so nothing from the previous profile leaks across.
    this.reloadProfileScopedState().catch(() => {});
  }

  /** Load the current profile's persisted state into this.state. */
  async reloadProfileScopedState() {
    if (this.settingsRepo?.getSettings) {
      try {
        const stored = await this.settingsRepo.getSettings();
        if (stored) this.state.settings = { ...this.state.settings, ...stored };
      } catch { /* keep current */ }
    }
    if (this.historyRepo?.getEntries) {
      try { this.state.historyItems = await this.historyRepo.getEntries(100); } catch { /* keep current */ }
    }
    if (this.bookmarksRepo?.getAllBookmarks) {
      try { await this.refreshBookmarksState(); } catch { /* keep current */ }
    }
    if (this.emailAddressesRepo?.getAllEmails) {
      try {
        await this.refreshEmailAddressesState();
        await this.pushEmailSuggestionsToOpenTabs();
      } catch { /* keep current */ }
    }
    if (this.wheelRepo?.getItems) {
      try {
        const storedWheel = await this.wheelRepo.getItems();
        this.state.customRadialActions = storedWheel && storedWheel.length
          ? this.hydrateWheelItems(storedWheel)
          : null;
        this.syncWheelToOverlay();
      } catch { /* keep current */ }
    }
    if (this.shortcutsRepo?.getShortcuts) {
      try { this.state.userShortcuts = await this.shortcutsRepo.getShortcuts(); } catch { /* keep current */ }
    }
    if (this.sessionRepo?.getLastSession) {
      try {
        // Profile switch: the previous-session offer belongs to the NEW
        // profile; the rolling snapshot restarts from its tabs too.
        const prev = await this.sessionRepo.getLastSession();
        const openNow = new Set(this.state.tabs.map((t) => t.url));
        const previousTabs = (prev.tabs || []).filter((t) => !t?.isPrivate && /^https?:\/\//i.test(t?.url || ''));
        this.state.tabGroupRestoreTabs = previousTabs;
        this.state.continueTabs = previousTabs.filter((t) => !openNow.has(t.url)).slice(0, 5);
        this._lastSessionSnapshotJson = null;
      } catch { /* keep current */ }
    }
    this.render();
  }

  /* -------------------------------------------------------------
   * CLOSE PROMPT & SESSION HANDOVER
   * -----------------------------------------------------------
   * Closing the app while real tabs are open asks what to do:
   *  - "Close all tabs & close"  -> next launch starts fresh;
   *  - "Just close"              -> next launch OFFERS the recent tabs;
   *  - "Keep all tabs & close"   -> next launch REOPENS every tab.
   * The choice is stored in localStorage ('yayra:close-session') and
   * consumed exactly once by the next launch (restoreCloseSession()).
   * ----------------------------------------------------------- */
  /** Exit the whole app from the Yayra menu (not just close this window). */
  exitYayra() {
    const controls = this.windowControls;
    if (controls && typeof controls.quit === 'function') {
      // Desktop asks how to handle open tabs, then quits every window,
      // including the always-on floating bubble and tray process.
      this.requestAppClose({ exitWholeApp: true });
      return;
    }

    // Native Android: Capacitor's App plugin is the supported process exit.
    try {
      const app = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
      if (app && typeof app.exitApp === 'function') {
        Promise.resolve(app.exitApp()).catch(() => {});
        return;
      }
    } catch { /* fall through to the browser-safe explanation */ }

    // A website cannot close a tab it did not open. Try the user-initiated
    // close for standalone/browser launches, then be explicit if blocked.
    this.state.isSideDrawerOpen = false;
    this.render();
    try { if (typeof window !== 'undefined') window.close?.(); } catch { /* browser may block it */ }
    this.showTransientNotice('To exit Yayra, close this browser tab or app window.');
  }

  requestAppClose({ exitWholeApp = false } = {}) {
    // Only REAL web pages warrant the session prompt. Internal pages
    // (Settings, History, ...) used to count as "real tabs", so closing
    // an app that showed only Settings interrogated the user about
    // nothing - and could even save yayra:// URLs as the session.
    const realTabs = this.state.tabs.filter((t) => !t.isPrivate && /^https?:\/\//i.test(t.url || ''));
    const controls = this.windowControls;
    const canQuitWholeApp = exitWholeApp && controls && typeof controls.quit === 'function';
    if (!realTabs.length || typeof document === 'undefined') {
      try {
        if (canQuitWholeApp) controls.quit();
        else controls?.close();
      } catch { /* already closing */ }
      this.state.closePromptExitsApp = false;
      return;
    }
    this.state.closePromptExitsApp = Boolean(canQuitWholeApp);
    this.state.closePrompt = true;
    this.render();
  }

  closeWithSessionMode(mode) {
    const exitWholeApp = Boolean(this.state.closePromptExitsApp);
    this.state.closePrompt = false;
    this.state.closePromptExitsApp = false;
    const tabs = mode === 'fresh'
      ? []
      : this.state.tabs
        .filter((t) => !t.isPrivate && /^https?:\/\//i.test(t.url || ''))
        .map((t) => {
          const group = this.sanitizeTabGroup(t.group);
          return { url: t.url, title: t.title || '', ...(group ? { group } : {}) };
        });
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('yayra:close-session', JSON.stringify({ mode, tabs, savedAt: new Date().toISOString() }));
      } catch { /* storage unavailable - closing still works */ }
    }
    try {
      if (exitWholeApp && typeof this.windowControls?.quit === 'function') this.windowControls.quit();
      else this.windowControls?.close();
    } catch { /* already closing */ }
    // Web/PWA builds have no native window to close - at least dismiss
    // the prompt so the choice is still honoured on the next visit.
    this.render();
  }

  /** Consume the previous session's close choice (once, at launch). */
  restoreCloseSession() {
    if (typeof localStorage === 'undefined') return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('yayra:close-session') || 'null'); } catch { saved = null; }
    if (!saved) return;
    try { localStorage.removeItem('yayra:close-session'); } catch { /* ignore */ }
    const tabs = Array.isArray(saved.tabs) ? saved.tabs.filter((t) => t && t.url) : [];
    if (!tabs.length) return;
    // A deep link (explicit initialUrl) always wins the first tab - the
    // saved session is downgraded to an offer instead of a takeover.
    if (saved.mode === 'restore' && this.options?.initialUrl) saved.mode = 'recent';
    if (saved.mode === 'restore') {
      // Reopen every tab automatically, exactly as they were.
      this.state.tabs = tabs.map((t, i) => {
        const group = this.sanitizeTabGroup(t.group);
        return {
          id: `tab-${Date.now()}-${i}`,
          title: t.title || 'New Tab',
          url: t.url,
          isSecure: String(t.url).startsWith('https://'),
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          isPrivate: false,
          favicon: null,
          ...(group ? { group } : {})
        };
      });
      this.state.activeTabId = this.state.tabs[0].id;
      this.state.urlInputValue = this.getDisplayUrl(this.state.tabs[0].url);
    } else if (saved.mode === 'recent') {
      // Plain close: offer the recent tabs instead of forcing them open.
      this.state.recentTabsOffer = tabs;
    }
  }

  acceptRecentTabsOffer() {
    const tabs = this.state.recentTabsOffer || [];
    this.state.recentTabsOffer = null;
    if (!tabs.length) { this.render(); return; }
    const restored = tabs.map((t, i) => {
      const group = this.sanitizeTabGroup(t.group);
      return {
        id: `tab-${Date.now()}-${i}`,
        title: t.title || 'New Tab',
        url: t.url,
        isSecure: String(t.url).startsWith('https://'),
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        isPrivate: false,
        favicon: null,
        ...(group ? { group } : {})
      };
    });
    // Replace a lone pristine new-tab; otherwise append after current tabs.
    const onlyPristine = this.state.tabs.length === 1 && this.state.tabs[0].url === 'yayra://newtab';
    this.state.tabs = onlyPristine ? restored : [...this.state.tabs, ...restored];
    this.state.activeTabId = restored[0].id;
    this.state.urlInputValue = this.getDisplayUrl(restored[0].url);
    this.render();
  }

  dismissRecentTabsOffer() {
    this.state.recentTabsOffer = null;
    this.render();
  }

  renderClosePromptModal(root) {
    const scrim = document.createElement('div');
    scrim.className = 'fb-close-prompt-scrim';
    scrim.addEventListener('click', () => {
      this.state.closePrompt = false;
      this.state.closePromptExitsApp = false;
      this.render();
    });
    root.appendChild(scrim);

    const realCount = this.state.tabs.filter((t) => !t.isPrivate && t.url && t.url !== 'yayra://newtab').length;
    const modal = document.createElement('div');
    modal.className = 'fb-close-prompt-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Close Yayra');
    modal.innerHTML = `
      <strong class="fb-close-prompt-title">Close Yayra?</strong>
      <p class="fb-close-prompt-text">You have ${realCount} open tab${realCount === 1 ? '' : 's'}. What should happen to ${realCount === 1 ? 'it' : 'them'}?</p>
      <div class="fb-close-prompt-actions">
        <button class="fb-btn fb-btn-primary fb-close-keep-tabs">Keep all tabs &amp; close <small>reopens them automatically next time</small></button>
        <button class="fb-btn fb-btn-secondary fb-close-just-close">Just close <small>offers your recent tabs next time</small></button>
        <button class="fb-btn fb-btn-secondary fb-close-all-tabs">Close all tabs &amp; close <small>starts fresh next time</small></button>
        <button class="fb-btn fb-btn-secondary fb-close-cancel">Cancel</button>
      </div>
    `;
    modal.querySelector('.fb-close-keep-tabs')?.addEventListener('click', () => this.closeWithSessionMode('restore'));
    modal.querySelector('.fb-close-just-close')?.addEventListener('click', () => this.closeWithSessionMode('recent'));
    modal.querySelector('.fb-close-all-tabs')?.addEventListener('click', () => this.closeWithSessionMode('fresh'));
    modal.querySelector('.fb-close-cancel')?.addEventListener('click', () => {
      this.state.closePrompt = false;
      this.state.closePromptExitsApp = false;
      this.render();
    });
    root.appendChild(modal);
  }

  renderRecentTabsOffer(root) {
    const tabs = this.state.recentTabsOffer || [];
    const card = document.createElement('div');
    card.className = 'fb-recent-tabs-offer';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Reopen recent tabs');
    card.innerHTML = `
      <span class="fb-recent-tabs-icon">${Icons.history}</span>
      <span class="fb-recent-tabs-text"><strong>Pick up where you left off?</strong><small>${tabs.length} recent tab${tabs.length === 1 ? '' : 's'} from your last session</small></span>
      <button class="fb-btn fb-btn-primary fb-recent-tabs-reopen">Reopen</button>
      <button class="fb-btn fb-btn-secondary fb-recent-tabs-dismiss">Dismiss</button>
    `;
    card.querySelector('.fb-recent-tabs-reopen')?.addEventListener('click', () => this.acceptRecentTabsOffer());
    card.querySelector('.fb-recent-tabs-dismiss')?.addEventListener('click', () => this.dismissRecentTabsOffer());
    root.appendChild(card);
  }

  profileAvatarHtml(profile, size = 28) {
    const initial = String((profile && (profile.name || profile.email)) || '?').charAt(0).toUpperCase();
    const color = (profile && profile.color) || '#3b82f6';
    return `<span class="fb-profile-avatar" style="width:${size}px; height:${size}px; background:${color}; font-size:${Math.round(size * 0.5)}px;">${initial}</span>`;
  }

  renderProfileSuggestionCard(root) {
    const suggestion = this.state.profileSuggestion;
    if (!suggestion || !this.profileService) return;
    const current = this.profileService.current();
    const isSwitch = suggestion.action === 'suggest-switch';
    const targetProfile = isSwitch
      ? this.profileService.list().find((p) => p.id === suggestion.profileId)
      : null;

    const card = document.createElement('div');
    card.className = 'fb-profile-suggestion-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Keep your browsing separate');
    card.innerHTML = `
      <div class="fb-profile-suggestion-avatars">
        ${this.profileAvatarHtml(current, 34)}
        ${this.profileAvatarHtml(targetProfile || { name: suggestion.email, color: '#10b981' }, 34)}
      </div>
      <strong class="fb-profile-suggestion-title">Keep your browsing separate?</strong>
      <p class="fb-profile-suggestion-text">
        <b>${current.name}</b>${current.email ? ` (${current.email})` : ''} is already using this profile.
        ${isSwitch
          ? `Switch to the existing profile for <b>${suggestion.email}</b> to keep cookies, logins and passwords separate.`
          : `Create a separate profile for <b>${suggestion.email}</b> so their cookies, logins and passwords stay their own.`}
      </p>
      <div class="fb-profile-suggestion-actions">
        <button class="fb-btn fb-btn-secondary fb-profile-suggestion-decline">No thanks</button>
        <button class="fb-btn fb-btn-primary fb-profile-suggestion-accept">${isSwitch ? 'Switch profile' : 'Use separate profile'}</button>
      </div>
    `;
    card.querySelector('.fb-profile-suggestion-accept')?.addEventListener('click', () => this.acceptProfileSuggestion());
    card.querySelector('.fb-profile-suggestion-decline')?.addEventListener('click', () => this.declineProfileSuggestion());
    root.appendChild(card);
  }

  renderAccountDropdown(root) {
    this.appendDropdownScrim(root, () => {
      this.state.isAccountMenuOpen = false;
      this.render();
    });

    const dropdown = document.createElement('div');
    dropdown.className = 'fb-account-dropdown';

    const account = this.state.googleAccount || { status: 'idle' };

    // Vault + passkey summary shown in both signed-in and signed-out
    // states: the Yayra account's local powers (encrypted passwords,
    // keys, passkey protection) work with or without Google sign-in.
    const passkey = this.state.passkeyInfo;
    const vaultSummaryHtml = `
      <div class="fb-account-vault-summary">
        <button class="fb-account-vault-btn" title="Open passwords & keys vault">
          ${Icons.lock}
          <span>
            <strong>Passwords &amp; keys vault</strong>
            <small>${this.state.passwordsItems.length} password${this.state.passwordsItems.length === 1 ? '' : 's'} &#183; ${this.state.vaultKeysItems.length} key${this.state.vaultKeysItems.length === 1 ? '' : 's'} &#183; AES-256 encrypted</small>
          </span>
        </button>
        <button class="fb-account-passkey-btn" title="${passkey ? 'Verify your account passkey' : 'Create an account passkey'}">
          ${Icons.shield}
          <span>
            <strong>${passkey ? 'Passkey active' : 'Create a passkey'}</strong>
            <small>${passkey
              ? `Protected since ${new Date(passkey.createdAt).toLocaleDateString()}`
              : 'Lock your account & vault with biometrics/PIN'}</small>
          </span>
        </button>
      </div>`;

    // Browser profiles section - shown in both branches. Each profile is
    // its own browsing identity (own cookies/logins on Electron via a
    // dedicated session partition - see electron/webviewBridge.cjs).
    const profiles = this.profileService ? this.profileService.list() : [];
    const currentProfileId = this.profileService ? this.profileService.current().id : null;
    const profilesHtml = this.profileService ? `
      <div class="fb-account-profiles">
        <small class="fb-account-profiles-label">Browsing profiles</small>
        ${profiles.map((p) => `
          <button class="fb-profile-row${p.id === currentProfileId ? ' fb-profile-row-current' : ''}" data-profile-id="${p.id}" title="${p.id === currentProfileId ? 'Current profile' : `Switch to ${p.name}`}">
            ${this.profileAvatarHtml(p, 26)}
            <span class="fb-profile-row-text">
              <strong>${p.name}</strong>
              ${p.email ? `<small>${p.email}</small>` : ''}
            </span>
            ${p.id === currentProfileId ? `<span class="fb-profile-row-check">${Icons.check || '&#10003;'}</span>` : ''}
          </button>
        `).join('')}
        <button class="fb-profile-row fb-profile-add-btn" title="Add a new browsing profile">
          <span class="fb-profile-avatar fb-profile-avatar-add">+</span>
          <span class="fb-profile-row-text"><strong>Add profile</strong></span>
        </button>
      </div>` : '';

    if (account.status === 'signed-in' && account.profile) {
      const { name, email } = account.profile;
      const sinceLabel = account.savedAt
        ? new Date(account.savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
      dropdown.innerHTML = `
        <div class="fb-account-dropdown-header">
          ${this.renderAccountAvatarHtml(account.profile, 40)}
          <div>
            <strong>${name || email || 'Signed in'}</strong>
            ${email ? `<p style="margin:2px 0 0; font-size:0.8rem; color:var(--fb-text-muted);">${email}</p>` : ''}
          </div>
        </div>
        ${sinceLabel ? `<p style="margin:0; padding:0 2px; font-size:0.75rem; color:var(--fb-text-muted);">Signed in since ${sinceLabel}</p>` : ''}
        ${vaultSummaryHtml}
        ${profilesHtml}
        <div class="fb-account-dropdown-actions">
          <button class="fb-btn fb-btn-secondary fb-account-manage-btn" style="width:100%; justify-content:flex-start;">${Icons.externalLink} Manage Google Account</button>
          <button class="fb-btn fb-btn-secondary fb-account-settings-btn" style="width:100%; justify-content:flex-start;">${Icons.info} Yayra account settings</button>
          <button class="fb-btn fb-btn-secondary fb-account-switch-btn" style="width:100%; justify-content:flex-start;">${Icons.userCircle} Switch account</button>
          <button class="fb-btn fb-btn-secondary fb-account-signout-btn" style="width:100%; justify-content:flex-start;">${Icons.close} Sign out</button>
        </div>
      `;
    } else {
      const isSigningIn = account.status === 'signing-in';
      const errorNote = account.status === 'error'
        ? `<p style="margin:0; color:#f66; font-size:0.8rem;">Couldn't sign in: ${account.error === 'not_configured' ? 'Google sign-in isn\u2019t configured for this build yet.' : (account.error || 'please try again.')}</p>`
        : '';
      dropdown.innerHTML = `
        <div class="fb-account-dropdown-header">
          ${this.renderAccountAvatarHtml(null, 40)}
          <div>
            <strong>Not signed in</strong>
            <p style="margin:2px 0 0; font-size:0.8rem; color:var(--fb-text-muted);">Sign in to personalize Yayra</p>
          </div>
        </div>
        ${errorNote}
        ${vaultSummaryHtml}
        ${profilesHtml}
        <div class="fb-account-dropdown-actions">
          <button class="fb-btn fb-btn-primary fb-account-signin-btn" style="width:100%;" ${isSigningIn ? 'disabled' : ''}>${isSigningIn ? 'Signing in&hellip;' : 'Sign in with Google'}</button>
          <button class="fb-btn fb-btn-secondary fb-account-settings-btn" style="width:100%; justify-content:flex-start;">${Icons.info} Yayra account settings</button>
        </div>
      `;
    }

    dropdown.querySelector('.fb-account-vault-btn')?.addEventListener('click', () => {
      this.state.isAccountMenuOpen = false;
      this.openInternalPage('yayra://passwords');
    });
    dropdown.querySelector('.fb-account-passkey-btn')?.addEventListener('click', () => {
      this.state.isAccountMenuOpen = false;
      if (this.state.passkeyInfo) this.verifyAccountPasskey();
      else this.registerAccountPasskey();
    });
    dropdown.querySelector('.fb-account-manage-btn')?.addEventListener('click', () => this.openGoogleAccountPage());
    dropdown.querySelector('.fb-account-switch-btn')?.addEventListener('click', () => this.switchGoogleAccount());
    dropdown.querySelector('.fb-account-signout-btn')?.addEventListener('click', () => this.signOutOfGoogle());
    dropdown.querySelector('.fb-account-signin-btn')?.addEventListener('click', () => this.signInWithGoogle());
    dropdown.querySelector('.fb-account-settings-btn')?.addEventListener('click', () => {
      this.state.isAccountMenuOpen = false;
      this.state.settingsActiveCategory = 'account';
      this.state.activeSettingsCategory = 'account';
      this.openInternalPage('yayra://settings');
    });

    // Profile switcher rows + "Add profile".
    for (const row of dropdown.querySelectorAll('.fb-profile-row')) {
      if (row.className.includes('fb-profile-add-btn')) {
        row.addEventListener('click', () => {
          const created = this.profileService.createProfile({});
          this.state.isAccountMenuOpen = false;
          // Chrome-style: the NEW profile opens in a NEW Yayra window;
          // this window stays on its current profile. In-place switch
          // only when no window capability exists at all.
          if (this.openProfileWindow(created)) {
            this.showTransientNotice(`${created.name} opened in a new window - this window stays on ${this.profileService.current().name}.`);
            this.render();
            return;
          }
          this.profileService.switchTo(created.id);
          this.applyProfileSwitch(created);
        });
      } else {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-profile-id');
          if (id) this.switchProfile(id);
        });
      }
    }

    root.appendChild(dropdown);
  }

  /* -------------------------------------------------------------
   * BACKGROUND UPDATE CHECKS
   * -----------------------------------------------------------
   * Beyond the single check shortly after startup, Yayra now re-checks on
   * a timer (config-driven: updates config checkIntervalMinutes, default
   * 12h, clamped to a 15-minute floor) so long-running sessions learn
   * about new releases without the user ever opening the menu. When a
   * background check finds an update, checkForUpdates() already alerts
   * the user: promptUpdateReady() shows the one-per-session confirm
   * dialog, and the toolbar renders a persistent "Update" chip that stays
   * until the update is applied.
   * ----------------------------------------------------------- */
  startBackgroundUpdateChecks() {
    if (this._updateCheckTimer || typeof setInterval !== 'function') return;
    if (!this.updateService || typeof this.updateService.check !== 'function') return;
    const configured = Number(this.updateService?.config?.checkIntervalMinutes);
    const minutes = Math.max(15, Number.isFinite(configured) && configured > 0 ? configured : 720);
    this._updateCheckTimer = setInterval(() => {
      this.checkForUpdates(false);
    }, minutes * 60 * 1000);
    // Never keep a Node test process alive because of this timer.
    if (this._updateCheckTimer && typeof this._updateCheckTimer.unref === 'function') {
      this._updateCheckTimer.unref();
    }
  }

  stopBackgroundUpdateChecks() {
    if (this._updateCheckTimer) {
      clearInterval(this._updateCheckTimer);
      this._updateCheckTimer = null;
    }
  }

  async checkForUpdates(manual = false) {
    if (this.state.updateState.status === 'checking') return;
    this.state.updateState = { ...this.state.updateState, status: 'checking' };
    this.render();

    // The Cloudflare Worker's /updates/manifest.json (via UpdateService) is
    // the single source of truth for "is a real update available" - it
    // already encodes per-target min-supported versions, staged rollout
    // percentages and ETag-cached fetches. There used to be a second,
    // independent "fallback" check here that fetched the raw GitHub Releases
    // API directly and compared the tag against a version string that was
    // hardcoded to '0.1.0' and never updated. That meant the fallback judged
    // the installed app "out of date" against EVERY release forever (0.1.0
    // never equals any real tag), even right after the UpdateService itself
    // had just confirmed the app was fully up to date - producing an
    // "update ready" prompt on every load/reload that could never be
    // satisfied. Removed entirely rather than patched, since UpdateService
    // already does this correctly and duplicating it only reintroduces the
    // same class of bug. See tests/update-service.test.mjs and
    // tests/browser-shell-update-check.test.mjs.
    if (!this.updateService || typeof this.updateService.check !== 'function') {
      this.state.updateState = {
        ...this.state.updateState,
        status: 'unknown',
        availableVersion: null,
        notes: 'No update service configured.'
      };
      this.render();
      return;
    }

    // Only the network call to the Worker-backed UpdateService is wrapped in
    // try/catch here (offline/5xx/etc). Showing the confirm()/alert()
    // dialogs afterward is deliberately kept OUTSIDE that try block: if a
    // browser blocks repeated dialogs (e.g. Chrome's "Prevent this page from
    // creating additional dialogs" safeguard, which can trip after a prior
    // dialog loop like the one this fix addresses) or a WebView lacks
    // window.alert/confirm, that must never be swallowed as if the update
    // check itself had failed - doing so previously reset the state back to
    // "uptodate" and skipped window.location.reload() silently, with no
    // visible error, right after telling the user an update was ready.
    let res;
    try {
      res = await this.updateService.check({ manual });
    } catch (err) {
      // A thrown check is a FAILED check - say so instead of silently
      // pretending everything is up to date (which left manual "Check for
      // updates" clicks looking like they did nothing at all).
      this.state.updateState = {
        ...this.state.updateState,
        status: 'error',
        availableVersion: null,
        notes: String(err?.message || err || 'Update check failed')
      };
      this.render();
      if (manual) this.showTransientNotice('Update check failed - please check your connection and try again.');
      return;
    }

    // How is THIS copy installed, and is a NEWER build already on disk?
    // That happens when the update was installed outside the app (e.g.
    // terminal `sudo dpkg -i ...`) while the old Yayra process stayed
    // resident in the tray/bubble: the old process keeps answering every
    // launch through the single-instance lock, so the user "keeps
    // getting the previous version" no matter how often they install.
    // The honest fix is Chrome's: a "Relaunch to update" prompt, not
    // another download.
    const installInfo = await this.getUpdateInstallInfo();
    if (installInfo?.relaunchWillUpdate) {
      this.state.updateState = {
        ...this.state.updateState,
        status: 'relaunch',
        installedVersion: installInfo.runningVersion || this.state.updateState.installedVersion,
        availableVersion: installInfo.diskVersion || null,
        notes: `v${installInfo.diskVersion} is already installed on this computer - relaunch Yayra to start using it.`,
        download: null
      };
      this.render();
      if (manual) this.showTransientNotice(`v${installInfo.diskVersion} is installed - relaunch Yayra to finish the update.`);
      this.promptRelaunchToUpdate(installInfo.diskVersion);
      return;
    }

    if (res && (res.status === 'available' || res.status === 'ready')) {
      // AppImage installs must download the AppImage (which Yayra
      // self-replaces in place), never the .deb: a dpkg install lands in
      // /opt while the user keeps launching their old AppImage file -
      // which looks exactly like "the update never applies".
      let download = res.download || null;
      if (installInfo?.installKind === 'appimage') {
        const alt = res.manifest?.downloads?.['linux-appimage'];
        if (alt?.url) download = alt;
      }
      this.state.updateState = {
        status: 'ready',
        installedVersion: res.installedVersion ?? this.state.updateState.installedVersion,
        availableVersion: res.version || null,
        notes: res.notes || (res.force ? 'A required update is ready.' : 'Update ready.'),
        // Verified download descriptor from the update manifest (url,
        // sha256, bytes) - this is what the desktop pipeline downloads,
        // verifies and installs. See applyUpdate().
        download,
        force: Boolean(res.force)
      };
      this.render();
      if (manual) this.showTransientNotice(`Update v${res.version || ''} is available.`);
      this.promptUpdateReady();
    } else {
      // 'upToDate', 'ahead', 'unknown', 'disabled', etc. - never a reason to
      // show the "update ready" dialog.
      const normalized = res?.status === 'upToDate' ? 'uptodate' : (res?.status || 'uptodate');
      this.state.updateState = {
        ...this.state.updateState,
        status: normalized,
        installedVersion: res?.installedVersion ?? this.state.updateState.installedVersion,
        availableVersion: null,
        download: null
      };
      this.render();
      if (manual) {
        if (normalized === 'uptodate' || normalized === 'ahead') {
          const v = this.state.updateState.installedVersion;
          this.showTransientNotice(`Yayra is up to date${v ? ` (v${v})` : ''}.`);
        } else if (normalized === 'unknown') {
          this.showTransientNotice('Could not reach the update server - will retry later.');
        } else if (normalized === 'disabled') {
          this.showTransientNotice('Updates are disabled on this build.');
        }
      }
    }
  }

  /** Install metadata from the desktop updater bridge (null on web/mobile). */
  async getUpdateInstallInfo() {
    const bridge = this.desktopUpdatesBridge;
    if (!bridge || typeof bridge.installInfo !== 'function') return null;
    try {
      const info = await bridge.installInfo();
      return (info && info.ok) ? info : null;
    } catch {
      return null;
    }
  }

  /** Chrome's "Relaunch to update": the new build is on disk already. */
  promptRelaunchToUpdate(diskVersion) {
    if (this.state.updatePromptShown) return;
    this.state.updatePromptShown = true;
    this.state.updatePrompt = {
      version: diskVersion || null,
      notes: '',
      relaunch: true,
      desktopPipeline: false
    };
    this.render();
  }

  async relaunchToUpdate() {
    const bridge = this.desktopUpdatesBridge;
    this.state.updatePrompt = null;
    this.render();
    if (bridge && typeof bridge.relaunch === 'function') {
      try {
        const res = await bridge.relaunch();
        if (res && res.status === 'relaunching') return;
        this.showTransientNotice(`Relaunch failed${res?.reason ? ` (${res.reason})` : ''} - please close and reopen Yayra.`);
        return;
      } catch { /* fall through */ }
    }
    this.showTransientNotice('Please close Yayra completely (including the bubble) and reopen it to use the installed version.');
  }

  promptUpdateReady() {
    if (this.state.updatePromptShown) return;
    this.state.updatePromptShown = true;
    // In-app card (not a native confirm() dialog): "Download & install
    // now" / "Later". One per session; the persistent toolbar "Update"
    // chip keeps offering the update after "Later".
    this.state.updatePrompt = {
      version: this.state.updateState.availableVersion || null,
      notes: this.state.updateState.notes || '',
      desktopPipeline: Boolean(this.desktopUpdatesBridge && this.state.updateState.download?.url)
    };
    this.render();
  }

  acceptUpdatePrompt() {
    this.state.updatePrompt = null;
    this.render();
    this.applyUpdate();
  }

  deferUpdatePrompt() {
    this.state.updatePrompt = null;
    this.render();
    this.showTransientNotice('Okay - update anytime from the "Update" chip or menu.');
  }

  /**
   * THE update prompt, pinned to the TOP RIGHT CORNER above EVERYTHING.
   *
   * It mounts on document.body (never inside the shell tree) as a
   * position:fixed card with the maximum z-index (design-system.css
   * .fb-update-prompt-card) - so no menu, dropdown, modal, toast, splash
   * or ancestor stacking context can ever cover it. On Electron the
   * native page surface is also held back while it is open (see
   * hasBlockingOverlay()). Self-cleaning: with no live prompt state every
   * render removes a lingering card, so "Later" can never leave it up.
   */
  renderUpdatePromptCard(root) {
    const prompt = this.state.updatePrompt;
    const host = (typeof document !== 'undefined' && document.body) ? document.body : root;
    const previous = (typeof document !== 'undefined' && document.getElementById)
      ? document.getElementById('yayra-update-prompt-card')
      : null;
    if (!prompt) {
      previous?.remove();
      return;
    }
    const card = document.createElement('div');
    card.id = 'yayra-update-prompt-card';
    card.className = 'fb-update-prompt-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Update available');
    if (prompt.relaunch) {
      // The newer build is ALREADY installed on disk (e.g. terminal
      // dpkg -i while this old process stayed resident) - no download,
      // just Chrome's "Relaunch to update".
      card.innerHTML = `
        <div class="fb-update-prompt-head">
          <span class="fb-update-prompt-icon">${Icons.refresh || Icons.download}</span>
          <div>
            <strong class="fb-update-prompt-title">Update installed - relaunch to finish</strong>
            <p class="fb-update-prompt-text">Yayra v${prompt.version || 'latest'} is already installed on this computer, but this window is still running the old version. Relaunch to start using it.</p>
          </div>
        </div>
        <div class="fb-update-prompt-actions">
          <button class="fb-btn fb-btn-secondary fb-update-prompt-later">Later</button>
          <button class="fb-btn fb-btn-primary fb-update-prompt-now">Relaunch Yayra</button>
        </div>
      `;
      card.querySelector('.fb-update-prompt-now')?.addEventListener('click', () => this.relaunchToUpdate());
      card.querySelector('.fb-update-prompt-later')?.addEventListener('click', () => this.deferUpdatePrompt());
      previous?.remove();
      host.appendChild(card);
      return;
    }
    card.innerHTML = `
      <div class="fb-update-prompt-head">
        <span class="fb-update-prompt-icon">${Icons.download}</span>
        <div>
          <strong class="fb-update-prompt-title">Update available</strong>
          <p class="fb-update-prompt-text">Yayra v${prompt.version || 'latest'} is ready.${prompt.desktopPipeline
            ? ' It will be downloaded and verified before anything runs.'
            : ' It applies in seconds with a quick restart.'}</p>
        </div>
      </div>
      <div class="fb-update-prompt-actions">
        <button class="fb-btn fb-btn-secondary fb-update-prompt-later">Later</button>
        <button class="fb-btn fb-btn-primary fb-update-prompt-now">${prompt.desktopPipeline ? (this.state.updateState.status === 'staged' ? 'Install now' : 'Download &amp; install now') : 'Update now'}</button>
      </div>
    `;
    card.querySelector('.fb-update-prompt-now')?.addEventListener('click', () => this.acceptUpdatePrompt());
    card.querySelector('.fb-update-prompt-later')?.addEventListener('click', () => this.deferUpdatePrompt());
    previous?.remove();
    host.appendChild(card);
  }

  /** Read (without consuming) a scheduled "install on next launch". */
  getScheduledInstall() {
    if (typeof localStorage === 'undefined') return null;
    try { return JSON.parse(localStorage.getItem('yayra:pending-update-install') || 'null'); } catch { return null; }
  }

  /**
   * Settings -> "Yayra Updates": the full manual home of the update
   * pipeline. Everything the prompts offer lives here too - check,
   * download, install now, install on next launch - so "Later" is never
   * a dead end. Also reachable from the menu's update section.
   */
  renderUpdatesSettingsHtml() {
    const u = this.state.updateState || {};
    const scheduled = this.getScheduledInstall();
    const desktopPipeline = Boolean(this.desktopUpdatesBridge);
    const configured = Number(this.updateService?.config?.checkIntervalMinutes);
    const intervalMin = Math.max(15, Number.isFinite(configured) && configured > 0 ? configured : 720);
    const intervalLabel = intervalMin % 60 === 0 ? `${intervalMin / 60} hour${intervalMin === 60 ? '' : 's'}` : `${intervalMin} minutes`;

    const statusLabel = u.status === 'checking' ? 'Checking for updates…'
      : u.status === 'downloading' ? `Downloading v${u.availableVersion || ''}… ${typeof u.progressPercent === 'number' ? `${u.progressPercent}%` : ''}`
      : u.status === 'staged' ? `v${u.availableVersion || ''} downloaded & verified - ready to install`
      : u.status === 'ready' ? `v${u.availableVersion || ''} is available`
      : u.status === 'installing' ? 'Installer running…'
      : u.status === 'error' ? `Problem: ${u.notes || 'update check failed'}`
      : `You're up to date${u.installedVersion ? ` (v${u.installedVersion})` : ''}`;

    return `
      <div class="fb-updates-settings">
        <div class="fb-updates-status-row">
          <span class="fb-status-orb ${u.status === 'error' ? '' : u.status === 'checking' || u.status === 'downloading' ? 'pulse' : 'green'}" ${u.status === 'error' ? 'style="background:#ef4444;"' : ''}></span>
          <div>
            <strong>${statusLabel}</strong>
            <p style="margin:2px 0 0; font-size:0.78rem; color:var(--fb-text-muted);">Installed: v${u.installedVersion || 'unknown'} &#183; Auto-checks every ${intervalLabel} while Yayra is open.</p>
          </div>
        </div>
        ${scheduled ? `
          <div class="fb-updates-scheduled-row">
            <span>${Icons.hourglass}</span>
            <span style="flex:1;">Scheduled: install v${scheduled.version || 'update'} the next time Yayra opens.</span>
            <button class="fb-btn fb-btn-secondary fb-up-cancel-scheduled">Cancel</button>
          </div>` : ''}
        <div class="fb-updates-actions">
          <button class="fb-btn fb-btn-secondary fb-up-check">Check for updates now</button>
          ${u.status === 'ready' ? `<button class="fb-btn fb-btn-primary fb-up-download">${desktopPipeline && u.download?.url ? `Download v${u.availableVersion || 'update'} (verified)` : `Update now to v${u.availableVersion || 'latest'}`}</button>` : ''}
          ${u.status === 'staged' ? `
            <button class="fb-btn fb-btn-primary fb-up-install-now">Install &amp; restart now</button>
            <button class="fb-btn fb-btn-secondary fb-up-install-next">Install when Yayra opens again</button>` : ''}
        </div>
      </div>
    `;
  }

  bindUpdatesSettingsActions(page) {
    page.querySelector('.fb-up-check')?.addEventListener('click', () => this.checkForUpdates(true));
    page.querySelector('.fb-up-download')?.addEventListener('click', () => this.applyUpdate());
    page.querySelector('.fb-up-install-now')?.addEventListener('click', () => this.installDesktopUpdateNow());
    page.querySelector('.fb-up-install-next')?.addEventListener('click', () => this.deferInstallToNextLaunch());
    page.querySelector('.fb-up-cancel-scheduled')?.addEventListener('click', () => {
      this.clearPendingInstall();
      this.render();
      this.showTransientNotice('Scheduled install cancelled - the update stays downloaded.');
    });
  }

  applyUpdate() {
    // Electron desktop with a real download descriptor: download the
    // artifact in the main process, verify sha256 + byte length, then hand
    // the verified installer to the OS. Everything else (web/PWA) keeps the
    // reload-based flow below.
    const bridge = this.desktopUpdatesBridge;
    // Already downloaded & verified? Then the ONLY remaining step is
    // installing - never re-download, and every button says "Install".
    if (bridge && this.state.updateState.status === 'staged' && this.state.updateState.stagedPath) {
      this.installDesktopUpdateNow();
      return;
    }
    if (bridge && this.state.updateState.download?.url) {
      this.applyDesktopUpdate().catch(() => {});
      return;
    }
    try {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert('Updating Yayra to latest version in background...');
      }
    } catch {
      // Dialogs can be blocked by the browser after repeated prompts - that
      // must never prevent the actual reload/update below from happening.
    }
    try {
      // PWA: promote any waiting service worker BEFORE reloading, otherwise
      // the reload keeps serving the previous cached build.
      if (typeof window !== 'undefined' && typeof window.__yayraApplyPwaUpdate === 'function') {
        window.__yayraApplyPwaUpdate();
      }
    } catch {
      // Never let the service-worker handoff block the reload fallback.
    }
    if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
      window.location.reload();
    }
  }

  async applyDesktopUpdate() {
    const bridge = this.desktopUpdatesBridge;
    const { download, availableVersion } = this.state.updateState;
    if (!bridge || !download?.url) return;
    if (this.state.updateState.status === 'downloading') return;

    this.state.updateState = { ...this.state.updateState, status: 'downloading', progressPercent: 0 };
    this.render();
    this.showTransientNotice(`Downloading Yayra v${availableVersion || ''}…`);

    let result;
    try {
      result = await bridge.download({
        url: download.url,
        sha256: download.sha256 || null,
        bytes: download.bytes || null,
        version: availableVersion || 'latest',
        target: this.updateService?.target || this.platform || 'desktop'
      });
    } catch (err) {
      result = { status: 'error', reason: String(err?.message || err) };
    }

    if (!result || result.status !== 'staged') {
      const reason = result?.reason || 'download failed';
      this.state.updateState = { ...this.state.updateState, status: 'error', notes: reason };
      this.render();
      this.showTransientNotice(`Update failed: ${reason}. Your current version keeps running.`);
      return;
    }

    this.state.updateState = { ...this.state.updateState, status: 'staged', stagedPath: result.path, progressPercent: 100 };
    this.showTransientNotice(`Update v${availableVersion || ''} downloaded and verified.`);

    // The download is staged and verified - now ASK instead of installing
    // behind the user's back: install & restart now, install when Yayra
    // is opened again, or later (manually, from Settings -> Yayra Updates
    // or the menu's update section).
    this.state.updateInstallPrompt = { path: result.path, version: availableVersion || null };
    this.render();
  }

  /** Install the staged (already verified) update right now. */
  async installDesktopUpdateNow() {
    const bridge = this.desktopUpdatesBridge;
    const path = this.state.updateInstallPrompt?.path || this.state.updateState.stagedPath;
    const version = this.state.updateInstallPrompt?.version || this.state.updateState.availableVersion || null;
    this.state.updateInstallPrompt = null;
    this.clearPendingInstall();
    if (!bridge || !path) { this.render(); return; }
    this.state.updateState = { ...this.state.updateState, status: 'installing' };
    this.render();
    let install;
    try {
      install = await bridge.install({ path, version });
    } catch (err) {
      install = { status: 'error', reason: String(err?.message || err) };
    }
    if (install?.status === 'install_started') {
      // The main process does the real work per artifact type
      // (electron/desktopUpdater.cjs) - tell the user exactly what happens
      // next instead of a one-size-fits-all message.
      const messages = {
        'os-installer': 'Installer launched - Yayra will close so the new version can take its place.',
        pkexec: 'Enter your password in the system prompt - Yayra restarts on the new version automatically.',
        'self-replace': 'Update applied in place - Yayra is reopening on the new version…',
        mounted: 'Disk image opened - drag Yayra into Applications to finish updating.',
        reveal: `Automatic install is not available here${install.note ? ` (${install.note})` : ''} - the verified update file was revealed so you can run it yourself.`
      };
      this.showTransientNotice(messages[install.method] || 'Install started.');
      if (install.method === 'reveal' || install.method === 'mounted') {
        // Nothing is replacing the running app: stay on "staged" so the
        // Install button remains available.
        this.state.updateState = { ...this.state.updateState, status: 'staged', stagedPath: path };
        this.render();
      }
    } else {
      this.state.updateState = { ...this.state.updateState, status: 'staged', stagedPath: path, notes: install?.reason || 'unknown error' };
      this.render();
      this.showTransientNotice(`Could not launch the installer: ${install?.reason || 'unknown error'}. The download stays verified - try again from Settings → Yayra Updates.`);
    }
  }

  /** Remember to install the staged update on the NEXT app launch. */
  deferInstallToNextLaunch() {
    const prompt = this.state.updateInstallPrompt || {};
    const path = prompt.path || this.state.updateState.stagedPath;
    this.state.updateInstallPrompt = null;
    if (path && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('yayra:pending-update-install', JSON.stringify({
          path,
          version: prompt.version || this.state.updateState.availableVersion || null,
          savedAt: new Date().toISOString()
        }));
      } catch { /* storage unavailable - fall back to manual install */ }
    }
    this.render();
    this.showTransientNotice('Got it - Yayra will install this update the next time it opens.');
  }

  /** Dismiss the install choice - everything stays available manually. */
  dismissInstallPrompt() {
    this.state.updateInstallPrompt = null;
    this.render();
    this.showTransientNotice('Update stays downloaded - install anytime from Settings → Yayra Updates.');
  }

  clearPendingInstall() {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem('yayra:pending-update-install'); } catch { /* ignore */ }
    }
  }

  /** Honour a "install when opened again" choice from the previous run. */
  async processPendingInstallOnLaunch() {
    if (typeof localStorage === 'undefined') return;
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem('yayra:pending-update-install') || 'null'); } catch { pending = null; }
    if (!pending || !pending.path) return;
    this.clearPendingInstall();
    const bridge = this.desktopUpdatesBridge;
    if (!bridge) return;
    let install;
    try {
      install = await bridge.install({ path: pending.path, version: pending.version || null });
    } catch (err) {
      install = { status: 'error', reason: String(err?.message || err) };
    }
    if (install?.status === 'install_started') {
      this.showTransientNotice(`Installing the update you scheduled (v${pending.version || ''}) - follow the system prompts.`);
    } else {
      this.showTransientNotice(`Scheduled update could not start: ${install?.reason || 'unknown error'}. Install it from Settings → Yayra Updates.`);
    }
  }

  /**
   * "Update downloaded - install when?" - the second update prompt card.
   * Same overlay contract as renderUpdatePromptCard: window-level,
   * document.body-mounted, pinned to the top right corner above
   * everything, self-cleaning on every render.
   */
  renderUpdateInstallPromptCard(root) {
    const prompt = this.state.updateInstallPrompt;
    const host = (typeof document !== 'undefined' && document.body) ? document.body : root;
    const previous = (typeof document !== 'undefined' && document.getElementById)
      ? document.getElementById('yayra-update-install-card')
      : null;
    if (!prompt) {
      previous?.remove();
      return;
    }
    const card = document.createElement('div');
    card.id = 'yayra-update-install-card';
    card.className = 'fb-update-prompt-card fb-update-install-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Update downloaded');
    card.innerHTML = `
      <div class="fb-update-prompt-head">
        <span class="fb-update-prompt-icon">${Icons.check}</span>
        <div>
          <strong class="fb-update-prompt-title">Update downloaded &amp; verified</strong>
          <p class="fb-update-prompt-text">Yayra v${prompt.version || 'latest'} is ready to install. When should it happen?</p>
        </div>
      </div>
      <div class="fb-update-install-actions">
        <button class="fb-btn fb-btn-primary fb-update-install-now">Install &amp; restart now</button>
        <button class="fb-btn fb-btn-secondary fb-update-install-next-launch">Install when Yayra opens again</button>
        <button class="fb-btn fb-btn-secondary fb-update-install-later">Later - I'll do it manually</button>
      </div>
    `;
    card.querySelector('.fb-update-install-now')?.addEventListener('click', () => this.installDesktopUpdateNow());
    card.querySelector('.fb-update-install-next-launch')?.addEventListener('click', () => this.deferInstallToNextLaunch());
    card.querySelector('.fb-update-install-later')?.addEventListener('click', () => this.dismissInstallPrompt());
    previous?.remove();
    host.appendChild(card);
  }

  /**
   * Live progress events from electron/desktopUpdater.cjs. Updates the
   * drawer progress label in place (no full re-render per chunk - that
   * would tear down input focus dozens of times per second).
   */
  handleDesktopUpdateEvent(evt) {
    if (!evt || typeof document === 'undefined') return;
    if (evt.type === 'download-progress') {
      if (typeof evt.percent === 'number') {
        this.state.updateState.progressPercent = evt.percent;
      }
      const label = document.querySelector('.fb-update-progress-label');
      if (label) {
        const received = Number(evt.received) || 0;
        const mb = (received / (1024 * 1024)).toFixed(1);
        label.textContent = typeof evt.percent === 'number'
          ? `Downloading update… ${evt.percent}%`
          : `Downloading update… ${mb} MB`;
      }
    } else if (evt.type === 'download-failed') {
      this.state.updateState = { ...this.state.updateState, status: 'error', notes: evt.reason || 'download failed' };
      this.requestRender();
    } else if (evt.type === 'install-finished') {
      // Package manager finished (e.g. pkexec dpkg -i) - the main process
      // relaunches Yayra on the new version right after this event.
      this.state.updateState = { ...this.state.updateState, status: 'installing' };
      this.requestRender();
      this.showTransientNotice(`Update${evt.version ? ` v${evt.version}` : ''} installed - Yayra is restarting on the new version…`);
    } else if (evt.type === 'install-failed') {
      // Honest failure (declined password prompt, dpkg error, …): the
      // verified download stays staged so Install can be retried.
      this.state.updateState = { ...this.state.updateState, status: 'staged', notes: evt.reason || 'install failed' };
      this.requestRender();
      const reason = evt.reason === 'authorization-declined'
        ? 'the system password prompt was cancelled'
        : (evt.reason || 'unknown error');
      this.showTransientNotice(`Install did not finish: ${reason}. The update stays downloaded - try again from Settings → Yayra Updates.`);
    }
  }

  /* -------------------------------------------------------------
   * REQUIREMENT 5: FULL RIGHT-SIDE DRAWER MENU WITH SUBMENUS (ZERO BLUR)
   * ----------------------------------------------------------- */
  renderSideDrawer(root) {
    // Keep the workspace crisp, but reserve the whole area outside the drawer
    // as a click target so the menu closes exactly like a native browser menu.
    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.className = 'fb-side-drawer-scrim';
    scrim.setAttribute('aria-label', 'Close Yayra menu');
    const closeDrawer = () => {
      this.state.isSideDrawerOpen = false;
      this.render();
    };
    scrim.addEventListener('click', closeDrawer);
    scrim.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      closeDrawer();
    });

    const drawer = document.createElement('div');
    drawer.className = 'fb-side-drawer-menu';

    const activeTab = this.getActiveTab() || { url: 'yayra://newtab', title: 'New Tab' };
    const isUpdateReady = this.state.updateState.status === 'ready' || this.state.updateState.status === 'available';

    drawer.innerHTML = `
      <header class="fb-side-drawer-header">
        <span class="fb-menu-wordmark" role="img" aria-label="yayra menu">${Icons.officialWordmark}</span>
        <button class="fb-btn-action fb-close-drawer-btn" aria-label="Close menu">${Icons.close}</button>
      </header>

      <div class="fb-side-drawer-content">
        <!-- 1. Top Update Section -->
        <div class="fb-drawer-update-section">
          ${isUpdateReady ? `
            <button class="fb-drawer-update-btn fb-update-ready-btn" title="Download, verify and install this update">
              <span class="fb-update-badge-icon">${Icons.update}</span>
              <div class="fb-update-text-group">
                <strong>Update Yayra (${this.state.updateState.availableVersion ? `v${this.state.updateState.availableVersion}` : 'Update available'})</strong>
                <span>${this.desktopUpdatesBridge && this.state.updateState.download?.url ? 'Click to download & install now' : 'Click to restart & update now'}</span>
              </div>
            </button>
          ` : this.state.updateState.status === 'downloading' ? `
            <div class="fb-drawer-update-status-row">
              <div class="fb-update-status-left">
                <span class="fb-status-orb pulse"></span>
                <span class="fb-update-status-text fb-update-progress-label">Downloading update… ${typeof this.state.updateState.progressPercent === 'number' ? `${this.state.updateState.progressPercent}%` : ''}</span>
              </div>
            </div>
          ` : this.state.updateState.status === 'staged' ? `
            <button class="fb-drawer-update-btn fb-drawer-install-btn" title="Install the downloaded & verified update now">
              <span class="fb-update-badge-icon">${Icons.update}</span>
              <div class="fb-update-text-group">
                <strong>Install Yayra ${this.state.updateState.availableVersion ? `v${this.state.updateState.availableVersion}` : 'update'}</strong>
                <span>Downloaded &amp; verified - click to install now</span>
              </div>
            </button>
          ` : this.state.updateState.status === 'installing' ? `
            <div class="fb-drawer-update-status-row">
              <div class="fb-update-status-left">
                <span class="fb-status-orb pulse"></span>
                <span class="fb-update-status-text">Installing update${this.state.updateState.availableVersion ? ` v${this.state.updateState.availableVersion}` : ''}…</span>
              </div>
            </div>
          ` : this.state.updateState.status === 'error' ? `
            <div class="fb-drawer-update-status-row">
              <div class="fb-update-status-left">
                <span class="fb-status-orb" style="background:#ef4444;"></span>
                <span class="fb-update-status-text">Update problem: ${this.state.updateState.notes || 'check failed'}</span>
              </div>
              <button class="fb-btn-action fb-check-updates-btn" title="Retry update check">${Icons.refresh}</button>
            </div>
          ` : `
            <div class="fb-drawer-update-status-row">
              <div class="fb-update-status-left">
                <span class="fb-status-orb ${this.state.updateState.status === 'checking' ? 'pulse' : 'green'}"></span>
                <span class="fb-update-status-text">${this.state.updateState.status === 'checking' ? 'Checking for updates...' : (this.state.updateState.installedVersion ? `Yayra v${this.state.updateState.installedVersion}${this.state.updateState.status === 'uptodate' ? ' (Latest)' : ''}` : 'Yayra is up to date')}</span>
              </div>
              <button class="fb-btn-action fb-check-updates-btn" title="Check for updates">${Icons.refresh}</button>
            </div>
          `}
          <button class="fb-drawer-item fb-update-options-btn" title="Open Yayra Updates settings">${Icons.download} <span>Update options</span></button>
        </div>

        <!-- 2. Primary Tabs/Windows -->
        <button class="fb-drawer-item fb-dr-newtab">${Icons.plus} <span>New tab</span> <kbd>Ctrl+T</kbd></button>
        <button class="fb-drawer-item fb-dr-newwin">${Icons.expand} <span>New window</span> <kbd>Ctrl+N</kbd></button>
        <button class="fb-drawer-item fb-dr-incognito">${Icons.incognito} <span>New Incognito window</span> <kbd>Ctrl+Shift+N</kbd></button>
        <div class="fb-drawer-separator"></div>

        <!-- 3. History with Submenu -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-history-parent">
            ${Icons.history} <span>History</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-tabsearch">${Icons.search} <span>Tab search</span> <kbd>Ctrl+Shift+A</kbd></button>
            <button class="fb-drawer-item fb-dr-reopen-tab">${Icons.tabs} <span>Reopen closed tab</span> <kbd>Ctrl+Shift+T</kbd></button>
            <div class="fb-drawer-separator"></div>
            <button class="fb-drawer-item fb-dr-history">${Icons.history} <span>Full history</span> <kbd>Ctrl+H</kbd></button>
            <button class="fb-drawer-item fb-dr-clear">${Icons.trash} <span>Clear browsing data</span> <kbd>Ctrl+Shift+Del</kbd></button>
          </div>
        </div>

        <!-- 4. Downloads -->
        <button class="fb-drawer-item fb-dr-downloads">${Icons.download} <span>Downloads</span> <kbd>Ctrl+J</kbd></button>

        <!-- 5. Bookmarks & Lists with Submenu -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-bm-parent">
            ${Icons.bookmark} <span>Bookmarks and lists</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-bm-curr">${Icons.star} <span>Bookmark this tab...</span> <kbd>Ctrl+D</kbd></button>
            <button class="fb-drawer-item fb-dr-bm-all">${Icons.starFilled} <span>Bookmark all tabs...</span> <kbd>Ctrl+Shift+D</kbd></button>
            <button class="fb-drawer-item fb-dr-bm-bar">${Icons.bookmark} <span>${this.state.settings.showBookmarksBar ? 'Hide bookmarks bar' : 'Show bookmarks bar'}</span> <kbd>Ctrl+Shift+B</kbd></button>
            <div class="fb-drawer-separator"></div>
            <button class="fb-drawer-item fb-dr-bookmarks">${Icons.folder} <span>Bookmark manager</span> <kbd>Ctrl+Shift+O</kbd></button>
            <button class="fb-drawer-item fb-dr-bm-import">${Icons.download} <span>Import bookmarks...</span></button>
          </div>
        </div>

        <!-- 6. Tab Groups with Submenu -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-tabgroups-parent">
            ${Icons.tabs} <span>Tab groups</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-tg-new">${Icons.plus} <span>New tab group</span></button>
            <button class="fb-drawer-item fb-dr-tg-add">${Icons.tabs} <span>Group current tab</span></button>
            <button class="fb-drawer-item fb-dr-tg-ungroup">${Icons.close} <span>Ungroup tabs</span></button>
            <button class="fb-drawer-item fb-dr-tg-manage">${Icons.settings} <span>Manage tab groups</span></button>
          </div>
        </div>

        <!-- 7. Extensions with Submenu -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-ext-parent">
            ${Icons.shield} <span>Extensions</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-extensions">${Icons.shield} <span>Manage extensions</span></button>
            <button class="fb-drawer-item fb-dr-ext-store">${Icons.externalLink} <span>Yayra extension store</span></button>
            <button class="fb-drawer-item fb-dr-permissions">${Icons.lock} <span>Shield & site permissions</span></button>
          </div>
        </div>

        <!-- 8. Delete browsing data -->
        <button class="fb-drawer-item fb-dr-clear-site-cache">${Icons.refresh} <span>Clear cache for this site</span> <kbd>Ctrl+Shift+R</kbd></button>
        <button class="fb-drawer-item fb-dr-clear">${Icons.trash} <span>Delete browsing data...</span> <kbd>Ctrl+Shift+Del</kbd></button>
        <div class="fb-drawer-separator"></div>

        <!-- 9. Zoom & Fullscreen -->
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px;">
          <span style="font-size:0.875rem; color:var(--fb-text-secondary);">${Icons.search} Zoom</span>
          <div style="display:flex; align-items:center; gap:6px;">
            <button class="fb-btn-action fb-dr-zoom-out" style="width:26px; height:26px;">−</button>
            <span style="font-size:0.85rem; font-weight:700; min-width:40px; text-align:center;">${this.state.zoomLevel}%</span>
            <button class="fb-btn-action fb-dr-zoom-in" style="width:26px; height:26px;">+</button>
            <button class="fb-btn-action fb-dr-fullscreen" style="width:26px; height:26px;" title="Toggle Fullscreen">${Icons.expand}</button>
          </div>
        </div>

        <!-- 10. Page Tools -->
        <button class="fb-drawer-item fb-dr-print">${Icons.print} <span>Print...</span> <kbd>Ctrl+P</kbd></button>
        <button class="fb-drawer-item fb-dr-lens">${Icons.lens} <span>Search this tab with Google Lens</span></button>
        <button class="fb-drawer-item fb-dr-translate">${Icons.translate} <span>Translate...</span></button>

        <!-- 11. Find and Edit with Submenu -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-find-parent">
            ${Icons.search} <span>Find and edit</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-find">${Icons.search} <span>Find in page...</span> <kbd>Ctrl+F</kbd></button>
            <div class="fb-drawer-separator"></div>
            <button class="fb-drawer-item fb-dr-cut">${Icons.edit} <span>Cut</span> <kbd>Ctrl+X</kbd></button>
            <button class="fb-drawer-item fb-dr-copy">${Icons.copy} <span>Copy</span> <kbd>Ctrl+C</kbd></button>
            <button class="fb-drawer-item fb-dr-paste">${Icons.save} <span>Paste</span> <kbd>Ctrl+V</kbd></button>
          </div>
        </div>

        <!-- 12. Cast, Save, and Share with Submenu (Matching Image 3) -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-cast-parent">
            ${Icons.save} <span>Cast, save, and share</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <div class="fb-submenu-section-label">Cast</div>
            <button class="fb-drawer-item fb-dr-cast">${Icons.cast} <span>Cast...</span></button>

            <div class="fb-submenu-section-label">Save</div>
            <button class="fb-drawer-item fb-dr-save-page">${Icons.save} <span>Save page as...</span> <kbd>Ctrl+S</kbd></button>
            <button class="fb-drawer-item fb-dr-open-doc">${Icons.document} <span>Open document... (PDF)</span></button>
            <button class="fb-drawer-item fb-dr-install-app">${Icons.download} <span>Install page as app...</span></button>
            <button class="fb-drawer-item fb-dr-open-pharmagame">${Icons.sparkles} <span>Open in pharmaGAME Ai</span></button>
            <button class="fb-drawer-item fb-dr-create-shortcut">${Icons.externalLink} <span>Create shortcut...</span></button>

            <div class="fb-submenu-section-label">Share</div>
            <button class="fb-drawer-item fb-dr-copy-link">${Icons.copy} <span>Copy link</span></button>
            <button class="fb-drawer-item fb-dr-send-devices">${Icons.devices} <span>Send to your devices</span></button>
            <button class="fb-drawer-item fb-dr-qr-code">${Icons.qrCode} <span>Create QR Code</span></button>
          </div>
        </div>

        <!-- 13. More Tools with Submenu (Matching Image 1) -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-moretools-parent">
            ${Icons.settings} <span>More tools</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-tabsearch">${Icons.search} <span>Tab search</span> <kbd>Ctrl+Shift+A</kbd></button>
            <button class="fb-drawer-item fb-dr-name-win">${Icons.edit} <span>Name window...</span></button>
            <button class="fb-drawer-item fb-dr-customize-yayra">${Icons.brush} <span>Customize yayra</span></button>
            <div class="fb-drawer-separator"></div>
            <button class="fb-drawer-item fb-dr-reading-mode">${Icons.readingMode} <span>Reading mode</span></button>
            <button class="fb-drawer-item fb-dr-performance">${Icons.performance} <span>Performance</span></button>
            <button class="fb-drawer-item fb-dr-task-mgr">${Icons.taskManager} <span>Task manager</span></button>
            <div class="fb-drawer-separator"></div>
            <button class="fb-drawer-item fb-dr-devtools">${Icons.developerTools} <span>Developer tools</span> <kbd>Ctrl+Shift+I</kbd></button>
          </div>
        </div>

        <div class="fb-drawer-separator"></div>

        <!-- 14. Help with Submenu (Matching Image 2) -->
        <div class="fb-drawer-item-has-submenu">
          <button class="fb-drawer-item fb-dr-help-parent">
            ${Icons.help} <span>Help</span> <span class="fb-submenu-arrow">${Icons.chevronRight}</span>
          </button>
          <div class="fb-drawer-submenu">
            <button class="fb-drawer-item fb-dr-about">${Icons.officialOrb} <span>About yayra</span></button>
            <button class="fb-drawer-item fb-dr-whatsnew">${Icons.whatNew} <span>What's New</span></button>
            <button class="fb-drawer-item fb-dr-help-center">${Icons.help} <span>Help center</span></button>
            <button class="fb-drawer-item fb-dr-report-issue">${Icons.report} <span>Report an issue...</span> <kbd>Alt+Shift+I</kbd></button>
          </div>
        </div>

        <!-- 15. Settings & Exit -->
        <button class="fb-drawer-item fb-dr-settings">${Icons.settings} <span>Settings</span></button>
        <button class="fb-drawer-item fb-dr-exit">${Icons.close} <span>Exit</span></button>
      </div>
    `;

    // Existing groups are direct one-click entries as well as being
    // available in the full picker. Build their labels as text nodes so a
    // user-entered name can never be parsed as HTML.
    const groupSubmenu = drawer.querySelector('.fb-dr-tabgroups-parent')?.parentElement?.querySelector('.fb-drawer-submenu');
    const tabGroups = this.getTabGroups();
    if (groupSubmenu && tabGroups.length) {
      const separator = document.createElement('div');
      separator.className = 'fb-drawer-separator';
      groupSubmenu.appendChild(separator);
      const label = document.createElement('div');
      label.className = 'fb-submenu-section-label';
      label.textContent = 'Open group';
      groupSubmenu.appendChild(label);
      for (const group of tabGroups) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fb-drawer-item fb-dr-tg-open';
        button.setAttribute('aria-label', `Open ${group.name} group (${group.tabs.length} tabs)`);
        const swatch = document.createElement('span');
        swatch.className = 'fb-drawer-group-swatch';
        swatch.style.background = group.color;
        const name = document.createElement('span');
        name.className = 'fb-drawer-group-name';
        name.textContent = group.name;
        const count = document.createElement('small');
        count.className = 'fb-drawer-group-count';
        count.textContent = String(group.tabs.length);
        button.appendChild(swatch);
        button.appendChild(name);
        button.appendChild(count);
        button.addEventListener('click', () => {
          this.state.isSideDrawerOpen = false;
          this.openTabGroup(group.id);
        });
        groupSubmenu.appendChild(button);
      }
    }

    // Event Listeners
    drawer.querySelector('.fb-close-drawer-btn')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
    });

    // Update Action Button
    drawer.querySelector('.fb-check-updates-btn')?.addEventListener('click', () => {
      this.checkForUpdates(true);
    });

    // Full update controls live in Settings -> Yayra Updates.
    drawer.querySelector('.fb-update-options-btn')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.state.settingsActiveCategory = 'updates';
      this.state.activeSettingsCategory = 'updates';
      this.openInternalPage('yayra://settings');
    });

    drawer.querySelector('.fb-update-ready-btn')?.addEventListener('click', () => {
      // Direct action: the one-time confirm() prompt may already have been
      // shown and dismissed - clicking the drawer button must always start
      // the actual update, not silently no-op behind the prompt guard.
      this.state.isSideDrawerOpen = false;
      this.render();
      this.applyUpdate();
    });

    // Staged (downloaded & verified) update: the drawer's primary action
    // is plain "Install" - it never re-downloads.
    drawer.querySelector('.fb-drawer-install-btn')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.installDesktopUpdateNow();
    });

    // Submenus are lateral flyouts, never inline accordions. Move the active
    // panel out of the scrollable menu list so its absolute positioning can
    // escape the list's overflow boundary while remaining part of the drawer.
    const submenuEntries = Array.from(drawer.querySelectorAll('.fb-drawer-item-has-submenu'))
      .map((parent) => {
        const button = parent.querySelector('.fb-drawer-item');
        const submenu = parent.querySelector('.fb-drawer-submenu');
        if (!button || !submenu) return null;
        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-expanded', 'false');
        submenu.setAttribute('role', 'menu');
        submenu.querySelectorAll('.fb-drawer-item').forEach((item) => item.setAttribute('role', 'menuitem'));
        return { parent, button, submenu };
      })
      .filter(Boolean);
    const pinnedSubmenus = new Set();

    const positionFlyout = ({ button, submenu }) => {
      const drawerRect = drawer.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || rootRect.right || 1024;
      const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || rootRect.bottom || 768;
      const hasRootBounds = rootRect.width > 0 && rootRect.height > 0;
      const leftEdge = hasRootBounds ? Math.max(8, rootRect.left + 8) : 8;
      const rightEdge = hasRootBounds ? Math.min(viewportWidth - 8, rootRect.right - 8) : viewportWidth - 8;
      const topEdge = hasRootBounds ? Math.max(8, rootRect.top + 8) : 8;
      const bottomEdge = hasRootBounds ? Math.min(viewportHeight - 8, rootRect.bottom - 8) : viewportHeight - 8;
      const availableWidth = Math.max(1, rightEdge - leftEdge);
      const availableHeight = Math.max(1, bottomEdge - topEdge);

      // Bound the flyout to its host as well as the viewport. That matters for
      // the resizable mini window, whose rounded frame clips anything outside.
      submenu.style.width = `${Math.min(270, availableWidth)}px`;
      submenu.style.maxHeight = `${availableHeight}px`;
      const submenuRect = submenu.getBoundingClientRect();
      const submenuWidth = submenuRect.width || Math.min(270, availableWidth);
      const submenuHeight = submenuRect.height || Math.min(submenu.scrollHeight || 240, availableHeight);
      const maxLeft = Math.max(leftEdge, rightEdge - submenuWidth);
      const left = Math.max(leftEdge, Math.min(drawerRect.left - submenuWidth + 1, maxLeft));
      const maxTop = Math.max(topEdge, bottomEdge - submenuHeight);
      const top = Math.max(topEdge, Math.min(buttonRect.top - 4, maxTop));

      // The submenu is positioned relative to the drawer; clamp both axes so
      // flyouts stay usable on narrow screens and near the bottom of the menu.
      submenu.style.left = `${Math.round(left - drawerRect.left)}px`;
      submenu.style.right = 'auto';
      submenu.style.top = `${Math.round(top - drawerRect.top)}px`;
    };

    const closeFlyout = (entry) => {
      pinnedSubmenus.delete(entry.parent);
      entry.parent.classList.remove('open');
      entry.button.setAttribute('aria-expanded', 'false');
      entry.submenu.classList.remove('is-open');
      if (entry.submenu.parentElement === drawer) entry.parent.appendChild(entry.submenu);
      entry.submenu.style.left = '';
      entry.submenu.style.right = '';
      entry.submenu.style.top = '';
      entry.submenu.style.width = '';
      entry.submenu.style.maxHeight = '';
    };

    const closeOtherFlyouts = (activeEntry) => {
      submenuEntries.forEach((entry) => {
        if (entry !== activeEntry) closeFlyout(entry);
      });
    };

    const openFlyout = (entry) => {
      closeOtherFlyouts(entry);
      if (entry.submenu.parentElement !== drawer) drawer.appendChild(entry.submenu);
      entry.parent.classList.add('open');
      entry.button.setAttribute('aria-expanded', 'true');
      entry.submenu.classList.add('is-open');
      positionFlyout(entry);
    };

    submenuEntries.forEach((entry) => {
      entry.parent.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'touch') return;
        openFlyout(entry);
      });

      entry.parent.addEventListener('pointerleave', (event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget && (entry.submenu.contains?.(nextTarget) || entry.parent.contains?.(nextTarget))) return;
        if (!pinnedSubmenus.has(entry.parent)) closeFlyout(entry);
      });

      entry.submenu.addEventListener('pointerleave', (event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget && (entry.parent.contains?.(nextTarget) || entry.submenu.contains?.(nextTarget))) return;
        if (!pinnedSubmenus.has(entry.parent)) closeFlyout(entry);
      });

      entry.button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (pinnedSubmenus.has(entry.parent)) {
          closeFlyout(entry);
          return;
        }
        closeOtherFlyouts(entry);
        pinnedSubmenus.add(entry.parent);
        openFlyout(entry);
      });
    });

    drawer.querySelector('.fb-side-drawer-content')?.addEventListener('scroll', () => {
      submenuEntries.forEach(closeFlyout);
    }, { passive: true });

    drawer.querySelector('.fb-dr-newtab')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.createNewTab();
    });

    drawer.querySelector('.fb-dr-newwin')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.duplicateFloatingMini();
    });

    drawer.querySelector('.fb-dr-incognito')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.createNewTab(true);
    });

    drawer.querySelector('.fb-dr-history')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://history');
    });

    drawer.querySelector('.fb-dr-reopen-tab')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.reopenLastClosedTab();
    });

    drawer.querySelectorAll('.fb-dr-tabsearch').forEach((button) => {
      button.addEventListener('click', () => {
        this.state.isSideDrawerOpen = false;
        this.openModal('tab-switcher');
      });
    });

    drawer.querySelector('.fb-dr-tg-new')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.createTabGroup();
    });

    drawer.querySelector('.fb-dr-tg-add')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.groupCurrentTab();
    });

    drawer.querySelector('.fb-dr-tg-ungroup')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.ungroupAllTabs();
    });

    drawer.querySelector('.fb-dr-tg-manage')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openTabGroupsSettings();
    });

    drawer.querySelector('.fb-dr-downloads')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://downloads');
    });

    drawer.querySelector('.fb-dr-bookmarks')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://bookmarks');
    });

    drawer.querySelector('.fb-dr-bm-curr')?.addEventListener('click', async () => {
      this.state.isSideDrawerOpen = false;
      await this.toggleBookmarkCurrentTab();
    });

    drawer.querySelector('.fb-dr-bm-all')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.bookmarkAllTabs();
    });

    drawer.querySelector('.fb-dr-bm-bar')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      // Real toggle: persisted per profile + the bar actually renders
      // under the toolbar (see renderBookmarksBar).
      this.state.settings = { ...this.state.settings, showBookmarksBar: !this.state.settings.showBookmarksBar };
      this.persistSettings();
      this.render();
      this.showTransientNotice(this.state.settings.showBookmarksBar
        ? 'Bookmarks bar shown. Star pages to fill it.'
        : 'Bookmarks bar hidden.');
    });

    drawer.querySelector('.fb-dr-bm-import')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.importBookmarks();
    });

    drawer.querySelector('.fb-dr-extensions')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://extensions');
    });

    drawer.querySelector('.fb-dr-ext-store')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://extensions');
    });

    drawer.querySelector('.fb-dr-permissions')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://permissions');
    });

    drawer.querySelector('.fb-dr-settings')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://settings');
    });

    drawer.querySelector('.fb-dr-about')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://about');
    });

    drawer.querySelector('.fb-dr-whatsnew')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openInternalPage('yayra://about');
    });

    drawer.querySelector('.fb-dr-help-center')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.navigateActiveTab('https://github.com/g2code33/yayra#readme');
    });

    drawer.querySelector('.fb-dr-report-issue')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.navigateActiveTab('https://github.com/g2code33/yayra/issues');
    });

    drawer.querySelector('.fb-dr-clear')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openModal('clear-data');
    });

    drawer.querySelector('.fb-dr-clear-site-cache')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.clearActiveSiteCache();
    });

    drawer.querySelector('.fb-dr-find')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.state.findInPage.isOpen = true;
      this.render();
    });

    drawer.querySelector('.fb-dr-cut')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.cutSelectionToClipboard();
    });

    drawer.querySelector('.fb-dr-copy')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.copySelectionToClipboard();
    });

    drawer.querySelector('.fb-dr-paste')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.pasteIntoFocusedField();
    });

    drawer.querySelector('.fb-dr-zoom-in')?.addEventListener('click', () => {
      this.setZoom(Math.min(200, this.state.zoomLevel + 10));
    });

    drawer.querySelector('.fb-dr-zoom-out')?.addEventListener('click', () => {
      this.setZoom(Math.max(50, this.state.zoomLevel - 10));
    });

    drawer.querySelector('.fb-dr-fullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    });

    drawer.querySelector('.fb-dr-print')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.printActivePage();
    });

    drawer.querySelector('.fb-dr-lens')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      const url = activeTab.url || 'https://yayra.app';
      this.navigateActiveTab(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`);
    });

    drawer.querySelector('.fb-dr-translate')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.translateActivePage();
    });

    // Cast, Save, and Share Actions
    drawer.querySelector('.fb-dr-cast')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      // Honest: Chromecast/AirPlay discovery isn't implemented in Yayra yet.
      this.showTransientNotice('Casting to TVs/displays is not available in Yayra yet.');
    });

    drawer.querySelector('.fb-dr-save-page')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.savePageAs();
    });

    drawer.querySelector('.fb-dr-open-pharmagame')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.navigateActiveTab('https://github.com/g2code33/pharmaTRACK_PERFECT_new');
    });

    drawer.querySelector('.fb-dr-open-doc')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.openDocument();
    });

    drawer.querySelector('.fb-dr-install-app')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.installPageAsApp();
    });

    drawer.querySelector('.fb-dr-create-shortcut')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.createShortcutForActivePage();
    });

    drawer.querySelector('.fb-dr-copy-link')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(activeTab.url);
          this.showTransientNotice('Page link copied to clipboard.');
          return;
        }
      } catch { /* fall through */ }
      this.showTransientNotice("Couldn't reach the clipboard on this device.");
    });

    drawer.querySelector('.fb-dr-send-devices')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      // Honest "send to devices": no cloud sync exists, so hand the page
      // over the real way - scan the QR with the other device.
      this.showUrlQrModal(activeTab.url, {
        title: 'Send to your devices',
        subtitle: 'Yayra has no cloud tab-sync yet - scan this with the other device to open the page there.'
      });
    });

    drawer.querySelector('.fb-dr-qr-code')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.showUrlQrModal(activeTab.url);
    });

    // More Tools Actions
    drawer.querySelector('.fb-dr-name-win')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.nameThisWindow();
    });

    drawer.querySelector('.fb-dr-customize-yayra')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.openModal('radial-customizer');
    });

    drawer.querySelector('.fb-dr-reading-mode')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.openReadingMode();
    });

    drawer.querySelector('.fb-dr-performance')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.openTaskManagerModal();
    });

    drawer.querySelector('.fb-dr-task-mgr')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.openTaskManagerModal();
    });

    drawer.querySelector('.fb-dr-devtools')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.render();
      this.openDevToolsForActiveTab();
    });

    // Exit means quit the whole app (including the desktop bubble/tray),
    // not just close this window. Web builds explain that only the browser
    // can close its own tab.
    drawer.querySelector('.fb-dr-exit')?.addEventListener('click', () => {
      this.state.isSideDrawerOpen = false;
      this.exitYayra();
    });

    root.appendChild(scrim);
    root.appendChild(drawer);
  }

  /* -------------------------------------------------------------
   * FIND IN PAGE TOOLBAR
   * ----------------------------------------------------------- */
  renderFindInPageBar(root) {
    const bar = document.createElement('div');
    bar.className = 'fb-find-in-page-bar';
    bar.innerHTML = `
      <input type="text" class="fb-find-input" placeholder="Find in page" value="${this.state.findInPage.query}" autofocus />
      <span class="fb-find-count">${this.state.findInPage.currentMatch}/${this.state.findInPage.matchesCount}</span>
      <button class="fb-find-btn fb-find-prev" title="Previous match">${Icons.arrowLeft}</button>
      <button class="fb-find-btn fb-find-next" title="Next match">${Icons.arrowRight}</button>
      <button class="fb-find-btn fb-find-close" title="Close">${Icons.close}</button>
    `;

    bar.querySelector('.fb-find-close')?.addEventListener('click', () => {
      this.state.findInPage.isOpen = false;
      this.state.findInPage.query = '';
      this.render();
    });

    root.appendChild(bar);
  }

  /* -------------------------------------------------------------
   * MODALS & DIALOGS
   * ----------------------------------------------------------- */
  renderActiveModal(root) {
    if (!this.state.activeModal) return;

    const backdrop = document.createElement('div');
    backdrop.className = `fb-modal-backdrop ${this.state.activeModal === 'search-overlay' ? 'fb-search-backdrop' : ''}`;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    const modal = document.createElement('div');

    switch (this.state.activeModal) {
      case 'menu':
        this.renderMenuModal(modal);
        break;
      case 'history':
        this.renderHistoryModal(modal);
        break;
      case 'bookmarks':
        this.renderBookmarksModal(modal);
        break;
      case 'settings':
        this.renderSettingsModal(modal);
        break;
      case 'clear-data':
        this.renderClearDataModal(modal);
        break;
      case 'edit-shortcut':
        this.renderEditShortcutModal(modal);
        break;
      case 'tab-switcher':
        this.renderTabSwitcherModal(modal);
        break;
      case 'tab-groups':
        this.renderTabGroupsModal(modal);
        break;
      case 'search-overlay':
        this.renderMobileSearchOverlay(modal);
        break;
      case 'sponsored-manager':
        this.renderSponsoredManagerModal(modal);
        break;
      case 'radial-customizer':
        this.renderRadialCustomizerModal(modal);
        break;
      default:
        return;
    }

    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }

  renderRadialCustomizerModal(modal) {
    modal.className = 'fb-modal-card fb-modal-radial-customizer';
    const actions = this.getRadialActions();
    const bookmarks = this.state.bookmarksItems || [];

    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">Customize Radial Action Wheel & Bookmarks</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body" style="display:flex; flex-direction:column; gap:14px; max-height:70vh; overflow-y:auto;">
        <div>
          <h3 class="fb-rc-section-title" style="font-size:0.85rem; font-weight:700; color:var(--fb-text-muted); text-transform:uppercase; margin:8px 0;">Current Wheel Items (${actions.length})</h3>
          <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:8px;">
            ${actions.map((item, idx) => `
              <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(255,255,255,0.06); border-radius:8px; border:1px solid rgba(255,255,255,0.08);">
                <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                  <span style="width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center;">${this.wheelIconHtml(item)}</span>
                  <span style="font-size:0.825rem; font-weight:600; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${item.title}</span>
                </div>
                <button class="fb-btn fb-btn-secondary fb-del-radial-item-btn" data-idx="${idx}" style="padding:2px 6px; font-size:12px;" title="Remove Item">${Icons.trash}</button>
              </div>
            `).join('')}
          </div>
        </div>

        <div>
          <h3 class="fb-rc-section-title" style="font-size:0.85rem; font-weight:700; color:var(--fb-text-muted); text-transform:uppercase; margin:8px 0;">Add from Bookmarks & Favorites</h3>
          ${bookmarks.length === 0 ? `
            <p style="font-size:0.8rem; color:var(--fb-text-muted); margin:4px 0;">No bookmarks saved yet. Star a webpage to add it to bookmarks.</p>
          ` : `
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:8px;">
              ${bookmarks.map((bm) => {
                let domain = bm.url;
                try { domain = new URL(bm.url).hostname; } catch {}
                return `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid rgba(255,255,255,0.08);">
                  <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                    <img src="https://icons.duckduckgo.com/ip3/${domain}.ico" style="width:16px; height:16px; border-radius:50%;" alt="" />
                    <span style="font-size:0.825rem; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${bm.title || bm.url}</span>
                  </div>
                  <button class="fb-btn fb-btn-primary fb-add-bm-to-wheel-btn" data-url="${bm.url}" data-title="${bm.title || bm.url}" style="padding:2px 8px; font-size:11px;">+ Add</button>
                </div>
              `;}).join('')}
            </div>
          `}
        </div>

        <div>
          <h3 class="fb-rc-section-title" style="font-size:0.85rem; font-weight:700; color:var(--fb-text-muted); text-transform:uppercase; margin:8px 0;">Add Custom Website / Tool</h3>
          <div style="display:flex; gap:8px;">
            <input type="text" id="fb-rc-custom-title" placeholder="Title (e.g. YouTube)" class="fb-input" style="flex:1;" />
            <input type="text" id="fb-rc-custom-url" placeholder="https://youtube.com" class="fb-input" style="flex:2;" />
            <button class="fb-btn fb-btn-primary fb-add-custom-wheel-btn">${Icons.plus} Add</button>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; margin-top:8px;">
          <button class="fb-btn fb-btn-secondary fb-reset-radial-btn">Reset Defaults</button>
          <button class="fb-btn fb-btn-primary fb-done-radial-btn">Done</button>
        </div>
      </div>
    `;

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-done-radial-btn')?.addEventListener('click', () => this.closeModal());

    modal.querySelectorAll('.fb-del-radial-item-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const current = [...this.getRadialActions()];
        current.splice(idx, 1);
        this.saveWheelItems(current);
        this.renderRadialCustomizerModal(modal);
      });
    });

    modal.querySelectorAll('.fb-add-bm-to-wheel-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        const title = btn.dataset.title;
        const current = [...this.getRadialActions()];
        // Real favicon + position are derived at render time (see
        // wheelIconHtml/applyWheelLayout); only plain data is stored.
        current.push({ id: `site-${Date.now()}`, title, url, type: 'site' });
        this.saveWheelItems(current);
        this.renderRadialCustomizerModal(modal);
      });
    });

    modal.querySelector('.fb-add-custom-wheel-btn')?.addEventListener('click', () => {
      const title = modal.querySelector('#fb-rc-custom-title')?.value.trim();
      const url = modal.querySelector('#fb-rc-custom-url')?.value.trim();
      if (title && url) {
        let fullUrl = url;
        if (!/^https?:\/\//i.test(fullUrl)) fullUrl = `https://${fullUrl}`;
        const current = [...this.getRadialActions()];
        current.push({ id: `custom-${Date.now()}`, title, url: fullUrl, type: 'site' });
        this.saveWheelItems(current);
        this.renderRadialCustomizerModal(modal);
      }
    });

    modal.querySelector('.fb-reset-radial-btn')?.addEventListener('click', () => {
      this.saveWheelItems([]);
      if (typeof localStorage !== 'undefined') {
        try { localStorage.removeItem('yayra_radial_actions'); } catch { /* legacy key */ }
      }
      this.renderRadialCustomizerModal(modal);
    });
  }

  renderSponsoredManagerModal(modal) {
    modal.className = 'fb-modal-card fb-modal-sponsored-manager';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">Manage Featured & Advertisement Links</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body" style="display:flex; flex-direction:column; gap:12px;">
        <p style="font-size:0.85rem; color:var(--fb-text-secondary); margin:0;">
          Add custom links to display on the New Tab page above the Yayra logo. Favicons are automatically retrieved.
        </p>
        <div style="display:flex; gap:8px;">
          <input type="text" id="fb-new-sp-title" placeholder="Title (e.g. My Website)" class="fb-input" style="flex:1;" />
          <input type="text" id="fb-new-sp-url" placeholder="https://example.com" class="fb-input" style="flex:2;" />
          <input type="text" id="fb-new-sp-tag" placeholder="Tag (optional)" class="fb-input" style="flex:1;" />
          <button class="fb-btn fb-btn-primary fb-add-sp-btn">${Icons.plus} Add</button>
        </div>
        <div class="fb-sp-list" style="display:flex; flex-direction:column; gap:8px; max-height:240px; overflow-y:auto; margin-top:8px;">
          ${this.state.sponsoredLinks.map((item, idx) => `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:rgba(255,255,255,0.05); border-radius:8px;">
              <div>
                <strong>${item.title}</strong>
                <span style="font-size:0.75rem; color:var(--fb-text-muted); display:block;">${item.url}</span>
              </div>
              <button class="fb-btn fb-btn-secondary fb-del-sp-btn" data-idx="${idx}">${Icons.trash}</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-add-sp-btn')?.addEventListener('click', () => {
      const title = modal.querySelector('#fb-new-sp-title')?.value.trim();
      const url = modal.querySelector('#fb-new-sp-url')?.value.trim();
      const tag = modal.querySelector('#fb-new-sp-tag')?.value.trim();
      if (title && url) {
        let domain = url;
        try { domain = new URL(url).hostname; } catch {}
        this.state.sponsoredLinks.push({ id: `sp-${Date.now()}`, title, url, tag, domain });
        this.renderSponsoredManagerModal(modal);
      }
    });

    modal.querySelectorAll('.fb-del-sp-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        this.state.sponsoredLinks.splice(idx, 1);
        this.renderSponsoredManagerModal(modal);
      });
    });
  }

  renderMenuModal(modal) {
    modal.className = 'fb-modal-card fb-chrome-menu-card fb-modal-menu';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title"><span class="fb-menu-wordmark" role="img" aria-label="yayra menu">${Icons.officialWordmark}</span></h2>
        <button class="fb-modal-close-btn" aria-label="Close menu">${Icons.close}</button>
      </div>
      <div class="fb-modal-body fb-menu-grid">
        <button class="fb-menu-item fb-btn-new-tab" data-action="new-tab">${Icons.plus} <span>New Tab</span></button>
        <button class="fb-menu-item" data-action="new-window">${Icons.expand} <span>New Window</span></button>
        <button class="fb-menu-item fb-btn-incognito" data-action="new-incognito-tab">${Icons.incognito} <span>New Incognito Tab</span></button>
        <button class="fb-menu-item" data-action="reopen-closed-tab">${Icons.history} <span>Reopen Closed Tab</span></button>
        <button class="fb-menu-item" data-action="find-in-page">${Icons.search} <span>Find in Page</span></button>
        <button class="fb-menu-item" data-action="print">${Icons.refresh} <span>Print</span></button>
        <button class="fb-menu-item" data-action="share">${Icons.forward} <span>Share</span></button>
        <button class="fb-menu-item" data-action="passwords">${Icons.lock} <span>Passwords</span></button>
        <button class="fb-menu-item fb-btn-history" data-action="history">${Icons.history} <span>History</span></button>
        <button class="fb-menu-item fb-btn-bookmarks" data-action="bookmarks">${Icons.bookmark} <span>Bookmarks</span></button>
        <button class="fb-menu-item fb-btn-downloads" data-action="downloads">${Icons.download} <span>Downloads</span></button>
        <button class="fb-menu-item" data-action="clear-data">${Icons.trash} <span>Clear Data</span></button>
        <button class="fb-menu-item" data-action="extensions">${Icons.puzzle} <span>Extensions</span></button>
        <button class="fb-menu-item" data-action="permissions">${Icons.shield} <span>Permissions</span></button>
        <button class="fb-menu-item fb-btn-settings" data-action="settings">${Icons.settings} <span>Settings</span></button>
        <button class="fb-menu-item" data-action="about">${Icons.info} <span>About</span></button>
      </div>
    `;

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelectorAll('.fb-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        this.closeModal();
        switch (action) {
          case 'new-tab': this.createNewTab(); break;
          case 'new-window': this.createNewTab(); break;
          case 'new-incognito-tab': this.createNewTab(true); break;
          case 'reopen-closed-tab': this.reopenLastClosedTab(); break;
          case 'find-in-page': this.executeFindInPage(); break;
          case 'passwords': this.openInternalPage('yayra://passwords'); break;
          case 'history': this.openInternalPage('yayra://history'); break;
          case 'bookmarks': this.openInternalPage('yayra://bookmarks'); break;
          case 'downloads': this.openInternalPage('yayra://downloads'); break;
          case 'clear-data': this.openModal('clear-data'); break;
          case 'extensions': this.openInternalPage('yayra://extensions'); break;
          case 'permissions': this.openInternalPage('yayra://permissions'); break;
          case 'settings': this.openInternalPage('yayra://settings'); break;
          case 'about': this.openInternalPage('yayra://about'); break;
        }
      });
    });
  }

  renderTabSwitcherModal(modal) {
    modal.className = 'fb-modal-card fb-modal-tab-switcher fb-mobile-tabswitcher-card';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.tabs} Tabs (${this.state.tabs.length})</h2>
        <div style="display:flex; gap:8px;">
          <button class="fb-btn fb-btn-primary fb-mobile-addtab-btn">${Icons.plus} New Tab</button>
          <button class="fb-modal-close-btn">${Icons.close}</button>
        </div>
      </div>
      <div class="fb-modal-body fb-mobile-tabs-grid">
        ${this.state.tabs.map((tab) => {
          // Real page preview: the last capturePage() snapshot of this
          // tab's native view (taken when overlays open, when switching
          // away from a tab, and when this switcher opens). Tabs that
          // were never on screen since launch fall back to an honest
          // favicon + URL placeholder instead of a fake thumbnail.
          const snapshot = this._pageSnapshots.get(tab.id);
          return `
          <div class="fb-tab-card fb-mobile-tab-card ${tab.id === this.state.activeTabId ? 'active' : ''}" data-tab-id="${tab.id}">
            <div class="fb-mobile-tab-header">
              <span class="fb-mobile-tab-title">${this.getTabTitle(tab)}</span>
              <button class="fb-mobile-tab-close" data-tab-id="${tab.id}">${Icons.close}</button>
            </div>
            <div class="fb-mobile-tab-preview fb-tab-card-preview">
              ${snapshot
                ? `<img class="fb-tab-preview-img" src="${snapshot}" alt="" draggable="false" />`
                : `<span class="fb-tab-preview-placeholder">
                     <span class="fb-tab-preview-favicon">${this.getTabFavicon(tab)}</span>
                     <span class="fb-mobile-tab-url">${tab.url}</span>
                   </span>`}
            </div>
          </div>`;
        }).join('')}
      </div>
    `;

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-mobile-addtab-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.createNewTab();
    });

    modal.querySelectorAll('.fb-mobile-tab-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.fb-mobile-tab-close')) return;
        this.selectTab(card.dataset.tabId);
        this.closeModal();
      });
    });

    modal.querySelectorAll('.fb-mobile-tab-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(btn.dataset.tabId);
        if (this.state.tabs.length === 0) {
          this.closeModal();
        } else {
          this.renderTabSwitcherModal(modal);
        }
      });
    });
  }

  renderHistoryModal(modal) {
    modal.className = 'fb-modal-card fb-modal-history';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.history} Browsing History</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body">
        <div class="fb-history-list">
          ${this.state.historyItems.map((h) => `
            <div class="fb-history-item" data-url="${h.url}">
              <span>${h.title || h.url}</span>
              <span class="fb-history-url">${h.url}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
  }

  renderBookmarksModal(modal) {
    modal.className = 'fb-modal-card fb-modal-bookmarks';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.bookmark} Bookmarks</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body">
        <div class="fb-bookmarks-list">
          ${this.state.bookmarksItems.map((b) => `
            <div class="fb-bookmark-item" data-url="${b.url}">
              <span>${b.title}</span>
              <span class="fb-bookmark-url">${b.url}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
  }

  renderSettingsModal(modal) {
    modal.className = 'fb-modal-card fb-settings-modal-card fb-modal-settings';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.settings} Floating Transparency Settings</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body" style="display:flex; flex-direction:column; gap:16px;">
        <div>
          <label style="display:flex; justify-content:space-between;">Bubble Opacity <span id="val-bubble-op">${Math.round((this.state.settings.bubbleOpacity || 0.88) * 100)}%</span></label>
          <input type="range" id="fb-slider-bubble-opacity" min="20" max="100" value="${Math.round((this.state.settings.bubbleOpacity || 0.88) * 100)}" class="fb-slider" style="width:100%;" />
        </div>
        <div>
          <label style="display:flex; justify-content:space-between;">Bubble Shadow <span id="val-bubble-shadow">${Math.max(0, Math.min(24, Number(this.state.settings.bubbleShadowPx) || 0))}px</span></label>
          <input type="range" id="fb-slider-bubble-shadow" min="0" max="24" step="1" value="${Math.max(0, Math.min(24, Number(this.state.settings.bubbleShadowPx) || 0))}" class="fb-slider" style="width:100%;" />
          <small>0px means no shadow.</small>
        </div>
        <div>
          <label style="display:flex; justify-content:space-between;">Frame Opacity <span id="val-frame-op">${Math.round((this.state.settings.frameOpacity || 0.85) * 100)}%</span></label>
          <input type="range" id="fb-slider-frame-opacity" min="20" max="100" value="${Math.round((this.state.settings.frameOpacity || 0.85) * 100)}" class="fb-slider" style="width:100%;" />
        </div>
        <div>
          <label style="display:flex; justify-content:space-between;">Glassmorphism Blur Radius <span id="val-blur">${this.state.settings.glassmorphismBlurRadius || 24}px</span></label>
          <input type="range" id="fb-slider-blur" min="0" max="64" value="${this.state.settings.glassmorphismBlurRadius || 24}" class="fb-slider" style="width:100%;" />
        </div>
        <div id="fb-transparency-live-preview" style="padding:12px; border-radius:8px; background:rgba(255,255,255,0.08); backdrop-filter:blur(${this.state.settings.glassmorphismBlurRadius || 24}px); border:1px solid rgba(255,255,255,0.15);">
          Live Glassmorphism Transparency Preview
        </div>
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <button class="fb-btn fb-btn-secondary fb-reset-transparency-btn">Reset Defaults</button>
          <button class="fb-btn fb-btn-primary fb-open-inpage-settings-btn">Open Full Settings</button>
        </div>
      </div>
    `;

    const bubbleSlider = modal.querySelector('#fb-slider-bubble-opacity');
    const shadowSlider = modal.querySelector('#fb-slider-bubble-shadow');
    const frameSlider = modal.querySelector('#fb-slider-frame-opacity');
    const blurSlider = modal.querySelector('#fb-slider-blur');
    const preview = modal.querySelector('#fb-transparency-live-preview');

    bubbleSlider?.addEventListener('input', (e) => {
      const rawVal = e?.target?.value !== undefined ? e.target.value : bubbleSlider?.value;
      const val = Number(rawVal) / 100;
      this.state.settings.bubbleOpacity = val;
      const lbl = modal.querySelector('#val-bubble-op');
      if (lbl) lbl.textContent = `${rawVal}%`;
      this.updateCssCustomProperties();
    });

    shadowSlider?.addEventListener('input', (e) => {
      const rawVal = e?.target?.value !== undefined ? e.target.value : shadowSlider?.value;
      const val = Math.max(0, Math.min(24, Math.round(Number(rawVal) || 0)));
      this.state.settings.bubbleShadowPx = val;
      const lbl = modal.querySelector('#val-bubble-shadow');
      if (lbl) lbl.textContent = `${val}px`;
      this.ensurePersistentAssistiveBubble();
    });
    shadowSlider?.addEventListener('change', () => {
      this.persistSettings();
      this.overlayBridge?.setBubbleShadow?.(this.state.settings.bubbleShadowPx);
    });

    frameSlider?.addEventListener('input', (e) => {
      const rawVal = e?.target?.value !== undefined ? e.target.value : frameSlider?.value;
      const val = Number(rawVal) / 100;
      this.state.settings.frameOpacity = val;
      const lbl = modal.querySelector('#val-frame-op');
      if (lbl) lbl.textContent = `${rawVal}%`;
      this.updateCssCustomProperties();
    });

    blurSlider?.addEventListener('input', (e) => {
      const rawVal = e?.target?.value !== undefined ? e.target.value : blurSlider?.value;
      const val = Number(rawVal);
      this.state.settings.glassmorphismBlurRadius = val;
      const lbl = modal.querySelector('#val-blur');
      if (lbl) lbl.textContent = `${val}px`;
      if (preview) preview.style.backdropFilter = `blur(${val}px)`;
      this.updateCssCustomProperties();
    });

    modal.querySelector('.fb-reset-transparency-btn')?.addEventListener('click', () => {
      this.state.settings.bubbleOpacity = 0.88;
      this.state.settings.bubbleShadowPx = 0;
      this.state.settings.frameOpacity = 0.85;
      this.state.settings.glassmorphismBlurRadius = 24;
      if (bubbleSlider) bubbleSlider.value = '88';
      if (shadowSlider) shadowSlider.value = '0';
      if (frameSlider) frameSlider.value = '85';
      if (blurSlider) blurSlider.value = '24';
      this.ensurePersistentAssistiveBubble();
      this.persistSettings();
      this.overlayBridge?.setBubbleShadow?.(0);
      this.updateCssCustomProperties();
    });

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-open-inpage-settings-btn')?.addEventListener('click', () => {
      this.closeModal();
      this.openInternalPage('yayra://settings');
    });
  }

  /** Chrome's "Add/Edit shortcut" dialog for the new-tab tiles. */
  renderEditShortcutModal(modal) {
    const editing = this._editingShortcut || null;
    modal.className = 'fb-modal-card fb-modal-edit-shortcut';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${editing ? 'Edit shortcut' : 'Add shortcut'}</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body" style="display:flex; flex-direction:column; gap:10px;">
        <label style="display:flex; flex-direction:column; gap:4px; font-size:0.8rem; color:var(--fb-text-muted);">Name
          <input type="text" id="fb-shortcut-name" class="fb-input" placeholder="e.g. GitHub" value="${editing ? String(editing.title).replace(/"/g, '&quot;') : ''}" />
        </label>
        <label style="display:flex; flex-direction:column; gap:4px; font-size:0.8rem; color:var(--fb-text-muted);">URL
          <input type="text" id="fb-shortcut-url" class="fb-input" placeholder="https://example.com" value="${editing ? String(editing.url).replace(/"/g, '&quot;') : ''}" />
        </label>
      </div>
      <div class="fb-modal-footer" style="display:flex; justify-content:space-between; gap:8px;">
        <span>${editing ? `<button class="fb-btn fb-btn-danger fb-shortcut-remove">Remove</button>` : ''}</span>
        <span style="display:flex; gap:8px;">
          <button class="fb-btn fb-btn-secondary fb-shortcut-cancel">Cancel</button>
          <button class="fb-btn fb-btn-primary fb-shortcut-save">${editing ? 'Save' : 'Add'}</button>
        </span>
      </div>
    `;
    const close = () => { this._editingShortcut = null; this.closeModal(); };
    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', close);
    modal.querySelector('.fb-shortcut-cancel')?.addEventListener('click', close);
    modal.querySelector('.fb-shortcut-remove')?.addEventListener('click', async () => {
      if (editing && this.shortcutsRepo?.removeShortcut) {
        await this.shortcutsRepo.removeShortcut(editing.id);
        this.state.userShortcuts = await this.shortcutsRepo.getShortcuts();
      }
      close();
      this.render();
    });
    modal.querySelector('.fb-shortcut-save')?.addEventListener('click', async () => {
      const name = modal.querySelector('#fb-shortcut-name')?.value?.trim() || '';
      let url = modal.querySelector('#fb-shortcut-url')?.value?.trim() || '';
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (!url || !/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) {
        this.showTransientNotice('Enter a valid website address for the shortcut.');
        return;
      }
      if (!this.shortcutsRepo) { close(); return; }
      if (editing && this.shortcutsRepo.updateShortcut) {
        await this.shortcutsRepo.updateShortcut(editing.id, { title: name || url, url });
      } else if (this.shortcutsRepo.addShortcut) {
        const added = await this.shortcutsRepo.addShortcut({ title: name || url, url });
        if (!added) this.showTransientNotice('Shortcut limit reached (12) - remove one first.');
      }
      this.state.userShortcuts = await this.shortcutsRepo.getShortcuts();
      close();
      this.render();
    });
  }

  renderClearDataModal(modal) {
    modal.className = 'fb-modal-card fb-modal-cleardata';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.trash} Clear Browsing Data</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body">
        <label><input type="checkbox" checked id="cb-hist" /> Browsing history</label>
        <label><input type="checkbox" checked id="cb-cookies" /> Cookies and site data</label>
        <label><input type="checkbox" checked id="cb-cache" /> Cached images and files</label>
      </div>
      <div class="fb-modal-footer">
        <button class="fb-btn fb-btn-secondary fb-cancel-cleardata">Cancel</button>
        <button class="fb-btn fb-btn-danger fb-confirm-cleardata">Clear Data</button>
      </div>
    `;
    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-cancel-cleardata')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('.fb-confirm-cleardata')?.addEventListener('click', async () => {
      const wantHistory = modal.querySelector('#cb-hist')?.checked !== false;
      const wantCookies = modal.querySelector('#cb-cookies')?.checked !== false;
      const wantCache = modal.querySelector('#cb-cache')?.checked !== false;
      const done = [];
      if (wantHistory) {
        if (this.historyRepo && typeof this.historyRepo.clearHistory === 'function') {
          await this.historyRepo.clearHistory();
        }
        this.state.historyItems = [];
        done.push('history');
      }
      // Desktop: REALLY clear Chromium's caches / cookies across every
      // Yayra session (see yayra:clear-browsing-data in main.cjs). The
      // web build can only clear its own PWA caches - said honestly.
      if ((wantCache || wantCookies) && this.systemBridge && typeof this.systemBridge.clearBrowsingData === 'function') {
        try {
          const res = await this.systemBridge.clearBrowsingData({ cache: wantCache, cookies: wantCookies });
          if (res && res.ok) {
            if (wantCache) done.push(res.clearedBytes > 0 ? `cache (${(res.clearedBytes / (1024 * 1024)).toFixed(1)} MB freed)` : 'cache');
            if (wantCookies) done.push('cookies & site data');
          }
        } catch { /* reported below by omission */ }
      } else if (wantCache && typeof caches !== 'undefined' && caches?.keys) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          done.push("Yayra's own app cache (sites' caches belong to your browser)");
        } catch { /* best effort on web */ }
      }
      this.closeModal();
      this.render();
      this.showTransientNotice(done.length ? `Cleared: ${done.join(', ')}.` : 'Nothing was cleared.');
    });
  }

  /**
   * Words/phrases the user has ACTUALLY searched before, recovered from
   * the search-result URLs in their own history (google.com/search?q=...,
   * DuckDuckGo ?q=, Bing ?q=, Yahoo ?p=...). Fuels "I've typed this
   * before" autofill without needing a separate search log.
   */
  getRememberedSearchPhrases() {
    const phrases = [];
    const items = (this.state.historyItems || []).slice(0, 300);
    for (const item of items) {
      try {
        const parsed = new URL(item.url);
        const phrase = parsed.searchParams.get('q') || parsed.searchParams.get('query') || parsed.searchParams.get('p');
        if (phrase && phrase.trim()) phrases.push(phrase.trim());
      } catch { /* not a URL - skip */ }
    }
    return [...new Set(phrases)];
  }

  /**
   * Chrome-style personal autofill: everything the user has USED before
   * (history + bookmarks), matched anywhere in the address or title.
   * Returns rich {url, title, kind, score} entries - score 0 means the
   * typed text is the START of the bare address (inline-completable).
   */
  getAutofillMatches(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const strip = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const typedBare = strip(q);
    const seen = new Set();
    const out = [];
    const consider = (item, kind) => {
      const url = item?.url || '';
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
      const bare = strip(url).toLowerCase();
      const title = String(item.title || '').toLowerCase();
      let score = -1;
      if (typedBare && bare.startsWith(typedBare)) score = 0;
      else if (title.startsWith(q)) score = 1;
      else if (bare.includes(q) || title.includes(q)) score = 2;
      if (score < 0) return;
      seen.add(url);
      out.push({ url, title: item.title || strip(url), kind, score });
    };
    (this.state.historyItems || []).forEach((h) => consider(h, 'history'));
    (this.state.bookmarksItems || []).forEach((b) => consider(b, 'bookmark'));
    out.sort((a, b) => a.score - b.score);
    return out.slice(0, 4);
  }

  getLocalSearchSuggestions(query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];
    const remembered = [
      ...this.getRememberedSearchPhrases(),
      ...(this.state.historyItems || []).map((item) => item.title || item.url),
      ...(this.state.bookmarksItems || []).map((item) => item.title || item.url),
      ...(this.state.tabs || []).map((tab) => tab.title || tab.url)
    ];
    const common = [
      `${query} news`,
      `${query} near me`,
      `${query} today`,
      `${query} website`
    ];
    return [...new Set([...remembered, ...common].filter((item) => String(item).toLowerCase().includes(normalized)))].slice(0, 8);
  }

  async getGoogleSearchSuggestions(query) {
    const local = this.getLocalSearchSuggestions(query);
    if (typeof fetch !== 'function') return local;
    try {
      this.searchSuggestionController?.abort();
      this.searchSuggestionController = typeof AbortController === 'function' ? new AbortController() : null;
      const response = await fetch(`https://yayra-updates-api.g2code335.workers.dev/api/suggestions?q=${encodeURIComponent(query)}`, {
        headers: { accept: 'application/json' },
        signal: this.searchSuggestionController?.signal
      });
      if (!response.ok) return local;
      const payload = await response.json();
      const remote = Array.isArray(payload?.[1]) ? payload[1].filter((item) => typeof item === 'string') : [];
      return [...new Set([...remote, ...local])].slice(0, 8);
    } catch {
      return local;
    }
  }

  bindSearchSuggestions(input, options = {}) {
    if (!input || input.dataset.searchSuggestionsBound === 'true') return;
    input.dataset.searchSuggestionsBound = 'true';

    const host = input.closest('.fb-omnibox-container')
      || input.closest('.fb-newtab-searchbox')
      || input.closest('#fb-mobile-search-form')
      || input.parentElement;
    if (!host) return;
    host.classList.add('fb-search-suggestions-host');

    const list = document.createElement('div');
    list.className = `fb-search-suggestions ${options.mobile ? 'fb-search-suggestions-mobile' : ''}`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.appendChild(list);

    let activeIndex = -1;
    let requestId = 0;
    const hide = () => {
      list.hidden = true;
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      // Un-obscure the native page surface (Electron) now that the
      // dropdown no longer needs to paint above it.
      this.setPageObscured(false);
    };
    const choose = (value) => {
      input.value = value;
      input.dataset.selectedSuggestion = value;
      this.state.urlInputValue = value;
      hide();
      if (options.mobile) this.closeModal();
      this.navigateActiveTab(value);
    };
    const updateActive = () => {
      const items = [...list.querySelectorAll('[role="option"]')];
      items.forEach((item, index) => item.classList.toggle('active', index === activeIndex));
      if (activeIndex >= 0 && items[activeIndex]) {
        input.setAttribute('aria-activedescendant', items[activeIndex].id);
        input.dataset.selectedSuggestion = items[activeIndex].dataset.value;
      } else {
        input.removeAttribute('aria-activedescendant');
        input.dataset.selectedSuggestion = '';
      }
    };
    const render = async () => {
      const query = input.value.trim();
      input.dataset.selectedSuggestion = '';
      if (!query) {
        hide();
        return;
      }
      const currentRequest = ++requestId;
      const suggestions = await this.getGoogleSearchSuggestions(query);
      if (currentRequest !== requestId || input.value.trim() !== query) return;
      list.innerHTML = '';
      // Chrome-style AI entry: every search also offers "Ask Yayra AI"
      // as the first row, opening yayra://ai with the query pre-asked.
      if (this.state.aiConfig?.enabled && this.state.aiConfig?.suggestInOmnibox) {
        const aiItem = document.createElement('button');
        aiItem.type = 'button';
        aiItem.className = 'fb-search-suggestion fb-ai-suggestion';
        aiItem.id = `fb-search-suggestion-ai-${Date.now()}`;
        aiItem.dataset.value = query;
        aiItem.setAttribute('role', 'option');
        aiItem.innerHTML = `<span class="fb-search-suggestion-icon fb-ai-suggestion-icon">${Icons.sparkles}</span><span class="fb-search-suggestion-text"></span><span class="fb-ai-suggestion-badge">Yayra AI</span>`;
        aiItem.querySelector('.fb-search-suggestion-text').textContent = `Ask Yayra AI: ${query}`;
        aiItem.addEventListener('mousedown', (event) => {
          event.preventDefault();
          hide();
          if (options.mobile) this.closeModal();
          this.openAiPage(query);
        });
        list.appendChild(aiItem);
      }
      // Personal autofill rows FIRST: links the user has actually used
      // before (history + bookmarks), with the site's logo and address.
      const autofillMatches = this.getAutofillMatches(query);
      autofillMatches.forEach((match, index) => {
        let host = '';
        try { host = new URL(match.url).hostname; } catch { host = ''; }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'fb-search-suggestion fb-autofill-suggestion';
        item.id = `fb-autofill-suggestion-${Date.now()}-${index}`;
        item.dataset.value = match.url;
        item.setAttribute('role', 'option');
        item.innerHTML = `<span class="fb-search-suggestion-icon fb-autofill-suggestion-icon">`
          + (host ? `<img class="fb-autofill-favicon" src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" loading="lazy" />` : Icons.history)
          + `</span><span class="fb-search-suggestion-text"><span class="fb-autofill-title"></span><span class="fb-autofill-url"></span></span>`
          + `<span class="fb-search-suggestion-use">${match.kind === 'bookmark' ? Icons.bookmark : Icons.history}</span>`;
        // Inline onerror is blocked by the shell CSP - bind the broken-
        // icon cleanup programmatically.
        item.querySelector('.fb-autofill-favicon')?.addEventListener?.('error', function () { try { this.remove(); } catch { /* gone */ } });
        item.querySelector('.fb-autofill-title').textContent = match.title;
        item.querySelector('.fb-autofill-url').textContent = this.getDisplayUrl(match.url);
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(match.url);
        });
        list.appendChild(item);
      });
      suggestions.forEach((suggestion, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'fb-search-suggestion';
        item.id = `fb-search-suggestion-${Date.now()}-${index}`;
        item.dataset.value = suggestion;
        item.setAttribute('role', 'option');
        item.innerHTML = `<span class="fb-search-suggestion-icon">${Icons.search}</span><span class="fb-search-suggestion-text"></span><span class="fb-search-suggestion-use">${Icons.arrowRight}</span>`;
        item.querySelector('.fb-search-suggestion-text').textContent = suggestion;
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(suggestion);
        });
        list.appendChild(item);
      });
      list.hidden = list.children.length === 0;
      activeIndex = -1;
      // The dropdown paints over the page area: on Electron the native
      // page surface must yield (it always draws above HTML otherwise).
      this.setPageObscured(!list.hidden);
    };

    // Inline type-ahead autofill: while the user TYPES (not deletes) the
    // start of an address they have used before, complete the rest right
    // in the bar with the completed part selected - exactly Chrome's
    // behavior. Enter navigates to the completed address; any further
    // keystroke simply replaces the selected remainder.
    let lastTypedLength = 0;
    const inlineAutofill = () => {
      const typed = input.value;
      const grew = typed.length > lastTypedLength;
      lastTypedLength = typed.length;
      if (!grew) return;
      if (typeof input.setSelectionRange !== 'function') return;
      if (!typed.trim() || typed.includes(' ') || typed.includes('://')) return;
      if (input.selectionStart !== typed.length || input.selectionEnd !== typed.length) return;
      const best = (this.getAutofillMatches(typed) || []).find((m) => m.score === 0);
      if (!best) return;
      const bare = String(best.url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
      if (bare.length <= typed.length || !bare.toLowerCase().startsWith(typed.toLowerCase())) return;
      input.value = typed + bare.slice(typed.length);
      input.setSelectionRange(typed.length, input.value.length);
    };
    input.addEventListener('input', () => {
      inlineAutofill();
      render();
    });
    input.addEventListener('focus', () => {
      lastTypedLength = input.value.length;
      if (input.value.trim()) render();
    });
    input.addEventListener('keydown', (event) => {
      const items = list.querySelectorAll('[role="option"]');
      if (event.key === 'ArrowDown' && items.length) {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % items.length;
        updateActive();
      } else if (event.key === 'ArrowUp' && items.length) {
        event.preventDefault();
        activeIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
        updateActive();
      } else if (event.key === 'Escape') {
        hide();
      } else if (event.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
        event.preventDefault();
        event.stopPropagation();
        const selected = items[activeIndex];
        if (selected.className.includes('fb-ai-suggestion')) {
          hide();
          if (options.mobile) this.closeModal();
          this.openAiPage(selected.dataset.value);
        } else {
          choose(selected.dataset.value);
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(hide, 160));

    if (typeof window !== 'undefined' && window.visualViewport && typeof window.visualViewport.addEventListener === 'function' && options.mobile) {
      const updateViewportHeight = () => {
        const height = `${window.visualViewport.height}px`;
        host.style.setProperty('--fb-search-visible-height', height);
        input.closest('.fb-mobile-search-overlay')?.style.setProperty('--fb-search-visible-height', height);
        input.closest('.fb-search-backdrop')?.style.setProperty('--fb-search-visible-height', height);
      };
      updateViewportHeight();
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      window.visualViewport.addEventListener('scroll', updateViewportHeight);
    }
  }

  renderMobileSearchOverlay(modal) {
    modal.className = 'fb-modal-card fb-mobile-search-overlay';
    modal.innerHTML = `
      <div class="fb-modal-header">
        <h2 class="fb-modal-title">${Icons.google} Google Suggestions</h2>
        <button class="fb-modal-close-btn">${Icons.close}</button>
      </div>
      <div class="fb-modal-body">
        <form id="fb-mobile-search-form" style="display:flex; gap:8px;">
          <input type="text" id="fb-mobile-search-input" value="${this.state.urlInputValue && !this.state.urlInputValue.startsWith('yayra://') ? this.state.urlInputValue : ''}" placeholder="Search with Google or enter website address" class="fb-input" style="flex:1;" autocomplete="off" spellcheck="false" />
          <button type="button" class="fb-mobile-search-clear" aria-label="Clear search">${Icons.close}</button>
        </form>
      </div>
    `;

    modal.querySelector('.fb-modal-close-btn')?.addEventListener('click', () => this.closeModal());
    modal.querySelector('#fb-mobile-search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const searchInput = modal.querySelector('#fb-mobile-search-input');
      const val = searchInput?.dataset.selectedSuggestion || searchInput?.value;
      if (val) {
        this.closeModal();
        this.navigateActiveTab(val);
      }
    });

    const input = modal.querySelector('#fb-mobile-search-input');
    this.bindSearchSuggestions(input, { mobile: true });
    modal.querySelector('.fb-mobile-search-clear')?.addEventListener('click', () => {
      if (input) {
        input.value = '';
        input.dataset.selectedSuggestion = '';
        input.focus();
      }
    });
    setTimeout(() => {
      input?.focus();
      input?.select();
      input?.scrollIntoView?.({ block: 'nearest' });
    }, 50);
  }

  /* -------------------------------------------------------------
   * PERSISTENT ASSISTIVETOUCH-STYLE FLOATING BUBBLE (PHASES 3, 4, 5, 20, 21)
   * ----------------------------------------------------------- */
  getBubbleShadowFilter() {
    const raw = Number(this.state.settings.bubbleShadowPx);
    const shadowPx = Number.isFinite(raw) ? Math.max(0, Math.min(24, raw)) : 0;
    return shadowPx > 0 ? `drop-shadow(0 3px ${shadowPx}px rgba(0,0,0,0.45))` : 'none';
  }

  ensurePersistentAssistiveBubble() {
    if (typeof document === 'undefined') return;

    // Electron desktop: the ONE floating bubble is the native always-on-top
    // overlay window (electron/overlayWindow.cjs) that floats over every
    // app on the desktop and exists even when this window is closed.
    // Rendering a second, in-page DOM bubble here produced two bubbles on
    // screen - so on Electron this in-page bubble is suppressed entirely
    // (and any leftover from an earlier render is removed).
    if (this.nativeWebview) {
      document.getElementById('yayra-persistent-assistive-bubble')?.remove();
      document.getElementById('yayra-floating-bubble-persistent')?.remove();
      return;
    }

    // Android (Capacitor) with the native system-wide bubble live: exactly
    // like Electron above, the OS-level overlay (YayraFloatBubbleService)
    // IS the one bubble - it floats over every app including Yayra itself,
    // so the in-page DOM copy would be a duplicate.
    if (this.state.systemBubbleActive && this.capacitorOverlay) {
      document.getElementById('yayra-persistent-assistive-bubble')?.remove();
      document.getElementById('yayra-floating-bubble-persistent')?.remove();
      return;
    }

    let bubble = document.getElementById('yayra-persistent-assistive-bubble') || document.getElementById('yayra-floating-bubble-persistent');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'yayra-floating-bubble-persistent yayra-persistent-assistive-bubble';
      bubble.id = 'yayra-persistent-assistive-bubble';
      bubble.setAttribute('role', 'button');
      bubble.setAttribute('aria-label', 'Yayra Floating Browser Bubble');
      bubble.tabIndex = 0;

      bubble.style.right = '24px';
      bubble.style.bottom = '24px';

      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let initialLeft = 0;
      let initialTop = 0;
      let hasMoved = false;

      bubble.addEventListener('pointerdown', (e) => {
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = bubble.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        if (bubble.setPointerCapture) bubble.setPointerCapture(e.pointerId);
      });

      bubble.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          hasMoved = true;
        }
        const newLeft = initialLeft + dx;
        const newTop = initialTop + dy;
        bubble.style.left = `${newLeft}px`;
        bubble.style.top = `${newTop}px`;
        bubble.style.right = 'auto';
        bubble.style.bottom = 'auto';
      });

      const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        if (bubble.releasePointerCapture) bubble.releasePointerCapture(e.pointerId);

        if (!hasMoved) {
          // Requirement 4: Single tap of the float bubble opens the mini floating full site, clicking it again minimizes it into the bubble
          if (this.state.isFloatingMiniOpen) {
            this.closeFloatingMini();
          } else {
            this.openFloatingMini();
          }
        }
      };

      bubble.addEventListener('pointerup', onPointerUp);
      bubble.addEventListener('pointercancel', onPointerUp);

      // Requirement 1: Double-click opens Radial Launcher Wheel
      bubble.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.openRadialLauncher();
      });

      document.body.appendChild(bubble);
    }

    // Update size, opacity, badge, loading pulse. Size is user-adjustable
    // from Settings > Floating Behavior ("Floating Bubble Size") and the
    // inner logo scales proportionally with it.
    const hasLoadingTab = this.state.tabs.some((t) => t.isLoading);
    const bubbleOpacity = this.state.settings.bubbleOpacity || 0.88;
    const bubbleSize = Math.max(40, Math.min(120, Number(this.state.settings.bubbleSizePx) || 64));
    // The logo IS the bubble (no circular plate behind it), so it fills
    // the hit area edge-to-edge instead of sitting inside a backdrop.
    const logoSize = bubbleSize;
    bubble.style.opacity = String(bubbleOpacity);
    bubble.style.width = `${bubbleSize}px`;
    bubble.style.height = `${bubbleSize}px`;
    bubble.style.filter = this.getBubbleShadowFilter();

    bubble.innerHTML = `
      ${hasLoadingTab ? '<div class="yayra-bubble-loading-ring"></div>' : ''}
      <div style="width:${logoSize}px; height:${logoSize}px; display:flex; align-items:center; justify-content:center; pointer-events:none;">
        ${Icons.officialOrb}
      </div>
      <span class="yayra-circle-badge" style="position:absolute; top:-3px; right:-3px; min-width:18px; height:18px; padding:0 4px; font-size:10px; border-radius:9px; background:var(--fb-accent-primary); color:#ffffff; font-weight:700; display:flex; align-items:center; justify-content:center;">
        ${this.state.tabs.length}
      </span>
    `;
  }

  renderFloatingBubbleOverlay() {
    this.ensurePersistentAssistiveBubble();
    if (typeof document === 'undefined') return;
    if (this.bubbleOverlay || document.getElementById('yayra-floating-bubble-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'yayra-floating-bubble-overlay';
    overlay.className = 'yayra-floating-bubble-overlay';
    // Pin the restore control just above the persistent assistive bubble
    // (bottom-right) instead of letting it fall into document flow.
    overlay.style.cssText = 'position:fixed; right:24px; bottom:104px; z-index:99998;';
    // Logo-only, exactly like the persistent bubble: no circular plate,
    // border or glass background behind the brand mark on ANY platform.
    overlay.innerHTML = `
      <div class="yayra-floating-bubble yayra-floating-orb" role="button" aria-label="Restore Yayra Browser" tabindex="0"
        style="position:relative; width:56px; height:56px; display:flex; align-items:center; justify-content:center; background:transparent; border:none; cursor:pointer; filter:${this.getBubbleShadowFilter()};">
        <div style="width:56px; height:56px; display:flex; align-items:center; justify-content:center; pointer-events:none;">
          ${Icons.officialOrb}
        </div>
        <span class="yayra-bubble-badge" style="position:absolute; top:-3px; right:-3px; min-width:18px; height:18px; padding:0 4px; font-size:10px; border-radius:9px; background:var(--fb-accent-primary); color:#ffffff; font-weight:700; display:flex; align-items:center; justify-content:center;">${this.state.tabs.length}</span>
      </div>
    `;
    overlay.addEventListener('click', () => {
      this.restoreFromBubble();
    });
    document.body.appendChild(overlay);
    this.bubbleOverlay = overlay;
  }

  minimizeToBubble() {
    // Electron desktop: "minimize to bubble" hides the real OS window; the
    // native system-wide bubble (always present) is the way back in. The
    // in-page bubble overlay below only exists for web/PWA builds where a
    // native overlay window is impossible.
    const overlay = this.overlayBridge;
    if (this.nativeWebview && overlay && typeof overlay.minimizeMainWindow === 'function') {
      overlay.minimizeMainWindow();
      if (this.options.onMinimizeToBubble) this.options.onMinimizeToBubble();
      return;
    }
    // Android (Capacitor): the system-wide bubble takes over - start it
    // (asking for the overlay permission on first use) and send the app to
    // the background so the bubble is immediately floating over whatever
    // the user switches to. Only when the permission isn't granted yet do
    // we fall through to the in-page bubble below.
    const sysOverlay = this.capacitorOverlay;
    if (sysOverlay) {
      this.ensureSystemOverlayBubble({ fromUserAction: true }).then((active) => {
        if (active && typeof sysOverlay.minimizeApp === 'function') sysOverlay.minimizeApp();
      });
      if (this.state.systemBubbleActive) {
        if (this.options.onMinimizeToBubble) this.options.onMinimizeToBubble();
        return;
      }
    }
    this.state.isMinimizedToBubble = true;
    if (this.options.onMinimizeToBubble) {
      this.options.onMinimizeToBubble();
    }
    this.render();
  }

  restoreFromBubble() {
    this.state.isMinimizedToBubble = false;
    if (this.bubbleOverlay) {
      this.bubbleOverlay.remove();
      this.bubbleOverlay = null;
    }
    if (typeof document !== 'undefined') {
      const legacyOverlay = document.getElementById('yayra-floating-bubble-overlay');
      if (legacyOverlay) {
        legacyOverlay.remove();
      }
    }
    this.render();
  }

  // NOTE: toggleDesktopMode() (the "floating mode / bubble mode" switch)
  // was removed on purpose. Switching modes hid the entire main window,
  // which users experienced as Yayra disappearing. The native bubble is
  // always present and opens its mini browser without ever touching the
  // main window, so a mode switch has no job left to do.

  /* -------------------------------------------------------------
   * TAB MANAGEMENT
   * ----------------------------------------------------------- */
  createNewTab(isPrivate = false, { group = null, render = true, afterTabId = null } = {}) {
    // Collision-proof id: `tab-${Date.now()}` alone DUPLICATED when two tabs
    // were created in the same millisecond (fast Ctrl+T, scripted flows) -
    // aliased tabs then shared ONE pooled frame, silently overwriting each
    // other's live page. The random suffix makes ids unique by construction.
    const newId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTab = {
      id: newId,
      title: isPrivate ? 'Incognito Tab' : 'New Tab',
      url: 'yayra://newtab',
      isSecure: true,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      isPrivate,
      favicon: null
    };
    const safeGroup = this.sanitizeTabGroup(group);
    if (safeGroup) newTab.group = safeGroup;

    const insertAfterIndex = afterTabId
      ? this.state.tabs.findIndex((tab) => tab.id === afterTabId)
      : -1;
    if (insertAfterIndex >= 0) this.state.tabs.splice(insertAfterIndex + 1, 0, newTab);
    else this.state.tabs.push(newTab);
    this.state.activeTabId = newId;
    this.state.urlInputValue = '';
    this.state.isBookmarked = false;

    if (render) this.render();
    return newTab;
  }

  selectTab(tabId) {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Snapshot the OUTGOING tab before it leaves the screen so the tab
    // switcher can show a real preview of every recently-seen tab, not
    // just the one that happened to be active when it opened.
    const prevId = this.state.activeTabId;
    if (prevId && prevId !== tabId
      && this._nativeWebviewTabIds.has(prevId)
      && this.nativeWebview && typeof this.nativeWebview.capture === 'function') {
      try {
        this.nativeWebview.capture(prevId).then((res) => {
          if (res && res.snapshot) this._pageSnapshots.set(prevId, res.snapshot);
        }).catch(() => { /* preview stays as-is */ });
      } catch { /* preview stays as-is */ }
    }

    this.state.activeTabId = tabId;
    this.state.urlInputValue = this.getDisplayUrl(tab.url);
    this.updateBookmarkState(tab.url);
    this.render();
  }

  closeTab(tabId) {
    const tabIndex = this.state.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    this.destroyNativeWebview(tabId);
    this._systemBrowserHandoffs.delete(tabId);
    this._pageSnapshots.delete(tabId); // closed tab, dead preview

    const [closedTab] = this.state.tabs.splice(tabIndex, 1);
    if (closedTab?.isDocument) {
      const session = this._documentViewerSessions?.get(tabId);
      if (session) {
        session.disposed = true;
        try { session.viewer?.destroy(); } catch { /* already gone */ }
        this._documentViewerSessions.delete(tabId);
      }
      if (this._activeDocViewer?.tabId === tabId) this._activeDocViewer = null;
      if (!this.state.tabs.some((tab) => tab.docId === closedTab.docId)) {
        this.documentStore?.remove(closedTab.docId);
      }
    }

    // Save to closed tabs history (for Ctrl+Shift+T restore)
    if (closedTab && !closedTab.isPrivate && closedTab.url !== 'yayra://newtab') {
      this.state.closedTabsHistory.unshift(closedTab);
      if (this.state.closedTabsHistory.length > 25) {
        this.state.closedTabsHistory.pop();
      }
    }

    if (this.state.tabs.length === 0) {
      // If last tab closed, open New Tab
      this.createNewTab();
      return;
    }

    if (this.state.activeTabId === tabId) {
      const nextIndex = Math.min(tabIndex, this.state.tabs.length - 1);
      this.selectTab(this.state.tabs[nextIndex].id);
    } else {
      this.render();
    }
  }

  // --- Tab strip right-click actions (Chrome parity - see renderTabContextMenu) ---

  duplicateTabById(tabId) {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const newId = `tab-${Date.now()}`;
    const index = this.state.tabs.findIndex((t) => t.id === tabId);
    const duplicate = { ...tab, id: newId, isLoading: false };
    this.state.tabs.splice(index + 1, 0, duplicate);
    this.selectTab(newId);
  }

  reloadTabById(tabId) {
    if (tabId === this.state.activeTabId) {
      this.reload();
      return;
    }
    // Background tabs rendered via the native engine can still be reloaded
    // directly through the webview bridge; iframe-rendered tabs simply pick
    // up the reload once the user switches to them (no native handle to
    // force a reload while not visible).
    if (this.nativeWebview?.reload) this.nativeWebview.reload(tabId);
  }

  closeOtherTabs(tabId) {
    const keep = this.state.tabs.find((t) => t.id === tabId);
    if (!keep) return;
    for (const tab of [...this.state.tabs]) {
      if (tab.id !== tabId) this.closeTab(tab.id);
    }
    if (this.state.activeTabId !== tabId) this.selectTab(tabId);
  }

  closeTabsToTheRight(tabId) {
    const index = this.state.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;
    for (const tab of this.state.tabs.slice(index + 1)) {
      this.closeTab(tab.id);
    }
  }

  /* -------------------------------------------------------------
   * CHROME-STYLE RIGHT-CLICK CONTEXT MENU FOR THE TAB STRIP
   * ----------------------------------------------------------- */
  renderTabContextMenu(x, y, tab) {
    document.body.querySelector('.fb-tab-context-menu')?.remove();
    document.body.querySelector('.fb-dropdown-scrim[data-tab-ctx]')?.remove();

    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.className = 'fb-dropdown-scrim';
    scrim.setAttribute('data-tab-ctx', 'true');
    scrim.setAttribute('aria-label', 'Close menu');

    const menu = document.createElement('div');
    menu.className = 'fb-tab-context-menu';
    menu.setAttribute('role', 'menu');
    if (!tab || !tab.id) return;

    // Clicking/tapping OR right-clicking anywhere outside the menu must
    // dismiss BOTH the scrim and the menu (previously only the scrim was
    // removed, stranding the menu on screen forever).
    const dismiss = () => {
      scrim.remove();
      menu.remove();
      // Un-obscure the native page surface (see below).
      this.setPageObscured(false);
    };
    scrim.addEventListener('click', dismiss);
    scrim.addEventListener('contextmenu', (e) => { e.preventDefault(); dismiss(); });
    const canCloseOthers = this.state.tabs.length > 1;
    const tabIndex = this.state.tabs.findIndex((t) => t.id === tab.id);
    const canCloseRight = tabIndex > -1 && tabIndex < this.state.tabs.length - 1;

    const currentGroupId = this.tabGroupIdentity(tab.group, tab.isPrivate);
    const currentGroup = this.getTabGroups().find((group) => group.id === currentGroupId);
    const availableGroups = this.getTabGroups().filter((group) =>
      group.isPrivate === Boolean(tab.isPrivate) && group.id !== currentGroupId);
    const items = [
      { label: 'New Tab', action: () => this.createNewTab() },
      { label: 'Reload', action: () => this.reloadTabById(tab.id) },
      { label: 'Duplicate Tab', action: () => this.duplicateTabById(tab.id) },
      null,
      { label: 'Create group with this tab…', action: () => this.createTabGroupForTab(tab.id) },
      ...(availableGroups.length ? [{
        label: 'Add to…',
        submenu: availableGroups.map((group) => ({
          label: group.name,
          action: () => this.addTabToExistingGroup(tab.id, group.id)
        }))
      }] : []),
      ...(currentGroup ? [
        { label: `Open “${currentGroup.name}” group`, action: () => this.openTabGroup(currentGroup.id) },
        { label: `Remove from “${currentGroup.name}”`, action: () => this.ungroupTab(tab.id) }
      ] : []),
      { label: 'Manage tab groups', action: () => this.openTabGroupsSettings() },
      null,
      { label: 'Close Tab', action: () => this.closeTab(tab.id) },
      { label: 'Close Other Tabs', action: () => this.closeOtherTabs(tab.id), disabled: !canCloseOthers },
      { label: 'Close Tabs to the Right', action: () => this.closeTabsToTheRight(tab.id), disabled: !canCloseRight }
    ];

    const menuWidth = 240;
    const baseMenuHeight = items.reduce((height, item) => height + (item ? 34 : 12), 16);
    const positionMenu = (extraHeight = 0) => {
      const left = Math.min(x, window.innerWidth - menuWidth - 8);
      const top = Math.min(y, window.innerHeight - baseMenuHeight - extraHeight - 8);
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
    };

    // Use textContent for labels: group names are user-entered and must
    // never be interpreted as markup in a tab context menu.
    items.forEach((item, index) => {
      if (item === null) {
        const separator = document.createElement('div');
        separator.className = 'fb-tab-context-menu-sep';
        separator.setAttribute('role', 'separator');
        menu.appendChild(separator);
        return;
      }

      if (Array.isArray(item.submenu)) {
        const groupRow = document.createElement('div');
        groupRow.className = 'fb-tab-context-menu-submenu-row';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'fb-tab-context-menu-item fb-tab-context-menu-submenu-toggle';
        toggle.setAttribute('role', 'menuitem');
        toggle.setAttribute('data-idx', String(index));
        toggle.setAttribute('aria-haspopup', 'menu');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = item.label;
        const submenu = document.createElement('div');
        submenu.className = 'fb-tab-context-submenu';
        submenu.setAttribute('role', 'menu');
        submenu.setAttribute('aria-label', 'Available tab groups');
        submenu.style.display = 'none';
        for (const child of item.submenu) {
          const childButton = document.createElement('button');
          childButton.type = 'button';
          childButton.className = 'fb-tab-context-menu-item fb-tab-context-submenu-item';
          childButton.setAttribute('role', 'menuitem');
          childButton.textContent = child.label;
          childButton.addEventListener('click', () => {
            dismiss();
            child.action?.();
            this.render();
          });
          submenu.appendChild(childButton);
        }
        toggle.addEventListener('click', () => {
          const expanded = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', String(!expanded));
          submenu.style.display = expanded ? 'none' : 'flex';
          positionMenu(expanded ? 0 : item.submenu.length * 34 + 8);
        });
        groupRow.appendChild(toggle);
        groupRow.appendChild(submenu);
        menu.appendChild(groupRow);
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fb-tab-context-menu-item';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-idx', String(index));
      button.disabled = Boolean(item.disabled);
      button.textContent = item.label;
      button.addEventListener('click', () => {
        dismiss();
        item.action?.();
        this.render();
      });
      menu.appendChild(button);
    });

    document.body.appendChild(scrim);
    document.body.appendChild(menu);

    // The menu extends BELOW the tab strip, over the page area. On
    // Electron the native page surface always paints above HTML - the
    // menu's lower items were covered by the site (field screenshot:
    // only "New Tab" visible, "Reload" half-cut). Swap the live view
    // for its snapshot while the menu is open, exactly like the
    // omnibox suggestion dropdown does.
    this.setPageObscured(true);

    // Clamp to viewport so it never renders off-screen near the right/bottom edge.
    positionMenu();
  }

  restoreLastClosedTab() {
    if (this.state.closedTabsHistory.length === 0) return;

    const lastClosed = this.state.closedTabsHistory.shift();
    const newId = `tab-${Date.now()}`;
    const restoredTab = {
      ...lastClosed,
      id: newId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    };

    this.state.tabs.push(restoredTab);
    this.selectTab(newId);
  }

  reorderTabs(fromIdx, toIdx) {
    if (fromIdx < 0 || fromIdx >= this.state.tabs.length || toIdx < 0 || toIdx >= this.state.tabs.length) return;
    const [movedTab] = this.state.tabs.splice(fromIdx, 1);
    this.state.tabs.splice(toIdx, 0, movedTab);
    this.render();
  }

  /* -------------------------------------------------------------
   * NAVIGATION & OMNIBOX INTERPRETATION
   * ----------------------------------------------------------- */
  ensureNavigationState(tab) {
    if (!tab) return null;
    const initialUrl = tab.url || 'yayra://newtab';
    const current = tab.navigationState;
    if (!current || !Array.isArray(current.historyStack) || current.historyStack.length === 0) {
      tab.navigationState = {
        historyStack: [initialUrl],
        currentIndex: 0,
        canGoBack: false,
        canGoForward: false
      };
    }
    tab.canGoBack = tab.navigationState.currentIndex > 0;
    tab.canGoForward = tab.navigationState.currentIndex < tab.navigationState.historyStack.length - 1;
    return tab.navigationState;
  }

  navigateActiveTab(rawInput) {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;

    const query = (rawInput || '').trim();
    if (!query) return;

    const targetUrl = this.interpretUrl(query);
    // An explicit navigation (including re-entering the same auth URL) is a
    // fresh attempt, unlike a render. It may therefore launch the browser once
    // again; passive chrome updates may not.
    this._systemBrowserHandoffs.delete(activeTab.id);
    const navigationState = this.ensureNavigationState(activeTab);
    const currentUrl = navigationState.historyStack[navigationState.currentIndex];
    if (currentUrl !== targetUrl) {
      navigationState.historyStack = navigationState.historyStack.slice(0, navigationState.currentIndex + 1);
      navigationState.historyStack.push(targetUrl);
      navigationState.currentIndex = navigationState.historyStack.length - 1;
    }
    activeTab.url = targetUrl;
    activeTab.title = this.getTabTitle(activeTab);
    activeTab.isSecure = targetUrl.startsWith('https://') || targetUrl.startsWith('yayra://');
    activeTab.canGoBack = navigationState.currentIndex > 0;
    activeTab.canGoForward = navigationState.currentIndex < navigationState.historyStack.length - 1;
    navigationState.canGoBack = activeTab.canGoBack;
    navigationState.canGoForward = activeTab.canGoForward;
    activeTab.isLoading = !targetUrl.startsWith('yayra://');

    this.state.urlInputValue = this.getDisplayUrl(targetUrl);
    this.updateBookmarkState(targetUrl);

    // Record history if not in private mode and not internal newtab
    if (!activeTab.isPrivate && this.historyRepo && targetUrl !== 'yayra://newtab') {
      const recorded = typeof this.historyRepo.recordVisit === 'function'
        ? this.historyRepo.recordVisit(targetUrl, activeTab.title, activeTab.favicon)
        : (typeof this.historyRepo.addEntry === 'function' ? this.historyRepo.addEntry(targetUrl, activeTab.title, activeTab.favicon) : null);
      Promise.resolve(recorded).then(() => this.refreshHistoryState()).catch(() => {});
    }

    if (this.navigationController && typeof this.navigationController.navigate === 'function') {
      this.navigationController.navigate(targetUrl);
    }

    // WEB/PWA (no native engines available): frame-hostile sites (Google,
    // YouTube, X, ...) can never embed, and no search engine allows
    // embedded results. Open them in a REAL browser tab RIGHT HERE -
    // synchronously inside the user's Enter-key activation. The old path
    // (window.open from the async render) had lost the activation, so
    // popup blockers ate it and the user landed on the dead "can't open"
    // card: the "google error in web". The render below then shows the
    // honest already-opened state; the per tab+url keys keep the render
    // path from opening a second tab.
    if (/^https?:\/\//i.test(targetUrl)
      && !this.nativeWebview && !this.capacitorBrowser && !this.capacitorTabWeb
      && !this.isSystemBrowserAuthHost(targetUrl) // sign-in hosts have their OWN single handoff
      && typeof window !== 'undefined' && typeof window.open === 'function') {
      const serp = typeof this.getSearchIntent === 'function' ? this.getSearchIntent(targetUrl) : null;
      const blocked = this.isKnownFrameBlockedUrl(targetUrl);
      if (serp || blocked) {
        try {
          const opened = window.open(targetUrl, '_blank', 'noopener,noreferrer');
          if (opened) {
            if (!this._autoExternalOpened) this._autoExternalOpened = new Set();
            if (serp) this._autoExternalOpened.add(`${activeTab.id}::serp::${targetUrl}`);
            if (blocked) this._autoExternalOpened.add(`${activeTab.id}::${targetUrl}`);
          }
        } catch { /* popup blocked - the honest card's button covers it */ }
      }
    }

    this.render();

    // Auto-complete loading for internal pages
    if (targetUrl.startsWith('yayra://')) {
      this.updateTabLoading(activeTab.id, false);
    }
  }

  interpretUrl(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith('yayra://') || trimmed.startsWith('about:') || trimmed.startsWith('app://')) {
      return trimmed;
    }
    if (trimmed === 'settings') return 'yayra://settings';
    if (trimmed === 'history') return 'yayra://history';
    if (trimmed === 'bookmarks') return 'yayra://bookmarks';
    if (trimmed === 'downloads') return 'yayra://downloads';
    if (trimmed === 'passwords') return 'yayra://passwords';
    if (trimmed === 'extensions') return 'yayra://extensions';
    if (trimmed === 'permissions') return 'yayra://permissions';
    if (trimmed === 'ai') return 'yayra://ai';
    if (trimmed === 'about') return 'yayra://about';

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:[0-9]+)?(\/.*)?$/.test(trimmed)) {
      return `https://${trimmed}`;
    }

    // Natural Language Search Query (Default: Google)
    const engine = this.state.settings.searchEngine || 'google';
    const encoded = encodeURIComponent(trimmed);
    if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=${encoded}`;
    if (engine === 'bing') return `https://www.bing.com/search?q=${encoded}`;
    if (engine === 'startpage') return `https://www.startpage.com/do/dsearch?query=${encoded}`;
    return `https://www.google.com/search?q=${encoded}`;
  }

  openInternalPage(schemeUrl) {
    const activeTab = this.getActiveTab();
    if (activeTab && activeTab.url === 'yayra://newtab') {
      this.navigateActiveTab(schemeUrl);
    } else {
      this.createNewTab();
      this.navigateActiveTab(schemeUrl);
    }
    // History/Bookmarks pages always show the CURRENT stored data, not
    // whatever was loaded at boot.
    if (schemeUrl === 'yayra://history' && this.historyRepo?.getEntries) {
      this.historyRepo.getEntries(200).then((items) => {
        this.state.historyItems = items || [];
        this.render();
      }).catch(() => {});
    } else if (schemeUrl === 'yayra://bookmarks' && this.bookmarksRepo?.getAllBookmarks) {
      this.refreshBookmarksState().then(() => this.render()).catch(() => {});
    }
  }

  goBack() {
    const activeTab = this.getActiveTab();
    if (!activeTab) return false;
    this._systemBrowserHandoffs.delete(activeTab.id);
    // Move the active tab's local history first. A native controller may
    // update its own model synchronously, so delegating before this step can
    // overwrite the shell state or jump straight back to the new-tab page.
    const navigationState = this.ensureNavigationState(activeTab);
    if (navigationState.currentIndex <= 0) return false;
    navigationState.currentIndex -= 1;
    activeTab.url = navigationState.historyStack[navigationState.currentIndex];
    activeTab.title = this.getTabTitle(activeTab);
    activeTab.isSecure = activeTab.url.startsWith('https://') || activeTab.url.startsWith('yayra://');
    activeTab.canGoBack = navigationState.currentIndex > 0;
    activeTab.canGoForward = navigationState.currentIndex < navigationState.historyStack.length - 1;
    navigationState.canGoBack = activeTab.canGoBack;
    navigationState.canGoForward = activeTab.canGoForward;
    activeTab.isLoading = !activeTab.url.startsWith('yayra://');
    this.state.urlInputValue = this.getDisplayUrl(activeTab.url);
    if (this.navigationController && typeof this.navigationController.goBack === 'function') {
      this.navigationController.goBack();
    }
    return true;
  }

  goForward() {
    const activeTab = this.getActiveTab();
    if (!activeTab) return false;
    this._systemBrowserHandoffs.delete(activeTab.id);
    const navigationState = this.ensureNavigationState(activeTab);
    if (navigationState.currentIndex >= navigationState.historyStack.length - 1) return false;
    navigationState.currentIndex += 1;
    activeTab.url = navigationState.historyStack[navigationState.currentIndex];
    activeTab.title = this.getTabTitle(activeTab);
    activeTab.isSecure = activeTab.url.startsWith('https://') || activeTab.url.startsWith('yayra://');
    activeTab.canGoBack = navigationState.currentIndex > 0;
    activeTab.canGoForward = navigationState.currentIndex < navigationState.historyStack.length - 1;
    navigationState.canGoBack = activeTab.canGoBack;
    navigationState.canGoForward = activeTab.canGoForward;
    activeTab.isLoading = !activeTab.url.startsWith('yayra://');
    this.state.urlInputValue = this.getDisplayUrl(activeTab.url);
    if (this.navigationController && typeof this.navigationController.goForward === 'function') {
      this.navigationController.goForward();
    }
    return true;
  }

  reload() {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    this._systemBrowserHandoffs.delete(activeTab.id);
    // FREEZE FIX: refresh must ALWAYS hand back the live page surface -
    // in the field a stuck obscured flag made refresh look dead.
    try { this.healStuckPageSurface(); } catch { /* best-effort heal */ }
    if (this.nativeWebview && this._nativeWebviewTabIds.has(activeTab.id)
      && !this.isSystemBrowserAuthHost(activeTab.url)) {
      // The X (stop) must appear the INSTANT the reload is requested -
      // not a roundtrip later when loading-start comes back from the
      // native engine. loading-stop flips it back to the refresh sign.
      this.updateTabLoading(activeTab.id, true);
      this.nativeWebview.reload(activeTab.id).catch(() => {
        this.updateTabLoading(activeTab.id, false);
      });
      return;
    }
    if (this.isSystemBrowserAuthHost(activeTab.url)) {
      activeTab.isLoading = false;
      this.render(); // explicit reload is a fresh, deduplicated browser handoff
      return;
    }
    activeTab.isLoading = true;
    this.render();
    setTimeout(() => {
      this.updateTabLoading(activeTab.id, false);
      this.render();
    }, 300);
  }

  /**
   * Chrome's Ctrl+Shift+R / Ctrl+F5: clear THIS site's caches, then
   * reload from the network. On desktop the native engine genuinely
   * drops the origin's code caches / Cache Storage / service workers and
   * bypasses the HTTP cache on the reload. The web build can only do a
   * plain reload (a page cannot clear another origin's cache) - honest
   * notice instead of pretending.
   */
  async hardReload() {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    this._systemBrowserHandoffs.delete(activeTab.id);
    if (this.isSystemBrowserAuthHost(activeTab.url)) {
      this.render(); // auth tabs retry the secure browser, never reload a hidden previous page
      return;
    }
    // FREEZE FIX: same invariant as reload() - the live surface comes back.
    try { this.healStuckPageSurface(); } catch { /* best-effort heal */ }
    if (this.nativeWebview && typeof this.nativeWebview.hardReload === 'function' && this._nativeWebviewTabIds.has(activeTab.id)) {
      try {
        const res = await this.nativeWebview.hardReload(activeTab.id);
        if (res && res.ok && res.origin) {
          let host = res.origin; try { host = new URL(res.origin).hostname; } catch { /* keep origin */ }
          this.showTransientNotice(`Cache cleared for ${host} - reloading from the network.`);
        }
        return;
      } catch { /* fall through to plain reload */ }
    }
    this.reload();
    if (!this.nativeWebview && /^https?:\/\//i.test(String(activeTab.url || ''))) {
      this.showTransientNotice('Reloaded. Full per-site cache clearing needs the Yayra desktop app.');
    }
  }

  /**
   * "Open full browser" handoff from yayra mini (or any overlay
   * surface): continue the SAME site here. A pristine new-tab is
   * reused; otherwise the url opens in a fresh tab - never clobbering
   * a page the user already has open in main.
   */
  openUrlHandoff(url) {
    const target = String(url || '');
    if (!/^(https?:\/\/|yayra:\/\/)/i.test(target)) return false;
    const active = this.getActiveTab();
    const pristine = active && active.url === 'yayra://newtab' && !active.isPrivate;
    if (!pristine) this.createNewTab();
    this.navigateActiveTab(target);
    return true;
  }

  /** "Restore all" on the continue-with-these-tabs prompt: open every entry. */
  restoreContinueTabs(entries) {
    const list = Array.isArray(entries) ? entries : [];
    // The offer is being consumed: clear it and mark it answered so it
    // neither re-prompts this session nor blocks the rolling snapshot.
    this.state.continueTabs = [];
    this.state.settings.continueDismissedAt = this.state.continueSavedAt || 'no-snapshot-id';
    this._sessionHadRealTabs = true;
    this.persistSettings?.();
    let opened = 0;
    for (const entry of list) {
      if (!/^https?:\/\//i.test(entry?.url || '')) continue;
      if (opened === 0) {
        // The newtab the prompt lives on becomes the first restored tab.
        this.navigateActiveTab(entry.url);
      } else {
        this.createNewTab();
        this.navigateActiveTab(entry.url);
      }
      const restoredTab = this.getActiveTab();
      if (restoredTab) restoredTab.group = this.sanitizeTabGroup(entry.group);
      opened += 1;
    }
    if (opened > 0) {
      this.render();
      this.showTransientNotice(`Restored ${opened} tab${opened === 1 ? '' : 's'}.`);
    }
  }

  /** "No thanks" on the prompt: remember the snapshot so it never re-asks. */
  dismissContinueTabs() {
    this.state.settings.continueDismissedAt = this.state.continueSavedAt || 'no-snapshot-id';
    this.state.continueTabs = [];
    // The offer is answered: the rolling snapshot may resume normally
    // (the launch-wipe guard no longer needs to protect it).
    this._sessionHadRealTabs = true;
    this.persistSettings?.();
    this.render();
  }

  /**
   * Chrome's "Restore pages?" prompt, made PERSISTENT: a bar docked
   * into the chrome (right under the toolbar) whenever the previous
   * session's tabs are recoverable. Because it is part of the layout -
   * not an overlay - the native page surface can never cover it, and it
   * stays through searching, tab switches and every other action until
   * the user MANUALLY answers: Restore reopens the session; the X is
   * the only thing that closes the prompt.
   */
  renderRestoreBar(root) {
    const tabs = (this.state.continueTabs || []).filter((t) => /^https?:\/\//i.test(t?.url || ''));
    if (!tabs.length || this._restoreToastClosed) return;
    const continueSnapshotId = this.state.continueSavedAt || 'no-snapshot-id';
    if (this.state.settings.continueDismissedAt === continueSnapshotId) return;
    const bar = document.createElement('div');
    bar.className = 'fb-restore-bar';
    bar.setAttribute('role', 'alertdialog');
    bar.setAttribute('aria-label', 'Restore pages?');
    bar.innerHTML = `
      <span class="fb-restore-bar-head">Restore pages?</span>
      <span class="fb-restore-bar-body">Yayra closed before you finished - ${tabs.length === 1 ? 'one tab' : `${tabs.length} tabs`} from your last session can come back.</span>
      <span class="fb-restore-bar-spacer"></span>
      <button class="fb-restore-toast-btn fb-restore-bar-btn">Restore</button>
      <button class="fb-restore-toast-close fb-restore-bar-close" aria-label="Dismiss" title="Dismiss">${Icons.close}</button>
    `;
    bar.querySelector('.fb-restore-bar-btn')?.addEventListener('click', () => {
      this.restoreContinueTabs(tabs.map((t) => ({ url: t.url, title: t.title || t.url, group: t.group })));
    });
    bar.querySelector('.fb-restore-bar-close')?.addEventListener('click', () => {
      this._restoreToastClosed = true;
      this.render();
    });
    root.appendChild(bar);
  }

  /**
   * Chrome's "Continue with these tabs?" card: the previous run's tabs
   * that were NOT closed manually (rolling session snapshot), topped up
   * with frequently-opened sites ("You visit often"). ALWAYS a real
   * prompt - the user explicitly recovers (Restore all / click one) or
   * rejects (No thanks). "No thanks" remembers the dismissed snapshot
   * so the same session never re-prompts, while the NEXT session's tabs
   * prompt again. Sits below the frequent tiles; the persistent
   * "Restore pages?" bar (renderRestoreBar) sits docked in the chrome.
   */
  appendContinueCard(newTabPage, frequentSites = []) {
    const continueEntries = [];
    const seenContinue = new Set(this.state.tabs.map((t) => t.url));
    for (const t of (this.state.continueTabs || [])) {
      if (seenContinue.has(t.url)) continue;
      seenContinue.add(t.url);
      continueEntries.push({ url: t.url, title: t.title || t.url, reason: 'From last session', group: t.group });
      if (continueEntries.length >= 5) break;
    }
    for (const site of frequentSites) {
      if (continueEntries.length >= 5) break;
      if (seenContinue.has(site.url)) continue;
      seenContinue.add(site.url);
      continueEntries.push({ url: site.url, title: site.title || site.url, reason: 'You visit often' });
    }
    const continueSnapshotId = this.state.continueSavedAt || 'no-snapshot-id';
    const continueDismissed = this.state.settings.continueDismissedAt === continueSnapshotId;
    if (continueEntries.length === 0 || continueDismissed) return;
    const continueCard = document.createElement('div');
    continueCard.className = 'fb-continue-card';
    continueCard.innerHTML = `
      <div class="fb-continue-card-head">Continue with these tabs?</div>
      ${continueEntries.map((entry) => {
        let host = entry.url;
        try { host = new URL(entry.url).hostname; } catch { /* keep url */ }
        return `
        <button class="fb-continue-item" data-url="${String(entry.url).replace(/"/g, '&quot;')}">
          <img class="fb-continue-favicon" src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
          <span class="fb-continue-text">
            <span class="fb-continue-title">${String(entry.title).replace(/</g, '&lt;')}</span>
            <span class="fb-continue-meta">${host} &bull; ${entry.reason}</span>
          </span>
        </button>`;
      }).join('')}
      <div class="fb-continue-actions">
        <button class="fb-continue-restore-btn">Restore all</button>
        <button class="fb-continue-dismiss-btn">No thanks</button>
      </div>
    `;
    continueCard.querySelectorAll('.fb-continue-item').forEach((item) => {
      item.addEventListener('click', () => {
        const entry = continueEntries.find((candidate) => candidate.url === item.dataset.url);
        this.navigateActiveTab(item.dataset.url);
        const active = this.getActiveTab();
        if (active && entry?.group) {
          active.group = this.sanitizeTabGroup(entry.group);
          this.render();
        }
      });
    });
    continueCard.querySelector('.fb-continue-restore-btn')?.addEventListener('click', () => {
      this.restoreContinueTabs(continueEntries);
    });
    continueCard.querySelector('.fb-continue-dismiss-btn')?.addEventListener('click', () => {
      this.dismissContinueTabs();
    });
    newTabPage.appendChild(continueCard);
  }

  /** Copy a link (newtab cards' copy buttons) with an honest notice. */
  async copyLinkToClipboard(url) {
    const text = String(url || '');
    if (!text) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        this.showTransientNotice('Link copied.');
        return;
      }
    } catch { /* fall through to execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      this.showTransientNotice(ok ? 'Link copied.' : 'Could not copy the link on this platform.');
    } catch {
      this.showTransientNotice('Could not copy the link on this platform.');
    }
  }

  /** Menu action: clear the current site's cached data, then reload it. */
  async clearActiveSiteCache() {
    const tab = this.getActiveTab();
    if (!tab || !/^https?:\/\//i.test(String(tab.url || ''))) {
      this.showTransientNotice('Open a website first - internal pages have no site cache.');
      return;
    }
    if (this.nativeWebview && typeof this.nativeWebview.clearSiteCache === 'function' && this._nativeWebviewTabIds.has(tab.id)) {
      try {
        const res = await this.nativeWebview.clearSiteCache(tab.id);
        if (res && res.ok) {
          let host = res.origin; try { host = new URL(res.origin).hostname; } catch { /* keep origin */ }
          this.showTransientNotice(`Cached data cleared for ${host}. Reloading…`);
          this.reload();
          return;
        }
        this.showTransientNotice(`Couldn't clear this site's cache${res?.reason ? ` (${res.reason})` : ''}.`);
        return;
      } catch { /* fall through */ }
    }
    this.showTransientNotice('Per-site cache clearing needs the Yayra desktop app - in a browser, use its own site settings.');
  }

  stopLoading() {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    // Environment-aware stop: native Electron views get a real
    // webContents.stop(); iframe-based tabs (web/PWA) get a best-effort
    // contentWindow.stop() (only reachable for same-origin documents).
    // Either way the UI flips back to the refresh icon IMMEDIATELY - a
    // stop must never leave the button stuck as an X.
    if (this.nativeWebview && this._nativeWebviewTabIds.has(activeTab.id)
      && !this.isSystemBrowserAuthHost(activeTab.url)) {
      this.nativeWebview.stop(activeTab.id).catch(() => {});
    } else {
      const frame = this.webFrames?.get(activeTab.id);
      try { frame?.iframe?.contentWindow?.stop?.(); } catch { /* cross-origin */ }
    }
    this.updateTabLoading(activeTab.id, false);
  }

  updateTabLoading(tabId, isLoading) {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (tab) {
      const changed = tab.isLoading !== Boolean(isLoading);
      tab.isLoading = Boolean(isLoading);
      if (changed && tab.isLoading) {
        tab.loadingStartedAt = Date.now();
        this._ensureLoadingWatchdog();
      }
      const countEl = this.rootElement?.querySelector('.fb-page-loading-bar');
      if (countEl) countEl.style.display = isLoading ? 'block' : 'none';
      if (changed) this.refreshLoadingUi(tabId);
      this.ensurePersistentAssistiveBubble();
    }
  }

  /**
   * Stuck-X watchdog: the refresh/stop button is driven by
   * loading-start/loading-stop events, and the optimistic X on
   * reload()/navigate. If a single loading-stop is EVER missed (busy
   * renderer, SPA subframe quirks, an event racing a chrome re-render),
   * the button used to stay an X forever. While any native tab claims
   * to be loading, this asks the REAL engine (webContents.isLoading())
   * every 2s and snaps the UI back to the truth. Self-terminates the
   * moment nothing is loading; never runs for iframe tabs (their <load>
   * event is the truth there).
   */
  _ensureLoadingWatchdog() {
    if (this._loadingWatchdogTimer) return;
    if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
    if (!this.nativeWebview || typeof this.nativeWebview.isLoading !== 'function') return;
    this._loadingWatchdogTimer = window.setInterval(() => {
      const loadingTabs = this.state.tabs.filter((t) => t.isLoading && this._nativeWebviewTabIds.has(t.id));
      if (!loadingTabs.length) {
        window.clearInterval(this._loadingWatchdogTimer);
        this._loadingWatchdogTimer = null;
        return;
      }
      const now = Date.now();
      for (const tab of loadingTabs) {
        // Give real loads breathing room - only reconcile after 2.5s.
        if (now - (tab.loadingStartedAt || 0) < 2500) continue;
        this.nativeWebview.isLoading(tab.id).then((res) => {
          if (res && res.isLoading === false) this.updateTabLoading(tab.id, false);
        }).catch(() => {});
      }
    }, 2000);
  }

  /**
   * Smart loading indicators, updated surgically IN PLACE (never a full
   * re-render, so nothing flickers):
   *  - the reload button knows the page state: X (stop) while the site is
   *    loading, back to the refresh sign the moment it's fully loaded;
   *  - the tab's icon slot shows an animated hourglass ("time sign")
   *    while loading, then the real favicon again.
   * Works for every environment that reports loading state: Electron
   * native views (loading-start/loading-stop events), web/PWA iframes
   * (load events), desktop and mobile toolbars alike.
   */
  /**
   * Surgical back/forward button state for same-URL navigations
   * (reloads): no full re-render, so refreshing never blinks.
   */
  refreshNavigationUi(tab) {
    if (typeof document === 'undefined' || !tab) return;
    const root = this.rootElement;
    if (!root || typeof root.querySelector !== 'function') return;
    const backBtn = root.querySelector('.fb-nav-back');
    if (backBtn) backBtn.disabled = !tab.canGoBack;
    const fwdBtn = root.querySelector('.fb-nav-forward');
    if (fwdBtn) fwdBtn.disabled = !tab.canGoForward;
  }

  /** Surgical tab-strip label update (title changes never blink the chrome). */
  refreshTabTitleUi(tabId) {
    if (typeof document === 'undefined') return;
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const root = this.rootElement;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const tabEl of root.querySelectorAll('.fb-tab-item') || []) {
      const elTabId = (tabEl.dataset && tabEl.dataset.tabId)
        || (typeof tabEl.getAttribute === 'function' ? tabEl.getAttribute('data-tab-id') : null);
      if (elTabId !== tabId) continue;
      const label = typeof tabEl.querySelector === 'function' ? tabEl.querySelector('.fb-tab-title') : null;
      if (label) label.textContent = tab.title || 'New Tab';
    }
  }

  refreshLoadingUi(tabId) {
    if (typeof document === 'undefined') return;
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const root = this.rootElement || document;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    // Reload/stop button(s) - only the ACTIVE tab drives the toolbar.
    if (tabId === this.state.activeTabId) {
      for (const selector of ['.fb-nav-reload', '.fb-mobile-refresh-btn']) {
        const btn = root.querySelector(selector);
        if (!btn) continue;
        btn.innerHTML = tab.isLoading ? Icons.stop : Icons.refresh;
        btn.setAttribute('title', tab.isLoading ? 'Stop loading this page (Esc)' : 'Reload this page (Ctrl+R)');
        btn.setAttribute('aria-label', tab.isLoading ? 'Stop' : 'Reload');
      }
    }

    // The tab's icon slot: hourglass while loading, favicon when done.
    for (const tabEl of root.querySelectorAll('.fb-tab-item') || []) {
      const elTabId = (tabEl.dataset && tabEl.dataset.tabId)
        || (typeof tabEl.getAttribute === 'function' ? tabEl.getAttribute('data-tab-id') : null);
      if (elTabId !== tabId) continue;
      const favicon = tabEl.querySelector?.('.fb-tab-favicon');
      if (favicon) {
        favicon.innerHTML = this.getTabFavicon(tab);
        // Fresh <img> from innerHTML: re-attach the CSP-safe fallbacks.
        this.bindTabLogoFallbacks(favicon);
      }
    }
  }

  /* -------------------------------------------------------------
   * SMART DOWNLOADS: progress ring + dropdown tracker
   * -----------------------------------------------------------
   * The toolbar download button wears a revolving ring tracking the live
   * download percentage, and opens a Chrome-style dropdown (latest 5,
   * state-aware actions) instead of yanking the user to a new tab. Live
   * progress updates are surgical (ring + open row only) - a full
   * re-render per network chunk would flicker and steal focus.
   * ----------------------------------------------------------- */
  activeDownloads() {
    return (this.state.downloadsItems || []).filter((it) => it.state === 'Downloading' || it.state === 'Paused');
  }

  /** Aggregate percent across in-flight downloads; null = indeterminate. */
  downloadProgressSummary() {
    const active = this.activeDownloads();
    if (!active.length) return { active: 0, percent: null };
    let received = 0;
    let total = 0;
    for (const it of active) {
      if (Number(it.sizeBytes) > 0) {
        total += Number(it.sizeBytes);
        received += Number(it.receivedBytes) || 0;
      }
    }
    return { active: active.length, percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null };
  }

  renderDownloadRingHtml() {
    const { active, percent } = this.downloadProgressSummary();
    if (!active) return '';
    const c = 2 * Math.PI * 14; // viewBox circle r=14
    const offset = percent === null ? c * 0.75 : c * (1 - percent / 100);
    return `
      <svg class="fb-dl-ring${percent === null ? ' indeterminate' : ''}" viewBox="0 0 32 32" aria-hidden="true">
        <circle class="fb-dl-ring-track" cx="16" cy="16" r="14"/>
        <circle class="fb-dl-ring-fill" cx="16" cy="16" r="14" style="stroke-dasharray:${c.toFixed(2)}; stroke-dashoffset:${offset.toFixed(2)};"/>
      </svg>`;
  }

  describeDownloadActivity() {
    const { active, percent } = this.downloadProgressSummary();
    if (!active) return 'Downloads (Ctrl+J)';
    return `Downloading ${active} file${active === 1 ? '' : 's'}${percent === null ? '…' : ` - ${percent}%`}`;
  }

  /** Normalized handler for every downloads bridge event. */
  handleDownloadEvent(payload) {
    if (!payload || !payload.id) return;
    const { type, ...item } = payload;
    const items = this.state.downloadsItems.slice();
    const idx = items.findIndex((it) => it.id === item.id);
    if (idx === -1) items.unshift(item);
    else items[idx] = { ...items[idx], ...item };
    this.state.downloadsItems = items;

    if (type === 'progress') {
      // Per-chunk: ring + visible dropdown row only. NEVER a full render.
      this.updateDownloadIndicator(items[idx === -1 ? 0 : idx]);
      return;
    }
    // started / done: structural change - rows and actions change shape.
    this.render();
    if (type === 'done') {
      const merged = items[idx === -1 ? 0 : idx];
      if (merged.state === 'Completed') {
        this.showTransientNotice(`Download complete: ${merged.filename}`);
      } else if (merged.state === 'Failed') {
        this.showTransientNotice(`Download failed: ${merged.filename} - retry from the downloads menu.`);
      }
    }
  }

  /** Surgical in-place refresh of the ring and any visible dropdown row. */
  updateDownloadIndicator(item) {
    if (typeof document === 'undefined') return;
    const root = this.rootElement || document;
    if (!root || typeof root.querySelector !== 'function') return;

    const btn = root.querySelector('.fb-toolbar-downloads-btn');
    if (btn) {
      btn.innerHTML = `${this.renderDownloadRingHtml()}${Icons.download}`;
      btn.setAttribute('title', this.describeDownloadActivity());
    }

    if (!item || !this.state.isDownloadsDropdownOpen) return;
    for (const row of root.querySelectorAll('.fb-dl-item') || []) {
      const rowId = (row.dataset && row.dataset.dlId)
        || (typeof row.getAttribute === 'function' ? row.getAttribute('data-dl-id') : null);
      if (rowId !== item.id) continue;
      const fill = row.querySelector?.('.fb-dl-progress-fill');
      if (fill && typeof item.progress === 'number') fill.style.width = `${item.progress}%`;
      const meta = row.querySelector?.('.fb-dl-meta');
      if (meta) meta.textContent = this.describeDownloadItem(item);
    }
  }

  describeDownloadItem(item) {
    const size = item.size || '';
    switch (item.state) {
      case 'Downloading':
        return typeof item.progress === 'number'
          ? `${item.progress}% of ${size || 'unknown size'}`
          : `Downloading… ${size}`;
      case 'Paused': return `Paused${typeof item.progress === 'number' ? ` at ${item.progress}%` : ''} - ${size}`;
      case 'Completed': return `${size}${item.date ? ` - ${item.date}` : ''}`;
      case 'Cancelled': return 'Cancelled';
      case 'Failed': return 'Failed - the file was not saved';
      default: return size;
    }
  }

  downloadStateIconHtml(item) {
    switch (item.state) {
      case 'Downloading': return `<span class="fb-dl-state-icon st-progress">${Icons.download}</span>`;
      case 'Paused': return `<span class="fb-dl-state-icon st-paused">${Icons.pause}</span>`;
      case 'Completed': return `<span class="fb-dl-state-icon st-done">${Icons.check}</span>`;
      case 'Failed': return `<span class="fb-dl-state-icon st-failed">${Icons.alertTriangle}</span>`;
      case 'Cancelled': return `<span class="fb-dl-state-icon st-failed">${Icons.stop}</span>`;
      default: return `<span class="fb-dl-state-icon">${Icons.download}</span>`;
    }
  }

  /**
   * State-aware action set - what shows (and what must NOT) per state:
   *  - Downloading: pause, cancel, copy address. ALWAYS visible (a stop
   *    must never hide behind a hover). No open/show-in-folder (no file).
   *  - Paused: resume, cancel, copy address. Always visible.
   *  - Completed: open, show in folder, copy file path, copy address,
   *    open address in tab, remove. Hover-revealed on pointer devices,
   *    always visible on touch (android/web).
   *  - Failed/Cancelled: retry (always visible), copy address, open
   *    address in tab, remove. Never open/show-in-folder (nothing saved).
   */
  downloadItemActionsHtml(item) {
    const hasBridge = Boolean(this.downloadsBridge);
    const act = (action, title, icon, extraClass = '') =>
      `<button class="fb-dl-act ${extraClass}" data-dl-action="${action}" title="${title}" aria-label="${title}">${icon}</button>`;
    if (item.state === 'Downloading') {
      return `<span class="fb-dl-item-actions fb-dl-actions-always">
        ${hasBridge ? act('pause', 'Pause download', Icons.pause) : ''}
        ${hasBridge ? act('cancel', 'Cancel download', Icons.stop) : ''}
        ${item.url ? act('copy-url', 'Copy download address', Icons.copy) : ''}
      </span>`;
    }
    if (item.state === 'Paused') {
      return `<span class="fb-dl-item-actions fb-dl-actions-always">
        ${hasBridge ? act('resume', 'Resume download', Icons.play) : ''}
        ${hasBridge ? act('cancel', 'Cancel download', Icons.stop) : ''}
        ${item.url ? act('copy-url', 'Copy download address', Icons.copy) : ''}
      </span>`;
    }
    if (item.state === 'Completed') {
      return `<span class="fb-dl-item-actions fb-dl-actions-reveal">
        ${hasBridge ? act('open', 'Open file', Icons.externalLink) : ''}
        ${hasBridge ? act('show', 'Show in folder', Icons.folder) : ''}
        ${hasBridge && item.path ? act('copy-path', 'Copy file path', Icons.save) : ''}
        ${item.url ? act('copy-url', 'Copy download address', Icons.copy) : ''}
        ${item.url ? act('open-url', 'Open download address in a tab', Icons.globe) : ''}
        ${hasBridge ? act('remove', 'Remove from list', Icons.trash) : ''}
      </span>`;
    }
    // Failed / Cancelled
    return `<span class="fb-dl-item-actions fb-dl-actions-reveal">
      ${(hasBridge && item.url) ? act('retry', 'Retry download', Icons.refresh, 'fb-dl-act-retry fb-dl-act-always') : ''}
      ${item.url ? act('copy-url', 'Copy download address', Icons.copy) : ''}
      ${item.url ? act('open-url', 'Open download address in a tab', Icons.globe) : ''}
      ${hasBridge ? act('remove', 'Remove from list', Icons.trash) : ''}
    </span>`;
  }

  /* -------------------------------------------------------------
   * PDF EVERYWHERE (user request): drag-and-drop, OS "Open with",
   * downloads right-click "Open in Yayra".
   * ----------------------------------------------------------- */
  /** One global drop zone: any PDF dropped anywhere in Yayra opens in
   *  the document viewer. Non-PDF files get the honest roadmap notice. */
  _armPdfDropZone() {
    if (this._pdfDropArmed || typeof document === 'undefined') return;
    this._pdfDropArmed = true;
    const isFileDrag = (e) => {
      try { return Array.from(e.dataTransfer?.types || []).includes('Files'); } catch { return false; }
    };
    this._pdfDropHandlers = {
      dragover: (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault(); // without it the browser would navigate away
        try { e.dataTransfer.dropEffect = 'copy'; } catch { /* shim */ }
      },
      drop: (e) => {
        if (!isFileDrag(e)) return;
        // Drops aimed at a real file input belong to that input.
        if (e.target && typeof e.target === 'object' && String(e.target.tagName || '').toUpperCase() === 'INPUT') return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) this._openDroppedPdfFiles(files);
      }
    };
    // Optional-call style (older shims/test environments): the handlers
    // exist either way - only the live attachment needs the DOM.
    document.addEventListener?.('dragover', this._pdfDropHandlers.dragover);
    document.addEventListener?.('drop', this._pdfDropHandlers.drop);
  }

  async _openDroppedPdfFiles(files) {
    const pdfs = files.filter((f) => classifyDocument(f && f.name) === 'pdf');
    if (!pdfs.length) {
      this.showTransientNotice('Only PDF documents open in Yayra right now - Word, Excel and PowerPoint are on the roadmap.');
      return;
    }
    for (const file of pdfs.slice(0, 8)) {
      try {
        const bytes = await this._readFileBytes(file);
        this.addDocumentTab({ name: file.name, bytes });
      } catch { this.showTransientNotice(`Couldn\u2019t read \u201C${file.name}\u201D.`); }
    }
  }

  _readFileBytes(file) {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read-failed'));
      reader.readAsArrayBuffer(file);
    });
  }

  isPdfDownload(item) {
    return Boolean(item) && (/\.pdf$/i.test(String(item.filename || item.name || ''))
      || String(item.mime || item.mimeType || '') === 'application/pdf'
      || (/\.pdf$/i.test(String(item.path || ''))));
  }

  /** Right-click menu for a download: "Open in Yayra" for PDFs (the
   *  in-app viewer), plus the OS open / reveal / copy actions. */
  showDownloadsContextMenu(evt, item) {
    if (typeof document === 'undefined' || !document.body || !item) return;
    document.getElementById('yayra-dl-context-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'yayra-dl-context-menu';
    menu.className = 'fb-dl-context-menu';
    menu.style.cssText = `position:fixed; z-index:2147483647; min-width:200px; background:var(--fb-bg-surface-elevated,#171a22); border:1px solid var(--fb-border-glass,rgba(255,255,255,0.12)); border-radius:10px; padding:6px; box-shadow:0 16px 48px rgba(0,0,0,0.55); left:${Math.max(8, (evt.clientX || 60) - 24)}px; top:${Math.max(8, evt.clientY || 60)}px; font-size:0.82rem; color:var(--fb-text-primary,#f3f4f6);`;
    const dismiss = () => { try { menu.remove(); } catch { /* gone */ } };
    const entry = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = 'fb-dl-ctx-entry';
      b.style.cssText = 'display:block; width:100%; text-align:left; padding:8px 10px; border:none; border-radius:7px; background:transparent; color:inherit; font-size:0.82rem; cursor:pointer;';
      b.addEventListener('click', () => { dismiss(); fn(); });
      menu.appendChild(b);
    };
    if (this.isPdfDownload(item)) entry('Open in Yayra', () => this.performDownloadAction(item.id, 'open-in-yayra'));
    if (this.downloadsBridge) {
      entry('Open (desktop app)', () => this.performDownloadAction(item.id, 'open'));
      entry('Show in folder', () => this.performDownloadAction(item.id, 'show'));
    }
    if (item.path) entry('Copy file path', () => this.performDownloadAction(item.id, 'copy-path'));
    if (item.url) entry('Copy download address', () => this.performDownloadAction(item.id, 'copy-url'));
    if (!menu.children || menu.children.length === 0) return;
    document.body.appendChild(menu);
    setTimeout(() => {
      if (typeof document.addEventListener !== 'function') return; // shim
      const away = () => { dismiss(); document.removeEventListener('click', away, true); };
      document.addEventListener('click', away, true);
    }, 0);
  }

  renderDownloadsDropdown(root) {
    this.appendDropdownScrim(root, () => {
      this.state.isDownloadsDropdownOpen = false;
      this.state.isDownloadsDropdownExpanded = false;
      this.render();
    });

    const dropdown = document.createElement('div');
    dropdown.className = 'fb-downloads-dropdown';
    const allDownloads = this.state.downloadsItems || [];
    const expanded = Boolean(this.state.isDownloadsDropdownExpanded);
    const visibleDownloads = expanded ? allDownloads : allDownloads.slice(0, 5);

    const rows = visibleDownloads.map((item) => `
      <div class="fb-dl-item st-${String(item.state || '').toLowerCase()}" data-dl-id="${item.id}">
        ${this.downloadStateIconHtml(item)}
        <span class="fb-dl-item-main">
          <strong class="fb-dl-item-name" title="${item.filename || ''}">${item.filename || 'download'}</strong>
          ${item.state === 'Downloading' || item.state === 'Paused' ? `
            <span class="fb-dl-progress"><span class="fb-dl-progress-fill" style="width:${typeof item.progress === 'number' ? item.progress : 15}%;"></span></span>` : ''}
          <small class="fb-dl-meta">${this.describeDownloadItem(item)}</small>
        </span>
        ${this.downloadItemActionsHtml(item)}
      </div>
    `).join('');

    dropdown.innerHTML = `
      <div class="fb-downloads-dropdown-header">
        <strong>Downloads</strong>
        ${this.activeDownloads().length ? `<small>${this.describeDownloadActivity()}</small>` : ''}
      </div>
      <div class="fb-downloads-dropdown-list">
        ${visibleDownloads.length ? rows : `<p class="fb-dl-empty">${this.downloadsBridge
          ? 'No downloads yet - files you download will appear here.'
          : 'Downloads appear here on the Yayra desktop app. This browser handles file saving natively.'}</p>`}
      </div>
      ${allDownloads.length > 5 ? `<button type="button" class="fb-btn fb-btn-secondary fb-dl-more-btn">${expanded ? 'Show less' : `More (${allDownloads.length - 5})`}</button>` : ''}
      <button class="fb-btn fb-btn-secondary fb-dl-open-page" style="width:100%;">${Icons.download} Open Yayra Downloads</button>
    `;

    dropdown.querySelector('.fb-dl-more-btn')?.addEventListener('click', () => {
      this.state.isDownloadsDropdownExpanded = !this.state.isDownloadsDropdownExpanded;
      this.render();
    });

    dropdown.querySelector('.fb-dl-open-page')?.addEventListener('click', () => {
      this.state.isDownloadsDropdownOpen = false;
      this.state.isDownloadsDropdownExpanded = false;
      this.openInternalPage('yayra://downloads');
    });

    for (const row of dropdown.querySelectorAll('.fb-dl-item')) {
      const id = (row.dataset && row.dataset.dlId) || row.getAttribute?.('data-dl-id');
      // RIGHT-CLICK: the per-download menu ("Open in Yayra" for PDFs,
      // OS open / reveal / copy actions).
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const item = (this.state.downloadsItems || []).find((it) => it.id === id);
        this.showDownloadsContextMenu(e, item);
      });
      for (const btn of row.querySelectorAll('.fb-dl-act')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = (btn.dataset && btn.dataset.dlAction) || btn.getAttribute?.('data-dl-action');
          this.performDownloadAction(id, action);
        });
      }
    }

    root.appendChild(dropdown);
  }

  async performDownloadAction(id, action) {
    const item = (this.state.downloadsItems || []).find((it) => it.id === id);
    if (!item || !action) return;
    const bridge = this.downloadsBridge;
    const copy = (value, notice) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(value);
          this.showTransientNotice(notice);
        }
      } catch { /* clipboard unavailable */ }
    };
    switch (action) {
      case 'open': {
        const res = await bridge?.open?.(id);
        if (res && res.ok === false) this.showTransientNotice(`Couldn't open file: ${res.error || 'unknown error'}`);
        break;
      }
      case 'show': {
        const res = await bridge?.showInFolder?.(id);
        if (res && res.ok === false) this.showTransientNotice(`Couldn't show in folder: ${res.error || 'unknown error'}`);
        break;
      }
      case 'copy-path':
        if (item.path) copy(item.path, 'File path copied');
        break;
      case 'copy-url':
        if (item.url) copy(item.url, 'Download address copied');
        break;
      case 'open-in-yayra': {
        if (!bridge || typeof bridge.openPdf !== 'function') {
          this.showTransientNotice('Opening downloads inside Yayra needs the desktop app.');
          break;
        }
        this.state.isDownloadsDropdownOpen = false;
        this.state.isDownloadsDropdownExpanded = false;
        const res = await bridge.openPdf(id);
        if (res && res.ok) {
          this.addDocumentTab({ name: res.name, bytes: res.data });
        } else {
          this.showTransientNotice(`Couldn't open it in Yayra${res && res.reason ? ` (${res.reason})` : ''}.`);
        }
        break;
      }
      case 'open-url':
        if (item.url) {
          this.state.isDownloadsDropdownOpen = false;
          this.state.isDownloadsDropdownExpanded = false;
          this.createNewTab();
          this.navigateActiveTab(item.url);
        }
        break;
      case 'pause':
        await bridge?.pause?.(id);
        break;
      case 'resume':
        await bridge?.resume?.(id);
        break;
      case 'cancel': {
        const res = await bridge?.cancel?.(id);
        if (res?.ok) this.showTransientNotice(`Cancelled: ${item.filename}`);
        break;
      }
      case 'retry': {
        const res = await bridge?.retry?.(id);
        if (res?.ok) {
          // The failed row is replaced by the fresh attempt's record.
          this.state.downloadsItems = this.state.downloadsItems.filter((it) => it.id !== id);
          this.showTransientNotice(`Retrying: ${item.filename}`);
          this.render();
        } else {
          this.showTransientNotice(`Couldn't retry: ${res?.error || 'unknown error'}`);
        }
        break;
      }
      case 'remove': {
        if (bridge?.remove) {
          const res = await bridge.remove(id);
          if (res?.items) this.state.downloadsItems = res.items;
          else this.state.downloadsItems = this.state.downloadsItems.filter((it) => it.id !== id);
        } else {
          this.state.downloadsItems = this.state.downloadsItems.filter((it) => it.id !== id);
        }
        this.render();
        break;
      }
      default:
        break;
    }
  }

  /* -------------------------------------------------------------
   * BOOKMARKS & REPOSITORIES
   * ----------------------------------------------------------- */
  async toggleBookmarkCurrentTab() {
    const activeTab = this.getActiveTab();
    if (!activeTab || !activeTab.url || activeTab.url === 'yayra://newtab') return;

    this._bookmarkCheckId = (this._bookmarkCheckId || 0) + 1;
    this.state.isBookmarked = !this.state.isBookmarked;

    if (this.bookmarksRepo) {
      if (this.state.isBookmarked) {
        if (typeof this.bookmarksRepo.addBookmark === 'function') {
          await this.bookmarksRepo.addBookmark({
            url: activeTab.url,
            title: activeTab.title || activeTab.url,
            favicon: activeTab.favicon
          });
        }
      } else {
        if (typeof this.bookmarksRepo.removeBookmarkByUrl === 'function') {
          await this.bookmarksRepo.removeBookmarkByUrl(activeTab.url);
        } else if (typeof this.bookmarksRepo.removeBookmark === 'function') {
          await this.bookmarksRepo.removeBookmark(activeTab.url);
        }
      }
      if (typeof this.bookmarksRepo.getAllBookmarks === 'function') {
        await this.refreshBookmarksState();
      }
    }

    const starBtn = this.rootElement?.querySelector('.fb-omnibox-star');
    if (starBtn) {
      starBtn.className = `fb-omnibox-star ${this.state.isBookmarked ? 'bookmarked' : ''}`;
      starBtn.innerHTML = this.state.isBookmarked ? Icons.starFilled : Icons.star;
    }
  }

  async updateBookmarkState(url) {
    if (!url || url === 'yayra://newtab' || !this.bookmarksRepo) {
      this.state.isBookmarked = false;
      return;
    }

    const currentCheckId = ++this._bookmarkCheckId;
    if (typeof this.bookmarksRepo.isBookmarked === 'function') {
      try {
        const bookmarked = await this.bookmarksRepo.isBookmarked(url);
        if (this._bookmarkCheckId === currentCheckId) {
          this.state.isBookmarked = Boolean(bookmarked);
          const starBtn = this.rootElement?.querySelector('.fb-omnibox-star');
          if (starBtn) {
            starBtn.className = `fb-omnibox-star ${this.state.isBookmarked ? 'bookmarked' : ''}`;
            starBtn.innerHTML = this.state.isBookmarked ? Icons.starFilled : Icons.star;
          }
        }
      } catch (err) {
        console.warn('Failed to verify bookmark state:', err);
      }
    }
  }

  shareCurrentPage() {
    const activeTab = this.getActiveTab();
    if (typeof navigator !== 'undefined' && navigator.share && activeTab) {
      navigator.share({ title: activeTab.title, url: activeTab.url }).catch(() => {});
    } else if (typeof navigator !== 'undefined' && navigator.clipboard && activeTab) {
      navigator.clipboard.writeText(activeTab.url);
      alert('Link copied to clipboard: ' + activeTab.url);
    }
  }

  openModal(modalName) {
    this.state.activeModal = modalName;
    this.render();
  }

  closeModal() {
    this.state.activeModal = null;
    this.render();
  }

  toggleModal(modalName) {
    if (this.state.activeModal === modalName) {
      this.closeModal();
    } else {
      this.openModal(modalName);
    }
  }

  /**
   * Resolves the user's theme preference into the concrete theme the shell
   * should render. 'system' follows the OS via prefers-color-scheme and
   * falls back to dark when media queries are unavailable.
   */
  resolveEffectiveTheme() {
    const pref = this.state.settings.theme || 'dark';
    if (pref === 'light') return 'light';
    if (pref !== 'system') return 'dark';
    try {
      if (typeof matchMedia === 'function') {
        return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
    } catch {
      // Fall through to the dark default below.
    }
    return 'dark';
  }

  /** Apply the resolved theme at document scope as well as to the shell. */
  applyDocumentTheme() {
    if (typeof document === 'undefined') return this.resolveEffectiveTheme();
    const theme = this.resolveEffectiveTheme();
    const colorTheme = this.state.settings.colorTheme || 'blue';
    const roots = [document.documentElement, document.body].filter(Boolean);
    for (const root of roots) {
      root.setAttribute?.('data-theme', theme);
      root.setAttribute?.('data-color-theme', colorTheme);
      root.style?.setProperty?.('color-scheme', theme);
    }
    return theme;
  }

  /**
   * Persists the current settings snapshot to the settings repository and
   * localStorage. Fire-and-forget: UI changes always apply immediately
   * even if persistence fails (e.g. storage quota exceeded).
   */
  persistSettings() {
    if (this.settingsRepo && typeof this.settingsRepo.updateSettings === 'function') {
      try {
        const result = this.settingsRepo.updateSettings(this.state.settings);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // Non-fatal: the in-memory state is already updated.
      }
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('yayra:settings', JSON.stringify(this.state.settings));
      } catch {
        // Keep the browser usable when storage is unavailable or full.
      }
    }
  }

  updateCssCustomProperties() {
    if (this.rootElement && this.rootElement.style && typeof this.rootElement.style.setProperty === 'function') {
      if (this.state.settings.bubbleOpacity !== undefined) {
        this.rootElement.style.setProperty('--fb-bubble-opacity', String(this.state.settings.bubbleOpacity));
      }
      if (this.state.settings.bubbleSizePx !== undefined) {
        this.rootElement.style.setProperty('--fb-bubble-size', `${this.state.settings.bubbleSizePx}px`);
      }
      if (this.state.settings.frameOpacity !== undefined) {
        this.rootElement.style.setProperty('--fb-frame-opacity', String(this.state.settings.frameOpacity));
      }
      if (this.state.settings.glassmorphismBlurRadius !== undefined) {
        this.rootElement.style.setProperty('--fb-glass-blur', `${this.state.settings.glassmorphismBlurRadius}px`);
      }
    }
  }

  toggleFullscreen() {
    this.state.isFullscreen = !this.state.isFullscreen;
    this.render();
  }

  reopenLastClosedTab() {
    if (this.state.closedTabsHistory.length === 0) return null;
    const lastClosed = this.state.closedTabsHistory.pop();
    const newTab = {
      id: 'tab-' + Math.random().toString(36).substring(2, 9),
      url: lastClosed.url || 'yayra://newtab',
      title: lastClosed.title || this.getTabTitle(lastClosed),
      isSecure: true,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      isPrivate: lastClosed.isPrivate || false,
      favicon: lastClosed.favicon || null
    };
    this.state.tabs.push(newTab);
    this.state.activeTabId = newTab.id;
    this.state.urlInputValue = newTab.url;
    this.render();
    return newTab;
  }

  zoomIn() {
    this.setZoom(this.state.zoomLevel + 10);
  }

  zoomOut() {
    this.setZoom(this.state.zoomLevel - 10);
  }

  setZoom(level) {
    const clamped = Math.max(25, Math.min(500, Math.round(level)));
    this.state.zoomLevel = clamped;
    this.applyNativeZoom();
    this.render();
  }

  resetZoom() {
    this.state.zoomLevel = 100;
    this.applyNativeZoom();
    this.render();
  }

  /**
   * On the Electron desktop the page lives in a native WebContentsView
   * that CSS transforms can't touch - push the zoom factor to the real
   * engine so the menu's +/- actually zooms the page.
   */
  applyNativeZoom() {
    const tab = this.getActiveTab();
    if (!tab || !this.nativeWebview || typeof this.nativeWebview.setZoom !== 'function') return;
    try {
      const res = this.nativeWebview.setZoom(tab.id, this.state.zoomLevel / 100);
      if (res && typeof res.catch === 'function') res.catch(() => {});
    } catch { /* view not ready yet */ }
  }

  executeFindInPage(query) {
    this.state.findInPage = {
      isOpen: true,
      query: query || '',
      currentMatch: query ? 1 : 0,
      matchesCount: query ? 5 : 0
    };
    this.render();
  }

  findNext() {
    if (!this.state.findInPage.isOpen || this.state.findInPage.matchesCount === 0) return;
    let next = this.state.findInPage.currentMatch + 1;
    if (next > this.state.findInPage.matchesCount) next = 1;
    this.state.findInPage.currentMatch = next;
    this.render();
  }

  findPrev() {
    if (!this.state.findInPage.isOpen || this.state.findInPage.matchesCount === 0) return;
    let prev = this.state.findInPage.currentMatch - 1;
    if (prev < 1) prev = this.state.findInPage.matchesCount;
    this.state.findInPage.currentMatch = prev;
    this.render();
  }

  closeFindInPage() {
    this.state.findInPage = {
      isOpen: false,
      query: '',
      currentMatch: 0,
      matchesCount: 0
    };
    this.render();
  }

  getDisplayUrl(url) {
    if (!url || url === 'yayra://newtab' || url === 'about:blank') return '';
    return url;
  }

  getTabTitle(tab) {
    if (!tab) return 'New Tab';
    if (tab.title && tab.title !== 'New Tab') return tab.title;
    if (!tab.url || tab.url === 'yayra://newtab') return tab.isPrivate ? 'Incognito Tab' : 'New Tab';
    if (tab.url === 'yayra://settings') return 'Settings';
    if (tab.url === 'yayra://history') return 'History';
    if (tab.url === 'yayra://bookmarks') return 'Bookmarks';
    if (tab.url === 'yayra://downloads') return 'Downloads';
    if (tab.url === 'yayra://passwords') return 'Passwords';
    if (tab.url === 'yayra://extensions') return 'Extensions';
    if (tab.url === 'yayra://permissions') return 'Site Permissions';
    if (tab.url === 'yayra://ai' || tab.url.startsWith('yayra://ai?')) return 'Yayra AI';
    if (tab.url === 'yayra://about') return 'About Yayra';

    try {
      const parsed = new URL(tab.url);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return tab.url;
    }
  }

  /* -------------------------------------------------------------
   * LOCAL DOCUMENT WORKSPACE (Phase 1: PDF - docs/DOCUMENT_WORKSPACE.md)
   * ----------------------------------------------------------- */
  /**
   * Opens a local document. Electron: the native picker in the main
   * process (the file path never reaches the renderer - only the bytes of
   * the explicitly chosen file). Web/PWA/Android: the standard file
   * input. Documents open in their OWN tab; browsing tabs are untouched.
   */
  async openDocument() {
    try {
      const bridge = this.systemBridge?.documents;
      if (bridge && typeof bridge.openPdf === 'function') {
        const res = await bridge.openPdf();
        if (!res || !res.ok) {
          if (res && res.canceled) return; // user closed the picker
          this.showTransientNotice(`Couldn\u2019t open the document${res && res.reason ? ` (${res.reason})` : ''}.`);
          return;
        }
        this.addDocumentTab({ name: res.name, bytes: res.data });
        return;
      }
    } catch { /* fall through to the file input */ }
    this._openDocumentFileInput();
  }

  /** Web/PWA/Android picker: a hidden standard file input (offline, no
   *  plugins needed; Capacitor's WebView maps it to the system picker). */
  _openDocumentFileInput() {
    if (typeof document === 'undefined' || !document.body) {
      this.showTransientNotice('Opening documents needs the app interface.');
      return;
    }
    let input = this._docFileInput;
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.setAttribute('aria-label', 'Open a PDF document');
      input.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0;';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (classifyDocument(file.name) !== 'pdf') {
          this.showTransientNotice('Only PDF documents are supported right now - Word, Excel and PowerPoint are on the roadmap.');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => this.addDocumentTab({ name: file.name, bytes: reader.result });
        reader.onerror = () => this.showTransientNotice('Couldn\u2019t read the file.');
        reader.readAsArrayBuffer(file);
        input.value = '';
      });
      document.body.appendChild(input);
      this._docFileInput = input;
    }
    input.click();
  }

  /** Registers the document and opens it in a fresh tab of its own. */
  addDocumentTab({ name, bytes }) {
    let doc;
    try {
      doc = this.documentStore.add({ name, bytes });
    } catch {
      this.showTransientNotice('That file appears to be empty.');
      return null;
    }
    this.createNewTab();
    const tab = this.getActiveTab();
    if (!tab) return null;
    tab.url = `yayra://doc/${doc.id}`;
    tab.title = doc.name;
    tab.isDocument = true;
    tab.docId = doc.id;
    tab.docState = { status: 'loading', numPages: 0, page: 1, zoom: 1.25, query: '', matches: [], matchIndex: -1, error: null };
    this.render();
    return doc;
  }

  /** Lazy PDF.js loader (vendored, offline). The worker is the vendored
   *  module URL; where workers are unavailable PDF.js falls back to
   *  main-thread parsing automatically. */
  async _pdfjsModule() {
    if (this._pdfjsLib) return this._pdfjsLib;
    if (!this._pdfjsLibPromise) {
      this._pdfjsLibPromise = import('../vendor/pdfjs/pdf.mjs').then((lib) => {
        try {
          lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).toString();
        } catch { /* older embedders - PDF.js self-heals to main-thread */ }
        // Standard-14 font data + CJK cmaps (vendored, offline): without
        // these, PDFs that rely on non-embedded standard fonts (very common
        // in simple/older documents) render with missing/degraded text, and
        // CJK documents fail outright. Wrapped so every getDocument call the
        // viewer makes carries them without the viewer knowing.
        const stdFontUrl = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).toString();
        const cMapUrl = new URL('../vendor/pdfjs/cmaps/', import.meta.url).toString();
        const wrapped = Object.create(lib);
        wrapped.getDocument = (params = {}) => lib.getDocument({
          standardFontDataUrl: stdFontUrl,
          cMapUrl,
          cMapPacked: true,
          ...params
        });
        this._pdfjsLib = wrapped;
        return wrapped;
      }).catch((error) => {
        // A transient asset/worker failure should be retryable rather than
        // pinning every future PDF tab to a rejected module promise.
        this._pdfjsLibPromise = null;
        throw error;
      });
    }
    return this._pdfjsLibPromise;
  }

  /** The integrated document tab: toolbar (pages, zoom, search, close) +
   *  the canvas host, driven by createPdfViewer. Honest states only -
   *  no placeholder buttons for unsupported operations. */
  renderDocumentViewer(viewport, tab) {
    const wrap = document.createElement('div');
    wrap.className = 'fb-doc-viewer';
    wrap.style.cssText = 'flex:1; min-height:0; display:flex; flex-direction:column; background:var(--fb-bg-app,#191c23); outline:none;';
    // Keyboard shortcuts (see createPdfViewer.handleKeydown) need the
    // viewer itself focusable.
    wrap.setAttribute('tabindex', '0');

    const btnCss = 'padding:5px 9px; border:none; border-radius:7px; background:var(--fb-bg-glass-input,rgba(255,255,255,0.07)); color:inherit; cursor:pointer; font-size:0.8rem;';
    const mkBtn = (label, title, fn, extraClass = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `fb-doc-btn ${extraClass}`;
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = btnCss;
      b.addEventListener('click', fn);
      return b;
    };

    // ---- Row A: identity + the big actions -----------------------------
    const bar = document.createElement('div');
    bar.className = 'fb-doc-toolbar';
    bar.style.cssText = 'flex:none; display:flex; align-items:center; gap:6px; padding:6px 10px; background:var(--fb-bg-elevated,#141824); border-bottom:1px solid rgba(255,255,255,0.08); font-size:0.8rem; color:var(--fb-text-primary,#dfe4ee);';
    const nameEl = document.createElement('span');
    nameEl.textContent = tab.title || 'Document';
    nameEl.style.cssText = 'max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;';
    bar.appendChild(nameEl);
    const spacerA = document.createElement('span');
    spacerA.style.cssText = 'flex:1;';
    bar.appendChild(spacerA);
    // "Use the desktop PDF app instead": the honest escape hatch from the
    // in-Yayra viewer (main process writes a temp file + OS open-with).
    if (this.systemBridge && this.systemBridge.documents && typeof this.systemBridge.documents.openExternal === 'function') {
      bar.appendChild(mkBtn('Desktop app', 'Open this PDF with your desktop PDF app instead', async () => {
        const d = this.documentStore.get(tab.docId);
        if (!d) return;
        try {
          const res = await this.systemBridge.documents.openExternal({ name: d.name, data: d.bytes });
          this.showTransientNotice(res && res.ok
            ? `Opening \u201C${d.name}\u201D with your desktop PDF app...`
            : `Couldn\u2019t open it externally${res && res.reason ? ` (${res.reason})` : ''}.`);
        } catch { this.showTransientNotice('Couldn\u2019t open it externally.'); }
      }));
    }
    bar.appendChild(mkBtn('\u2715 Close', 'Close the document and return to browsing', () => this.closeTab(tab.id), 'fb-doc-close-btn'));

    // ---- Row B: pages, zoom, fit, rotate, night, outline, search -------
    const bar2 = document.createElement('div');
    bar2.className = 'fb-doc-toolbar fb-doc-toolbar2';
    bar2.style.cssText = 'flex:none; display:flex; align-items:center; gap:6px; padding:5px 10px; background:var(--fb-bg-surface,#11141d); border-bottom:1px solid rgba(255,255,255,0.08); font-size:0.78rem; color:var(--fb-text-primary,#dfe4ee); flex-wrap:wrap;';

    bar2.appendChild(mkBtn('\u2039', 'Previous page (Left)', () => this._activeDocViewer?.viewer.prevPage()));
    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.className = 'fb-doc-page-input';
    pageInput.min = '1';
    pageInput.setAttribute('aria-label', 'Page number');
    pageInput.style.cssText = 'width:52px; padding:4px 6px; border-radius:6px; border:1px solid var(--fb-border-glass,rgba(255,255,255,0.12)); background:var(--fb-bg-glass-input,#101218); color:inherit; font-size:0.78rem; text-align:center;';
    const pageLabel = document.createElement('span');
    pageLabel.className = 'fb-doc-page-label';
    pageLabel.style.cssText = 'color:var(--fb-text-secondary,#9aa3b2);';
    pageLabel.textContent = '/ -';
    const gotoPage = () => {
      const n = parseInt(pageInput.value, 10);
      if (Number.isFinite(n)) this._activeDocViewer?.viewer.setPage(n);
    };
    pageInput.addEventListener('change', gotoPage);
    pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { gotoPage(); wrap.focus?.(); } });
    bar2.appendChild(pageInput);
    bar2.appendChild(pageLabel);
    bar2.appendChild(mkBtn('\u203a', 'Next page (Right)', () => this._activeDocViewer?.viewer.nextPage()));

    bar2.appendChild(mkBtn('\u2212', 'Zoom out (-)', () => this._activeDocViewer?.viewer.setZoom((tab.docState?.zoom || 1.25) - 0.25)));
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'fb-doc-zoom-label';
    zoomLabel.style.cssText = 'min-width:40px; text-align:center; color:var(--fb-text-secondary,#9aa3b2);';
    bar2.appendChild(zoomLabel);
    bar2.appendChild(mkBtn('+', 'Zoom in (+)', () => this._activeDocViewer?.viewer.setZoom((tab.docState?.zoom || 1.25) + 0.25)));

    bar2.appendChild(mkBtn('\u2194 Fit', 'Fit the page to the window width (F)', () => this._activeDocViewer?.viewer.fitToWidth(), 'fb-doc-btn-fitw'));
    bar2.appendChild(mkBtn('\u29c9 Page', 'Show the whole page at once', () => this._activeDocViewer?.viewer.fitToPage(), 'fb-doc-btn-fitp'));
    bar2.appendChild(mkBtn('\u21bb', 'Rotate 90\u00b0 (R)', () => this._activeDocViewer?.viewer.rotate(90), 'fb-doc-btn-rotate'));
    bar2.appendChild(mkBtn('\u263d', 'Night reading mode - invert colors (N)', () => { this._activeDocViewer?.viewer.setNight(!tab.docState?.night); }, 'fb-doc-btn-night'));
    bar2.appendChild(mkBtn('\u2630', 'Outline and page thumbnails', () => {
      tab.docState.sidebarOpen = !tab.docState.sidebarOpen;
      if (this._activeDocViewer && this._activeDocViewer.tabId === tab.id) this._activeDocViewer.rerenderSidebar?.();
      else this.render();
    }, 'fb-doc-btn-outline'));

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'fb-doc-search-input';
    searchInput.placeholder = 'Find in document (Ctrl+F)';
    searchInput.setAttribute('aria-label', 'Find in document');
    searchInput.style.cssText = 'width:160px; padding:5px 9px; border-radius:7px; border:1px solid var(--fb-border-glass,rgba(255,255,255,0.12)); background:var(--fb-bg-glass-input,#101218); color:inherit; font-size:0.78rem;';
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { this._activeDocViewer?.viewer.search(searchInput.value); }, 350);
    });
    bar2.appendChild(searchInput);
    const matchLabel = document.createElement('span');
    matchLabel.className = 'fb-doc-match-label';
    matchLabel.title = 'Show the list of matches';
    matchLabel.style.cssText = 'min-width:56px; color:var(--fb-text-secondary,#9aa3b2); font-size:0.72rem; cursor:pointer;';
    bar2.appendChild(matchLabel);

    // ---- Sidebar: outline + thumbnails ---------------------------------
    const sidebar = document.createElement('div');
    sidebar.className = 'fb-doc-sidebar';
    sidebar.style.cssText = 'flex:none; width:210px; min-height:0; overflow:auto; background:var(--fb-bg-elevated,#141722); border-right:1px solid var(--fb-border-glass,rgba(255,255,255,0.07)); padding:8px; display:none;';
    const sidebarTabs = document.createElement('div');
    sidebarTabs.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;';
    const mkTabBtn = (label, tabName) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `fb-doc-sidebar-tab fb-doc-sidebar-tab-${tabName}`;
      b.textContent = label;
      b.style.cssText = 'flex:1; padding:5px 8px; border:none; border-radius:7px; background:var(--fb-bg-glass-input,rgba(255,255,255,0.07)); color:inherit; cursor:pointer; font-size:0.75rem;';
      b.addEventListener('click', () => {
        tab.docState.sidebarTab = tabName;
        this._activeDocViewer?.rerenderSidebar?.();
      });
      return b;
    };
    sidebarTabs.appendChild(mkTabBtn('Outline', 'outline'));
    sidebarTabs.appendChild(mkTabBtn('Pages', 'thumbnails'));
    const sidebarBody = document.createElement('div');
    sidebarBody.className = 'fb-doc-sidebar-body';
    sidebar.appendChild(sidebarTabs);
    sidebar.appendChild(sidebarBody);

    // ---- Host + status --------------------------------------------------
    const host = document.createElement('div');
    host.className = 'fb-doc-host';
    host.style.cssText = 'flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px;';
    const statusEl = document.createElement('div');
    statusEl.className = 'fb-doc-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:10px; background:var(--fb-bg-app,#191c23); color:var(--fb-text-primary,#d7dbe3); text-align:center; padding:24px; font-size:0.9rem; z-index:2;';
    const statusMessage = document.createElement('div');
    statusMessage.className = 'fb-doc-status-message';
    const progressTrack = document.createElement('div');
    progressTrack.className = 'fb-doc-progress-track';
    progressTrack.style.cssText = 'width:min(320px,80%); height:4px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,0.12); display:none;';
    const progressFill = document.createElement('div');
    progressFill.className = 'fb-doc-progress-fill';
    progressFill.style.cssText = 'height:100%; width:0; border-radius:inherit; background:var(--fb-accent-primary,#6d5df2); transition:width 120ms linear;';
    progressTrack.appendChild(progressFill);
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'fb-doc-retry-btn';
    retryBtn.textContent = 'Try again';
    retryBtn.style.cssText = 'display:none; padding:7px 14px; border:0; border-radius:8px; background:var(--fb-accent-primary,#6d5df2); color:#fff; cursor:pointer; font-weight:600;';
    retryBtn.addEventListener('click', () => this.retryDocumentViewer(tab.id));
    statusEl.appendChild(statusMessage);
    statusEl.appendChild(progressTrack);
    statusEl.appendChild(retryBtn);

    // ---- Match list panel ----------------------------------------------
    const matchPanel = document.createElement('div');
    matchPanel.className = 'fb-doc-match-panel';
    matchPanel.style.cssText = 'position:absolute; top:0; right:0; bottom:0; width:260px; max-width:70%; overflow:auto; background:var(--fb-bg-elevated,rgba(17,20,29,0.97)); border-left:1px solid var(--fb-border-glass,rgba(255,255,255,0.1)); padding:8px; display:none; z-index:3; font-size:0.75rem; color:var(--fb-text-primary,#dfe4ee);';

    const rel = document.createElement('div');
    rel.style.cssText = 'position:relative; flex:1; min-height:0; display:flex; flex-direction:row;';
    const relCol = document.createElement('div');
    relCol.style.cssText = 'position:relative; flex:1; min-height:0; display:flex; flex-direction:column;';
    relCol.appendChild(host);
    relCol.appendChild(statusEl);
    relCol.appendChild(matchPanel);
    rel.appendChild(sidebar);
    rel.appendChild(relCol);

    wrap.appendChild(bar);
    wrap.appendChild(bar2);
    wrap.appendChild(rel);
    viewport.appendChild(wrap);
    try { wrap.focus?.(); } catch { /* shim */ }

    const doc = this.documentStore.get(tab.docId);
    const state = tab.docState || (tab.docState = createDocumentViewerState());
    // Fresh mounts of an old tab state get the new fields.
    for (const [k, v] of Object.entries(createDocumentViewerState())) {
      if (state[k] === undefined) state[k] = v;
    }

    const renderSidebar = () => {
      sidebarBody.innerHTML = '';
      try {
        sidebar.style.display = state.sidebarOpen ? 'block' : 'none';
        if (!state.sidebarOpen) return;
        for (const b of sidebarTabs.querySelectorAll('.fb-doc-sidebar-tab')) {
          b.style.background = 'var(--fb-bg-glass-input,rgba(255,255,255,0.07))';
        }
        const activeTabBtn = sidebarTabs.querySelector(`.fb-doc-sidebar-tab-${state.sidebarTab}`);
        if (activeTabBtn) activeTabBtn.style.background = 'rgba(109,93,242,0.35)';
        if (state.sidebarTab === 'thumbnails') {
          const count = Math.min(state.numPages || 0, 60);
          if (!count) {
            sidebarBody.innerHTML = '<div style="color:var(--fb-text-secondary,#9aa3b2); padding:8px;">No pages yet.</div>';
            return;
          }
          for (let p = 1; p <= count; p += 1) {
            const thumb = document.createElement('div');
            thumb.className = 'fb-doc-thumb';
            thumb.dataset.page = String(p);
            thumb.setAttribute('role', 'button');
            thumb.setAttribute('aria-label', `Go to page ${p}`);
            thumb.style.cssText = `margin:0 auto 10px; width:130px; padding:4px; border:1px solid ${p === state.page ? 'var(--fb-accent-primary,#6d5df2)' : 'var(--fb-border-glass,rgba(255,255,255,0.12))'}; border-radius:6px; cursor:pointer; text-align:center; background:var(--fb-bg-glass-input,#0e111a);`;
            const label = document.createElement('div');
            label.textContent = String(p);
            label.style.cssText = 'padding:2px 0; color:var(--fb-text-secondary,#9aa3b2); font-size:0.7rem;';
            thumb.appendChild(label);
            thumb.addEventListener('click', () => this._activeDocViewer?.viewer.setPage(p));
            sidebarBody.appendChild(thumb);
          }
          return;
        }
        if (!state.outline.length) {
          sidebarBody.innerHTML = '<div style="color:var(--fb-text-secondary,#9aa3b2); padding:8px; line-height:1.5;">This PDF has no table of contents. Use the Pages tab to jump between pages.</div>';
          return;
        }
        for (const item of state.outline) {
          const row = document.createElement('div');
          row.className = 'fb-doc-outline-item';
          row.textContent = item.title;
          if (item.page) {
            row.title = `Go to page ${item.page}`;
            row.addEventListener('click', () => this._activeDocViewer?.viewer.setPage(item.page));
          }
          row.style.cssText = `padding:6px 8px; margin-bottom:2px; border-radius:6px; cursor:${item.page ? 'pointer' : 'default'}; background:${item.page ? 'rgba(255,255,255,0.04)' : 'transparent'}; color:${item.page ? 'var(--fb-text-primary,#dfe4ee)' : 'var(--fb-text-secondary,#9aa3b2)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-left:${(item.depth || 0) * 12}px;`;
          sidebarBody.appendChild(row);
        }
      } catch { /* shim */ }
    };

    const sync = () => {
      try {
        pageInput.value = String(state.page || 1);
        pageInput.max = String(state.numPages || 1);
        pageLabel.textContent = `/ ${state.numPages || '-'}`;
        zoomLabel.textContent = `${Math.round((state.zoom || 1) * 100)}%`;
        matchLabel.textContent = state.query
          ? (state.matches.length ? `${state.matches.length} found \u25be` : '0 found')
          : '';
        const nightBtn = bar2.querySelector('.fb-doc-btn-night');
        if (nightBtn) nightBtn.style.background = state.night ? 'rgba(109,93,242,0.45)' : 'rgba(255,255,255,0.07)';
        const isLoading = state.status === 'loading';
        const hasError = state.status === 'error' || state.status === 'password';
        statusEl.style.display = state.status === 'ready' ? 'none' : 'flex';
        statusEl.setAttribute('role', hasError ? 'alert' : 'status');
        if (isLoading) {
          const stage = state.loadingStage || 'Opening document…';
          statusMessage.textContent = Number.isFinite(state.progress)
            ? `${stage} ${Math.max(0, Math.min(100, state.progress))}%`
            : stage;
        } else {
          statusMessage.textContent = state.error || (state.status === 'idle'
            ? 'Preparing the PDF reader…'
            : 'This document can’t be displayed.');
        }
        progressTrack.style.display = isLoading && Number.isFinite(state.progress) ? 'block' : 'none';
        progressFill.style.width = `${Math.max(0, Math.min(100, Number(state.progress) || 0))}%`;
        retryBtn.style.display = state.status === 'error' ? 'inline-flex' : 'none';
        // Match list panel.
        if (state.showMatchList && state.matches.length) {
          matchPanel.style.display = 'block';
          matchPanel.innerHTML = '';
          const head = document.createElement('div');
          head.style.cssText = 'font-weight:600; margin:4px 0 8px; color:var(--fb-text-primary,#dfe4ee);';
          head.textContent = `${state.matches.length} matches for \u201C${state.query}\u201D`;
          matchPanel.appendChild(head);
          state.matches.forEach((m, i) => {
            const row = document.createElement('div');
            row.className = 'fb-doc-match-row';
            row.style.cssText = `padding:6px 8px; margin-bottom:4px; border-radius:6px; cursor:pointer; background:${i === state.matchIndex ? 'rgba(109,93,242,0.35)' : 'rgba(255,255,255,0.04)'}; line-height:1.4;`;
            row.innerHTML = `<strong style="color:var(--fb-text-secondary,#9aa3b2);">p.${m.page}</strong> \u2014 ${String(m.snippet || '').slice(0, 90)}`;
            row.addEventListener('click', () => { this._activeDocViewer?.viewer.setPage(m.page); });
            matchPanel.appendChild(row);
          });
        } else {
          matchPanel.style.display = 'none';
        }
        renderSidebar();
      } catch { /* shim */ }
    };
    matchLabel.addEventListener('click', () => {
      state.showMatchList = !state.showMatchList && state.matches.length > 0;
      sync();
    });

    // Keyboard: page/zoom/rotate/night/fit + Ctrl+F focus search.
    wrap.addEventListener('keydown', (e) => {
      const active = this._activeDocViewer;
      if (!active || active.tabId !== tab.id) return;
      const action = active.viewer.handleKeydown(e);
      if (action === 'focus-search') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        searchInput.focus?.();
        searchInput.select?.();
      } else if (action) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
      }
    });

    sync();

    if (!doc) {
      state.status = 'error';
      state.error = 'This document is no longer available (it was closed or the app restarted). Open it again from the menu.';
      sync();
      return;
    }

    const sessions = this._documentViewerSessions || (this._documentViewerSessions = new Map());
    let session = sessions.get(tab.id);
    if (session && session.docId !== tab.docId) {
      session.disposed = true;
      try { session.viewer?.destroy(); } catch { /* already gone */ }
      sessions.delete(tab.id);
      session = null;
    }
    if (!session) {
      session = {
        tabId: tab.id,
        docId: tab.docId,
        state,
        host,
        sync,
        rerenderSidebar: renderSidebar,
        viewer: null,
        loadPromise: null,
        disposed: false
      };
      sessions.set(tab.id, session);
    } else {
      // BrowserShell reconstructs the viewport on ordinary renders. Move the
      // current canvas and replace the state callback; do not start a second
      // PDF.js worker/load for the same document.
      session.host = host;
      session.sync = sync;
      session.rerenderSidebar = renderSidebar;
      session.state = state;
      session.viewer?.attach(host, () => {
        if (!session.disposed) session.sync?.();
      });
    }
    this._activeDocViewer = session;
    sync();

    if (!doc) {
      state.status = 'error';
      state.error = 'This document is no longer available (it was closed or the app restarted). Open it again from the menu.';
      sync();
      return;
    }
    if (!session.viewer && !session.loadPromise) this._startDocumentViewerLoad(session, doc);
  }

  _startDocumentViewerLoad(session, doc) {
    if (!session || session.disposed || session.loadPromise) return session?.loadPromise || null;
    const isCurrent = () => !session.disposed
      && this._documentViewerSessions?.get(session.tabId) === session;
    Object.assign(session.state, {
      status: 'loading',
      progress: null,
      loadingStage: 'Preparing PDF reader…',
      error: null
    });
    session.sync?.();

    const loadPromise = (async () => {
      try {
        const engine = this._docEngineOverride || await this._pdfjsModule();
        if (!isCurrent()) return;
        const viewer = createPdfViewer({
          pdfjs: engine,
          container: session.host,
          state: session.state,
          onStateChange: () => { if (isCurrent()) session.sync?.(); }
        });
        session.viewer = viewer;
        if (this.state.activeTabId === session.tabId) this._activeDocViewer = session;
        await viewer.load(doc.bytes);
        if (!isCurrent()) {
          viewer.destroy();
          return;
        }
        session.sync?.();
        // The first page is the priority. Build the TOC after it is visible
        // so a complex outline can never hold the opening screen hostage.
        if (session.state.status === 'ready') {
          Promise.resolve(viewer.loadOutline())
            .then(() => { if (isCurrent()) session.sync?.(); })
            .catch(() => {});
        }
      } catch {
        if (!isCurrent()) return;
        Object.assign(session.state, {
          status: 'error',
          progress: null,
          loadingStage: '',
          error: 'Yayra could not start the PDF reader. Try again, or choose Desktop app to open this file instead.'
        });
        session.sync?.();
      }
    })();
    session.loadPromise = loadPromise;
    loadPromise.finally(() => {
      if (session.loadPromise === loadPromise) session.loadPromise = null;
    }).catch(() => {});
    return loadPromise;
  }

  retryDocumentViewer(tabId) {
    const session = this._documentViewerSessions?.get(tabId);
    const tab = this.state.tabs.find((item) => item.id === tabId);
    const doc = tab && this.documentStore?.get(tab.docId);
    if (!session || !tab || !doc || session.disposed || session.loadPromise) return false;
    try { session.viewer?.destroy(); } catch { /* retry owns a fresh controller */ }
    session.viewer = null;
    Object.assign(session.state, {
      status: 'loading',
      progress: null,
      loadingStage: 'Retrying PDF reader…',
      error: null
    });
    session.sync?.();
    this._startDocumentViewerLoad(session, doc);
    return true;
  }

  getTabFavicon(tab) {
    if (!tab) return Icons.globe;
    // Document tabs carry the document glyph, never a web favicon.
    if (tab.isDocument) return Icons.document;
    // "Time sign" while the page is loading: the tab's icon slot becomes
    // an animated hourglass the moment loading starts, and flips back to
    // the real favicon when the page is fully loaded. Updated in place by
    // refreshLoadingUi() - never via a flickery full re-render.
    if (tab.isLoading) return `<span class="fb-tab-loading-hourglass">${Icons.hourglass}</span>`;
    const url = tab.url || '';
    if (url.startsWith('yayra://settings')) return Icons.settings;
    if (url.startsWith('yayra://history')) return Icons.history;
    if (url.startsWith('yayra://bookmarks')) return Icons.bookmark;
    if (url.startsWith('yayra://downloads')) return Icons.download;
    if (url.startsWith('yayra://passwords')) return Icons.lock;
    if (url.startsWith('yayra://extensions')) return Icons.shield;
    if (url.startsWith('yayra://permissions')) return Icons.lock;
    if (url.startsWith('yayra://about')) return Icons.logoOrb;
    if (url.startsWith('yayra://newtab') || !url) return tab.isPrivate ? Icons.incognito : Icons.officialOrb;
    // Real site logo for actual web pages. IMPORTANT: the shell page's
    // CSP only allows chrome images from 'self', data:, and the icon
    // service host - a page-reported favicon URL (https://site/fav.ico)
    // would be BLOCKED and render as a broken-image glyph. So only
    // data:-inlined favicons are used directly; everything else resolves
    // through the allowed icon service by host. Inline onerror/onload
    // are also dead under the CSP (no 'unsafe-inline' scripts) - the
    // fallback is bound programmatically by bindTabLogoFallbacks().
    if (/^https?:\/\//i.test(url)) {
      let host = '';
      try { host = new URL(url).hostname; } catch { host = ''; }
      const reported = (typeof tab.favicon === 'string' && /^data:image\//i.test(tab.favicon)) ? tab.favicon : '';
      const src = reported || (host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : '');
      if (src) {
        const safeSrc = src.replace(/"/g, '&quot;');
        return `<span class="fb-tab-logo-stack"><span class="fb-tab-logo-fallback">${Icons.globe}</span>`
          + `<img class="fb-tab-site-logo" src="${safeSrc}" alt="" loading="lazy" /></span>`;
      }
    }
    return Icons.globe;
  }

  /**
   * CSP-safe logo fallback wiring: inline onerror/onload attributes are
   * blocked by the shell's script-src (no 'unsafe-inline'), so every
   * .fb-tab-site-logo image gets its listeners attached here instead -
   * logo loads -> hide the globe underneath; logo fails -> remove the
   * broken image so the globe stays. Idempotent; called after renders
   * and after surgical icon updates.
   */
  bindTabLogoFallbacks(scope = null) {
    const root = scope || this.lastRenderTarget || (typeof document !== 'undefined' ? document : null);
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const img of root.querySelectorAll('.fb-tab-site-logo')) {
      if (!img || img.dataset?.logoBound === 'true') continue;
      if (img.dataset) img.dataset.logoBound = 'true';
      if (typeof img.addEventListener !== 'function') continue;
      const hideFallback = () => {
        const stack = img.parentElement;
        const fallback = stack?.querySelector?.('.fb-tab-logo-fallback');
        if (fallback?.style) fallback.style.display = 'none';
      };
      img.addEventListener('load', hideFallback);
      img.addEventListener('error', () => { try { img.remove(); } catch { /* already gone */ } });
      // Cached images may already be settled before listeners attach.
      if (img.complete === true) {
        if (typeof img.naturalWidth === 'number' && img.naturalWidth === 0) {
          try { img.remove(); } catch { /* already gone */ }
        } else {
          hideFallback();
        }
      }
    }
  }

  handleViewportResize() {
    // The mini panel's layout is the user's CHOICE (Settings > Floating:
    // desktop or mobile view), never the window width - a narrow mini
    // window must keep the desktop chrome when the user picked it.
    if (this.options?.isMiniShell) {
      this.syncWebFrameLayer();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this.syncWebFrameLayer());
      }
      return;
    }
    const isMobile = this.checkMobileViewport();
    if (isMobile !== this.state.isMobile) {
      this.state.isMobile = isMobile;
      this.render();
    } else {
      // Window resized without a layout-mode change: the chrome DOM is
      // untouched but the viewport slot moved/resized, so re-align the
      // persistent web-frame layer to it.
      this.syncWebFrameLayer();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this.syncWebFrameLayer());
      }
    }
  }

  /**
   * PRODUCTION FREEZE SHIELD: a stray exception in any event handler must
   * never look like a dead app. Uncaught errors and rejected promises are
   * logged (rate-limited) and surfaced as a one-off notice - the UI loop
   * itself keeps running. Installed once in the constructor.
   */
  installGlobalErrorShield() {
    if (this._errorShieldInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._errorShieldInstalled = true;
    let lastNoticeAt = 0;
    const shield = (label) => (err) => {
      try { this.logger?.(`[shield] ${label}: ${err && (err.message || err)}`); } catch { /* logging must never throw */ }
      const now = Date.now();
      if (now - lastNoticeAt > 15000) {
        lastNoticeAt = now;
        try { this.showTransientNotice?.('Something hiccuped in the background - Yayra recovered and kept your session.'); } catch { /* notice is best-effort */ }
      }
    };
    this._errorShieldOnWindowError = shield('window error');
    this._errorShieldOnRejection = shield('unhandled rejection');
    try {
      window.addEventListener('error', this._errorShieldOnWindowError);
      window.addEventListener('unhandledrejection', this._errorShieldOnRejection);
    } catch { /* older shims */ }
  }

  /**
   * PRODUCTION RENDER COALESCING (anti-lag): bursts of state changes -
   * session restore, multi-tab navigation storms, update events - each
   * calling render() in the same frame caused back-to-back full DOM
   * rebuilds, the classic startup jank. requestRender() batches any number
   * of calls within one animation frame into a SINGLE render. Where
   * requestAnimationFrame doesn't exist (tests, minimal shims) it falls
   * back to a synchronous render, so behaviour is identical everywhere.
   */
  requestRender() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      this.render();
      return;
    }
    if (this._renderFramePending) return;
    this._renderFramePending = true;
    window.requestAnimationFrame(() => {
      this._renderFramePending = false;
      this.render();
    });
  }

  /**
   * FREEZE RECOVERY - the universal escape hatch: closes EVERY full-screen
   * overlay in one call, state chrome (drawer, modals, dropdowns, find
   * bar, radial, mini window) AND the body-appended dialogs (reader, task
   * manager, QR, passkey, update splash). Wired to Esc, so a stuck
   * overlay can never hold the UI hostage - there is always one key that
   * gives the page back. Returns true when it actually dismissed
   * something (so callers can decide about preventDefault/render).
   */
  dismissAllOverlays() {
    let dismissed = false;
    const s = this.state;
    if (s.isSideDrawerOpen) { s.isSideDrawerOpen = false; dismissed = true; }
    if (s.activeModal) { this.closeModal(); dismissed = true; }
    if (s.isSecurityDropdownOpen) { s.isSecurityDropdownOpen = false; dismissed = true; }
    if (s.isAccountMenuOpen) { s.isAccountMenuOpen = false; dismissed = true; }
    if (s.isDownloadsDropdownOpen) {
      s.isDownloadsDropdownOpen = false;
      s.isDownloadsDropdownExpanded = false;
      dismissed = true;
    }
    if (s.isRadialLauncherOpen) { try { this.closeRadialLauncher(); } catch { /* shim */ } dismissed = true; }
    if (s.findInPage && s.findInPage.isOpen) { s.findInPage.isOpen = false; dismissed = true; }
    if (s.isFloatingMiniOpen) { try { this.closeFloatingMini(); } catch { /* shim */ } dismissed = true; }
    if (typeof document !== 'undefined' && document.body) {
      const detach = (el, label) => {
        if (!el) return;
        try { el.remove(); } catch { /* already gone */ }
        dismissed = true;
        this.logger?.(`[overlays] Esc dismissed ${label}`);
      };
      // Tab-strip right-click menu + its scrim (state lives outside render()).
      detach(document.body.querySelector('.fb-tab-context-menu'), 'tab context menu');
      detach(document.body.querySelector('.fb-dropdown-scrim'), 'dropdown scrim');
      // Body-appended dialogs (each also has its own close button).
      detach(document.getElementById('yayra-reader-overlay'), 'reader');
      detach(document.getElementById('yayra-taskmgr-overlay'), 'task manager');
      detach(document.getElementById('yayra-url-qr-overlay'), 'QR dialog');
      const installDialog = document.getElementById('yayra-install-app-overlay');
      if (installDialog) {
        if (typeof installDialog._yayraFinish === 'function') installDialog._yayraFinish(null);
        else detach(installDialog, 'install app dialog');
        dismissed = true;
      }
      detach(document.body.querySelector('.fb-passkey-dialog-overlay'), 'passkey dialog');
      detach(document.querySelector('.fb-update-splash'), 'update splash');
    }
    // The omnibox / new-tab suggestion dropdowns also obscure the page
    // (they hide via [hidden], managed by bindSearchSuggestions) - one
    // Esc press closes them too.
    if (typeof document !== 'undefined' && document.body) {
      try {
        const lists = document.querySelectorAll('.fb-search-suggestions');
        for (const list of (lists || [])) {
          if (list && list.hidden !== true) { list.hidden = true; dismissed = true; }
        }
      } catch { /* best-effort */ }
    }
    if (dismissed || this.state.isPageObscured) {
      // Give the page surface back (desktop native view) and repaint once -
      // even when only the flag itself was stuck with nothing on screen.
      try { this.setPageObscured(false); } catch { /* no native view */ }
      this.render();
    }
    return dismissed;
  }

  handleGlobalKeyDown(e) {
    // Ctrl+T: New Tab
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      this.createNewTab();
    }
    // Ctrl+W: Close Tab
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      this.closeTab(this.state.activeTabId);
    }
    // Ctrl+Shift+T: Reopen Last Closed Tab
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      this.restoreLastClosedTab();
    }
    // Ctrl+Shift+N: New Incognito Tab
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      this.createNewTab(true);
    }
    // Ctrl+L or Alt+D: Focus Omnibox
    else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') || (e.altKey && e.key.toLowerCase() === 'd')) {
      e.preventDefault();
      this.omniboxInput?.focus();
      this.omniboxInput?.select();
    }
    // Ctrl+Shift+B: Toggle the bookmarks bar
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      this.state.settings = { ...this.state.settings, showBookmarksBar: !this.state.settings.showBookmarksBar };
      this.persistSettings();
      this.render();
    }
    // Ctrl+Shift+D: Bookmark all open tabs
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.bookmarkAllTabs();
    }
    // Ctrl+D: Bookmark Tab
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.toggleBookmarkCurrentTab();
    }
    // Ctrl+Shift+R / Ctrl+F5 / Shift+F5: hard reload - clears the
    // current site's cache, then reloads from the network (Chrome).
    else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r')
      || (e.key === 'F5' && (e.ctrlKey || e.metaKey || e.shiftKey))) {
      e.preventDefault();
      this.hardReload();
    }
    // Ctrl+R / F5: reload the current page (Chrome).
    else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') || e.key === 'F5') {
      e.preventDefault();
      this.reload();
    }
    // Ctrl+H: History
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      this.openInternalPage('yayra://history');
    }
    // Ctrl+J: Downloads
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      this.openInternalPage('yayra://downloads');
    }
    // Ctrl+F: Find in Page
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.state.findInPage.isOpen = true;
      this.render();
    }
    // Ctrl+N: New window - the independent floating mini window (the
    // web/PWA equivalent of a real new browser window).
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      this.openFloatingMini();
    }
    // Ctrl+Shift+G: open the tab-group picker for one-tap group switching.
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      this.openModal('tab-groups');
    }
    // Ctrl+Shift+A: Tab search (the tab switcher)
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.openModal('tab-switcher');
    }
    // Ctrl+Shift+Del: Clear browsing data
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Delete') {
      e.preventDefault();
      this.openModal('clear-data');
    }
    // Ctrl+Shift+O: Bookmark manager
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      this.openInternalPage('yayra://bookmarks');
    }
    // Ctrl+P: Print the active page
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      this.printActivePage();
    }
    // Ctrl+S: Save the active page
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.savePageAs();
    }
    // Ctrl+Shift+I / F12: Developer tools for the active tab
    else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i') || e.key === 'F12') {
      e.preventDefault();
      this.openDevToolsForActiveTab();
    }
    // Alt+Shift+I: Report an issue (matches the menu's advertised hint)
    else if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      this.navigateActiveTab('https://github.com/g2code33/yayra/issues');
    }
    // Esc: Close Overlays
    else if (e.key === 'Escape') {
      // FREEZE RECOVERY: one key gives the whole UI back - every state
      // overlay AND every body-appended dialog (see dismissAllOverlays).
      const dismissed = this.dismissAllOverlays();
      if (dismissed && typeof e.preventDefault === 'function') e.preventDefault();
    }
  }

  destroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.boundResizeHandler);
      window.removeEventListener('keydown', this.boundKeyHandler);
      // Production error shield (installed in the constructor).
      if (this._errorShieldOnWindowError) {
        try { window.removeEventListener('error', this._errorShieldOnWindowError); } catch { /* shim */ }
      }
      if (this._errorShieldOnRejection) {
        try { window.removeEventListener('unhandledrejection', this._errorShieldOnRejection); } catch { /* shim */ }
      }
    }
    this.stopBackgroundUpdateChecks();
    this.stopBackgroundRefresh();
    if (this._loadingWatchdogTimer && typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
      window.clearInterval(this._loadingWatchdogTimer);
      this._loadingWatchdogTimer = null;
    }
    if (this._sessionSnapshotTimer) {
      clearTimeout(this._sessionSnapshotTimer);
      this._sessionSnapshotTimer = null;
    }
    for (const session of this._documentViewerSessions?.values?.() || []) {
      session.disposed = true;
      try { session.viewer?.destroy(); } catch { /* already gone */ }
    }
    this._documentViewerSessions?.clear?.();
    this._activeDocViewer = null;
    // Android overlay-permission grant watcher (poll + listeners).
    if (this._stopOverlayGrantWatch) {
      try { this._stopOverlayGrantWatch(); } catch { /* already stopped */ }
      this._stopOverlayGrantWatch = null;
    }
    if (this.webFrameLayer) {
      this.webFrameLayer.remove();
      this.webFrameLayer = null;
      this.webFrames = new Map();
      this.activeWebFrameSlot = null;
      this.activeWebFrameTabId = null;
    }
    if (this._unsubscribeNativeWebview) {
      this._unsubscribeNativeWebview();
      this._unsubscribeNativeWebview = null;
    }
    if (this._unsubscribeAuthBridge) {
      this._unsubscribeAuthBridge();
      this._unsubscribeAuthBridge = null;
    }
    for (const tabId of Array.from(this._nativeWebviewTabIds || [])) {
      this.destroyNativeWebview(tabId);
    }
    for (const tabId of Array.from(this._androidTabWebIds || [])) {
      this.destroyAndroidTabWebview(tabId);
    }
    if (this._unsubscribeTabWebEvents) { this._unsubscribeTabWebEvents(); this._unsubscribeTabWebEvents = null; }
    if (this._unsubscribeAndroidBackButton) { this._unsubscribeAndroidBackButton(); this._unsubscribeAndroidBackButton = null; }
    if (this._unsubscribeOpenPdfFile) { try { this._unsubscribeOpenPdfFile(); } catch { /* gone */ } this._unsubscribeOpenPdfFile = null; }
    if (this._pdfDropHandlers && typeof document !== 'undefined') {
      document.removeEventListener?.('dragover', this._pdfDropHandlers.dragover);
      document.removeEventListener?.('drop', this._pdfDropHandlers.drop);
      this._pdfDropHandlers = null;
    }
    this._pdfDropArmed = false;
    if (this.bubbleOverlay) {
      this.bubbleOverlay.remove();
    }
    const persistentBubble = typeof document !== 'undefined' ? (document.getElementById('yayra-persistent-assistive-bubble') || document.getElementById('yayra-floating-bubble-persistent')) : null;
    if (persistentBubble) {
      persistentBubble.remove();
    }
  }
}
