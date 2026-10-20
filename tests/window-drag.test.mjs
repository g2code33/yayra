import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindowDragController } = require('../electron/windowDrag.cjs');

function harness() {
  const listeners = new Map();
  const ipcMain = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }
  };
  const timers = new Map();
  let nextTimer = 1;
  const setTimeoutImpl = (callback, delay) => {
    const token = { id: nextTimer++, delay, unref() {} };
    timers.set(token, callback);
    return token;
  };
  const clearTimeoutImpl = (token) => timers.delete(token);
  const fireDelay = (delay) => {
    const entry = [...timers.entries()].find(([token]) => token.delay === delay);
    assert.ok(entry, `expected a ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1]();
  };
  const positions = [];
  const win = {
    destroyed: false,
    maximized: false,
    fullscreen: false,
    isDestroyed() { return this.destroyed; },
    isMaximized() { return this.maximized; },
    isFullScreen() { return this.fullscreen; },
    getPosition() { return [300, 120]; },
    setPosition(x, y, animate) { positions.push([x, y, animate]); }
  };
  const BrowserWindow = { fromWebContents: (sender) => sender?.window || null };
  const controller = createWindowDragController({
    ipcMain, BrowserWindow, setTimeoutImpl, clearTimeoutImpl,
    logger: { warn() {} }
  });
  const sender = { id: 44, window: win };
  const event = { sender };
  return { controller, event, win, positions, listeners, timers, fireDelay };
}

test('manual window drag is sender-scoped, coalesced, flushed and cleaned up', () => {
  const h = harness();
  assert.deepEqual([...h.listeners.keys()].sort(), [
    'yayra:window-drag-end',
    'yayra:window-drag-move',
    'yayra:window-drag-start'
  ]);

  h.listeners.get('yayra:window-drag-start')(h.event, { x: 500, y: 250 });
  assert.equal(h.controller.activeCount(), 1);
  h.listeners.get('yayra:window-drag-move')(h.event, { x: 508, y: 260 });
  h.listeners.get('yayra:window-drag-move')(h.event, { x: 530, y: 280 });
  assert.deepEqual(h.positions, [], 'high-frequency moves wait for one frame deadline');
  h.fireDelay(16);
  assert.deepEqual(h.positions, [[330, 150, false]], 'only the latest pointer coordinate is applied');

  h.listeners.get('yayra:window-drag-move')(h.event, { x: 550, y: 290 });
  h.listeners.get('yayra:window-drag-end')(h.event);
  assert.deepEqual(h.positions.at(-1), [350, 160, false], 'pointerup flushes the final movement');
  assert.equal(h.controller.activeCount(), 0);
  assert.equal(h.timers.size, 0, 'frame and lost-pointer safety timers cannot leak');

  h.controller.destroy();
  assert.equal(h.listeners.size, 0, 'destroy unregisters every IPC listener');
});

test('manual drag rejects invalid, maximized, destroyed, and cross-sender movement', () => {
  const h = harness();
  h.win.maximized = true;
  assert.equal(h.controller.begin(h.event, { x: 1, y: 2 }), false);
  h.win.maximized = false;
  assert.equal(h.controller.begin(h.event, { x: Number.NaN, y: 2 }), false);
  assert.equal(h.controller.begin(h.event, { x: 10, y: 20 }), true);

  const attacker = { sender: { id: 99, window: h.win } };
  assert.equal(h.controller.move(attacker, { x: 100, y: 200 }), false, 'a different renderer cannot move the active window');
  assert.equal(h.positions.length, 0);

  h.win.destroyed = true;
  assert.equal(h.controller.move(h.event, { x: 100, y: 200 }), true, 'move can be queued before destruction is observed');
  h.fireDelay(16);
  assert.equal(h.controller.activeCount(), 0, 'destruction cancels the session on the next coalesced move');
  assert.equal(h.positions.length, 0);
  h.controller.destroy();
});

test('native window lifecycle can cancel a drag by sender WebContents without pointerup IPC', () => {
  const h = harness();
  h.controller.begin(h.event, { x: 50, y: 60 });
  h.controller.move(h.event, { x: 70, y: 90 });
  assert.equal(h.controller.activeCount(), 1);
  assert.equal(h.controller.cancelForWebContents(h.event.sender), true);
  assert.equal(h.controller.activeCount(), 0);
  assert.equal(h.timers.size, 0, 'pending move and safety timers are both revoked');
  h.controller.destroy();
});

test('lost-pointer safety deadline flushes and ends an abandoned drag', () => {
  const h = harness();
  h.controller.begin(h.event, { x: 50, y: 60 });
  h.controller.move(h.event, { x: 70, y: 90 });
  h.fireDelay(15000);
  assert.deepEqual(h.positions, [[320, 150, false]]);
  assert.equal(h.controller.activeCount(), 0);
  assert.equal(h.timers.size, 0);
  h.controller.destroy();
});
