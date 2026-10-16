/**
 * FloatBrowse Design System - Theme Manager
 * Manages Dark, Light, and System theme modes and applies CSS custom properties.
 */

import { DarkThemeTokens, LightThemeTokens, AccentThemeTokens, LightAccentThemeTokens } from './colors.js';
import { Spacing, Radii, Blur } from './spacing.js';
import { Typography } from './typography.js';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ColorTheme = keyof typeof AccentThemeTokens;

export class ThemeManager {
  private currentMode: ThemeMode = 'dark';
  private currentColorTheme: ColorTheme = 'blue';
  private listeners: Set<(mode: ThemeMode) => void> = new Set();

  constructor(initialMode: ThemeMode = 'dark', onModeChange?: (mode: ThemeMode) => void) {
    this.currentMode = initialMode;
    if (onModeChange) {
      this.subscribe(onModeChange);
    }
  }

  public getMode(): ThemeMode {
    return this.currentMode;
  }

  public getColorTheme(): ColorTheme {
    return this.currentColorTheme;
  }

  public setColorTheme(colorTheme: ColorTheme, rootElement?: HTMLElement): ColorTheme {
    if (!Object.prototype.hasOwnProperty.call(AccentThemeTokens, colorTheme)) return this.currentColorTheme;
    this.currentColorTheme = colorTheme;
    if (rootElement || (typeof document !== 'undefined' && document.documentElement)) {
      const root = rootElement || document.documentElement;
      this.applyTokens(root);
    }
    return this.currentColorTheme;
  }

  public getEffectiveMode(): 'dark' | 'light' {
    return this.resolveEffectiveDark() ? 'dark' : 'light';
  }

  public setMode(mode: ThemeMode, rootElement?: HTMLElement): void {
    this.currentMode = mode;
    if (rootElement || (typeof document !== 'undefined' && document.documentElement)) {
      const root = rootElement || document.documentElement;
      this.applyTokens(root);
    }
    this.listeners.forEach((callback) => callback(mode));
  }

  public toggleMode(rootElement?: HTMLElement): ThemeMode {
    const next = this.currentMode === 'dark' ? 'light' : 'dark';
    this.setMode(next, rootElement);
    return next;
  }

  public subscribe(callback: (mode: ThemeMode) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  public getCssCustomProperties(): Record<string, string> {
    const isDark = this.resolveEffectiveDark();
    const tokens = isDark ? DarkThemeTokens : LightThemeTokens;
    const props: Record<string, string> = {};

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

  public generateCssCustomPropertiesText(): string {
    const props = this.getCssCustomProperties();
    return Object.entries(props)
      .map(([k, v]) => `${k}: ${v};`)
      .join('\n');
  }

  public applyTokens(root: HTMLElement = (typeof document !== 'undefined' ? document.documentElement : null as any)): void {
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

  private resolveEffectiveDark(): boolean {
    if (this.currentMode === 'system') {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      return true;
    }
    return this.currentMode === 'dark';
  }

  private kebabCase(str: string): string {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }
}
