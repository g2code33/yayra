/**
 * BrowserSession Model
 * Represents complete active browser state, open tabs, active tab focus, and closed tab history for undo restoration.
 */

import { BrowserTab, createBrowserTab } from './BrowserTab.js';

export interface BrowserSession {
  id: string;
  tabs: BrowserTab[];
  activeTabId: string | null;
  closedTabs: BrowserTab[];
  isIncognito: boolean;
  createdAt: number;
  lastSavedAt: number;
  updatedAt?: number;
}

export function createBrowserSession(options: { id?: string; initialUrl?: string; isIncognito?: boolean } = {}): BrowserSession {
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
