/**
 * BrowserSession Model (JS runtime)
 */

import { createBrowserTab } from './BrowserTab.js';

export function createBrowserSession(options = {}) {
  const initialTab = createBrowserTab({
    url: options.initialUrl || 'https://duckduckgo.com',
    isIncognito: options.isIncognito
  });
  const now = Date.now();

  return {
    id: options.id || `session_${Math.random().toString(36).substring(2, 9)}_${now}`,
    tabs: [initialTab],
    activeTabId: initialTab.id,
    closedTabs: [],
    isIncognito: Boolean(options.isIncognito),
    createdAt: now,
    lastSavedAt: now
  };
}
