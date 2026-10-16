/**
 * REGRESSION SUITE for "the app crashes on startup" (Ubuntu/desktop).
 *
 * The crash: createWindow() referenced `win` before its `const win =
 * mainWindow` declaration (temporal dead zone -> ReferenceError) the
 * moment the main window was created, so every normal launch died during
 * the app.whenReady() startup sequence. The desktop smoke harness could
 * not catch it: when the Electron runtime is absent it falls back to
 * string-matching the built DOM, and even with the runtime present the
 * uncaught exception is swallowed by the startup-error logger.
 *
 * This suite EXECUTES electron/main.cjs (and therefore its full ready
 * sequence: createWindow, overlay bubble, tray) under a mocked 'electron'
 * module and asserts it completes without throwing - exactly the code
 * path every desktop launch takes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function createElectronMock({ userDataDir }) {
  const windows = [];
  const readyCbs = [];
  const loadLog = [];

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
      appendSwitch: () => {},
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
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }), showErrorBox: () => {} },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
      getAllDisplays: () => [electronMock.screen.getPrimaryDisplay()],
      getDisplayNearestPoint: () => electronMock.screen.getPrimaryDisplay(),
      getDisplayMatching: () => electronMock.screen.getPrimaryDisplay(),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      on: () => {}
    },
    Tray: class {
      setToolTip() {} setContextMenu() {} setImage() {} on() {} destroy() {}
      isDestroyed() { return false; } setTitle() {}
    },
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

  return { electronMock, app, windows, loadLog };
}

/**
 * Load and boot electron/main.cjs under the mock. Returns the observable
 * startup effects. Throws (fails the test) if the ready sequence throws.
 */
async function bootMain() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-startup-'));
  const { electronMock, windows, loadLog } = createElectronMock({ userDataDir });

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    // Clear any previously loaded app modules so each boot re-executes them.
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.join(repoRoot, 'electron'))) delete require.cache[key];
    }
    require(path.join(repoRoot, 'electron', 'main.cjs'));
    // Let the whenReady microtask chain (the whole startup sequence) run.
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    Module._load = origLoad;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  return { windows, loadLog };
}

test('CONFIRMED: the full desktop startup sequence (createWindow + bubble + tray) runs without throwing', async () => {
  // Before the fix this threw:
  //   ReferenceError: Cannot access 'win' before initialization
  //   at createWindow (electron/main.cjs) - via the app.whenReady chain,
  // killing the app before any window appeared on every Ubuntu launch.
  const { windows, loadLog } = await bootMain();

  // The main browser window was created and pointed at the app shell.
  assert.ok(
    loadLog.some((u) => u.startsWith('yayra://app/index.html')),
    `main window must load the app shell (load log: ${JSON.stringify(loadLog)})`
  );
  // ...and the floating bubble window came up alongside it.
  assert.ok(windows.length >= 2, `expected main window + floating bubble, got ${windows.length} window(s)`);
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
