/**
 * Unit tests for electron/vaapiProbe.cjs - the Linux VA-API video-decode
 * probe that keeps the harmless-but-alarming
 *   ERROR:media/gpu/vaapi/vaapi_wrapper.cc] vaInitialize failed: unknown libva error
 * off the console on machines with no VA-API driver (it reads like a
 * crash next to real startup errors).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { findVaapiDrivers, shouldDisableVaapi, applyVaapiPolicy } = require(path.join(repoRoot, 'electron', 'vaapiProbe.cjs'));

function fakeFs(driversByDir) {
  return {
    readdirSync(dir) {
      if (driversByDir[dir]) return driversByDir[dir];
      const err = new Error(`ENOENT: ${dir}`);
      err.code = 'ENOENT';
      throw err;
    }
  };
}

function fakeApp() {
  const switches = [];
  return {
    switches,
    commandLine: { appendSwitch: (k, v) => switches.push([k, v]), hasSwitch: () => false }
  };
}

test('probe finds VA-API driver backends only in existing DRI directories', () => {
  const fsImpl = fakeFs({
    '/usr/lib/x86_64-linux-gnu/dri': ['iHD_drv_video.so', 'swrast_dri.so', 'libfoo.so'],
    '/usr/lib/dri': ['radeonsi_drv_video.so', 'nvidia_drv_video.so.bak'] // .bak is not a loadable backend
  });
  const found = findVaapiDrivers({ fsImpl, driverDirs: ['/usr/lib/x86_64-linux-gnu/dri', '/usr/lib/dri', '/nonexistent'] });
  assert.deepEqual(found.sort(), [
    '/usr/lib/dri/radeonsi_drv_video.so',
    '/usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so'
  ].sort());
});

test('no driver present -> VA-API must be disabled (the vaInitialize-error case)', () => {
  const fsImpl = fakeFs({ '/usr/lib/x86_64-linux-gnu/dri': ['swrast_dri.so'] });
  const decision = shouldDisableVaapi({ fsImpl, driverDirs: ['/usr/lib/x86_64-linux-gnu/dri'], env: {} });
  assert.equal(decision.disable, true);
  assert.match(decision.reason, /no VA-API driver/);
  assert.deepEqual(decision.drivers, []);
});

test('driver present -> VA-API is left alone (hardware video decode preserved)', () => {
  const fsImpl = fakeFs({ '/usr/lib/dri': ['radeonsi_drv_video.so'] });
  const decision = shouldDisableVaapi({ fsImpl, driverDirs: ['/usr/lib/dri'], env: {} });
  assert.equal(decision.disable, false);
  assert.equal(decision.drivers.length, 1);
});

test('YAYRA_DISABLE_VAAPI=1 forces disable even with a driver', () => {
  const fsImpl = fakeFs({ '/usr/lib/dri': ['radeonsi_drv_video.so'] });
  const decision = shouldDisableVaapi({ fsImpl, driverDirs: ['/usr/lib/dri'], env: { YAYRA_DISABLE_VAAPI: '1' } });
  assert.equal(decision.disable, true);
  assert.match(decision.reason, /YAYRA_DISABLE_VAAPI/);
});

test('YAYRA_KEEP_VAAPI=1 opts out of the auto-disable', () => {
  const fsImpl = fakeFs({});
  const decision = shouldDisableVaapi({ fsImpl, driverDirs: ['/usr/lib/dri'], env: { YAYRA_KEEP_VAAPI: '1' } });
  assert.equal(decision.disable, false);
  assert.match(decision.reason, /YAYRA_KEEP_VAAPI/);
});

test('applyVaapiPolicy is a no-op outside Linux', () => {
  const app = fakeApp();
  const result = applyVaapiPolicy({
    app, platform: 'win32', fsImpl: fakeFs({}), driverDirs: ['/x'], env: {}, logger: { warn() {}, log() {} }
  });
  assert.equal(result.applied, false);
  assert.deepEqual(app.switches, []);
});

test('applyVaapiPolicy disables VA-API decode/encode entry points when no driver exists', () => {
  const app = fakeApp();
  const warnings = [];
  const result = applyVaapiPolicy({
    app, platform: 'linux', fsImpl: fakeFs({}), driverDirs: ['/x'], env: {},
    logger: { warn: (m) => warnings.push(m), log() {} }
  });
  assert.equal(result.applied, true);
  const disableFeatures = app.switches.find(([k]) => k === 'disable-features');
  assert.ok(disableFeatures, 'disable-features switch appended');
  assert.match(disableFeatures[1], /VaapiVideoDecodeLinuxGL/);
  assert.match(disableFeatures[1], /VaapiVideoEncoder/);
  assert.ok(app.switches.some(([k]) => k === 'disable-accelerated-video-decode'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /vaInitialize failed/);
});

test('applyVaapiPolicy appends nothing when a driver is present', () => {
  const app = fakeApp();
  const result = applyVaapiPolicy({
    app, platform: 'linux',
    fsImpl: fakeFs({ '/usr/lib/dri': ['radeonsi_drv_video.so'] }),
    driverDirs: ['/usr/lib/dri'], env: {}, logger: { warn() {}, log() {} }
  });
  assert.equal(result.applied, false);
  assert.deepEqual(app.switches, []);
});
