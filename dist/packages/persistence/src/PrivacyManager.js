/**
 * Yayra Floating Browser - Privacy Manager
 */

import { HistoryRepository, BookmarkRepository, SessionRepository, DownloadRepository } from './HistoryRepository.js';
import { SettingsRepository } from './SettingsRepository.js';

export class PrivacyManager {
  constructor(
    adapter,
    historyRepo,
    bookmarkRepo,
    sessionRepo,
    downloadRepo,
    settingsRepo
  ) {
    this.adapter = adapter;
    this.historyRepo = historyRepo || new HistoryRepository(adapter);
    this.bookmarkRepo = bookmarkRepo || new BookmarkRepository(adapter);
    this.sessionRepo = sessionRepo || new SessionRepository(adapter);
    this.downloadRepo = downloadRepo || new DownloadRepository(adapter);
    this.settingsRepo = settingsRepo || new SettingsRepository(adapter);
  }

  async clearHistory() {
    await this.historyRepo.clearHistory();
  }

  async clearCookies() {
    const allKeys = await this.adapter.keys();
    const cookieKeys = allKeys.filter((k) => k.startsWith('cookie:') || k.startsWith('cookies:'));
    for (const k of cookieKeys) {
      await this.adapter.delete(k);
    }
  }

  async clearCache() {
    const allKeys = await this.adapter.keys();
    const cacheKeys = allKeys.filter((k) => k.startsWith('cache:') || k.startsWith('http-cache:'));
    for (const k of cacheKeys) {
      await this.adapter.delete(k);
    }
  }

  async clearWebsiteStorage() {
    const allKeys = await this.adapter.keys();
    const storageKeys = allKeys.filter(
      (k) => k.startsWith('webstorage:') || k.startsWith('idb:') || k.startsWith('site-data:')
    );
    for (const k of storageKeys) {
      await this.adapter.delete(k);
    }
  }

  async clearDownloads() {
    await this.downloadRepo.clearDownloads();
  }

  async deleteHistoryEntry(id) {
    await this.historyRepo.deleteEntry(id);
  }

  async deleteBookmark(id) {
    await this.bookmarkRepo.deleteBookmark(id);
  }

  async clearAllUserData() {
    await this.clearHistory();
    await this.clearCookies();
    await this.clearCache();
    await this.clearWebsiteStorage();
    await this.clearDownloads();
    await this.sessionRepo.clearSession();
  }
}
