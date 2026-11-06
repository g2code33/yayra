/**
 * Yayra Floating Browser - Private Browsing Storage Context
 */

import { MemoryPersistenceAdapter } from './LocalFirstStore.js';

export class PrivateBrowsingStorageContext {
  constructor() {
    this.ephemeralAdapter = new MemoryPersistenceAdapter();
    this.isDestroyed = false;
  }

  getAdapter() {
    if (this.isDestroyed) {
      throw new Error('PrivateBrowsingStorageContext has already been destroyed');
    }
    return this.ephemeralAdapter;
  }

  async destroy() {
    if (this.isDestroyed) return;
    await this.ephemeralAdapter.clear();
    this.isDestroyed = true;
  }

  isContextActive() {
    return !this.isDestroyed;
  }
}
