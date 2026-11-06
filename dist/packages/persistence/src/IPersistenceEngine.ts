/**
 * Yayra Floating Browser - Persistence Engine Interfaces
 * Local-first persistence contracts ensuring ZERO cloud / backend lock-in,
 * transactional data integrity, schema migrations, and private browsing isolation.
 */

import {
  BookmarkItem,
  BrowserTab,
  DesktopFloatingMode,
  HistoryEntry,
  SnapSide,
  ThemeMode,
  SearchEngine,
  UserSettings,
  WindowGeometry
} from '../../shared-core/src/types.js';

// --- 1. Database Entity Interfaces ---

export interface BrowserTabEntity {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  favicon: string | null;
  isIncognito: boolean;
  zoomLevel: number;
  canGoBack: boolean;
  canGoForward: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserHistoryEntity {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  visitCount: number;
  lastVisitedAt: number;
  isIncognito: boolean;
  searchTerms?: string;
}

export interface BrowserBookmarkEntity {
  id: string;
  parentId: string | null;
  title: string;
  url?: string;
  favicon?: string | null;
  isFolder: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserSessionEntity {
  id: string;
  name: string;
  activeTabId: string | null;
  tabs: BrowserTabEntity[];
  windowGeometry: WindowGeometry;
  bubblePosition: { x: number; y: number; snapSide: SnapSide };
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadRecordEntity {
  id: string;
  url: string;
  fileName: string;
  filePath: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'pending' | 'in-progress' | 'completed' | 'cancelled' | 'interrupted';
  mimeType: string;
  createdAt: number;
  completedAt?: number;
}

export interface BrowserSettingsEntity {
  theme: ThemeMode;
  searchEngine: SearchEngine;
  customSearchUrl?: string;
  startUrl: string;
  homepage: string;
  defaultZoom: number;
  hardwareAcceleration: boolean;
  adBlockEnabled: boolean;
  clearHistoryOnExit: boolean;
  glassmorphismBlurRadius: number;
  glassmorphismOpacity: number;
  customUserAgent?: string;
}

export interface FloatingSettingsEntity {
  desktopFloatingMode: DesktopFloatingMode;
  startFloatingOnLaunch: boolean;
  alwaysOnTop: boolean;
  rememberPosition: boolean;
  rememberSize: boolean;
  minimizeToBubble: boolean;
  closeToTray: boolean;
  startWithWindows: boolean;
  bubbleX: number;
  bubbleY: number;
  bubbleSnapSide: SnapSide;
}

export type DesktopFloatingModeEntity = DesktopFloatingMode;

// --- 2. Storage Adapters & Contracts ---

export interface IPersistenceAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

export interface ISettingsRepository {
  getSettings(): Promise<UserSettings>;
  updateSettings(settings: Partial<UserSettings>): Promise<UserSettings>;
  saveWindowGeometry(geometry: WindowGeometry): Promise<void>;
  loadWindowGeometry(): Promise<WindowGeometry | null>;
  saveBubblePosition(pos: { x: number; y: number; snapSide: SnapSide }): Promise<void>;
  loadBubblePosition(): Promise<{ x: number; y: number; snapSide: SnapSide } | null>;
}

export interface IHistoryRepository {
  addEntry(url: string, title: string, favicon?: string | null, isIncognito?: boolean): Promise<BrowserHistoryEntity>;
  getEntries(limit?: number, offset?: number): Promise<BrowserHistoryEntity[]>;
  search(query: string, limit?: number): Promise<BrowserHistoryEntity[]>;
  clearHistory(): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  getLastVisited(): Promise<BrowserHistoryEntity | null>;
}

export interface IBookmarkRepository {
  addBookmark(title: string, url: string, parentId?: string | null, favicon?: string | null): Promise<BrowserBookmarkEntity>;
  createFolder(title: string, parentId?: string | null): Promise<BrowserBookmarkEntity>;
  getBookmarks(parentId?: string | null): Promise<BrowserBookmarkEntity[]>;
  searchBookmarks(query: string): Promise<BrowserBookmarkEntity[]>;
  deleteBookmark(id: string): Promise<void>;
  updateBookmark(id: string, updates: Partial<BrowserBookmarkEntity>): Promise<BrowserBookmarkEntity | null>;
}

export interface ISessionRepository {
  saveTabs(tabs: BrowserTab[], activeTabId: string | null): Promise<void>;
  restoreTabs(): Promise<{ tabs: BrowserTab[]; activeTabId: string | null } | null>;
  saveSession(session: BrowserSessionEntity): Promise<void>;
  restoreSession(sessionId?: string): Promise<BrowserSessionEntity | null>;
  clearSession(): Promise<void>;
}

export interface IDownloadRepository {
  addRecord(record: Omit<DownloadRecordEntity, 'createdAt'>): Promise<DownloadRecordEntity>;
  getRecords(): Promise<DownloadRecordEntity[]>;
  updateRecord(id: string, updates: Partial<DownloadRecordEntity>): Promise<DownloadRecordEntity | null>;
  deleteRecord(id: string): Promise<void>;
  clearDownloads(): Promise<void>;
}

export interface IPrivacyManager {
  clearHistory(): Promise<void>;
  clearCookies(): Promise<void>;
  clearCache(): Promise<void>;
  clearWebsiteStorage(): Promise<void>;
  clearDownloads(): Promise<void>;
  clearAllUserData(): Promise<void>;
}
