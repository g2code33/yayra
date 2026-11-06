/**
 * FloatBrowse Design System - Theme Manager (JS runtime)
 */

import { DarkThemeTokens, LightThemeTokens, AccentThemeTokens, LightAccentThemeTokens } from './colors.js';
import { Radii, Blur } from './spacing.js';
import { Typography } from './typography.js';

export class ThemeManager {
  constructor(initialMode = 'dark', onModeChange) {
    this.currentMode = initialMode;
    this.currentColorTheme = 'blue';
    this.listeners = new Set();
    if (onModeChange) {
      this.subscribe(onModeChange);
    }
  }

  getMode() {
    return this.currentMode;
  }

  getColorTheme() {
    return this.currentColorTheme;
  }

  setColorTheme(colorTheme, rootElement) {
    if (!Object.prototype.hasOwnProperty.call(AccentThemeTokens, colorTheme)) return this.currentColorTheme;
    this.currentColorTheme = colorTheme;
    if (rootElement || (typeof document !== 'undefined' && document.documentElement)) {
      const root = rootElement || document.documentElement;
      this.applyTokens(root);
    }
    return this.currentColorTheme;
  }

  getEffectiveMode() {
    return this.resolveEffectiveDark() ? 'dark' : 'light';
  }

  setMode(mode, rootElement) {
    this.currentMode = mode;
    if (rootElement || (typeof document !== 'undefined' && document.documentElement)) {
      const root = rootElement || document.documentElement;
      this.applyTokens(root);
    }
    this.listeners.forEach((callback) => callback(mode));
  }

  toggleMode(rootElement) {
    const next = this.currentMode === 'dark' ? 'light' : 'dark';
    this.setMode(next, rootElement);
    return next;
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getCssCustomProperties() {
    const isDark = this.resolveEffectiveDark();
    const tokens = isDark ? DarkThemeTokens : LightThemeTokens;
    const props = {};

    props['--fb-bg-deep'] = tokens.bgDeepNavy;
    props['--fb-bg-surface'] = tokens.bgSurface;
    props['--fb-accent-primary'] = tokens.accentPrimary;
    props['--fb-accent-secondary'] = tokens.accentSecondary;
    props['--fb-glass-fill'] = tokens.glassFill;
    props['--fb-glass-border'] = tokens.glassBorder;
    props['--fb-text-primary'] = tokens.textPrimary;
    props['--fb-text-secondary'] = tokens.textSecondary;
    props['--fb-radius-lg'] = Radii.pxLg;
    props['--fb-blur-md'] = Blur.pxMd;
    props['--fb-font-sans'] = Typography.fontFamily.sans;

    for (const [key, value] of Object.entries(tokens)) {
      props[`--fb-${this.kebabCase(key)}`] = value;
    }
    const accentTokens = isDark ? AccentThemeTokens[this.currentColorTheme] : LightAccentThemeTokens[this.currentColorTheme];
    for (const [key, value] of Object.entries(accentTokens)) {
      props[`--fb-${this.kebabCase(key)}`] = value;
    }

    return props;
  }

  generateCssCustomPropertiesText() {
    const props = this.getCssCustomProperties();
    return Object.entries(props)
      .map(([k, v]) => `${k}: ${v};`)
      .join('\n');
  }

  applyTokens(root = (typeof document !== 'undefined' ? document.documentElement : null)) {
    if (!root) return;
    const isDark = this.resolveEffectiveDark();
    const tokens = isDark ? DarkThemeTokens : LightThemeTokens;

    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    root.setAttribute('data-color-theme', this.currentColorTheme);

    for (const [key, value] of Object.entries(tokens)) {
      const cssVar = `--fb-${this.kebabCase(key)}`;
      root.style.setProperty(cssVar, value);
    }
    const accentTokens = isDark ? AccentThemeTokens[this.currentColorTheme] : LightAccentThemeTokens[this.currentColorTheme];
    for (const [key, value] of Object.entries(accentTokens)) {
      root.style.setProperty(`--fb-${this.kebabCase(key)}`, value);
    }
  }

  resolveEffectiveDark() {
    if (this.currentMode === 'system') {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      return true;
    }
    return this.currentMode === 'dark';
  }

  kebabCase(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }
}
