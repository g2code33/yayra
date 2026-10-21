import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();
const require = createRequire(import.meta.url);
const { popupMenuWithRecovery } = require('../electron/nativeMenuGuard.cjs');
const { sanitizePageBounds, MIN_NATIVE_PAGE_Y } = require('../electron/webviewBridge.cjs');
const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

function fakeWindowControls() {
  const calls = { minimize: 0, maximize: 0, close: 0, dragStart: 0, dragMove: 0, dragEnd: 0 };
  return {
    calls,
    bridge: {
      minimize: () => { calls.minimize += 1; },
      toggleMaximize: () => { calls.maximize += 1; return Promise.resolve(false); },
      close: () => { calls.close += 1; },
      dragStart: () => { calls.dragStart += 1; },
      dragMove: () => { calls.dragMove += 1; },
      dragEnd: () => { calls.dragEnd += 1; }
    }
  };
}

async function makeShell({ controls = null } = {}) {
  if (controls) globalThis.window.yayra = { windowControls: controls };
  else delete globalThis.window.yayra;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const root = shell.render(container);
  return {
    shell,
    container,
    root,
    cleanup() {
      shell.destroy();
      container.remove();
      delete globalThis.window.yayra;
      for (const selector of ['.fb-tab-context-menu', '.fb-dropdown-scrim']) {
        for (const el of document.body.querySelectorAll(selector) || []) el.remove();
      }
    }
  };
}

function pointer(target, type, x, y = 10, pointerId = 41) {
  return {
    type,
    target,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    preventDefault() {},
    stopPropagation() {}
  };
}

test('tab pointer capture is delayed until a real reorder and renderer re-render revokes it synchronously', async () => {
  const h = await makeShell();
  try {
    h.shell.createNewTab('https://example.com/two');
    const root = h.shell.render(h.container);
    const row = root.querySelector('.fb-tabs-scroll-container');
    const tabs = row.querySelectorAll('.fb-tab-item');
    tabs.forEach((tab, index) => {
      tab.getBoundingClientRect = () => ({ left: index * 120, width: 120, right: (index + 1) * 120 });
    });
    let captures = 0;
    let releases = 0;
    tabs[0].setPointerCapture = () => { captures += 1; };
    tabs[0].releasePointerCapture = () => { releases += 1; };

    tabs[0].dispatchEvent(pointer(tabs[0], 'pointerdown', 10));
    assert.equal(captures, 0, 'an ordinary tab press owns no pointer capture');
    assert.equal(h.shell._activePointerCleanups.size, 1, 'the press still has global/lifecycle cleanup');

    tabs[0].dispatchEvent(pointer(tabs[0], 'pointermove', 180));
    assert.equal(captures, 1, 'capture begins only after crossing the reorder threshold');
    assert.ok(tabs[0].classList.contains('fb-tab-pointer-dragging'));

    h.shell.render(h.container); // native title/loading update during the held drag
    assert.equal(h.shell._activePointerCleanups.size, 0, 'render is a hard gesture-generation boundary');
    assert.equal(releases, 1, 'detached source releases its pointer capture');
    assert.equal(h.shell.rootElement.querySelector('.fb-tab-pointer-dragging'), null, 'new strip has no stale drag marker');

    const before = h.shell.state.tabs.length;
    h.shell.rootElement.querySelector('.fb-btn-newtab').click();
    assert.equal(h.shell.state.tabs.length, before + 1, 'New Tab remains clickable immediately after recovery');
  } finally {
    h.cleanup();
  }
});

test('lost pointerup heals through the legacy mouseup fallback and caption controls still work', async () => {
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  const listeners = new Map();
  window.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  window.removeEventListener = (type, fn) => {
    listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn));
  };
  const fake = fakeWindowControls();
  let h;
  try {
    h = await makeShell({ controls: fake.bridge });
    const tab = h.shell.rootElement.querySelector('.fb-tab-item');
    tab.dispatchEvent(pointer(tab, 'pointerdown', 12));
    assert.equal(h.shell._activePointerCleanups.size, 1);

    // Simulate the failure: no pointerup/pointercancel/lostpointercapture,
    // but Chromium's compatibility mouseup survives.
    for (const listener of [...(listeners.get('mouseup') || [])]) listener({ type: 'mouseup' });
    assert.equal(h.shell._activePointerCleanups.size, 0, 'fallback revokes the abandoned pointer lease');

    h.shell.rootElement.querySelector('.fb-wc-minimize').click();
    h.shell.rootElement.querySelector('.fb-wc-maximize').click();
    h.shell.rootElement.querySelector('.fb-wc-close').click();
    assert.deepEqual(
      { minimize: fake.calls.minimize, maximize: fake.calls.maximize, close: fake.calls.close },
      { minimize: 1, maximize: 1, close: 1 },
      'all caption controls remain live without refresh/restart'
    );
  } finally {
    h?.cleanup();
    window.addEventListener = originalAdd;
    window.removeEventListener = originalRemove;
  }
});

test('main-process recovery IPC revokes renderer capture even when DOM focus events are lost', async () => {
  const fake = fakeWindowControls();
  let nativeRecovery = null;
  let unsubscribed = 0;
  fake.bridge.onInputRecovery = (callback) => {
    nativeRecovery = callback;
    return () => { unsubscribed += 1; };
  };
  const h = await makeShell({ controls: fake.bridge });
  const tab = h.shell.rootElement.querySelector('.fb-tab-item');
  tab.dispatchEvent(pointer(tab, 'pointerdown', 10));
  assert.equal(h.shell._activePointerCleanups.size, 1);
  nativeRecovery({ reason: 'window-focus' });
  assert.equal(h.shell._activePointerCleanups.size, 0, 'native signal is independent of pointerup/blur DOM delivery');
  h.cleanup();
  assert.equal(unsubscribed, 1, 'native listener lifecycle is owned by the shell');
});

test('orphan tab-menu scrims auto-retire and a re-render closes a valid transient pair', async () => {
  const h = await makeShell();
  try {
    const orphan = document.createElement('button');
    orphan.className = 'fb-dropdown-scrim';
    orphan.setAttribute('data-tab-ctx', 'true');
    document.body.appendChild(orphan);
    h.shell.state.isPageObscured = true;

    const result = h.shell.recoverTopChromeInput('focus return');
    assert.equal(result.healed, true);
    assert.equal(document.body.querySelector('[data-tab-ctx]'), null, 'transparent orphan cannot keep intercepting top chrome');
    assert.equal(h.shell.state.isPageObscured, false, 'native/live page visibility is truth-healed too');

    const tab = h.shell.getActiveTab();
    h.shell.renderTabContextMenu(10, 10, tab);
    const menu = document.body.querySelector('.fb-tab-context-menu');
    const scrim = document.body.querySelector('[data-tab-ctx]');
    assert.ok(menu && scrim, 'fresh menu pair opens');
    assert.equal(scrim.style.top, '36px', 'outside-click scrim starts below the protected top row');
    assert.equal(menu.style.top, '40px', 'menu itself is clamped below tabs/caption controls');

    h.shell.render(h.container);
    assert.equal(document.body.querySelector('.fb-tab-context-menu'), null, 'render retires body-mounted menu');
    assert.equal(document.body.querySelector('[data-tab-ctx]'), null, 'render retires its scrim as one unit');
  } finally {
    h.cleanup();
  }
});

test('native page bounds can never cover the custom tab/caption row', () => {
  assert.equal(MIN_NATIVE_PAGE_Y, 36);
  assert.deepEqual(
    sanitizePageBounds({ x: 4, y: 0, width: 900, height: 700 }),
    { x: 4, y: 36, width: 900, height: 664 }
  );
  assert.deepEqual(
    sanitizePageBounds({ x: 4, y: 92, width: 900, height: 600 }),
    { x: 4, y: 92, width: 900, height: 600 },
    'correct renderer viewport bounds are untouched'
  );
  assert.deepEqual(sanitizePageBounds({ x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0, width: 0, height: 0 });
});

test('native menu guard closes exactly once on blur and on an independent safety timeout', () => {
  const makeOwner = () => {
    const events = new Map();
    const owner = {
      webContents: null,
      on(type, fn) {
        if (!events.has(type)) events.set(type, []);
        events.get(type).push(fn);
      },
      removeListener(type, fn) {
        events.set(type, (events.get(type) || []).filter((item) => item !== fn));
      },
      emit(type) { for (const fn of [...(events.get(type) || [])]) fn(); }
    };
    owner.webContents = owner;
    return owner;
  };
  const timers = new Map();
  let timerId = 0;
  const setTimeoutImpl = (fn, delay) => {
    const token = { id: ++timerId, delay, unref() {} };
    timers.set(token, fn);
    return token;
  };
  const clearTimeoutImpl = (token) => timers.delete(token);

  const owner = makeOwner();
  let closes = 0;
  let callbacks = 0;
  const menu = { popup() {}, closePopup() { closes += 1; } };
  popupMenuWithRecovery({
    menu, window: owner, callback: () => { callbacks += 1; },
    setTimeoutImpl, clearTimeoutImpl, timeoutMs: 5000
  });
  owner.emit('blur');
  owner.emit('hide');
  assert.equal(closes, 1, 'multiple lifecycle signals close the native popup only once');
  assert.equal(callbacks, 1, 'terminal callback is exactly once even if Electron drops its callback');
  assert.equal(timers.size, 0, 'blur cleanup removes the safety timer');

  const owner2 = makeOwner();
  let timeoutCloses = 0;
  popupMenuWithRecovery({
    menu: { popup() {}, closePopup() { timeoutCloses += 1; } },
    window: owner2,
    setTimeoutImpl,
    clearTimeoutImpl,
    timeoutMs: 5000
  });
  const deadline = [...timers.entries()].find(([token]) => token.delay === 5000);
  assert.ok(deadline, 'independent native-menu deadline is armed');
  timers.delete(deadline[0]);
  deadline[1]();
  assert.equal(timeoutCloses, 1, 'abandoned native OS input loop is forcibly closed');
});

test('source contract: native focus recovery crosses preload IPC and no top child can be a drag region', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  assert.match(preload, /onInputRecovery:[\s\S]{0,260}CHROME_INPUT_RECOVERY_CHANNEL/);
  assert.match(main, /window-focus[\s\S]{0,3000}CHROME_INPUT_RECOVERY_CHANNEL|CHROME_INPUT_RECOVERY_CHANNEL[\s\S]{0,5000}window-focus/);
  assert.match(main, /cancelForWebContents/);
  assert.match(css, /\.fb-chrome-tabstrip \*[\s\S]{0,220}-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.fb-dropdown-scrim\[data-tab-ctx="true"\][\s\S]{0,180}top:\s*36px/);
});
