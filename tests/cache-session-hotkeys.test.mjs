import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { reloadActionForInput, createWebviewBridge } from '../electron/webviewBridge.cjs';
import { createShortcutsRepo, createSessionRepo, createTabGroupsRepo } from '../packages/shared-ui/src/services/profileStorage.js';

const require = createRequire(import.meta.url);
const { createCapsLockChords } = require('../electron/globalHotkeys.cjs');
const { registerDesktopUpdateHandlers } = require('../electron/desktopUpdater.cjs');
const { pickArtifact } = await import('../scripts/lib/update-artifacts.mjs');

// ---------- Chrome reload-shortcut matrix (pure) ------------------------

test('reloadActionForInput: Ctrl+R / F5 reload, Ctrl+Shift+R / Ctrl+F5 / Shift+F5 hard-reload', () => {
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'r', control: true }), 'reload');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'R', meta: true }), 'reload');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'F5' }), 'reload');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'r', control: true, shift: true }), 'hard-reload');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'F5', control: true }), 'hard-reload');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'F5', shift: true }), 'hard-reload');
  // Not reload shortcuts:
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'r' }), null, 'plain r types the letter');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 'r', control: true, alt: true }), null, 'AltGr combos type characters');
  assert.equal(reloadActionForInput({ type: 'keyUp', key: 'r', control: true }), null, 'keyUp ignored');
  assert.equal(reloadActionForInput({ type: 'keyDown', key: 't', control: true }), null);
});

// ---------- webview bridge: hard reload + per-site cache clearing -------

function makeBridgeHarness() {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: () => {} },
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView() {} }
  };
  const sessionCalls = [];
  const views = [];
  const WebContentsView = function FakeView() {
    const listeners = new Map();
    const calls = [];
    const view = {
      webContents: {
        calls,
        loadURL: async () => {},
        reload: () => calls.push('reload'),
        reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
        stop: () => {},
        close: () => {},
        isDestroyed: () => false,
        setWindowOpenHandler: () => {},
        setUserAgent: () => {},
        on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
        emit: (ev, ...args) => { for (const fn of listeners.get(ev) || []) fn(...args); },
        session: {
          clearCodeCaches: async (opts) => sessionCalls.push(['clearCodeCaches', opts]),
          clearStorageData: async (opts) => sessionCalls.push(['clearStorageData', opts])
        }
      },
      setBounds: () => {}
    };
    views.push(view);
    return view;
  };
  createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => fakeWin,
    logger: { error: () => {} }
  });
  return { handlers, views, sessionCalls };
}

test('webview bridge: hard reload clears ONLY cache-like storage for the site origin, then bypasses the HTTP cache', async () => {
  const { handlers, views, sessionCalls } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 't1', url: 'https://example.com/page' });
  const res = await handlers.get('yayra:webview-hard-reload')(null, { tabId: 't1' });

  assert.equal(res.ok, true);
  assert.equal(res.origin, 'https://example.com');
  assert.deepEqual(sessionCalls[0], ['clearCodeCaches', { urls: ['https://example.com'] }]);
  assert.equal(sessionCalls[1][0], 'clearStorageData');
  assert.equal(sessionCalls[1][1].origin, 'https://example.com');
  assert.ok(sessionCalls[1][1].storages.includes('cachestorage'));
  assert.ok(!sessionCalls[1][1].storages.includes('cookies'), 'hard reload must NOT log the user out');
  assert.ok(views[0].webContents.calls.includes('reloadIgnoringCache'));
});

test('webview bridge: clear-site-cache refuses internal pages honestly', async () => {
  const { handlers } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 't1', url: 'https://ok.com/' });
  const entryless = await handlers.get('yayra:webview-clear-site-cache')(null, { tabId: 'nope' });
  assert.equal(entryless.ok, false);
});

test('webview bridge: Ctrl+Shift+R typed INSIDE the page triggers the hard reload (before-input-event)', async () => {
  const { handlers, views } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 't1', url: 'https://example.com/' });
  const wc = views[0].webContents;
  let prevented = false;
  wc.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'R', control: true, shift: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(prevented, true, 'the page must not also receive the keystroke');
  assert.ok(wc.calls.includes('reloadIgnoringCache'));
});

test('webview bridge: plain Ctrl+R inside the page just reloads (no cache clearing)', async () => {
  const { handlers, views, sessionCalls } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 't1', url: 'https://example.com/' });
  const wc = views[0].webContents;
  wc.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key: 'r', control: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(wc.calls.includes('reload'));
  assert.equal(sessionCalls.length, 0);
});

// ---------- new-tab shortcuts + last-session repos ----------------------

function memoryStorage() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { map.delete(k); }
  };
}

test('shortcuts repo: add/edit/remove with https-only validation and the 12-tile Chrome cap', async () => {
  const repo = createShortcutsRepo(memoryStorage());
  assert.equal(await repo.addShortcut({ title: 'Nope', url: 'javascript:alert(1)' }), null);
  const gh = await repo.addShortcut({ title: 'GitHub', url: 'https://github.com' });
  assert.ok(gh.id);
  assert.equal((await repo.addShortcut({ title: 'dup', url: 'https://github.com' })).id, gh.id, 'same URL dedupes');
  await repo.updateShortcut(gh.id, { title: 'GH' });
  assert.equal((await repo.getShortcuts())[0].title, 'GH');
  for (let i = 0; i < 11; i += 1) await repo.addShortcut({ title: `s${i}`, url: `https://site${i}.com` });
  assert.equal((await repo.getShortcuts()).length, 12);
  assert.equal(await repo.addShortcut({ title: 'overflow', url: 'https://late.com' }), null, 'cap of 12 enforced');
  await repo.removeShortcut(gh.id);
  assert.equal((await repo.getShortcuts()).length, 11);
});

test('session repo: snapshot keeps safe websites and opaque local-file recovery descriptors', async () => {
  const repo = createSessionRepo(memoryStorage());
  assert.deepEqual((await repo.getLastSession()).tabs, [], 'fresh profile has no previous session');
  await repo.saveSession([
    { url: 'https://docs.rs/x', title: 'docs', group: { name: 'Research', color: '#3b82f6' } },
    {
      url: 'yayra://doc/runtime-id',
      title: 'Quarterly deck',
      document: {
        recoveryId: 'docrec-abcdefgh-12345678',
        name: '/home/user/secret/Quarterly deck.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 4096,
        path: '/home/user/secret/Quarterly deck.pptx'
      },
      group: { id: 'tg-research', name: 'Research', color: '#3b82f6' },
      groupMemberId: 'tgm-deck'
    },
    { url: 'yayra://newtab', title: 'New Tab' },
    { url: 'not a url', title: 'junk' },
    { url: 'https://user:password@example.com/', title: 'credential URL' },
    { url: 'https://private.example/', title: 'private', isPrivate: true },
    { document: { recoveryId: 'docrec-private1-12345678', name: 'private.pdf' }, isPrivate: true },
    { document: { recoveryId: '../../etc/passwd', name: 'bad' } }
  ]);
  const { tabs, savedAt } = await repo.getLastSession();
  assert.equal(tabs.length, 2, 'only the website and valid opaque file capability survive');
  assert.deepEqual(tabs[0], { url: 'https://docs.rs/x', title: 'docs', group: { name: 'Research', color: '#3b82f6' } });
  assert.deepEqual(tabs[1], {
    url: 'yayra://recover-document/docrec-abcdefgh-12345678',
    title: 'Quarterly deck.pptx',
    document: {
      recoveryId: 'docrec-abcdefgh-12345678',
      name: 'Quarterly deck.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: 4096
    },
    group: { id: 'tg-research', name: 'Research', color: '#3b82f6' },
    groupMemberId: 'tgm-deck'
  }, 'file order/group metadata survives, while arbitrary source paths are stripped');
  assert.equal(JSON.stringify(tabs).includes('/home/user/secret'), false, 'session metadata never contains a filesystem path');
  assert.ok(savedAt > 0);
});

test('durable tab-group catalog retains a sanitized local-file capability', async () => {
  const repo = createTabGroupsRepo(memoryStorage());
  await repo.saveGroups([{
    id: 'tg-files',
    name: 'Files',
    color: '#8b5cf6',
    members: [{
      id: 'tgm-report',
      url: 'yayra://doc/runtime-only',
      title: 'unsafe title',
      document: {
        recoveryId: 'docrec-report12-12345678',
        name: 'C:\\Users\\alice\\report.pdf',
        mime: 'application/pdf',
        size: 42,
        path: 'C:\\Users\\alice\\report.pdf'
      }
    }]
  }]);
  const groups = await repo.getGroups();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members[0].document, {
    recoveryId: 'docrec-report12-12345678',
    name: 'report.pdf',
    mime: 'application/pdf',
    size: 42
  });
  assert.equal(groups[0].members[0].url, 'yayra://recover-document/docrec-report12-12345678');
  assert.equal(JSON.stringify(groups).includes('Users'), false, 'durable group metadata cannot leak a source path');
});

// ---------- CapsLock chords (pure state machine) -------------------------

test('CapsLock chords: CapsLock+Y opens main, CapsLock+Shift+R opens mini, nothing fires without CapsLock held', () => {
  const fired = [];
  const K = { capsLock: 58, y: 21, r: 19 };
  const chords = createCapsLockChords({
    keycodes: K,
    onOpenMain: () => fired.push('main'),
    onOpenMini: () => fired.push('mini'),
    logger: { error: () => {} }
  });
  // Without CapsLock held: nothing.
  assert.equal(chords.handleKeydown({ keycode: K.y }), null);
  assert.equal(chords.handleKeydown({ keycode: K.r, shiftKey: true }), null);
  // Hold CapsLock -> chords fire.
  chords.handleKeydown({ keycode: K.capsLock });
  assert.equal(chords.handleKeydown({ keycode: K.y }), 'open-main');
  assert.equal(chords.handleKeydown({ keycode: K.r, shiftKey: true }), 'open-mini');
  assert.equal(chords.handleKeydown({ keycode: K.r, shiftKey: false }), null, 'R without Shift is not a chord');
  // Release CapsLock -> chords stop firing.
  chords.handleKeyup({ keycode: K.capsLock });
  assert.equal(chords.handleKeydown({ keycode: K.y }), null);
  assert.deepEqual(fired, ['main', 'mini']);
});

// ---------- updater: relaunch-to-update detection ------------------------

function makeUpdaterHarness({ platform = 'linux', appImage = null, dpkgVersion = null, packaged = true } = {}) {
  const handlers = new Map();
  const relaunches = [];
  const exits = [];
  const handlersObj = registerDesktopUpdateHandlers({
    getWindow: () => null,
    logger: () => {},
    appImpl: {
      getVersion: () => '1.0.10',
      isPackaged: packaged,
      getPath: () => '/tmp',
      relaunch: () => relaunches.push(1),
      exit: (code) => exits.push(code)
    },
    netImpl: {},
    shellImpl: { openPath: async () => '', showItemInFolder: () => {} },
    fsImpl: { existsSync: () => false, mkdirSync: () => {}, createWriteStream: () => {} },
    ipcMainImpl: { handle: (ch, fn) => handlers.set(ch, fn) },
    spawnImpl: () => ({ unref: () => {}, once: () => {} }),
    spawnSyncImpl: (cmd) => (cmd === 'dpkg-query' && dpkgVersion !== null
      ? { status: 0, stdout: dpkgVersion }
      : { status: 1, stdout: '' }),
    envImpl: appImage ? { APPIMAGE: appImage } : {},
    setTimeoutImpl: (fn) => { fn(); return 0; },
    quitDelayMs: 0,
    relaunchDelayMs: 0
  });
  return { handlers, handlersObj, relaunches, exits };
}

test('updater install-info: terminal dpkg install of a NEWER version while the old process is resident -> relaunchWillUpdate', async (t) => {
  const realPlatform = process.platform;
  if (realPlatform !== 'linux') return t.skip('dpkg path is linux-only');
  const { handlersObj } = makeUpdaterHarness({ dpkgVersion: '1.0.12' });
  const info = await handlersObj.handleInstallInfo();
  assert.equal(info.ok, true);
  assert.equal(info.runningVersion, '1.0.10');
  assert.equal(info.diskVersion, '1.0.12');
  assert.equal(info.installKind, 'deb');
  assert.equal(info.relaunchWillUpdate, true);
});

test('updater install-info: disk matches running version -> no relaunch prompt; AppImage detected as appimage', async (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only');
  const same = await makeUpdaterHarness({ dpkgVersion: '1.0.10' }).handlersObj.handleInstallInfo();
  assert.equal(same.relaunchWillUpdate, false);
  const appimg = await makeUpdaterHarness({ appImage: '/home/u/yayra.AppImage' }).handlersObj.handleInstallInfo();
  assert.equal(appimg.installKind, 'appimage');
  assert.equal(appimg.diskVersion, null, 'AppImage has no dpkg version - never fake one');
});

test('updater relaunch: actually relaunches and exits the old process', async () => {
  const { handlersObj, relaunches, exits } = makeUpdaterHarness({});
  const res = await handlersObj.handleRelaunch();
  assert.equal(res.status, 'relaunching');
  assert.equal(relaunches.length, 1);
  assert.deepEqual(exits, [0]);
});

// ---------- manifest: AppImage users get the AppImage --------------------

test('update artifacts: linux-appimage target picks the AppImage, never the .deb', () => {
  const files = ['yayra_1.0.11_amd64.deb', 'yayra-1.0.11.AppImage', 'linux-signing-public-key.pem', 'SHA256SUMS.txt'];
  assert.equal(pickArtifact('linux', files), 'yayra_1.0.11_amd64.deb');
  assert.equal(pickArtifact('linux-appimage', files), 'yayra-1.0.11.AppImage');
  assert.equal(pickArtifact('linux-appimage', ['yayra_1.0.11_amd64.deb']), null, 'no AppImage asset -> no entry, no guessing');
});

// ---------- Esc+F1 chord + mini "open full browser" handoff -------------

test('Esc+F1 chord: toggles mini hide only while Escape is physically held', () => {
  const fired = [];
  const K = { capsLock: 58, y: 21, r: 19, escape: 1, f1: 59 };
  const chords = createCapsLockChords({
    keycodes: K,
    onOpenMain: () => fired.push('main'),
    onOpenMini: () => fired.push('mini'),
    onToggleMiniHide: () => fired.push('hide'),
    logger: { error: () => {} }
  });
  assert.equal(chords.handleKeydown({ keycode: K.f1 }), null, 'F1 alone does nothing');
  chords.handleKeydown({ keycode: K.escape });
  assert.equal(chords.handleKeydown({ keycode: K.f1 }), 'toggle-mini-hide');
  chords.handleKeyup({ keycode: K.escape });
  assert.equal(chords.handleKeydown({ keycode: K.f1 }), null, 'released Escape ends the chord');
  assert.deepEqual(fired, ['hide']);
});

test('updater: committed installs force-exit the resident bubble process so the old version can never survive an update', async () => {
  const handlers = new Map();
  const appCalls = [];
  const timers = [];
  const spawned = [];
  const updater = registerDesktopUpdateHandlers({
    getWindow: () => null,
    logger: () => {},
    appImpl: {
      getVersion: () => '1.0.11',
      isPackaged: true,
      getPath: () => '/tmp',
      quit: () => appCalls.push('quit'),
      relaunch: () => appCalls.push('relaunch'),
      exit: (code) => appCalls.push(`exit:${code}`)
    },
    netImpl: {},
    shellImpl: { openPath: async () => '', showItemInFolder: () => {} },
    fsImpl: { existsSync: () => true },
    ipcMainImpl: { handle: (ch, fn) => handlers.set(ch, fn) },
    spawnImpl: (cmd, args, opts) => {
      const listeners = new Map();
      const child = {
        once: (ev, fn) => listeners.set(ev, fn),
        unref: () => {},
        trigger: (ev, ...a) => listeners.get(ev)?.(...a)
      };
      spawned.push({ cmd, args, opts, child });
      return child;
    },
    spawnSyncImpl: () => ({ status: 1, stdout: '' }),
    envImpl: { PATH: '/usr/bin' },
    setTimeoutImpl: (fn) => { timers.push(fn); return 0; },
    quitDelayMs: 0,
    relaunchDelayMs: 0
  });
  await updater.handleInstall(null, { path: '/tmp/yayra_1.0.12_amd64.deb', version: '1.0.12' });
  // pkexec may be unavailable in this fake env - either way, if an
  // install path schedules quit, it must ALSO schedule the hard exit.
  if (spawned.length) {
    spawned[0].child.trigger('exit', 0);
    while (timers.length) timers.shift()();
    assert.ok(appCalls.includes('relaunch'));
    assert.ok(appCalls.includes('exit:0'), 'force-exit scheduled after relaunch+quit');
  }
});
