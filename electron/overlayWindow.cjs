'use strict';

const { popupMenuWithRecovery } = require('./nativeMenuGuard.cjs');

/**
 * Yayra's system-wide floating overlay bubble (desktop).
 *
 * This is the real, Apple-AssistiveTouch-style always-on-top circle the
 * product spec asks for: a SEPARATE native OS window (not a <div> inside
 * the main browser window), so it keeps floating above every other
 * application on the desktop even while the main Yayra window is closed,
 * minimized, or was never opened this session at all.
 *
 * What this honestly achieves, using only public Electron/OS APIs:
 *   - `alwaysOnTop: 'screen-saver'` is the highest window level Electron
 *     exposes; combined with `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
 *     it sits above ordinary windows AND other virtual desktops/Spaces and
 *     fullscreen apps on macOS. This is the same technique sticky-note /
 *     chat-head style always-on-top utilities use; it is not a kernel-level
 *     overlay, so a handful of other apps that also request top-level OS
 *     overlay status (e.g. the Windows Task Manager, or another
 *     screen-saver-level app) can still end up above it - there is no
 *     public desktop API that guarantees literally first in the Z-order
 *     over everything, including other overlay apps.
 *   - `app.setLoginItemSettings({ openAtLogin: true })` registers Yayra to
 *     launch at OS login (Windows/macOS). On Linux this depends on desktop
 *     environment autostart support, which Electron proxies through the
 *     same API where available.
 *   - It is created directly in `app.whenReady()`, independent of whether
 *     `createWindow()` (the full browser) ever runs - so it genuinely does
 *     not require opening the Yayra app, and shows up the moment Electron
 *     itself starts (including right after a fresh install's first launch,
 *     and after every subsequent reboot once login-item autostart is on).
 *
 * Siblings on other platforms:
 *   - Android: the true system-wide "draw over other apps" overlay (the
 *     same category as Facebook Messenger's chat heads) IS implemented -
 *     `SYSTEM_ALERT_WINDOW` permission + foreground Service + WindowManager
 *     TYPE_APPLICATION_OVERLAY views in packages/floating-android/src/kotlin,
 *     bridged to the web shell by YayraOverlayPlugin.kt and installed into
 *     the generated android/ project by scripts/ensure-capacitor-platform.mjs.
 *
 * What this CANNOT honestly do, and why (do not ask for this to be faked):
 *   - iOS: Apple does not expose ANY API, public or private-but-App-Store-safe,
 *     that lets a third-party app draw above other apps or the home screen -
 *     AssistiveTouch is a first-party OS accessibility feature, not a
 *     capability any app can opt into. This is a platform policy wall, not
 *     a missing feature - the same category of hard limit documented for
 *     Google's embedded-webview sign-in block in docs/GOOGLE_SIGNIN.md.
 *
 * Fully dependency-injected so the pure parts (settings defaults, enable/
 * disable bookkeeping) are unit-testable without a real Electron runtime -
 * see tests/overlay-window.test.mjs.
 */

// Square size (px) the bubble window expands to while the radial menu of
// circular action buttons is open (double-tap the bubble to toggle it).
const RADIAL_SIZE = 340;

function createOverlayBridge({
  BrowserWindow,
  app,
  ipcMain,
  screen,
  path,
  preloadPath,
  overlayStore,
  getMainWindow,
  // --- all optional (keeps older tests/callers working unchanged) ---
  // Preload for the floating mini-browser window (the full window.yayra API,
  // NOT the tiny overlay preload) - when absent, the mini window feature is
  // disabled and bubble clicks fall back to restoring the main window.
  mainPreloadPath = null,
  // URL the mini window loads (the dist shell in compact mini mode).
  miniUrl = 'yayra://app/index.html?shell=mini&profile=default',
  // Electron Menu class for the bubble's right-click menu.
  Menu = null,
  // Recreates the main browser window after it was closed - this is what
  // makes the bubble genuinely independent of the main window's lifetime.
  createMainWindow = null,
  // Linux autostart fallback dependencies (fs + home dir), injectable for
  // tests. app.setLoginItemSettings historically only covers Win/macOS, so
  // on Linux we also write a freedesktop autostart .desktop entry.
  fsImpl = null,
  homeDir = null,
  platform = process.platform,
  // Absolute path to the Yayra brand logo (transparent PNG). Inlined as a
  // data URL into the bubble HTML so the bubble is ONLY the logo - no
  // circular backdrop around it.
  logoPath = null,
  // Real screenshot capture for the radial/right-click "Capture screenshot"
  // action: Electron's desktopCapturer + shell (reveal in file manager) +
  // a directory resolver (usually app.getPath('downloads')). All optional -
  // when absent the action reports itself unavailable instead of faking.
  desktopCapturerImpl = null,
  shellImpl = null,
  screenshotDir = null,
  // Screen recorder bridge (electron/screenRecorder.cjs) powering the
  // right-click "Screen recording" entries: PC system sound is ALWAYS
  // captured (where the OS provides loopback); the microphone is the
  // user's include/mute choice.
  screenRecorder = null,
  logger = console
}) {
  let overlayWin = null;
  let miniWin = null;
  let cachedLogoDataUrl;
  // Heartbeats that keep the bubble/mini windows genuinely above every
  // other application - see assertTopmost() for why this is needed.
  let overlayTopmostTimer = null;
  let miniTopmostTimer = null;
  // Manual drag state (the bubble has NO native drag region - drag regions
  // swallow left-button events, which broke clicking entirely). The window
  // follows pointermove screen coordinates STREAMED from the renderer; the
  // main process never polls the cursor (see beginBubbleDrag for why).
  let dragActive = false;
  let dragOffset = { x: 0, y: 0 };
  // Cursor-poll drag ASSIST (see beginBubbleDrag): delta-based, only takes
  // over when the renderer's pointermove stream goes quiet mid-drag.
  let dragAssistTimer = null;
  let dragStartCursor = null;
  let dragStartWinPos = null;
  let lastRendererDragAt = 0;
  let lastDragTopmostAt = 0;
  // AssistiveTouch-style radial menu state: double-tap expands the bubble
  // window into a ring of circular action buttons (Yayra AI, mini, full
  // browser, lock, hide, quit) and remembers the bounds to shrink back to.
  let radialOpen = false;
  let radialRestoreBounds = null;

  /**
   * Force a window back to the top of the OS z-order.
   *
   * `alwaysOnTop: 'screen-saver'` is set at creation, but on real desktops
   * it is NOT a one-shot guarantee: Windows silently strips/undercuts the
   * topmost flag in several situations (fullscreen/exclusive apps, UAC
   * desktop switches, explorer restarts, other topmost apps calling
   * SetWindowPos above us), and some Linux WMs drop the hint on workspace
   * or compositor changes. The user-visible symptom is exactly "the bubble
   * only floats over the desktop, not over the apps I open". So the
   * topmost claim is re-asserted (a) whenever the OS reports it changed,
   * and (b) on a cheap heartbeat - the same strategy chat-head/overlay
   * utilities use. Re-asserting when already topmost is a no-op for the OS,
   * so the heartbeat causes no flicker.
   */
  /** Both overlay surfaces (bubble + mini panel) on screen at once? */
  function bothOverlaySurfacesVisible() {
    try {
      const bubbleVisible = Boolean(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible?.());
      const miniVisible = Boolean(miniWin && !miniWin.isDestroyed() && miniWin.isVisible?.());
      return bubbleVisible && miniVisible;
    } catch {
      return false;
    }
  }

  function assertTopmost(win) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      // WINDOWS FIX - never assert a HIDDEN window: Chromium's
      // always-on-top path on Windows issues SetWindowPos with
      // SWP_SHOWWINDOW, which RE-SHOWS the window. The mini panel's
      // heartbeat/blur guards kept resurrecting it right after hide(),
      // which is why the titlebar X, "open full browser" and the
      // bubble's single-click hide all looked dead on Windows PCs
      // (the panel hid for a frame and instantly came back).
      if (typeof win.isVisible === 'function' && !win.isVisible()) return;
      // WINDOWS FIX - no sibling z-fights: while BOTH the bubble and
      // the mini panel are on screen, their two out-of-phase heartbeats
      // re-inserted each window above the other every tick, visibly
      // BLINKING the pair. If the topmost flag is already in place
      // there is nothing to repair - skip the reorder entirely.
      if (bothOverlaySurfacesVisible() && typeof win.isAlwaysOnTop === 'function' && win.isAlwaysOnTop()) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      if (typeof win.moveTop === 'function') win.moveTop();
      if (typeof win.setVisibleOnAllWorkspaces === 'function') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      }
    } catch {
      // Window raced destruction between the check and the call.
    }
  }

  function startTopmostGuard(win, { onEvent = true } = {}) {
    if (!win) return null;
    if (onEvent && typeof win.on === 'function') {
      // Fired when anything (OS or another app) toggles our topmost state.
      win.on('always-on-top-changed', (_e, isOnTop) => {
        if (!isOnTop) assertTopmost(win);
      });
      win.on('show', () => assertTopmost(win));
      // The instant the user clicks INTO another app is exactly when the
      // WM is most likely to promote that app over us - reassert on the
      // spot instead of waiting for the heartbeat.
      win.on('blur', () => assertTopmost(win));
    }
    if (typeof setInterval !== 'function') return null;
    // 800ms heartbeat: newly-opened/focused apps never keep the bubble
    // or mini panel buried for a noticeable moment; re-asserting an
    // already-topmost window is a no-op for the OS, so this is free.
    const timer = setInterval(() => assertTopmost(win), 800);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stopTopmostGuard(timer) {
    if (timer) clearInterval(timer);
    return null;
  }

  function logoDataUrl() {
    if (cachedLogoDataUrl !== undefined) return cachedLogoDataUrl;
    cachedLogoDataUrl = null;
    if (logoPath && fsImpl && typeof fsImpl.readFileSync === 'function') {
      try {
        const buf = fsImpl.readFileSync(logoPath);
        cachedLogoDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      } catch (err) {
        logger?.warn?.(`[yayra:overlay] could not inline bubble logo: ${err?.message || err}`);
      }
    }
    return cachedLogoDataUrl;
  }

  function linuxAutostartFile() {
    if (!homeDir) return null;
    return path.join(homeDir, '.config', 'autostart', 'yayra.desktop');
  }

  function applyLinuxAutostart(enabled) {
    if (platform !== 'linux' || !fsImpl) return;
    const file = linuxAutostartFile();
    if (!file) return;
    try {
      if (enabled) {
        // Prefer the /usr/bin/yayra wrapper over the raw binary: the
        // wrapper picks the x11 backend on Wayland sessions BEFORE
        // Electron starts. Autostarting /opt/yayra/yayra directly would
        // boot the bubble on native Wayland - undraggable, not on top.
        let execPath = process.env.APPIMAGE || process.execPath;
        try {
          if (!process.env.APPIMAGE && process.execPath === '/opt/yayra/yayra' && fsImpl.existsSync('/usr/bin/yayra')) {
            execPath = '/usr/bin/yayra';
          }
        } catch { /* keep the raw path */ }
        // --yayra-autostart tells main.cjs this is a boot launch: start the
        // bubble + tray only, WITHOUT popping the main browser window over
        // whatever the user is doing right after login.
        const desktop = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Yayra',
          'Comment=Yayra floating browser bubble',
          `Exec=${JSON.stringify(execPath)} --yayra-autostart`,
          'X-GNOME-Autostart-enabled=true',
          'Terminal=false'
        ].join('\n') + '\n';
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        fsImpl.writeFileSync(file, desktop, { mode: 0o644 });
      } else if (fsImpl.existsSync(file)) {
        fsImpl.unlinkSync(file);
      }
      // Kill COMPETING autostart entries (any filename) that launch the
      // raw binary directly: those boot a native-Wayland instance at
      // login - frozen bubble - which then hogs the single-instance
      // lock. Only entries going through the wrapper (or an explicit
      // --ozone-platform) may survive.
      try {
        if (typeof fsImpl.readdirSync === 'function') {
          const dir = path.dirname(file);
          for (const name of fsImpl.readdirSync(dir)) {
            if (!String(name).endsWith('.desktop')) continue;
            const full = path.join(dir, name);
            if (full === file) continue;
            let text = '';
            try { text = String(fsImpl.readFileSync(full, 'utf8')); } catch { continue; }
            if (text.includes('/opt/yayra/yayra') && !text.includes('--ozone-platform=')) {
              try { fsImpl.unlinkSync(full); logger?.warn?.(`[yayra:overlay] removed competing raw-binary autostart entry: ${name}`); } catch { /* best effort */ }
            }
          }
        }
      } catch { /* cleanup is best-effort */ }
    } catch (err) {
      logger?.warn?.(`[yayra:overlay] could not write Linux autostart entry: ${err?.message || err}`);
    }
  }

  function applyLoginItemSettings(enabled) {
    try {
      // args: boot launches carry --yayra-autostart so only the bubble +
      // tray appear at login (never a surprise main window).
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--yayra-autostart'] });
    } catch (err) {
      // Not supported in some sandboxed/CI/Linux-without-autostart
      // environments - never fatal, just means this one convenience is
      // unavailable there.
      logger?.warn?.(`[yayra:overlay] could not set login item: ${err?.message || err}`);
    }
    // Linux desktop environments use XDG autostart, which Electron's
    // setLoginItemSettings does not reliably cover - write the .desktop
    // entry ourselves so "start right from booting" is true on Linux too.
    applyLinuxAutostart(Boolean(enabled));
  }

  function defaultPosition() {
    try {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      const size = overlayStore.load().size;
      return { x: width - size - 24, y: height - size - 96 };
    } catch {
      return { x: 40, y: 40 };
    }
  }

  function buildOverlayHtml(settings) {
    const logo = logoDataUrl();
    const rawShadowPx = Number(settings.shadowPx);
    const shadowPx = Number.isFinite(rawShadowPx) ? Math.max(0, Math.min(24, rawShadowPx)) : 0;
    const bubbleFilter = shadowPx > 0 ? `drop-shadow(0 3px ${shadowPx}px rgba(0,0,0,0.45))` : 'none';
    // The bubble is JUST the Yayra logo - fully transparent window, no
    // circular plate/gradient behind it. Its shadow is off by default and
    // user-adjustable in Settings. Fallback (logo asset unavailable): a
    // bare transparent "Y" monogram, still no circle.
    //
    // INPUT HANDLING (why there is NO -webkit-app-region: drag here):
    // Electron drag regions are handled natively by the OS window - the
    // renderer never receives left-button mouse events inside them, so
    // click/dblclick listeners on a draggable bubble silently never fire
    // (right-click still worked because contextmenu passes through).
    // That was exactly the "left click / tap / double click do nothing"
    // bug. Dragging is therefore implemented manually: once the pointer
    // travels past the tap slop the renderer streams its own pointermove
    // screen coordinates to the main process (never cursor polling - see
    // beginBubbleDrag), and real pointer events stay available for taps:
    //   1 tap   -> toggle the floating mini browser
    //   2 taps  -> open the radial menu of circular action buttons
    //   3 taps  -> lock the bubble where it is / unlock it again
    const bubbleContent = logo
      ? `<img id="bubble" src="${logo}" alt="" draggable="false" />`
      : `<div id="bubble"><span id="monogram">Y</span></div>`;
    // Radial ring geometry: 12 circular buttons evenly spaced around the
    // center of the RADIAL_SIZE square, AssistiveTouch-style. The ring
    // restores every assistant from the classic v1.0.2 in-app wheel
    // (ChatGPT / Gemini / Claude / Perplexity / screenshot / shields)
    // alongside the newer Yayra actions.
    const C = RADIAL_SIZE / 2;
    const RING_R = 120;
    const BTN = 50;
    const ringPos = (index, total) => {
      const angle = (index / total) * 2 * Math.PI - Math.PI / 2; // start at top
      const x = Math.round(C + RING_R * Math.cos(angle) - BTN / 2);
      const y = Math.round(C + RING_R * Math.sin(angle) - BTN / 2);
      return `left:${x}px; top:${y}px;`;
    };
    const icons = {
      ai: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M9.5 2L8 6.5 3.5 8 8 9.5 9.5 14 11 9.5 15.5 8 11 6.5zM17.5 11l-1 3-3 1 3 1 1 3 1-3 3-1-3-1z"/></svg>',
      mini: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="7" y="3" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12"/></svg>',
      full: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20"/></svg>',
      lockClosed: '<svg class="ic-locked" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      lockOpen: '<svg class="ic-unlocked" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
      hide: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
      quit: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" x2="12" y1="2" y2="12"/></svg>',
      close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
      // Brand marks mirror packages/shared-ui/src/icons/icons.js so the
      // native ring matches the classic in-app assistive wheel.
      chatgpt: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20.5 10.3a4.5 4.5 0 0 0-.4-3.8 4.6 4.6 0 0 0-3.6-2.2 4.5 4.5 0 0 0-3.6-1.8 4.6 4.6 0 0 0-4.2 2.8 4.5 4.5 0 0 0-3.2 1.5 4.6 4.6 0 0 0-.8 3.5 4.5 4.5 0 0 0-1.8 3.6 4.6 4.6 0 0 0 2.2 3.6 4.5 4.5 0 0 0 1.8 3.6 4.6 4.6 0 0 0 4.2 2.2 4.5 4.5 0 0 0 3.6-1.8 4.6 4.6 0 0 0 4.2-2.8 4.5 4.5 0 0 0 3.2-1.5 4.6 4.6 0 0 0 .8-3.5 4.5 4.5 0 0 0 1.8-3.6 4.6 4.6 0 0 0-2.4-3.6zm-8.5 10.2a3.1 3.1 0 0 1-2.1-.8l.1-.1 3.5-2a.8.8 0 0 0 .4-.7v-4.9l1.5.9v4.6a3.1 3.1 0 0 1-3.4 3zm-6.7-4.1a3.1 3.1 0 0 1-.3-2.3l.1.1 3.5 2a.8.8 0 0 0 .8 0l4.2-2.5v1.8l-4 2.3a3.1 3.1 0 0 1-4.3-1.4zm-.8-7.7a3.1 3.1 0 0 1 1.8-1.5v4.2a.8.8 0 0 0 .4.7l4.2 2.5-1.5.9-4-2.3a3.1 3.1 0 0 1-.9-4.5zm10.7 2.4l-4.2-2.5 1.5-.9 4 2.3a3.1 3.1 0 0 1 .9 4.5 3.1 3.1 0 0 1-1.8 1.5v-4.2a.8.8 0 0 0-.4-.7zm3.2 5.3a3.1 3.1 0 0 1-.3 2.3l-.1-.1-3.5-2a.8.8 0 0 0-.8 0l-4.2 2.5v-1.8l4-2.3a3.1 3.1 0 0 1 4.9 1.4zm-7.4-2.4l-1.9-1.1 1.9-1.1 1.9 1.1-1.9 1.1z"/></svg>',
      gemini: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C12 7.52 7.52 12 2 12c5.48 0 10 4.48 10 10 0-5.52 4.48-10 10-10-5.52 0-10-4.48-10-10z"/></svg>',
      claude: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2.5l2.4 6.8 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.6L12 2.5z"/></svg>',
      perplexity: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M8 8h8M8 16h8M6 8l6 8 6-8"/></svg>',
      screenshot: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
      shields: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>'
    };
    // Real logos for link-backed buttons: the site's actual favicon,
    // with the original glyph as an instant fallback if it can't load
    // (offline, firewalled, ...). Non-link actions keep custom glyphs.
    const linkIcon = (url, glyph) => {
      try {
        const host = new URL(url).hostname;
        return `<img src="https://icons.duckduckgo.com/ip3/${host}.ico" alt="" draggable="false"`
          + ` style="width:22px;height:22px;border-radius:6px;pointer-events:none;"`
          + ` onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='';" />`
          + `<span style="display:none;pointer-events:none;">${glyph || ''}</span>`;
      } catch {
        return glyph || '';
      }
    };
    const letterBadge = (title) =>
      `<span style="font:700 18px/1 system-ui;pointer-events:none;">${String(title || '?').trim().charAt(0).toUpperCase() || '?'}</span>`;
    const classicRing = [
      { action: 'ai', label: 'Ask Yayra AI', icon: icons.ai, cls: 'radial-btn-ai' },
      { action: 'chatgpt', label: 'Ask ChatGPT', icon: linkIcon('https://chatgpt.com', icons.chatgpt), cls: '' },
      { action: 'gemini', label: 'Rephrase with Gemini', icon: linkIcon('https://gemini.google.com', icons.gemini), cls: 'radial-btn-gemini' },
      { action: 'claude', label: 'Claude Assistant', icon: linkIcon('https://claude.ai', icons.claude), cls: '' },
      { action: 'perplexity', label: 'Perplexity Search', icon: linkIcon('https://perplexity.ai', icons.perplexity), cls: '' },
      { action: 'screenshot', label: 'Capture screenshot', icon: icons.screenshot, cls: '' },
      { action: 'mini', label: 'Open yayra mini', icon: icons.mini, cls: '' },
      { action: 'full', label: 'Open full browser', icon: icons.full, cls: '' },
      { action: 'shields', label: 'Security & Shields', icon: icons.shields, cls: '' },
      { action: 'lock', label: 'Lock / unlock position', icon: icons.lockClosed + icons.lockOpen, cls: 'radial-btn-lock' },
      { action: 'hide', label: 'Hide bubble', icon: icons.hide, cls: '' },
      { action: 'quit', label: 'Quit Yayra', icon: icons.quit, cls: '' }
    ];
    // When the user customized the in-app action wheel, the bubble's
    // double-tap radial mirrors it 1:1 (synced via
    // yayra:overlay-set-wheel-items). Unknown/renderer-only actions are
    // forwarded to the main window - see handleRadialAction.
    const wheelItems = Array.isArray(settings.wheelItems) && settings.wheelItems.length > 0
      ? settings.wheelItems
      : null;
    const builtinGlyphs = {
      chatgpt: icons.chatgpt,
      gemini: icons.gemini,
      claude: icons.claude,
      perplexity: icons.perplexity,
      screenshot: icons.screenshot,
      shields: icons.shields,
      sparkles: icons.ai,
      finder: icons.mini,
      duplicate: icons.full
    };
    const ringButtons = wheelItems
      ? wheelItems.map((item) => ({
          action: `wheel:${item.id}`,
          label: String(item.title || item.id || 'Action'),
          icon: (item.url && linkIcon(item.url, builtinGlyphs[item.id] || letterBadge(item.title)))
            || builtinGlyphs[item.id]
            || letterBadge(item.title),
          cls: ''
        }))
      : classicRing;
    const radialButtonsHtml = ringButtons.map((btn, i) =>
      `<button class="radial-btn ${btn.cls}" data-action="${btn.action}" title="${btn.label}" aria-label="${btn.label}" style="${ringPos(i, ringButtons.length)}">${btn.icon}</button>`
    ).join('')
      // Down-arrow below the center close - opens the wheel customizer in
      // the full browser, exactly like the in-app wheel's bottom arrow.
      + `<button class="radial-btn radial-btn-customize" data-action="customize" title="Customize wheel & bookmarks" aria-label="Customize wheel & bookmarks" style="left:${C - BTN / 2}px; top:${C + 42}px;">`
      + '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>';
    return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html, body { margin:0; padding:0; background:transparent; overflow:hidden; }
  #bubble {
    width:100vw; height:100vh;
    display:flex; align-items:center; justify-content:center;
    background:transparent;
    object-fit:contain;
    filter:${bubbleFilter};
    opacity:${settings.opacity};
    /* 'pointer'/'move' map to REAL Windows system cursors (IDC_HAND /
       IDC_SIZEALL) so the pointer keeps the user's Windows size here.
       'grab'/'grabbing' have no native Windows cursor - Chromium paints
       them from its own fixed-size bitmaps, which SHRANK the pointer
       over the bubble for anyone using a larger Windows pointer. */
    cursor:pointer;
    user-select:none;
    touch-action:none;
    transition:transform 120ms ease;
  }
  #bubble.dragging { cursor:move; }
  #bubble.locked { cursor:default; }
  #bubble.pulse { transform:scale(0.82); }
  #monogram {
    font:800 64px/1 system-ui, sans-serif;
    color:#4f7cff;
    text-shadow:0 2px 8px rgba(0,0,0,0.6);
    pointer-events:none;
  }
  /* --- double-tap radial menu (AssistiveTouch-style) --- */
  #radial { position:fixed; inset:0; display:none; }
  body.radial-open #bubble { display:none; }
  body.radial-open #radial { display:block; }
  .radial-btn {
    position:absolute;
    width:${BTN}px; height:${BTN}px;
    border-radius:50%;
    border:none;
    display:flex; align-items:center; justify-content:center;
    background:#f3f4f6;
    color:#1f2430;
    cursor:pointer;
    box-shadow:0 4px 14px rgba(0,0,0,0.45);
    transition:transform 120ms ease;
    animation:radial-pop 160ms ease;
  }
  .radial-btn:hover { transform:scale(1.1); }
  .radial-btn:active { transform:scale(0.92); }
  .radial-btn-ai { background:#15181f; color:#c4b5fd; }
  .radial-btn-gemini { background:#1b1d2a; color:#8ab4f8; }
  #radial-close {
    position:absolute;
    left:${C - 29}px; top:${C - 29}px;
    width:58px; height:58px;
    border-radius:50%;
    border:none;
    display:flex; align-items:center; justify-content:center;
    background:rgba(28, 32, 42, 0.92);
    color:#f3f4f6;
    cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,0.5);
    animation:radial-pop 160ms ease;
  }
  .radial-btn-lock .ic-unlocked { display:none; }
  body.pos-locked .radial-btn-lock .ic-locked { display:none; }
  body.pos-locked .radial-btn-lock .ic-unlocked { display:block; }
  body.pos-locked .radial-btn-lock { background:#fbbf24; color:#3b2f06; }
  @keyframes radial-pop { from { transform:scale(0.4); opacity:0; } to { transform:scale(1); opacity:1; } }
</style></head>
<body>
  ${bubbleContent}
  <div id="radial">
    ${radialButtonsHtml}
    <button id="radial-close" data-action="close" title="Close menu" aria-label="Close menu">${icons.close}</button>
  </div>
  <script>
    const bubbleEl = document.getElementById('bubble');
    const api = window.yayraOverlay || {};
    let locked = ${settings.positionLocked ? 'true' : 'false'};
    const TAP_SLOP_PX = 5;        // movement below this is a tap, not a drag
    const MULTI_TAP_MS = 350;     // Chrome-style multi-click settle window

    function applyLockUi() {
      bubbleEl.classList.toggle('locked', locked);
      document.body.classList.toggle('pos-locked', locked);
      bubbleEl.title = locked
        ? 'Yayra - position locked (triple-click to unlock)'
        : 'Yayra - click: mini  |  double-click: menu  |  triple-click: lock position  |  drag to move';
    }
    function pulse() {
      bubbleEl.classList.add('pulse');
      setTimeout(() => bubbleEl.classList.remove('pulse'), 140);
    }
    applyLockUi();
    if (typeof api.onLockChanged === 'function') {
      api.onLockChanged((isLocked) => { locked = Boolean(isLocked); applyLockUi(); pulse(); });
    }

    let downAt = null;   // screen coords at pointerdown
    let grabOffset = null; // cursor offset inside the window at pointerdown
    let dragging = false;  // only true AFTER movement exceeds the tap slop
    let tapCount = 0;
    let tapTimer = null;

    function endDrag() {
      bubbleEl.classList.remove('dragging');
      if (dragging && typeof api.dragEnd === 'function') api.dragEnd();
      dragging = false;
    }
    function dispatchTaps(count) {
      tapCount = 0;
      if (typeof api.tap === 'function') api.tap(count);
      else if (count === 1 && typeof api.bubbleClick === 'function') api.bubbleClick();
      else if (typeof api.restore === 'function') api.restore();
    }

    // A press NEVER moves the window. Dragging engages only once the
    // pointer travels past the tap slop, then the renderer streams its own
    // pointermove screen coordinates to the main process - this keeps taps
    // and drags correct on every display scale and monitor layout.
    bubbleEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { bubbleEl.setPointerCapture(e.pointerId); } catch {}
      downAt = { x: e.screenX, y: e.screenY };
      grabOffset = { x: e.clientX, y: e.clientY };
      dragging = false;
    });
    bubbleEl.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      if (!dragging) {
        const past = Math.abs(e.screenX - downAt.x) > TAP_SLOP_PX
          || Math.abs(e.screenY - downAt.y) > TAP_SLOP_PX;
        if (!past || locked) return;
        dragging = true;
        bubbleEl.classList.add('dragging');
        if (typeof api.dragStart === 'function') api.dragStart(grabOffset);
      }
      if (typeof api.dragMove === 'function') api.dragMove({ x: e.screenX, y: e.screenY });
    });
    bubbleEl.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const wasDrag = dragging
        || Math.abs(e.screenX - downAt.x) > TAP_SLOP_PX
        || Math.abs(e.screenY - downAt.y) > TAP_SLOP_PX;
      downAt = null;
      endDrag();
      if (wasDrag) { tapCount = 0; clearTimeout(tapTimer); return; }
      pulse();
      tapCount += 1;
      clearTimeout(tapTimer);
      if (tapCount >= 3) dispatchTaps(3); // lock/unlock fires instantly
      else tapTimer = setTimeout(() => dispatchTaps(tapCount), MULTI_TAP_MS);
    });
    bubbleEl.addEventListener('pointercancel', () => { downAt = null; endDrag(); });
    bubbleEl.addEventListener('lostpointercapture', () => { if (downAt) { downAt = null; endDrag(); } });
    bubbleEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof api.openMenu === 'function') api.openMenu();
    });

    // --- double-tap radial menu of circular action buttons ---
    // Opening/closing is driven by the MAIN process (it resizes this
    // window around the bubble first); buttons report their action back.
    const radialEl = document.getElementById('radial');
    if (typeof api.onRadial === 'function') {
      api.onRadial((payload) => {
        const open = Boolean(payload && payload.open);
        document.body.classList.toggle('radial-open', open);
        if (payload && typeof payload.locked === 'boolean') {
          locked = payload.locked;
          applyLockUi();
        }
      });
    }
    radialEl.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof api.radialAction === 'function') api.radialAction(btn.dataset.action);
      });
    });
    // Tapping the empty space around the ring closes the menu.
    radialEl.addEventListener('pointerdown', (e) => {
      if (e.target === radialEl && typeof api.radialAction === 'function') api.radialAction('close');
    });
    radialEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof api.openMenu === 'function') api.openMenu();
    });
  </script>
</body></html>`;
  }

  function ensureOverlayWindow() {
    const settings = overlayStore.load();
    if (!settings.enabled) return null;
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

    const size = settings.size || 64;
    // Clamp the restored position: a monitor change/resolution switch can
    // leave the saved spot outside every screen - the bubble must NEVER
    // come back invisible ("left the computer screen").
    const pos = clampToVisibleArea(
      (settings.position || defaultPosition()).x,
      (settings.position || defaultPosition()).y,
      size
    );

    overlayWin = new BrowserWindow({
      width: size,
      height: size,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Never steal keyboard focus: a focusable overlay gets pulled into
      // normal window activation ordering, which is one of the ways the
      // bubble ends up BEHIND the app the user just clicked into. A
      // non-focusable window still receives mouse clicks/drags.
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // 'screen-saver' is the highest always-on-top level Electron exposes -
    // see the module-level doc comment for exactly what this does and does
    // not guarantee.
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    if (typeof overlayWin.setVisibleOnAllWorkspaces === 'function') {
      overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    overlayWin.setContentProtection(false);
    // Keep it above every opened app, not just the desktop: re-assert the
    // topmost claim whenever the OS drops it and on a heartbeat.
    overlayTopmostTimer = stopTopmostGuard(overlayTopmostTimer);
    overlayTopmostTimer = startTopmostGuard(overlayWin);
    overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(settings))}`);
    // The bubble can be configured nearly invisible (tiny + low opacity +
    // tucked in a corner) - log its geometry so "the bubble did not open"
    // is diagnosable from the terminal in one glance.
    console.log(`[yayra] floating bubble shown at ${pos.x},${pos.y} size ${size}px opacity ${Math.round((settings.opacity ?? 1) * 100)}%${settings.positionLocked ? ' (position locked)' : ''}`);

    overlayWin.on('moved', () => {
      // While the radial menu is open the window is the ENLARGED square -
      // persisting that position would teleport the bubble on restart.
      if (radialOpen) return;
      try {
        const [x, y] = overlayWin.getPosition();
        overlayStore.save({ position: { x, y } });
      } catch {
        // best-effort persistence only
      }
    });

    overlayWin.on('closed', () => {
      overlayWin = null;
      endBubbleDrag({ persist: false });
      radialOpen = false;
      radialRestoreBounds = null;
      overlayTopmostTimer = stopTopmostGuard(overlayTopmostTimer);
    });

    return overlayWin;
  }

  function destroyOverlayWindow() {
    endBubbleDrag({ persist: false });
    radialOpen = false;
    radialRestoreBounds = null;
    overlayTopmostTimer = stopTopmostGuard(overlayTopmostTimer);
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.close();
    }
    overlayWin = null;
    // The mini panel is anchored to the bubble - no bubble, no mini panel.
    destroyMiniWindow();
  }

  function getOverlayWindow() {
    return overlayWin;
  }

  /* -------------------------------------------------------------
   * Floating "yayra mini" panel - a REAL native always-on-top window
   * (not a <div> inside the main renderer), so it works even when the
   * main browser window is closed or was never opened. Single click on
   * the bubble toggles it, exactly like AssistiveTouch expanding.
   * ----------------------------------------------------------- */

  function miniDefaultBounds() {
    // 480px: comfortable room for the DEFAULT desktop view's tab strip +
    // toolbar (back/forward/reload + omnibox + actions) in the mini panel.
    const width = 480;
    const height = 640;
    try {
      const area = screen.getPrimaryDisplay().workAreaSize;
      let x = area.width - width - 24;
      let y = area.height - height - 48;
      if (overlayWin && !overlayWin.isDestroyed() && typeof overlayWin.getPosition === 'function') {
        const [bx, by] = overlayWin.getPosition();
        const size = overlayStore.load().size || 64;
        x = Math.min(Math.max(12, bx + size - width), Math.max(12, area.width - width - 12));
        y = Math.min(Math.max(12, by - height - 12), Math.max(12, area.height - height - 12));
      }
      return { x, y, width, height };
    } catch {
      return { x: 80, y: 80, width, height };
    }
  }

  function ensureMiniWindow(urlOverride = null) {
    if (!mainPreloadPath) return null;
    if (miniWin && !miniWin.isDestroyed()) return miniWin;
    const bounds = miniDefaultBounds();
    miniWin = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: true,
      backgroundColor: '#101218',
      webPreferences: {
        preload: mainPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    miniWin.setAlwaysOnTop(true, 'screen-saver');
    if (typeof miniWin.setVisibleOnAllWorkspaces === 'function') {
      miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    // The mini panel must also stay above whatever app is focused (it opens
    // from the bubble while the user is inside another application). It
    // stays focusable - it hosts a real browser that needs the keyboard -
    // so the heartbeat is what keeps it topmost after focus round-trips.
    miniTopmostTimer = stopTopmostGuard(miniTopmostTimer);
    miniTopmostTimer = startTopmostGuard(miniWin);
    miniWin.loadURL(urlOverride || miniUrl);
    miniWin.on('closed', () => {
      miniWin = null;
      miniTopmostTimer = stopTopmostGuard(miniTopmostTimer);
    });
    return miniWin;
  }

  /**
   * Open the floating mini browser directly on an internal page (e.g.
   * 'yayra://ai' from the radial menu's AI button or the bubble's
   * right-click menu). The &page= boot param is read by
   * src/browser/main.js, which starts the mini shell on that page.
   * An already-open mini is recreated - deep-linking wins over reuse.
   */
  function openMiniPanelAt(page) {
    if (!mainPreloadPath) return restoreMainWindow();
    destroyMiniWindow();
    const sep = miniUrl.includes('?') ? '&' : '?';
    return ensureMiniWindow(`${miniUrl}${sep}page=${encodeURIComponent(String(page || ''))}`);
  }

  function openDictionaryLookupInMini(page) {
    const url = typeof page === 'string' && /^yayra:\/\/dictionary(?:\?|$)/i.test(page) ? page.slice(0, 4000) : '';
    if (!url || !mainPreloadPath) return false;
    if (!miniWin || miniWin.isDestroyed()) return Boolean(openMiniPanelAt(url));
    const deliver = () => {
      try { if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('yayra:overlay-dictionary-lookup', { url }); } catch { /* mini closed */ }
    };
    try {
      miniWin.show?.();
      miniWin.focus?.();
      if (typeof miniWin.webContents?.isLoading === 'function' && miniWin.webContents.isLoading()) miniWin.webContents.once('did-finish-load', deliver);
      else deliver();
      return true;
    } catch { return false; }
  }

  function destroyMiniWindow() {
    miniTopmostTimer = stopTopmostGuard(miniTopmostTimer);
    if (miniWin && !miniWin.isDestroyed()) miniWin.close();
    miniWin = null;
  }

  function getMiniWindow() {
    return miniWin;
  }

  function toggleMiniPanel() {
    if (!mainPreloadPath) {
      restoreMainWindow();
      return null;
    }
    if (miniWin && !miniWin.isDestroyed()) {
      if (typeof miniWin.isVisible === 'function' && miniWin.isVisible()) {
        miniWin.hide();
      } else {
        miniWin.show?.();
        miniWin.focus?.();
        // Guarantee the panel actually surfaces above whatever app the
        // bubble was clicked over (single-click is the primary gesture).
        assertTopmost(miniWin);
      }
      return miniWin;
    }
    return ensureMiniWindow();
  }

  /* -------------------------------------------------------------
   * Manual bubble dragging + tap gestures + triple-click position lock.
   *
   * The bubble window deliberately has no -webkit-app-region drag zone
   * (native drag regions eat every left-button event, so click/double-
   * click never reached the renderer - the original "using it is not
   * working" bug). Instead, once the pointer moves past the tap slop the
   * renderer streams pointermove screen coordinates and the main process
   * repositions the window to match. While the position is LOCKED
   * (toggled by triple-click), drag requests are refused and the bubble
   * stays exactly where it is.
   * ----------------------------------------------------------- */

  // v1.0.4 regression fix: the first manual-drag implementation polled
  // screen.getCursorScreenPoint() from the MAIN process and started
  // repositioning the window on EVERY pointerdown. On scaled/multi-monitor
  // displays and several Linux backends the cursor-poll coordinate space
  // does not match window coordinates, so the bubble teleported out from
  // under the pointer the moment it was pressed - which simultaneously
  // broke single-click (the jump read as a drag), broke dragging (the
  // poll loop fought the pointer), and on some WMs the constant
  // setPosition spam dropped the always-on-top hint. The drag is now
  // driven entirely by the RENDERER's own pointermove screen coordinates
  // (the same event stream that demonstrably works - taps use it), and
  // the window only starts moving after real movement, never on a press.
  /**
   * Keep the bubble ON the screen: clamp a target position so the whole
   * bubble stays inside the work area of the display it is on (multi-
   * monitor aware via getDisplayNearestPoint). The bubble must never
   * leave the screen unless the user explicitly hides it.
   */
  function clampToVisibleArea(x, y, size) {
    const rx = Math.round(Number(x)) || 0;
    const ry = Math.round(Number(y)) || 0;
    const s = Math.max(1, Math.round(Number(size)) || 64);
    try {
      let area = null;
      if (typeof screen.getDisplayNearestPoint === 'function') {
        const display = screen.getDisplayNearestPoint({ x: rx + Math.round(s / 2), y: ry + Math.round(s / 2) });
        if (display && display.workArea) area = display.workArea;
      }
      if (!area) {
        const wa = screen.getPrimaryDisplay().workAreaSize;
        area = { x: 0, y: 0, width: wa.width, height: wa.height };
      }
      return {
        x: Math.min(Math.max(area.x, rx), area.x + Math.max(0, area.width - s)),
        y: Math.min(Math.max(area.y, ry), area.y + Math.max(0, area.height - s))
      };
    } catch {
      return { x: rx, y: ry };
    }
  }

  /**
   * Move the bubble window. setBounds (full rect, one atomic configure)
   * is more reliable than setPosition for fixed-size frameless windows on
   * several Linux WMs; fall back to setPosition for environments (and
   * older test fakes) without it. Re-asserts topmost on a throttle: some
   * WMs quietly demote z-order during programmatic moves.
   */
  function positionBubbleAt(x, y) {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const size = overlayStore.load().size || 64;
    const target = clampToVisibleArea(x, y, size);
    try {
      if (typeof overlayWin.setBounds === 'function') {
        overlayWin.setBounds({ x: target.x, y: target.y, width: size, height: size });
        // Belt-and-suspenders: a few WMs quietly drop client-initiated
        // ConfigureRequests issued through one API but honor the other.
        // Issuing both is idempotent where the first already worked.
        if (typeof overlayWin.setPosition === 'function') overlayWin.setPosition(target.x, target.y);
      } else {
        overlayWin.setPosition(target.x, target.y);
      }
      const now = Date.now();
      if (now - lastDragTopmostAt > 300) {
        lastDragTopmostAt = now;
        assertTopmost(overlayWin);
      }
      return true;
    } catch {
      return false;
    }
  }

  function stopDragAssist() {
    if (dragAssistTimer) clearInterval(dragAssistTimer);
    dragAssistTimer = null;
    dragStartCursor = null;
    dragStartWinPos = null;
  }

  function beginBubbleDrag(offset) {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    if (radialOpen) return false; // the expanded menu never drags
    if (overlayStore.load().positionLocked) return false; // triple-click lock
    dragOffset = {
      x: Math.round(Number(offset?.x)) || 0,
      y: Math.round(Number(offset?.y)) || 0
    };
    dragActive = true;
    lastRendererDragAt = Date.now();

    // DRAG ASSIST: on some machines the renderer's pointermove stream dies
    // the moment the window starts moving under the cursor - the original
    // "bubble cannot be moved around" bug. While a drag is active, the
    // main process also follows the OS cursor, DELTA-based (window start
    // position + cursor movement since the drag began), which is immune
    // to the absolute coordinate-space mismatches that sank the old
    // poll-on-pointerdown approach (no teleports - a press alone still
    // never moves the window, because this only runs after the renderer
    // reported real movement past the tap slop). The renderer stream
    // stays the primary driver; the poll only steps in when that stream
    // has gone quiet mid-drag, and a long total silence safety-releases
    // the drag so the bubble can never get stuck to the cursor.
    stopDragAssist();
    try {
      if (typeof screen.getCursorScreenPoint === 'function' && typeof overlayWin.getPosition === 'function') {
        const cursor = screen.getCursorScreenPoint();
        const [wx, wy] = overlayWin.getPosition();
        if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
          dragStartCursor = { x: cursor.x, y: cursor.y };
          dragStartWinPos = { x: wx, y: wy };
          dragAssistTimer = setInterval(() => {
            if (!dragActive || !overlayWin || overlayWin.isDestroyed()) { stopDragAssist(); return; }
            const sinceRenderer = Date.now() - lastRendererDragAt;
            if (sinceRenderer > 2500) { endBubbleDrag(); return; } // lost pointerup safety
            if (sinceRenderer < 120) return; // renderer stream is driving fine
            try {
              const cur = screen.getCursorScreenPoint();
              if (!cur || !Number.isFinite(cur.x) || !Number.isFinite(cur.y)) return;
              positionBubbleAt(
                dragStartWinPos.x + (cur.x - dragStartCursor.x),
                dragStartWinPos.y + (cur.y - dragStartCursor.y)
              );
            } catch { /* cursor unavailable this tick */ }
          }, 16);
          if (typeof dragAssistTimer.unref === 'function') dragAssistTimer.unref();
        }
      }
    } catch { /* assist is optional - renderer stream still works */ }
    return true;
  }

  function moveBubbleDrag(point) {
    if (!dragActive || !overlayWin || overlayWin.isDestroyed()) return false;
    const sx = Math.round(Number(point?.x));
    const sy = Math.round(Number(point?.y));
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
    lastRendererDragAt = Date.now();
    const moved = positionBubbleAt(sx - dragOffset.x, sy - dragOffset.y);
    if (!moved) dragActive = false;
    return moved;
  }

  function endBubbleDrag({ persist = true } = {}) {
    dragActive = false;
    stopDragAssist();
    if (!persist) return;
    try {
      if (overlayWin && !overlayWin.isDestroyed()) {
        const [x, y] = overlayWin.getPosition();
        overlayStore.save({ position: { x, y } });
        // Some WMs demote the z-order after programmatic moves - make the
        // "floats over every app" promise hold the instant the drag ends.
        assertTopmost(overlayWin);
      }
    } catch {
      // best-effort persistence only
    }
  }

  /* -------------------------------------------------------------
   * Menu-driven "Move bubble": the bubble glides with the cursor
   * (no button held) until the user clicks it to drop it. This is
   * the classic coarse-pointer-friendly move from the old versions -
   * restored alongside normal dragging, and it works even when a
   * misbehaving WM eats pointer-drag events.
   * ----------------------------------------------------------- */
  let moveModeTimer = null;
  let moveModeDeadline = null;

  function startBubbleMoveMode() {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    stopBubbleMoveMode({ persist: false });
    endBubbleDrag({ persist: false });
    if (!screen || typeof screen.getCursorScreenPoint !== 'function' || typeof setInterval !== 'function') return false;
    const size = overlayStore.load().size || 64;
    moveModeTimer = setInterval(() => {
      try {
        if (!overlayWin || overlayWin.isDestroyed()) { stopBubbleMoveMode({ persist: false }); return; }
        const p = screen.getCursorScreenPoint();
        const target = clampToVisibleArea(p.x - Math.round(size / 2), p.y - Math.round(size / 2), size);
        overlayWin.setPosition(target.x, target.y);
      } catch { /* screen API raced shutdown */ }
    }, 16);
    if (moveModeTimer && typeof moveModeTimer.unref === 'function') moveModeTimer.unref();
    // A missed click must never leave the bubble glued to the cursor.
    if (typeof setTimeout === 'function') {
      moveModeDeadline = setTimeout(() => stopBubbleMoveMode({ persist: true }), 30000);
      if (moveModeDeadline && typeof moveModeDeadline.unref === 'function') moveModeDeadline.unref();
    }
    return true;
  }

  /** @returns {boolean} true when move mode WAS active (the click dropped the bubble). */
  function stopBubbleMoveMode({ persist = true } = {}) {
    if (!moveModeTimer) return false;
    clearInterval(moveModeTimer);
    moveModeTimer = null;
    if (moveModeDeadline) { clearTimeout(moveModeDeadline); moveModeDeadline = null; }
    if (persist) {
      try {
        if (overlayWin && !overlayWin.isDestroyed() && typeof overlayWin.getPosition === 'function') {
          const [x, y] = overlayWin.getPosition();
          overlayStore.save({ position: { x, y } });
          assertTopmost(overlayWin);
        }
      } catch { /* best-effort persistence only */ }
    }
    return true;
  }

  /* -------------------------------------------------------------
   * Radial menu (AssistiveTouch-style): double-tapping the bubble
   * expands its tiny always-on-top window into a RADIAL_SIZE square
   * centered on the bubble, and the renderer shows a ring of circular
   * action buttons (see buildOverlayHtml): Yayra AI, yayra mini, full
   * browser, lock/unlock position, hide bubble, quit. Closing shrinks
   * the window back to exactly where the bubble was.
   * ----------------------------------------------------------- */

  function openRadialMenu() {
    if (!overlayWin || overlayWin.isDestroyed() || radialOpen) return false;
    if (typeof overlayWin.setBounds !== 'function') return false;
    // Stop any in-flight drag WITHOUT persisting here: real moves already
    // persist via the 'moved' handler, and saving now would race the
    // expansion below.
    endBubbleDrag({ persist: false });
    const settings = overlayStore.load();
    const size = settings.size || 64;
    const [x, y] = overlayWin.getPosition();
    radialRestoreBounds = { x, y, width: size, height: size };
    // Center the expanded square on the bubble's center, clamped on-screen.
    let rx = Math.round(x + size / 2 - RADIAL_SIZE / 2);
    let ry = Math.round(y + size / 2 - RADIAL_SIZE / 2);
    try {
      const area = screen.getPrimaryDisplay().workAreaSize;
      rx = Math.min(Math.max(0, rx), Math.max(0, area.width - RADIAL_SIZE));
      ry = Math.min(Math.max(0, ry), Math.max(0, area.height - RADIAL_SIZE));
    } catch {
      // No display info (tests/headless) - keep the unclamped center.
    }
    radialOpen = true;
    overlayWin.setBounds({ x: rx, y: ry, width: RADIAL_SIZE, height: RADIAL_SIZE });
    assertTopmost(overlayWin); // setBounds can demote z-order on some WMs
    try {
      overlayWin.webContents?.send?.('yayra:overlay-radial', {
        open: true,
        locked: Boolean(settings.positionLocked)
      });
    } catch {
      // Renderer gone mid-open.
    }
    return true;
  }

  function closeRadialMenu() {
    if (!radialOpen) return false;
    radialOpen = false;
    try {
      if (overlayWin && !overlayWin.isDestroyed()) {
        if (radialRestoreBounds && typeof overlayWin.setBounds === 'function') {
          overlayWin.setBounds(radialRestoreBounds);
          assertTopmost(overlayWin); // setBounds can demote z-order
        }
        overlayWin.webContents?.send?.('yayra:overlay-radial', { open: false });
      }
    } catch {
      // Renderer/window gone mid-close - state is reset either way.
    }
    radialRestoreBounds = null;
    return true;
  }

  function isRadialOpen() {
    return radialOpen;
  }

  // External assistants from the classic v1.0.2 in-app wheel, now opened
  // system-wide in the floating mini browser over whatever app is active.
  const ASSISTANT_PAGES = {
    chatgpt: 'https://chatgpt.com',
    gemini: 'https://gemini.google.com',
    claude: 'https://claude.ai',
    perplexity: 'https://perplexity.ai'
  };

  /**
   * REAL screen capture (the v1.0.2 in-app wheel only showed a fake
   * "saved!" alert): grabs the primary display at native resolution via
   * desktopCapturer, writes a timestamped PNG into the user's Downloads
   * folder, and reveals it in the file manager. The bubble window hides
   * for the grab so the screenshot never contains the bubble itself.
   */
  async function captureScreenshot() {
    if (!desktopCapturerImpl || typeof desktopCapturerImpl.getSources !== 'function'
      || !fsImpl || typeof screenshotDir !== 'function') {
      logger?.warn?.('[yayra:overlay] screenshot unavailable: capturer/fs/dir not wired');
      return { ok: false, reason: 'unavailable' };
    }
    const hadOverlay = overlayWin && !overlayWin.isDestroyed();
    try {
      if (hadOverlay) overlayWin.hide();
      // Give the compositor a beat to actually unmap the bubble window.
      await new Promise((resolve) => setTimeout(resolve, 180));
      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const sources = await desktopCapturerImpl.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.size.width * scale),
          height: Math.round(display.size.height * scale)
        }
      });
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (!source || !source.thumbnail || source.thumbnail.isEmpty?.()) {
        return { ok: false, reason: 'no-source' };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(screenshotDir(), `yayra-screenshot-${stamp}.png`);
      fsImpl.writeFileSync(file, source.thumbnail.toPNG());
      try { shellImpl?.showItemInFolder?.(file); } catch { /* reveal is best-effort */ }
      logger?.log?.(`[yayra:overlay] screenshot saved: ${file}`);
      return { ok: true, file };
    } catch (err) {
      logger?.warn?.(`[yayra:overlay] screenshot failed: ${err?.message || err}`);
      return { ok: false, reason: String(err?.message || err) };
    } finally {
      if (hadOverlay && overlayWin && !overlayWin.isDestroyed()) {
        try { overlayWin.show(); assertTopmost(overlayWin); } catch { /* window raced destruction */ }
      }
    }
  }

  /**
   * Forward a wheel action the native ring can't run itself to the main
   * renderer (Quick Notes, Duplicate Window, the customizer, ...): the
   * full browser is brought up and executes it via executeWheelActionById.
   */
  function forwardWheelToMain(actionId) {
    const win = restoreMainWindow();
    try {
      win?.webContents?.send?.('yayra:wheel-action', actionId);
    } catch (err) {
      logger?.warn?.(`[yayra:overlay] could not forward wheel action "${actionId}": ${err?.message || err}`);
    }
    return win;
  }

  /** Run one synced custom-wheel item from the native radial. */
  function runWheelItem(actionId) {
    const settings = overlayStore.load();
    const items = Array.isArray(settings.wheelItems) ? settings.wheelItems : [];
    const item = items.find((i) => i && i.id === actionId) || null;
    // Link items (bookmarks, custom sites, the AI assistants) open right
    // here in yayra mini - no need to wake the full browser.
    if (item && item.url) return openMiniPanelAt(item.url);
    switch (actionId) {
      case 'screenshot': return captureScreenshot();
      case 'shields': return openMiniPanelAt('yayra://extensions');
      case 'sparkles': return openMiniPanelAt('yayra://ai');
      case 'finder': return toggleMiniPanel();
      default:
        // play / notes / touch / duplicate / unknown ids: only the full
        // renderer owns these features.
        return forwardWheelToMain(actionId);
    }
  }

  /** A circular button in the radial menu was pressed. */
  function handleRadialAction(action) {
    if (typeof action === 'string' && action.startsWith('wheel:')) {
      closeRadialMenu();
      return runWheelItem(action.slice('wheel:'.length));
    }
    if (action === 'customize') {
      closeRadialMenu();
      return forwardWheelToMain('customize');
    }
    if (ASSISTANT_PAGES[action]) {
      closeRadialMenu();
      return openMiniPanelAt(ASSISTANT_PAGES[action]);
    }
    switch (action) {
      case 'ai':
        closeRadialMenu();
        return openMiniPanelAt('yayra://ai');
      case 'screenshot':
        closeRadialMenu();
        return captureScreenshot();
      case 'shields':
        closeRadialMenu();
        return openMiniPanelAt('yayra://extensions');
      case 'mini':
        closeRadialMenu();
        return toggleMiniPanel();
      case 'full':
        closeRadialMenu();
        return restoreMainWindow();
      case 'lock':
        // Stays open so the button's icon flip is visible immediately.
        return togglePositionLock();
      case 'hide':
        closeRadialMenu();
        return setEnabled(false);
      case 'quit':
        try { app.quit(); } catch { /* already quitting */ }
        return null;
      case 'close':
      default:
        closeRadialMenu();
        return null;
    }
  }

  function setPositionLocked(locked) {
    const next = overlayStore.save({ positionLocked: Boolean(locked) });
    if (next.positionLocked) endBubbleDrag({ persist: true }); // a mid-drag lock freezes in place
    try {
      if (overlayWin && !overlayWin.isDestroyed() && typeof overlayWin.setMovable === 'function') {
        overlayWin.setMovable(!next.positionLocked);
      }
      // Let the bubble update its cursor/tooltip + play the lock pulse.
      overlayWin?.webContents?.send?.('yayra:overlay-lock-changed', next.positionLocked);
    } catch {
      // Renderer gone mid-toggle - state is persisted either way.
    }
    return next;
  }

  function togglePositionLock() {
    return setPositionLocked(!overlayStore.load().positionLocked);
  }

  /**
   * Gesture dispatch for the bubble (counts settled by the renderer):
   *   1 tap -> toggle the floating mini browser (or close an open radial);
   *   2 taps -> toggle the AssistiveTouch-style RADIAL MENU of circular
   *             action buttons (Yayra AI / mini / full browser / lock /
   *             hide / quit) around the bubble;
   *   3 taps -> lock the bubble's position right where it is - and
   *             triple-clicking again unlocks movement.
   */
  function handleBubbleTap(count) {
    const taps = Math.max(1, Math.round(Number(count)) || 1);
    if (taps >= 3) return togglePositionLock();
    if (taps === 2) return radialOpen ? closeRadialMenu() : openRadialMenu();
    if (radialOpen) return closeRadialMenu();
    return toggleMiniPanel();
  }

  function restoreMainWindow() {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized?.()) win.restore();
      win.show();
      win.focus();
      return win;
    }
    // Main window was closed (or never opened): the bubble must still be
    // able to open the full browser - this is what "the bubble does not
    // rely on yayra main" means in practice.
    if (typeof createMainWindow === 'function') {
      try {
        return createMainWindow();
      } catch (err) {
        logger?.warn?.(`[yayra:overlay] could not recreate main window: ${err?.message || err}`);
      }
    }
    return null;
  }

  /**
   * Right-click "Screen recording" entries. PC system sound is always
   * part of a recording (OS loopback - see electron/screenRecorder.cjs
   * for the one honest exception); the mic is the include/mute choice.
   */
  function buildRecordingMenuItems() {
    if (!screenRecorder || !screenRecorder.isSupported?.()) return [];
    const rec = screenRecorder.status();
    if (rec.active) {
      const mins = Math.max(0, Math.floor((Date.now() - (rec.startedAt || Date.now())) / 60000));
      return [{
        label: `Stop screen recording (${mins}m, ${rec.mic ? 'voice on' : 'mic muted'})`,
        click: () => { screenRecorder.stop(); }
      }];
    }
    return [{
      label: 'Screen recording',
      submenu: [
        { label: 'Record screen - PC sound + voice', click: () => { screenRecorder.start({ mic: true }); } },
        { label: 'Record screen - PC sound only (mic muted)', click: () => { screenRecorder.start({ mic: false }); } }
      ]
    }];
  }

  function openBubbleMenu() {
    if (!Menu || !overlayWin || overlayWin.isDestroyed()) return;
    const locked = Boolean(overlayStore.load().positionLocked);
    const template = [
      { label: 'Ask Yayra AI', click: () => openMiniPanelAt('yayra://ai') },
      {
        label: 'AI assistants',
        submenu: [
          { label: 'Ask ChatGPT', click: () => openMiniPanelAt(ASSISTANT_PAGES.chatgpt) },
          { label: 'Rephrase with Gemini', click: () => openMiniPanelAt(ASSISTANT_PAGES.gemini) },
          { label: 'Claude Assistant', click: () => openMiniPanelAt(ASSISTANT_PAGES.claude) },
          { label: 'Perplexity Search', click: () => openMiniPanelAt(ASSISTANT_PAGES.perplexity) }
        ]
      },
      { type: 'separator' },
      { label: 'Capture screenshot', click: () => { captureScreenshot(); } },
      ...buildRecordingMenuItems(),
      { label: 'Security & Shields', click: () => openMiniPanelAt('yayra://extensions') },
      { type: 'separator' },
      { label: 'Open yayra mini', click: () => toggleMiniPanel() },
      { label: 'Open full browser', click: () => restoreMainWindow() },
      { type: 'separator' },
      {
        label: 'Move bubble (follows your cursor - click it to drop)',
        click: () => {
          // Explicit menu action: moving is the user's intent, so a
          // position lock never blocks it - just moves the locked spot.
          startBubbleMoveMode();
        }
      },
      {
        label: locked ? 'Unlock movement (or triple-click)' : 'Lock position here (or triple-click)',
        click: () => togglePositionLock()
      },
      { label: 'Hide bubble (re-enable from Settings)', click: () => setEnabled(false) },
      { type: 'separator' },
      { label: 'Quit Yayra', click: () => { try { app.quit(); } catch { /* already quitting */ } } }
    ];
    const menu = Menu.buildFromTemplate(template);
    // OUTSIDE-CLICK DISMISSAL: the bubble window is focusable:false by
    // design (it must never steal focus from the app under it), but a
    // native popup anchored to an unfocusable window never sees focus
    // leave, so clicking anywhere else left the menu stuck open. Make
    // the window focusable just for the popup's lifetime: a click
    // anywhere else now blurs it, and blur closes the popup.
    try {
      overlayWin.setFocusable?.(true);
      overlayWin.focus?.();
    } catch { /* focus dance is best-effort */ }
    let guardedPopup = null;
    // Keep the explicit once-listener as well as the generic guard. Older
    // Electron/EventEmitter shims expose only once(); close() is idempotent,
    // so whichever blur path runs first settles the popup exactly once.
    const onBlur = () => guardedPopup?.close?.('overlay-window-blur');
    try { overlayWin.once?.('blur', onBlur); } catch { /* optional */ }
    guardedPopup = popupMenuWithRecovery({
      menu,
      window: overlayWin,
      // Fires on ANY close (item clicked, Esc, blur, or the independent
      // safety deadline) - restore the never-steal-focus contract and the
      // topmost claim. A missing native callback cannot strand this state.
      callback: () => {
        try { overlayWin.removeListener?.('blur', onBlur); } catch { /* already removed */ }
        try { overlayWin.setFocusable?.(false); } catch { /* window raced destruction */ }
        assertTopmost(overlayWin);
      }
    });
  }

  function setEnabled(enabled) {
    const next = overlayStore.save({ enabled: Boolean(enabled) });
    if (next.enabled) ensureOverlayWindow();
    else destroyOverlayWindow();
    return next;
  }

  function setLaunchAtStartup(enabled) {
    const next = overlayStore.save({ launchAtStartup: Boolean(enabled) });
    applyLoginItemSettings(next.launchAtStartup);
    return next;
  }

  // Live-resizes the floating bubble (user-adjustable from Settings).
  // The bubble HTML renders the logo at 100vw x 100vh, so resizing the
  // window is all that's needed - no reload.
  function setBubbleSize(size) {
    const px = Math.max(40, Math.min(160, Math.round(Number(size)))) || 64;
    const next = overlayStore.save({ size: px });
    if (overlayWin && !overlayWin.isDestroyed()) {
      try {
        if (typeof overlayWin.setBounds === 'function') {
          const [x, y] = overlayWin.getPosition();
          overlayWin.setBounds({ x, y, width: px, height: px });
          assertTopmost(overlayWin); // setBounds can demote z-order
        } else {
          destroyOverlayWindow();
          ensureOverlayWindow();
        }
      } catch {
        // Worst case the new size applies on next launch via the store.
      }
    }
    return next;
  }

  // Live-updates the bubble's opacity by re-rendering its data-URL HTML
  // with the new value baked in.
  function setBubbleOpacity(opacity) {
    const raw = Number(opacity);
    const val = Number.isFinite(raw) ? Math.max(0.2, Math.min(1, raw)) : 0.92;
    const next = overlayStore.save({ opacity: val });
    if (overlayWin && !overlayWin.isDestroyed()) {
      try {
        overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(next))}`);
      } catch {
        // Applied on next launch via the store.
      }
    }
    return next;
  }

  // Adjustable logo shadow; zero is the shipped default and removes the
  // CSS filter entirely (no residual blur/halo around the floating bubble).
  function setBubbleShadow(shadowPx) {
    const raw = Number(shadowPx);
    const val = Number.isFinite(raw) ? Math.max(0, Math.min(24, Math.round(raw))) : 0;
    const next = overlayStore.save({ shadowPx: val });
    if (overlayWin && !overlayWin.isDestroyed()) {
      try {
        overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(next))}`);
      } catch {
        // Applied on next launch via the store.
      }
    }
    return next;
  }

  /**
   * Sync the customized in-app action wheel onto the bubble's double-tap
   * radial. `items` is an array of plain {id,title,url,type} (or null to
   * fall back to the classic default ring). Persisted, and the live
   * bubble HTML is rebuilt immediately so the next double-tap shows it.
   */
  function setWheelItems(items) {
    const sanitized = Array.isArray(items)
      ? items
          .filter((i) => i && i.id && i.title)
          .slice(0, 24)
          .map((i) => ({
            id: String(i.id),
            title: String(i.title).slice(0, 60),
            url: typeof i.url === 'string' && /^(https?:|yayra:)/i.test(i.url) ? i.url : null,
            type: i.type ? String(i.type) : null
          }))
      : null;
    const next = overlayStore.save({ wheelItems: sanitized && sanitized.length ? sanitized : null });
    if (overlayWin && !overlayWin.isDestroyed()) {
      try {
        overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(next))}`);
      } catch {
        // Applied on next launch via the store.
      }
    }
    return next;
  }

  function setOverlayAllApps(enabled) {
    const next = overlayStore.save({ overlayAllApps: Boolean(enabled) });
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setAlwaysOnTop(Boolean(enabled), 'screen-saver');
      if (typeof overlayWin.setVisibleOnAllWorkspaces === 'function') {
        overlayWin.setVisibleOnAllWorkspaces(Boolean(enabled), { visibleOnFullScreen: true });
      }
    }
    return next;
  }

  /**
   * Called once from app.whenReady(), independent of createWindow(), so the
   * bubble exists whether or not the user ever opens the full browser this
   * session - including the very first launch right after installation.
   */
  function initializeOnStartup() {
    const settings = overlayStore.load();
    // First run: nothing has been saved yet beyond the in-memory defaults,
    // so explicitly commit the "launch at startup" default to the OS once,
    // rather than only taking effect after the user visits Settings.
    applyLoginItemSettings(settings.launchAtStartup);
    if (settings.enabled) {
      ensureOverlayWindow();
    } else {
      // Not a bug, a persisted choice ("Hide bubble" / radial Hide) - but
      // say so, because a missing bubble otherwise looks like a crash.
      console.log('[yayra] floating bubble is disabled in overlay-settings.json - re-enable it in Settings (or the tray menu)');
    }
  }

  ipcMain.handle('yayra:overlay-open-dictionary-lookup', (_event, payload = {}) => openDictionaryLookupInMini(payload.url));
  ipcMain.handle('yayra:overlay-get-settings', () => overlayStore.load());
  ipcMain.handle('yayra:overlay-set-enabled', (_e, enabled) => setEnabled(enabled));
  ipcMain.handle('yayra:overlay-set-launch-at-startup', (_e, enabled) => setLaunchAtStartup(enabled));
  ipcMain.handle('yayra:overlay-set-overlay-all-apps', (_e, enabled) => setOverlayAllApps(enabled));
  ipcMain.handle('yayra:overlay-set-bubble-size', (_e, size) => setBubbleSize(size));
  ipcMain.handle('yayra:overlay-set-bubble-opacity', (_e, opacity) => setBubbleOpacity(opacity));
  ipcMain.handle('yayra:overlay-set-bubble-shadow', (_e, shadowPx) => setBubbleShadow(shadowPx));
  ipcMain.handle('yayra:overlay-set-wheel-items', (_e, items) => setWheelItems(items));
  ipcMain.on('yayra:overlay-restore', () => restoreMainWindow());
  // Single bubble click: toggle the floating mini browser (independent of
  // the main window). Right-click: quick menu with full-browser/quit.
  ipcMain.on('yayra:overlay-bubble-click', () => {
    if (stopBubbleMoveMode({ persist: true })) return; // click = drop here
    toggleMiniPanel();
  });
  ipcMain.on('yayra:overlay-bubble-menu', () => openBubbleMenu());
  // Settled tap-count gestures from the bubble renderer: 1 = mini,
  // 2 = full browser, 3 = lock/unlock position (see handleBubbleTap).
  ipcMain.on('yayra:overlay-bubble-tap', (_e, count) => {
    if (stopBubbleMoveMode({ persist: true })) return; // click = drop here
    handleBubbleTap(count);
  });
  // Manual drag loop (replaces the native drag region that swallowed all
  // left-button events): follow the OS cursor until pointerup.
  ipcMain.on('yayra:overlay-drag-start', (_e, offset) => {
    if (stopBubbleMoveMode({ persist: true })) return;
    beginBubbleDrag(offset);
  });
  ipcMain.on('yayra:overlay-drag-move', (_e, point) => moveBubbleDrag(point));
  ipcMain.on('yayra:overlay-drag-end', () => endBubbleDrag());
  // A circular button in the double-tap radial menu was pressed
  // (ai / mini / full / lock / hide / quit / close).
  ipcMain.on('yayra:overlay-radial-action', (_e, action) => handleRadialAction(action));
  // Settings toggle mirrors the triple-click lock.
  ipcMain.handle('yayra:overlay-set-position-locked', (_e, locked) => setPositionLocked(locked));
  // Sent from the mini shell's own chrome (close / expand buttons).
  ipcMain.on('yayra:overlay-mini-close', () => {
    if (miniWin && !miniWin.isDestroyed()) miniWin.hide();
  });
  ipcMain.on('yayra:overlay-mini-open-full', (_event, payload = {}) => {
    if (miniWin && !miniWin.isDestroyed()) miniWin.hide();
    const win = restoreMainWindow();
    // Hand the mini's CURRENT site over to the full browser, so "open
    // full browser" continues exactly where the user was - not a blank
    // main window. Internal yayra:// pages hand over too.
    const url = typeof payload.url === 'string' && /^(https?:|yayra:)/i.test(payload.url) ? payload.url : null;
    if (!url || !win || win.isDestroyed?.()) return;
    try {
      const deliver = () => {
        try { win.webContents.send('yayra:open-url', { url }); } catch { /* window closed */ }
      };
      if (typeof win.webContents?.isLoading === 'function' && win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', deliver);
      } else {
        deliver();
      }
    } catch { /* best effort - the main window is open either way */ }
  });
  // "Minimize to bubble" from the main window: hide the whole OS window;
  // the native bubble (always present) is the way back in.
  ipcMain.on('yayra:overlay-minimize-main', () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) win.hide();
    ensureOverlayWindow();
  });
  ipcMain.on('yayra:overlay-moved', (_e, position) => {
    if (position && typeof position.x === 'number' && typeof position.y === 'number') {
      overlayStore.save({ position });
    }
  });

  // Monitor layout changed (display unplugged, resolution switched):
  // pull the bubble back inside a visible work area immediately - it must
  // never end up stranded outside every screen.
  if (screen && typeof screen.on === 'function') {
    const reclampBubble = () => {
      try {
        if (!overlayWin || overlayWin.isDestroyed() || radialOpen) return;
        const [x, y] = overlayWin.getPosition();
        const size = overlayStore.load().size || 64;
        const clamped = clampToVisibleArea(x, y, size);
        if (clamped.x !== x || clamped.y !== y) positionBubbleAt(clamped.x, clamped.y);
      } catch { /* display race - next event will fix it */ }
    };
    screen.on('display-metrics-changed', reclampBubble);
    screen.on('display-removed', reclampBubble);
    screen.on('display-added', reclampBubble);
  }

  return {
    ensureOverlayWindow,
    destroyOverlayWindow,
    getOverlayWindow,
    ensureMiniWindow,
    destroyMiniWindow,
    getMiniWindow,
    toggleMiniPanel,
    restoreMainWindow,
    openBubbleMenu,
    setEnabled,
    setLaunchAtStartup,
    setOverlayAllApps,
    setBubbleSize,
    setBubbleOpacity,
    setBubbleShadow,
    setPositionLocked,
    togglePositionLock,
    handleBubbleTap,
    beginBubbleDrag,
    moveBubbleDrag,
    endBubbleDrag,
    clampToVisibleArea,
    positionBubbleAt,
    captureScreenshot,
    openRadialMenu,
    closeRadialMenu,
    isRadialOpen,
    handleRadialAction,
    openMiniPanelAt,
    openDictionaryLookupInMini,
    setWheelItems,
    initializeOnStartup,
    applyLoginItemSettings
  };
}

module.exports = { createOverlayBridge };
