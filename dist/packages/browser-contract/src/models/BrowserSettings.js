/**
 * BrowserSettings Model (JS runtime)
 */

export const DEFAULT_BROWSER_SETTINGS = Object.freeze({
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

export function createDefaultBrowserSettings(overrides = {}) {
  return {
    ...DEFAULT_BROWSER_SETTINGS,
    ...overrides
  };
}
