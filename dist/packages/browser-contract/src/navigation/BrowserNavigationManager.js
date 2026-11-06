/**
 * Yayra Floating Browser - Shared Browser Navigation & Tab/Session Manager (JS runtime)
 */

import { createBrowserTab } from '../models/BrowserTab.js';
import { createBrowserSession } from '../models/BrowserSession.js';
import { createDefaultBrowserSettings } from '../models/BrowserSettings.js';
import { defaultUrlInterpreter } from '../url/UrlInterpreter.js';

export class BrowserNavigationManager {
  constructor(options = {}) {
    this.settings = options.settings || createDefaultBrowserSettings();
    this.urlInterpreter = options.urlInterpreter || defaultUrlInterpreter;
    this.session = createBrowserSession({ initialUrl: options.initialUrl || this.settings.startUrl });
    this.listeners = new Set();
    this.onNavigateHook = options.onNavigate;
  }

  getSession() {
    return this.session;
  }

  getTabs() {
    return [...this.session.tabs];
  }

  getActiveTab() {
    if (!this.session.activeTabId) return this.session.tabs[0] || null;
    return this.session.tabs.find((t) => t.id === this.session.activeTabId) || this.session.tabs[0] || null;
  }

  getTab(tabId) {
    return this.session.tabs.find((t) => t.id === tabId) || null;
  }

  createTab(options = {}) {
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

  selectTab(tabId) {
    const tab = this.getTab(tabId);
    if (!tab) return false;

    this.session.activeTabId = tab.id;
    tab.lastAccessedAt = Date.now();
    this.emit('tab:selected', { tabId, tab });
    return true;
  }

  closeTab(tabId) {
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

  undoCloseTab() {
    if (this.session.closedTabs.length === 0) return null;
    const restoredTab = this.session.closedTabs.shift();
    this.session.tabs.push(restoredTab);
    this.selectTab(restoredTab.id);
    this.emit('tab:created', { tab: restoredTab, isRestored: true });
    return restoredTab;
  }

  exportSession() {
    return JSON.parse(JSON.stringify(this.session));
  }

  restoreSession(savedSession) {
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

  async loadUrl(input, tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) throw new Error('No active browser tab found for navigation.');

    const interpreted = this.urlInterpreter.interpret(input, this.settings.searchEngine);
    const targetUrl = interpreted.normalizedUrl;

    tab.url = targetUrl;
    tab.isSecure = targetUrl.startsWith('https://');
    tab.navigationState.currentUrl = targetUrl;

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
      } catch (err) {
        this.reportNavigationError(tab.id, targetUrl, -1, err.message || 'Navigation hook failed');
        return targetUrl;
      }
    }

    return targetUrl;
  }

  async search(query, engine, tabId) {
    const targetEngine = engine || this.settings.searchEngine;
    const searchUrl = this.urlInterpreter.buildSearchUrl(query, targetEngine);
    return this.loadUrl(searchUrl, tabId);
  }

  async goBack(tabId) {
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

  async goForward(tabId) {
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

  async reload(bypassCache = false, tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab) return;

    this.updateTabLoading(tab.id, { status: 'loading', progress: 10 });
    this.emit('navigation:started', { tabId: tab.id, url: tab.url, isReload: true, bypassCache });

    if (this.onNavigateHook) {
      await this.onNavigateHook(tab.id, tab.url);
    }
  }

  stopLoading(tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    if (!tab || !tab.isLoading) return;

    this.updateTabLoading(tab.id, {
      status: 'cancelled',
      progress: 0
    });
  }

  async navigateHome(tabId) {
    return this.loadUrl(this.settings.startUrl, tabId);
  }

  reportNavigationCommitted(tabId, url) {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.url = url;
    tab.isSecure = url.startsWith('https://');

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

  reportNavigationCompleted(tabId, url, statusCode = 200) {
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

  reportNavigationError(tabId, url, errorCode, description) {
    const tab = this.getTab(tabId);
    if (!tab) return;

    const error = {
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

  reportTitleReceived(tabId, title) {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.title = title || tab.url;
    tab.navigationState.title = tab.title;
    this.emit('navigation:title-changed', { tabId: tab.id, title: tab.title });
  }

  reportFaviconReceived(tabId, faviconUrl) {
    const tab = this.getTab(tabId);
    if (!tab) return;

    tab.faviconUrl = faviconUrl;
    this.emit('navigation:favicon-changed', { tabId: tab.id, faviconUrl });
  }

  reportProgress(tabId, progress) {
    const tab = this.getTab(tabId);
    if (!tab) return;

    const clamped = Math.max(0, Math.min(100, progress));
    tab.progress = clamped;
    tab.loadingState.progress = clamped;
    this.emit('navigation:progress-changed', { tabId: tab.id, progress: clamped });
  }

  getCurrentUrl(tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.url : 'about:blank';
  }

  getPageTitle(tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.title : 'New Tab';
  }

  getLoadingProgress(tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.progress : 0;
  }

  getLoadingState(tabId) {
    const tab = tabId ? this.getTab(tabId) : this.getActiveTab();
    return tab ? tab.loadingState : { status: 'idle', progress: 0 };
  }

  getNavigationState(tabId) {
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

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(eventType, payload) {
    this.listeners.forEach((listener) => {
      try {
        listener(eventType, payload);
      } catch {
        // Suppress listener error
      }
    });
  }

  updateTabLoading(tabId, partial) {
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
