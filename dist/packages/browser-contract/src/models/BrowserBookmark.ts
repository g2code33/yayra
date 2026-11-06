/**
 * BrowserBookmark Model
 * Hierarchical bookmark system supporting nested folders and tags.
 */

export interface BrowserBookmark {
  id: string;
  url?: string;
  title: string;
  parentId?: string | null;
  isFolder: boolean;
  createdAt: number;
  faviconUrl?: string | null;
  tags?: string[];
}

export function createBookmark(title: string, url?: string, parentId: string | null = null, isFolder = false): BrowserBookmark {
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
