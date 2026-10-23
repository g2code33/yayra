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
      let raw = null;
      try { raw = store.getItem(scoped(key)); } catch { return null; }
      if (raw !== null && raw !== undefined) return safeParse(raw, null);
      // Default profile: adopt the legacy un-scoped key once.
      if (pid() === 'default' && legacyKeys[key]) {
        let legacy = null;
        try { legacy = store.getItem(legacyKeys[key]); } catch { return null; }
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
const BOOKMARK_GROUPS_KEY = 'bookmark-groups';
const BOOKMARK_DEFAULT_GROUP_KEY = 'bookmark-default-group';

export const DEFAULT_BOOKMARK_GROUP_ID = 'bookmarks-bar';
export const DEFAULT_BOOKMARK_GROUPS = Object.freeze([
  Object.freeze({ id: 'bookmarks-bar', name: 'Bookmarks Bar', builtIn: true }),
  Object.freeze({ id: 'mobile-bookmarks', name: 'Mobile Bookmarks', builtIn: true }),
  Object.freeze({ id: 'other-bookmarks', name: 'Other Bookmarks', builtIn: true })
]);

function cleanBookmarkGroupName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

export function createBookmarksRepo(storage) {
  const readGroups = async () => {
    const groups = DEFAULT_BOOKMARK_GROUPS.map((group) => ({ ...group }));
    const ids = new Set(groups.map((group) => group.id));
    const names = new Set(groups.map((group) => group.name.toLocaleLowerCase()));
    const stored = await storage.get(BOOKMARK_GROUPS_KEY);
    for (const candidate of Array.isArray(stored) ? stored : []) {
      const id = String(candidate?.id || '');
      const name = cleanBookmarkGroupName(candidate?.name);
      if (!/^bg-[a-z0-9][a-z0-9_-]{0,80}$/i.test(id) || ids.has(id) || !name) continue;
      const foldedName = name.toLocaleLowerCase();
      if (names.has(foldedName)) continue;
      ids.add(id);
      names.add(foldedName);
      groups.push({ id, name, builtIn: false });
    }
    return groups;
  };

  const defaultGroupFor = async (groups) => {
    const stored = await storage.get(BOOKMARK_DEFAULT_GROUP_KEY);
    const valid = groups.some((group) => group.id === stored);
    const groupId = valid ? stored : DEFAULT_BOOKMARK_GROUP_ID;
    if (!valid) await storage.set(BOOKMARK_DEFAULT_GROUP_KEY, groupId);
    return groupId;
  };

  const repo = {
    async getGroups() {
      return readGroups();
    },
    async getDefaultGroupId() {
      return defaultGroupFor(await readGroups());
    },
    async setDefaultGroup(groupId) {
      const groups = await readGroups();
      if (!groups.some((group) => group.id === groupId)) return { ok: false, reason: 'invalid-group' };
      await storage.set(BOOKMARK_DEFAULT_GROUP_KEY, groupId);
      return { ok: true, groupId };
    },
    async createGroup(name) {
      const cleanName = cleanBookmarkGroupName(name);
      if (!cleanName) return { ok: false, reason: 'invalid-name' };
      const groups = await readGroups();
      const existing = groups.find((group) => group.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
      if (existing) return { ok: false, reason: 'duplicate-name', group: existing };
      const group = {
        id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name: cleanName,
        builtIn: false
      };
      const customGroups = groups.filter((item) => !item.builtIn);
      customGroups.push(group);
      await storage.set(BOOKMARK_GROUPS_KEY, customGroups);
      return { ok: true, group };
    },
    async removeGroup(groupId) {
      const groups = await readGroups();
      const target = groups.find((group) => group.id === groupId);
      if (!target) return { ok: false, reason: 'not-found' };
      if (target.builtIn) return { ok: false, reason: 'built-in' };
      const currentDefault = await defaultGroupFor(groups);
      const nextGroups = groups.filter((group) => !group.builtIn && group.id !== groupId);
      const nextDefault = currentDefault === groupId ? DEFAULT_BOOKMARK_GROUP_ID : currentDefault;
      const items = await repo.getAllBookmarks();
      let moved = 0;
      const movedItems = items.map((item) => {
        if (item.groupId !== groupId) return item;
        moved += 1;
        return { ...item, groupId: nextDefault };
      });
      await storage.set(BOOKMARK_GROUPS_KEY, nextGroups);
      if (moved) await storage.set(BOOKMARKS_KEY, movedItems);
      if (currentDefault === groupId) await storage.set(BOOKMARK_DEFAULT_GROUP_KEY, nextDefault);
      return { ok: true, moved };
    },
    async getAllBookmarks() {
      const groups = await readGroups();
      const groupIds = new Set(groups.map((group) => group.id));
      const defaultGroupId = await defaultGroupFor(groups);
      const stored = await storage.get(BOOKMARKS_KEY);
      const items = Array.isArray(stored) ? stored.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
      let migrated = items.length !== (Array.isArray(stored) ? stored.length : 0);
      const normalized = items.map((item) => {
        const groupId = item && groupIds.has(item.groupId) ? item.groupId : defaultGroupId;
        if (!item || item.groupId !== groupId) migrated = true;
        return { ...item, groupId };
      });
      if (migrated) await storage.set(BOOKMARKS_KEY, normalized);
      return normalized;
    },
    async addBookmark({ url, title = '', favicon = null, groupId } = {}) {
      if (!url) return null;
      const groups = await readGroups();
      const defaultGroupId = await defaultGroupFor(groups);
      const targetGroupId = groups.some((group) => group.id === groupId) ? groupId : defaultGroupId;
      const items = await repo.getAllBookmarks();
      const existingIndex = items.findIndex((bookmark) => bookmark.url === url);
      if (existingIndex >= 0) {
        const existing = items[existingIndex];
        // Re-adding an existing URL normally keeps its folder. An explicit
        // group from the bookmarks page is a deliberate move.
        if (groupId && existing.groupId !== targetGroupId) {
          const updated = { ...existing, groupId: targetGroupId };
          items[existingIndex] = updated;
          await storage.set(BOOKMARKS_KEY, items);
          return updated;
        }
        return existing;
      }
      const bookmark = {
        id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url, title: title || url, favicon: favicon || null, addedAt: Date.now(), groupId: targetGroupId
      };
      items.unshift(bookmark);
      await storage.set(BOOKMARKS_KEY, items);
      return bookmark;
    },
    async moveBookmark(urlOrId, groupId) {
      const groups = await readGroups();
      if (!groups.some((group) => group.id === groupId)) return { ok: false, reason: 'invalid-group' };
      const items = await repo.getAllBookmarks();
      const index = items.findIndex((bookmark) => bookmark.id === urlOrId || bookmark.url === urlOrId);
      if (index < 0) return { ok: false, reason: 'not-found' };
      const updated = { ...items[index], groupId };
      items[index] = updated;
      await storage.set(BOOKMARKS_KEY, items);
      return { ok: true, bookmark: updated };
    },
    async removeBookmark(urlOrId) {
      const items = await repo.getAllBookmarks();
      await storage.set(BOOKMARKS_KEY, items.filter((bookmark) => bookmark.url !== urlOrId && bookmark.id !== urlOrId));
    },
    async isBookmarked(url) {
      const items = await repo.getAllBookmarks();
      return items.some((bookmark) => bookmark.url === url);
    }
  };
  // Duck-typed aliases used by existing BrowserShell call sites.
  repo.removeBookmarkByUrl = (url) => repo.removeBookmark(url);
  repo.addBookmarkGroup = (name) => repo.createGroup(name);
  return repo;
}

const EMAIL_ADDRESSES_KEY = 'email-addresses';
const EMAIL_ADDRESS_LIMIT = 250;

export function normalizeEmailAddress(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at >= email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  if (domain.split('.').some((label) => !label || label.length > 63)) return null;
  return email;
}

/** Profile-scoped, local-only email suggestions (never passwords). */
export function createEmailAddressesRepo(storage) {
  const repo = {
    async getAllEmails() {
      const stored = await storage.get(EMAIL_ADDRESSES_KEY);
      const seen = new Set();
      let changed = false;
      const items = [];
      for (const value of Array.isArray(stored) ? stored : []) {
        const source = typeof value === 'string' ? { email: value } : value;
        const email = normalizeEmailAddress(source?.email);
        if (!email) { changed = true; continue; }
        const key = email.toLocaleLowerCase();
        if (seen.has(key)) { changed = true; continue; }
        seen.add(key);
        const addedAt = Number(source.addedAt) || Date.now();
        const lastUsedAt = Number(source.lastUsedAt) || addedAt;
        items.push({
          id: String(source.id || `e-${addedAt}-${Math.random().toString(36).slice(2, 8)}`),
          email,
          addedAt,
          lastUsedAt
        });
      }
      const sorted = items.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, EMAIL_ADDRESS_LIMIT);
      if (sorted.length !== items.length) changed = true;
      if (changed) await storage.set(EMAIL_ADDRESSES_KEY, sorted);
      return sorted;
    },
    async addEmail(value) {
      const email = normalizeEmailAddress(value);
      if (!email) return null;
      const items = await repo.getAllEmails();
      const key = email.toLocaleLowerCase();
      const existing = items.find((item) => item.email.toLocaleLowerCase() === key);
      const now = Date.now();
      if (existing) {
        const updated = { ...existing, lastUsedAt: now };
        await storage.set(EMAIL_ADDRESSES_KEY, [updated, ...items.filter((item) => item.id !== existing.id)]);
        return updated;
      }
      const item = {
        id: `e-${now}-${Math.random().toString(36).slice(2, 8)}`,
        email,
        addedAt: now,
        lastUsedAt: now
      };
      await storage.set(EMAIL_ADDRESSES_KEY, [item, ...items].slice(0, EMAIL_ADDRESS_LIMIT));
      return item;
    },
    async removeEmail(emailOrId) {
      const items = await repo.getAllEmails();
      await storage.set(EMAIL_ADDRESSES_KEY, items.filter((item) => item.id !== emailOrId
        && item.email.toLocaleLowerCase() !== String(emailOrId || '').trim().toLocaleLowerCase()));
    },
    async clear() {
      if (typeof storage.delete === 'function') await storage.delete(EMAIL_ADDRESSES_KEY);
      else await storage.set(EMAIL_ADDRESSES_KEY, []);
    }
  };
  repo.remember = (email) => repo.addEmail(email);
  repo.deleteEmail = (emailOrId) => repo.removeEmail(emailOrId);
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
  const id = /^tg-[A-Za-z0-9_-]{1,100}$/.test(String(group.id || '')) ? String(group.id) : null;
  return { ...(id ? { id } : {}), name, ...(color ? { color } : {}) };
}

const TAB_GROUPS_KEY = 'tab-groups';
const TAB_GROUP_ID = /^tg-[A-Za-z0-9_-]{1,100}$/;
const TAB_GROUP_MEMBER_ID = /^tgm-[A-Za-z0-9_-]{1,120}$/;

function sanitizeDurableTabUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
        ? parsed.toString()
        : null;
    } catch { return null; }
  }
  // Internal pages are safe to recreate. Runtime yayra://doc ids are not;
  // recoverable files use a separate sanitized opaque descriptor.
  if (/^yayra:\/\/(?!doc\/)[A-Za-z0-9._~/?#=&%+-]{1,2048}$/i.test(value)) return value;
  return value === 'about:blank' ? value : null;
}

function sanitizeDurableTabGroup(group) {
  if (!group || typeof group !== 'object' || !TAB_GROUP_ID.test(String(group.id || ''))) return null;
  const name = String(group.name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!name) return null;
  const rawColor = String(group.color || '').trim().toLowerCase();
  const color = /^#[0-9a-f]{6}$/.test(rawColor) ? rawColor : '#8b5cf6';
  const seenMembers = new Set();
  const members = [];
  for (const candidate of Array.isArray(group.members) ? group.members : []) {
    const id = String(candidate?.id || '');
    const document = sanitizeSessionDocument(candidate?.document);
    const url = document
      ? `yayra://recover-document/${encodeURIComponent(document.libraryId || document.recoveryId)}`
      : sanitizeDurableTabUrl(candidate?.url);
    if (!TAB_GROUP_MEMBER_ID.test(id) || seenMembers.has(id) || !url) continue;
    seenMembers.add(id);
    members.push({
      id,
      url,
      title: document?.name || String(candidate?.title || url).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || url,
      ...(document ? { document } : {}),
      createdAt: Number(candidate?.createdAt) || Date.now(),
      updatedAt: Number(candidate?.updatedAt) || Number(candidate?.createdAt) || Date.now()
    });
  }
  return {
    id: String(group.id),
    name,
    color,
    members,
    createdAt: Number(group.createdAt) || Date.now(),
    updatedAt: Number(group.updatedAt) || Number(group.createdAt) || Date.now()
  };
}

/**
 * Durable, profile-scoped tab-group catalog. It is intentionally separate
 * from the rolling open-tab session: closing a tab, quitting, restoring an
 * update, or opening every member never deletes a catalog row. Only explicit
 * ungroup/delete actions replace the catalog without that group/member.
 */
export function createTabGroupsRepo(storage) {
  const sanitize = (groups) => {
    const result = [];
    const ids = new Set();
    for (const candidate of Array.isArray(groups) ? groups : []) {
      const group = sanitizeDurableTabGroup(candidate);
      if (!group || ids.has(group.id)) continue;
      ids.add(group.id);
      result.push(group);
    }
    return result;
  };
  return {
    async getGroups() {
      return sanitize(await storage.get(TAB_GROUPS_KEY));
    },
    async saveGroups(groups) {
      const safeGroups = sanitize(groups);
      await storage.set(TAB_GROUPS_KEY, safeGroups);
      return safeGroups;
    }
  };
}

/**
 * "Continue with these tabs": a rolling snapshot of the tabs currently
 * open (non-private, real websites only). Closing a tab by hand removes
 * it from the snapshot naturally, so whatever is left when the app
 * exits = the tabs the user did NOT manually close - exactly what the
 * next launch should offer to continue with.
 */
const SESSION_DOCUMENT_LIBRARY_ID = /^local-[A-Za-z0-9-]{8,}$/;
const SESSION_DOCUMENT_RECOVERY_ID = /^docrec-[A-Za-z0-9_-]{8,120}$/;

function sanitizeSessionDocument(value) {
  if (!value || typeof value !== 'object') return null;
  const libraryId = SESSION_DOCUMENT_LIBRARY_ID.test(String(value.libraryId || '')) ? String(value.libraryId) : null;
  const recoveryId = SESSION_DOCUMENT_RECOVERY_ID.test(String(value.recoveryId || '')) ? String(value.recoveryId) : null;
  if (!libraryId && !recoveryId) return null;
  return {
    ...(libraryId ? { libraryId } : {}),
    ...(recoveryId ? { recoveryId } : {}),
    name: String(value.name || 'Local file').replace(/\\/g, '/').split('/').pop()
      .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || 'Local file',
    mime: String(value.mime || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200),
    size: Math.max(0, Math.min(300 * 1024 * 1024, Number(value.size) || 0))
  };
}

export function createSessionRepo(storage) {
  const sanitize = (tabs) => (Array.isArray(tabs) ? tabs : [])
    .map(({ url, title, group, groupMemberId, document, isPrivate } = {}) => {
      if (isPrivate) return null;
      const safeGroup = sanitizeSessionGroup(group);
      const safeMemberId = TAB_GROUP_MEMBER_ID.test(String(groupMemberId || '')) ? String(groupMemberId) : null;
      const safeDocument = sanitizeSessionDocument(document);
      if (safeDocument) {
        const id = safeDocument.libraryId || safeDocument.recoveryId;
        return {
          url: `yayra://recover-document/${encodeURIComponent(id)}`,
          title: safeDocument.name,
          document: safeDocument,
          ...(safeGroup ? { group: safeGroup } : {}),
          ...(safeGroup && safeMemberId ? { groupMemberId: safeMemberId } : {})
        };
      }
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 8192) return null;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      } catch { return null; }
      return {
        url,
        title: String(title || url).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
        ...(safeGroup ? { group: safeGroup } : {}),
        ...(safeGroup && safeMemberId ? { groupMemberId: safeMemberId } : {})
      };
    })
    .filter(Boolean);
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
