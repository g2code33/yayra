/**
 * BrowserTab Model (JS runtime)
 */

import { createInitialLoadingState } from './BrowserLoadingState.js';
import { createInitialNavigationState } from './BrowserNavigationState.js';

export function createBrowserTab(options = {}) {
  const initialUrl = options.url || 'about:blank';
  const initialTitle = options.title || (initialUrl === 'about:blank' ? 'New Tab' : initialUrl);
  const now = Date.now();

  const loadingState = createInitialLoadingState();
  const navigationState = createInitialNavigationState(initialUrl, initialTitle);

  return {
    id: options.id || `tab_${Math.random().toString(36).substring(2, 9)}_${now}`,
    url: initialUrl,
    title: initialTitle,
    faviconUrl: null,
    loadingState,
    navigationState,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    progress: 0,
    zoomLevel: 1.0,
    isIncognito: Boolean(options.isIncognito),
    isPinned: Boolean(options.isPinned),
    isMuted: Boolean(options.isMuted),
    isSecure: initialUrl.startsWith('https://'),
    createdAt: now,
    lastAccessedAt: now,
    error: null
  };
}
