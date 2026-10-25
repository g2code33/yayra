import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDictionaryLookupShortcut } = require('../electron/dictionaryLookupShortcut.cjs');

function makeShortcutHarness({ registerResult = true, clipboardText = '  Ghana medicines  ' } = {}) {
  const registered = new Map();
  const reads = { count: 0 };
  const writes = { count: 0 };
  const handedOff = [];
  const globalShortcut = {
    register(accelerator, callback) { if (!registerResult) return false; registered.set(accelerator, callback); return true; },
    unregister(accelerator) { registered.delete(accelerator); },
    isRegistered(accelerator) { return registered.has(accelerator); }
  };
  const clipboard = {
    readText() { reads.count += 1; return clipboardText; },
    writeText() { writes.count += 1; }
  };
  const service = createDictionaryLookupShortcut({ globalShortcut, clipboard, openLookup: (url) => handedOff.push(url), logger: { warn() {} } });
  return { service, registered, reads, writes, handedOff };
}

test('global clipboard lookup is opt-in, reads only when its accelerator is pressed, and never writes clipboard', () => {
  const harness = makeShortcutHarness();
  assert.deepEqual(harness.service.configure(true, 'CommandOrControl+Alt+D'), { ok: true, enabled: true, accelerator: 'CommandOrControl+Alt+D' });
  assert.equal(harness.reads.count, 0, 'registration does not read the clipboard');
  harness.registered.get('CommandOrControl+Alt+D')();
  assert.equal(harness.reads.count, 1);
  assert.equal(harness.writes.count, 0);
  assert.equal(harness.handedOff[0], 'yayra://dictionary?q=Ghana%20medicines');
  assert.deepEqual(harness.service.configure(false), { ok: true, enabled: false });
  assert.equal(harness.registered.size, 0);
});

test('global lookup validates user-selectable shortcuts and bounds the clipboard payload', () => {
  const harness = makeShortcutHarness({ clipboardText: 'x'.repeat(4000) });
  assert.deepEqual(harness.service.configure(true, 'Ctrl+Alt+Delete'), { ok: false, reason: 'invalid-shortcut' });
  assert.equal(harness.service.configure(true, 'CommandOrControl+Alt+K').ok, true);
  harness.registered.get('CommandOrControl+Alt+K')();
  const query = new URL(harness.handedOff[0].replace('yayra://dictionary', 'https://local.test/dictionary')).searchParams.get('q');
  assert.equal(query.length, 2000);
});

test('global lookup reports an accelerator collision without claiming it is enabled', () => {
  const harness = makeShortcutHarness({ registerResult: false });
  assert.deepEqual(harness.service.configure(true), { ok: false, reason: 'global-shortcut-in-use-or-unsupported' });
  assert.equal(harness.service.accelerator, '');
});
