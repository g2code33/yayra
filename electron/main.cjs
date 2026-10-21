const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell, safeStorage, Menu, clipboard, session, dialog, screen, Tray, nativeImage, systemPreferences, desktopCapturer, webContents, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { registerDesktopUpdateHandlers } = require('./desktopUpdater.cjs');
const { createWebviewBridge, buildContextMenuTemplate, buildBrowserUserAgent } = require('./webviewBridge.cjs');
const { parseAppModeUrl, buildInstallPlan, appWindowClass } = require('./appMode.cjs');
const { parsePdfFileArg } = require('./pdfLaunch.cjs');
const { extractManifestLink, extractIconLink, parseManifest, pickInstallIdentity, isPngBuffer, isIcoBuffer, pngToIco } = require('./pwaManifest.cjs');
const { startGlobalHotkeys } = require('./globalHotkeys.cjs');
const { createAuthBridge } = require('./authBridge.cjs');
const { createAuthStore } = require('./authStore.cjs');
const { signInWithGoogle } = require('./googleAuth.cjs');
const { resolveGoogleClientId, resolveGoogleClientSecret } = require('./googleAuthConfig.cjs');
const { APP_GOOGLE_AUTH_PARTITION, createGoogleAuthWindowManager } = require('./googleAuthWindow.cjs');
const { createDownloadsStore } = require('./downloadsStore.cjs');
const { createDownloadsBridge } = require('./downloadsBridge.cjs');
const { createDocumentLibrary } = require('./documentLibrary.cjs');
const { createPasskeyBridge } = require('./passkeyBridge.cjs');
const { configureWebsiteWebAuthn } = require('./websiteWebAuthn.cjs');
const { createWebsitePasskeyProvider } = require('./websitePasskeyProvider.cjs');
const { configureTrustedMediaPermissions } = require('./trustedMediaPermissions.cjs');
const { uploadGoogleLensImage, searchGoogleLensImageUrl, requestGoogleLensWithElectronNet } = require('./googleFeatures.cjs');
const { createPhoneApproval } = require('./phoneApproval.cjs');
const { createOverlayBridge } = require('./overlayWindow.cjs');
const { createOverlayStore } = require('./overlayStore.cjs');
const { createScreenRecorder } = require('./screenRecorder.cjs');
const { createTrayController } = require('./tray.cjs');
const { applyVaapiPolicy } = require('./vaapiProbe.cjs');
const { createWindowDragController } = require('./windowDrag.cjs');
const { popupMenuWithRecovery, closeNativeMenuForWindow } = require('./nativeMenuGuard.cjs');
const { buildMediaCompatibilityScript, installMediaCompatibility } = require('./mediaCompatibility.cjs');

const CUSTOM_SCHEME = 'yayra';
const CHROME_INPUT_RECOVERY_CHANNEL = 'yayra:chrome-input-recover';
// Keep local-document IPC bounded before any file is read into memory. This
// mirrors MAX_DOCUMENT_BYTES in the browser workspace (CommonJS cannot import
// that browser ESM module during Electron startup).
const MAX_DOCUMENT_BYTES = 300 * 1024 * 1024;
const DIST_DIR = path.join(__dirname, '..', 'dist');
let mainWindow;
let downloadsBridge = null;
// Trusted local-file catalog. It alone owns source paths; renderer code only
// ever receives opaque ids plus display metadata or bytes for one chosen id.
let documentLibrary = null;
// Extra per-profile shell windows (Chrome-style: one window per profile,
// the previous window stays). Tracked for cleanup only.
const profileWindows = new Set();
let overlayBridge = null;
let webviewBridge = null;
let googleAuthWindowManager = null;
let globalHotkeys = null;
let trayController = null;
let windowDragController = null;
let lastLoadError = null;

function ensureDocumentLibrary() {
  if (!documentLibrary) {
    documentLibrary = createDocumentLibrary({
      fs,
      path,
      crypto,
      shell,
      userDataDir: app.getPath('userData'),
      maxViewBytes: MAX_DOCUMENT_BYTES
    });
  }
  return documentLibrary;
}

// Boot launches (login items / XDG autostart) pass --yayra-autostart:
// start the floating bubble + system tray ONLY, without popping the main
// browser window over whatever the user is doing right after login.
const isAutostartLaunch = process.argv.includes('--yayra-autostart');

protocol.registerSchemesAsPrivileged([{ scheme: CUSTOM_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// Linux: the floating bubble DEPENDS on programmatic window positioning
// (drag) and always-on-top stacking - both of which native Wayland
// windows simply do not get (the compositor refuses external positioning
// and ignores the above hint). Running through XWayland (x11 backend)
// keeps every bubble behavior working on Wayland desktops too.
//
// CRITICAL: on a Wayland desktop the BROWSER process picks its ozone
// backend before this script runs, so appendSwitch('ozone-platform',
// 'x11') here reaches only the child processes - the browser keeps
// Wayland window handles while GPU/viz come up on x11. That mismatch is
// a GPU crash loop (exit_code=139) plus "XGetWindowAttributes failed
// for window 1/2", and NOTHING ever paints: the app looks like it is
// not opening at all. The only reliable way to force x11 is to have the
// switch on the real command line - so when we detect a Wayland session
// with XWayland available, we relaunch ourselves ONCE with it.
let relaunchingForX11 = false;
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  const display = typeof process.env.DISPLAY === 'string' ? process.env.DISPLAY.trim() : '';
  const waylandDisplay = typeof process.env.WAYLAND_DISPLAY === 'string' ? process.env.WAYLAND_DISPLAY.trim() : '';
  // An explicit --ozone-platform on the command line (the /usr/bin/yayra
  // wrapper's, ours after the relaunch, or the user's own choice) is
  // always respected - it is also what makes this a one-shot instead of
  // a relaunch loop.
  const argvHasOzonePlatform = process.argv.some((arg) => typeof arg === 'string' && arg.startsWith('--ozone-platform='))
    || app.commandLine.hasSwitch('ozone-platform');
  // Belt-and-suspenders loop breaker: 3+ relaunches inside 30s while
  // STILL not seeing the switch means something strips argv on this
  // setup - stay on the native backend rather than relaunch forever.
  // (Count-based so legitimate quick successions - autostart + updater
  // relaunch + manual launch - are never mistaken for a loop.)
  const relaunchStampPath = path.join(app.getPath('userData'), 'x11-relaunch-stamp');
  let relaunchBurst = 0;
  try {
    const stamp = JSON.parse(fs.readFileSync(relaunchStampPath, 'utf8'));
    if (Date.now() - stamp.t < 30000) relaunchBurst = stamp.n || 0;
  } catch { /* no stamp yet (or the old plain-timestamp format) */ }
  if (!argvHasOzonePlatform && relaunchBurst < 3 && waylandDisplay !== '' && display !== '') {
    relaunchingForX11 = true;
    const relaunchOpts = { args: process.argv.slice(1).concat(['--ozone-platform=x11']) };
    // AppImage: relaunch the AppImage itself, not the binary inside the
    // temporary mount (which disappears with this process).
    if (typeof process.env.APPIMAGE === 'string' && process.env.APPIMAGE.trim() !== '') {
      relaunchOpts.execPath = process.env.APPIMAGE;
    }
    console.log('[yayra] Wayland session with XWayland detected - relaunching once with --ozone-platform=x11 so the bubble can move and stay above every app');
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(relaunchStampPath, JSON.stringify({ t: Date.now(), n: relaunchBurst + 1 }));
    } catch { /* loop breaker unavailable - argv check still guards */ }
    // IMPORTANT: app.exit() BEFORE 'ready' can tear the process down
    // without ever spawning the relauncher (observed in the field: the
    // relaunch message printed, then nothing started). The documented
    // relaunch-then-exit pattern runs after 'ready', so wait for it -
    // the rest of startup is skipped via relaunchingForX11.
    app.whenReady().then(() => {
      app.relaunch(relaunchOpts);
      app.exit(0);
    }).catch((err) => reportStartupFailure('x11-relaunch', err));
  } else if (display === '') {
    console.warn('[yayra] no $DISPLAY - staying on the native backend; bubble drag/topmost may be limited on native Wayland');
  }
}

// A startup crash must NEVER be silent (a dead process with no window
// looks like "the app is not opening at all"). Surface it in a native
// error box when possible and always append it to a log file next to
// the user data, so there is something actionable to report.
//
// BOTH failure shapes are routed here: uncaughtException, and promise
// rejections - the app.whenReady() startup sequence is async, so a throw
// inside it (e.g. createWindow) surfaces as an unhandled rejection. That
// shape used to escape this logger entirely: the only trace was a
// UnhandledPromiseRejectionWarning on stderr and a silently running
// zombie with no window ("the app is crashing / not opening").
function reportStartupFailure(kind, err) {
  const detail = `[${new Date().toISOString()}] ${kind}\n${err && err.stack ? err.stack : String(err)}\n`;
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup-error.log'), detail);
  } catch { /* disk unavailable - still try to show the box */ }
  try { console.error(detail); } catch { /* stderr gone */ }
  try {
    console.error(`[yayra] startup failed (${kind}) - details appended to ${path.join(app.getPath('userData'), 'startup-error.log')}`);
  } catch { /* stderr gone */ }
  try {
    const { dialog } = require('electron');
    if (app.isReady()) dialog.showErrorBox('Yayra hit an unexpected error', String(err && err.stack ? err.stack : err));
  } catch { /* headless / too early */ }
}
process.on('uncaughtException', (err) => reportStartupFailure('uncaughtException', err));
process.on('unhandledRejection', (err) => reportStartupFailure('unhandledRejection', err));

// GPU self-heal: on some Linux driver/XWayland combos Chromium's GPU
// process segfault-loops ("GPU process exited unexpectedly:
// exit_code=139", vaInitialize failures) - windows get created but
// NOTHING ever paints, which looks exactly like "the app is not opening
// at all". When we see the GPU process crash repeatedly, we persist a
// flag and relaunch ourselves into software rendering, which always
// paints. Delete the flag file (or unset it in a future launch) to
// retry hardware acceleration after a driver upgrade.
const softwareRenderFlagPath = () => path.join(app.getPath('userData'), 'force-software-render');
let softwareRenderActive = false;
try {
  softwareRenderActive = process.env.YAYRA_SOFTWARE_RENDER === '1' || fs.existsSync(softwareRenderFlagPath());
} catch { /* fs unavailable - stay on the default path */ }
if (softwareRenderActive) {
  app.disableHardwareAcceleration();
  console.warn(`[yayra] software rendering active (the GPU process crashed on this machine before). Delete ${softwareRenderFlagPath()} to retry hardware acceleration.`);
}

// VA-API video decode: on Linux boxes with no VA driver installed (common
// on fresh Ubuntu), Chromium's GPU process probes VA-API at startup and
// logs "vaInitialize failed: unknown libva error" on every launch -
// harmless (software video decode) but reads like a crash. Skip the probe
// when there is no driver to use; see electron/vaapiProbe.cjs.
try {
  applyVaapiPolicy({ app, platform: process.platform, fsImpl: fs, logger: console });
} catch { /* probe is best-effort - never block startup over it */ }

let gpuCrashCount = 0;
app.on('child-process-gone', (_event, details) => {
  if (!details || details.type !== 'GPU') return;
  if (details.reason !== 'crashed' && details.reason !== 'abnormal-exit' && details.reason !== 'killed') return;
  gpuCrashCount += 1;
  console.error(`[yayra] GPU process ${details.reason} (#${gpuCrashCount}, exit code ${details.exitCode})`);
  if (gpuCrashCount < 2 || softwareRenderActive) return;
  softwareRenderActive = true; // never schedule the relaunch twice
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(softwareRenderFlagPath(), `GPU process crash-looped on ${new Date().toISOString()}; Yayra switched to software rendering. Delete this file to retry hardware acceleration.\n`);
  } catch { /* flag not persisted - this relaunch still fixes the session */ }
  console.error('[yayra] GPU is crash-looping - relaunching with software rendering so the app can actually paint');
  app.relaunch();
  app.exit(0);
});
if (process.env.YAYRA_SMOKE === '1' || process.env.IBROWSE_SMOKE === '1') {
  app.commandLine.appendSwitch('headless');
  app.disableHardwareAcceleration();
}

// One Yayra per desktop: a second launch (e.g. autostart at login racing a
// manual launch - the classic cause of TWO floating bubbles) just focuses
// the existing instance instead of spawning a duplicate app + duplicate
// bubble.
// (Skipped while relaunching for x11: this process is already exiting
// and must not grab the lock the relaunched instance needs.)
// The duplicate launch carries ITS display environment to the resident
// instance: a resident stranded on native Wayland (autostart can fire
// before $DISPLAY exists at login) uses it to HEAL itself - see the
// second-instance handler below.
const isPrimaryInstance = relaunchingForX11
  ? false
  : app.requestSingleInstanceLock({
    display: typeof process.env.DISPLAY === 'string' ? process.env.DISPLAY.trim() : '',
    wayland: typeof process.env.WAYLAND_DISPLAY === 'string' ? process.env.WAYLAND_DISPLAY.trim() : ''
  });
if (relaunchingForX11) {
  // app.exit() already scheduled - nothing else to set up.
} else if (!isPrimaryInstance) {
  // Exiting with NO output looks exactly like "the app is not opening
  // at all" when the primary instance is wedged - say so out loud.
  console.log('[yayra] another Yayra process already holds the single-instance lock - signaled it to come to the front and exiting this duplicate. If no window appeared, the resident process is stuck: run `pkill -9 -f yayra` and launch again.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDir, additionalData) => {
    // An installed site-app shortcut was launched while Yayra is already
    // running - computed FIRST so even the Wayland self-heal handover
    // below carries it through instead of swallowing the site.
    const appUrl = parseAppModeUrl(argv || []);
    // SELF-HEAL: if THIS resident instance is stuck on native Wayland
    // (bubble frozen, not on top - e.g. autostart ran before XWayland
    // exported $DISPLAY at login) and the user just launched Yayra from
    // an environment that HAS a display, hand the session over to a
    // fresh x11 instance instead of focusing the broken one. This makes
    // a launcher-icon click FIX a broken bubble instead of surfacing it.
    try {
      const selfForcedX11 = process.argv.some((a) => typeof a === 'string' && a.startsWith('--ozone-platform='))
        || app.commandLine.hasSwitch('ozone-platform');
      const selfOnWayland = process.platform === 'linux' && !selfForcedX11
        && (process.env.WAYLAND_DISPLAY || '').trim() !== '';
      const newDisplay = typeof additionalData?.display === 'string' ? additionalData.display.trim() : '';
      if (selfOnWayland && newDisplay !== '') {
        let launcher = '/usr/bin/yayra';
        try { if (!fs.existsSync(launcher)) launcher = process.execPath; } catch { launcher = process.execPath; }
        // The handover must carry the --app url of the shortcut that was
        // clicked - dropping it opened the full browser instead of the
        // installed site's own window (the "install as app is broken on
        // Ubuntu" bug: Ubuntu sessions are Wayland, and installed-site
        // .desktop entries launch /opt/yayra/yayra directly, so a
        // Wayland-stranded resident is a common state).
        const appArg = appUrl ? ` --app="${appUrl}"` : '';
        const handover = spawn('/bin/sh', ['-c', `sleep 1; exec "${launcher}" --ozone-platform=x11${appArg}`], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, DISPLAY: newDisplay }
        });
        handover.unref();
        console.log('[yayra] this resident instance is stuck on native wayland - handing over to a fresh x11 instance (bubble will work there)');
        app.exit(0);
        return;
      }
    } catch { /* healing is best-effort - normal focusing below */ }
    // A local document was opened WITH Yayra while it is already running:
    // hand its unchanged bytes to the matching in-shell viewer.
    const pdfFile = parsePdfFileArg(argv || []);
    if (pdfFile) {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      deliverPdfFile(pdfFile);
      return;
    }
    // An installed site-app shortcut was launched while Yayra is already
    // running: open THAT site's app window, not the browser.
    if (appUrl) { createAppModeWindow(appUrl); return; }
    if (overlayBridge) overlayBridge.restoreMainWindow();
    else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
}

// Launched via an installed "Install page as app..." shortcut
// (`yayra --app=<url>`)? Then this process opens ONLY the site's own
// minimal app window - exactly like chrome --app=<url>.
const appModeLaunchUrl = parseAppModeUrl(process.argv);
if (appModeLaunchUrl) {
  // The installed site's window must carry the SAME class its .desktop
  // entry declares as StartupWMClass (see appWindowClass), or GNOME/KDE
  // give it a generic dock icon and never group it under its launcher.
  // The --class switch only takes effect before the app is ready.
  try { app.commandLine.appendSwitch('class', appWindowClass(appModeLaunchUrl)); } catch { /* pre-ready only */ }
  // Windows taskbar grouping/pinning key for this site's app window.
  if (process.platform === 'win32') {
    try { app.setAppUserModelId(appWindowClass(appModeLaunchUrl)); } catch { /* best effort */ }
  }
}

/**
 * Chrome-style app window for an installed site: the page IS the window
 * (own taskbar presence, no tabs/omnibox). Popups/external links go to
 * the user's default browser, like Chrome app windows hand them off.
 */
const appModeWindows = new Map(); // normalized url -> open site-app window

function createAppModeWindow(url) {
  let normalized = url;
  try { normalized = new URL(url).toString(); } catch { /* keep raw */ }
  // Clicking the same installed app again must FOCUS its window, not
  // stack a duplicate per click (the classic "every launch opens another
  // window" complaint about site shortcuts).
  const existing = appModeWindows.get(normalized);
  if (existing && !existing.isDestroyed()) {
    try {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    } catch { /* race with close */ }
    return existing;
  }
  let hostname = 'app';
  try { hostname = new URL(url).hostname; } catch { /* keep default */ }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    autoHideMenuBar: true,
    backgroundColor: '#101218',
    title: hostname,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try {
    win.webContents.setUserAgent(buildBrowserUserAgent({ platform: process.platform, chromeVersion: process.versions.chrome }));
  } catch { /* default UA still works */ }
  installMediaCompatibility(win.webContents.session);
  win.webContents.on('dom-ready', () => {
    try { win.webContents.executeJavaScript(buildMediaCompatibilityScript(), true).catch(() => {}); }
    catch { /* closing or an older Electron surface */ }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try { if (/^https?:\/\//i.test(target)) shell.openExternal(target); } catch { /* best effort */ }
    return { action: 'deny' };
  });
  // Keep the window title honest: the site's own <title>.
  win.webContents.on('page-title-updated', (e, pageTitle) => {
    e.preventDefault();
    try { win.setTitle(pageTitle || hostname); } catch { /* closing */ }
  });
  win.loadURL(url);
  appModeWindows.set(normalized, win);
  win.on('closed', () => { appModeWindows.delete(normalized); });
  return win;
}

const pendingPdfFiles = []; // legacy name: local documents queued until the renderer listens

function deliverPdfFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    // Remember the explicit OS "Open with Yayra" action even when the file is
    // too large for the in-app 300 MB viewer. The hub can still reveal it or
    // hand the original path to its system application later.
    const libraryEntry = ensureDocumentLibrary().recordPathSync(filePath);
    if (stat.size > MAX_DOCUMENT_BYTES) return false;
    const data = fs.readFileSync(filePath);
    const payload = {
      name: path.basename(filePath),
      size: stat.size,
      data,
      libraryId: libraryEntry?.id || null
    };
    const rendererReady = mainWindow && !mainWindow.isDestroyed()
      && (typeof mainWindow.webContents.isLoadingMainFrame !== 'function' || !mainWindow.webContents.isLoadingMainFrame());
    if (rendererReady) {
      mainWindow.webContents.send('yayra:open-pdf-file', payload);
    } else {
      // A second-instance launch can create a window from the background
      // bubble/autostart state. Queue until did-finish-load, just like a cold
      // launch, so the preload listener cannot miss the file event.
      pendingPdfFiles.push(payload);
    }
    return true;
  } catch (err) {
    console.error('[yayra] document open-with delivery failed', err);
    return false;
  }
}

function flushPendingPdfFiles() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.webContents.isLoadingMainFrame === 'function' && mainWindow.webContents.isLoadingMainFrame()) return;
  while (pendingPdfFiles.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('yayra:open-pdf-file', pendingPdfFiles.shift());
  }
}

/**
 * TRUE PWA INSTALL - the site's own identity for "Install page as app":
 * reads the site's Web App Manifest (its OWN name, OWN icon, OWN
 * start_url) and downloads its own icon into userData/pwa-icons, so the
 * desktop entry is a PWA OF THAT SITE - exactly like Chrome's install -
 * not a shortcut stamped with Yayra's branding. Windows .lnk icons need
 * .ico, so a PNG icon is wrapped via pngToIco(); Linux .desktop entries
 * take the absolute PNG path. Non-PWA sites fall back honestly (page
 * title, the site's favicon.ico on Windows, the Yayra hicolor name on
 * Linux). Everything is strictly time-boxed and never throws - a slow
 * or missing manifest can only degrade the branding, never the install.
 */
async function resolvePwaInstallIdentity(url, pageTitle) {
  const fallback = { name: pageTitle || '', startUrl: url, iconFile: null, pwa: false };
  try {
    if (!url || !/^https?:\/\//i.test(String(url))) return fallback;
    const ua = buildBrowserUserAgent({ platform: process.platform, chromeVersion: process.versions.chrome });
    const fetchBoxed = async (target, ms) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const res = await net.fetch(target, { signal: controller.signal, headers: { 'User-Agent': ua, Accept: '*/*' }, redirect: 'follow' });
        return res && res.ok ? res : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // 1. The page's HTML -> its manifest link -> the manifest itself.
    let manifest = null;
    let manifestUrl = null;
    let html = '';
    const pageRes = await fetchBoxed(url, 6000);
    if (pageRes) {
      html = await pageRes.text().catch(() => '');
      manifestUrl = extractManifestLink(html, url);
      if (manifestUrl) {
        const manifestRes = await fetchBoxed(manifestUrl, 6000);
        if (manifestRes) manifest = parseManifest(await manifestRes.text().catch(() => ''));
      }
    }
    const identity = pickInstallIdentity({ manifest, manifestUrl, pageUrl: url, pageTitle });

    // 2. The site's OWN icon: the manifest icon, else the page's own
    // <link rel="icon"> / apple-touch-icon, else favicon.ico.
    let iconUrl = identity.iconSrc;
    if (!iconUrl && html) iconUrl = extractIconLink(html, url);
    if (!iconUrl) {
      try { iconUrl = new URL('/favicon.ico', url).toString(); } catch { iconUrl = null; }
    }
    let iconFile = null;
    if (iconUrl) {
      const iconRes = await fetchBoxed(iconUrl, 6000);
      if (iconRes) {
        const bytes = Buffer.from(await iconRes.arrayBuffer().catch(() => new ArrayBuffer(0)));
        if (bytes.length > 0 && bytes.length <= 3 * 1024 * 1024) {
          const dir = path.join(app.getPath('userData'), 'pwa-icons');
          fs.mkdirSync(dir, { recursive: true });
          const slug = crypto.createHash('sha1').update(identity.startUrl).digest('hex').slice(0, 16);
          if (isPngBuffer(bytes)) {
            const pngPath = path.join(dir, `${slug}.png`);
            fs.writeFileSync(pngPath, bytes);
            if (process.platform === 'win32') {
              const icoPath = path.join(dir, `${slug}.ico`);
              fs.writeFileSync(icoPath, pngToIco(bytes));
              iconFile = icoPath;
            } else {
              iconFile = pngPath; // Linux .desktop: absolute PNG path
            }
          } else if (isIcoBuffer(bytes) && process.platform === 'win32') {
            const icoPath = path.join(dir, `${slug}.ico`);
            fs.writeFileSync(icoPath, bytes);
            iconFile = icoPath;
          } // Linux can't use .ico in Icon= - the hicolor fallback stays
        }
      }
    }
    return { name: identity.name, startUrl: identity.startUrl, iconFile, pwa: identity.pwa };
  } catch (err) {
    console.warn('[yayra] pwa identity lookup fell back to plain install', err && err.message);
    return fallback;
  }
}

app.whenReady().then(async () => {
  // Exiting to come back on the x11 backend: build nothing in this
  // doomed process - the relaunch handler registered above takes over.
  if (relaunchingForX11) return;
  if (!isPrimaryInstance) return;

  // Website WebAuthn is Chromium-owned and separate from Yayra's internal
  // vault-unlock key. Roaming security keys are available without setup;
  // on macOS, enable Touch ID only when the exact access group is present in
  // the signed app entitlements (the helper refuses invented/default groups).
  configureWebsiteWebAuthn({ app });

  // The internal voice-search surface may request AUDIO only. Keep arbitrary
  // website origins denied and preserve the app-generated recorder window;
  // macOS still owns and displays its OS-level microphone consent prompt.
  configureTrustedMediaPermissions({
    defaultSession: session.defaultSession,
    systemPreferences,
    recorderPreloadPath: path.join(__dirname, 'recorderPreload.cjs'),
    platform: process.platform,
    dialog,
    getWindowForWebContents: (wc) => BrowserWindow.fromWebContents(wc),
    logger: console
  });

  // One glance at the terminal must answer "which backend is this
  // instance on?" - it decides whether the bubble can move and overlay.
  if (process.platform === 'linux') {
    const forcedX11 = app.commandLine.hasSwitch('ozone-platform')
      || process.argv.some((arg) => typeof arg === 'string' && arg.startsWith('--ozone-platform='));
    if (forcedX11) {
      console.log('[yayra] windowing backend: x11 (forced) - bubble drag + overlay-above-all-apps fully supported');
    } else if ((process.env.WAYLAND_DISPLAY || '').trim() !== '') {
      console.warn('[yayra] windowing backend: native wayland - the compositor will BLOCK bubble dragging and always-on-top. Launch via /usr/bin/yayra or with --ozone-platform=x11.');
    } else {
      console.log('[yayra] windowing backend: x11 (native session)');
    }
  }

  // Remove the File/Edit/View/Window menu block entirely (Windows/Linux -
  // it rendered as a second header row under the title bar). Keyboard
  // shortcuts are unaffected: Yayra binds its own in the renderer
  // (BrowserShell.handleGlobalKeyDown). On macOS the application menu
  // lives in the system menu bar, not in the window, and removing it
  // would break Cmd+C/V/Q - so it is kept there.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  protocol.handle(CUSTOM_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = safeAssetPath(url.pathname);
    if (!pathname) return new Response('not found', { status: 404 });
    const file = path.join(DIST_DIR, pathname);
    if (!file.startsWith(DIST_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('not found', { status: 404 });
    const type = mimeType(file);
    if (/\.m?js$/.test(file) && !/javascript/.test(type)) return new Response('refused wrong MIME type', { status: 415 });

    // Do not leave module MIME types up to the host OS's file association
    // database. In particular, Linux installations can return .mjs files as
    // application/octet-stream through net.fetch(file://…), and Chromium's
    // strict module loader then rejects the lazily imported PDF.js engine.
    // Preserve net.fetch's streaming body/status while making every bundled
    // asset's Content-Type deterministic under yayra:// (including the
    // module worker used by PDF.js).
    const assetResponse = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(assetResponse.headers);
    headers.set('content-type', type);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(assetResponse.body, {
      // net.fetch(file:) normally reports 200; guard the Fetch API's
      // internal status 0 as Response() only accepts 200–599.
      status: assetResponse.status >= 200 && assetResponse.status <= 599 ? assetResponse.status : 200,
      statusText: assetResponse.status >= 200 ? assetResponse.statusText : '',
      headers
    });
  });

  // ALL IPC surfaces are registered exactly once here (never inside
  // createWindow()): the main window can now be closed and recreated from
  // the floating bubble, and re-running ipcMain.handle() for an existing
  // channel throws.
  registerIpcBridges();
  const isSmokeStartup = process.env.YAYRA_SMOKE === '1' || process.env.IBROWSE_SMOKE === '1';
  // Launched from an installed site-app shortcut: only the site's own
  // app window opens - no browser window, like chrome --app=<url>.
  // Launched via desktop "Open with > yayra" on a local document (Linux may
  // pass a file:// URI while Windows passes a path): queue it until the shell
  // has loaded, then route it by sniffed bytes in the renderer.
  const coldPdfFile = parsePdfFileArg(process.argv);
  if (coldPdfFile && !isSmokeStartup) deliverPdfFile(coldPdfFile);

  if (appModeLaunchUrl && !isSmokeStartup) {
    createAppModeWindow(appModeLaunchUrl);
  } else if (!isAutostartLaunch || isSmokeStartup) {
    // Boot launch: bubble + tray only. Manual launch: full browser window.
    createWindow();
  }

  // The floating overlay bubble is intentionally started independently of
  // createWindow()/the main browser window - see electron/overlayWindow.cjs
  // for exactly what "system-wide overlay" does and does not mean here.
  // Skipped under the automated smoke/CI harness (no real display,
  // hardware acceleration disabled) where a transparent always-on-top
  // window serves no purpose and isn't exercised by any assertion.
  const isSmokeRun = process.env.YAYRA_SMOKE === '1' || process.env.IBROWSE_SMOKE === '1';
  if (!isSmokeRun) {
    const overlayStore = createOverlayStore({ fs, userDataDir: app.getPath('userData') });
    const downloadsDirResolver = () => {
      try { return app.getPath('downloads'); } catch { return app.getPath('userData'); }
    };
    // System-wide screen recorder behind the bubble's right-click menu:
    // always captures PC system sound (OS loopback), mic optional.
    const screenRecorder = createScreenRecorder({
      BrowserWindow,
      ipcMain,
      screen,
      path,
      desktopCapturerImpl: desktopCapturer,
      fsImpl: fs,
      shellImpl: shell,
      preloadPath: path.join(__dirname, 'recorderPreload.cjs'),
      saveDir: downloadsDirResolver
    });
    overlayBridge = createOverlayBridge({
      BrowserWindow,
      app,
      ipcMain,
      screen,
      path,
      preloadPath: path.join(__dirname, 'overlayPreload.cjs'),
      // Full-API preload for the floating "yayra mini" browser window the
      // bubble expands into on single click.
      mainPreloadPath: path.join(__dirname, 'preload.cjs'),
      Menu,
      fsImpl: fs,
      homeDir: app.getPath('home'),
      overlayStore,
      getMainWindow: () => mainWindow,
      // The bubble outlives the main window; clicking "Open full browser"
      // after the main window was closed recreates it from scratch.
      createMainWindow: () => createWindow(),
      // Bubble shows ONLY the Yayra logo (inlined as a data URL).
      logoPath: resolveBubbleLogoPath(),
      // Real "Capture screenshot" support for the radial / right-click
      // menus: full-resolution primary-display PNG into ~/Downloads.
      desktopCapturerImpl: desktopCapturer,
      shellImpl: shell,
      screenshotDir: downloadsDirResolver,
      screenRecorder
    });
    overlayBridge.initializeOnStartup();

    // System tray: the bubble overlays every app on the PC, so it is also
    // visible and regulated from the OS notification area (enable/disable
    // bubble, overlay-above-all-apps, start-at-login, open mini/full, quit).
    trayController = createTrayController({
      Tray,
      Menu,
      nativeImage,
      app,
      iconPath: resolveTrayIconPath(),
      overlayStore,
      overlayBridge,
      getMainWindow: () => mainWindow,
      createMainWindow: () => createWindow()
    });
    trayController.init();
  }

  // Safety net: a boot launch must NEVER run invisibly. If the user had
  // disabled the bubble AND the platform has no tray, show the browser.
  if (isAutostartLaunch && !isSmokeRun) {
    const bubbleVisible = overlayBridge && overlayBridge.getOverlayWindow && overlayBridge.getOverlayWindow();
    const trayVisible = trayController && trayController.getTray && trayController.getTray();
    if (!bubbleVisible && !trayVisible) createWindow();
  }

  // System-wide CapsLock chords (real low-level keyboard hook - see
  // electron/globalHotkeys.cjs for why globalShortcut can't do this):
  //   CapsLock+Y        -> open/restore the main Yayra window
  //   CapsLock+Shift+R  -> open yayra mini (the bubble's floating panel)
  if (!isSmokeRun && !appModeLaunchUrl) {
    globalHotkeys = startGlobalHotkeys({
      onOpenMain: () => {
        if (overlayBridge) overlayBridge.restoreMainWindow();
        else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        else createWindow();
      },
      onOpenMini: () => {
        if (overlayBridge && typeof overlayBridge.toggleMiniPanel === 'function') overlayBridge.toggleMiniPanel();
      },
      // Esc+F1: hide (or bring back) an EXISTING yayra mini - the only
      // keyboard escape hatch, since mini deliberately overlays all apps
      // until the user hides it.
      onToggleMiniHide: () => {
        const mini = overlayBridge?.getMiniWindow?.();
        if (mini && !mini.isDestroyed?.() && typeof overlayBridge.toggleMiniPanel === 'function') {
          overlayBridge.toggleMiniPanel();
        }
      },
      logger: console
    });
  }

  // Ctrl+Alt+Y: open/focus the main Yayra window from ANYWHERE on the
  // PC. A standard OS accelerator (works on Windows/macOS/Linux-X11,
  // unlike the CapsLock chords which need the low-level hook).
  if (!isSmokeRun && !appModeLaunchUrl) {
    try {
      globalShortcut.register('CommandOrControl+Alt+Y', () => {
        try {
          if (overlayBridge) overlayBridge.restoreMainWindow();
          else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
          else createWindow();
        } catch { /* window raced destruction */ }
      });
    } catch (err) {
      console.warn(`[yayra] could not register Ctrl+Alt+Y global shortcut: ${err?.message || err}`);
    }
  }
}).catch((err) => reportStartupFailure('startup-sequence', err));

app.on('will-quit', () => {
  try { googleAuthWindowManager?.closeAll(); } catch { /* exiting */ }
  googleAuthWindowManager = null;
  try { globalHotkeys?.detach(); } catch { /* exiting */ }
  try { windowDragController?.destroy(); } catch { /* exiting */ }
  windowDragController = null;
  try { globalShortcut.unregisterAll(); } catch { /* exiting */ }
});

function resolveBubbleLogoPath() {
  const candidates = [
    path.join(DIST_DIR, 'assets', 'brand', 'logomain1-transparent.png'),
    path.join(__dirname, '..', 'assets', 'brand', 'logomain1-transparent.png'),
    path.join(DIST_DIR, 'icons', 'icon-192.png')
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

function resolveTrayIconPath() {
  const candidates = [
    path.join(DIST_DIR, 'icons', 'icon-192.png'),
    path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'),
    path.join(__dirname, '..', 'build', 'icons', 'hicolor', '32x32', 'apps', 'yayra.png')
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

// The floating bubble + mini window keep Yayra alive in the background by
// design (they are real windows, so 'window-all-closed' only fires once
// they are gone too - e.g. after "Hide bubble" or "Quit Yayra").
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function registerIpcBridges() {
  registerDesktopUpdateHandlers({ getWindow: () => mainWindow });

  ensureDocumentLibrary();

  // Keep every pixel of the custom top chrome renderer-interactive. Native
  // CSS drag regions can hold a compositor input grab (most visibly on
  // Linux), leaving tabs and caption buttons looking frozen. The dedicated
  // dotted handle now streams pointer coordinates through this coalesced
  // manual drag controller instead.
  if (!windowDragController) {
    windowDragController = createWindowDragController({ ipcMain, BrowserWindow });
  }

  // Window controls for the frameless main window (the OS title bar and
  // menu block are gone - see createWindow()). Resolved per-sender so the
  // same channels work for any shell window that renders the controls.
  const senderWindow = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  };
  ipcMain.handle('yayra:window-minimize', (event) => {
    senderWindow(event)?.minimize();
  });
  ipcMain.handle('yayra:window-maximize-toggle', (event) => {
    const win = senderWindow(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('yayra:window-is-maximized', (event) => Boolean(senderWindow(event)?.isMaximized()));
  ipcMain.handle('yayra:window-close', (event) => {
    senderWindow(event)?.close();
  });
  // Menu > Exit is app-wide. The window close button intentionally closes
  // only its BrowserWindow so the optional floating bubble can stay alive.
  ipcMain.handle('yayra:app-quit', (event) => {
    if (!senderWindow(event)) return false;
    app.quit();
    return true;
  });

  // Electron renderer fetches are CORS-constrained. Send the user-selected
  // file (or its public URL) from the trusted main process straight to
  // Google's official Lens endpoints and return only a completed result URL.
  // No Yayra backend/storage sees the image. Empty Google upload-picker
  // redirects are rejected so the renderer can retain the selection + retry.
  ipcMain.handle('yayra:google-lens-upload', async (event, payload = {}) => {
    if (!senderWindow(event)) return { ok: false, reason: 'untrusted-sender' };
    const tabId = String(payload.tabId || '');
    if (payload.isPrivate && !/^[a-zA-Z0-9_-]{1,120}$/.test(tabId)) {
      return { ok: false, reason: 'invalid-private-tab' };
    }
    const profileId = String(payload.profileId || 'default');
    const partition = payload.isPrivate
      ? `incognito-${tabId}`
      : profileId === 'default'
        ? 'persist:yayra-webview'
        : `persist:yayra-profile-${profileId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    // Use the same Chromium Session as the destination tab. Google cookies
    // set while accepting the image are therefore present when the returned
    // result URL is opened; main-process defaultSession cookies are not.
    const tabSession = session.fromPartition(partition);
    const common = {
      // ClientRequest exposes Google's exact redirect destination. Electron
      // documents net.fetch Response.url as incorrect, so it cannot reliably
      // identify the completed Lens result after following that redirect.
      requestTransport: (url, options) => requestGoogleLensWithElectronNet({
        createRequest: (requestOptions) => net.request({ ...requestOptions, session: tabSession }),
        url,
        options
      }),
      language: payload.language,
      startedAt: payload.startedAt,
      viewportWidth: payload.viewportWidth,
      viewportHeight: payload.viewportHeight,
      userAgent: buildBrowserUserAgent()
    };
    if (payload.imageUrl) {
      return searchGoogleLensImageUrl({ ...common, imageUrl: payload.imageUrl });
    }
    return uploadGoogleLensImage({
      ...common,
      data: payload.data,
      name: payload.name,
      type: payload.type,
      width: payload.width,
      height: payload.height
    });
  });

  // Menu > More tools > Performance / Task manager: REAL process metrics
  // (no invented numbers). Summarized here so the renderer gets plain data.
  ipcMain.handle('yayra:app-metrics', () => {
    try {
      const metrics = app.getAppMetrics() || [];
      return {
        ok: true,
        sampledAt: Date.now(),
        processes: metrics.map((m) => ({
          type: m.type || 'unknown',
          label: m.name || m.serviceName || m.type || 'process',
          pid: m.pid ?? null,
          cpu: m.cpu && Number.isFinite(m.cpu.percentCPUUsage) ? m.cpu.percentCPUUsage : null,
          // Electron reports workingSetSize in bytes. Convert it to MiB;
          // the renderer labels the same binary unit explicitly.
          memoryMiB: m.memory && Number.isFinite(m.memory.workingSetSize)
            ? Math.round((m.memory.workingSetSize / (1024 * 1024)) * 10) / 10
            : null
        }))
      };
    } catch (err) {
      console.error('[yayra] app metrics failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  // Settings/menu > Clear browsing data: REALLY clears Chromium's disk
  // caches (and optionally cookies/site data) across every session Yayra
  // uses - the default session, the default profile partition, and every
  // live profile/incognito partition. Returns the real byte count freed.
  ipcMain.handle('yayra:clear-browsing-data', async (_event, { cache = true, cookies = false } = {}) => {
    try {
      const sessions = new Set([
        session.defaultSession,
        session.fromPartition('persist:yayra-webview'),
        session.fromPartition(APP_GOOGLE_AUTH_PARTITION)
      ]);
      for (const wc of (typeof webContents.getAllWebContents === 'function' ? webContents.getAllWebContents() : [])) {
        try { if (wc.session) sessions.add(wc.session); } catch { /* destroyed */ }
      }
      let clearedBytes = 0;
      for (const ses of sessions) {
        if (!ses) continue;
        try {
          if (cache) {
            if (typeof ses.getCacheSize === 'function') {
              try { clearedBytes += await ses.getCacheSize(); } catch { /* size is best-effort */ }
            }
            if (typeof ses.clearCache === 'function') await ses.clearCache();
            if (typeof ses.clearCodeCaches === 'function') await ses.clearCodeCaches({});
            if (typeof ses.clearStorageData === 'function') {
              await ses.clearStorageData({ storages: ['cachestorage', 'shadercache'] });
            }
          }
          if (cookies && typeof ses.clearStorageData === 'function') {
            await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'websql'] });
          }
        } catch (err) {
          console.error('[yayra] clear-browsing-data failed for a session', err);
        }
      }
      return { ok: true, clearedBytes, sessions: sessions.size };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
  });

  // Menu > Save and share > Install page as app...: Chrome-style site
  // installation. Writes a REAL launcher entry (desktop + applications
  // menu on Linux, desktop + Start Menu .lnk on Windows) that reopens
  // the site in its own minimal app window via `yayra --app=<url>` -
  // see createAppModeWindow() + electron/appMode.cjs.
  // Preview of the site's own PWA identity (name/start url/pwa flag) for
  // the renderer's editable install dialog - nothing is written.
  ipcMain.handle('yayra:install-page-as-app-preview', async (_event, { url, title } = {}) => {
    try {
      const identity = await resolvePwaInstallIdentity(url, title);
      return { ok: true, name: identity.name, startUrl: identity.startUrl, pwa: identity.pwa };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('yayra:install-page-as-app', async (_event, { url, title, nameOverride } = {}) => {
    try {
      // SHORTCUT TARGET FIX: inside a running AppImage, process.execPath
      // is the TEMPORARY squashfs mount (/tmp/.mount_yayraXXX/yayra)
      // which stops existing the moment the app closes - every shortcut
      // written that way was dead on next launch. Point at the .AppImage
      // FILE itself (it is executable and accepts the same args).
      let execPath = process.execPath;
      if (typeof process.env.APPIMAGE === 'string' && process.env.APPIMAGE.trim() !== '' && fs.existsSync(process.env.APPIMAGE)) {
        execPath = process.env.APPIMAGE;
      }
      // TRUE PWA INSTALL: the desktop entry carries the SITE'S OWN name,
      // OWN icon and OWN start url from its Web App Manifest (see
      // resolvePwaInstallIdentity + electron/pwaManifest.cjs). When the
      // site has no icon to give, Windows .lnk icons inherit the exe's
      // own embedded icon and Linux .desktop entries fall back to the
      // hicolor name 'yayra' (installed by the .deb, registered by
      // AppImage desktop integration).
      const identity = await resolvePwaInstallIdentity(url, title);
      // The user may EDIT the install name in the renderer dialog - an
      // explicit non-empty override always wins over the manifest name.
      const installName = (typeof nameOverride === 'string' && nameOverride.trim() !== '')
        ? nameOverride.trim().slice(0, 60)
        : identity.name;
      const iconPath = identity.iconFile || (process.platform === 'linux' ? 'yayra' : null);
      const plan = buildInstallPlan({
        platform: process.platform,
        execPath,
        url: identity.startUrl,
        title: installName,
        desktopDir: app.getPath('desktop'),
        applicationsDir: process.platform === 'linux'
          ? path.join(os.homedir(), '.local', 'share', 'applications')
          : null,
        startMenuDir: process.platform === 'win32'
          ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
          : null,
        iconPath
      });
      if (!plan.ok) return plan;
      let primaryPath = null;
      for (const artifact of plan.artifacts) {
        try {
          fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
          if (artifact.kind === 'shortcut') {
            if (typeof shell.writeShortcutLink !== 'function' || !shell.writeShortcutLink(artifact.path, artifact.options)) {
              continue;
            }
          } else {
            fs.writeFileSync(artifact.path, artifact.contents, 'utf8');
            if (artifact.executable) { try { fs.chmodSync(artifact.path, 0o755); } catch { /* best effort */ } }
          }
          if (!primaryPath) primaryPath = artifact.path;
        } catch (err) {
          console.error('[yayra] install-as-app artifact failed', artifact.path, err);
        }
      }
      if (!primaryPath) return { ok: false, reason: 'write-failed' };
      // Ubuntu/GNOME keeps self-written .desktop launchers UNTRUSTED
      // until gvfs marks them so - without this, the first double-click
      // of the freshly installed site icon shows "Untrusted application
      // launcher" (or nothing at all on stricter setups) and the install
      // looks broken. Best-effort: gio lives on every GNOME/KDE box, and
      // the executable bit above already covers the rest.
      if (process.platform === 'linux') {
        for (const artifact of plan.artifacts) {
          try {
            const gio = spawn('gio', ['set', artifact.path, 'metadata::trusted', 'true'], { detached: true, stdio: 'ignore' });
            gio.unref();
          } catch { /* best effort */ }
        }
      }
      return { ok: true, name: plan.name, path: primaryPath, inLauncher: plan.inLauncher, pwa: identity.pwa, edited: installName !== identity.name };
    } catch (err) {
      console.error('[yayra] install page as app failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  // LOCAL DOCUMENT WORKSPACE: every explicitly selected file is recorded in
  // the trusted main-process catalog. Viewable formats transfer capped bytes
  // to the bundled renderer; every other type is handed, unchanged, to the
  // operating system. Source paths never cross IPC.
  ipcMain.handle('yayra:doc-open', async () => {
    try {
      const picked = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'All files', extensions: ['*'] },
          { name: 'Documents and presentations', extensions: ['pdf', 'pptx', 'pptm', 'ppt', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'csv'] },
          { name: 'Images and text', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg', 'txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml'] }
        ]
      });
      if (picked.canceled || !picked.filePaths || picked.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const filePath = picked.filePaths[0];
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
      const entry = await documentLibrary.recordPath(filePath);
      if (!documentLibrary.canOpenInYayra(filePath)) {
        const error = await shell.openPath(filePath);
        return error
          ? { ok: false, reason: String(error), libraryId: entry.id, entry }
          : { ok: true, action: 'system', libraryId: entry.id, entry };
      }
      if (stat.size > MAX_DOCUMENT_BYTES) {
        return { ok: false, reason: 'file-too-large', libraryId: entry.id, entry };
      }
      const data = await fs.promises.readFile(filePath);
      return {
        ok: true,
        action: 'yayra',
        name: path.basename(filePath),
        size: stat.size,
        data,
        libraryId: entry.id,
        entry
      };
    } catch (err) {
      console.error('[yayra] doc-open failed', err);
      return { ok: false, reason: err && err.code === 'EACCES' ? 'permission-denied' : 'read-failed' };
    }
  });

  // Opaque-id document hub operations. The library resolves ids to paths in
  // this trusted process and re-checks existence/permissions on every action.
  ipcMain.handle('yayra:doc-library-list', async () => {
    try { return { ok: true, entries: await documentLibrary.list() }; }
    catch (err) {
      console.error('[yayra] document library list failed', err);
      return { ok: false, reason: 'read-failed', entries: [] };
    }
  });
  ipcMain.handle('yayra:doc-library-open', async (_event, { id, external = false } = {}) => {
    try { return await documentLibrary.open(id, { external: Boolean(external) }); }
    catch (err) {
      console.error('[yayra] document library open failed', err);
      return { ok: false, reason: 'open-failed' };
    }
  });
  ipcMain.handle('yayra:doc-library-show', async (_event, { id } = {}) => {
    try { return await documentLibrary.showInFolder(id); }
    catch { return { ok: false, reason: 'show-failed' }; }
  });
  ipcMain.handle('yayra:doc-library-locate', async (_event, { id } = {}) => {
    try {
      const picked = await dialog.showOpenDialog({
        title: 'Locate moved document',
        properties: ['openFile'],
        filters: [{ name: 'All files', extensions: ['*'] }]
      });
      if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
      return await documentLibrary.relink(id, picked.filePaths[0]);
    } catch { return { ok: false, reason: 'locate-failed' }; }
  });
  ipcMain.handle('yayra:doc-library-remove', (_event, { id } = {}) => documentLibrary.remove(id));
  ipcMain.handle('yayra:doc-library-clear', () => documentLibrary.clear());
  ipcMain.handle('yayra:doc-library-clear-missing', () => documentLibrary.clearMissing());
  ipcMain.handle('yayra:doc-library-prune', (_event, { olderThanDays } = {}) => documentLibrary.prune({ olderThanDays }));

  // DOCUMENT WORKSPACE: "Open with desktop app" / "Open original" escape
  // hatch. The unchanged bytes come FROM the renderer; a sanitized temporary
  // file is written and opened with the OS handler for its real extension.
  // Nothing else on disk is touched.
  ipcMain.handle('yayra:doc-open-externally', async (_event, { name, data, libraryId } = {}) => {
    try {
      // Prefer the original source file when this tab came from the trusted
      // catalog. This preserves its real location/name and avoids a temp copy.
      if (libraryId) return await documentLibrary.open(libraryId, { external: true });
      if (!data) return { ok: false, reason: 'no-data' };
      const safeName = String(name || 'document.bin').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'document.bin';
      const dir = path.join(app.getPath('temp'), 'yayra-docs');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${Date.now().toString(36)}-${safeName}`);
      const bytes = data.byteLength !== undefined ? Buffer.from(data) : Buffer.from(new Uint8Array(0));
      if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'bad-size' };
      fs.writeFileSync(filePath, bytes);
      const result = await shell.openPath(filePath);
      if (result !== '') return { ok: false, reason: String(result) };
      return { ok: true };
    } catch (err) {
      console.error('[yayra] doc-open-externally failed', err);
      return { ok: false, reason: 'failed' };
    }
  });

  // Menu > Save and share > Create desktop shortcut...: a REAL shortcut file on
  // the user's desktop that opens the page in the default browser
  // (.desktop on Linux, .url on Windows, .webloc on macOS).
  ipcMain.handle('yayra:create-shortcut', (_event, { url, title } = {}) => {
    try {
      if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, reason: 'invalid-url' };
      const desktopDir = app.getPath('desktop');
      const safeName = String(title || url).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'yayra-page';
      let filePath;
      let contents;
      if (process.platform === 'win32') {
        filePath = path.join(desktopDir, `${safeName}.url`);
        contents = `[InternetShortcut]\r\nURL=${url}\r\n`;
      } else if (process.platform === 'darwin') {
        filePath = path.join(desktopDir, `${safeName}.webloc`);
        contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${String(url).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></dict></plist>\n`;
      } else {
        filePath = path.join(desktopDir, `${safeName}.desktop`);
        contents = `[Desktop Entry]\nType=Link\nName=${safeName}\nURL=${url}\nIcon=text-html\n`;
      }
      fs.writeFileSync(filePath, contents, 'utf8');
      if (process.platform === 'linux') {
        try { fs.chmodSync(filePath, 0o755); } catch { /* best effort */ }
      }
      return { ok: true, path: filePath };
    } catch (err) {
      console.error('[yayra] create shortcut failed', err);
      return { ok: false, reason: err && err.code === 'EACCES' ? 'permission-denied' : 'failed' };
    }
  });

  // Device passkey for the desktop shell. Besides guarding the Yayra vault,
  // a successful PIN/Touch ID/system-lock verification can mint a one-shot,
  // main-process-only grant for one exact website WebAuthn request. The grant
  // authorizes use of (but never replaces) that RP-scoped website credential.
  const devicePasskeyBridge = createPasskeyBridge({
    ipcMain,
    fs,
    path,
    userDataDir: app.getPath('userData'),
    safeStorageImpl: safeStorage,
    systemPreferencesImpl: systemPreferences,
    phoneApproval: createPhoneApproval({
      httpImpl: http,
      osImpl: os,
      randomBytesImpl: (n) => crypto.randomBytes(n)
    })
  });

  // Linux has no Chromium platform-passkey UI in Electron: website
  // navigator.credentials.create/get calls otherwise wait silently. Supply a
  // profile-scoped CTAP2 authenticator only when private credentials can be
  // strongly encrypted. Each release still requires a verified Yayra grant
  // above, or the PolicyKit fallback when the user explicitly chooses it.
  const websitePasskeyProvider = createWebsitePasskeyProvider({
    fsImpl: fs,
    pathImpl: path,
    userDataDir: app.getPath('userData'),
    safeStorageImpl: safeStorage,
    platform: process.platform,
    logger: console
  });

  // Full top-level Google auth windows. RX Store's working desktop flow
  // demonstrates the important distinction: the provider owns an entire
  // BrowserWindow, not an embedded page surface. Yayra additionally shares
  // the originating tab Session and resumes that tab after the callback, so
  // the redirect and resulting login state never disappear into Chrome.
  googleAuthWindowManager = createGoogleAuthWindowManager({
    BrowserWindow,
    getMainWindow: () => mainWindow,
    buildUserAgent: () => buildBrowserUserAgent({ platform: process.platform, chromeVersion: process.versions.chrome }),
    iconPath: resolveTrayIconPath(),
    logger: console
  });

  // Native website-rendering engine bridge (replaces <iframe>-based rendering
  // so real sites with X-Frame-Options/frame-ancestors - Google, GitHub,
  // etc. - actually load). See electron/webviewBridge.cjs for the full
  // architecture rationale. Views attach to whichever shell window asked
  // for them (main window or the floating mini window).
  webviewBridge = createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell,
    openGoogleAuthWindow: (options) => googleAuthWindowManager.openWebsiteAuth(options),
    closeGoogleAuthWindow: (key, options) => googleAuthWindowManager.close(key, options),
    Menu,
    clipboard,
    dialog,
    getMainWindow: () => mainWindow,
    getWindowForWebContents: (wc) => BrowserWindow.fromWebContents(wc),
    // Chrome-style password capture/fill inside real pages (sandboxed
    // preload, nothing exposed to the page) - see autofillPreload.cjs.
    autofillPreloadPath: path.join(__dirname, 'autofillPreload.cjs'),
    websitePasskeyProvider,
    consumeWebsitePasskeyGrant: devicePasskeyBridge.consumeWebsiteGrant
  });

  // "Sign in with Google" for Yayra's own app-level identity. See
  // electron/googleAuth.cjs + electron/authBridge.cjs for the full
  // architecture rationale (RFC 8252 loopback + PKCE in a full Yayra window).
  const authStore = createAuthStore({
    fs,
    safeStorageImpl: safeStorage,
    userDataDir: app.getPath('userData')
  });
  createAuthBridge({
    ipcMain,
    shell,
    getMainWindow: () => mainWindow,
    authStore,
    clientId: resolveGoogleClientId(),
    clientSecret: resolveGoogleClientSecret(),
    // Use Electron's own net.fetch (Chromium's network stack) instead of
    // Node's global fetch for the Google token/userinfo requests. The
    // system browser (Chromium) and Node's undici-based fetch do NOT share
    // a network stack - on machines with a corporate proxy, VPN, or a
    // TLS-inspecting antivirus whose root cert is trusted by the OS/Chromium
    // but not by Node's own CA store, Node's fetch fails outright with a
    // generic "fetch failed" even though the browser-driven consent step
    // worked fine. net.fetch is proxy- and OS-cert-aware the same way the
    // browser is, so it succeeds in those environments too.
    fetchImpl: typeof net.fetch === 'function' ? net.fetch : undefined,
    signInImpl: signInWithGoogle,
    googleAuthWindow: googleAuthWindowManager
  });

  // Real file-download tracking (replaces the old hardcoded fake "Downloads"
  // row entirely - see electron/downloadsBridge.cjs). Tracks downloads that
  // happen in the shared "persist:yayra-webview" session that regular
  // (non-private) tabs use, plus Yayra's own windows, and lets the user pick
  // where new downloads are saved.
  // Legacy channel name retained: it now transfers any supported downloaded
  // document to the unified viewer, still as capped bytes with no path.
  ipcMain.handle('yayra:downloads-open-pdf', async (_event, { id } = {}) => {
    try {
      const item = (downloadsStore.load().items || []).find((it) => it.id === id);
      if (!item || !item.path) return { ok: false, reason: 'not-found' };
      const stat = await fs.promises.stat(item.path);
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
      const entry = await documentLibrary.recordPath(item.path);
      if (stat.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'file-too-large', libraryId: entry.id, entry };
      const data = await fs.promises.readFile(item.path);
      return { ok: true, name: path.basename(item.path), size: stat.size, data, libraryId: entry.id, entry };
    } catch (err) {
      console.error('[yayra] downloads-open-pdf failed', err);
      return { ok: false, reason: 'read-failed' };
    }
  });

  const downloadsStore = createDownloadsStore({
    fs,
    userDataDir: app.getPath('userData'),
    defaultDownloadsDir: app.getPath('downloads')
  });
  downloadsBridge = createDownloadsBridge({
    ipcMain,
    shell,
    dialog,
    path,
    fs,
    sessions: [session.fromPartition('persist:yayra-webview'), session.defaultSession],
    downloadsStore,
    getMainWindow: () => mainWindow
  });


  // Chrome-style profiles: "Add profile" / switching opens a NEW Yayra
  // window for that profile while the current window stays on its own.
  // Each profile window boots with ?profile=<id> so the renderer binds to
  // the right identity, and its web-content partition joins download
  // tracking the moment the window exists.
  ipcMain.handle('yayra:open-profile-window', (_event, { profileId } = {}) => {
    const id = String(profileId || 'default');
    try {
      if (id !== 'default') {
        const partition = `persist:yayra-profile-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        downloadsBridge?.attachSession?.(session.fromPartition(partition));
      }
      const win = createProfileWindow(id);
      return { ok: Boolean(win) };
    } catch (err) {
      console.error(`[yayra] failed to open profile window: ${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('yayra:get-launch-info', () => ({
    version: app.getVersion(),
    updateState: 'diagnostics-ready',
    flags: process.argv.filter((arg) => arg.startsWith('--')),
    lastLoadError
  }));
  ipcMain.handle('ibrowse:get-launch-info', () => ({
    version: app.getVersion(),
    updateState: 'diagnostics-ready',
    flags: process.argv.filter((arg) => arg.startsWith('--')),
    lastLoadError
  }));
}

/**
 * Website pages live in separate WebContentsViews. A stalled shell renderer
 * therefore freezes only tabs/address/caption controls while the page below
 * can keep moving - the exact split-freeze this guard repairs. It applies to
 * both the primary shell and every independent profile window.
 */
function installShellFreezeRecovery(win, label = 'shell') {
  const contents = win.webContents;
  let crashWindowStarted = 0;
  let crashReloads = 0;
  let unresponsiveTimer = null;
  let recoveryWindowStarted = 0;
  let recoveryReloads = 0;
  const clearUnresponsiveTimer = () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  };
  const signalChromeInputRecovery = (reason, { closeMenu = false } = {}) => {
    try { windowDragController?.cancelForWebContents?.(contents); } catch { /* no active drag */ }
    if (closeMenu) {
      try { closeNativeMenuForWindow(win, reason); } catch { /* no native popup */ }
    }
    try {
      if (!contents.isDestroyed?.()) contents.send(CHROME_INPUT_RECOVERY_CHANNEL, { reason });
    } catch { /* renderer/window raced shutdown */ }
  };
  const onWindowFocus = () => {
    // A radial overlay is a separate transparent always-on-top window. If it
    // was left expanded over Yayra, focusing the browser deterministically
    // shrinks it before it can intercept the custom title/tab row.
    try { overlayBridge?.closeRadialMenu?.(); } catch { /* overlay absent */ }
    signalChromeInputRecovery('window-focus', { closeMenu: true });
  };
  const onWindowBlur = () => signalChromeInputRecovery('window-blur', { closeMenu: true });
  const onWindowHide = () => signalChromeInputRecovery('window-hide', { closeMenu: true });
  const onWindowMinimize = () => signalChromeInputRecovery('window-minimize', { closeMenu: true });
  win.on?.('focus', onWindowFocus);
  win.on?.('blur', onWindowBlur);
  win.on?.('hide', onWindowHide);
  win.on?.('minimize', onWindowMinimize);
  const onRenderGone = (_event, details) => {
    const reason = details && details.reason;
    signalChromeInputRecovery(`renderer-${reason || 'gone'}`, { closeMenu: true });
    if (reason !== 'crashed' && reason !== 'oom' && reason !== 'killed') return;
    const now = Date.now();
    if (now - crashWindowStarted > 60000) {
      crashWindowStarted = now;
      crashReloads = 0;
    }
    crashReloads += 1;
    console.error(`[yayra] ${label} renderer gone (${reason}) - reload #${crashReloads}`);
    if (crashReloads > 5) {
      console.error(`[yayra] ${label} renderer is crash-looping - not reloading again automatically`);
      return;
    }
    try { if (!win.isDestroyed()) win.webContents.reload(); } catch { /* already closing */ }
  };
  const onUnresponsive = () => {
    signalChromeInputRecovery('renderer-unresponsive', { closeMenu: true });
    console.warn(`[yayra] ${label} renderer reported unresponsive; recovery grace period started`);
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (win.isDestroyed() || win.webContents.isDestroyed?.()) return;
      const now = Date.now();
      if (now - recoveryWindowStarted > 60000) {
        recoveryWindowStarted = now;
        recoveryReloads = 0;
      }
      recoveryReloads += 1;
      if (recoveryReloads > 3) {
        console.error(`[yayra] ${label} renderer remains unresponsive but recovery is rate-limited`);
        return;
      }
      console.error(`[yayra] ${label} renderer stayed unresponsive; reloading chrome (${recoveryReloads}/3)`);
      try { win.webContents.reload(); } catch { /* window raced shutdown */ }
    }, 6000);
    unresponsiveTimer?.unref?.();
  };
  const onResponsive = () => {
    clearUnresponsiveTimer();
    console.log(`[yayra] ${label} renderer responsive again`);
  };
  contents.on('render-process-gone', onRenderGone);
  contents.on('unresponsive', onUnresponsive);
  contents.on('responsive', onResponsive);
  return () => {
    clearUnresponsiveTimer();
    try { closeNativeMenuForWindow(win, 'shell-recovery-destroy'); } catch { /* none */ }
    try { win.removeListener?.('focus', onWindowFocus); } catch { /* destroyed */ }
    try { win.removeListener?.('blur', onWindowBlur); } catch { /* destroyed */ }
    try { win.removeListener?.('hide', onWindowHide); } catch { /* destroyed */ }
    try { win.removeListener?.('minimize', onWindowMinimize); } catch { /* destroyed */ }
    try { contents.removeListener?.('render-process-gone', onRenderGone); } catch { /* destroyed */ }
    try { contents.removeListener?.('unresponsive', onUnresponsive); } catch { /* destroyed */ }
    try { contents.removeListener?.('responsive', onResponsive); } catch { /* destroyed */ }
  };
}

/**
 * A SECOND, independent shell window bound to a specific browser profile
 * (Chrome's "open this profile in its own window" model). The existing
 * window keeps its profile and tabs; this one boots with ?profile=<id>
 * so the renderer binds to the requested identity and its tabs get that
 * profile's own session partition (see electron/webviewBridge.cjs).
 */
function createProfileWindow(profileId) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    backgroundColor: '#101218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // This renderer owns only browser chrome. Never freeze its timers/rAF
      // while a native page surface remains active in a separate renderer.
      backgroundThrottling: false
    }
  });
  profileWindows.add(win);
  const clearShellRecovery = installShellFreezeRecovery(win, 'profile shell');
  win.webContents.on('context-menu', (_event, params) => {
    if (win.isDestroyed()) return;
    const template = buildContextMenuTemplate({ params, wc: win.webContents, tabId: null, send: () => {}, clipboard });
    popupMenuWithRecovery({ menu: Menu.buildFromTemplate(template), window: win });
  });
  const winContents = win.webContents;
  win.on('closed', () => {
    clearShellRecovery();
    if (webviewBridge) webviewBridge.destroyForWebContents(winContents);
    profileWindows.delete(win);
  });
  win.loadURL(`${CUSTOM_SCHEME}://app/index.html?profile=${encodeURIComponent(profileId)}`);
  return win;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // No OS title bar ("yayra" text) and no File/Edit/View/Window menu
    // block: Yayra draws its OWN top chrome, with a renderer-owned manual
    // drag handle and real minimize/maximize/close buttons via the
    // windowControls IPC bridge (see registerIpcBridges + BrowserShell).
    // No part of the tab strip enters a native input-grab region. On macOS
    // the native traffic lights are kept, inset.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    // Dark surface behind EVERYTHING. Electron's default window background
    // is white, and every time the native page view hides/moves (menu
    // drawer, dropdowns, modals, tab switches) the compositor exposes the
    // window background for a frame or two - which users saw as a blank
    // WHITE flash before the menu appeared. Matching the app's dark theme
    // makes those frames invisible.
    backgroundColor: '#101218',
    show: process.env.YAYRA_SMOKE !== '1' && process.env.IBROWSE_SMOKE !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Native pages run in their own WebContentsViews; the shell renderer
      // is the tabs/address/window-control UI and must never be timer-frozen
      // while those pages continue painting underneath it.
      backgroundThrottling: false
    }
  });

  const win = mainWindow;

  // PDFs queued before the window existed (OS "Open With" at cold start)
  // are delivered the moment the shell renderer finished loading - the
  // preload's listener is attached before any page script runs.
  win.webContents.on('did-finish-load', () => flushPendingPdfFiles());

  // Chrome-equivalent native right-click menu for Yayra's OWN chrome (the
  // omnibox, side drawer, settings forms, etc.) - this is a different
  // webContents than the per-tab WebContentsViews (those get their
  // own context menu wired in electron/webviewBridge.cjs), so without this
  // right-clicking the address bar or any text field in Yayra's own UI
  // would show no menu at all.
  win.webContents.on('context-menu', (_event, params) => {
    if (win.isDestroyed()) return;
    const template = buildContextMenuTemplate({
      params,
      wc: win.webContents,
      tabId: null,
      send: () => {},
      clipboard
    });
    popupMenuWithRecovery({ menu: Menu.buildFromTemplate(template), window: win });
  });

  // PRODUCTION FREEZE GUARDS: a crash or genuinely stuck chrome renderer
  // must not leave a dead title/tab strip over still-live website content.
  const clearShellRecovery = installShellFreezeRecovery(win, 'main shell');

  // Closing the main window only tears down ITS tab views; the floating
  // bubble/mini window (and their views) stay alive independently. The
  // webContents reference is captured now because the BrowserWindow proxy
  // refuses property access after destruction.
  const winContents = win.webContents;
  win.on('closed', () => {
    clearShellRecovery();
    if (webviewBridge) webviewBridge.destroyForWebContents(winContents);
    if (mainWindow === win) mainWindow = null;
  });

  winContents.on('did-fail-load', (_event, code, description, url) => {
    lastLoadError = { code, description, url };
    console.error(`[yayra] renderer load failed; retrying file fallback code=${code} url=${url}`);
    if (!winContents.isDestroyed()) win.loadFile(path.join(DIST_DIR, 'index.html'));
  });
  const isBadLoad = process.env.YAYRA_FORCE_BAD_LOAD === '1' || process.env.IBROWSE_FORCE_BAD_LOAD === '1';
  const loadTarget = isBadLoad ? `${CUSTOM_SCHEME}://app/does-not-exist.html` : `${CUSTOM_SCHEME}://app/index.html`;
  win.loadURL(loadTarget);
  if (process.env.YAYRA_SMOKE === '1' || process.env.IBROWSE_SMOKE === '1') {
    winContents.once('did-finish-load', async () => {
      // Exercise the lazy PDF.js ESM + module worker through the exact
      // yayra:// protocol used by installed apps. A DOM-only smoke could
      // pass while .mjs was served as octet-stream and every PDF failed.
      const result = await winContents.executeJavaScript(`(async () => {
        const output = {
          title: document.title,
          hasRoot: Boolean(document.getElementById('app')),
          headerControl: Boolean(document.getElementById('update-button') || document.getElementById('top-header')),
          hasPdfEngine: false,
          pdfPages: 0,
          pdfError: null
        };
        // The second smoke launch deliberately forces a bad shell URL and
        // only verifies file:// recovery. Parse the PDF once, on the normal
        // yayra:// launch, so fallback behavior cannot mask module health.
        if (${isBadLoad ? 'false' : 'true'}) {
          try {
            const engine = await window.__yayraShell?._pdfjsModule?.();
            output.hasPdfEngine = typeof engine?.getDocument === 'function';
            if (output.hasPdfEngine) {
              const encoded = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDUgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiAzMCA3MCBUZCAoWWF5cmEgUERGIHNtb2tlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA2CiUlRU9GCg==';
              const raw = atob(encoded);
              const data = Uint8Array.from(raw, (char) => char.charCodeAt(0));
              const task = engine.getDocument({ data });
              const pdf = await task.promise;
              output.pdfPages = pdf?.numPages || 0;
              await pdf?.destroy?.();
            }
          } catch (error) {
            output.pdfError = String(error?.message || error);
          }
        }
        return output;
      })()`);
      const smokeResult = {
        ...result,
        fallbackUsed: Boolean(lastLoadError),
        loadError: lastLoadError
      };
      writeSmokeReport(smokeResult);
      console.log(`[yayra-smoke] ${JSON.stringify(smokeResult)}`);
      app.quit();
    });
    setTimeout(() => {
      const timeoutResult = {
        timeout: true,
        fallbackUsed: Boolean(lastLoadError),
        loadError: lastLoadError
      };
      writeSmokeReport(timeoutResult);
      console.error('[yayra-smoke] timeout waiting for renderer paint');
      app.exit(1);
    }, 15000).unref();
  }
  return mainWindow;
}

/**
 * GUI-subsystem Windows executables are not guaranteed to expose stdout to
 * their parent. Write an explicit machine-readable result as well as logging
 * it so the packaged smoke gate measures the renderer/PDF result, not console
 * plumbing.
 */
function writeSmokeReport(payload) {
  const reportPath = String(process.env.YAYRA_SMOKE_REPORT || '').trim();
  if (!reportPath) return;
  try {
    fs.writeFileSync(reportPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error(`[yayra-smoke] could not write report: ${error?.message || error}`);
  }
}

function safeAssetPath(rawPath) {
  let decoded = rawPath || '/';
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  decoded = decoded.replace(/\\/g, '/');
  if (decoded.includes('..')) return null;
  if (decoded === '/' || decoded === '') return 'index.html';
  return decoded.replace(/^\/+/, '');
}

function mimeType(file) {
  const lower = String(file || '').toLowerCase();
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json') || lower.endsWith('.map')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.pfb')) return 'application/x-font-type1';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}
