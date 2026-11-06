/**
 * Yayra Floating Browser - Settings Modal Component
 */

export class SettingsModalComponent {
  constructor(options) {
    this.settings = { ...options.currentSettings };
    this.eventBus = options.eventBus;
    this.onSave = options.onSave;
    this.onClose = options.onClose;
    this.modalElement = null;
  }

  render(container = document.body) {
    const overlay = document.createElement('div');
    overlay.className = 'yayra-settings-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(12px);
      display: flex; align-items: center; justify-content: center;
      z-index: 20000;
    `;

    const card = document.createElement('div');
    card.className = 'yayra-glass-surface';
    card.style.cssText = `
      width: 520px; max-width: 92vw; max-height: 88vh; overflow-y: auto;
      border-radius: 16px; padding: 24px; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 16px;
      box-shadow: 0 16px 36px rgba(0,0,0,0.5);
    `;

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px;">
        <h2 style="margin:0; font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Yayra Settings
        </h2>
        <button id="yayra-settings-close" style="background:transparent; border:none; color:white; font-size:18px; cursor:pointer;">✕</button>
      </div>

      <div style="display:flex; flex-direction:column; gap:16px;">
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px;">
          <h3 style="margin:0; font-size:14px; color:var(--yayra-accent); font-weight:600;">Desktop Floating Window Modes</h3>
          
          <label style="display:flex; flex-direction:column; gap:4px; font-size:13px;">
            <strong>Desktop Floating Mode:</strong>
            <span style="font-size:12px; color:var(--yayra-text-secondary);">Choose your default desktop experience.</span>
            <select id="yayra-setting-desktop-mode" style="background:rgba(0,0,0,0.4); color:white; border:1px solid rgba(255,255,255,0.2); border-radius:8px; padding:8px; font-size:13px;">
              <option value="circle-first" ${this.settings.desktopFloatingMode === 'circle-first' ? 'selected' : ''}>
                Mode A: Circle-first (Floating glass bubble, opens browser on click)
              </option>
              <option value="browser-first" ${this.settings.desktopFloatingMode === 'browser-first' ? 'selected' : ''}>
                Mode B: Browser-first (Floating browser window remains always visible)
              </option>
            </select>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-start-floating" ${this.settings.startFloatingOnLaunch ? 'checked' : ''} />
            <span>Start floating automatically on application launch</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-always-on-top" ${this.settings.alwaysOnTop ? 'checked' : ''} />
            <span>Always-on-Top preference (Pin overlay above other windows)</span>
          </label>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px;">
          <h3 style="margin:0; font-size:14px; color:var(--yayra-accent); font-weight:600;">Window Geometry & Lifecycle</h3>
          
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-remember-pos" ${this.settings.rememberPosition ? 'checked' : ''} />
            <span>Remember window position across sessions</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-remember-size" ${this.settings.rememberSize ? 'checked' : ''} />
            <span>Remember window size across sessions</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-minimize-bubble" ${this.settings.minimizeToBubble ? 'checked' : ''} />
            <span>Minimize browser window to floating circle</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-close-tray" ${this.settings.closeToTray ? 'checked' : ''} />
            <span>Close button minimizes to system tray / bubble instead of exiting</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-start-windows" ${this.settings.startWithWindows ? 'checked' : ''} />
            <span>Start with Windows (Disabled by default)</span>
          </label>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px;">
          <h3 style="margin:0; font-size:14px; color:var(--yayra-accent); font-weight:600;">Search & Privacy</h3>
          
          <label style="display:flex; flex-direction:column; gap:4px; font-size:13px;">
            <strong>Default Search Engine:</strong>
            <select id="yayra-setting-search-engine" style="background:rgba(0,0,0,0.4); color:white; border:1px solid rgba(255,255,255,0.2); border-radius:8px; padding:8px; font-size:13px;">
              <option value="duckduckgo" ${this.settings.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (Privacy Default)</option>
              <option value="searx" ${this.settings.searchEngine === 'searx' ? 'selected' : ''}>SearXNG (Decentralized)</option>
              <option value="google" ${this.settings.searchEngine === 'google' ? 'selected' : ''}>Google</option>
              <option value="bing" ${this.settings.searchEngine === 'bing' ? 'selected' : ''}>Bing</option>
            </select>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-adblock" ${this.settings.adBlockEnabled ? 'checked' : ''} />
            <span>Enable Built-in Content & Ad Blocker</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="yayra-setting-clear-exit" ${this.settings.clearHistoryOnExit ? 'checked' : ''} />
            <span>Clear Browsing History on Exit</span>
          </label>
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
        <button id="yayra-settings-cancel" style="background:rgba(255,255,255,0.1); border:none; color:white; padding:8px 16px; border-radius:8px; cursor:pointer;">Cancel</button>
        <button id="yayra-settings-save" style="background:var(--yayra-accent); border:none; color:black; font-weight:bold; padding:8px 16px; border-radius:8px; cursor:pointer;">Save Changes</button>
      </div>
    `;

    overlay.appendChild(card);
    this.attachEvents(overlay);
    container.appendChild(overlay);
    this.modalElement = overlay;

    return overlay;
  }

  attachEvents(overlay) {
    const closeBtn = overlay.querySelector('#yayra-settings-close');
    const cancelBtn = overlay.querySelector('#yayra-settings-cancel');
    const saveBtn = overlay.querySelector('#yayra-settings-save');

    const modeSelect = overlay.querySelector('#yayra-setting-desktop-mode');
    const startFloatingCheck = overlay.querySelector('#yayra-setting-start-floating');
    const alwaysOnTopCheck = overlay.querySelector('#yayra-setting-always-on-top');
    const rememberPosCheck = overlay.querySelector('#yayra-setting-remember-pos');
    const rememberSizeCheck = overlay.querySelector('#yayra-setting-remember-size');
    const minimizeBubbleCheck = overlay.querySelector('#yayra-setting-minimize-bubble');
    const closeTrayCheck = overlay.querySelector('#yayra-setting-close-tray');
    const startWindowsCheck = overlay.querySelector('#yayra-setting-start-windows');

    const searchSelect = overlay.querySelector('#yayra-setting-search-engine');
    const adBlockCheck = overlay.querySelector('#yayra-setting-adblock');
    const clearExitCheck = overlay.querySelector('#yayra-setting-clear-exit');

    const closeHandler = () => {
      this.destroy();
      this.onClose();
    };

    closeBtn?.addEventListener('click', closeHandler);
    cancelBtn?.addEventListener('click', closeHandler);

    saveBtn?.addEventListener('click', async () => {
      const updated = {
        ...this.settings,
        desktopFloatingMode: modeSelect.value,
        startFloatingOnLaunch: startFloatingCheck.checked,
        alwaysOnTop: alwaysOnTopCheck.checked,
        rememberPosition: rememberPosCheck.checked,
        rememberSize: rememberSizeCheck.checked,
        minimizeToBubble: minimizeBubbleCheck.checked,
        closeToTray: closeTrayCheck.checked,
        startWithWindows: startWindowsCheck.checked,
        searchEngine: searchSelect.value,
        adBlockEnabled: adBlockCheck.checked,
        clearHistoryOnExit: clearExitCheck.checked
      };

      await this.onSave(updated);
      this.eventBus.emit('settings:updated', { settings: updated });
      this.eventBus.emit('floating:mode-changed', { mode: updated.desktopFloatingMode });
      closeHandler();
    });
  }

  destroy() {
    if (this.modalElement && this.modalElement.parentNode) {
      this.modalElement.parentNode.removeChild(this.modalElement);
      this.modalElement = null;
    }
  }
}
