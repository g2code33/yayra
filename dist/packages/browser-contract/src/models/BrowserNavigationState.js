/**
 * BrowserNavigationState Model (JS runtime)
 */

export function createInitialNavigationState(initialUrl = 'about:blank', initialTitle = 'New Tab') {
  return {
    currentUrl: initialUrl,
    title: initialTitle,
    historyStack: [initialUrl],
    currentIndex: 0,
    canGoBack: false,
    canGoForward: false
  };
}
