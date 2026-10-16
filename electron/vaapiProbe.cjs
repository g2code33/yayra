/**
 * VA-API video-decode capability probe (Linux only).
 *
 * On Ubuntu boxes without a working VA-API driver, Chromium's GPU process
 * probes VA-API at startup and logs on EVERY launch:
 *
 *   ERROR:media/gpu/vaapi/vaapi_wrapper.cc] vaInitialize failed: unknown libva error
 *
 * It is NOT fatal (video decode falls back to software), but it looks
 * like a crash next to real errors. The probe here checks the standard
 * DRI driver locations for a `*_drv_video.so` backend; when none exists,
 * Yayra disables Chromium's VA-API video paths up front so the failing
 * probe never runs. When a driver IS present (mesa-va-drivers,
 * intel-media-va-driver, nvidia-vaapi-driver, ...) hardware video decode
 * is left untouched.
 *
 * Overrides:
 *   YAYRA_DISABLE_VAAPI=1  force-disable VA-API video paths
 *   YAYRA_KEEP_VAAPI=1     never auto-disable (opt out of this probe)
 */

const DEFAULT_DRIVER_DIRS = [
  '/usr/lib/x86_64-linux-gnu/dri',
  '/usr/lib/aarch64-linux-gnu/dri',
  '/usr/lib/i386-linux-gnu/dri',
  '/usr/lib/dri',
  '/usr/lib64/dri',
  '/lib/x86_64-linux-gnu/dri'
];

/** Find installed VA-API driver backends (`*_drv_video.so`) in standard DRI dirs. */
function findVaapiDrivers({ fsImpl = require('node:fs'), driverDirs = DEFAULT_DRIVER_DIRS } = {}) {
  const found = [];
  for (const dir of driverDirs || []) {
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { /* dir absent - keep looking */ }
    for (const name of names) {
      if (typeof name === 'string' && name.endsWith('_drv_video.so')) found.push(`${dir}/${name}`);
    }
  }
  return found;
}

/** Pure decision: should Yayra disable Chromium's VA-API video paths? */
function shouldDisableVaapi({ fsImpl, driverDirs, env = process.env } = {}) {
  if (env && env.YAYRA_DISABLE_VAAPI === '1') {
    return { disable: true, reason: 'YAYRA_DISABLE_VAAPI=1', drivers: [] };
  }
  if (env && env.YAYRA_KEEP_VAAPI === '1') {
    return { disable: false, reason: 'YAYRA_KEEP_VAAPI=1 (opted out of the VA-API probe)', drivers: findVaapiDrivers({ fsImpl, driverDirs }) };
  }
  const drivers = findVaapiDrivers({ fsImpl, driverDirs });
  if (drivers.length === 0) {
    return {
      disable: true,
      reason: 'no VA-API driver (*_drv_video.so) found in the standard DRI directories',
      drivers
    };
  }
  return { disable: false, reason: `VA-API driver present (${drivers[0]})`, drivers };
}

/**
 * Wire the decision into the Electron command line. MUST run before the
 * app 'ready' event - appendSwitch after ready has no effect.
 */
function applyVaapiPolicy({
  app,
  platform = process.platform,
  fsImpl,
  driverDirs,
  env = process.env,
  logger = console
} = {}) {
  if (platform !== 'linux') return { applied: false, reason: 'not linux' };
  const decision = shouldDisableVaapi({ fsImpl, driverDirs, env });
  if (!decision.disable) {
    if (decision.drivers.length > 0) logger.log?.(`[yayra] ${decision.reason} - hardware video decode left enabled`);
    return { applied: false, ...decision };
  }
  // No usable driver (or forced off): turn the VA-API video paths off so
  // the GPU process never runs the failing vaInitialize probe. Unknown
  // feature names in --disable-features are ignored by Chromium; the
  // list covers every VA-API decode/encode entry point as of Electron 44.
  app.commandLine.appendSwitch(
    'disable-features',
    'VaapiVideoDecodeLinuxGL,VaapiVideoDecodeLinuxZeroCopyGL,VaapiVideoEncoder,VaapiOnNvidiaGPUs,VaapiIgnoreDriverChecks'
  );
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  logger.warn?.(
    `[yayra] ${decision.reason} - video decode stays software (avoids the harmless-but-scary "vaInitialize failed" GPU error on every launch). `
    + 'Install mesa-va-drivers / intel-media-va-driver / nvidia-vaapi-driver for hardware video decode, or set YAYRA_KEEP_VAAPI=1 to always let Chromium try.'
  );
  return { applied: true, ...decision };
}

module.exports = { findVaapiDrivers, shouldDisableVaapi, applyVaapiPolicy, DEFAULT_DRIVER_DIRS };
