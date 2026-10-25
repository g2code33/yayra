'use strict';

/**
 * Honest UA client-hint metadata for Google auth surfaces.
 *
 * Electron exposes `webContents.setUserAgent()` but NOT the Chromium
 * `UserAgentMetadata` that drives `navigator.userAgentData.brands` and the
 * low-entropy `Sec-CH-UA` family. A UA string claiming Chrome/<version> while
 * `navigator.userAgentData` reports Electron's defaults is an internal
 * inconsistency that Google's risk engine can read.
 *
 * The only supported way to close that gap in Electron is CDP's
 * `Emulation.setUserAgentOverride` with `userAgentMetadata`. This module does
 * that with HONEST values: it declares the real Chromium engine version and a
 * GREASE brand, never "Google Chrome". It does NOT set --enable-automation,
 * --headless, --remote-debugging-port, or navigator.webdriver. Attaching the
 * debugger is a normal Electron capability, not an automation flag.
 *
 * Everything is best-effort and injectable: on any failure the caller falls
 * back to the header-level hints in googleAuthParity.cjs. No page is broken by
 * a missing CDP feature, and no page script is injected.
 */

const { buildGoogleAuthClientHints, majorVersion, platformBrand } = require('./googleAuthParity.cjs');

function buildUserAgentMetadata({ chromeVersion = process.versions.chrome, platform = process.platform } = {}) {
  const major = majorVersion(chromeVersion);
  const full = String(chromeVersion || `${major}.0.0.0`).slice(0, 64);
  const hintPlatform = platformBrand(platform);
  return Object.freeze({
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Not?A_Brand', version: '99' }
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Not?A_Brand', version: '99.0.0.0' }
    ],
    platform: hintPlatform,
    platformVersion: '',
    architecture: '',
    model: '',
    mobile: false,
    wow64: false,
    bitness: '64'
  });
}

function buildUserAgentOverride({ userAgent, chromeVersion = process.versions.chrome, platform = process.platform } = {}) {
  if (typeof userAgent !== 'string' || !userAgent || userAgent.length > 1024) return null;
  return {
    userAgent,
    userAgentMetadata: buildUserAgentMetadata({ chromeVersion, platform })
  };
}

/**
 * Apply the override to a real Electron webContents. Returns a Promise that
 * resolves to a boolean: never throws, never rejects. The debugger stays
 * attached for the view's lifetime so the override persists; `detach()` is
 * returned for cleanup when the view is destroyed.
 */
async function applyGoogleAuthUserAgentMetadata(webContents, options = {}) {
  const override = buildUserAgentOverride(options);
  const debuggerApi = webContents?.debugger;
  if (!override || !debuggerApi || typeof debuggerApi.sendCommand !== 'function') return false;
  try {
    if (typeof debuggerApi.isAttached === 'function' && !debuggerApi.isAttached()) {
      if (typeof debuggerApi.attach !== 'function') return false;
      debuggerApi.attach('1.3');
    }
    await debuggerApi.sendCommand('Emulation.setUserAgentOverride', override);
    return true;
  } catch {
    // CDP unavailable/blocked: header-level hints remain in place.
    return false;
  }
}

function detachGoogleAuthUserAgentMetadata(webContents) {
  try {
    const debuggerApi = webContents?.debugger;
    if (debuggerApi?.isAttached?.() && typeof debuggerApi.detach === 'function') debuggerApi.detach();
  } catch { /* view already gone */ }
}

module.exports = {
  buildUserAgentMetadata,
  buildUserAgentOverride,
  buildGoogleAuthClientHints,
  applyGoogleAuthUserAgentMetadata,
  detachGoogleAuthUserAgentMetadata
};
