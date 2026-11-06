/**
 * Yayra Floating Browser - Local-First Memory & Storage Adapters
 */

export class MemoryPersistenceAdapter {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    const raw = this.store.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(key, value) {
    this.store.set(key, JSON.stringify(value));
  }

  async delete(key) {
    this.store.delete(key);
  }

  async clear() {
    this.store.clear();
  }

  async keys() {
    return Array.from(this.store.keys());
  }
}

export class LocalStorageAdapter {
  constructor(prefix = 'yayra:') {
    this.prefix = prefix;
  }

  async get(key) {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${this.prefix}${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(key, value) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${this.prefix}${key}`, JSON.stringify(value));
  }

  async delete(key) {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(`${this.prefix}${key}`);
  }

  async clear() {
    if (typeof localStorage === 'undefined') return;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  }

  async keys() {
    if (typeof localStorage === 'undefined') return [];
    const matched = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        matched.push(k.slice(this.prefix.length));
      }
    }
    return matched;
  }
}

export class CorruptedDataRecoveryAdapter {
  constructor(inner) {
    this.inner = inner;
    this.fallbackStore = new Map();
    this.corruptionLog = [];
  }

  async get(key) {
    try {
      const val = await this.inner.get(key);
      if (val !== null && typeof val === 'object') {
        this.fallbackStore.set(key, JSON.parse(JSON.stringify(val)));
        return val;
      }
      if (val === null && this.fallbackStore.has(key)) {
        this.corruptionLog.push(`Corrupted key recovered from last-known-good [${key}]`);
        return this.fallbackStore.get(key) || null;
      }
      return val;
    } catch (err) {
      this.corruptionLog.push(`Corrupted key encountered [${key}]: ${err.message}`);
      return this.fallbackStore.get(key) || null;
    }
  }

  async set(key, value) {
    await this.inner.set(key, value);
    this.fallbackStore.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key) {
    await this.inner.delete(key);
    this.fallbackStore.delete(key);
  }

  async clear() {
    await this.inner.clear();
    this.fallbackStore.clear();
  }

  async keys() {
    return this.inner.keys();
  }

  getCorruptionLog() {
    return [...this.corruptionLog];
  }
}
