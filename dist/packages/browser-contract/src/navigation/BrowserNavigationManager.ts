/**
 * Yayra Floating Browser - Shared Browser Navigation & Tab/Session Manager
 * Platform-independent navigation controller managing browser tabs, navigation history,
 * loading lifecycles, and session restoration.
 */

import { BrowserTab, createBrowserTab, CreateTabOptions } from '../models/BrowserTab.js';
import { BrowserSession, createBrowserSession } from '../models/BrowserSession.js';
import { BrowserLoadingState, LoadingStatus, NavigationError } from '../models/BrowserLoadingState.js';
import { BrowserNavigationState } from '../models/BrowserNavigationState.js';
import { BrowserSettings, createDefaultBrowserSettings, SearchEngineType } from '../models/BrowserSettings.js';
import { UrlInterpreter, defaultUrlInterpreter } from '../url/UrlInterpreter.js';

export interface NavigationManagerOptions {
  initialUrl?: string;
  settings?: BrowserSettings;
  urlInterpreter?: UrlInterpreter;
  onNavigate?: (tabId: string, url: string) => Promise<void> | void;
}

export type NavigationEventType =
  | 'tab:created'
  | 'tab:selected'
  | 'tab:closed'
  | 'tab:updated'
  | 'navigation:started'
  | 'navigation:committed'
  | 'navigation:completed'
  | 'navigation:failed'
  | 'navigation:title-changed'
  | 'navigation:favicon-changed'
  | 'navigation:progress-changed'
  | 'session:restored'
  | 'session:saved';

export interface NavigationEventListener {
  (eventType: NavigationEventType, payload: any): void;
}

export class BrowserNavigationManager {
  private session: BrowserSession;
  private settings: BrowserSettings;
  private urlInterpreter: UrlInterpreter;
  private listeners: Set<NavigationEventListener> = new Set();
  private onNavigateHook?: (tabId: string, url: string) => Promise<void> | void;

  constructor(options: NavigationManagerOptions = {}) {
    this.settings = options.settings || createDefaultBrowserSettings();
    this.urlInterpreter = options.urlInterpreter || defaultUrlInterpreter;
    this.session = createBrowserSession({ initialUrl: options.initialUrl || this.settings.startUrl });
    this.onNavigateHook = options.onNavigate;
  }

  // --- Session & Tab Management ---

  public getSession(): BrowserSession {
    return this.session;
  }

  public getTabs(): BrowserTab[] {
    return [...this.session.tabs];
  }

  public getActiveTab(): BrowserTab | null {
    if (!this.session.activeTabId) return this.session.tabs[0] || null;
    return this.session.tabs.find((t) => t.id === this.session.activeTabId) || this.session.tabs[0] || null;
  }

  public getTab(tabId: string): BrowserTab | null {
    return this.session.tabs.find((t) => t.id === tabId) || null;
  }

  public createTab(options: CreateTabOptions & { select?: boolean } = {}): BrowserTab {
    const tab = createBrowserTab({
      url: options.url || this.settings.startUrl,
      title: options.title,
      isIncognito: options.isIncognito,
      isPinned: options.isPinned,
      isMuted: options.isMuted
    });

    this.session.tabs.push(tab);

    if (options.select !== false) {
      this.selectTab(tab.id);
    }

    this.session.lastSavedAt = Date.now();
    this.emit('tab:created', { tab });
    return tab;
  }

  public selectTab(tabId: string): boolean {
    const tab = this.getTab(tabId);
    if (!tab) return false;

    this.session.activeTabId = tab.id;
    tab.lastAccessedAt = Date.now();
    this.emit('tab:selected', { tabId, tab });
    return true;
  }

  public closeTab(tabId: string): boolean {
    const index = this.session.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return false;

    const [closedTab] = this.session.tabs.splice(index, 1);
    this.session.closedTabs.unshift(closedTab);
    if (this.session.closedTabs.length > 25) {
      this.session.closedTabs.pop();
    }

    if (this.session.activeTabId === tabId) {
      if (this.session.tabs.length > 0) {
        const nextIndex = Math.min(index, this.session.tabs.length - 1);
        this.selectTab(this.session.tabs[nextIndex].id);
      } else {
        const fallbackTab = this.createTab({ url: this.settings.startUrl });
        this.session.activeTabId = fallbackTab.id;
      }
    }

    this.session.lastSavedAt = Date.now();
    this.emit('tab:closed', { tabId, closedTab });
    return true;
  }

  public undoCloseTab(): BrowserTab | null {
    if (this.session.closedTabs.length === 0) return null;
    const restoredTab = this.session.closedTabs.shift()!;
    this.session.tabs.push(restoredTab);
    this.selectTab(restoredTab.id);
    this.emit('tab:created', { tab: restoredTab, isRestored: true });
    return restoredTab;
  }

  // --- Session Export & Restoration ---

  public exportSession(): BrowserSession {
    return JSON.parse(JSON.stringify(this.session));
  }

  public restoreSession(savedSession: Partial<BrowserSession>): void {
    if (!savedSession || !Array.isArray(savedSession.tabs) || savedSession.tabs.length === 0) {
      return;
    }

    const restoredTabs = savedSession.tabs.map((t) => {
      const tab = createBrowserTab({
        id: t.id,
        url: t.url,
        title: t.title,
        isIncognito: t.isIncognito,
        isPinned: t.isPinned,
        isMuted: t.isMuted
      });

      if (t.navigationState) {
        tab.navigationState = {
          currentUrl: t.navigationState.currentUrl || t.url,
          title: t.navigationState.title || t.title,
          historyStack: Array.isArray(t.navigationState.historyStack) ? [...t.navigationState.historyStack] : [t.url],
          currentIndex: typeof t.navigationState.currentIndex === 'number' ? t.navigationState.currentIndex : 0,
          canGoBack: Boolean(t.navigationState.canGoBack),
          canGoForward: Boolean(t.navigationState.canGoForward)
        };
        tab.canGoBack = tab.navigationState.canGoBack;
        tab.canGoForward = tab.navigationState.canGoForward;
      }

      return tab;
    });

    this.session = {
      id: savedSession.id || `session_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`,
      tabs: restoredTabs,
      activeTabId: savedSession.activeTabId && restoredTabs.some((t) => t.id === savedSession.activeTabId)
        ? savedSession.activeTabId
        : restoredTabs[0].id,
      closedTabs: Array.isArray(savedSession.closedTabs) ? [...savedSession.closedTabs] : [],
      isIncognito: Boolean(savedSession.isIncognito),
      createdAt: savedSession.createdAt || Date.now(),
      lastSavedAt: Date.now()
    };

    this.emit('session:restored', { session: this.session });
  }

  // --- Navigation Commands ---

  public async loadUrl(input: string, tabId?: string): Promise<string> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) throw new Error('No active browser tab found for navigation.');

    const interpreted = this.urlInterpreter.interpret(input, this.settings.searchEngine);
    const targetUrl = interpreted.normalizedUrl;

    tab.url = targetUrl;
    tab.isSecure = targetUrl.startsWith('https://');
    tab.navigationState.currentUrl = targetUrl;

    // Transition state to loading
    this.updateTabLoading(tab.id, {
      status: 'loading',
      progress: 10,
      error: null
    });

    this.emit('navigation:started', {
      tabId: tab.id,
      url: targetUrl,
      interpreted
    });

    if (this.onNavigateHook) {
      try {
        await this.onNavigateHook(tab.id, targetUrl);
      } catch (err: any) {
        this.reportNavigationError(tab.id, targetUrl, -1, err.message || 'Navigation hook failed');
        return targetUrl;
      }
    }

    return targetUrl;
  }

  public async search(query: string, engine?: SearchEngineType, tabId?: string): Promise<string> {
    const targetEngine = engine || this.settings.searchEngine;
    const searchUrl = this.urlInterpreter.buildSearchUrl(query, targetEngine);
    return this.loadUrl(searchUrl, tabId);
  }

  public async goBack(tabId?: string): Promise<boolean> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab || !tab.canGoBack || tab.navigationState.currentIndex <= 0) return false;

    tab.navigationState.currentIndex -= 1;
    const prevUrl = tab.navigationState.historyStack[tab.navigationState.currentIndex];
    tab.url = prevUrl;
    tab.navigationState.currentUrl = prevUrl;
    tab.canGoBack = tab.navigationState.currentIndex > 0;
    tab.canGoForward = tab.navigationState.currentIndex < tab.navigationState.historyStack.length - 1;
    tab.navigationState.canGoBack = tab.canGoBack;
    tab.navigationState.canGoForward = tab.canGoForward;

    this.updateTabLoading(tab.id, { status: 'loading', progress: 15 });
    this.emit('navigation:started', { tabId: tab.id, url: prevUrl, isTraversal: true });

    if (this.onNavigateHook) {
      await this.onNavigateHook(tab.id, prevUrl);
    }
    return true;
  }

  public async goForward(tabId?: string): Promise<boolean> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab || !tab.canGoForward || tab.navigationState.currentIndex >= tab.navigationState.historyStack.length - 1) return false;

    tab.navigationState.currentIndex += 1;
    const nextUrl = tab.navigationState.historyStack[tab.navigationState.currentIndex];
    tab.url = nextUrl;
    tab.navigationState.currentUrl = nextUrl;
    tab.canGoBack = tab.navigationState.currentIndex > 0;
    tab.canGoForward = tab.navigationState.currentIndex < tab.navigationState.historyStack.length - 1;
    tab.navigationState.canGoBack = tab.canGoBack;
    tab.navigationState.canGoForward = tab.canGoForward;

    this.updateTabLoading(tab.id, { status: 'loading', progress: 15 });
    this.emit('navigation:started', { tabId: tab.id, url: nextUrl, isTraversal: true });

    if (this.onNavigateHook) {
      await this.onNavigateHook(tab.id, nextUrl);
    }
    return true;
  }

  public async reload(bypassCache = false, tabId?: string): Promise<void> {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return;

    this.updateTabLoading(tab.id, { status: 'loading', progress: 10 });
    this.emit('navigation:started', { tabId: tab.id, url: tab.url, isReload: true, bypassCache });

    if (this.onNavigateHook) {
      await this.onNavigateHook(tab.id, tab.url);
    }
  }

  public stopLoading(tabId?: string): void {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab || !tab.isLoading) return;

    this.updateTabLoading(tab.id, {
      status: 'cancelled',
      progress: 0
    });
  }

  public async navigateHome(tabId?: string): Promise<string> {
    return this.loadUrl(this.settings.startUrl, tabId);
  }

  // --- Engine State Synchronization Handlers ---

  public reportNavigationCommitted(tabId: string, url: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.url = url;
    tab.isSecure = url.startsWith('https://');

    // History stack append if not a traversal
    const nav = tab.navigationState;
    if (nav.historyStack[nav.currentIndex] !== url) {
      nav.historyStack = nav.historyStack.slice(0, nav.currentIndex + 1);
      nav.historyStack.push(url);
      nav.currentIndex = nav.historyStack.length - 1;
    }

    tab.canGoBack = nav.currentIndex > 0;
    tab.canGoForward = nav.currentIndex < nav.historyStack.length - 1;
    nav.canGoBack = tab.canGoBack;
    nav.canGoForward = tab.canGoForward;
    nav.currentUrl = url;

    this.updateTabLoading(tab.id, {
      status: 'committed',
      progress: 60
    });

    this.emit('navigation:committed', { tabId: tab.id, url });
  }

  public reportNavigationCompleted(tabId: string, url: string, statusCode = 200): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.url = url;
    this.updateTabLoading(tab.id, {
      status: 'loaded',
      progress: 100,
      httpStatusCode: statusCode,
      loadedAt: Date.now()
    });

    this.emit('navigation:completed', { tabId: tab.id, url, statusCode });
  }

  public reportNavigationError(tabId: string, url: string, errorCode: number, description: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    const error: NavigationError = {
      code: errorCode,
      description,
      failingUrl: url,
      isCertError: errorCode === -1200 || description.toLowerCase().includes('cert'),
      timestamp: Date.now()
    };

    tab.error = error;
    this.updateTabLoading(tab.id, {
      status: 'failed',
      progress: 0,
      error
    });

    this.emit('navigation:failed', { tabId: tab.id, url, error });
  }

  public reportTitleReceived(tabId: string, title: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.title = title || tab.url;
    tab.navigationState.title = tab.title;
    this.emit('navigation:title-changed', { tabId: tab.id, title: tab.title });
  }

  public reportFaviconReceived(tabId: string, faviconUrl: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.faviconUrl = faviconUrl;
    this.emit('navigation:favicon-changed', { tabId: tab.id, faviconUrl });
  }

  public reportProgress(tabId: string, progress: number): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    const clamped = Math.max(0, Math.min(100, progress));
    tab.progress = clamped;
    tab.loadingState.progress = clamped;
    this.emit('navigation:progress-changed', { tabId: tab.id, progress: clamped });
  }

  // --- Getters & Inspection ---

  public getCurrentUrl(tabId?: string): string {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.url : 'about:blank';
  }

  public getPageTitle(tabId?: string): string {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.title : 'New Tab';
  }

  public getLoadingProgress(tabId?: string): number {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.progress : 0;
  }

  public getLoadingState(tabId?: string): BrowserLoadingState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.loadingState : { status: 'idle', progress: 0 };
  }

  public getNavigationState(tabId?: string): BrowserNavigationState {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.navigationState : {
      currentUrl: 'about:blank',
      title: 'New Tab',
      historyStack: ['about:blank'],
      currentIndex: 0,
      canGoBack: false,
      canGoForward: false
    };
  }

  // --- Subscriptions & Events ---

  public on(listener: NavigationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(eventType: NavigationEventType, payload: any): void {
    this.listeners.forEach((listener) => {
      try {
        listener(eventType, payload);
      } catch {
        // Suppress listener failure
      }
    });
  }

  private updateTabLoading(tabId: string, partial: Partial<BrowserLoadingState>): void {
    const tab = this.getTab(tabId);
    if (!tab) return;

    Object.assign(tab.loadingState, partial);
    tab.isLoading = tab.loadingState.status === 'loading' || tab.loadingState.status === 'committed';
    if (partial.progress !== undefined) {
      tab.progress = partial.progress;
    }
    this.emit('tab:updated', { tabId: tab.id, tab });
  }
}
