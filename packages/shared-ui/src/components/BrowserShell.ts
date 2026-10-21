/**
 * Yayra Floating Browser - Mainstream Browser-First Shell (TypeScript Definitions)
 */

export interface BrowserTabGroupState {
  name: string;
  color?: string;
}

export interface CreateNewTabOptions {
  group?: BrowserTabGroupState | null;
  render?: boolean;
  afterTabId?: string | null;
}

export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  group?: BrowserTabGroupState | null;
  isSecure?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  isPrivate?: boolean;
  favicon?: string | null;
}

export interface BrowserShellOptions {
  container?: HTMLElement | null;
  platform?: 'windows' | 'linux' | 'android' | 'ios' | 'desktop' | 'web' | 'pwa';
  isMobile?: boolean;
  initialUrl?: string;
  initialPrivate?: boolean;
  tabs?: BrowserTabState[];
  activeTabId?: string;
  navigationController?: any;
  historyRepo?: any;
  bookmarksRepo?: any;
  downloadsRepo?: any;
  settingsRepo?: any;
  privacyManager?: any;
  updateService?: any;
  passwordManager?: any;
  extensionManager?: any;
  storageAdapter?: any;
  desktopFloatingMode?: 'circle-first' | 'browser-first';
  initialSettings?: Record<string, any>;
  onMinimizeToBubble?: () => void;
  onToggleMode?: (mode: string) => void;
}

export declare class BrowserShell {
  constructor(options?: BrowserShellOptions);
  initialize(): Promise<void>;
  render(container?: HTMLElement | null): HTMLElement | null;
  getActiveTab(): BrowserTabState;
  createNewTab(isPrivate?: boolean, options?: CreateNewTabOptions): BrowserTabState;
  selectTab(tabId: string): void;
  closeTab(tabId: string): void;
  reopenLastClosedTab(): void;
  reorderTabs(fromIdx: number, toIdx: number): void;
  detachTabToWindow(tabId: string): Promise<boolean>;
  navigateActiveTab(rawInput: string): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
  toggleBookmarkCurrentTab(): Promise<void>;
  setZoom(level: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  toggleFullscreen(): void;
  executeFindInPage(query: string): void;
  minimizeToBubble(): void;
  restoreFromBubble(): void;
  toggleDesktopMode(): void;
  openModal(modalName: string): void;
  closeModal(): void;
  toggleModal(modalName: string): void;
  destroy(): void;
}
