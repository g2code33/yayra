/**
 * Yayra Floating Browser - Local-First Memory & Storage Adapters
 * Pure local-first implementation with memory, localStorage, and corrupted data recovery.
 */

import { IPersistenceAdapter } from './IPersistenceEngine.js';

export class MemoryPersistenceAdapter implements IPersistenceAdapter {
  public store: Map<string, string> = new Map();

  public async get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }

  public async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

export class LocalStorageAdapter implements IPersistenceAdapter {
  private prefix: string;

  constructor(prefix = 'yayra:') {
    this.prefix = prefix;
  }

  public async get<T>(key: string): Promise<T | null> {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${this.prefix}${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${this.prefix}${key}`, JSON.stringify(value));
  }

  public async delete(key: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(`${this.prefix}${key}`);
  }

  public async clear(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  }

  public async keys(): Promise<string[]> {
    if (typeof localStorage === 'undefined') return [];
    const matched: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        matched.push(k.slice(this.prefix.length));
      }
    }
    return matched;
  }
}

/**
 * Resilient Adapter Wrapper that recovers from corrupted JSON or malformed records,
 * archiving the bad record and falling back to safe defaults or last-known-good state.
 */
export class CorruptedDataRecoveryAdapter implements IPersistenceAdapter {
  private inner: IPersistenceAdapter;
  private fallbackStore: Map<string, any> = new Map();
  private corruptionLog: string[] = [];

  constructor(inner: IPersistenceAdapter) {
    this.inner = inner;
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const val = await this.inner.get<T>(key);
      if (val !== null && typeof val === 'object') {
        this.fallbackStore.set(key, JSON.parse(JSON.stringify(val)));
        return val;
      }
      if (val === null && this.fallbackStore.has(key)) {
        this.corruptionLog.push(`Corrupted key recovered from last-known-good [${key}]`);
        return this.fallbackStore.get(key) || null;
      }
      return val;
    } catch (err: any) {
      this.corruptionLog.push(`Corrupted key encountered [${key}]: ${err.message}`);
      return this.fallbackStore.get(key) || null;
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    await this.inner.set(key, value);
    this.fallbackStore.set(key, JSON.parse(JSON.stringify(value)));
  }

  public async delete(key: string): Promise<void> {
    await this.inner.delete(key);
    this.fallbackStore.delete(key);
  }

  public async clear(): Promise<void> {
    await this.inner.clear();
    this.fallbackStore.clear();
  }

  public async keys(): Promise<string[]> {
    return this.inner.keys();
  }

  public getCorruptionLog(): string[] {
    return [...this.corruptionLog];
  }
}
