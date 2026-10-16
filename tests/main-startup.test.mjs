/**
 * REGRESSION SUITE for "the app crashes on startup" (Ubuntu/desktop).
 *
 * The crash: createWindow() referenced `win` before its `const win =
 * mainWindow` declaration (temporal dead zone -> ReferenceError) the
 * moment the main window was created, so every normal launch died during
 * the app.whenReady() startup sequence. The desktop smoke harness could
 * not catch it: when the Electron runtime is absent it falls back to
 * string-matching the built DOM, and the async whenReady chain turned the
 * throw into a bare UnhandledPromiseRejectionWarning that bypassed the
 * startup-error logger and error box entirely.
 *
 * This suite EXECUTES electron/main.cjs (and therefore its full ready
 * sequence: createWindow, overlay bubble, tray) under a mocked 'electron'
 * module (and a mocked uiohook-napi - the startup suite must never touch
 * the native keyboard-hook binary) and asserts:
 *   1. the startup sequence completes without throwing;
 *   2. `win` stays declared-before-use in createWindow;
 *   3. a throw in the startup sequence is ROUTED to startup-error.log and
 *      the native error box (the old silent-zombie regression);
 *   4. the no-VA-driver policy reaches the Chromium command line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Deterministic session type: force the plain-x11 branch (no Wayland
// relaunch, no missing-display warning path) regardless of CI env.
delete process.env.WAYLAND_DISPLAY;
process.env.DISPLAY = process.env.DISPLAY || ':0';
delete process.env.YAYRA_SMOKE;
delete process.env.IBROWSE_SMOKE;
delete process.env.YAYRA_FORCE_BAD_LOAD;
delete process.env.IBROWSE_FORCE_BAD_LOAD;
delete process.env.YAYRA_SOFTWARE_RENDER;
delete process.env.APPIMAGE;

function makeWebContents() {
  return new Proxy({
    session: { clearCache: async () => {}, clearStorageData: async () => {}, getCacheSize: async () => 0, clearCodeCaches: async () => {} },
    on: () => {}, once: () => {}, removeListener: () => {}, off: () => {},
    send: () => {}, setWindowOpenHandler: () => {}, setUserAgent: () => {},
    loadURL: () => Promise.resolve(), loadFile: () => Promise.resolve(),
    getURL: () => 'yayra://app/index.html', getTitle: () => 'yayra',
    isDestroyed: () => false, executeJavaScript: () => Promise.resolve({}),
    capturePage: () => Promise.resolve({ toPNG: () => Buffer.alloc(0) }),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    getPrintersAsync: async () => [], printToPDF: async () => Buffer.alloc(0),
    openDevTools: () => {}, closeDevTools: () => {}, setAudioMuted: () => {}
  }, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'then') return undefined;
      return () => undefined;
    }
  });
}

function createElectronMock({ userDataDir, mutateMock } = {}) {
  const windows = [];
  const readyCbs = [];
  const loadLog = [];
  const appendSwitches = [];
  const errorBoxes = [];

  class FakeBrowserWindow {
    constructor(opts = {}) {
      this.options = opts;
      this.webContents = makeWebContents();
      this._bounds = { x: 0, y: 0, width: opts.width || 1200, height: opts.height || 800 };
      this._destroyed = false;
      windows.push(this);
      return new Proxy(this, {
        get(t, p) {
          if (p in t) return t[p];
          if (p === 'then') return undefined;
          return () => undefined;
        }
      });
    }
    loadURL(url) { loadLog.push(String(url).slice(0, 120)); return Promise.resolve(); }
    loadFile(file) { loadLog.push(`file:${path.basename(file)}`); return Promise.resolve(); }
    on() {} once() {} removeListener() {}
    show() {} hide() {} focus() {} blur() {} close() {} destroy() { this._destroyed = true; }
    isDestroyed() { return this._destroyed; }
    isMinimized() { return false; } isMaximized() { return false; } isVisible() { return true; }
    isFocused() { return true; } isAlwaysOnTop() { return true; }
    restore() {} minimize() {} maximize() {} unmaximize() {} center() {} moveTop() {}
    setAlwaysOnTop() {} setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
    getBounds() { return this._bounds; } getTitle() { return 'yayra'; }
    static getAllWindows() { return windows.filter((w) => !w._destroyed); }
    static fromWebContents() { return windows[0] || null; }
    static getFocusedWindow() { return windows[0] || null; }
    static fromId() { return null; }
  }

  class FakeTray {
    constructor(...args) {
      this.iconArgs = args;
    }
    setToolTip() {} setContextMenu() {} setImage() {} on() {} destroy() {}
    isDestroyed() { return false; } setTitle() {}
  }

  const sessionStub = {
    clearCache: async () => {}, clearStorageData: async () => {}, getCacheSize: async () => 0,
    clearCodeCaches: async () => {}, clearAuthCache: async () => {},
    cookies: { get: async () => [], remove: async () => {}, set: async () => {} },
    webRequest: { onBeforeSendHeaders: () => {}, onBeforeRequest: () => {}, onHeadersReceived: () => {} },
    setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
    setSpellCheckerEnabled: () => {}, clearHostResolverCache: async () => {},
    allowNTLMCredentialsForDomains: () => {}, setProxy: async () => {},
    on: () => {}, once: () => {}, removeListener: () => {}, off: () => {}, downloadURL: () => {}
  };

  const app = {
    commandLine: {
      appendSwitch: (key, value) => { appendSwitches.push([key, value]); },
      hasSwitch: (s) => process.argv.some((x) => x === `--${s}` || x.startsWith(`--${s}=`)),
      appendArgument: () => {}
    },
    getPath: (name) => {
      if (name === 'userData') return userDataDir;
      if (name === 'home') return os.homedir();
      if (name === 'temp') return os.tmpdir();
      return path.join(userDataDir, name || 'x');
    },
    getVersion: () => '1.0.40',
    getName: () => 'yayra',
    getAppPath: () => repoRoot,
    getLocale: () => 'en-US',
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    quit: () => {}, exit: () => {}, relaunch: () => {},
    whenReady: () => Promise.resolve().then(() => { readyCbs.forEach((cb) => cb()); }),
    on: (ev, cb) => { if (ev === 'ready') readyCbs.push(cb); },
    once: () => {}, removeListener: () => {},
    isReady: () => true,
    isPackaged: true,
    disableHardwareAcceleration: () => {},
    setAppUserModelId: () => {},
    addLoginItemSettings: () => {}, removeLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {}
  };

  const electronMock = {
    app,
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: class {
      constructor() { this.webContents = makeWebContents(); }
      setBounds() {} getBounds() { return {}; } setBorderRadius() {} setVisible() {}
    },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, handleOnce: () => {} },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    net: { fetch: async () => { throw new Error('offline'); } },
    shell: { openExternal: async () => {}, openPath: async () => '', writeShortcutLink: () => true, beep: () => {}, showItemInFolder: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
    clipboard: { readText: () => '', writeText: () => {}, readImage: () => ({ toPNG: () => Buffer.alloc(0) }), writeImage: () => {}, availableFormats: () => [] },
    session: { defaultSession: sessionStub, fromPartition: () => sessionStub },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox: (title, message) => { errorBoxes.push({ title, message }); }
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
      getAllDisplays: () => [electronMock.screen.getPrimaryDisplay()],
      getDisplayNearestPoint: () => electronMock.screen.getPrimaryDisplay(),
      getDisplayMatching: () => electronMock.screen.getPrimaryDisplay(),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      on: () => {}
    },
    Tray: FakeTray,
    nativeImage: {
      createFromPath: (p) => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0), resize: () => electronMock.nativeImage.createFromPath(p), getSize: () => ({ width: 32, height: 32 }) }),
      createFromBuffer: (b) => ({ isEmpty: () => b.length === 0, toPNG: () => b, resize: () => electronMock.nativeImage.createFromBuffer(b), getSize: () => ({ width: 32, height: 32 }) }),
      createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), resize: () => electronMock.nativeImage.createEmpty(), getSize: () => ({ width: 0, height: 0 }) })
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
    desktopCapturer: { getSources: async () => [] },
    webContents: { getAllWebContents: () => [], getFocusedWebContents: () => null, on: () => {} },
    globalShortcut: { register: () => true, unregisterAll: () => {}, unregister: () => {} }
  };

  if (typeof mutateMock === 'function') mutateMock({ electronMock, windows, loadLog, appendSwitches, errorBoxes });

  return { electronMock, app, windows, loadLog, appendSwitches, errorBoxes };
}

/**
 * Wait for the (fully mocked, but async) startup sequence to settle.
 *
 * A fixed `sleep(400)` is a coin flip on a loaded CI runner - `npm test`
 * executes ~100 test files in parallel, so a chain that takes 50ms on an
 * idle machine can take seconds under contention (and the v1.0.41 release
 * run failed exactly this way). Instead: poll the observable startup
 * effects until (a) SOMETHING happened (a window, an error box, or a
 * startup-error.log entry) and (b) nothing changed for `quietMs`. Falls
 * through after `timeoutMs` so a broken boot fails on the assertions
 * instead of hanging the suite.
 */
async function settleStartup({ probe, started, timeoutMs = 20000, quietMs = 300, intervalMs = 25 }) {
  const deadline = Date.now() + timeoutMs;
  let last = probe();
  let lastChange = Date.now();
  let seenStart = started();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const now = probe();
    seenStart = seenStart || started();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
      continue;
    }
    if (seenStart && Date.now() - lastChange >= quietMs) return;
  }
}

/**
 * Hermetic stand-in for the uiohook-napi NATIVE module. On CI runners the
 * real binding loads (X11 libs are installed) and start() tries to open an
 * X display; headless machines hit libuiohook's fast-fail path whose
 * condition-signal can race the waiting parent thread into a lost-wakeup
 * deadlock (uv_cond_wait) - freezing the whole test process. The chords
 * state machine is dependency-injected and unit-tested on its own; the
 * startup suite only needs the documented wiring, so native code stays out.
 */
function createUiohookFake() {
  const listeners = {};
  return {
    uIOhook: {
      on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
      start: () => {},
      stop: () => {}
    },
    UiohookKey: { CapsLock: 0x003a, Escape: 0x0001, F1: 0x003b, R: 0x0013, Y: 0x0015 },
    listeners
  };
}

/**
 * Load and boot electron/main.cjs under the mock. Returns the observable
 * startup effects. Throws (fails the test) if the ready sequence throws
 * uncaught; caught startup failures are observable via errorBoxes and the
 * userDataDir/startup-error.log file.
 */
async function bootMain({ mutateMock, env = {} } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-startup-'));
  const startupErrorLogPath = path.join(userDataDir, 'startup-error.log');
  const { electronMock, windows, loadLog, appendSwitches, errorBoxes } = createElectronMock({ userDataDir, mutateMock });
  const uiohookFake = createUiohookFake();

  const envApplied = [];
  for (const [k, v] of Object.entries(env)) {
    envApplied.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // main.cjs registers process-level error handlers; snapshot so each boot
  // can remove exactly the listeners it added (keep the test runner's own).
  const beforeUncaught = new Set(process.listeners('uncaughtException'));
  const beforeRejection = new Set(process.listeners('unhandledRejection'));

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'uiohook-napi') return uiohookFake;
    return origLoad.call(this, request, parent, isMain);
  };
  let loadError = null;
  try {
    // Clear any previously loaded app modules so each boot re-executes them.
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(repoRoot, 'electron'))) delete require.cache[key];
    }
    require(path.join(repoRoot, 'electron', 'main.cjs'));
    // Let the whenReady chain (the whole startup sequence) run to
    // completion - condition-based, never a fixed sleep (see settleStartup).
    await settleStartup({
      probe: () => JSON.stringify([
        windows.length,
        loadLog.length,
        appendSwitches.length,
        errorBoxes.length,
        fs.existsSync(startupErrorLogPath) ? fs.statSync(startupErrorLogPath).size : -1
      ]),
      started: () => windows.length > 0 || errorBoxes.length > 0 || fs.existsSync(startupErrorLogPath)
    });
  } catch (err) {
    loadError = err;
  } finally {
    Module._load = origLoad;
    for (const l of process.listeners('uncaughtException')) {
      if (!beforeUncaught.has(l)) process.removeListener('uncaughtException', l);
    }
    for (const l of process.listeners('unhandledRejection')) {
      if (!beforeRejection.has(l)) process.removeListener('unhandledRejection', l);
    }
    for (const [k, v] of envApplied) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  if (loadError) throw loadError;
  return {
    windows,
    loadLog,
    appendSwitches,
    errorBoxes,
    startupErrorLogPath: path.join(userDataDir, 'startup-error.log'),
    readStartupErrorLog() {
      try { return fs.readFileSync(path.join(userDataDir, 'startup-error.log'), 'utf8'); } catch { return ''; }
    },
    cleanup() { fs.rmSync(userDataDir, { recursive: true, force: true }); }
  };
}

test('CONFIRMED: the full desktop startup sequence (createWindow + bubble + tray) runs without throwing', async () => {
  // Before the fix this threw:
  //   ReferenceError: Cannot access 'win' before initialization
  //   at createWindow (electron/main.cjs) - via the app.whenReady chain,
  // killing the app before any window appeared on every Ubuntu launch.
  const boot = await bootMain();
  try {
    // The main browser window was created and pointed at the app shell.
    assert.ok(
      boot.loadLog.some((u) => u.startsWith('yayra://app/index.html')),
      `main window must load the app shell (load log: ${JSON.stringify(boot.loadLog)})`
    );
    // ...and the floating bubble window came up alongside it.
    assert.ok(boot.windows.length >= 2, `expected main window + floating bubble, got ${boot.windows.length} window(s)`);
    // A clean startup must never write the crash log.
    assert.equal(boot.readStartupErrorLog(), '', 'no startup-error.log on a clean boot');
  } finally {
    boot.cleanup();
  }
});

test('CONFIRMED: createWindow keeps its `win` binding above every use (no TDZ use-before-declaration)', () => {
  const mainCjs = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const fnStart = mainCjs.indexOf('function createWindow()');
  assert.ok(fnStart !== -1, 'createWindow exists');
  const body = mainCjs.slice(fnStart);
  const declAt = body.indexOf('const win = mainWindow;');
  assert.ok(declAt !== -1, 'createWindow binds win from mainWindow');
  const firstUseAt = body.search(/\bwin\./);
  assert.ok(firstUseAt !== -1, 'createWindow uses win');
  assert.ok(firstUseAt > declAt, 'every `win.` use must come after `const win = mainWindow` (temporal dead zone crash otherwise)');
});

test('CONFIRMED: a throw in the startup sequence lands in startup-error.log AND the error box (no silent zombie)', async () => {
  // The v1.0.39/40 crash surfaced only as UnhandledPromiseRejectionWarning
  // on stderr: startup-error.log was never written and no error box
  // appeared, so the app looked like it silently crashed. Inject an
  // unguarded startup failure (Menu.setApplicationMenu throws - it is
  // called bare in the ready sequence) and assert the failure is reported
  // through BOTH documented channels.
  const boot = await bootMain({
    mutateMock: ({ electronMock }) => {
      electronMock.Menu.setApplicationMenu = () => { throw new Error('menu exploded'); };
    }
  });
  try {
    const log = boot.readStartupErrorLog();
    assert.match(log, /startup-sequence/, 'startup-error.log must record the failing startup sequence');
    assert.match(log, /menu exploded/, 'startup-error.log must carry the original error');
    assert.equal(boot.errorBoxes.length, 1, 'the native error box must be shown');
    assert.match(boot.errorBoxes[0].message, /menu exploded/);
  } finally {
    boot.cleanup();
  }
});

test('CONFIRMED: no VA-API driver -> VA-API video paths disabled on the Chromium command line before ready', async () => {
  const boot = await bootMain({ env: { YAYRA_DISABLE_VAAPI: '1' } });
  try {
    const disableFeatures = boot.appendSwitches.find(([key]) => key === 'disable-features');
    assert.ok(disableFeatures, 'disable-features switch must be appended');
    assert.match(disableFeatures[1], /VaapiVideoDecodeLinuxGL/);
    assert.ok(
      boot.appendSwitches.some(([key]) => key === 'disable-accelerated-video-decode'),
      'accelerated video decode must be disabled when no VA-API driver exists'
    );
  } finally {
    boot.cleanup();
  }
});

test('CONFIRMED: YAYRA_KEEP_VAAPI=1 opts out - no VA-API switches are appended', async () => {
  const boot = await bootMain({ env: { YAYRA_KEEP_VAAPI: '1', YAYRA_DISABLE_VAAPI: undefined } });
  try {
    assert.ok(
      !boot.appendSwitches.some(([key]) => key === 'disable-accelerated-video-decode'),
      'opt-out must leave VA-API/video decode switches alone'
    );
  } finally {
    boot.cleanup();
  }
});
