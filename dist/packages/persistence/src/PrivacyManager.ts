/**
 * Yayra Floating Browser - Privacy Manager
 * Provides user privacy operations: clearing history, cookies, cache, website storage,
 * individual records, bookmarks, downloads, and complete data wipe.
 */

import { IPersistenceAdapter, IPrivacyManager } from './IPersistenceEngine.js';
import { HistoryRepository, BookmarkRepository, SessionRepository, DownloadRepository } from './HistoryRepository.js';
import { SettingsRepository } from './SettingsRepository.js';

export class PrivacyManager implements IPrivacyManager {
  private adapter: IPersistenceAdapter;
  private historyRepo: HistoryRepository;
  private bookmarkRepo: BookmarkRepository;
  private sessionRepo: SessionRepository;
  private downloadRepo: DownloadRepository;
  private settingsRepo: SettingsRepository;

  constructor(
    adapter: IPersistenceAdapter,
    historyRepo?: HistoryRepository,
    bookmarkRepo?: BookmarkRepository,
    sessionRepo?: SessionRepository,
    downloadRepo?: DownloadRepository,
    settingsRepo?: SettingsRepository
  ) {
    this.adapter = adapter;
    this.historyRepo = historyRepo || new HistoryRepository(adapter);
    this.bookmarkRepo = bookmarkRepo || new BookmarkRepository(adapter);
    this.sessionRepo = sessionRepo || new SessionRepository(adapter);
    this.downloadRepo = downloadRepo || new DownloadRepository(adapter);
    this.settingsRepo = settingsRepo || new SettingsRepository(adapter);
  }

  public async clearHistory(): Promise<void> {
    await this.historyRepo.clearHistory();
  }

  public async clearCookies(): Promise<void> {
    const allKeys = await this.adapter.keys();
    const cookieKeys = allKeys.filter((k) => k.startsWith('cookie:') || k.startsWith('cookies:'));
    for (const k of cookieKeys) {
      await this.adapter.delete(k);
    }
  }

  public async clearCache(): Promise<void> {
    const allKeys = await this.adapter.keys();
    const cacheKeys = allKeys.filter((k) => k.startsWith('cache:') || k.startsWith('http-cache:'));
    for (const k of cacheKeys) {
      await this.adapter.delete(k);
    }
  }

  public async clearWebsiteStorage(): Promise<void> {
    const allKeys = await this.adapter.keys();
    const storageKeys = allKeys.filter(
      (k) => k.startsWith('webstorage:') || k.startsWith('idb:') || k.startsWith('site-data:')
    );
    for (const k of storageKeys) {
      await this.adapter.delete(k);
    }
  }

  public async clearDownloads(): Promise<void> {
    await this.downloadRepo.clearDownloads();
  }

  public async deleteHistoryEntry(id: string): Promise<void> {
    await this.historyRepo.deleteEntry(id);
  }

  public async deleteBookmark(id: string): Promise<void> {
    await this.bookmarkRepo.deleteBookmark(id);
  }

  public async clearAllUserData(): Promise<void> {
    await this.clearHistory();
    await this.clearCookies();
    await this.clearCache();
    await this.clearWebsiteStorage();
    await this.clearDownloads();
    await this.sessionRepo.clearSession();
  }
}
