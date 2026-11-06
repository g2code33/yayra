/**
 * BrowserSettings Model
 * Configurable local-first browser preferences and privacy policies.
 */

export type SearchEngineType = 'duckduckgo' | 'searx' | 'google' | 'bing' | 'custom';

export interface BrowserSettings {
  startUrl: string;
  searchEngine: SearchEngineType;
  customSearchUrl?: string;
  defaultZoom: number;
  hardwareAcceleration: boolean;
  adBlockEnabled: boolean;
  doNotTrack: boolean;
  javascriptEnabled: boolean;
  clearHistoryOnExit: boolean;
  clearCookiesOnExit: boolean;
  allowWebsitePopups: boolean;
  defaultUserAgent?: string;
  desktopFloatingMode: 'circle-first' | 'browser-first';
  theme: 'dark' | 'light' | 'system';
  colorTheme?: 'blue' | 'purple' | 'green' | 'rose' | 'amber';
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = Object.freeze({
  startUrl: 'https://duckduckgo.com',
  searchEngine: 'duckduckgo',
  defaultZoom: 1.0,
  hardwareAcceleration: true,
  adBlockEnabled: true,
  doNotTrack: true,
  javascriptEnabled: true,
  clearHistoryOnExit: false,
  clearCookiesOnExit: false,
  allowWebsitePopups: false,
  desktopFloatingMode: 'circle-first',
  theme: 'dark',
  colorTheme: 'blue'
});

export function createDefaultBrowserSettings(overrides: Partial<BrowserSettings> = {}): BrowserSettings {
  return {
    ...DEFAULT_BROWSER_SETTINGS,
    ...overrides
  };
}
