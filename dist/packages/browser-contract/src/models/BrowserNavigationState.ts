/**
 * BrowserNavigationState Model
 * Tracks history stack, index position, and forward/backward capabilities.
 */

export interface BrowserNavigationState {
  currentUrl: string;
  title: string;
  historyStack: string[];
  currentIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function createInitialNavigationState(initialUrl = 'about:blank', initialTitle = 'New Tab'): BrowserNavigationState {
  return {
    currentUrl: initialUrl,
    title: initialTitle,
    historyStack: [initialUrl],
    currentIndex: 0,
    canGoBack: false,
    canGoForward: false
  };
}
