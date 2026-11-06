const DB_NAME = 'yayra-dictionary-library';
const DB_VERSION = 1;
const ENTRY_STORE = 'entries';
const PACK_STORE = 'packMeta';
const ACTIVE_STORE = 'activePacks';
const VOCAB_STORE = 'vocabulary';
const PARTIAL_STORE = 'partials';
const MAX_VOCAB_ITEMS = 50_000;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('dictionary-storage-request-failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('dictionary-storage-transaction-failed'));
    tx.onabort = () => reject(tx.error || new Error('dictionary-storage-transaction-aborted'));
  });
}

export class MemoryDictionaryStore {
  constructor() {
    this.persistent = false;
    this.packs = new Map();
    this.active = new Map();
    this.entries = new Map();
    this.vocabulary = new Map();
    this.partials = new Map();
  }

  async getActivePacks() {
    return [...this.active.values()].map((active) => this.packs.get(`${active.id}@${active.version}`))
      .filter((pack) => pack?.enabled !== false).map((pack) => ({ ...pack }));
  }

  async getPackCatalog() { return [...this.packs.values()].map((pack) => ({ ...pack })); }
  async getPack(id, version = null) {
    if (version) return this.packs.get(`${id}@${version}`) || null;
    const active = this.active.get(id);
    return active ? this.packs.get(`${id}@${active.version}`) || null : null;
  }

  async findEntries(packId, version, prefix, limit = 30) {
    const packKey = `${packId}@${version}`;
    return [...this.entries.values()].filter((entry) => entry.packKey === packKey && entry.normalizedTerm.startsWith(prefix))
      .sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm)).slice(0, limit).map(({ packKey: _packKey, ...entry }) => ({ ...entry }));
  }

  async savePack(meta, entries) {
    const packKey = `${meta.id}@${meta.version}`;
    const normalized = entries.map((entry) => ({ ...entry, packKey, key: `${packKey}:${entry.normalizedTerm}` }));
    for (const [key, row] of this.entries) if (row.packKey === packKey) this.entries.delete(key);
    for (const row of normalized) this.entries.set(row.key, row);
    this.packs.set(packKey, { ...meta, entryCount: normalized.length, installedAt: Date.now() });
    this.active.set(meta.id, { id: meta.id, version: meta.version, enabled: meta.enabled !== false });
    for (const [oldKey, oldPack] of this.packs) {
      if (oldPack.id !== meta.id || oldKey === packKey) continue;
      this.packs.delete(oldKey);
      for (const [entryKey, row] of this.entries) if (row.packKey === oldKey) this.entries.delete(entryKey);
    }
  }

  async setPackEnabled(id, enabled) {
    const active = this.active.get(id);
    if (!active) return false;
    active.enabled = Boolean(enabled);
    this.active.set(id, active);
    const pack = this.packs.get(`${id}@${active.version}`);
    if (pack) pack.enabled = active.enabled;
    return true;
  }

  async removePack(id) {
    const active = this.active.get(id);
    this.active.delete(id);
    if (!active) return false;
    const packKey = `${id}@${active.version}`;
    this.packs.delete(packKey);
    for (const [key, row] of this.entries) if (row.packKey === packKey) this.entries.delete(key);
    this.partials.delete(id);
    return true;
  }

  async saveVocabulary(item) { this.vocabulary.set(item.id, { ...item }); return item; }
  async getVocabulary(ownerProfile) { return [...this.vocabulary.values()].filter((item) => item.ownerProfile === ownerProfile).map((item) => ({ ...item })); }
  async deleteVocabulary(ownerProfile, id) {
    const item = this.vocabulary.get(id);
    if (!item || item.ownerProfile !== ownerProfile) return false;
    return this.vocabulary.delete(id);
  }
  async getPartial(id) { return this.partials.get(id) || null; }
  async savePartial(id, partial) { this.partials.set(id, { id, ...partial }); }
  async removePartial(id) { this.partials.delete(id); }
}

export function createDictionaryStore({ indexedDBImpl = typeof indexedDB !== 'undefined' ? indexedDB : null } = {}) {
  if (!indexedDBImpl?.open) return new MemoryDictionaryStore();
  let dbPromise;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRY_STORE)) {
          const store = db.createObjectStore(ENTRY_STORE, { keyPath: 'key' });
          store.createIndex('packKey', 'packKey', { unique: false });
          store.createIndex('packTerm', ['packKey', 'normalizedTerm'], { unique: true });
        }
        if (!db.objectStoreNames.contains(PACK_STORE)) db.createObjectStore(PACK_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(ACTIVE_STORE)) db.createObjectStore(ACTIVE_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(VOCAB_STORE)) {
          const store = db.createObjectStore(VOCAB_STORE, { keyPath: 'id' });
          store.createIndex('ownerProfile', 'ownerProfile', { unique: false });
          store.createIndex('ownerKind', ['ownerProfile', 'kind'], { unique: false });
          store.createIndex('ownerUpdated', ['ownerProfile', 'updatedAt'], { unique: false });
        }
        if (!db.objectStoreNames.contains(PARTIAL_STORE)) db.createObjectStore(PARTIAL_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('dictionary-storage-open-failed'));
      request.onblocked = () => reject(new Error('dictionary-storage-upgrade-blocked'));
    }).catch((error) => { dbPromise = null; throw error; });
    return dbPromise;
  };
  const getAll = async (storeName) => {
    const db = await open();
    const tx = db.transaction(storeName, 'readonly');
    const result = await requestValue(tx.objectStore(storeName).getAll());
    await transactionDone(tx);
    return result;
  };
  const deleteEntriesForPack = async (packKey) => {
    const db = await open();
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    const index = tx.objectStore(ENTRY_STORE).index('packKey');
    const cursorRequest = index.openCursor(IDBKeyRange.only(packKey));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await transactionDone(tx);
  };

  return {
    persistent: true,
    async getActivePacks() {
      const [active, packs] = await Promise.all([getAll(ACTIVE_STORE), getAll(PACK_STORE)]);
      const byKey = new Map(packs.map((pack) => [pack.key, pack]));
      return active.filter((item) => item.enabled !== false).map((item) => byKey.get(`${item.id}@${item.version}`)).filter(Boolean);
    },
    async getPackCatalog() { return getAll(PACK_STORE); },
    async getPack(id, version = null) {
      const db = await open();
      const tx = db.transaction(version ? PACK_STORE : ACTIVE_STORE, 'readonly');
      const store = tx.objectStore(version ? PACK_STORE : ACTIVE_STORE);
      const value = await requestValue(store.get(version ? `${id}@${version}` : id));
      await transactionDone(tx);
      if (!value) return null;
      if (!version) {
        const next = await this.getPack(id, value.version);
        return next ? { ...next, enabled: value.enabled !== false } : null;
      }
      return value;
    },
    async findEntries(packId, version, prefix, limit = 30) {
      const db = await open();
      const tx = db.transaction(ENTRY_STORE, 'readonly');
      const index = tx.objectStore(ENTRY_STORE).index('packTerm');
      const lower = [ `${packId}@${version}`, prefix ];
      const upper = [ `${packId}@${version}`, `${prefix}\uffff` ];
      const range = IDBKeyRange.bound(lower, upper, false, false);
      const values = await requestValue(index.getAll(range, Math.max(1, Math.min(100, limit))));
      await transactionDone(tx);
      return values.map(({ packKey: _packKey, key: _key, ...entry }) => entry);
    },
    async savePack(meta, entries) {
      const packKey = `${meta.id}@${meta.version}`;
      await deleteEntriesForPack(packKey);
      const batchSize = 500;
      for (let start = 0; start < entries.length; start += batchSize) {
        const db = await open();
        const tx = db.transaction(ENTRY_STORE, 'readwrite');
        const store = tx.objectStore(ENTRY_STORE);
        for (const entry of entries.slice(start, start + batchSize)) {
          store.put({ ...entry, packKey, key: `${packKey}:${entry.normalizedTerm}` });
        }
        await transactionDone(tx);
      }
      const db = await open();
      const tx = db.transaction([PACK_STORE, ACTIVE_STORE], 'readwrite');
      tx.objectStore(PACK_STORE).put({ ...meta, key: packKey, entryCount: entries.length, installedAt: Date.now() });
      tx.objectStore(ACTIVE_STORE).put({ id: meta.id, version: meta.version, enabled: meta.enabled !== false });
      await transactionDone(tx);
      const stalePacks = (await getAll(PACK_STORE)).filter((pack) => pack.id === meta.id && pack.key !== packKey);
      if (stalePacks.length) {
        const cleanup = (await open()).transaction(PACK_STORE, 'readwrite');
        for (const pack of stalePacks) cleanup.objectStore(PACK_STORE).delete(pack.key);
        await transactionDone(cleanup);
        for (const pack of stalePacks) await deleteEntriesForPack(`${pack.id}@${pack.version}`);
      }
    },
    async setPackEnabled(id, enabled) {
      const db = await open();
      const tx = db.transaction([PACK_STORE, ACTIVE_STORE], 'readwrite');
      const activeStore = tx.objectStore(ACTIVE_STORE);
      const active = await requestValue(activeStore.get(id));
      if (!active) { tx.abort(); return false; }
      active.enabled = Boolean(enabled);
      activeStore.put(active);
      const packStore = tx.objectStore(PACK_STORE);
      const pack = await requestValue(packStore.get(`${id}@${active.version}`));
      if (pack) { pack.enabled = active.enabled; packStore.put(pack); }
      await transactionDone(tx);
      return true;
    },
    async removePack(id) {
      const packCatalog = await getAll(PACK_STORE);
      const packs = packCatalog.filter((pack) => pack.id === id);
      const db = await open();
      const tx = db.transaction([PACK_STORE, ACTIVE_STORE, PARTIAL_STORE], 'readwrite');
      for (const pack of packs) tx.objectStore(PACK_STORE).delete(pack.key);
      tx.objectStore(ACTIVE_STORE).delete(id);
      tx.objectStore(PARTIAL_STORE).delete(id);
      await transactionDone(tx);
      for (const pack of packs) await deleteEntriesForPack(`${id}@${pack.version}`);
      return packs.length > 0;
    },
    async saveVocabulary(item) {
      const db = await open();
      const tx = db.transaction(VOCAB_STORE, 'readwrite');
      tx.objectStore(VOCAB_STORE).put(item);
      await transactionDone(tx);
      return item;
    },
    async getVocabulary(ownerProfile) {
      const db = await open();
      const tx = db.transaction(VOCAB_STORE, 'readonly');
      const items = await requestValue(tx.objectStore(VOCAB_STORE).index('ownerProfile').getAll(IDBKeyRange.only(ownerProfile), MAX_VOCAB_ITEMS));
      await transactionDone(tx);
      return items;
    },
    async deleteVocabulary(ownerProfile, id) {
      const db = await open();
      const tx = db.transaction(VOCAB_STORE, 'readwrite');
      const store = tx.objectStore(VOCAB_STORE);
      const item = await requestValue(store.get(id));
      if (!item || item.ownerProfile !== ownerProfile) { tx.abort(); return false; }
      store.delete(id);
      await transactionDone(tx);
      return true;
    },
    async getPartial(id) {
      const db = await open();
      const tx = db.transaction(PARTIAL_STORE, 'readonly');
      const partial = await requestValue(tx.objectStore(PARTIAL_STORE).get(id));
      await transactionDone(tx);
      return partial || null;
    },
    async savePartial(id, partial) {
      const db = await open();
      const tx = db.transaction(PARTIAL_STORE, 'readwrite');
      tx.objectStore(PARTIAL_STORE).put({ ...partial, id });
      await transactionDone(tx);
    },
    async removePartial(id) {
      const db = await open();
      const tx = db.transaction(PARTIAL_STORE, 'readwrite');
      tx.objectStore(PARTIAL_STORE).delete(id);
      await transactionDone(tx);
    }
  };
}
