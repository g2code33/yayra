/**
 * Yayra Floating Browser - Browser Engine Contract
 * Abstract interface unifying native engines:
 * - Android WebView / GeckoView
 * - Windows Microsoft Edge WebView2
 * - Linux WebKitGTK
 */

export interface BrowserEngineCapabilities {
  supportsIncognito: boolean;
  supportsCustomUserAgent: boolean;
  supportsHardwareAcceleration: boolean;
  supportsExtensions: boolean;
  supportsDirectComposition: boolean;
  engineName: 'AndroidWebView' | 'GeckoView' | 'EdgeWebView2' | 'WebKitGTK' | 'MockEngine';
  engineVersion: string;
}

export interface NavigationOptions {
  referrer?: string;
  headers?: Record<string, string>;
  userInitiated?: boolean;
  searchEngine?: string;
}

export interface EngineEventMap {
  'load:start': (url: string) => void;
  'load:commit': (url: string) => void;
  'load:finish': (url: string, statusCode: number) => void;
  'load:error': (url: string, errorCode: number, description: string) => void;
  'load:progress': (progress: number) => void;
  'title:received': (title: string) => void;
  'favicon:received': (faviconUrl: string) => void;
  'navigation:state-changed': (state: any) => void;
  'loading:state-changed': (state: any) => void;
  'new-window:requested': (targetUrl: string, userInitiated: boolean) => void;
  [key: string]: Function;
}

export interface IBrowserEngine {
  readonly capabilities: BrowserEngineCapabilities;

  /**
   * Initializes the native rendering surface within the given host element or native HWND/XID/View.
   */
  initialize(container: HTMLElement | unknown): Promise<void>;

  /**
   * Navigates to the specified target URL.
   */
  navigate(url: string, options?: NavigationOptions): Promise<void>;

  /**
   * Navigation alias for loadUrl.
   */
  loadUrl?(url: string, options?: NavigationOptions): Promise<void>;
  search?(query: string, engine?: any): Promise<void>;
  navigateHome?(): Promise<void>;

  /**
   * History traversal.
   */
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  canGoBack?(): boolean;
  canGoForward?(): boolean;

  /**
   * Reload current page.
   */
  reload(ignoreCache?: boolean): Promise<void>;

  /**
   * Stop in-flight loading.
   */
  stop(): Promise<void>;

  /**
   * Evaluate custom JavaScript within the browser context.
   */
  evaluateJavaScript<T = any>(script: string): Promise<T>;

  /**
   * Set display zoom scale.
   */
  setZoomLevel(zoom: number): Promise<void>;

  /**
   * Capture screenshot of visible webview surface.
   */
  captureScreenshot(): Promise<string>;

  /**
   * Cleanly teardown and dispose native engine resources to eliminate memory leaks.
   */
  destroy(): Promise<void>;
}
