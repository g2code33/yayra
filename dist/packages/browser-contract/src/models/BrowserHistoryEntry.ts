/**
 * BrowserHistoryEntry Model
 * Local-first browsing history tracking visit time, URL, title, and visit frequency.
 */

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  timestamp: number;
  visitCount: number;
  faviconUrl?: string | null;
}

export function createHistoryEntry(url: string, title = '', faviconUrl: string | null = null): BrowserHistoryEntry {
  const now = Date.now();
  return {
    id: `hist_${Math.random().toString(36).substring(2, 9)}_${now}`,
    url,
    title: title || url,
    timestamp: now,
    visitCount: 1,
    faviconUrl
  };
}
