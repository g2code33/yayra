/**
 * Yayra Floating Browser - History, Bookmark, Session, and Download Repositories
 */

export class HistoryRepository {
  constructor(adapter) {
    this.adapter = adapter;
    this.HISTORY_KEY = 'history-entries';
  }

  async addEntry(url, title, favicon = null, isIncognito = false) {
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

    const sanitizedUrl = this.sanitizeUrl(url);
    const list = (await this.adapter.get(this.HISTORY_KEY)) || [];
    const existingIndex = list.findIndex((e) => e.url === sanitizedUrl);

    let entry;
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

  async recordVisit(url, title, favicon = null, isIncognito = false) {
    return this.addEntry(url, title, favicon, isIncognito);
  }

  async getEntries(limit = 50, offset = 0) {
    const list = (await this.adapter.get(this.HISTORY_KEY)) || [];
    return list.slice(offset, offset + limit);
  }

  async search(query, limit = 20) {
    const list = (await this.adapter.get(this.HISTORY_KEY)) || [];
    const q = query.toLowerCase();
    return list
      .filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async getLastVisited() {
    const list = (await this.adapter.get(this.HISTORY_KEY)) || [];
    return list.length > 0 ? list[0] : null;
  }

  async clearHistory() {
    await this.adapter.delete(this.HISTORY_KEY);
  }

  async deleteEntry(id) {
    const list = (await this.adapter.get(this.HISTORY_KEY)) || [];
    const filtered = list.filter((e) => e.id !== id);
    await this.adapter.set(this.HISTORY_KEY, filtered);
  }

  sanitizeUrl(rawUrl) {
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

export class BookmarkRepository {
  constructor(adapter) {
    this.adapter = adapter;
    this.BOOKMARKS_KEY = 'bookmarks-tree';
  }

  async addBookmark(title, url, parentId = null, favicon = null) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
    const bookmark = {
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

  async createFolder(title, parentId = null) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
    const folder = {
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

  async getBookmarks(parentId = null) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
    return items.filter((b) => b.parentId === parentId);
  }

  async searchBookmarks(query) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
    const q = query.toLowerCase();
    return items.filter(
      (b) => b.title.toLowerCase().includes(q) || (b.url && b.url.toLowerCase().includes(q))
    );
  }

  async updateBookmark(id, updates) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
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

  async deleteBookmark(id) {
    const items = (await this.adapter.get(this.BOOKMARKS_KEY)) || [];
    const filtered = items.filter((b) => b.id !== id && b.parentId !== id);
    await this.adapter.set(this.BOOKMARKS_KEY, filtered);
  }
}

export class SessionRepository {
  constructor(adapter) {
    this.adapter = adapter;
    this.SESSION_KEY = 'browser-session';
    this.FULL_SESSION_KEY = 'browser-full-session';
  }

  async saveTabs(tabs, activeTabId) {
    const persistable = tabs
      .filter((t) => !t.isIncognito)
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    await this.adapter.set(this.SESSION_KEY, { tabs: persistable, activeTabId });
  }

  async restoreTabs() {
    const session = await this.adapter.get(this.SESSION_KEY);
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

  async saveSession(session) {
    if (session.isPrivate) return;

    const safeTabs = session.tabs
      .filter((t) => !t.isIncognito)
      .map((t) => ({
        ...t,
        url: this.validateAndSanitizeUrl(t.url)
      }))
      .filter((t) => Boolean(t.url));

    const safeSession = {
      ...session,
      tabs: safeTabs,
      updatedAt: Date.now()
    };
    await this.adapter.set(this.FULL_SESSION_KEY, safeSession);
  }

  async restoreSession(sessionId) {
    const session = await this.adapter.get(this.FULL_SESSION_KEY);
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

  async clearSession() {
    await this.adapter.delete(this.SESSION_KEY);
    await this.adapter.delete(this.FULL_SESSION_KEY);
  }

  validateAndSanitizeUrl(rawUrl) {
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

export class DownloadRepository {
  constructor(adapter) {
    this.adapter = adapter;
    this.DOWNLOADS_KEY = 'download-records';
  }

  async addRecord(record) {
    const list = (await this.adapter.get(this.DOWNLOADS_KEY)) || [];
    const entity = {
      ...record,
      createdAt: Date.now()
    };
    list.unshift(entity);
    await this.adapter.set(this.DOWNLOADS_KEY, list);
    return entity;
  }

  async getRecords() {
    return (await this.adapter.get(this.DOWNLOADS_KEY)) || [];
  }

  async updateRecord(id, updates) {
    const list = (await this.adapter.get(this.DOWNLOADS_KEY)) || [];
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    list[idx] = { ...list[idx], ...updates };
    await this.adapter.set(this.DOWNLOADS_KEY, list);
    return list[idx];
  }

  async deleteRecord(id) {
    const list = (await this.adapter.get(this.DOWNLOADS_KEY)) || [];
    const filtered = list.filter((r) => r.id !== id);
    await this.adapter.set(this.DOWNLOADS_KEY, filtered);
  }

  async clearDownloads() {
    await this.adapter.delete(this.DOWNLOADS_KEY);
  }
}
