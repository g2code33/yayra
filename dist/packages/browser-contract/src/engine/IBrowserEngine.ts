/**
 * Yayra Floating Browser - Platform-Independent Browser Engine Interface
 * Pure contract defining browser navigation and lifecycle operations across
 * Android WebView/GeckoView, Windows WebView2, and Linux WebKitGTK.
 */

import { BrowserLoadingState } from '../models/BrowserLoadingState.js';
import { BrowserNavigationState } from '../models/BrowserNavigationState.js';
import { SearchEngineType } from '../models/BrowserSettings.js';

export interface NavigationOptions {
  referrer?: string;
  headers?: Record<string, string>;
  userInitiated?: boolean;
  searchEngine?: SearchEngineType;
}

export interface BrowserEngineCapabilities {
  supportsIncognito: boolean;
  supportsCustomUserAgent: boolean;
  supportsHardwareAcceleration: boolean;
  supportsExtensions: boolean;
  supportsDirectComposition: boolean;
  engineName: 'AndroidWebView' | 'GeckoView' | 'EdgeWebView2' | 'WebKitGTK' | 'AbstractEngine';
  engineVersion: string;
}

export interface EngineEventMap {
  'load:start': (url: string) => void;
  'load:commit': (url: string) => void;
  'load:finish': (url: string, statusCode: number) => void;
  'load:error': (url: string, errorCode: number, description: string) => void;
  'load:progress': (progress: number) => void;
  'title:received': (title: string) => void;
  'favicon:received': (faviconUrl: string) => void;
  'navigation:state-changed': (state: BrowserNavigationState) => void;
  'loading:state-changed': (state: BrowserLoadingState) => void;
  'new-window:requested': (targetUrl: string, userInitiated: boolean) => void;
}

export interface IBrowserEngine {
  readonly capabilities: BrowserEngineCapabilities;

  /**
   * Initializes the native rendering surface.
   */
  initialize(container?: HTMLElement | unknown): Promise<void>;

  /**
   * Navigation commands
   */
  loadUrl(url: string, options?: NavigationOptions): Promise<void>;
  search(query: string, engine?: SearchEngineType): Promise<void>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  reload(bypassCache?: boolean): Promise<void>;
  stop(): Promise<void>;
  navigateHome(): Promise<void>;

  /**
   * Inspection & state getters
   */
  getCurrentUrl(): string;
  getPageTitle(): string;
  getLoadingProgress(): number;
  getLoadingState(): BrowserLoadingState;
  getNavigationState(): BrowserNavigationState;
  canGoBack(): boolean;
  canGoForward(): boolean;

  /**
   * Surface controls
   */
  evaluateJavaScript<T = any>(script: string): Promise<T>;
  setZoomLevel(zoom: number): Promise<void>;
  getZoomLevel(): number;

  /**
   * Event registration & resource disposal
   */
  on<K extends keyof EngineEventMap>(event: K, listener: EngineEventMap[K]): () => void;
  destroy(): Promise<void>;
}
