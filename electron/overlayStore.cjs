'use strict';

/**
 * Persists the floating overlay bubble's settings + last screen position
 * across restarts, so "move it anywhere, it stays there" actually holds
 * true after quitting and relaunching Yayra (or after a reboot, since the
 * whole point of the overlay is that it's running before anyone opens the
 * main browser window again).
 *
 * Defaults match the product requirement: the overlay ships ENABLED,
 * set to launch at system startup, and always-on-top of other
 * applications, out of the box - the user can turn any of these off from
 * Settings, but they are never off by default.
 *
 * Fully dependency-injected (fs, userDataDir) so this is unit-testable with
 * a real temp directory and no live Electron runtime. Mirrors
 * electron/authStore.cjs / electron/downloadsStore.cjs.
 */

const path = require('node:path');

const FILE_NAME = 'overlay-settings.json';

const DEFAULTS = Object.freeze({
  enabled: true,
  launchAtStartup: true,
  overlayAllApps: true,
  opacity: 0.92,
  size: 64,
  shadowPx: 0,
  position: null, // null = not yet placed; overlay picks a default corner
  // Triple-clicking the bubble locks it exactly where it is (no dragging)
  // until it is triple-clicked again. Persisted so a locked bubble stays
  // locked across restarts.
  positionLocked: false,
  // Customized radial action wheel synced from the in-app customizer
  // ({id,title,url,type} items). null = show the classic default ring.
  wheelItems: null
});

function createOverlayStore({ fs, userDataDir }) {
  const filePath = path.join(userDataDir, FILE_NAME);

  function load() {
    if (!fs.existsSync(filePath)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function save(partial) {
    const next = { ...load(), ...partial };
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next), { mode: 0o600 });
    return next;
  }

  return { load, save, DEFAULTS };
}

module.exports = { createOverlayStore, FILE_NAME, DEFAULTS };
