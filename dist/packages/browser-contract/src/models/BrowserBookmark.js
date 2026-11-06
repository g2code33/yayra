/**
 * BrowserBookmark Model (JS runtime)
 */

export function createBookmark(title, url, parentId = null, isFolder = false) {
  const now = Date.now();
  return {
    id: `bm_${Math.random().toString(36).substring(2, 9)}_${now}`,
    title,
    url: isFolder ? undefined : url,
    parentId,
    isFolder,
    createdAt: now,
    faviconUrl: null,
    tags: []
  };
}
