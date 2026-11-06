/**
 * BrowserTab Model
 * Fully encapsulated browser tab model with navigation, loading, and security states.
 */

import { BrowserLoadingState, createInitialLoadingState, NavigationError } from './BrowserLoadingState.js';
import { BrowserNavigationState, createInitialNavigationState } from './BrowserNavigationState.js';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string | null;
  favicon?: string | null;
  loadingState: BrowserLoadingState;
  navigationState: BrowserNavigationState;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  progress: number;
  loadingProgress?: number;
  zoomLevel: number;
  isIncognito: boolean;
  isPrivate?: boolean;
  isPinned: boolean;
  isMuted: boolean;
  isSecure: boolean;
  createdAt: number;
  lastAccessedAt: number;
  error?: NavigationError | null;
  historyStack?: string[];
  historyIndex?: number;
}

export interface CreateTabOptions {
  id?: string;
  url?: string;
  title?: string;
  isIncognito?: boolean;
  isPinned?: boolean;
  isMuted?: boolean;
}

export function createBrowserTab(options: CreateTabOptions = {}): BrowserTab {
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
