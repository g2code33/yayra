/**
 * Yayra Floating Browser - Private Browsing Storage Context
 * Ephemeral in-memory storage partition strictly isolated from disk storage.
 * Ensures private tabs, history, cookies, and cache never persist to persistent storage.
 */

import { IPersistenceAdapter } from './IPersistenceEngine.js';
import { MemoryPersistenceAdapter } from './LocalFirstStore.js';

export class PrivateBrowsingStorageContext {
  private ephemeralAdapter: IPersistenceAdapter;
  private isDestroyed: boolean = false;

  constructor() {
    this.ephemeralAdapter = new MemoryPersistenceAdapter();
  }

  public getAdapter(): IPersistenceAdapter {
    if (this.isDestroyed) {
      throw new Error('PrivateBrowsingStorageContext has already been destroyed');
    }
    return this.ephemeralAdapter;
  }

  public async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    await this.ephemeralAdapter.clear();
    this.isDestroyed = true;
  }

  public isContextActive(): boolean {
    return !this.isDestroyed;
  }
}
