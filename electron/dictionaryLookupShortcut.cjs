'use strict';

const ALLOWED_ACCELERATORS = Object.freeze([
  'CommandOrControl+Alt+D',
  'CommandOrControl+Alt+K'
]);

function createDictionaryLookupShortcut({ globalShortcut, clipboard, openLookup, logger = console } = {}) {
  let registeredAccelerator = '';

  function configure(enabled, accelerator = ALLOWED_ACCELERATORS[0]) {
    if (!globalShortcut || typeof globalShortcut.register !== 'function') return { ok: false, reason: 'global-shortcut-unavailable' };
    if (enabled !== true) {
      if (registeredAccelerator) {
        try { globalShortcut.unregister(registeredAccelerator); } catch { /* the OS may already have removed it */ }
      }
      registeredAccelerator = '';
      return { ok: true, enabled: false };
    }
    if (!ALLOWED_ACCELERATORS.includes(accelerator)) return { ok: false, reason: 'invalid-shortcut' };
    if (registeredAccelerator === accelerator && globalShortcut.isRegistered?.(accelerator) !== false) return { ok: true, enabled: true, accelerator };
    if (registeredAccelerator) {
      try { globalShortcut.unregister(registeredAccelerator); } catch { /* try the new binding anyway */ }
      registeredAccelerator = '';
    }
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => {
        // This is deliberately the ONLY clipboard read in the feature: it
        // happens after the user presses their explicitly enabled shortcut.
        let text = '';
        try { text = String(clipboard?.readText?.() || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 2000); }
        catch (error) { logger.warn?.('[yayra:dictionary] clipboard read was denied', String(error?.message || error)); }
        const url = `yayra://dictionary${text ? `?q=${encodeURIComponent(text)}` : ''}`;
        try { openLookup?.(url); } catch (error) { logger.warn?.('[yayra:dictionary] lookup handoff failed', String(error?.message || error)); }
      });
    } catch (error) {
      logger.warn?.('[yayra:dictionary] global shortcut registration failed', String(error?.message || error));
      return { ok: false, reason: 'global-shortcut-registration-failed' };
    }
    if (!registered) return { ok: false, reason: 'global-shortcut-in-use-or-unsupported' };
    registeredAccelerator = accelerator;
    return { ok: true, enabled: true, accelerator };
  }

  function dispose() {
    if (!registeredAccelerator) return;
    try { globalShortcut?.unregister?.(registeredAccelerator); } catch { /* app is exiting */ }
    registeredAccelerator = '';
  }

  return { configure, dispose, get accelerator() { return registeredAccelerator; } };
}

module.exports = { ALLOWED_ACCELERATORS, createDictionaryLookupShortcut };
