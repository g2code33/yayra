/*
 * Adapted from g2code33/pharmaTRACK_PERFECT_new at
 * daf2daf0352e07a0da8f9aeaae5ee7d8f8db7981.
 * Copyright (c) 2026 G2CODE33. Licensed under the MIT License.
 * The generated browser module retains this notice and ships with
 * packages/shared-ui/src/vendor/documents/PHARMATRACK-MIT-LICENSE.
 */
import JSZip from 'jszip';
import { codePoint as dingbatCodePoint } from 'dingbat-to-unicode';

/**
 * Native .pptx renderer — parses the OPC zip directly in the browser.
 *
 * PowerPoint is already an open XML format (DrawingML inside a zip), so no
 * conversion service is needed and the file never leaves the device. This
 * module produces a *visual* model of each slide: slide dimensions, shape
 * geometry (position/size/rotation), fills, per-run font sizing/weight/
 * colour, paragraph alignment, tables, placed images and backgrounds — which
 * is enough to rebuild the slide as positioned DOM and show it as the user
 * would see it in PowerPoint.
 *
 * The legacy flat-text fields (title/body/notes/images/text/fullText) are
 * kept unchanged for compatibility with existing consumers (FileUploader,
 * search indexing).
 *
 * Units: PowerPoint stores geometry in EMU (914400 per inch). We convert to
 * CSS pixels (96 per inch → divide by 9525). Font sizes arrive in 1/100 pt.
 */

const EMU_PER_PX = 9525;
const DEFAULT_SLIDE_CX = 12192000; // 16:9
const DEFAULT_SLIDE_CY = 6858000;

export const emuToPx = (emu: number): number => emu / EMU_PER_PX;
export const ptToPx = (pt: number): number => (pt * 4) / 3;

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

export interface PptxRun {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  font?: string;
}

export type PptxAlign = 'left' | 'center' | 'right' | 'justify';

export interface PptxParagraph {
  runs: PptxRun[];
  /** Outline level (0-based) from a:pPr/@lvl. */
  level: number;
  align?: PptxAlign;
  /** Multiplier, e.g. 1.5 for 150% line spacing. */
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  /** null = no bullet; string = literal glyph (auto-numbering is resolved). */
  bullet?: string | null;
}

/**
 * Text properties inherited through the PowerPoint style chain
 * (shape lstStyle → slide layout placeholder → master txStyles).
 */
export interface PptxLevelDefault {
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: PptxAlign;
  bullet?: string | null;
  /** Font family for the level (theme fonts already resolved). */
  font?: string;
  /** Left margin for the level, in px (marL). */
  indentPx?: number;
}

export interface PptxText {
  paragraphs: PptxParagraph[];
  /** Vertical anchor from bodyPr. */
  anchor?: 't' | 'ctr' | 'b';
  /** normAutofit fontScale (≤ 1) — PowerPoint shrinks text to fit. */
  fontScale: number;
  /** Font size assumed when a run carries no explicit sz. */
  defaultSizePt: number;
  /** Per-level inherited defaults (index 0 = level 1). */
  levels: PptxLevelDefault[];
}

export interface PptxTableCell {
  text: string;
  sizePt?: number;
  bold?: boolean;
  color?: string;
  fill?: string;
  /** a:tc gridSpan — columns this (anchor) cell covers. */
  gridSpan?: number;
  /** a:tc rowSpan — rows this (anchor) cell covers. */
  rowSpan?: number;
  /** a:tc hMerge/vMerge — covered cell, emitted by PowerPoint after a span. */
  merged?: 'h' | 'v';
  /** Optional cell borders (a:lnL/lnR/lnT/lnB), CSS colours. */
  borders?: { l?: string; r?: string; t?: string; b?: string };
}

export interface PptxTable {
  colWidths: number[]; // px
  rowHeights: number[]; // px
  cells: PptxTableCell[][];
}

export type PptxShapeType = 'text' | 'image' | 'table' | 'chart' | 'line';

export interface PptxShape {
  id: number;
  type: PptxShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number; // degrees
  /** prstGeom name (rect, roundRect, ellipse, …). */
  geom?: string;
  /** CSS colour or gradient. */
  fill?: string;
  borderColor?: string;
  borderWidth?: number; // px
  text?: PptxText;
  imageUrl?: string;
  /** Relationship id of an embedded image. Filled even when the bytes are not loaded yet. */
  imageRid?: string;
  /** a:srcRect cropping of the source image, as 0..1 fractions of each edge. */
  crop?: { l: number; t: number; r: number; b: number };
  table?: PptxTable;
  /** Font scale inherited from an enclosing group. */
  textScale: number;
  /** True for placeholders (used for default font sizing). */
  isTitle: boolean;
}

export interface PptxSlide {
  slideNumber: number;
  title: string;
  body: string[];
  /** Object URLs in document order (back-compat; also referenced by shapes). */
  images: string[];
  notes: string;
  text: string;
  /** CSS colour or gradient for the slide background. */
  background?: string;
  /** Full-bleed background picture (p:bg > p:bgPr > a:blipFill), if any. */
  backgroundImageUrl?: string;
  shapes: PptxShape[];
}

export interface PptxDocument {
  slides: PptxSlide[];
  /** CSS pixels. */
  slideWidth: number;
  slideHeight: number;
  fullText: string;
  fileSize: number; // bytes
  dates?: { created?: string; modified?: string };
  /**
   * Loads images for one slide. No-op when media was already decoded during
   * parse. Safe to call more than once. Large decks pass `{ lazyMedia: true }`
   * so opening the file does not decode every picture.
   */
  ensureSlideMedia: (slideNumber: number) => Promise<void>;
  dispose: () => void;
}

/* ------------------------------------------------------------------ */
/* Small XML helpers (namespaced names arrive with their prefix)      */
/* ------------------------------------------------------------------ */

const child = (el: Element | null, tag: string): Element | null => {
  if (!el) return null;
  const t = tag.toLowerCase();
  for (const c of Array.from(el.children)) {
    if (c.tagName.toLowerCase() === t) return c;
  }
  return null;
};

const children = (el: Element, tag: string): Element[] => {
  const t = tag.toLowerCase();
  return Array.from(el.children).filter((c) => c.tagName.toLowerCase() === t);
};

/** Fallback palette (Office 2013+ theme) for files with no readable theme. */
const FALLBACK_SCHEME_COLORS: Record<string, string> = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#44546A',
  lt2: '#E7E6E6',
  tx1: '#000000',
  bg1: '#FFFFFF',
  tx2: '#44546A',
  bg2: '#E7E6E6',
  accent1: '#4472C4',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#5B9BD5',
  accent6: '#70AD47',
  hlink: '#0563C1',
  folHlink: '#954F72',
};

const FALLBACK_FONTS = { major: 'Calibri', minor: 'Calibri' };

/** Per-deck theme: the file's own colour scheme (as remapped by p:clrMap) + fonts. */
interface ThemeInfo {
  colors: Record<string, string>;
  major: string;
  minor: string;
}

/**
 * The theme of the slide being parsed. Files resolve scheme colours/fonts
 * through their theme, so the parser needs it while walking shapes; parsing
 * is synchronous once a slide's parts are loaded, so a single slot is safe.
 */
let activeTheme: ThemeInfo | null = null;

/** Reads the theme part a slide master points at: clrScheme + fontScheme. */
async function loadTheme(zip: JSZip, masterRels: Map<string, Rel>): Promise<ThemeInfo | null> {
  const themeRel = Array.from(masterRels.values()).find((r) => /theme\d*\.xml$/i.test(r.target));
  const candidates = [
    ...(themeRel ? [resolveZipPath('ppt/slideMasters', themeRel.target)] : []),
    ...Object.keys(zip.files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n)).sort(),
  ];
  for (const path of candidates) {
    const file = zip.file(path);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const scheme = doc.getElementsByTagName('a:clrScheme')[0];
    const colors: Record<string, string> = {};
    if (scheme) {
      for (const el of Array.from(scheme.children)) {
        const name = el.tagName.replace(/^a:/, '');
        const css = colorChoiceCss(el);
        if (css) colors[name] = css;
      }
    }
    const fontScheme = doc.getElementsByTagName('a:fontScheme')[0];
    const faceOf = (part: Element | null | undefined) =>
      part ? child(part, 'a:latin')?.getAttribute('typeface') || undefined : undefined;
    const major = fontScheme ? faceOf(child(fontScheme, 'a:majorFont')) : undefined;
    const minor = fontScheme ? faceOf(child(fontScheme, 'a:minorFont')) : undefined;
    if (!Object.keys(colors).length && !major && !minor) continue;
    return {
      colors,
      major: major || FALLBACK_FONTS.major,
      minor: minor || FALLBACK_FONTS.minor,
    };
  }
  return null;
}

/** Applies the master's p:clrMap (tx1→dk1, bg1→lt1, …) to the theme palette. */
function applyColorMap(theme: ThemeInfo, masterDoc: Document | null): void {
  const map = masterDoc ? masterDoc.getElementsByTagName('p:clrMap')[0] : null;
  if (!map) return;
  const merged: Record<string, string> = {};
  for (const attr of Array.from(map.attributes)) {
    const value = theme.colors[attr.value] ?? FALLBACK_SCHEME_COLORS[attr.value];
    if (value) merged[attr.name] = value;
  }
  theme.colors = { ...theme.colors, ...merged };
}

/** CSS colour for an a:schemeClr value, via the active file's theme. */
function schemeColor(key: string): string {
  return (
    activeTheme?.colors[key] ??
    FALLBACK_SCHEME_COLORS[key] ??
    activeTheme?.colors.tx1 ??
    '#000000'
  );
}

/** Resolves theme font references (+mj-lt / +mn-lt / +mn-ea …) to a real face. */
function resolveFont(face: string | undefined | null): string | undefined {
  if (!face) return undefined;
  if (face.startsWith('+mj-')) return activeTheme?.major ?? FALLBACK_FONTS.major;
  if (face.startsWith('+mn-')) return activeTheme?.minor ?? FALLBACK_FONTS.minor;
  return face;
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const clampUnit = (v: number): number => Math.max(0, Math.min(1, v));

function parseOoxmlPercent(raw: string | null | undefined, fallback = 100000): number {
  if (!raw) return fallback / 100000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n / 100000 : fallback / 100000;
}

function parseHexColor(value: string | undefined | null): RgbaColor | null {
  if (!value) return null;
  const hex = value.replace(/^#/, '').trim();
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const int = parseInt(hex, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
}

function rgbaToCss(color: RgbaColor): string {
  const r = clampByte(color.r);
  const g = clampByte(color.g);
  const b = clampByte(color.b);
  const a = clampUnit(color.a);
  if (a < 0.999) return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const PRESET_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  dkBlue: '#00008b',
  dkCyan: '#008b8b',
  dkGray: '#a9a9a9',
  dkGreen: '#006400',
  dkMagenta: '#8b008b',
  dkRed: '#8b0000',
  dkYellow: '#808000',
  gray: '#808080',
  green: '#008000',
  ltGray: '#d3d3d3',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

function colorChoice(holder: Element | null): Element | null {
  if (!holder) return null;
  return child(holder, 'a:srgbClr')
    ?? child(holder, 'a:scrgbClr')
    ?? child(holder, 'a:hslClr')
    ?? child(holder, 'a:sysClr')
    ?? child(holder, 'a:schemeClr')
    ?? child(holder, 'a:prstClr');
}

function hslToRgb(h: number, s: number, l: number): RgbaColor {
  const hueToRgb = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s <= 0) {
    const gray = l * 255;
    return { r: gray, g: gray, b: gray, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255,
    a: 1,
  };
}

function baseColorForChoice(colorEl: Element): RgbaColor | null {
  const tag = colorEl.tagName.toLowerCase();
  if (tag === 'a:srgbclr') return parseHexColor(colorEl.getAttribute('val'));
  if (tag === 'a:scrgbclr') {
    return {
      r: parseOoxmlPercent(colorEl.getAttribute('r'), 0) * 255,
      g: parseOoxmlPercent(colorEl.getAttribute('g'), 0) * 255,
      b: parseOoxmlPercent(colorEl.getAttribute('b'), 0) * 255,
      a: 1,
    };
  }
  if (tag === 'a:hslclr') {
    const hue = (parseInt(colorEl.getAttribute('hue') || '0', 10) / 60000) / 360;
    return hslToRgb(hue, parseOoxmlPercent(colorEl.getAttribute('sat'), 0), parseOoxmlPercent(colorEl.getAttribute('lum'), 0));
  }
  if (tag === 'a:sysclr') {
    const last = parseHexColor(colorEl.getAttribute('lastClr'));
    if (last) return last;
    return colorEl.getAttribute('val') === 'window'
      ? { r: 255, g: 255, b: 255, a: 1 }
      : { r: 0, g: 0, b: 0, a: 1 };
  }
  if (tag === 'a:schemeclr') return parseHexColor(schemeColor(colorEl.getAttribute('val') || ''));
  if (tag === 'a:prstclr') return parseHexColor(PRESET_COLORS[colorEl.getAttribute('val') || '']);
  return null;
}

function applyColorTransforms(colorEl: Element, base: RgbaColor): RgbaColor {
  let out = { ...base };
  for (const t of Array.from(colorEl.children)) {
    const tag = t.tagName.toLowerCase();
    const v = parseOoxmlPercent(t.getAttribute('val'));
    if (tag === 'a:tint') {
      out = { ...out, r: out.r + (255 - out.r) * v, g: out.g + (255 - out.g) * v, b: out.b + (255 - out.b) * v };
    } else if (tag === 'a:shade') {
      out = { ...out, r: out.r * v, g: out.g * v, b: out.b * v };
    } else if (tag === 'a:lummod') {
      out = { ...out, r: out.r * v, g: out.g * v, b: out.b * v };
    } else if (tag === 'a:lumoff') {
      out = { ...out, r: out.r + 255 * v, g: out.g + 255 * v, b: out.b + 255 * v };
    } else if (tag === 'a:alpha') {
      out = { ...out, a: v };
    } else if (tag === 'a:alphamod') {
      out = { ...out, a: out.a * v };
    } else if (tag === 'a:alphaoff') {
      out = { ...out, a: out.a + v };
    }
  }
  return { r: clampByte(out.r), g: clampByte(out.g), b: clampByte(out.b), a: clampUnit(out.a) };
}

function colorChoiceCss(holder: Element | null): string | undefined {
  const colorEl = colorChoice(holder);
  if (!colorEl) return undefined;
  const base = baseColorForChoice(colorEl);
  if (!base) return undefined;
  return rgbaToCss(applyColorTransforms(colorEl, base));
}

function solidColor(fillEl: Element | null): string | undefined {
  if (!fillEl || child(fillEl, 'a:noFill')) return undefined;
  return colorChoiceCss(fillEl);
}

/** CSS background for an a:solidFill / a:gradFill element (or its parent holder). */
function fillCss(holder: Element | null): string | undefined {
  if (!holder) return undefined;
  const solid = child(holder, 'a:solidFill');
  const flat = solidColor(solid);
  if (flat) return flat;
  const grad = child(holder, 'a:gradFill');
  if (grad) {
    // Keep all gradient stops and stop positions. Many lecturer templates use
    // tinted theme colours in gradients; preserving the whole CSS gradient is
    // far closer than flattening it to one colour during PDF conversion.
    const lin = child(grad, 'a:lin');
    const rawAngle = lin?.getAttribute('ang');
    const angle = rawAngle ? `${Math.round((parseInt(rawAngle, 10) / 60000) * 10) / 10}deg` : '135deg';
    const stops = Array.from(grad.getElementsByTagName('a:gs'))
      .map((gs) => {
        const c = solidColor(gs);
        if (!c) return null;
        const pos = gs.getAttribute('pos');
        return pos ? `${c} ${Math.max(0, Math.min(100, parseInt(pos, 10) / 1000))}%` : c;
      })
      .filter((c): c is string => Boolean(c));
    if (stops.length >= 2) return `linear-gradient(${angle}, ${stops.join(', ')})`;
    if (stops.length === 1) return stops[0];
  }
  return undefined;
}

function parseSpacingPt(pPr: Element, tag: string): number | undefined {
  const el = child(pPr, tag);
  if (!el) return undefined;
  const pts = child(el, 'a:spcPts');
  const v = pts?.getAttribute('val');
  if (v) return parseInt(v, 10) / 100;
  return undefined;
}

/**
 * a:buChar carries its glyph in char="\u2022" (val= is not used by PowerPoint).
 *
 * The glyph is translated through the a:buFont's real glyph table via the
 * dingbat-to-unicode mapping (which follows the Unicode consortium's official
 * Symbol/Wingdings/Webdings charts), so a bullet shows exactly the glyph
 * PowerPoint itself draws at that position. A bullet authored as "\u00A7"
 * with buFont Wingdings is the small filled square, never a section sign.
 */

/**
 * Canonical typeface names for the symbol fonts whose full glyph tables we
 * carry. Lower-cased typeface -> the name dingbat-to-unicode expects.
 */
const SYMBOL_FONT_TYPEFACES: Record<string, string> = {
  symbol: 'Symbol',
  wingdings: 'Wingdings',
  'wingdings 2': 'Wingdings 2',
  'wingdings 3': 'Wingdings 3',
  webdings: 'Webdings',
};

/**
 * Fonts whose glyph tables are symbol/picture encodings rather than text
 * alphabets. PowerPoint uses them for BULLET characters (via a:buFont and the
 * master's level defaults) and NEVER applies them to text runs \u2014 but the
 * level default carries the font in its defRPr, so a naive inheritance
 * renders the first run of every paragraph through the symbol table (the
 * "S\u@@AOabsorption" garbling on real lecture decks: 'I' draws as \u222B, 'n' as
 * \u2191, 'v' as \u2228, 'o' as \u2299 \u2026). Exported for tests.
 */
const SYMBOL_BULLET_FONTS =
  /^(wingdings( [23])?|webdings|symbol|monotype sorts|mt extra|zapfdingbats|dingbats|marlett|bookshelf symbol|ms reference specialty|ms outlook)/i;

export function isSymbolBulletFont(face?: string | null): boolean {
  return Boolean(face) && SYMBOL_BULLET_FONTS.test(face!.trim());
}

/**
 * Translates one character through a symbol font's real glyph table \u2014 the
 * exact glyph PowerPoint draws at that code point. A Wingdings bullet
 * authored as "\u00A7" is the small filled square "\u25AA", Symbol "\u00B7" is
 * "\u2022", and so on for every position in the font. Returns undefined when
 * `font` is not a known symbol font or the position is unmapped, so callers
 * keep the original character. Exported for tests.
 */
export function mapSymbolFontChar(ch: string, font?: string | null): string | undefined {
  if (!ch) return undefined;
  const typeface = SYMBOL_FONT_TYPEFACES[(font ?? '').trim().toLowerCase()];
  if (!typeface) return undefined;
  let code = ch.codePointAt(0) ?? 0;
  // Symbol-font characters are often shifted into the private use area
  // (U+F000 + font position) \u2014 the docx convention; shift back first.
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000;
  if (code < 0x20 || code > 0xff) return undefined;
  return dingbatCodePoint(typeface, code)?.string;
}

/**
 * Normalises one bullet glyph for display. `font` is the a:buFont typeface
 * ("Wingdings", "Symbol", ...). PowerPoint's rule: the bullet character is
 * the buFont's glyph at the buChar's code point, whatever that character
 * looks like in a normal font. When the font is unknown we only rescue
 * private-use characters (unshowable in any real font) and leave everything
 * else untouched. Exported for tests.
 */
export function normalizeBulletGlyph(glyph: string, font?: string | null): string {
  if (!glyph) return '\u2022';
  const code = glyph.codePointAt(0) ?? 0;
  // A symbol bullet font maps EVERY code point through its own glyph table.
  const mapped = mapSymbolFontChar(glyph, font);
  if (mapped) return mapped;
  // Private use area (Wingdings/Symbol shift their charset into
  // U+F000\u2013U+F0FF): never show these raw \u2014 no real font draws them.
  // Without a known buFont, Wingdings is the overwhelmingly common authoring
  // font, so its table is the rescue path.
  if (code >= 0xf000 && code <= 0xf0ff) {
    const shifted = code - 0xf000;
    return dingbatCodePoint('Wingdings', shifted)?.string ?? '\u2022';
  }
  if (code < 0x20 || code === 0x7f) return '\u2022';
  return glyph;
}

function bulletChar(el: Element): string {
  const raw = el.getAttribute('char') || el.getAttribute('val') || '\u2022';
  // a:buFont (the bullet's font) sits alongside a:buChar inside a:pPr; when
  // the glyph comes from Wingdings/Symbol it must be translated.
  const buFont = el.parentElement ? child(el.parentElement, 'a:buFont')?.getAttribute('typeface') : null;
  return normalizeBulletGlyph(raw, buFont);
}

function autoNumGlyph(type: string, n: number): string {
  switch (type) {
    case 'arabicPeriod':
      return `${n}.`;
    case 'alphaPeriod':
    case 'lowerLetter':
      return `${String.fromCharCode(96 + Math.min(n, 26))}.`;
    case 'upperLetter':
      return `${String.fromCharCode(64 + Math.min(n, 26))}.`;
    default:
      return '•';
  }
}

function parseRunProps(rPr: Element | null, out: PptxRun): void {
  if (!rPr) return;
  const sz = rPr.getAttribute('sz');
  if (sz) {
    const pt = parseInt(sz, 10) / 100;
    if (pt > 0) out.sizePt = pt;
  }
  const b = rPr.getAttribute('b');
  if (b === '1') out.bold = true;
  else if (b === '0') out.bold = false;
  if (rPr.getAttribute('i') === '1') out.italic = true;
  const u = rPr.getAttribute('u');
  if (u && u !== 'none') out.underline = true;
  out.color = solidColor(child(rPr, 'a:solidFill'));
  const face = resolveFont(child(rPr, 'a:latin')?.getAttribute('typeface'));
  if (face) out.font = face;
}

const ALIGN_MAP: Record<string, PptxAlign> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  rt: 'right',
  just: 'justify',
};

/** Reads the inheritable properties of one a:lvlNpPr (or a:pPr) element. */
function parseLevelDefault(pPr: Element): PptxLevelDefault {
  const d: PptxLevelDefault = {};
  const algn = pPr.getAttribute('algn');
  if (algn && ALIGN_MAP[algn]) d.align = ALIGN_MAP[algn];
  const marL = pPr.getAttribute('marL');
  if (marL) {
    const px = emuToPx(Math.abs(parseInt(marL, 10)));
    if (px > 0) d.indentPx = px;
  }
  if (child(pPr, 'a:buNone')) d.bullet = null;
  else if (child(pPr, 'a:buChar')) d.bullet = bulletChar(child(pPr, 'a:buChar')!);
  else if (child(pPr, 'a:buAutoNum')) d.bullet = '•';

  const defRPr = child(pPr, 'a:defRPr');
  if (defRPr) {
    const sz = defRPr.getAttribute('sz');
    if (sz) {
      const pt = parseInt(sz, 10) / 100;
      if (pt > 0) d.sizePt = pt;
    }
    if (defRPr.getAttribute('b') === '1') d.bold = true;
    if (defRPr.getAttribute('i') === '1') d.italic = true;
    const color = solidColor(child(defRPr, 'a:solidFill'));
    if (color) d.color = color;
    const face = resolveFont(child(defRPr, 'a:latin')?.getAttribute('typeface'));
    if (face) d.font = face;
  }
  return d;
}

/**
 * Collects lvl1..lvl9 defaults from an a:lstStyle (placeholder/shape) or a
 * txStyles style element (master), which hold a:lvlNpPr as direct children.
 */
function parseLevels(container: Element | null): PptxLevelDefault[] {
  const out: PptxLevelDefault[] = [];
  if (!container) return out;
  for (let i = 1; i <= 9; i++) {
    const pPr = child(container, `a:lvl${i}pPr`);
    if (pPr) out[i - 1] = parseLevelDefault(pPr);
  }
  return out;
}

/** Earlier arrays win; later ones only fill gaps. */
function mergeLevels(...chains: (PptxLevelDefault[] | undefined)[]): PptxLevelDefault[] {
  const out: PptxLevelDefault[] = [];
  for (const chain of chains) {
    if (!chain) continue;
    for (let i = 0; i < chain.length; i++) {
      const src = chain[i];
      if (!src) continue;
      const dst = (out[i] ??= {});
      if (dst.sizePt === undefined && src.sizePt !== undefined) dst.sizePt = src.sizePt;
      if (dst.bold === undefined && src.bold !== undefined) dst.bold = src.bold;
      if (dst.italic === undefined && src.italic !== undefined) dst.italic = src.italic;
      if (dst.color === undefined && src.color !== undefined) dst.color = src.color;
      if (dst.align === undefined && src.align !== undefined) dst.align = src.align;
      if (dst.bullet === undefined && src.bullet !== undefined) dst.bullet = src.bullet;
      if (dst.indentPx === undefined && src.indentPx !== undefined) dst.indentPx = src.indentPx;
      if (dst.font === undefined && src.font !== undefined) dst.font = src.font;
    }
  }
  return out;
}

function parseParagraph(p: Element, counter: { n: number }): PptxParagraph {
  const para: PptxParagraph = { runs: [], level: 0 };
  const pPr = child(p, 'a:pPr');
  if (pPr) {
    const lvl = parseInt(pPr.getAttribute('lvl') || '0', 10);
    if (Number.isFinite(lvl) && lvl > 0) para.level = Math.min(lvl, 8);
    const algn = pPr.getAttribute('algn');
    if (algn === 'ctr') para.align = 'center';
    else if (algn === 'r' || algn === 'rtl') para.align = 'right';
    else if (algn === 'just') para.align = 'justify';
    else if (algn === 'l') para.align = 'left';

    const lnSpc = child(pPr, 'a:lnSpc');
    const pct = lnSpc ? child(lnSpc, 'a:spcPct') : null;
    const pctVal = pct?.getAttribute('val');
    if (pctVal) {
      const ls = parseInt(pctVal, 10) / 100000;
      if (ls > 0) para.lineSpacing = ls;
    }
    const before = parseSpacingPt(pPr, 'a:spcBef');
    if (before !== undefined) para.spaceBeforePt = before;
    const after = parseSpacingPt(pPr, 'a:spcAft');
    if (after !== undefined) para.spaceAfterPt = after;

    if (child(pPr, 'a:buNone')) para.bullet = null;
    else if (child(pPr, 'a:buChar')) para.bullet = bulletChar(child(pPr, 'a:buChar')!);
    else if (child(pPr, 'a:buAutoNum')) {
      counter.n += 1;
      para.bullet = autoNumGlyph(child(pPr, 'a:buAutoNum')!.getAttribute('type') || 'arabicPeriod', counter.n);
    }
  }

  for (const c of Array.from(p.children)) {
    const tag = c.tagName.toLowerCase();
    if (tag === 'a:r' || tag === 'a:fld') {
      const t = child(c, 'a:t')?.textContent ?? '';
      if (t) {
        const run: PptxRun = { text: t };
        parseRunProps(child(c, 'a:rPr'), run);
        para.runs.push(run);
      }
    } else if (tag === 'a:br') {
      para.runs.push({ text: '\n' });
    }
  }
  return para;
}

function parseText(
  txBody: Element | null,
  defaultSizePt: number,
  inherited: PptxLevelDefault[] = [],
): PptxText | undefined {
  if (!txBody) return undefined;
  const bodyPr = child(txBody, 'a:bodyPr');
  const anchor = bodyPr?.getAttribute('anchor') as PptxText['anchor'] | undefined;
  let fontScale = 1;
  const norm = bodyPr ? child(bodyPr, 'a:normAutofit') : null;
  const fs = norm?.getAttribute('fontScale');
  if (fs) {
    const v = parseInt(fs, 10);
    if (v > 0) fontScale = Math.min(1, v / 100000);
  }
  const counter = { n: 0 };
  const paragraphs = children(txBody, 'a:p').map((p) => parseParagraph(p, counter));
  if (!paragraphs.length) return undefined;
  // The shape's own lstStyle is most specific, then the layout placeholder,
  // then the master's txStyles.
  const levels = mergeLevels(parseLevels(child(txBody, 'a:lstStyle')), inherited);
  return { paragraphs, anchor, fontScale, defaultSizePt, levels };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

function parseXfrm(container: Element | null): Box {
  const xfrm = child(container, 'a:xfrm') ?? child(container, 'p:xfrm');
  const off = xfrm ? child(xfrm, 'a:off') : null;
  const ext = xfrm ? child(xfrm, 'a:ext') : null;
  const num = (el: Element | null, attr: string) => {
    const v = el?.getAttribute(attr);
    return v ? emuToPx(parseInt(v, 10)) : 0;
  };
  const rotRaw = xfrm?.getAttribute('rot');
  return {
    x: num(off, 'x'),
    y: num(off, 'y'),
    w: num(ext, 'cx'),
    h: num(ext, 'cy'),
    rot: rotRaw ? Math.round((parseInt(rotRaw, 10) / 60000) * 10) / 10 : 0,
  };
}

/** 2-D affine transform accumulating group nesting. */
interface T {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

const IDENTITY: T = { sx: 1, sy: 1, dx: 0, dy: 0 };

function applyT(t: T, b: Box): Box {
  return {
    x: t.dx + b.x * t.sx,
    y: t.dy + b.y * t.sy,
    w: b.w * t.sx,
    h: b.h * t.sy,
    rot: b.rot,
  };
}

/**
 * Compose the group's child→parent mapping into the running transform.
 * A child at child-space coordinate l lands at
 *   parent = gOff + (l − chOff) × (gExt / chExt),
 * and the running transform t then maps parent → final: t.dx + p·t.sx.
 */
function composeGroup(t: T, gOff: Box, gExt: Box, chOff: Box, chExt: Box): T {
  const gsx = chExt.w > 0 ? gExt.w / chExt.w : 1;
  const gsy = chExt.h > 0 ? gExt.h / chExt.h : 1;
  return {
    sx: t.sx * gsx,
    sy: t.sy * gsy,
    dx: t.dx + t.sx * (gOff.x - chOff.x * gsx),
    dy: t.dy + t.sy * (gOff.y - chOff.y * gsy),
  };
}

function resolveZipPath(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\//, '');
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ */
/* Package-level helpers                                              */
/* ------------------------------------------------------------------ */

interface Rel {
  type: string;
  target: string;
}

async function loadRelsFor(zip: JSZip, partPath: string): Promise<Map<string, Rel>> {
  const idx = partPath.lastIndexOf('/');
  const dir = partPath.slice(0, idx);
  const name = partPath.slice(idx + 1);
  const relsFile = zip.file(`${dir}/_rels/${name}.rels`);
  const out = new Map<string, Rel>();
  if (!relsFile) return out;
  const xml = await relsFile.async('text');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    if (id) {
      out.set(id, {
        type: rel.getAttribute('Type') || '',
        target: rel.getAttribute('Target') || '',
      });
    }
  }
  return out;
}

async function parsePresentationSize(zip: JSZip): Promise<{ w: number; h: number }> {
  const file = zip.file('ppt/presentation.xml');
  if (file) {
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const sldSz = doc.getElementsByTagName('p:sldSz')[0];
    const cx = parseInt(sldSz?.getAttribute('cx') || '', 10);
    const cy = parseInt(sldSz?.getAttribute('cy') || '', 10);
    if (cx > 0 && cy > 0) return { w: emuToPx(cx), h: emuToPx(cy) };
  }
  return { w: emuToPx(DEFAULT_SLIDE_CX), h: emuToPx(DEFAULT_SLIDE_CY) };
}

async function parseDates(zip: JSZip): Promise<{ created?: string; modified?: string } | undefined> {
  const file = zip.file('docProps/core.xml');
  if (!file) return undefined;
  const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
  const created = doc.getElementsByTagName('dcterms:created')[0]?.textContent?.trim() || undefined;
  const modified = doc.getElementsByTagName('dcterms:modified')[0]?.textContent?.trim() || undefined;
  return created || modified ? { created, modified } : undefined;
}

/**
 * Slide order follows p:sldIdLst in presentation.xml (decks can reorder
 * slides without renaming files); falls back to numeric filename order.
 */
async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const file = zip.file('ppt/presentation.xml');
  if (file) {
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const sldIdLst = child(doc.documentElement, 'p:sldIdLst');
    if (sldIdLst) {
      const presRels = await loadRelsFor(zip, 'ppt/presentation.xml');
      const ordered: string[] = [];
      for (const sldId of children(sldIdLst, 'p:sldId')) {
        const rid = sldId.getAttribute('r:id');
        const rel = rid ? presRels.get(rid) : undefined;
        if (rel) {
          const path = resolveZipPath('ppt', rel.target);
          if (zip.file(path)) ordered.push(path);
        }
      }
      if (ordered.length) return ordered;
    }
  }
  const all = Object.keys(zip.files).filter((n) => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'));
  all.sort((a, b) => {
    const an = parseInt(a.match(/(\d+)\.xml$/)?.[1] || '0', 10);
    const bn = parseInt(b.match(/(\d+)\.xml$/)?.[1] || '0', 10);
    return an - bn;
  });
  return all;
}

/* ------------------------------------------------------------------ */
/* Slide-level parsing                                                */
/* ------------------------------------------------------------------ */

interface LayoutGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a slide placeholder inherits from its layout counterpart. */
interface PlaceholderInfo {
  geom?: LayoutGeom;
  anchor?: 't' | 'ctr' | 'b';
  levels: PptxLevelDefault[];
}

interface LayoutInfo {
  /** Keyed by "type#idx" (OOXML placeholder matching), then by "type". */
  placeholders: Map<string, PlaceholderInfo>;
  /** Master <p:txStyles> levels, so real decks keep their 44pt titles etc. */
  masterStyles: { title: PptxLevelDefault[]; body: PptxLevelDefault[]; other: PptxLevelDefault[] };
  background?: string;
  /** Background picture inherited from the layout or the master. */
  backgroundImageUrl?: string;
  /** Zip path of that picture, when decoding was deferred. */
  backgroundImagePath?: string;
  /** The master's theme (colours/fonts) — applied while parsing the slide. */
  theme?: ThemeInfo;
}

const TITLE_PH = new Set(['title', 'ctrTitle']);

/** Styles a placeholder type picks up from the master's txStyles. */
function masterLevelsFor(master: LayoutInfo['masterStyles'], phType: string): PptxLevelDefault[] {
  if (TITLE_PH.has(phType)) return master.title;
  if (phType === 'body' || phType === 'subTitle') return master.body;
  return master.other;
}

/** Resolves a background element: p:bgPr fills, or a p:bgRef theme colour. */
function backgroundCss(bg: Element | null): string | undefined {
  if (!bg) return undefined;
  const bgPr = child(bg, 'p:bgPr');
  if (bgPr) {
    const css = fillCss(bgPr);
    if (css) return css;
  }
  // bgRef points at a theme fill; the referenced colour is usually declared
  // inline (bg1/tx1/accentN), which is enough to match the slide's look.
  const bgRef = child(bg, 'p:bgRef');
  if (bgRef) {
    const direct = solidColor(bgRef);
    if (direct) return direct;
  }
  return undefined;
}

/**
 * Background pictures: p:bg > p:bgPr > a:blipFill with an embedded image.
 * Resolves the referenced media to an object URL and hands it to the caller's
 * revoke list.
 */
/** Zip path of a background picture, without decoding the image. */
function embeddedPicturePath(
  bg: Element | null | undefined,
  partDir: string,
  rels: Map<string, Rel>,
): string | undefined {
  const blip = bg ? child(child(bg, 'p:bgPr'), 'a:blipFill') : null;
  const rid = blip ? child(blip, 'a:blip')?.getAttribute('r:embed') : null;
  if (!rid) return undefined;
  const rel = rels.get(rid);
  if (!rel) return undefined;
  return resolveZipPath(partDir, rel.target);
}

async function backgroundPicture(
  zip: JSZip,
  bg: Element | null | undefined,
  partDir: string,
  rels: Map<string, Rel>,
  onUrl: (url: string) => void,
): Promise<string | undefined> {
  const blip = bg ? child(child(bg, 'p:bgPr'), 'a:blipFill') : null;
  const rid = blip ? child(blip, 'a:blip')?.getAttribute('r:embed') : null;
  if (!rid) return undefined;
  const rel = rels.get(rid);
  if (!rel) return undefined;
  const media = zip.file(resolveZipPath(partDir, rel.target));
  if (!media) return undefined;
  try {
    const url = URL.createObjectURL(await media.async('blob'));
    onUrl(url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Placeholders inherit position, size, anchor and text styles from their slide
 * layout, and text styles again from the master's txStyles. Decks authored in
 * PowerPoint rely on this chain for nearly everything visible.
 */
async function loadLayoutInfo(
  zip: JSZip,
  slideRels: Map<string, Rel>,
  onUrl: (url: string) => void,
  deferPictures = false,
): Promise<LayoutInfo | null> {
  const layoutRel = Array.from(slideRels.values()).find((r) => r.type.endsWith('/slideLayout'));
  if (!layoutRel) return null;
  const layoutPath = resolveZipPath('ppt/slides', layoutRel.target);
  const layoutFile = zip.file(layoutPath);
  if (!layoutFile) return null;
  const layoutDoc = new DOMParser().parseFromString(await layoutFile.async('text'), 'text/xml');
  const layoutRels = await loadRelsFor(zip, layoutPath);
  let deckTheme: ThemeInfo | undefined;

  // --- master: txStyles + background ---
  let masterStyles: LayoutInfo['masterStyles'] = { title: [], body: [], other: [] };
  let masterBg: Element | null = null;
  let masterRels = new Map<string, Rel>();
  const masterRel = Array.from(layoutRels.values()).find((r) =>
    r.type.endsWith('/slideMaster'),
  );
  if (masterRel) {
    const masterPath = resolveZipPath('ppt/slideLayouts', masterRel.target);
    const masterFile = zip.file(masterPath);
    if (masterFile) {
      masterRels = await loadRelsFor(zip, masterPath);
      const masterDoc = new DOMParser().parseFromString(await masterFile.async('text'), 'text/xml');
      // Theme first: scheme colours and +mj-lt/+mn-lt font faces are resolved
      // while parsing shapes and backgrounds below.
      const theme = await loadTheme(zip, masterRels);
      if (theme) {
        applyColorMap(theme, masterDoc);
        // Used below for bgRef colours; renderPptx re-applies it right before
        // parsing this slide's shapes so concurrent parses cannot interleave.
        activeTheme = theme;
        deckTheme = theme;
      }
      const txStyles = masterDoc.getElementsByTagName('p:txStyles')[0];
      if (txStyles) {
        masterStyles = {
          title: parseLevels(child(txStyles, 'p:titleStyle')),
          body: parseLevels(child(txStyles, 'p:bodyStyle')),
          other: parseLevels(child(txStyles, 'p:otherStyle')),
        };
      }
      const mCsl = masterDoc.getElementsByTagName('p:cSld')[0];
      masterBg = mCsl ? child(mCsl, 'p:bg') : null;
    }
  }

  // --- layout placeholders ---
  const placeholders = new Map<string, PlaceholderInfo>();
  const spTree = layoutDoc.getElementsByTagName('p:spTree')[0] || layoutDoc.documentElement;
  for (const sp of Array.from(spTree.getElementsByTagName('p:sp'))) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph) continue;
    const type = ph.getAttribute('type') || 'body';
    const idx = ph.getAttribute('idx') || '0';
    const box = parseXfrm(child(sp, 'p:spPr'));
    const txBody = child(sp, 'p:txBody');
    const bodyPr = txBody ? child(txBody, 'a:bodyPr') : null;
    const anchor = bodyPr?.getAttribute('anchor') as PlaceholderInfo['anchor'] | undefined;
    const levels = mergeLevels(
      parseLevels(txBody ? child(txBody, 'a:lstStyle') : null),
      masterLevelsFor(masterStyles, type),
    );
    const info: PlaceholderInfo = { levels };
    if (box.w > 0 && box.h > 0) info.geom = { x: box.x, y: box.y, w: box.w, h: box.h };
    if (anchor) info.anchor = anchor;
    placeholders.set(`${type}#${idx}`, info);
    if (!placeholders.has(type)) placeholders.set(type, info);
  }

  const cSld = layoutDoc.getElementsByTagName('p:cSld')[0];
  const layoutBg = cSld ? child(cSld, 'p:bg') : null;
  const background = backgroundCss(layoutBg) ?? backgroundCss(masterBg);
  let backgroundImageUrl: string | undefined;
  let backgroundImagePath: string | undefined;
  if (deferPictures) {
    backgroundImagePath =
      embeddedPicturePath(layoutBg, 'ppt/slideLayouts', layoutRels) ??
      embeddedPicturePath(masterBg, 'ppt/slideMasters', masterRels);
  } else {
    backgroundImageUrl =
      (await backgroundPicture(zip, layoutBg, 'ppt/slideLayouts', layoutRels, onUrl)) ??
      (await backgroundPicture(zip, masterBg, 'ppt/slideMasters', masterRels, onUrl));
  }
  return { placeholders, masterStyles, background, backgroundImageUrl, backgroundImagePath, theme: deckTheme };
}

/** OOXML matches a slide placeholder to its layout counterpart by type+idx. */
function placeholderFor(
  layout: LayoutInfo | null,
  phType: string,
  phIdx: string,
): PlaceholderInfo | undefined {
  if (!layout) return undefined;
  return layout.placeholders.get(`${phType}#${phIdx}`) ?? (phType ? layout.placeholders.get(phType) : undefined);
}

/** Sensible defaults when no layout geometry exists (e.g. hand-built files). */
function defaultPhGeom(phType: string | undefined, sw: number, sh: number): LayoutGeom {
  if (phType === 'ctrTitle') return { x: sw * 0.1, y: sh * 0.32, w: sw * 0.8, h: sh * 0.22 };
  if (phType === 'title') return { x: sw * 0.06, y: sh * 0.07, w: sw * 0.88, h: sh * 0.22 };
  if (phType === 'subTitle') return { x: sw * 0.15, y: sh * 0.55, w: sw * 0.7, h: sh * 0.25 };
  if (phType === 'body') return { x: sw * 0.1, y: sh * 0.34, w: sw * 0.8, h: sh * 0.56 };
  if (phType === 'pic' || phType === 'media' || phType === 'chart' || phType === 'tbl' || phType === 'dt')
    return { x: sw * 0.1, y: sh * 0.3, w: sw * 0.8, h: sh * 0.6 };
  return { x: sw * 0.08, y: sh * 0.12, w: sw * 0.84, h: sh * 0.5 };
}

function parseTableCell(tc: Element): PptxTableCell {
  const cell: PptxTableCell = { text: '' };
  const txBody = child(tc, 'a:txBody');
  const paras = txBody ? children(txBody, 'a:p') : [];
  const lines: string[] = [];
  for (const p of paras) {
    const para = parseParagraph(p, { n: 0 });
    const line = para.runs.map((r) => r.text).join('');
    if (line.trim()) lines.push(line);
  }
  cell.text = lines.join('\n');
  const firstRun = paras.length ? parseParagraph(paras[0], { n: 0 }).runs.find((r) => r.text.trim()) : undefined;
  if (firstRun) {
    cell.sizePt = firstRun.sizePt;
    cell.bold = firstRun.bold;
    cell.color = firstRun.color;
  }
  const tcPr = child(tc, 'a:tcPr');
  cell.fill = solidColor(tcPr ? child(tcPr, 'a:solidFill') : null);
  const span = parseInt(tc.getAttribute('gridSpan') || '0', 10);
  if (span > 1) cell.gridSpan = span;
  const rowSpan = parseInt(tc.getAttribute('rowSpan') || '0', 10);
  if (rowSpan > 1) cell.rowSpan = rowSpan;
  if (tc.getAttribute('hMerge') === '1') cell.merged = 'h';
  else if (tc.getAttribute('vMerge') === '1') cell.merged = 'v';
  if (tcPr) {
    const borders: NonNullable<PptxTableCell['borders']> = {};
    const edge = (tag: string, key: 'l' | 'r' | 't' | 'b') => {
      const ln = child(tcPr, tag);
      if (!ln || child(ln, 'a:noFill')) return;
      const color = solidColor(child(ln, 'a:solidFill'));
      if (color) borders[key] = color;
    };
    edge('a:lnL', 'l');
    edge('a:lnR', 'r');
    edge('a:lnT', 't');
    edge('a:lnB', 'b');
    if (Object.keys(borders).length) cell.borders = borders;
  }
  return cell;
}

function parseTable(gf: Element, t: T): PptxShape {
  const box = applyT(t, parseXfrm(gf));
  const graphicData = gf.getElementsByTagName('a:graphicData')[0];
  const tbl = graphicData ? child(graphicData, 'a:tbl') : null;
  const shape: PptxShape = { id: 0, type: 'table', x: box.x, y: box.y, w: box.w, h: box.h, rot: box.rot, textScale: 1, isTitle: false };
  if (!tbl) return shape;
  const colWidths = Array.from(child(tbl, 'a:tblGrid')?.children || [])
    .filter((c) => c.tagName.toLowerCase() === 'a:gridcol')
    .map((c) => emuToPx(parseInt(c.getAttribute('w') || '0', 10)));
  const rows = children(tbl, 'a:tr');
  const rowHeights = rows.map((tr) => emuToPx(parseInt(tr.getAttribute('h') || '0', 10)));
  const cells = rows.map((tr) => children(tr, 'a:tc').map(parseTableCell));
  shape.table = { colWidths, rowHeights, cells };
  return shape;
}

interface ShapeCtx {
  t: T;
  imageUrls: Map<string, string>;
  layout: LayoutInfo | null;
  sw: number;
  sh: number;
  nextId: () => number;
  tableTexts: string[];
  imageList: string[];
  push: (s: PptxShape) => void;
}

/** Placeholder types that act as the slide title (incl. the title-slide one). */
export const isTitlePlaceholder = (phType: string): boolean => phType === 'title' || phType === 'ctrTitle';

function defaultSizePtFor(phType: string, isTitle: boolean): number {
  if (phType === 'ctrTitle') return 44;
  if (isTitle) return 32;
  if (phType === 'subTitle') return 28;
  return 18;
}

function parseSp(sp: Element, ctx: ShapeCtx): PptxShape | null {
  const spPr = child(sp, 'p:spPr');
  const ph = sp.getElementsByTagName('p:ph')[0];
  const phType = ph?.getAttribute('type') || (ph ? 'body' : '');
  const phIdx = ph?.getAttribute('idx') || '0';
  const isTitle = isTitlePlaceholder(phType);
  const placeholder = ph ? placeholderFor(ctx.layout, phType, phIdx) : undefined;

  let box = parseXfrm(spPr);
  if (box.w <= 0 || box.h <= 0) {
    const inherited = placeholder?.geom ?? defaultPhGeom(phType || undefined, ctx.sw, ctx.sh);
    box = { ...inherited, rot: 0 };
  }
  const b = applyT(ctx.t, box);

  const prst = child(spPr, 'a:prstGeom')?.getAttribute('prst');
  const noFill = Boolean(spPr && child(spPr, 'a:noFill'));
  const fill = noFill ? undefined : fillCss(spPr);
  const ln = spPr ? child(spPr, 'a:ln') : null;
  const lineColor = ln ? solidColor(child(ln, 'a:solidFill')) : undefined;
  const lineW = ln?.getAttribute('w') ? emuToPx(parseInt(ln.getAttribute('w')!, 10)) : undefined;

  const inheritedLevels = placeholder?.levels ?? (ctx.layout ? masterLevelsFor(ctx.layout.masterStyles, phType) : []);
  const text = parseText(child(sp, 'p:txBody'), defaultSizePtFor(phType, isTitle), inheritedLevels);
  if (text && !text.anchor && placeholder?.anchor) text.anchor = placeholder.anchor;

  const shape: PptxShape = {
    id: ctx.nextId(),
    type: 'text',
    x: b.x,
    y: b.y,
    w: Math.max(b.w, 0),
    h: Math.max(b.h, 0),
    rot: b.rot,
    geom: prst || (text ? 'rect' : undefined),
    fill,
    textScale: (ctx.t.sx + ctx.t.sy) / 2,
    isTitle,
  };
  if (lineColor) {
    shape.borderColor = lineColor;
    shape.borderWidth = Math.max(1, lineW || 1);
  }
  if (text) shape.text = text;
  if (!shape.text && !shape.fill) return null; // empty, invisible placeholder
  return shape;
}

function parsePic(pic: Element, ctx: ShapeCtx): PptxShape {
  const spPr = child(pic, 'p:spPr');
  const box = applyT(ctx.t, parseXfrm(spPr));
  const blipFill = child(pic, 'p:blipFill');
  const blip = blipFill ? child(blipFill, 'a:blip') : null;
  const rid = blip?.getAttribute('r:embed');
  const url = rid ? ctx.imageUrls.get(rid) : undefined;
  if (url) ctx.imageList.push(url);
  const shape: PptxShape = {
    id: ctx.nextId(),
    type: 'image',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 0),
    h: Math.max(box.h, 0),
    rot: box.rot,
    geom: child(spPr, 'a:prstGeom')?.getAttribute('prst') || 'rect',
    imageUrl: url,
    imageRid: rid || undefined,
    textScale: 1,
    isTitle: false,
  };
  // a:srcRect keeps a sub-rectangle of the source (values are 1/1000 %).
  const srcRect = blipFill ? child(blipFill, 'a:srcRect') : null;
  if (srcRect) {
    const frac = (name: string) => {
      const v = parseInt(srcRect.getAttribute(name) || '0', 10);
      return Number.isFinite(v) && v > 0 ? Math.min(v / 100000, 0.999) : 0;
    };
    const crop = { l: frac('l'), t: frac('t'), r: frac('r'), b: frac('b') };
    if (crop.l || crop.t || crop.r || crop.b) shape.crop = crop;
  }
  return shape;
}

function parseCxnSp(cxn: Element, ctx: ShapeCtx): PptxShape {
  const box = applyT(ctx.t, parseXfrm(child(cxn, 'p:spPr')));
  const spPr = child(cxn, 'p:spPr');
  const ln = spPr ? child(spPr, 'a:ln') : null;
  const color = ln ? solidColor(child(ln, 'a:solidFill')) : undefined;
  const w = ln?.getAttribute('w') ? emuToPx(parseInt(ln.getAttribute('w')!, 10)) : 2;
  return {
    id: ctx.nextId(),
    type: 'line',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 1),
    h: Math.max(box.h, Math.max(1, w)),
    rot: box.rot,
    fill: color,
    textScale: 1,
    isTitle: false,
  };
}

function parseGraphicFrame(gf: Element, ctx: ShapeCtx): PptxShape | null {
  const graphicData = gf.getElementsByTagName('a:graphicData')[0];
  const uri = graphicData?.getAttribute('uri') || '';
  if (uri.includes('/table') || (graphicData && child(graphicData, 'a:tbl'))) {
    const shape = parseTable(gf, ctx.t);
    shape.id = ctx.nextId();
    if (shape.table) {
      const rows = shape.table.cells.map((row) => row.map((c) => c.text.replace(/\n/g, ' ')).filter(Boolean));
      ctx.tableTexts.push(...rows.flatMap((row) => row));
    }
    return shape;
  }
  if (uri.includes('/chart')) {
    const box = applyT(ctx.t, parseXfrm(gf));
    return {
      id: ctx.nextId(),
      type: 'chart',
      x: box.x,
      y: box.y,
      w: Math.max(box.w, 0),
      h: Math.max(box.h, 0),
      rot: box.rot,
      textScale: 1,
      isTitle: false,
    };
  }
  return null; // SmartArt & other graphic frames: skipped (kept out of text too)
}

function parseGroup(grp: Element, ctx: ShapeCtx): void {
  const xfrm = child(child(grp, 'p:grpSpPr'), 'a:xfrm');
  if (!xfrm) return;
  const num = (el: Element | null, attr: string) => {
    const v = el?.getAttribute(attr);
    return v ? emuToPx(parseInt(v, 10)) : 0;
  };
  const off = child(xfrm, 'a:off');
  const ext = child(xfrm, 'a:ext');
  const chOff = child(xfrm, 'a:chOff');
  const chExt = child(xfrm, 'a:chExt');
  const t = composeGroup(
    ctx.t,
    { x: num(off, 'x'), y: num(off, 'y'), w: 0, h: 0, rot: 0 },
    { x: 0, y: 0, w: num(ext, 'cx'), h: num(ext, 'cy'), rot: 0 },
    { x: num(chOff, 'x'), y: num(chOff, 'y'), w: 0, h: 0, rot: 0 },
    { x: 0, y: 0, w: num(chExt, 'cx'), h: num(chExt, 'cy'), rot: 0 },
  );
  const groupCtx: ShapeCtx = { ...ctx, t };
  for (const c of Array.from(grp.children)) {
    const tag = c.tagName.toLowerCase();
    if (tag === 'p:sp') {
      const s = parseSp(c, groupCtx);
      if (s) groupCtx.push(s);
    } else if (tag === 'p:pic') {
      groupCtx.push(parsePic(c, groupCtx));
    } else if (tag === 'p:cxnsp') {
      groupCtx.push(parseCxnSp(c, groupCtx));
    } else if (tag === 'p:graphicframe') {
      const s = parseGraphicFrame(c, groupCtx);
      if (s) groupCtx.push(s);
    } else if (tag === 'p:grpsp') {
      parseGroup(c, groupCtx);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Deck: lazy, cached, bounded                                         */
/* ------------------------------------------------------------------ */

/**
 * A parsed-but-not-materialised deck.
 *
 * `renderPptx` (below) eagerly parses every slide for callers that want the
 * whole document at once (PDF export, tests). The reader instead opens a
 * deck: presentation dimensions, slide order and the first requested slide
 * are parsed, and every other slide is parsed on demand behind a bounded
 * LRU cache. Opening a 150-slide lecture therefore costs one slide's parse,
 * not 150 — that upfront whole-deck parse is what used to freeze the reader
 * and is the reason PPTX files were once converted to PDF on open.
 */
export interface PptxDeck {
  slideCount: number;
  /** CSS pixels. */
  slideWidth: number;
  slideHeight: number;
  dates?: { created?: string; modified?: string };
  fileSize: number;
  /**
   * Parses and returns slide `n` (1-based). Results are cached; the cache is
   * bounded, so a long browsing session cannot accumulate every slide's
   * shapes. Media (pictures) is not decoded by this call — the viewer calls
   * `ensureSlideMedia` for the slide on screen, exactly like before.
   */
  getSlide: (n: number) => Promise<PptxSlide | null>;
  /** Parses every slide (eager path / export). Returns them in deck order. */
  parseAllSlides: () => Promise<PptxSlide[]>;
  /**
   * Ordered slide texts WITHOUT a visual parse: shape runs, table cells and
   * speaker notes only. This is what find-in-deck and text extraction use,
   * so searching a deck never triggers layout/theme parsing.
   */
  textIndex: (onProgress?: (done: number, total: number) => void) => Promise<{ slide: number; text: string }[]>;
  /** Decodes the pictures of one slide. No-op when already loaded. */
  ensureSlideMedia: (slideNumber: number) => Promise<void>;
  /** Releases every object URL and cache entry. The deck is unusable after. */
  dispose: () => void;
}

/** Parsed slides kept for instant prev/next. Small: these are the heavy objects. */
const DECK_SLIDE_CACHE = 16;
/** The LRU never evicts the most recent slides — the one on screen is among them. */
const DECK_KEEP_HOT = 4;

export async function openPptxDeck(blob: Blob, opts?: { lazyMedia?: boolean }): Promise<PptxDeck> {
  activeTheme = null; // never inherit another deck's theme
  const lazyMedia = Boolean(opts?.lazyMedia);
  const zip = await JSZip.loadAsync(blob);
  const slideFiles = await orderedSlidePaths(zip);
  const { w: slideWidth, h: slideHeight } = await parsePresentationSize(zip);
  const dates = await parseDates(zip);

  /* ---- shared, deck-lifetime caches (immutable parts of the file) ---- */

  // Relationships are tiny XML docs but were re-parsed per slide AND per
  // layout AND per master before; a deck with 100 slides sharing 2 layouts
  // parsed the same master >100 times.
  const relsCache = new Map<string, Promise<Map<string, Rel>>>();
  const loadRelsCached = (partPath: string): Promise<Map<string, Rel>> => {
    const hit = relsCache.get(partPath);
    if (hit) return hit;
    const p = loadRelsFor(zip, partPath);
    relsCache.set(partPath, p);
    return p;
  };

  // Layouts (and the master + theme each one pulls in) are shared by every
  // slide that uses them; parse each distinct layout exactly once.
  const layoutCache = new Map<string, Promise<LayoutInfo | null>>();
  const loadLayoutCached = (slideRels: Map<string, Rel>): Promise<LayoutInfo | null> => {
    const layoutRel = Array.from(slideRels.values()).find((r) => r.type.endsWith('/slideLayout'));
    if (!layoutRel) return Promise.resolve(null);
    const layoutPath = resolveZipPath('ppt/slides', layoutRel.target);
    const hit = layoutCache.get(layoutPath);
    if (hit) return hit;
    const p = loadLayoutInfo(zip, slideRels, (u) => urlRevoke.push(u), lazyMedia);
    layoutCache.set(layoutPath, p);
    return p;
  };

  /* ---- media bookkeeping (refcounted per slide, revoked when unused) ---- */

  const urlRevoke: string[] = [];
  const urlByPath = new Map<string, string>();
  /** Which slide numbers still hold a live reference to each media path. */
  const pathRefs = new Map<string, Set<number>>();
  /** Media paths decoded for a given slide number (for eviction/refcount). */
  const slideLoadedPaths = new Map<number, string[]>();
  const jobs = new Map<number, { rels: Map<string, Rel>; slideBgPath?: string; layoutBgPath?: string }>();
  const loadedMedia = new Set<number>();
  const inflight = new Map<number, Promise<void>>();
  let alive = true;

  const urlFor = async (path: string, forSlide: number): Promise<string | undefined> => {
    if (!alive) return undefined;
    const cached = urlByPath.get(path);
    if (cached) {
      pathRefs.get(path)?.add(forSlide);
      return cached;
    }
    const media = zip.file(path);
    if (!media) return undefined;
    try {
      const url = URL.createObjectURL(await media.async('blob'));
      if (!alive) {
        try { URL.revokeObjectURL(url); } catch { /* disposed mid-load */ }
        return undefined;
      }
      urlRevoke.push(url);
      urlByPath.set(path, url);
      let refs = pathRefs.get(path);
      if (!refs) { refs = new Set(); pathRefs.set(path, refs); }
      refs.add(forSlide);
      return url;
    } catch {
      return undefined;
    }
  };

  /* ---- per-slide visual parse (the old renderPptx loop body) ---- */

  const parseSlideAt = async (i: number): Promise<PptxSlide | null> => {
    const slidePath = slideFiles[i];
    if (!slidePath) return null;
    const content = await zip.file(slidePath)?.async('text');
    if (!content) return null;
    const doc = new DOMParser().parseFromString(content, 'text/xml');
    const rels = await loadRelsCached(slidePath);

    // Embedded images. Eager parses decode every picture of the slide now
    // (callers that omit lazyMedia — and the unit tests — still get URLs
    // immediately). Lazy decks defer to ensureSlideMedia.
    const imageUrls = new Map<string, string>();
    if (!lazyMedia) {
      for (const [rid, rel] of rels) {
        if (!rel.type.endsWith('/image')) continue;
        const path = resolveZipPath('ppt/slides', rel.target);
        const media = zip.file(path);
        if (!media) continue;
        try {
          const url = await urlFor(path, i + 1);
          if (url) {
            imageUrls.set(rid, url);
            const list = slideLoadedPaths.get(i + 1) ?? [];
            if (!list.includes(path)) { list.push(path); slideLoadedPaths.set(i + 1, list); }
          }
        } catch {
          /* unreadable media — skip */
        }
      }
    }

    const layout = await loadLayoutCached(rels);
    const cSld = doc.getElementsByTagName('p:cSld')[0] || doc.documentElement;
    const spTree = cSld.getElementsByTagName('p:spTree')[0] || cSld;

    // Background: the slide's own, else the layout's, else the master's.
    const slideBg = child(cSld, 'p:bg');
    const background = backgroundCss(slideBg) ?? layout?.background;
    let backgroundImageUrl = layout?.backgroundImageUrl;
    if (lazyMedia) {
      jobs.set(i + 1, {
        rels,
        slideBgPath: embeddedPicturePath(slideBg, 'ppt/slides', rels),
        layoutBgPath: layout?.backgroundImagePath,
      });
    } else {
      const slideBgPath = embeddedPicturePath(slideBg, 'ppt/slides', rels);
      const slideBgImage = slideBgPath ? await urlFor(slideBgPath, i + 1) : undefined;
      if (slideBgPath && slideBgImage) {
        const list = slideLoadedPaths.get(i + 1) ?? [];
        list.push(slideBgPath); slideLoadedPaths.set(i + 1, list);
      }
      backgroundImageUrl = slideBgImage ?? layout?.backgroundImageUrl;
    }

    // Apply this slide's theme for the (synchronous) parse below. The shape
    // section never awaits, so concurrent slide parses cannot interleave a
    // different deck's — or slide's — active theme into it.
    activeTheme = layout?.theme ?? activeTheme;

    let nextId = 0;
    const shapes: PptxShape[] = [];
    const tableTexts: string[] = [];
    const imageList: string[] = [];
    const ctx: ShapeCtx = {
      t: IDENTITY,
      imageUrls,
      layout,
      sw: slideWidth,
      sh: slideHeight,
      nextId: () => ++nextId,
      tableTexts,
      imageList,
      push: (s: PptxShape) => shapes.push(s),
    };

    for (const c of Array.from(spTree.children)) {
      const tag = c.tagName.toLowerCase();
      if (tag === 'p:sp') {
        const s = parseSp(c, ctx);
        if (s) ctx.push(s);
      } else if (tag === 'p:pic') {
        ctx.push(parsePic(c, ctx));
      } else if (tag === 'p:cxnsp') {
        ctx.push(parseCxnSp(c, ctx));
      } else if (tag === 'p:graphicframe') {
        const s = parseGraphicFrame(c, ctx);
        if (s) ctx.push(s);
      } else if (tag === 'p:grpsp') {
        parseGroup(c, ctx);
      }
    }

    /* --- Legacy flat-text fields (unchanged semantics) --- */
    let title = '';
    const body: string[] = [];
    for (const c of Array.from(spTree.getElementsByTagName('p:sp'))) {
      const ph = c.getElementsByTagName('p:ph')[0];
      const phType = ph?.getAttribute('type') || '';
      const txBody = c.getElementsByTagName('p:txBody')[0];
      if (!txBody) continue;
      // Join the runs of each paragraph with no separator (PowerPoint splits
      // a single word across runs — naive per-run joining corrupts search text).
      const paraTexts = Array.from(txBody.getElementsByTagName('a:p'))
        .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join(''))
        .filter((t) => t.trim());
      if (isTitlePlaceholder(phType || (ph ? 'body' : ''))) {
        if (!title) title = paraTexts.join(' ');
      } else {
        body.push(...paraTexts);
      }
    }

    // Speaker notes via the slide's own relationship (robust to reordering);
    // fall back to the conventional notesSlide{n} naming for minimal files.
    let notes = '';
    const notesRel = Array.from(rels.values()).find((r) => r.type.endsWith('/notesSlide'));
    const notesPath = notesRel
      ? resolveZipPath('ppt/slides', notesRel.target)
      : `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notesFile = zip.file(notesPath);
    if (notesFile) {
      const notesDoc = new DOMParser().parseFromString(await notesFile.async('text'), 'text/xml');
      // PowerPoint's notes pane shows ONLY the notes placeholder's text. A
      // notes slide can also carry other shapes (a mirrored copy of the slide
      // text, slide-number boxes) which must not leak into the notes, so
      // prefer the body-placeholder shape and fall back to every paragraph
      // for minimal files that mark nothing.
      const allNoteShapes = Array.from(notesDoc.getElementsByTagName('p:sp'));
      const paragraphsOf = (sp: Element) =>
        Array.from(sp.getElementsByTagName('a:p')).map((p) =>
          Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join(''),
        );
      const notesBody = allNoteShapes.find((sp) => {
        // Placeholders are <p:ph> in real files; a:ph is accepted defensively.
        const ph = sp.getElementsByTagName('p:ph')[0] ?? sp.getElementsByTagName('a:ph')[0];
        return ph?.getAttribute('type') === 'body';
      });
      const noteParas = notesBody
        ? paragraphsOf(notesBody)
        : allNoteShapes.length
          ? allNoteShapes.flatMap(paragraphsOf)
          : Array.from(notesDoc.getElementsByTagName('a:p')).map((p) =>
              Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join(''),
            );
      const lines = noteParas.map((t) => t.trim()).filter(Boolean);
      // PowerPoint repeats the slide number on the last note line.
      const last = lines[lines.length - 1];
      if (last && /^\d{1,3}$/.test(last) && parseInt(last, 10) === i + 1) lines.pop();
      notes = lines.join('\n');
    }

    // Combined text: title + body (document order) + table cells, then notes —
    // the same searchable content the old renderer produced, plus tables.
    const parts: string[] = [];
    if (title) parts.push(title);
    body.forEach((p) => parts.push(p));
    tableTexts.forEach((p) => parts.push(p));
    if (notes) parts.push(`Notes: ${notes}`);

    return {
      slideNumber: i + 1,
      title,
      body,
      images: imageList.slice(),
      notes,
      text: parts.join('\n'),
      background,
      backgroundImageUrl,
      shapes,
    };
  };

  /* ---- bounded slide cache ---- */

  const parsedSlides = new Map<number, PptxSlide>(); // insertion order = LRU order
  const slideInflight = new Map<number, Promise<PptxSlide | null>>();
  /** Set by parseAllSlides: eager decks keep every slide cached (see below). */
  let allParsed = false;

  const revokeSlideMedia = (n: number) => {
    const paths = slideLoadedPaths.get(n);
    if (!paths) return;
    for (const path of paths) {
      const refs = pathRefs.get(path);
      if (!refs) continue;
      refs.delete(n);
      if (refs.size === 0) {
        const url = urlByPath.get(path);
        if (url) {
          try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
        }
        urlByPath.delete(path);
        pathRefs.delete(path);
      }
    }
    slideLoadedPaths.delete(n);
  };

  const evictColdSlides = () => {
    if (allParsed) return;
    while (parsedSlides.size > DECK_SLIDE_CACHE - DECK_KEEP_HOT) {
      // Map iterates oldest-inserted first; the hot (recent) tail is never touched.
      const oldest = parsedSlides.keys().next();
      if (oldest.done) break;
      parsedSlides.delete(oldest.value);
      jobs.delete(oldest.value);
      revokeSlideMedia(oldest.value);
    }
  };

  const getSlide = async (n: number): Promise<PptxSlide | null> => {
    if (!alive || n < 1 || n > slideFiles.length) return null;
    const hit = parsedSlides.get(n);
    if (hit) {
      // Refresh recency.
      parsedSlides.delete(n);
      parsedSlides.set(n, hit);
      return hit;
    }
    const pending = slideInflight.get(n);
    if (pending) return pending;
    const run = (async () => {
      const slide = await parseSlideAt(n - 1);
      if (!alive) return slide;
      if (slide) {
        parsedSlides.set(n, slide);
        evictColdSlides();
      }
      slideInflight.delete(n);
      return slide;
    })();
    slideInflight.set(n, run);
    return run;
  };

  /* ---- media loading for one slide (lazy decks) ---- */

  const ensureSlideMedia = (slideNumber: number): Promise<void> => {
    if (!alive || loadedMedia.has(slideNumber)) return Promise.resolve();
    const pending = inflight.get(slideNumber);
    if (pending) return pending;
    const run = (async () => {
      const job = jobs.get(slideNumber);
      const slide = parsedSlides.get(slideNumber);
      if (!job || !slide) {
        loadedMedia.add(slideNumber);
        return;
      }
      const note = (path?: string) => {
        if (!path) return;
        const list = slideLoadedPaths.get(slideNumber) ?? [];
        if (!list.includes(path)) { list.push(path); slideLoadedPaths.set(slideNumber, list); }
      };
      if (job.slideBgPath) {
        slide.backgroundImageUrl = (await urlFor(job.slideBgPath, slideNumber)) ?? slide.backgroundImageUrl;
        note(job.slideBgPath);
      } else if (job.layoutBgPath && !slide.backgroundImageUrl) {
        const layoutUrl = await urlFor(job.layoutBgPath, slideNumber);
        if (layoutUrl) {
          note(job.layoutBgPath);
          slide.backgroundImageUrl = layoutUrl;
        }
      }
      for (const shape of slide.shapes) {
        if (!shape.imageRid || shape.imageUrl) continue;
        const rel = job.rels.get(shape.imageRid);
        if (!rel || !rel.type.endsWith('/image')) continue;
        const path = resolveZipPath('ppt/slides', rel.target);
        const url = await urlFor(path, slideNumber);
        if (!url) continue;
        note(path);
        shape.imageUrl = url;
        if (!slide.images.includes(url)) slide.images.push(url);
      }
      loadedMedia.add(slideNumber);
    })();
    inflight.set(slideNumber, run);
    return run;
  };

  /* ---- eager parse (export / legacy renderPptx callers) ---- */

  const parseAllSlides = async (): Promise<PptxSlide[]> => {
    const slides: PptxSlide[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      if (!alive) return slides;
      const slide = await parseSlideAt(i);
      if (slide) slides.push(slide);
      // Keep the UI thread free on large lazy decks. Eager parses stay synchronous
      // so existing tests do not pick up an extra turn.
      if (lazyMedia && (i + 1) % 4 === 0 && i < slideFiles.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (alive) {
      // Register every parsed slide. Eager decks are exempt from the LRU
      // bound: renderPptx callers (PDF export, tests) expect every slide and
      // its media to stay addressable until dispose, exactly as before.
      for (const s of slides) {
        parsedSlides.set(s.slideNumber, s);
      }
      if (!lazyMedia) slides.forEach((s) => loadedMedia.add(s.slideNumber));
      allParsed = true;
    }
    return slides;
  };

  /* ---- text-only pass (find + extraction; no visual parse) ---- */

  const textIndex = async (
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ slide: number; text: string }[]> => {
    const out: { slide: number; text: string }[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      if (!alive) return out;
      const slidePath = slideFiles[i];
      const content = await zip.file(slidePath)?.async('text');
      if (!content) continue;
      let text = '';
      try {
        const doc = new DOMParser().parseFromString(content, 'text/xml');
        text = Array.from(doc.getElementsByTagName('a:p'))
          .map((p) =>
            Array.from(p.getElementsByTagName('a:t'))
              .map((t) => t.textContent || '')
              .join(''),
          )
          .filter((t) => t.trim())
          .join('\n');
      } catch {
        /* unreadable slide — skip */
      }
      // Speaker notes join the searchable text, matching the visual parse.
      let notes = '';
      const rels = await loadRelsCached(slidePath);
      const notesRel = Array.from(rels.values()).find((r) => r.type.endsWith('/notesSlide'));
      const notesPath = notesRel
        ? resolveZipPath('ppt/slides', notesRel.target)
        : `ppt/notesSlides/notesSlide${i + 1}.xml`;
      const notesFile = zip.file(notesPath);
      if (notesFile) {
        try {
          const notesDoc = new DOMParser().parseFromString(await notesFile.async('text'), 'text/xml');
          const lines = Array.from(notesDoc.getElementsByTagName('a:p'))
            .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join('').trim())
            .filter(Boolean);
          const last = lines[lines.length - 1];
          if (last && /^\d{1,3}$/.test(last) && parseInt(last, 10) === i + 1) lines.pop();
          notes = lines.join('\n');
        } catch {
          /* unreadable notes — skip */
        }
      }
      const parts = [text, notes ? `Notes: ${notes}` : ''].filter((t) => t.trim());
      out.push({ slide: i + 1, text: parts.join('\n') });
      onProgress?.(i + 1, slideFiles.length);
      if ((i + 1) % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return out;
  };

  const dispose = () => {
    alive = false;
    jobs.clear();
    parsedSlides.clear();
    slideInflight.clear();
    urlByPath.clear();
    pathRefs.clear();
    slideLoadedPaths.clear();
    relsCache.clear();
    layoutCache.clear();
    inflight.clear();
    loadedMedia.clear();
    urlRevoke.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* already revoked */
      }
    });
  };

  return {
    slideCount: slideFiles.length,
    slideWidth,
    slideHeight,
    dates,
    fileSize: blob.size,
    getSlide,
    parseAllSlides,
    textIndex,
    ensureSlideMedia,
    dispose,
  };
}

/**
 * Eager, whole-deck parse. Returns every slide materialised — the interface
 * the PDF exporter and the unit tests are written against. The reader uses
 * `openPptxDeck` instead (see above) so opening a file never waits for the
 * whole deck to parse.
 */
export async function renderPptx(blob: Blob, opts?: { lazyMedia?: boolean }): Promise<PptxDocument> {
  const deck = await openPptxDeck(blob, opts);
  const slides = await deck.parseAllSlides();
  const fullText = slides.length
    ? slides.map((s) => `--- Slide ${s.slideNumber} ---\n${s.text}`).join('\n\n')
    : '';
  return {
    slides,
    slideWidth: deck.slideWidth,
    slideHeight: deck.slideHeight,
    fullText,
    fileSize: deck.fileSize,
    dates: deck.dates,
    ensureSlideMedia: deck.ensureSlideMedia,
    dispose: () => deck.dispose(),
  };
}
