'use strict';

/**
 * Main-process-only catalog for local files explicitly opened through Yayra.
 *
 * The source path is deliberately persisted only in Electron's trusted
 * userData directory. Renderer-facing records use an opaque random id and
 * never expose a path, so a compromised page cannot turn the recents list
 * into arbitrary filesystem access.
 */

const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

const LIBRARY_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_VIEW_BYTES = 300 * 1024 * 1024;

const INTERNAL_EXTENSIONS = new Set([
  'pdf', 'pptx', 'pptm', 'docx', 'xlsx', 'xlsm', 'xls', 'csv',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg',
  'txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml',
  // These legacy formats intentionally open the honest fallback surface,
  // which offers the unchanged original to the system application.
  'ppt', 'doc'
]);

const TYPE_GROUPS = Object.freeze({
  pdf: new Set(['pdf']),
  presentation: new Set(['pptx', 'pptm', 'ppt', 'odp', 'key']),
  document: new Set(['docx', 'doc', 'odt', 'rtf', 'pages']),
  spreadsheet: new Set(['xlsx', 'xlsm', 'xls', 'csv', 'ods', 'numbers']),
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg', 'tif', 'tiff', 'heic']),
  text: new Set(['txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml']),
  archive: new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'])
});

function extensionFor(name, pathImpl = nodePath) {
  return String(pathImpl.extname(String(name || '')) || '').replace(/^\./, '').toLocaleLowerCase();
}

function categoryForExtension(extension) {
  const ext = String(extension || '').toLocaleLowerCase();
  for (const [category, extensions] of Object.entries(TYPE_GROUPS)) {
    if (extensions.has(ext)) return category;
  }
  return 'other';
}

function createOpaqueId(cryptoImpl = nodeCrypto) {
  if (typeof cryptoImpl.randomUUID === 'function') return `local-${cryptoImpl.randomUUID()}`;
  return `local-${cryptoImpl.randomBytes(18).toString('hex')}`;
}

function finiteTime(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function createDocumentLibrary({
  fs,
  path = nodePath,
  crypto = nodeCrypto,
  shell = null,
  userDataDir,
  fileName = 'document-library.json',
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxViewBytes = DEFAULT_MAX_VIEW_BYTES,
  now = () => Date.now()
} = {}) {
  if (!fs || !userDataDir) throw new TypeError('fs and userDataDir are required');
  const storePath = path.join(userDataDir, fileName);
  const safeMaxEntries = Math.max(10, Math.min(10000, Number(maxEntries) || DEFAULT_MAX_ENTRIES));
  const safeMaxViewBytes = Math.max(1, Number(maxViewBytes) || DEFAULT_MAX_VIEW_BYTES);
  let loaded = false;
  let state = { version: LIBRARY_VERSION, entries: [] };

  const cleanEntry = (value) => {
    if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !path.isAbsolute(value.path)) return null;
    const timestamp = finiteTime(value.lastOpenedAt, now());
    const name = String(value.name || path.basename(value.path) || 'Local file').replace(/[\u0000-\u001f]/g, '').slice(0, 240) || 'Local file';
    const extension = extensionFor(name, path);
    return {
      id: typeof value.id === 'string' && /^local-[a-zA-Z0-9-]{8,}$/.test(value.id)
        ? value.id
        : createOpaqueId(crypto),
      path: path.resolve(value.path),
      name,
      extension,
      category: categoryForExtension(extension),
      size: Math.max(0, Number(value.size) || 0),
      firstOpenedAt: finiteTime(value.firstOpenedAt, timestamp),
      lastOpenedAt: timestamp,
      openedCount: Math.max(1, Math.floor(Number(value.openedCount) || 1)),
      modifiedAt: Math.max(0, Number(value.modifiedAt) || 0),
      available: value.available !== false
    };
  };

  function ensureLoaded() {
    if (loaded) return state;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries.map(cleanEntry).filter(Boolean) : [];
      const seen = new Set();
      state = {
        version: LIBRARY_VERSION,
        entries: entries.filter((entry) => {
          const key = process.platform === 'win32' ? entry.path.toLocaleLowerCase() : entry.path;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, safeMaxEntries)
      };
    } catch {
      state = { version: LIBRARY_VERSION, entries: [] };
    }
    return state;
  }

  function persist() {
    ensureLoaded();
    fs.mkdirSync(userDataDir, { recursive: true });
    const temporary = `${storePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows / unusual filesystems */ }
    try {
      fs.renameSync(temporary, storePath);
    } catch (error) {
      try { fs.rmSync(storePath, { force: true }); } catch { /* absent */ }
      fs.renameSync(temporary, storePath);
    }
  }

  function canonicalPathSync(filePath) {
    const absolute = path.resolve(String(filePath || ''));
    try { return fs.realpathSync(absolute); } catch { return absolute; }
  }

  function findById(id) {
    ensureLoaded();
    return state.entries.find((entry) => entry.id === String(id || '')) || null;
  }

  function toRendererEntry(entry) {
    if (!entry) return null;
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      extension: entry.extension,
      category: entry.category,
      size: entry.size,
      firstOpenedAt: entry.firstOpenedAt,
      lastOpenedAt: entry.lastOpenedAt,
      openedCount: entry.openedCount,
      modifiedAt: entry.modifiedAt,
      available: entry.available !== false,
      canOpenInYayra: INTERNAL_EXTENSIONS.has(entry.extension),
      preferredAction: INTERNAL_EXTENSIONS.has(entry.extension) ? 'yayra' : 'system'
    });
  }

  function recordPathSync(filePath, { countOpen = true } = {}) {
    ensureLoaded();
    const canonical = canonicalPathSync(filePath);
    const stat = fs.statSync(canonical);
    if (!stat.isFile()) throw Object.assign(new Error('not-a-file'), { code: 'NOT_A_FILE' });
    const timestamp = now();
    const compare = process.platform === 'win32' ? canonical.toLocaleLowerCase() : canonical;
    let entry = state.entries.find((candidate) => {
      const candidatePath = process.platform === 'win32' ? candidate.path.toLocaleLowerCase() : candidate.path;
      return candidatePath === compare;
    });
    if (entry) {
      entry.name = String(path.basename(canonical) || entry.name).replace(/[\u0000-\u001f]/g, '').slice(0, 240);
      entry.extension = extensionFor(entry.name, path);
      entry.category = categoryForExtension(entry.extension);
      entry.size = stat.size;
      entry.modifiedAt = Number(stat.mtimeMs) || entry.modifiedAt;
      entry.available = true;
      if (countOpen) {
        entry.lastOpenedAt = timestamp;
        entry.openedCount += 1;
      }
    } else {
      const name = String(path.basename(canonical) || 'Local file').replace(/[\u0000-\u001f]/g, '').slice(0, 240) || 'Local file';
      const extension = extensionFor(name, path);
      entry = {
        id: createOpaqueId(crypto),
        path: canonical,
        name,
        extension,
        category: categoryForExtension(extension),
        size: stat.size,
        firstOpenedAt: timestamp,
        lastOpenedAt: timestamp,
        openedCount: 1,
        modifiedAt: Number(stat.mtimeMs) || 0,
        available: true
      };
      state.entries.push(entry);
    }
    state.entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    state.entries = state.entries.slice(0, safeMaxEntries);
    persist();
    return toRendererEntry(entry);
  }

  async function recordPath(filePath, options) {
    return recordPathSync(filePath, options);
  }

  async function list() {
    ensureLoaded();
    let changed = false;
    await Promise.all(state.entries.map(async (entry) => {
      try {
        const stat = await fs.promises.stat(entry.path);
        const available = stat.isFile();
        if (entry.available !== available || (available && (entry.size !== stat.size || entry.modifiedAt !== Number(stat.mtimeMs)))) changed = true;
        entry.available = available;
        if (available) {
          entry.size = stat.size;
          entry.modifiedAt = Number(stat.mtimeMs) || entry.modifiedAt;
        }
      } catch {
        if (entry.available !== false) changed = true;
        entry.available = false;
      }
    }));
    if (changed) persist();
    return state.entries
      .slice()
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map(toRendererEntry);
  }

  function touchOpened(entry, stat) {
    entry.available = true;
    entry.lastOpenedAt = now();
    entry.openedCount += 1;
    entry.size = stat.size;
    entry.modifiedAt = Number(stat.mtimeMs) || entry.modifiedAt;
    state.entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    persist();
  }

  async function open(id, { external = false } = {}) {
    const entry = findById(id);
    if (!entry) return { ok: false, reason: 'not-found' };
    let stat;
    try {
      stat = await fs.promises.stat(entry.path);
      if (!stat.isFile()) throw Object.assign(new Error('not-a-file'), { code: 'NOT_A_FILE' });
    } catch (error) {
      entry.available = false;
      persist();
      return { ok: false, reason: error?.code === 'EACCES' ? 'permission-denied' : 'unavailable', entry: toRendererEntry(entry) };
    }

    const shouldUseSystem = external || !INTERNAL_EXTENSIONS.has(entry.extension);
    if (shouldUseSystem) {
      if (!shell || typeof shell.openPath !== 'function') return { ok: false, reason: 'system-app-unavailable' };
      const error = await shell.openPath(entry.path);
      if (error) return { ok: false, reason: String(error), entry: toRendererEntry(entry) };
      touchOpened(entry, stat);
      return { ok: true, action: 'system', entry: toRendererEntry(entry) };
    }

    if (stat.size > safeMaxViewBytes) {
      entry.size = stat.size;
      entry.available = true;
      persist();
      return { ok: false, reason: 'file-too-large', maxBytes: safeMaxViewBytes, entry: toRendererEntry(entry) };
    }
    try {
      const data = await fs.promises.readFile(entry.path);
      touchOpened(entry, stat);
      return {
        ok: true,
        action: 'yayra',
        name: entry.name,
        size: stat.size,
        data,
        libraryId: entry.id,
        entry: toRendererEntry(entry)
      };
    } catch (error) {
      return { ok: false, reason: error?.code === 'EACCES' ? 'permission-denied' : 'read-failed', entry: toRendererEntry(entry) };
    }
  }

  async function relink(id, filePath) {
    const entry = findById(id);
    if (!entry) return { ok: false, reason: 'not-found' };
    try {
      const canonical = canonicalPathSync(filePath);
      const stat = await fs.promises.stat(canonical);
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
      const name = String(path.basename(canonical) || entry.name).replace(/[\u0000-\u001f]/g, '').slice(0, 240) || entry.name;
      entry.path = canonical;
      entry.name = name;
      entry.extension = extensionFor(name, path);
      entry.category = categoryForExtension(entry.extension);
      entry.size = stat.size;
      entry.modifiedAt = Number(stat.mtimeMs) || entry.modifiedAt;
      entry.available = true;
      // If this source already had another stale catalog row, keep the id the
      // user explicitly chose to repair and remove the duplicate capability.
      const compare = process.platform === 'win32' ? canonical.toLocaleLowerCase() : canonical;
      state.entries = state.entries.filter((candidate) => candidate === entry
        || (process.platform === 'win32' ? candidate.path.toLocaleLowerCase() : candidate.path) !== compare);
      persist();
      return { ok: true, entry: toRendererEntry(entry) };
    } catch (error) {
      return { ok: false, reason: error?.code === 'EACCES' ? 'permission-denied' : 'unavailable' };
    }
  }

  async function showInFolder(id) {
    const entry = findById(id);
    if (!entry) return { ok: false, reason: 'not-found' };
    try {
      const stat = await fs.promises.stat(entry.path);
      if (!stat.isFile()) throw new Error('unavailable');
      if (!shell || typeof shell.showItemInFolder !== 'function') return { ok: false, reason: 'unsupported' };
      shell.showItemInFolder(entry.path);
      return { ok: true };
    } catch {
      entry.available = false;
      persist();
      return { ok: false, reason: 'unavailable', entry: toRendererEntry(entry) };
    }
  }

  function remove(id) {
    ensureLoaded();
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => entry.id !== String(id || ''));
    if (state.entries.length === before) return { ok: false, reason: 'not-found' };
    persist();
    return { ok: true };
  }

  function clear() {
    ensureLoaded();
    const removed = state.entries.length;
    state.entries = [];
    persist();
    return { ok: true, removed };
  }

  async function clearMissing() {
    await list();
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => entry.available !== false);
    const removed = before - state.entries.length;
    if (removed) persist();
    return { ok: true, removed };
  }

  function prune({ olderThanDays } = {}) {
    ensureLoaded();
    const days = Number(olderThanDays);
    if (!Number.isFinite(days) || days <= 0) return { ok: true, removed: 0 };
    const threshold = now() - (days * 24 * 60 * 60 * 1000);
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => entry.lastOpenedAt >= threshold);
    const removed = before - state.entries.length;
    if (removed) persist();
    return { ok: true, removed };
  }

  return Object.freeze({
    storePath,
    recordPath,
    recordPathSync,
    list,
    open,
    relink,
    showInFolder,
    remove,
    clear,
    clearMissing,
    prune,
    // Useful for policy checks and focused tests; no source path is exposed.
    canOpenInYayra: (name) => INTERNAL_EXTENSIONS.has(extensionFor(name, path))
  });
}

module.exports = {
  LIBRARY_VERSION,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_VIEW_BYTES,
  INTERNAL_EXTENSIONS,
  categoryForExtension,
  extensionFor,
  createDocumentLibrary
};
