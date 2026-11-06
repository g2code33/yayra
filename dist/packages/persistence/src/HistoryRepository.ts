/**
 * Yayra Floating Browser - History, Bookmark, Session, and Download Repositories
 * Complete implementation of the 8 local-first database entities.
 */

import {
  BookmarkItem,
  BrowserTab,
  HistoryEntry,
  SnapSide,
  WindowGeometry
} from '../../shared-core/src/types.js';
import {
  BrowserBookmarkEntity,
  BrowserHistoryEntity,
  BrowserSessionEntity,
  DownloadRecordEntity,
  IBookmarkRepository,
  IDownloadRepository,
  IHistoryRepository,
  IPersistenceAdapter,
  ISessionRepository
} from './IPersistenceEngine.js';

export class HistoryRepository implements IHistoryRepository {
  private adapter: IPersistenceAdapter;
  private readonly HISTORY_KEY = 'history-entries';

  constructor(adapter: IPersistenceAdapter) {
    this.adapter = adapter;
  }

  public async addEntry(
    url: string,
    title: string,
    favicon: string | null = null,
    isIncognito = false
  ): Promise<BrowserHistoryEntity> {
    // Never persist incognito history
    if (isIncognito) {
      return {
        id: `ephemeral-${Date.now()}`,
        url,
        title,
        favicon,
        visitCount: 1,
        lastVisitedAt: Date.now(),
        isIncognito: true
      };
    }

    // Sanitize sensitive credentials from URL parameters
    const sanitizedUrl = this.sanitizeUrl(url);

    const list = (await this.adapter.get<BrowserHistoryEntity[]>(this.HISTORY_KEY)) || [];
    const existingIndex = list.findIndex((e) => e.url === sanitizedUrl);

    let entry: BrowserHistoryEntity;
    if (existingIndex >= 0) {
      entry = {
        ...list[existingIndex],
        title: title || list[existingIndex].title,
        favicon: favicon || list[existingIndex].favicon,
        visitCount: list[existingIndex].visitCount + 1,
        lastVisitedAt: Date.now(),
        searchTerms: `${title} ${sanitizedUrl}`.toLowerCase()
      };
      list.splice(existingIndex, 1);
    } else {
      entry = {
        id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url: sanitizedUrl,
        title: title || sanitizedUrl,
        favicon,
        visitCount: 1,
        lastVisitedAt: Date.now(),
        isIncognito: false,
        searchTerms: `${title || sanitizedUrl} ${sanitizedUrl}`.toLowerCase()
      };
    }

    list.unshift(entry);
    if (list.length > 2000) list.length = 2000;
    await this.adapter.set(this.HISTORY_KEY, list);
    return entry;
  }

  public async getEntries(limit = 50, offset = 0): Promise<BrowserHistoryEntity[]> {
    const list = (await this.adapter.get<BrowserHistoryEntity[]>(this.HISTORY_KEY)) || [];
    return list.slice(offset, offset + limit);
  }

  public async search(query: string, limit = 20): Promise<BrowserHistoryEntity[]> {
    const list = (await this.adapter.get<BrowserHistoryEntity[]>(this.HISTORY_KEY)) || [];
    const q = query.toLowerCase();
    return list
      .filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
      .slice(0, limit);
  }

  public async getLastVisited(): Promise<BrowserHistoryEntity | null> {
    const list = (await this.adapter.get<BrowserHistoryEntity[]>(this.HISTORY_KEY)) || [];
    return list.length > 0 ? list[0] : null;
  }

  public async clearHistory(): Promise<void> {
    await this.adapter.delete(this.HISTORY_KEY);
  }

  public async deleteEntry(id: string): Promise<void> {
    const list = (await this.adapter.get<BrowserHistoryEntity[]>(this.HISTORY_KEY)) || [];
    const filtered = list.filter((e) => e.id !== id);
    await this.adapter.set(this.HISTORY_KEY, filtered);
  }

  private sanitizeUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      const sensitiveKeys = ['password', 'passwd', 'token', 'auth', 'secret', 'api_key', 'access_token'];
      let modified = false;
      sensitiveKeys.forEach((key) => {
        if (u.searchParams.has(key)) {
          u.searchParams.set(key, 'REDACTED');
          modified = true;
        }
      });
      return modified ? decodeURI(u.toString()) : rawUrl;
    } catch {
      return rawUrl;
    }
  }
}

export class BookmarkRepository implements IBookmarkRepository {
  private adapter: IPersistenceAdapter;
  private readonly BOOKMARKS_KEY = 'bookmarks-tree';

  constructor(adapter: IPersistenceAdapter) {
    this.adapter = adapter;
  }

  public async addBookmark(
    title: string,
    url: string,
    parentId: string | null = null,
    favicon: string | null = null
  ): Promise<BrowserBookmarkEntity> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    const bookmark: BrowserBookmarkEntity = {
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      parentId,
      title,
      url,
      favicon,
      isFolder: false,
      position: items.filter((b) => b.parentId === parentId).length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    items.push(bookmark);
    await this.adapter.set(this.BOOKMARKS_KEY, items);
    return bookmark;
  }

  public async createFolder(title: string, parentId: string | null = null): Promise<BrowserBookmarkEntity> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    const folder: BrowserBookmarkEntity = {
      id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      parentId,
      title,
      isFolder: true,
      position: items.filter((b) => b.parentId === parentId).length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    items.push(folder);
    await this.adapter.set(this.BOOKMARKS_KEY, items);
    return folder;
  }

  public async getBookmarks(parentId: string | null = null): Promise<BrowserBookmarkEntity[]> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    return items.filter((b) => b.parentId === parentId);
  }

  public async searchBookmarks(query: string): Promise<BrowserBookmarkEntity[]> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    const q = query.toLowerCase();
    return items.filter(
      (b) => b.title.toLowerCase().includes(q) || (b.url && b.url.toLowerCase().includes(q))
    );
  }

  public async updateBookmark(id: string, updates: Partial<BrowserBookmarkEntity>): Promise<BrowserBookmarkEntity | null> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    const idx = items.findIndex((b) => b.id === id);
    if (idx === -1) return null;

    items[idx] = {
      ...items[idx],
      ...updates,
      updatedAt: Date.now()
    };
    await this.adapter.set(this.BOOKMARKS_KEY, items);
    return items[idx];
  }

  public async deleteBookmark(id: string): Promise<void> {
    const items = (await this.adapter.get<BrowserBookmarkEntity[]>(this.BOOKMARKS_KEY)) || [];
    const filtered = items.filter((b) => b.id !== id && b.parentId !== id);
    await this.adapter.set(this.BOOKMARKS_KEY, filtered);
  }
}

export class SessionRepository implements ISessionRepository {
  private adapter: IPersistenceAdapter;
  private readonly SESSION_KEY = 'browser-session';
  private readonly FULL_SESSION_KEY = 'browser-full-session';

  constructor(adapter: IPersistenceAdapter) {
    this.adapter = adapter;
  }

  public async saveTabs(tabs: BrowserTab[], activeTabId: string | null): Promise<void> {
    const persistable = tabs
      .filter((t) => !t.isIncognito)
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    await this.adapter.set(this.SESSION_KEY, { tabs: persistable, activeTabId });
  }

  public async restoreTabs(): Promise<{ tabs: BrowserTab[]; activeTabId: string | null } | null> {
    const session = await this.adapter.get<{ tabs: BrowserTab[]; activeTabId: string | null }>(this.SESSION_KEY);
    if (!session || !Array.isArray(session.tabs)) return null;

    const validTabs = session.tabs
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    return {
      tabs: validTabs,
      activeTabId: session.activeTabId
    };
  }

  public async saveSession(session: BrowserSessionEntity): Promise<void> {
    if (session.isPrivate) return;

    const safeTabs = session.tabs
      .filter((t) => !t.isIncognito)
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    const safeSession: BrowserSessionEntity = {
      ...session,
      tabs: safeTabs,
      updatedAt: Date.now()
    };
    await this.adapter.set(this.FULL_SESSION_KEY, safeSession);
  }

  public async restoreSession(sessionId?: string): Promise<BrowserSessionEntity | null> {
    const session = await this.adapter.get<BrowserSessionEntity>(this.FULL_SESSION_KEY);
    if (!session) return null;

    const safeTabs = session.tabs
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    return {
      ...session,
      tabs: safeTabs
    };
  }

  public async clearSession(): Promise<void> {
    await this.adapter.delete(this.SESSION_KEY);
    await this.adapter.delete(this.FULL_SESSION_KEY);
  }

  private validateAndSanitizeUrl(rawUrl: string): string {
    if (!rawUrl || typeof rawUrl !== 'string') return 'https://duckduckgo.com';
    const trimmed = rawUrl.trim();

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/html')) {
      return 'https://duckduckgo.com';
    }

    try {
      const u = new URL(trimmed);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') {
        let modified = false;
        ['password', 'token', 'secret', 'auth'].forEach((key) => {
          if (u.searchParams.has(key)) {
            u.searchParams.set(key, 'REDACTED');
            modified = true;
          }
        });
        return modified ? decodeURI(u.toString()) : trimmed;
      }
    } catch {
      // Fallback
    }
    return trimmed;
  }
}

export class DownloadRepository implements IDownloadRepository {
  private adapter: IPersistenceAdapter;
  private readonly DOWNLOADS_KEY = 'download-records';

  constructor(adapter: IPersistenceAdapter) {
    this.adapter = adapter;
  }

  public async addRecord(record: Omit<DownloadRecordEntity, 'createdAt'>): Promise<DownloadRecordEntity> {
    const list = (await this.adapter.get<DownloadRecordEntity[]>(this.DOWNLOADS_KEY)) || [];
    const entity: DownloadRecordEntity = {
      ...record,
      createdAt: Date.now()
    };
    list.unshift(entity);
    await this.adapter.set(this.DOWNLOADS_KEY, list);
    return entity;
  }

  public async getRecords(): Promise<DownloadRecordEntity[]> {
    return (await this.adapter.get<DownloadRecordEntity[]>(this.DOWNLOADS_KEY)) || [];
  }

  public async updateRecord(id: string, updates: Partial<DownloadRecordEntity>): Promise<DownloadRecordEntity | null> {
    const list = (await this.adapter.get<DownloadRecordEntity[]>(this.DOWNLOADS_KEY)) || [];
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    list[idx] = { ...list[idx], ...updates };
    await this.adapter.set(this.DOWNLOADS_KEY, list);
    return list[idx];
  }

  public async deleteRecord(id: string): Promise<void> {
    const list = (await this.adapter.get<DownloadRecordEntity[]>(this.DOWNLOADS_KEY)) || [];
    const filtered = list.filter((r) => r.id !== id);
    await this.adapter.set(this.DOWNLOADS_KEY, filtered);
  }

  public async clearDownloads(): Promise<void> {
    await this.adapter.delete(this.DOWNLOADS_KEY);
  }
}
