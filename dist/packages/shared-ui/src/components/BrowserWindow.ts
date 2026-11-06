/**
 * Yayra Floating Browser - Floating Window Frame Component
 * Glassmorphism floating container with titlebar, navigation controls, address bar, and mode switching.
 */

import { WindowStateManager } from '../../../shared-core/src/window.js';
import { NavigationController } from '../../../shared-core/src/navigation.js';
import { EventBus } from '../../../shared-core/src/events.js';

export interface BrowserWindowOptions {
  windowManager: WindowStateManager;
  navigationController: NavigationController;
  eventBus: EventBus;
  onMinimizeToCircle?: () => void;
  onOpenSettings?: () => void;
}

export class BrowserWindowComponent {
  private windowManager: WindowStateManager;
  private navigationController: NavigationController;
  private eventBus: EventBus;
  private onMinimizeToCircle?: () => void;
  private onOpenSettings?: () => void;
  private element: HTMLElement | null = null;
  private contentContainer: HTMLElement | null = null;
  private addressInput: HTMLInputElement | null = null;

  constructor(options: BrowserWindowOptions) {
    this.windowManager = options.windowManager;
    this.navigationController = options.navigationController;
    this.eventBus = options.eventBus;
    this.onMinimizeToCircle = options.onMinimizeToCircle;
    this.onOpenSettings = options.onOpenSettings;
  }

  public render(container: HTMLElement = document.body): HTMLElement {
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

  public getContentContainer(): HTMLElement | null {
    return this.contentContainer;
  }

  private attachEvents(win: HTMLElement): void {
    const header = win.querySelector('#yayra-drag-header') as HTMLElement;
    const urlBar = win.querySelector('#yayra-url-bar') as HTMLInputElement;
    const backBtn = win.querySelector('#yayra-btn-back');
    const fwdBtn = win.querySelector('#yayra-btn-forward');
    const reloadBtn = win.querySelector('#yayra-btn-reload');
    const settingsBtn = win.querySelector('#yayra-btn-settings');
    const minBtn = win.querySelector('#yayra-btn-minimize');
    const closeBtn = win.querySelector('#yayra-btn-close');

    // Navigation inputs
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

    // Window Draggable Header
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialX = 0;
    let initialY = 0;

    header?.addEventListener('pointerdown', (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'INPUT') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const geom = this.windowManager.getState().geometry;
      initialX = geom.x;
      initialY = geom.y;
      header.setPointerCapture(e.pointerId);
    });

    header?.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isDragging) return;
      const newX = initialX + (e.clientX - startX);
      const newY = initialY + (e.clientY - startY);
      this.windowManager.setPosition(newX, newY);
      win.style.left = `${newX}px`;
      win.style.top = `${newY}px`;
    });

    const onDragEnd = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      header.releasePointerCapture(e.pointerId);
    };

    header?.addEventListener('pointerup', onDragEnd);
    header?.addEventListener('pointercancel', onDragEnd);

    // Window Corner Resize
    const resizeCorner = win.querySelector('#yayra-resize-corner') as HTMLElement;
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let initialWidth = 0;
    let initialHeight = 0;

    resizeCorner?.addEventListener('pointerdown', (e: PointerEvent) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      const geom = this.windowManager.getState().geometry;
      initialWidth = geom.width;
      initialHeight = geom.height;
      resizeCorner.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    resizeCorner?.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isResizing) return;
      const newW = initialWidth + (e.clientX - resizeStartX);
      const newH = initialHeight + (e.clientY - resizeStartY);
      this.windowManager.setSize(newW, newH);
      win.style.width = `${this.windowManager.getState().geometry.width}px`;
      win.style.height = `${this.windowManager.getState().geometry.height}px`;
    });

    const onResizeEnd = (e: PointerEvent) => {
      if (!isResizing) return;
      isResizing = false;
      resizeCorner.releasePointerCapture(e.pointerId);
    };

    resizeCorner?.addEventListener('pointerup', onResizeEnd);
    resizeCorner?.addEventListener('pointercancel', onResizeEnd);
  }

  public updateVisibility(visible: boolean): void {
    if (this.element) {
      this.element.style.display = visible ? 'flex' : 'none';
    }
  }

  public destroy(): void {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
      this.element = null;
    }
  }
}
