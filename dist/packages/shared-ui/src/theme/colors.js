/**
 * FloatBrowse Design System - Color System (JS runtime)
 */

export const ColorPalette = Object.freeze({
  navy: {
    950: '#060b19',
    900: '#0a1026',
    850: '#0d1736',
    800: '#111f48',
    700: '#172554',
    600: '#1e3a8a',
    500: '#3b82f6',
    400: '#60a5fa',
    300: '#93c5fd',
    200: '#bfdbfe',
    100: '#dbeafe',
    50: '#eff6ff'
  },
  cyan: {
    900: '#164e63',
    800: '#155e75',
    700: '#0e7490',
    600: '#0891b2',
    500: '#06b6d4',
    400: '#22d3ee',
    300: '#67e8f9',
    200: '#a5f3fc',
    100: '#cffafe',
    50: '#ecfeff'
  },
  blue: {
    600: '#2563eb',
    500: '#3b82f6',
    400: '#60a5fa',
    300: '#93c5fd'
  },
  slate: {
    900: '#0f172a',
    800: '#1e293b',
    700: '#334155',
    600: '#475569',
    500: '#64748b',
    400: '#94a3b8',
    300: '#cbd5e1',
    200: '#e2e8f0',
    100: '#f1f5f9',
    50: '#f8fafc'
  },
  semantic: {
    success: '#10b981',
    successGlass: 'rgba(16, 185, 129, 0.18)',
    warning: '#f59e0b',
    warningGlass: 'rgba(245, 158, 11, 0.18)',
    danger: '#ef4444',
    dangerGlass: 'rgba(239, 68, 68, 0.18)',
    info: '#38bdf8',
    infoGlass: 'rgba(56, 189, 248, 0.18)'
  }
});

export const DarkThemeTokens = Object.freeze({
  bgApp: ColorPalette.navy[950],
  bgDeepNavy: ColorPalette.navy[950],
  bgSurface: 'rgba(13, 23, 54, 0.72)',
  bgSurfaceNavy: 'rgba(13, 23, 54, 0.72)',
  bgSurfaceElevated: 'rgba(23, 37, 84, 0.75)',
  bgGlassCard: 'rgba(17, 31, 72, 0.65)',
  bgGlassInput: 'rgba(6, 11, 25, 0.55)',
  glassFill: 'rgba(17, 31, 72, 0.65)',
  borderGlass: 'rgba(255, 255, 255, 0.14)',
  glassBorder: 'rgba(255, 255, 255, 0.14)',
  borderGlassHighlight: 'rgba(56, 189, 248, 0.35)',
  textPrimary: ColorPalette.slate[50],
  textSecondary: ColorPalette.slate[400],
  textMuted: ColorPalette.slate[500],
  accentPrimary: ColorPalette.cyan[500],
  accentCyan: ColorPalette.cyan[500],
  accentSecondary: ColorPalette.blue[600],
  accentBlue: ColorPalette.blue[600],
  accentGlow: 'rgba(6, 182, 212, 0.35)',
  shadowSurface: '0 20px 40px -15px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12)',
  statusActive: ColorPalette.semantic.success,
  statusInactive: ColorPalette.slate[500],
  statusWarning: ColorPalette.semantic.warning
});

export const LightThemeTokens = Object.freeze({
  bgApp: '#f0f4f8',
  bgDeepNavy: '#f0f4f8',
  bgSurface: 'rgba(255, 255, 255, 0.75)',
  bgSurfaceNavy: 'rgba(255, 255, 255, 0.75)',
  bgSurfaceElevated: 'rgba(255, 255, 255, 0.90)',
  bgGlassCard: 'rgba(255, 255, 255, 0.70)',
  bgGlassInput: 'rgba(241, 245, 249, 0.80)',
  glassFill: 'rgba(255, 255, 255, 0.70)',
  borderGlass: 'rgba(0, 0, 0, 0.08)',
  glassBorder: 'rgba(0, 0, 0, 0.08)',
  borderGlassHighlight: 'rgba(14, 116, 144, 0.45)',
  textPrimary: ColorPalette.slate[900],
  textSecondary: ColorPalette.slate[600],
  // Keep low-emphasis labels comfortably legible on light surfaces (WCAG AA).
  textMuted: ColorPalette.slate[600],
  accentPrimary: ColorPalette.cyan[700],
  accentCyan: ColorPalette.cyan[700],
  accentSecondary: '#1d4ed8',
  accentBlue: '#1d4ed8',
  accentGlow: 'rgba(14, 116, 144, 0.22)',
  shadowSurface: '0 20px 40px -15px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.06)',
  statusActive: ColorPalette.semantic.success,
  statusInactive: ColorPalette.slate[400],
  statusWarning: ColorPalette.semantic.warning
});

export const AccentThemeTokens = Object.freeze({
  blue: { accentPrimary: '#06b6d4', accentSecondary: '#2563eb', accentGlow: 'rgba(6, 182, 212, 0.35)', borderGlassHighlight: 'rgba(56, 189, 248, 0.35)', gradientAccent: 'linear-gradient(135deg, #67e8f9 0%, #3b82f6 52%, #1d4ed8 100%)' },
  purple: { accentPrimary: '#a78bfa', accentSecondary: '#7c3aed', accentGlow: 'rgba(167, 139, 250, 0.34)', borderGlassHighlight: 'rgba(196, 181, 253, 0.42)', gradientAccent: 'linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 52%, #6d28d9 100%)' },
  green: { accentPrimary: '#34d399', accentSecondary: '#059669', accentGlow: 'rgba(52, 211, 153, 0.32)', borderGlassHighlight: 'rgba(110, 231, 183, 0.42)', gradientAccent: 'linear-gradient(135deg, #6ee7b7 0%, #10b981 52%, #047857 100%)' },
  rose: { accentPrimary: '#fb7185', accentSecondary: '#e11d48', accentGlow: 'rgba(251, 113, 133, 0.32)', borderGlassHighlight: 'rgba(253, 164, 175, 0.42)', gradientAccent: 'linear-gradient(135deg, #fda4af 0%, #f43f5e 52%, #be123c 100%)' },
  amber: { accentPrimary: '#fbbf24', accentSecondary: '#d97706', accentGlow: 'rgba(251, 191, 36, 0.3)', borderGlassHighlight: 'rgba(253, 230, 138, 0.42)', gradientAccent: 'linear-gradient(135deg, #fde68a 0%, #f59e0b 52%, #b45309 100%)' }
});

// Accent values tuned for light surfaces: links and labels need sufficient
// contrast, and primary buttons use white text over a dark enough gradient.
export const LightAccentThemeTokens = Object.freeze({
  blue: { accentPrimary: '#0e7490', accentSecondary: '#1d4ed8', accentGlow: 'rgba(14, 116, 144, 0.22)', borderGlassHighlight: 'rgba(14, 116, 144, 0.45)', gradientAccent: 'linear-gradient(135deg, #0e7490 0%, #1d4ed8 52%, #4338ca 100%)' },
  purple: { accentPrimary: '#6d28d9', accentSecondary: '#5b21b6', accentGlow: 'rgba(109, 40, 217, 0.18)', borderGlassHighlight: 'rgba(109, 40, 217, 0.38)', gradientAccent: 'linear-gradient(135deg, #6d28d9 0%, #5b21b6 52%, #4c1d95 100%)' },
  green: { accentPrimary: '#047857', accentSecondary: '#065f46', accentGlow: 'rgba(4, 120, 87, 0.18)', borderGlassHighlight: 'rgba(4, 120, 87, 0.36)', gradientAccent: 'linear-gradient(135deg, #047857 0%, #065f46 52%, #064e3b 100%)' },
  rose: { accentPrimary: '#be123c', accentSecondary: '#9f1239', accentGlow: 'rgba(190, 18, 60, 0.16)', borderGlassHighlight: 'rgba(190, 18, 60, 0.34)', gradientAccent: 'linear-gradient(135deg, #be123c 0%, #9f1239 52%, #881337 100%)' },
  amber: { accentPrimary: '#92400e', accentSecondary: '#78350f', accentGlow: 'rgba(146, 64, 14, 0.16)', borderGlassHighlight: 'rgba(146, 64, 14, 0.36)', gradientAccent: 'linear-gradient(135deg, #92400e 0%, #78350f 52%, #713f12 100%)' }
});

export const Colors = Object.freeze({
  dark: DarkThemeTokens,
  light: LightThemeTokens,
  palette: ColorPalette
});
