import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOverlayStore } from '../electron/overlayStore.cjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-overlay-store-'));
}

test('overlayStore: defaults ship ENABLED, launch-at-startup ON, and overlay-all-apps ON (never off out of the box)', () => {
  const dir = makeTempDir();
  const store = createOverlayStore({ fs, userDataDir: dir });
  const settings = store.load();
  assert.equal(settings.enabled, true);
  assert.equal(settings.launchAtStartup, true);
  assert.equal(settings.overlayAllApps, true);
  assert.equal(settings.miniOpenBehavior, 'same-mini', 'floating bubble actions reuse the same mini window by default');
});

test('overlayStore: save() merges partial updates and persists them across a fresh store instance', () => {
  const dir = makeTempDir();
  const store = createOverlayStore({ fs, userDataDir: dir });

  store.save({ enabled: false });
  let loaded = store.load();
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.launchAtStartup, true); // untouched field keeps its default

  store.save({ position: { x: 100, y: 200 } });
  loaded = store.load();
  assert.deepEqual(loaded.position, { x: 100, y: 200 });
  assert.equal(loaded.enabled, false); // earlier change is retained

  const store2 = createOverlayStore({ fs, userDataDir: dir });
  const loaded2 = store2.load();
  assert.equal(loaded2.enabled, false);
  assert.deepEqual(loaded2.position, { x: 100, y: 200 });
});

test('overlayStore: tolerates a corrupt settings file by falling back to defaults', () => {
  const dir = makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'overlay-settings.json'), '{not valid json');
  const store = createOverlayStore({ fs, userDataDir: dir });
  assert.equal(store.load().enabled, true);
});
