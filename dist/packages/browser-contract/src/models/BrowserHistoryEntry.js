/**
 * BrowserHistoryEntry Model (JS runtime)
 */

export function createHistoryEntry(url, title = '', faviconUrl = null) {
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
