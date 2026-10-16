/**
 * Profile-scoped persistence for the browser shell.
 *
 * WHY: the shipped app constructed BrowserShell with NO history/bookmarks/
 * settings repositories at all - the menu items "worked" visually but
 * nothing was ever stored (star a page: gone on restart; yayra://history:
 * always empty). This module provides real repositories backed by
 * localStorage, namespaced PER PROFILE (`yayra:p:<profileId>:<key>`), so
 * every profile keeps its own history, bookmarks, settings and wheel.
 *
 * The profile id is resolved through a callback ON EVERY call, so
 * switching profiles in-window automatically re-scopes all storage with
 * zero re-wiring.
 *
 * Migration: the DEFAULT profile adopts pre-existing un-scoped keys
 * (e.g. the old global `yayra:settings` / `yayra_radial_actions`) the
 * first time the scoped key is missing - nobody loses data.
 */

function safeParse(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function createProfileScopedStorage({ backing, getProfileId, legacyKeys = {} } = {}) {
  const store = backing || (typeof localStorage !== 'undefined' ? localStorage : null);
  const pid = () => {
    try { return String((typeof getProfileId === 'function' && getProfileId()) || 'default'); } catch { return 'default'; }
  };
  const scoped = (key) => `yayra:p:${pid()}:${key}`;

  return {
    get profileId() { return pid(); },
    async get(key) {
      if (!store) return null;
      const raw = store.getItem(scoped(key));
      if (raw !== null && raw !== undefined) return safeParse(raw, null);
      // Default profile: adopt the legacy un-scoped key once.
      if (pid() === 'default' && legacyKeys[key]) {
        const legacy = store.getItem(legacyKeys[key]);
        if (legacy !== null && legacy !== undefined) {
          const value = safeParse(legacy, null);
          if (value !== null) {
            try { store.setItem(scoped(key), JSON.stringify(value)); } catch { /* quota */ }
            return value;
          }
        }
      }
      return null;
    },
    async set(key, value) {
      if (!store) return;
      try { store.setItem(scoped(key), JSON.stringify(value)); } catch { /* quota - keep running */ }
    },
    async delete(key) {
      if (!store) return;
      try { store.removeItem(scoped(key)); } catch { /* ignore */ }
      // The legacy un-scoped key is just the pre-profile alias of the
      // default profile's data - deleting must cover it too, or the old
      // value would silently re-migrate on the next read.
      if (pid() === 'default' && legacyKeys[key]) {
        try { store.removeItem(legacyKeys[key]); } catch { /* ignore */ }
      }
    }
  };
}

const HISTORY_KEY = 'history';
const HISTORY_CAP = 1000;

export function createHistoryRepo(storage) {
  const repo = {
    async addEntry(url, title = '', favicon = null) {
      if (!url || String(url).startsWith('yayra://newtab')) return;
      const items = (await storage.get(HISTORY_KEY)) || [];
      // One row per URL: repeat visits move it to the front and bump its
      // visitCount - this is what powers the new tab page's REAL
      // "Frequently Used Sites" (empty on a fresh install/profile, then
      // built from actual browsing).
      const idx = items.findIndex((i) => i.url === url);
      if (idx >= 0) {
        const existing = items.splice(idx, 1)[0];
        items.unshift({
          ...existing,
          title: title || existing.title,
          favicon: favicon || existing.favicon || null,
          visitCount: (Number(existing.visitCount) || 1) + 1,
          lastVisitedAt: Date.now()
        });
      } else {
        items.unshift({
          id: `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url, title: title || url, favicon: favicon || null, visitCount: 1, lastVisitedAt: Date.now()
        });
      }
      await storage.set(HISTORY_KEY, items.slice(0, HISTORY_CAP));
    },
    async getEntries(limit = 100) {
      const items = (await storage.get(HISTORY_KEY)) || [];
      return items.slice(0, limit);
    },
    /**
     * The REAL most-visited web pages, by visit count then recency.
     * Fresh install / new profile = empty array (no invented sites);
     * never more than `limit` (default 5).
     */
    async getTopSites(limit = 5) {
      const items = (await storage.get(HISTORY_KEY)) || [];
      return items
        .filter((i) => /^https?:\/\//i.test(String(i.url || '')))
        .sort((a, b) => ((Number(b.visitCount) || 1) - (Number(a.visitCount) || 1))
          || ((b.lastVisitedAt || 0) - (a.lastVisitedAt || 0)))
        .slice(0, Math.max(1, Math.min(5, limit)));
    },
    async removeEntry(id) {
      const items = (await storage.get(HISTORY_KEY)) || [];
      await storage.set(HISTORY_KEY, items.filter((i) => i.id !== id));
    },
    async clear() {
      await storage.delete(HISTORY_KEY);
    }
  };
  // Duck-typed aliases BrowserShell probes for (older repo contracts).
  repo.recordVisit = (url, title, favicon) => repo.addEntry(url, title, favicon);
  repo.deleteEntry = (id) => repo.removeEntry(id);
  repo.clearHistory = () => repo.clear();
  return repo;
}

const BOOKMARKS_KEY = 'bookmarks';

export function createBookmarksRepo(storage) {
  const repo = {
    async getAllBookmarks() {
      return (await storage.get(BOOKMARKS_KEY)) || [];
    },
    async addBookmark({ url, title = '', favicon = null } = {}) {
      if (!url) return null;
      const items = (await storage.get(BOOKMARKS_KEY)) || [];
      if (items.some((b) => b.url === url)) return items.find((b) => b.url === url);
      const bookmark = {
        id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url, title: title || url, favicon: favicon || null, addedAt: Date.now()
      };
      items.unshift(bookmark);
      await storage.set(BOOKMARKS_KEY, items);
      return bookmark;
    },
    async removeBookmark(urlOrId) {
      const items = (await storage.get(BOOKMARKS_KEY)) || [];
      await storage.set(BOOKMARKS_KEY, items.filter((b) => b.url !== urlOrId && b.id !== urlOrId));
    },
    async isBookmarked(url) {
      const items = (await storage.get(BOOKMARKS_KEY)) || [];
      return items.some((b) => b.url === url);
    }
  };
  // Duck-typed alias BrowserShell probes for first.
  repo.removeBookmarkByUrl = (url) => repo.removeBookmark(url);
  return repo;
}

const SETTINGS_KEY = 'settings';

export function createSettingsRepo(storage) {
  return {
    async getSettings() {
      return (await storage.get(SETTINGS_KEY)) || null;
    },
    async updateSettings(partial) {
      const current = (await storage.get(SETTINGS_KEY)) || {};
      const next = { ...current, ...(partial || {}) };
      await storage.set(SETTINGS_KEY, next);
      return next;
    }
  };
}

const SHORTCUTS_KEY = 'newtab-shortcuts';

/**
 * Chrome-style new-tab shortcut tiles: the user's own pinned sites
 * ("Add shortcut" on the new tab page). Separate from bookmarks and
 * from the automatic frequent-sites tiles. Capped at 12 like Chrome.
 */
export function createShortcutsRepo(storage) {
  const sanitize = (items) => (Array.isArray(items) ? items : [])
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
    .map(({ id, title, url }) => ({ id: id || `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: String(title || url).slice(0, 60), url }))
    .slice(0, 12);
  return {
    async getShortcuts() {
      return sanitize((await storage.get(SHORTCUTS_KEY)) || []);
    },
    async addShortcut({ title = '', url } = {}) {
      if (!url || !/^https?:\/\//i.test(String(url))) return null;
      const items = sanitize((await storage.get(SHORTCUTS_KEY)) || []);
      if (items.length >= 12) return null;
      if (items.some((s) => s.url === url)) return items.find((s) => s.url === url);
      const shortcut = { id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: String(title || url).slice(0, 60), url };
      items.push(shortcut);
      await storage.set(SHORTCUTS_KEY, items);
      return shortcut;
    },
    async updateShortcut(id, { title, url } = {}) {
      const items = sanitize((await storage.get(SHORTCUTS_KEY)) || []);
      const target = items.find((s) => s.id === id);
      if (!target) return null;
      if (typeof title === 'string' && title.trim()) target.title = title.trim().slice(0, 60);
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) target.url = url;
      await storage.set(SHORTCUTS_KEY, items);
      return target;
    },
    async removeShortcut(id) {
      const items = sanitize((await storage.get(SHORTCUTS_KEY)) || []);
      await storage.set(SHORTCUTS_KEY, items.filter((s) => s.id !== id));
    }
  };
}

const LAST_SESSION_KEY = 'last-session-tabs';

function sanitizeSessionGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const name = String(group.name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!name) return null;
  const rawColor = String(group.color || '').trim();
  const color = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : null;
  return color ? { name, color } : { name };
}

/**
 * "Continue with these tabs": a rolling snapshot of the tabs currently
 * open (non-private, real websites only). Closing a tab by hand removes
 * it from the snapshot naturally, so whatever is left when the app
 * exits = the tabs the user did NOT manually close - exactly what the
 * next launch should offer to continue with.
 */
export function createSessionRepo(storage) {
  const sanitize = (tabs) => (Array.isArray(tabs) ? tabs : [])
    .filter((t) => t && typeof t.url === 'string' && /^https?:\/\//i.test(t.url))
    .map(({ url, title, group }) => {
      const safeGroup = sanitizeSessionGroup(group);
      return {
        url,
        title: String(title || url).slice(0, 120),
        ...(safeGroup ? { group: safeGroup } : {})
      };
    })
    .slice(0, 20);
  return {
    async getLastSession() {
      const snapshot = await storage.get(LAST_SESSION_KEY);
      return snapshot && Array.isArray(snapshot.tabs)
        ? { tabs: sanitize(snapshot.tabs), savedAt: Number(snapshot.savedAt) || null }
        : { tabs: [], savedAt: null };
    },
    async saveSession(tabs) {
      await storage.set(LAST_SESSION_KEY, { tabs: sanitize(tabs), savedAt: Date.now() });
    }
  };
}

const WHEEL_KEY = 'radial-wheel';

/**
 * Radial action wheel persistence. Only plain serializable fields are
 * stored ({id,title,url,type}) - builtin actions are rebuilt by id at
 * load time and icons are resolved at render time (favicon for links),
 * so stale icon-HTML blobs from old versions are stripped on read.
 */
export function createWheelRepo(storage) {
  const sanitize = (items) => (Array.isArray(items) ? items : [])
    .filter((i) => i && i.id && i.title)
    .map(({ id, title, url = null, type = null }) => ({ id, title, url, type }));
  return {
    async getItems() {
      const items = await storage.get(WHEEL_KEY);
      return items === null ? null : sanitize(items);
    },
    async setItems(items) {
      await storage.set(WHEEL_KEY, sanitize(items));
    },
    async reset() {
      await storage.delete(WHEEL_KEY);
    }
  };
}
