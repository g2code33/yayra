/**
 * Yayra Floating Browser - Floating Window Frame Component
 */

export class BrowserWindowComponent {
  constructor(options) {
    this.windowManager = options.windowManager;
    this.navigationController = options.navigationController;
    this.eventBus = options.eventBus;
    this.onMinimizeToCircle = options.onMinimizeToCircle;
    this.onOpenSettings = options.onOpenSettings;
    this.element = null;
    this.contentContainer = null;
    this.addressInput = null;
  }

  render(container = document.body) {
    const state = this.windowManager.getState();
    const activeTab = this.navigationController.getActiveTab();

    const win = document.createElement('div');
    win.className = 'yayra-glass-surface yayra-floating-window';
    win.id = 'yayra-floating-browser-window';
    win.style.left = `${state.geometry.x}px`;
    win.style.top = `${state.geometry.y}px`;
    win.style.width = `${state.geometry.width}px`;
    win.style.height = `${state.geometry.height}px`;
    win.style.display = state.isVisible ? 'flex' : 'none';

    win.innerHTML = `
      <div class="yayra-window-header" id="yayra-drag-header">
        <button class="yayra-nav-button" id="yayra-btn-back" title="Go Back" ${activeTab?.canGoBack ? '' : 'disabled'}>
          ◀
        </button>
        <button class="yayra-nav-button" id="yayra-btn-forward" title="Go Forward" ${activeTab?.canGoForward ? '' : 'disabled'}>
          ▶
        </button>
        <button class="yayra-nav-button" id="yayra-btn-reload" title="Reload">
          ⟳
        </button>
        <input type="text" class="yayra-address-bar" id="yayra-url-bar" value="${activeTab?.url || ''}" placeholder="Search or type URL" />
        <button class="yayra-nav-button" id="yayra-btn-settings" title="Settings">
          ⚙
        </button>
        <button class="yayra-nav-button" id="yayra-btn-minimize" title="Minimize to Circle">
          ○
        </button>
        <button class="yayra-nav-button" id="yayra-btn-close" title="Close">
          ✕
        </button>
      </div>
      <div class="yayra-window-content" id="yayra-engine-container"></div>
      <div class="yayra-resize-handle" id="yayra-resize-corner"></div>
    `;

    this.element = win;
    this.contentContainer = win.querySelector('#yayra-engine-container');
    this.addressInput = win.querySelector('#yayra-url-bar');

    this.attachEvents(win);
    container.appendChild(win);

    return win;
  }

  getContentContainer() {
    return this.contentContainer;
  }

  attachEvents(win) {
    const header = win.querySelector('#yayra-drag-header');
    const urlBar = win.querySelector('#yayra-url-bar');
    const backBtn = win.querySelector('#yayra-btn-back');
    const fwdBtn = win.querySelector('#yayra-btn-forward');
    const reloadBtn = win.querySelector('#yayra-btn-reload');
    const settingsBtn = win.querySelector('#yayra-btn-settings');
    const minBtn = win.querySelector('#yayra-btn-minimize');
    const closeBtn = win.querySelector('#yayra-btn-close');

    urlBar?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = this.navigationController.sanitizeUrl(urlBar.value);
        const activeTab = this.navigationController.getActiveTab();
        if (activeTab) {
          this.navigationController.updateTabState(activeTab.id, { url, isLoading: true });
          this.eventBus.emit('navigation:started', { tabId: activeTab.id, url });
        }
      }
    });

    backBtn?.addEventListener('click', () => {
      const tab = this.navigationController.getActiveTab();
      if (tab && tab.canGoBack) {
        this.eventBus.emit('navigation:started', { tabId: tab.id, url: tab.url });
      }
    });

    fwdBtn?.addEventListener('click', () => {
      const tab = this.navigationController.getActiveTab();
      if (tab && tab.canGoForward) {
        this.eventBus.emit('navigation:started', { tabId: tab.id, url: tab.url });
      }
    });

    reloadBtn?.addEventListener('click', () => {
      const tab = this.navigationController.getActiveTab();
      if (tab) {
        this.eventBus.emit('navigation:started', { tabId: tab.id, url: tab.url });
      }
    });

    settingsBtn?.addEventListener('click', () => {
      if (this.onOpenSettings) this.onOpenSettings();
    });

    minBtn?.addEventListener('click', () => {
      this.windowManager.minimize(true);
      if (this.onMinimizeToCircle) this.onMinimizeToCircle();
    });

    closeBtn?.addEventListener('click', () => {
      this.windowManager.minimize(true);
      if (this.onMinimizeToCircle) this.onMinimizeToCircle();
    });

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialX = 0;
    let initialY = 0;

    header?.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const geom = this.windowManager.getState().geometry;
      initialX = geom.x;
      initialY = geom.y;
      if (header.setPointerCapture) header.setPointerCapture(e.pointerId);
    });

    header?.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const newX = initialX + (e.clientX - startX);
      const newY = initialY + (e.clientY - startY);
      this.windowManager.setPosition(newX, newY);
      win.style.left = `${newX}px`;
      win.style.top = `${newY}px`;
    });

    const onDragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      if (header.releasePointerCapture) header.releasePointerCapture(e.pointerId);
    };

    header?.addEventListener('pointerup', onDragEnd);
    header?.addEventListener('pointercancel', onDragEnd);

    const resizeCorner = win.querySelector('#yayra-resize-corner');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let initialWidth = 0;
    let initialHeight = 0;

    resizeCorner?.addEventListener('pointerdown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      const geom = this.windowManager.getState().geometry;
      initialWidth = geom.width;
      initialHeight = geom.height;
      if (resizeCorner.setPointerCapture) resizeCorner.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    resizeCorner?.addEventListener('pointermove', (e) => {
      if (!isResizing) return;
      const newW = initialWidth + (e.clientX - resizeStartX);
      const newH = initialHeight + (e.clientY - resizeStartY);
      this.windowManager.setSize(newW, newH);
      win.style.width = `${this.windowManager.getState().geometry.width}px`;
      win.style.height = `${this.windowManager.getState().geometry.height}px`;
    });

    const onResizeEnd = (e) => {
      if (!isResizing) return;
      isResizing = false;
      if (resizeCorner.releasePointerCapture) resizeCorner.releasePointerCapture(e.pointerId);
    };

    resizeCorner?.addEventListener('pointerup', onResizeEnd);
    resizeCorner?.addEventListener('pointercancel', onResizeEnd);
  }

  updateVisibility(visible) {
    if (this.element) {
      this.element.style.display = visible ? 'flex' : 'none';
    }
  }

  destroy() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
      this.element = null;
    }
  }
}
