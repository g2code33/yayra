/**
 * FloatBrowse Design System - Typography System
 */

export const TypographyScale = Object.freeze({
  fontFamilySans: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  fontFamilyMono: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  sizes: {
    display: { size: '2.5rem', lineHeight: '1.15', weight: '800', letterSpacing: '-0.025em' },
    h1: { size: '2.0rem', lineHeight: '1.2', weight: '700', letterSpacing: '-0.02em' },
    h2: { size: '1.5rem', lineHeight: '1.25', weight: '700', letterSpacing: '-0.015em' },
    h3: { size: '1.25rem', lineHeight: '1.3', weight: '600', letterSpacing: '-0.01em' },
    h4: { size: '1.125rem', lineHeight: '1.35', weight: '600', letterSpacing: '0em' },
    bodyLg: { size: '1.0rem', lineHeight: '1.5', weight: '400', letterSpacing: '0em' },
    bodyMd: { size: '0.875rem', lineHeight: '1.5', weight: '400', letterSpacing: '0em' },
    bodySm: { size: '0.75rem', lineHeight: '1.4', weight: '400', letterSpacing: '0.01em' },
    caption: { size: '0.6875rem', lineHeight: '1.3', weight: '600', letterSpacing: '0.04em' }
  }
});

export const Typography = Object.freeze({
  fontFamily: {
    sans: TypographyScale.fontFamilySans,
    mono: TypographyScale.fontFamilyMono
  },
  fontSize: {
    display: '2.5rem',
    h1: '2.0rem',
    h2: '1.5rem',
    h3: '1.25rem',
    h4: '1.125rem',
    body: '0.875rem',
    bodyLg: '1.0rem',
    bodySm: '0.75rem',
    caption: '0.6875rem'
  },
  scale: TypographyScale
});
