/*!
 * Adapted from g2code33/pharmaTRACK_PERFECT_new at
 * 19edf65562e25d0827f655e0c799cfe83554abc6.
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
  /** Plain-text equivalent, retained for search, copy and accessibility. */
  text: string;
  /** Safe MathML generated locally from an Office Math (OMML) run. */
  mathMl?: string;
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

export type PptxShapeType = 'text' | 'image' | 'video' | 'table' | 'chart' | 'line';

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
  /** Ordered local alternatives (for example SVG first, then EMF/PNG). */
  imageUrls?: string[];
  /** Relationship id of the preferred embedded image. */
  imageRid?: string;
  /** All package image relationships in preferred decode order. */
  imageRids?: string[];
  /** Resolved OPC package paths for those relationships (internal/lazy use). */
  imagePaths?: string[];
  /** a:srcRect cropping of the source image, as 0..1 fractions of each edge. */
  crop?: { l: number; t: number; r: number; b: number };
  /**
   * Playable clip for a `type: 'video'` shape (object URL into the embedded
   * media part). `imageUrl` on a video shape is the poster frame PowerPoint
   * stores alongside it, used both as the `<video poster>` and as the
   * fallback when the clip itself is a *linked* (not embedded) file that
   * cannot be resolved offline.
   */
  videoUrl?: string;
  /** Relationship id of the embedded/linked video. Filled even before resolution. */
  videoRid?: string;
  table?: PptxTable;
  /** Font scale inherited from an enclosing group. */
  textScale: number;
  /** True for placeholders (used for default font sizing). */
  isTitle: boolean;
  /** Resolved OOXML placeholder type (title, body, sldNum, …), when present. */
  placeholderType?: string;
}

export interface PptxDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
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
  /** Visible fidelity failures; unsupported content is never silently blank. */
  diagnostics?: PptxDiagnostic[];
}

export interface PptxMediaOptions {
  /** False for static thumbnails: load backgrounds/posters, but not large clips. */
  includeClips?: boolean;
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
   * Loads media for one slide. No-op when it is already decoded. Static
   * thumbnails pass `{ includeClips: false }` so a large embedded movie is not
   * decompressed merely because its slide entered the thumbnail rail.
   */
  ensureSlideMedia: (slideNumber: number, options?: PptxMediaOptions) => Promise<void>;
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

const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MATH_STRICT_NS = 'http://purl.oclc.org/ooxml/officeDocument/math';
const DRAWING_2010_NS = 'http://schemas.microsoft.com/office/drawing/2010/main';
const POWERPOINT_2010_NS = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const DIAGRAM_DRAWING_NS = 'http://schemas.microsoft.com/office/drawing/2008/diagram';

const localTag = (el: Element): string =>
  (el.localName || el.tagName.split(':').pop() || el.tagName).toLowerCase();

const childByLocalName = (el: Element | null, name: string): Element | null => {
  if (!el) return null;
  const wanted = name.toLowerCase();
  return Array.from(el.children).find((candidate) => localTag(candidate) === wanted) || null;
};

const descendantsByLocalName = (el: Element | Document | null, name: string): Element[] => {
  if (!el) return [];
  const wanted = name.toLowerCase();
  return Array.from(el.getElementsByTagName('*')).filter((candidate) => localTag(candidate) === wanted);
};

const inNamespace = (el: Element, namespace: string, local?: string): boolean =>
  el.namespaceURI === namespace && (!local || localTag(el) === local.toLowerCase());

const isMathElement = (el: Element, local?: string): boolean =>
  (el.namespaceURI === MATH_NS || el.namespaceURI === MATH_STRICT_NS) &&
  (!local || localTag(el) === local.toLowerCase());

/** Prefix-independent attribute access (OMML writers do not all use `m:`). */
function localAttribute(el: Element | null, name: string): string | null {
  if (!el) return null;
  for (const attr of Array.from(el.attributes)) {
    const local = attr.localName || attr.name.split(':').pop() || attr.name;
    if (local.toLowerCase() === name.toLowerCase()) return attr.value;
  }
  return null;
}

const SUPPORTED_COMPATIBILITY_NAMESPACES = new Set([
  PRESENTATION_NS,
  DRAWING_NS,
  DRAWING_2010_NS,
  POWERPOINT_2010_NS,
  MATH_NS,
  MATH_STRICT_NS,
]);

/** Whether Yayra understands every namespace required by an mc:Choice. */
function compatibilityChoiceSupported(choice: Element): boolean {
  const requires = (choice.getAttribute('Requires') || choice.getAttribute('requires') || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!requires.length) return true;
  return requires.every((prefix) => {
    const uri = choice.lookupNamespaceURI?.(prefix) || null;
    if (uri) return SUPPORTED_COMPATIBILITY_NAMESPACES.has(uri);
    // Defensive fallback for DOM implementations without lookupNamespaceURI.
    return prefix === 'a14' || prefix === 'p14' || prefix === 'm';
  });
}

function compatibilityChoices(alternate: Element): Element[] {
  return Array.from(alternate.children).filter(
    (el) => inNamespace(el, MC_NS, 'choice') && compatibilityChoiceSupported(el),
  );
}

function compatibilityFallback(alternate: Element): Element | null {
  return Array.from(alternate.children).find((el) => inNamespace(el, MC_NS, 'fallback')) || null;
}

/**
 * Select the modern compatibility branch we can understand; otherwise use
 * the package's fallback. This helper is also used by text-only indexing so
 * Choice and Fallback content can never be counted twice.
 */
function selectedCompatibilityBranch(alternate: Element): Element | null {
  return compatibilityChoices(alternate)[0] || compatibilityFallback(alternate);
}

/** Walk descendants while resolving each mc:AlternateContent exactly once. */
function walkEffectiveElements(root: Element, visit: (el: Element) => void): void {
  for (const el of Array.from(root.children)) {
    if (inNamespace(el, MC_NS, 'alternatecontent')) {
      const branch = selectedCompatibilityBranch(el);
      if (branch) walkEffectiveElements(branch, visit);
      continue;
    }
    visit(el);
    walkEffectiveElements(el, visit);
  }
}

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

interface MathFragment {
  markup: string;
  text: string;
}

const EMPTY_MATH: MathFragment = { markup: '', text: '' };

function escapeMathText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mathChildren(el: Element | null, name?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter(
    (candidate) => isMathElement(candidate) && (!name || localTag(candidate) === name.toLowerCase()),
  );
}

function mathChild(el: Element | null, name: string): Element | null {
  return mathChildren(el, name)[0] || null;
}

function mathPropertyValue(properties: Element | null, name: string): string | null {
  return localAttribute(mathChild(properties, name), 'val');
}

function joinMath(fragments: MathFragment[], separator = ''): MathFragment {
  const useful = fragments.filter((fragment) => fragment.markup || fragment.text);
  if (!useful.length) return EMPTY_MATH;
  const markup = useful.map((fragment) => fragment.markup).join(separator);
  return {
    markup: useful.length > 1 ? `<mrow>${markup}</mrow>` : markup,
    text: useful.map((fragment) => fragment.text).join(''),
  };
}

/** Tokenise one OMML text run without ever treating package text as markup. */
function mathTextFragment(text: string): MathFragment {
  if (!text) return EMPTY_MATH;
  const chunks = text.match(/\s+|\d+(?:[.,]\d+)*|[A-Za-z]+|[\u0370-\u03ff]+|./gu) || [text];
  const markup = chunks.map((chunk) => {
    if (/^\s+$/.test(chunk)) return `<mspace width="${Math.max(0.2, chunk.length * 0.24)}em"/>`;
    const escaped = escapeMathText(chunk);
    if (/^\d+(?:[.,]\d+)*$/.test(chunk)) return `<mn>${escaped}</mn>`;
    if (/^[A-Za-z\u0370-\u03ff]+$/u.test(chunk)) return `<mi>${escaped}</mi>`;
    if (/^[+\-−=×÷/*<>≤≥±∓≈≠∝∞∫∑∏√()[\]{}|,:;.]+$/u.test(chunk)) return `<mo>${escaped}</mo>`;
    return `<mtext>${escaped}</mtext>`;
  }).join('');
  return { markup: chunks.length > 1 ? `<mrow>${markup}</mrow>` : markup, text };
}

const SUPER_CHARS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};
const SUB_CHARS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

function scriptText(value: string, kind: 'sup' | 'sub'): string {
  const map = kind === 'sup' ? SUPER_CHARS : SUB_CHARS;
  const converted = Array.from(value).map((char) => map[char]).join('');
  return converted.length === Array.from(value).length && converted
    ? converted
    : `${kind === 'sup' ? '^' : '_'}(${value})`;
}

function mathArgument(parent: Element, name: string): MathFragment {
  const arg = mathChild(parent, name);
  return arg ? mathListFragment(arg) : EMPTY_MATH;
}

/** Converts the structural subset of OMML used by PowerPoint into MathML. */
function mathNodeFragment(node: Element): MathFragment {
  const name = localTag(node);
  if (name.endsWith('pr')) return EMPTY_MATH;

  if (name === 'r') {
    const pieces: string[] = [];
    const collect = (root: Element) => {
      for (const c of Array.from(root.children)) {
        if (isMathElement(c, 't')) pieces.push(c.textContent || '');
        else if (isMathElement(c)) collect(c);
      }
    };
    collect(node);
    const fragment = mathTextFragment(pieces.join(''));
    const properties = mathChild(node, 'rPr');
    const normal = mathChild(properties, 'nor');
    const style = mathPropertyValue(properties, 'sty');
    const variant = normal || style === 'p'
      ? 'normal'
      : style === 'b'
        ? 'bold'
        : style === 'bi'
          ? 'bold-italic'
          : '';
    return variant && fragment.markup
      ? { ...fragment, markup: `<mstyle mathvariant="${variant}">${fragment.markup}</mstyle>` }
      : fragment;
  }

  if (name === 't') return mathTextFragment(node.textContent || '');

  if (name === 'f') {
    const numerator = mathArgument(node, 'num');
    const denominator = mathArgument(node, 'den');
    const kind = mathPropertyValue(mathChild(node, 'fPr'), 'type') || 'bar';
    if (kind === 'lin') {
      return {
        markup: `<mrow>${numerator.markup}<mo>/</mo>${denominator.markup}</mrow>`,
        text: `${numerator.text}/${denominator.text}`,
      };
    }
    return {
      markup: `<mfrac${kind === 'skw' ? ' bevelled="true"' : kind === 'noBar' ? ' linethickness="0"' : ''}>${numerator.markup}${denominator.markup}</mfrac>`,
      text: `${numerator.text}⁄${denominator.text}`,
    };
  }

  if (name === 'ssup' || name === 'ssub' || name === 'ssubsup') {
    const base = mathArgument(node, 'e');
    const sub = mathArgument(node, 'sub');
    const sup = mathArgument(node, 'sup');
    if (name === 'ssup') return {
      markup: `<msup>${base.markup}${sup.markup}</msup>`,
      text: `${base.text}${scriptText(sup.text, 'sup')}`,
    };
    if (name === 'ssub') return {
      markup: `<msub>${base.markup}${sub.markup}</msub>`,
      text: `${base.text}${scriptText(sub.text, 'sub')}`,
    };
    return {
      markup: `<msubsup>${base.markup}${sub.markup}${sup.markup}</msubsup>`,
      text: `${base.text}${scriptText(sub.text, 'sub')}${scriptText(sup.text, 'sup')}`,
    };
  }

  if (name === 'spre') {
    const base = mathArgument(node, 'e');
    const sub = mathArgument(node, 'sub');
    const sup = mathArgument(node, 'sup');
    return {
      markup: `<mmultiscripts>${base.markup}<mprescripts/>${sub.markup || '<none/>'}${sup.markup || '<none/>'}</mmultiscripts>`,
      text: `${scriptText(sub.text, 'sub')}${scriptText(sup.text, 'sup')}${base.text}`,
    };
  }

  if (name === 'rad') {
    const body = mathArgument(node, 'e');
    const degree = mathArgument(node, 'deg');
    const hidden = mathChild(mathChild(node, 'radPr'), 'degHide');
    const hasDegree = degree.markup && localAttribute(hidden, 'val') !== '1';
    return {
      markup: hasDegree ? `<mroot>${body.markup}${degree.markup}</mroot>` : `<msqrt>${body.markup}</msqrt>`,
      text: hasDegree ? `√[${degree.text}](${body.text})` : `√(${body.text})`,
    };
  }

  if (name === 'nary') {
    const properties = mathChild(node, 'naryPr');
    const operator = mathPropertyValue(properties, 'chr') || '∫';
    const body = mathArgument(node, 'e');
    const sub = mathArgument(node, 'sub');
    const sup = mathArgument(node, 'sup');
    let scripted = `<mo>${escapeMathText(operator)}</mo>`;
    if (sub.markup && sup.markup) scripted = `<munderover>${scripted}${sub.markup}${sup.markup}</munderover>`;
    else if (sub.markup) scripted = `<munder>${scripted}${sub.markup}</munder>`;
    else if (sup.markup) scripted = `<mover>${scripted}${sup.markup}</mover>`;
    return {
      markup: `<mrow>${scripted}${body.markup}</mrow>`,
      text: `${operator}${sub.text ? scriptText(sub.text, 'sub') : ''}${sup.text ? scriptText(sup.text, 'sup') : ''}${body.text}`,
    };
  }

  if (name === 'd') {
    const properties = mathChild(node, 'dPr');
    const open = mathPropertyValue(properties, 'begChr');
    const close = mathPropertyValue(properties, 'endChr');
    const separator = mathPropertyValue(properties, 'sepChr') || '|';
    const items = mathChildren(node, 'e').map((item) => mathListFragment(item));
    const middleMarkup = items.map((item) => item.markup).join(`<mo separator="true">${escapeMathText(separator)}</mo>`);
    const middleText = items.map((item) => item.text).join(separator);
    const left = open === '' ? '' : (open || '(');
    const right = close === '' ? '' : (close || ')');
    return {
      markup: `<mrow>${left ? `<mo stretchy="true">${escapeMathText(left)}</mo>` : ''}${middleMarkup}${right ? `<mo stretchy="true">${escapeMathText(right)}</mo>` : ''}</mrow>`,
      text: `${left}${middleText}${right}`,
    };
  }

  if (name === 'func') {
    const functionName = mathArgument(node, 'fName');
    const body = mathArgument(node, 'e');
    return {
      markup: `<mrow>${functionName.markup}<mo>&#x2061;</mo>${body.markup}</mrow>`,
      text: `${functionName.text}${body.text}`,
    };
  }

  if (name === 'limlow' || name === 'limupp') {
    const base = mathArgument(node, 'e');
    const limit = mathArgument(node, 'lim');
    return {
      markup: name === 'limlow' ? `<munder>${base.markup}${limit.markup}</munder>` : `<mover>${base.markup}${limit.markup}</mover>`,
      text: `${base.text}${name === 'limlow' ? scriptText(limit.text, 'sub') : scriptText(limit.text, 'sup')}`,
    };
  }

  if (name === 'acc' || name === 'bar' || name === 'groupchr') {
    const propertyName = name === 'acc' ? 'accPr' : name === 'bar' ? 'barPr' : 'groupChrPr';
    const properties = mathChild(node, propertyName);
    const body = mathArgument(node, 'e');
    const top = name === 'acc' || mathPropertyValue(properties, 'pos') === 'top';
    const glyph = name === 'acc'
      ? (mathPropertyValue(properties, 'chr') || 'ˆ')
      : name === 'bar'
        ? '¯'
        : (mathPropertyValue(properties, 'chr') || (top ? '⏞' : '⏟'));
    return {
      markup: top
        ? `<mover accent="true">${body.markup}<mo>${escapeMathText(glyph)}</mo></mover>`
        : `<munder accentunder="true">${body.markup}<mo>${escapeMathText(glyph)}</mo></munder>`,
      text: `${body.text}${glyph}`,
    };
  }

  if (name === 'eqarr') {
    const rows = mathChildren(node, 'e').map((row) => mathListFragment(row));
    return {
      markup: `<mtable>${rows.map((row) => `<mtr><mtd>${row.markup}</mtd></mtr>`).join('')}</mtable>`,
      text: rows.map((row) => row.text).join('\n'),
    };
  }

  if (name === 'm') {
    const rows = mathChildren(node, 'mr').map((row) =>
      mathChildren(row, 'e').map((cell) => mathListFragment(cell)),
    );
    return {
      markup: `<mtable>${rows.map((row) => `<mtr>${row.map((cell) => `<mtd>${cell.markup}</mtd>`).join('')}</mtr>`).join('')}</mtable>`,
      text: rows.map((row) => row.map((cell) => cell.text).join('  ')).join('\n'),
    };
  }

  if (name === 'borderbox') {
    const body = mathArgument(node, 'e');
    return { markup: `<menclose notation="box">${body.markup}</menclose>`, text: body.text };
  }
  if (name === 'phant') {
    const body = mathArgument(node, 'e');
    return { markup: `<mphantom>${body.markup}</mphantom>`, text: body.text };
  }
  if (name === 'box') return mathArgument(node, 'e');

  // oMath and argument wrappers, plus future OMML structures whose children
  // are still meaningful, degrade to their ordered mathematical content.
  return mathListFragment(node);
}

function mathListFragment(parent: Element): MathFragment {
  return joinMath(mathChildren(parent).map((node) => mathNodeFragment(node)));
}

function ommlRoots(container: Element): Element[] {
  const roots: Element[] = [];
  const walk = (node: Element) => {
    if (isMathElement(node, 'omathpara') || isMathElement(node, 'omath')) {
      roots.push(node);
      return;
    }
    for (const c of Array.from(node.children)) walk(c);
  };
  walk(container);
  return roots;
}

function equationRuns(container: Element): PptxRun[] {
  return ommlRoots(container).map((root) => {
    let fragment: MathFragment;
    const display = isMathElement(root, 'omathpara');
    if (display) {
      const lines = mathChildren(root, 'oMath').map((line) => mathListFragment(line));
      fragment = lines.length > 1
        ? {
            markup: `<mtable>${lines.map((line) => `<mtr><mtd>${line.markup}</mtd></mtr>`).join('')}</mtable>`,
            text: lines.map((line) => line.text).join('\n'),
          }
        : (lines[0] || mathListFragment(root));
    } else {
      fragment = mathListFragment(root);
    }
    const run: PptxRun = {
      text: fragment.text,
      mathMl: `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>${fragment.markup || '<mrow/>'}</math>`,
      font: 'Cambria Math',
    };
    const drawingRunProps = Array.from(root.getElementsByTagName('a:rPr'))[0] || null;
    parseRunProps(drawingRunProps, run);
    return run;
  }).filter((run) => run.text || run.mathMl);
}

function inlineRunsFrom(container: Element): PptxRun[] {
  const runs: PptxRun[] = [];
  for (const c of Array.from(container.children)) {
    if (inNamespace(c, DRAWING_NS, 'r') || inNamespace(c, DRAWING_NS, 'fld')) {
      const text = child(c, 'a:t')?.textContent ?? '';
      if (text) {
        const run: PptxRun = { text };
        parseRunProps(child(c, 'a:rPr'), run);
        runs.push(run);
      }
      continue;
    }
    if (inNamespace(c, DRAWING_NS, 'br')) {
      runs.push({ text: '\n' });
      continue;
    }
    if (inNamespace(c, MC_NS, 'alternatecontent')) {
      const fallback = compatibilityFallback(c);
      const fallbackRuns = fallback ? inlineRunsFrom(fallback) : [];
      let selected: PptxRun[] = [];
      for (const choice of compatibilityChoices(c)) {
        selected = inlineRunsFrom(choice);
        if (selected.some((run) => run.text || run.mathMl)) break;
      }
      if (selected.length) {
        // PowerPoint's fallback often carries the best linear, copyable form
        // of one OMML equation. Keep it for search while rendering MathML.
        const mathRuns = selected.filter((run) => run.mathMl);
        const fallbackText = fallbackRuns.map((run) => run.text).join('');
        if (mathRuns.length === 1 && fallbackText) {
          const mathRun = mathRuns[0];
          const fallbackRun = fallbackRuns.find((run) => run.text) || fallbackRuns[0];
          mathRun.text = fallbackText;
          if (fallbackRun) {
            if (mathRun.sizePt === undefined) mathRun.sizePt = fallbackRun.sizePt;
            if (mathRun.bold === undefined) mathRun.bold = fallbackRun.bold;
            if (mathRun.italic === undefined) mathRun.italic = fallbackRun.italic;
            if (mathRun.underline === undefined) mathRun.underline = fallbackRun.underline;
            if (mathRun.color === undefined) mathRun.color = fallbackRun.color;
          }
        }
        runs.push(...selected);
      } else {
        runs.push(...fallbackRuns);
      }
      continue;
    }
    if (
      inNamespace(c, DRAWING_2010_NS, 'm') ||
      isMathElement(c, 'omathpara') ||
      isMathElement(c, 'omath')
    ) {
      runs.push(...equationRuns(c));
      continue;
    }
    // mc:ProcessContent and vendor wrappers may legally sit around ordinary
    // DrawingML runs. Recursing is safe because text is always assigned via
    // textContent, never interpreted as HTML.
    runs.push(...inlineRunsFrom(c));
  }
  return runs;
}

function mathAlignment(container: Element): PptxAlign | undefined {
  let result: PptxAlign | undefined;
  const walk = (node: Element) => {
    if (result) return;
    if (isMathElement(node, 'jc')) {
      const value = localAttribute(node, 'val');
      if (value === 'left') result = 'left';
      else if (value === 'right') result = 'right';
      else if (value === 'center' || value === 'centerGroup') result = 'center';
      return;
    }
    for (const c of Array.from(node.children)) walk(c);
  };
  walk(container);
  return result;
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

  para.runs = inlineRunsFrom(p);
  if (!para.align && para.runs.some((run) => run.mathMl)) para.align = mathAlignment(p);
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

/**
 * JSZip returns embedded parts as untyped Blobs. Images generally sniff well,
 * but Chromium intentionally relies on a useful Content-Type for several
 * media codecs. Preserve the package bytes while giving blob: URLs the MIME
 * PowerPoint's media extension implies.
 */
function mediaExtension(path: string): string {
  return path.toLowerCase().split(/[?#]/, 1)[0].split('.').pop() || '';
}

function mediaMimeForPath(path: string): string {
  const extension = mediaExtension(path);
  const mimeByExtension: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', ogv: 'video/ogg', avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', oga: 'audio/ogg', ogg: 'audio/ogg',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    emf: 'image/emf', wmf: 'image/wmf',
  };
  return mimeByExtension[extension] || '';
}

let metafileModule: Promise<{ convertMetafileToSafeSvg: (value: ArrayBufferView) => Promise<Blob> }> | null = null;
async function convertMetafileBlob(bytes: Uint8Array): Promise<Blob | null> {
  try {
    // Keep the import non-literal so esbuild leaves it as a lazy sibling
    // module rather than adding the sizeable GDI parser to every PPTX load.
    const modulePath = './metafile.mjs';
    metafileModule ??= import(modulePath) as Promise<{ convertMetafileToSafeSvg: (value: ArrayBufferView) => Promise<Blob> }>;
    const converter = await metafileModule;
    return await converter.convertMetafileToSafeSvg(bytes);
  } catch {
    return null;
  }
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

function diagramPart(model: Element | null, drawing: Element | null, drawingPath?: string): DiagramPart {
  return { model, drawing, drawingPath, imagePaths: new Map(), imageUrls: new Map() };
}

async function loadSlideDiagrams(
  zip: JSZip,
  slideDoc: Document,
  slidePath: string,
  slideRels: Map<string, Rel>,
  loadRels: (partPath: string) => Promise<Map<string, Rel>>,
): Promise<Map<string, DiagramPart>> {
  const out = new Map<string, DiagramPart>();
  const slideDir = slidePath.slice(0, slidePath.lastIndexOf('/'));
  for (const relIds of descendantsByLocalName(slideDoc, 'relIds')) {
    const dmRid = localAttribute(relIds, 'dm');
    if (!dmRid || out.has(dmRid)) continue;
    const dmRel = slideRels.get(dmRid);
    if (!dmRel || !dmRel.type.endsWith('/diagramData')) {
      out.set(dmRid, diagramPart(null, null));
      continue;
    }
    const modelPath = resolveZipPath(slideDir, dmRel.target);
    const modelFile = zip.file(modelPath);
    if (!modelFile) {
      out.set(dmRid, diagramPart(null, null));
      continue;
    }
    try {
      const modelDoc = new DOMParser().parseFromString(await modelFile.async('text'), 'text/xml');
      const model = modelDoc.documentElement;
      const modelRels = await loadRels(modelPath);
      const drawingRef = descendantsByLocalName(modelDoc, 'dataModelExt')[0];
      const drawingRid = localAttribute(drawingRef, 'relId');
      let drawingRel = drawingRid ? modelRels.get(drawingRid) : undefined;
      let drawingDir = modelPath.slice(0, modelPath.lastIndexOf('/'));
      // Some producers scope the cached drawing relationship to the slide
      // rather than dataN.xml. Accept either OPC-valid convention.
      if (!drawingRel && drawingRid) {
        drawingRel = slideRels.get(drawingRid);
        drawingDir = slideDir;
      }
      if (!drawingRel) {
        drawingRel = Array.from(modelRels.values()).find((rel) => rel.type.endsWith('/diagramDrawing'));
      }
      if (!drawingRel) {
        drawingRel = Array.from(slideRels.values()).find((rel) => rel.type.endsWith('/diagramDrawing'));
        drawingDir = slideDir;
      }
      if (!drawingRel) {
        out.set(dmRid, diagramPart(model, null));
        continue;
      }
      const drawingPath = resolveZipPath(drawingDir, drawingRel.target);
      const drawingFile = zip.file(drawingPath);
      if (!drawingFile) {
        out.set(dmRid, diagramPart(model, null, drawingPath));
        continue;
      }
      const drawingDoc = new DOMParser().parseFromString(await drawingFile.async('text'), 'text/xml');
      const part = diagramPart(model, drawingDoc.documentElement, drawingPath);
      const drawingRels = await loadRels(drawingPath);
      const partDir = drawingPath.slice(0, drawingPath.lastIndexOf('/'));
      for (const [rid, rel] of drawingRels) {
        if (rel.type.endsWith('/image')) part.imagePaths.set(rid, resolveZipPath(partDir, rel.target));
      }
      out.set(dmRid, part);
    } catch {
      out.set(dmRid, diagramPart(null, null));
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
  /** Resolved placeholder identity after master → layout inheritance. */
  type: string;
  idx: string;
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
  if (phType === 'body' || phType === 'subTitle' || phType === 'obj') return master.body;
  return master.other;
}

function placeholderFromMap(
  placeholders: Map<string, PlaceholderInfo>,
  phType: string,
  phIdx: string,
): PlaceholderInfo | undefined {
  return (
    (phType ? placeholders.get(`${phType}#${phIdx}`) : undefined) ??
    placeholders.get(`#${phIdx}`) ??
    (phType ? placeholders.get(phType) : undefined)
  );
}

function registerPlaceholder(
  placeholders: Map<string, PlaceholderInfo>,
  info: PlaceholderInfo,
  preferType = false,
): void {
  placeholders.set(`${info.type}#${info.idx}`, info);
  placeholders.set(`#${info.idx}`, info);
  if (preferType || !placeholders.has(info.type)) placeholders.set(info.type, info);
}

/**
 * Placeholder shapes can themselves be compatibility wrapped. Select only one
 * branch so the fallback cannot overwrite the modern geometry.
 */
function effectiveShapeChildren(container: Element): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(container.children)) {
    if (inNamespace(el, MC_NS, 'alternatecontent')) {
      const branch = selectedCompatibilityBranch(el);
      if (branch) out.push(...effectiveShapeChildren(branch));
    } else if (inNamespace(el, PRESENTATION_NS, 'sp') || inNamespace(el, PRESENTATION_NS, 'pic') || inNamespace(el, PRESENTATION_NS, 'cxnsp') || inNamespace(el, PRESENTATION_NS, 'graphicframe')) {
      out.push(el);
    } else if (inNamespace(el, PRESENTATION_NS, 'grpsp')) {
      out.push(...effectiveShapeChildren(el));
    }
  }
  return out;
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

  // --- master: txStyles, placeholder geometry + background ---
  let masterStyles: LayoutInfo['masterStyles'] = { title: [], body: [], other: [] };
  let masterBg: Element | null = null;
  let masterRels = new Map<string, Rel>();
  let masterDoc: Document | null = null;
  const masterPlaceholders = new Map<string, PlaceholderInfo>();
  const masterRel = Array.from(layoutRels.values()).find((r) =>
    r.type.endsWith('/slideMaster'),
  );
  if (masterRel) {
    const masterPath = resolveZipPath('ppt/slideLayouts', masterRel.target);
    const masterFile = zip.file(masterPath);
    if (masterFile) {
      masterRels = await loadRelsFor(zip, masterPath);
      masterDoc = new DOMParser().parseFromString(await masterFile.async('text'), 'text/xml');
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

      const masterTree = mCsl?.getElementsByTagName('p:spTree')[0] || mCsl;
      if (masterTree) {
        const seenMasterTypes = new Set<string>();
        for (const sp of effectiveShapeChildren(masterTree)) {
          if (!inNamespace(sp, PRESENTATION_NS, 'sp')) continue;
          const ph = sp.getElementsByTagName('p:ph')[0];
          if (!ph) continue;
          const type = ph.getAttribute('type') || 'obj';
          const idx = ph.getAttribute('idx') || '0';
          const box = parseXfrm(child(sp, 'p:spPr'));
          const txBody = child(sp, 'p:txBody');
          const bodyPr = txBody ? child(txBody, 'a:bodyPr') : null;
          const info: PlaceholderInfo = {
            type,
            idx,
            levels: mergeLevels(
              parseLevels(txBody ? child(txBody, 'a:lstStyle') : null),
              masterLevelsFor(masterStyles, type),
            ),
          };
          if (box.w > 0 && box.h > 0) info.geom = { x: box.x, y: box.y, w: box.w, h: box.h };
          const anchor = bodyPr?.getAttribute('anchor') as PlaceholderInfo['anchor'] | undefined;
          if (anchor) info.anchor = anchor;
          registerPlaceholder(masterPlaceholders, info, !seenMasterTypes.has(type));
          seenMasterTypes.add(type);
        }
      }
    }
  }

  // --- layout placeholders, inheriting missing values from the master ---
  const placeholders = new Map<string, PlaceholderInfo>(masterPlaceholders);
  const seenLayoutTypes = new Set<string>();
  const spTree = layoutDoc.getElementsByTagName('p:spTree')[0] || layoutDoc.documentElement;
  for (const sp of effectiveShapeChildren(spTree)) {
    if (!inNamespace(sp, PRESENTATION_NS, 'sp')) continue;
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph) continue;
    const declaredType = ph.getAttribute('type') || '';
    const idx = ph.getAttribute('idx') || '0';
    const master = placeholderFromMap(masterPlaceholders, declaredType, idx);
    const type = declaredType || master?.type || 'obj';
    const box = parseXfrm(child(sp, 'p:spPr'));
    const txBody = child(sp, 'p:txBody');
    const bodyPr = txBody ? child(txBody, 'a:bodyPr') : null;
    const anchor = bodyPr?.getAttribute('anchor') as PlaceholderInfo['anchor'] | undefined;
    const levels = mergeLevels(
      parseLevels(txBody ? child(txBody, 'a:lstStyle') : null),
      master?.levels,
      masterLevelsFor(masterStyles, type),
    );
    const info: PlaceholderInfo = { type, idx, levels };
    if (box.w > 0 && box.h > 0) info.geom = { x: box.x, y: box.y, w: box.w, h: box.h };
    else if (master?.geom) info.geom = { ...master.geom };
    if (anchor) info.anchor = anchor;
    else if (master?.anchor) info.anchor = master.anchor;
    registerPlaceholder(placeholders, info, !seenLayoutTypes.has(type));
    seenLayoutTypes.add(type);
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
  return layout ? placeholderFromMap(layout.placeholders, phType, phIdx) : undefined;
}

/** Sensible defaults when no layout geometry exists (e.g. hand-built files). */
function defaultPhGeom(phType: string | undefined, sw: number, sh: number): LayoutGeom {
  if (phType === 'ctrTitle') return { x: sw * 0.1, y: sh * 0.32, w: sw * 0.8, h: sh * 0.22 };
  if (phType === 'title') return { x: sw * 0.06, y: sh * 0.07, w: sw * 0.88, h: sh * 0.22 };
  if (phType === 'subTitle') return { x: sw * 0.15, y: sh * 0.55, w: sw * 0.7, h: sh * 0.25 };
  if (phType === 'body' || phType === 'obj') return { x: sw * 0.1, y: sh * 0.34, w: sw * 0.8, h: sh * 0.56 };
  if (phType === 'sldNum') return { x: sw * 0.86, y: sh * 0.93, w: sw * 0.09, h: sh * 0.04 };
  if (phType === 'dt') return { x: sw * 0.05, y: sh * 0.93, w: sw * 0.18, h: sh * 0.04 };
  if (phType === 'ftr') return { x: sw * 0.28, y: sh * 0.93, w: sw * 0.44, h: sh * 0.04 };
  if (phType === 'hdr') return { x: sw * 0.05, y: sh * 0.02, w: sw * 0.9, h: sh * 0.05 };
  if (phType === 'pic' || phType === 'media' || phType === 'chart' || phType === 'tbl')
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

interface DiagramPart {
  model: Element | null;
  drawing: Element | null;
  drawingPath?: string;
  imagePaths: Map<string, string>;
  imageUrls: Map<string, string>;
}

interface ShapeCtx {
  t: T;
  imageUrls: Map<string, string>;
  /** Resolved OPC paths for image relationships in this shape part. */
  imagePaths: Map<string, string>;
  /** Resolved object URLs for embedded video/audio clips, keyed by relationship id. */
  videoUrls: Map<string, string>;
  /** SmartArt data + cached DrawingML, keyed by the graphic frame's r:dm id. */
  diagrams: Map<string, DiagramPart>;
  diagnostics: PptxDiagnostic[];
  layout: LayoutInfo | null;
  sw: number;
  sh: number;
  slideNumber: number;
  nextId: () => number;
  tableTexts: string[];
  imageList: string[];
  push: (s: PptxShape) => void;
}

/** Placeholder types that act as the slide title (incl. the title-slide one). */
export const isTitlePlaceholder = (phType: string): boolean => phType === 'title' || phType === 'ctrTitle';

/**
 * Modern PowerPoint often keeps an SVG fallback beside an older EMF/WMF
 * blip. Prefer the browser-native representation, but retain every package
 * relationship so an image decode failure can advance instead of leaving a
 * broken-image glyph on the slide.
 */
function imageRelationshipIds(blip: Element | null): string[] {
  if (!blip) return [];
  const preferred: string[] = [];
  const secondary: string[] = [];
  const add = (target: string[], value: string | null) => {
    if (value && !preferred.includes(value) && !secondary.includes(value)) target.push(value);
  };
  for (const descendant of Array.from(blip.getElementsByTagName('*'))) {
    const tag = localTag(descendant);
    if (tag === 'svgblip') add(preferred, localAttribute(descendant, 'embed') || localAttribute(descendant, 'link'));
    else if (tag === 'imglayer') add(secondary, localAttribute(descendant, 'embed') || localAttribute(descendant, 'link'));
  }
  add(secondary, localAttribute(blip, 'embed') || localAttribute(blip, 'link'));
  return [...preferred, ...secondary];
}

function resolvedImageUrls(ids: string[], urls: Map<string, string>): string[] {
  return ids.map((id) => urls.get(id)).filter((url): url is string => Boolean(url));
}

function defaultSizePtFor(phType: string, isTitle: boolean): number {
  if (phType === 'ctrTitle') return 44;
  if (isTitle) return 32;
  if (phType === 'subTitle') return 28;
  if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr' || phType === 'hdr') return 10;
  return 18;
}

function parseSp(sp: Element, ctx: ShapeCtx): PptxShape | null {
  const diagramShape = inNamespace(sp, DIAGRAM_DRAWING_NS);
  const presentationChild = (tag: string): Element | null =>
    child(sp, `p:${tag}`) || (diagramShape ? childByLocalName(sp, tag) : null);
  const spPr = presentationChild('spPr');
  const ph = sp.getElementsByTagName('p:ph')[0];
  const declaredPhType = ph?.getAttribute('type') || '';
  const phIdx = ph?.getAttribute('idx') || '0';
  const placeholder = ph ? placeholderFor(ctx.layout, declaredPhType, phIdx) : undefined;
  const phType = declaredPhType || placeholder?.type || (ph ? 'obj' : '');
  const isTitle = isTitlePlaceholder(phType);

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
  let text = parseText(presentationChild('txBody'), defaultSizePtFor(phType, isTitle), inheritedLevels);
  if (text && !text.anchor && placeholder?.anchor) text.anchor = placeholder.anchor;
  const hasTextContent = () => Boolean(text?.paragraphs.some((paragraph) =>
    paragraph.runs.some((run) => run.text || run.mathMl),
  ));
  // Some producers leave the cached a:fld value empty. A slide-number field
  // still has deterministic local meaning and must remain visible.
  if (phType === 'sldNum' && !hasTextContent()) {
    text = {
      paragraphs: [{ runs: [{ text: String(ctx.slideNumber) }], level: 0 }],
      anchor: placeholder?.anchor,
      fontScale: 1,
      defaultSizePt: defaultSizePtFor(phType, false),
      levels: inheritedLevels,
    };
  }

  // Compatibility fallbacks sometimes put a raster preview in a normal p:sp
  // rather than p:pic. Preserve that preview if the modern branch is unknown.
  const shapeBlipFill = spPr ? child(spPr, 'a:blipFill') : null;
  const shapeBlip = shapeBlipFill ? child(shapeBlipFill, 'a:blip') : null;
  const imageRids = imageRelationshipIds(shapeBlip);
  const imageUrls = resolvedImageUrls(imageRids, ctx.imageUrls);
  const imagePaths = imageRids.map((rid) => ctx.imagePaths.get(rid)).filter((path): path is string => Boolean(path));
  const imageRid = imageRids[0];
  const imageUrl = imageUrls[0];
  if (imageUrl && !hasTextContent()) ctx.imageList.push(imageUrl);

  const shape: PptxShape = {
    id: ctx.nextId(),
    type: imageRid && !hasTextContent() ? 'image' : 'text',
    x: b.x,
    y: b.y,
    w: Math.max(b.w, 0),
    h: Math.max(b.h, 0),
    rot: b.rot,
    geom: prst || (text ? 'rect' : undefined),
    fill,
    imageUrl: imageRid && !hasTextContent() ? imageUrl : undefined,
    imageUrls: imageRid && !hasTextContent() && imageUrls.length ? imageUrls : undefined,
    imageRid: imageRid && !hasTextContent() ? imageRid : undefined,
    imageRids: imageRid && !hasTextContent() ? imageRids : undefined,
    imagePaths: imageRid && !hasTextContent() && imagePaths.length ? imagePaths : undefined,
    textScale: (ctx.t.sx + ctx.t.sy) / 2,
    isTitle,
    placeholderType: ph ? phType : undefined,
  };
  if (lineColor) {
    shape.borderColor = lineColor;
    shape.borderWidth = Math.max(1, lineW || 1);
  }
  if (text && hasTextContent()) shape.text = text;
  if (!shape.text && !shape.fill && !shape.imageRid) return null; // empty, invisible placeholder
  return shape;
}

function parsePic(pic: Element, ctx: ShapeCtx): PptxShape {
  const diagramShape = inNamespace(pic, DIAGRAM_DRAWING_NS);
  const presentationChild = (tag: string): Element | null =>
    child(pic, `p:${tag}`) || (diagramShape ? childByLocalName(pic, tag) : null);
  const spPr = presentationChild('spPr');
  const box = applyT(ctx.t, parseXfrm(spPr));
  const blipFill = presentationChild('blipFill');
  const blip = blipFill ? child(blipFill, 'a:blip') : null;
  // Most pictures are embedded (r:embed); pasted-as-link producers use
  // r:link, while newer Office versions can include an asvg:svgBlip beside
  // an older EMF/WMF source. Keep all local alternatives in decode order.
  const imageRids = imageRelationshipIds(blip);
  const imageUrls = resolvedImageUrls(imageRids, ctx.imageUrls);
  const imagePaths = imageRids.map((imageRid) => ctx.imagePaths.get(imageRid)).filter((path): path is string => Boolean(path));
  const rid = imageRids[0];
  const url = imageUrls[0];
  if (url) ctx.imageList.push(url);

  // Video (and audio) placeholders: PowerPoint keeps the poster frame as the
  // ordinary blipFill picture above, and points at the actual clip via the
  // legacy <a:videoFile r:link="…"/> (used even for clips embedded inside
  // the package, not just truly linked ones) or the newer PowerPoint-2010+
  // <p14:media r:embed="…"/> extension.
  const videoEl = pic.getElementsByTagName('a:videoFile')[0] ?? pic.getElementsByTagName('p14:media')[0];
  const videoRid = videoEl?.getAttribute('r:link') || videoEl?.getAttribute('r:embed') || undefined;
  const videoUrl = videoRid ? ctx.videoUrls.get(videoRid) : undefined;

  const shape: PptxShape = {
    id: ctx.nextId(),
    type: videoRid ? 'video' : 'image',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 0),
    h: Math.max(box.h, 0),
    rot: box.rot,
    geom: child(spPr, 'a:prstGeom')?.getAttribute('prst') || 'rect',
    imageUrl: url,
    imageUrls: imageUrls.length ? imageUrls : undefined,
    imageRid: rid || undefined,
    imageRids: imageRids.length ? imageRids : undefined,
    imagePaths: imagePaths.length ? imagePaths : undefined,
    videoUrl,
    videoRid,
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
  const spPr = child(cxn, 'p:spPr')
    || (inNamespace(cxn, DIAGRAM_DRAWING_NS) ? childByLocalName(cxn, 'spPr') : null);
  const box = applyT(ctx.t, parseXfrm(spPr));
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

function diagramModelTexts(model: Element | null): string[] {
  if (!model) return [];
  const values: string[] = [];
  for (const point of descendantsByLocalName(model, 'pt')) {
    const text = descendantsByLocalName(point, 't')
      .filter((node) => inNamespace(node, DRAWING_NS, 't'))
      .map((node) => node.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && !values.includes(text)) values.push(text);
  }
  return values.slice(0, 64);
}

function nativeDiagramFallback(gf: Element, model: Element | null, ctx: ShapeCtx): PptxShape[] {
  const frame = applyT(ctx.t, parseXfrm(gf));
  const labels = diagramModelTexts(model);
  const effective = labels.length ? labels : ['SmartArt diagram unavailable'];
  const columns = Math.max(1, Math.ceil(Math.sqrt(effective.length)));
  const rows = Math.max(1, Math.ceil(effective.length / columns));
  const gap = Math.max(4, Math.min(12, Math.min(frame.w, frame.h) * 0.03));
  const nodeWidth = Math.max(1, (frame.w - gap * (columns - 1)) / columns);
  const nodeHeight = Math.max(1, (frame.h - gap * (rows - 1)) / rows);
  return effective.map((label, index) => ({
    id: ctx.nextId(),
    type: 'text',
    x: frame.x + (index % columns) * (nodeWidth + gap),
    y: frame.y + Math.floor(index / columns) * (nodeHeight + gap),
    w: nodeWidth,
    h: nodeHeight,
    rot: frame.rot,
    geom: 'roundRect',
    fill: labels.length ? '#4472c4' : '#e2e8f0',
    borderColor: labels.length ? '#2f5597' : '#94a3b8',
    borderWidth: 1,
    text: {
      paragraphs: [{ runs: [{ text: label, color: labels.length ? '#ffffff' : '#334155' }], level: 0, align: 'center' }],
      anchor: 'ctr',
      fontScale: 1,
      defaultSizePt: Math.max(8, Math.min(18, nodeHeight / 5)),
      levels: [],
    },
    textScale: (ctx.t.sx + ctx.t.sy) / 2,
    isTitle: false,
  } as PptxShape));
}

function parseDiagramFrame(gf: Element, ctx: ShapeCtx): PptxShape[] {
  const graphicData = gf.getElementsByTagName('a:graphicData')[0]
    || descendantsByLocalName(gf, 'graphicData')[0];
  const relIds = graphicData && descendantsByLocalName(graphicData, 'relIds')[0];
  const dmRid = localAttribute(relIds || null, 'dm');
  const part = dmRid ? ctx.diagrams.get(dmRid) : undefined;
  const drawingTree = part?.drawing && descendantsByLocalName(part.drawing, 'spTree')[0];
  if (drawingTree) {
    const rawFrame = parseXfrm(gf);
    const frame = applyT(ctx.t, rawFrame);
    const localT: T = {
      sx: rawFrame.w > 0 ? frame.w / rawFrame.w : ctx.t.sx,
      sy: rawFrame.h > 0 ? frame.h / rawFrame.h : ctx.t.sy,
      dx: frame.x,
      dy: frame.y,
    };
    const parsed: PptxShape[] = [];
    const drawingCtx: ShapeCtx = {
      ...ctx,
      t: localT,
      imagePaths: part?.imagePaths || new Map(),
      imageUrls: part?.imageUrls || new Map(),
      push: (shape) => parsed.push(shape),
    };
    for (const node of Array.from(drawingTree.children)) parseShapeNode(node, drawingCtx);
    if (parsed.length) return parsed;
  }

  const code = part?.model ? 'pptx/smartart-native-fallback' : 'pptx/smartart-unresolved';
  const message = part?.model
    ? `Slide ${ctx.slideNumber}: SmartArt cached drawing is missing; using a simplified local layout.`
    : `Slide ${ctx.slideNumber}: SmartArt relationships could not be resolved.`;
  if (!ctx.diagnostics.some((item) => item.code === code && item.message === message)) {
    ctx.diagnostics.push({ code, severity: part?.model ? 'warning' : 'error', message });
  }
  return nativeDiagramFallback(gf, part?.model || null, ctx);
}

function parseGraphicFrame(gf: Element, ctx: ShapeCtx): PptxShape | PptxShape[] | null {
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
  if (uri.includes('/diagram') || (graphicData && descendantsByLocalName(graphicData, 'relIds').length)) {
    return parseDiagramFrame(gf, ctx);
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
  // Historical Equation Editor/OLE objects carry a safe static preview as a
  // nested p:pic. Never execute the object; render only that package image.
  const previewPic = gf.getElementsByTagName('p:pic')[0];
  if (previewPic) {
    const preview = parsePic(previewPic, ctx);
    if (preview.w <= 0 || preview.h <= 0) {
      const box = applyT(ctx.t, parseXfrm(gf));
      preview.x = box.x;
      preview.y = box.y;
      preview.w = Math.max(box.w, 0);
      preview.h = Math.max(box.h, 0);
      preview.rot = box.rot;
    }
    return preview;
  }
  return null; // Unknown graphic frames remain explicit diagnostics candidates.
}

function parseShapeNode(node: Element, ctx: ShapeCtx): number {
  if (inNamespace(node, MC_NS, 'alternatecontent')) {
    // Prefer the first supported modern representation that yields a visible
    // shape. If it is malformed or still unknown, honour the fallback.
    for (const choice of compatibilityChoices(node)) {
      let parsed = 0;
      for (const c of Array.from(choice.children)) parsed += parseShapeNode(c, ctx);
      if (parsed) return parsed;
    }
    const fallback = compatibilityFallback(node);
    if (!fallback) return 0;
    let parsed = 0;
    for (const c of Array.from(fallback.children)) parsed += parseShapeNode(c, ctx);
    return parsed;
  }
  const drawingShape = node.namespaceURI === PRESENTATION_NS || node.namespaceURI === DIAGRAM_DRAWING_NS;
  const tag = localTag(node);
  if (drawingShape && tag === 'sp') {
    const shape = parseSp(node, ctx);
    if (!shape) return 0;
    ctx.push(shape);
    return 1;
  }
  if (drawingShape && tag === 'pic') {
    ctx.push(parsePic(node, ctx));
    return 1;
  }
  if (drawingShape && tag === 'cxnsp') {
    ctx.push(parseCxnSp(node, ctx));
    return 1;
  }
  if (inNamespace(node, PRESENTATION_NS, 'graphicframe')) {
    const shape = parseGraphicFrame(node, ctx);
    if (!shape) {
      const code = 'pptx/graphic-frame-unsupported';
      if (!ctx.diagnostics.some((item) => item.code === code)) {
        ctx.diagnostics.push({
          code,
          severity: 'warning',
          message: `Slide ${ctx.slideNumber}: a graphic frame could not be rendered locally.`,
        });
      }
      return 0;
    }
    if (Array.isArray(shape)) {
      shape.forEach(ctx.push);
      return shape.length;
    }
    ctx.push(shape);
    return 1;
  }
  if (drawingShape && tag === 'grpsp') return parseGroup(node, ctx);
  return 0;
}

function parseGroup(grp: Element, ctx: ShapeCtx): number {
  const groupProperties = child(grp, 'p:grpSpPr')
    || (inNamespace(grp, DIAGRAM_DRAWING_NS) ? childByLocalName(grp, 'grpSpPr') : null);
  const xfrm = child(groupProperties, 'a:xfrm');
  let t = ctx.t;
  if (xfrm) {
    const num = (el: Element | null, attr: string) => {
      const v = el?.getAttribute(attr);
      return v ? emuToPx(parseInt(v, 10)) : 0;
    };
    const off = child(xfrm, 'a:off');
    const ext = child(xfrm, 'a:ext');
    const chOff = child(xfrm, 'a:chOff');
    const chExt = child(xfrm, 'a:chExt');
    t = composeGroup(
      ctx.t,
      { x: num(off, 'x'), y: num(off, 'y'), w: 0, h: 0, rot: 0 },
      { x: 0, y: 0, w: num(ext, 'cx'), h: num(ext, 'cy'), rot: 0 },
      { x: num(chOff, 'x'), y: num(chOff, 'y'), w: 0, h: 0, rot: 0 },
      { x: 0, y: 0, w: num(chExt, 'cx'), h: num(chExt, 'cy'), rot: 0 },
    );
  }
  // Identity groups are valid in files emitted by several non-Microsoft
  // producers. Missing a:xfrm must not make every child disappear.
  const groupCtx: ShapeCtx = { ...ctx, t };
  let parsed = 0;
  for (const c of Array.from(grp.children)) parsed += parseShapeNode(c, groupCtx);
  return parsed;
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
  /** Decodes one slide's local media; previews may defer heavyweight clips. */
  ensureSlideMedia: (slideNumber: number, options?: PptxMediaOptions) => Promise<void>;
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
  /** Slides whose backgrounds, pictures and video posters are ready. */
  const loadedPreviewMedia = new Set<number>();
  /** Slides whose preview media and embedded video/audio clips are all ready. */
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
      const extension = mediaExtension(path);
      let typedBlob: Blob;
      if (extension === 'emf' || extension === 'wmf') {
        const source = await media.async('uint8array');
        // Browsers do not decode Windows metafiles. Convert the package part
        // locally to bounded SVG; keep a typed raw Blob only as a last-resort
        // source so the DOM renderer can retire it cleanly on decode failure.
        typedBlob = (await convertMetafileBlob(source))
          || new Blob([source], { type: mediaMimeForPath(path) });
      } else {
        const rawBlob = await media.async('blob');
        const mime = mediaMimeForPath(path);
        // Blob#slice changes metadata without copying the underlying bytes.
        typedBlob = mime && rawBlob.type !== mime
          ? rawBlob.slice(0, rawBlob.size, mime)
          : rawBlob;
      }
      const url = URL.createObjectURL(typedBlob);
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
    const diagrams = await loadSlideDiagrams(zip, doc, slidePath, rels, loadRelsCached);

    // Embedded images. Eager parses decode every picture of the slide now
    // (callers that omit lazyMedia — and the unit tests — still get URLs
    // immediately). Lazy decks retain resolved package paths so media from a
    // cached SmartArt drawing's own relationship part can load too.
    const imageUrls = new Map<string, string>();
    const imagePaths = new Map<string, string>();
    const videoUrls = new Map<string, string>();
    for (const [rid, rel] of rels) {
      if (rel.type.endsWith('/image')) imagePaths.set(rid, resolveZipPath('ppt/slides', rel.target));
    }
    if (!lazyMedia) {
      for (const [rid, rel] of rels) {
        const isImage = rel.type.endsWith('/image');
        const isClip = rel.type.endsWith('/video') || rel.type.endsWith('/audio') || rel.type.endsWith('/media');
        if (!isImage && !isClip) continue;
        const path = resolveZipPath('ppt/slides', rel.target);
        const media = zip.file(path);
        if (!media) continue;
        try {
          const url = await urlFor(path, i + 1);
          if (url) {
            (isImage ? imageUrls : videoUrls).set(rid, url);
            const list = slideLoadedPaths.get(i + 1) ?? [];
            if (!list.includes(path)) { list.push(path); slideLoadedPaths.set(i + 1, list); }
          }
        } catch {
          /* unreadable media — skip */
        }
      }
      for (const part of diagrams.values()) {
        for (const [rid, path] of part.imagePaths) {
          const url = await urlFor(path, i + 1);
          if (!url) continue;
          part.imageUrls.set(rid, url);
          const list = slideLoadedPaths.get(i + 1) ?? [];
          if (!list.includes(path)) { list.push(path); slideLoadedPaths.set(i + 1, list); }
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
    const diagnostics: PptxDiagnostic[] = [];
    const ctx: ShapeCtx = {
      t: IDENTITY,
      imageUrls,
      imagePaths,
      videoUrls,
      diagrams,
      diagnostics,
      layout,
      sw: slideWidth,
      sh: slideHeight,
      slideNumber: i + 1,
      nextId: () => ++nextId,
      tableTexts,
      imageList,
      push: (s: PptxShape) => shapes.push(s),
    };

    for (const c of Array.from(spTree.children)) parseShapeNode(c, ctx);

    /* --- Legacy flat-text fields, now including OMML equations --- */
    let title = '';
    const body: string[] = [];
    const nonBodyPlaceholders = new Set(['sldNum', 'dt', 'ftr', 'hdr']);
    for (const shape of shapes) {
      if (!shape.text) continue;
      const paraTexts = shape.text.paragraphs
        .map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
        .filter((value) => value.trim());
      if (shape.isTitle) {
        if (!title) title = paraTexts.join(' ');
      } else if (!shape.placeholderType || !nonBodyPlaceholders.has(shape.placeholderType)) {
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

    for (const shape of shapes) {
      if (shape.type !== 'image' && shape.type !== 'video') continue;
      const paths = shape.imagePaths || [];
      const hasPackagedSource = paths.some((path) => Boolean(zip.file(path)))
        || (shape.imageRids || []).some((rid) => {
          const rel = rels.get(rid);
          return Boolean(rel?.type.endsWith('/image') && zip.file(resolveZipPath('ppt/slides', rel.target)));
        });
      if (!hasPackagedSource && !diagnostics.some((item) => item.code === 'pptx/image-relationship-unresolved')) {
        diagnostics.push({
          code: 'pptx/image-relationship-unresolved',
          severity: 'error',
          message: `Slide ${i + 1}: an image relationship has no readable package part.`,
        });
      }
    }
    if (!shapes.length && !backgroundImageUrl && !background) {
      diagnostics.push({
        code: 'pptx/unexplained-blank-slide',
        severity: 'warning',
        message: `Slide ${i + 1} contains no renderable shapes or background.`,
      });
    }

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
      diagnostics: diagnostics.length ? diagnostics : undefined,
    };
  };

  /* ---- bounded slide cache ---- */

  const parsedSlides = new Map<number, PptxSlide>(); // insertion order = LRU order
  const slideInflight = new Map<number, Promise<PptxSlide | null>>();
  /** Set by parseAllSlides: eager decks keep every slide cached (see below). */
  let allParsed = false;

  const revokeSlideMedia = (n: number) => {
    // A later visit reparses the slide and must be allowed to rematerialise
    // every URL that is revoked below. Keeping this flag used to make media
    // disappear after a sufficiently long deck evicted then revisited it.
    loadedPreviewMedia.delete(n);
    loadedMedia.delete(n);
    inflight.delete(n);
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

  const ensureSlideMedia = (slideNumber: number, options: PptxMediaOptions = {}): Promise<void> => {
    const includeClips = options.includeClips !== false;
    if (!alive || (includeClips ? loadedMedia.has(slideNumber) : loadedPreviewMedia.has(slideNumber))) {
      return Promise.resolve();
    }
    const pending = inflight.get(slideNumber);
    if (pending) {
      // Serialize each slide. A full request arriving during a lightweight
      // thumbnail decode continues afterwards and adds the deferred clip.
      return pending.then(() => ensureSlideMedia(slideNumber, options));
    }
    const run = (async () => {
      const job = jobs.get(slideNumber);
      const slide = parsedSlides.get(slideNumber);
      if (!job || !slide) {
        loadedPreviewMedia.add(slideNumber);
        if (includeClips) loadedMedia.add(slideNumber);
        return;
      }
      const note = (path?: string) => {
        if (!path) return;
        const list = slideLoadedPaths.get(slideNumber) ?? [];
        if (!list.includes(path)) { list.push(path); slideLoadedPaths.set(slideNumber, list); }
      };

      if (!loadedPreviewMedia.has(slideNumber)) {
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
        // Posters are ordinary image relationships and remain cheap enough for
        // a static thumbnail. The potentially very large clip stays deferred.
        for (const shape of slide.shapes) {
          const imageRids = shape.imageRids?.length
            ? shape.imageRids
            : (shape.imageRid ? [shape.imageRid] : []);
          const paths = shape.imagePaths?.length
            ? shape.imagePaths
            : imageRids.map((rid) => {
                const rel = job.rels.get(rid);
                return rel?.type.endsWith('/image') ? resolveZipPath('ppt/slides', rel.target) : '';
              }).filter(Boolean);
          if (!paths.length || (shape.imageUrl && shape.imageUrls?.length === paths.length)) continue;
          const urls: string[] = [];
          for (const path of paths) {
            // External relationships are deliberately never fetched. A local
            // alternate can still render if one exists later in the list.
            const url = await urlFor(path, slideNumber);
            if (!url) continue;
            note(path);
            if (!urls.includes(url)) urls.push(url);
          }
          if (!urls.length) continue;
          shape.imageUrls = urls;
          shape.imageUrl = urls[0];
          for (const url of urls) if (!slide.images.includes(url)) slide.images.push(url);
        }
        loadedPreviewMedia.add(slideNumber);
      }

      if (includeClips) {
        for (const shape of slide.shapes) {
          if (!shape.videoRid || shape.videoUrl) continue;
          const videoRel = job.rels.get(shape.videoRid);
          if (
            videoRel &&
            (videoRel.type.endsWith('/video') || videoRel.type.endsWith('/audio') || videoRel.type.endsWith('/media'))
          ) {
            const videoPath = resolveZipPath('ppt/slides', videoRel.target);
            const videoUrl = await urlFor(videoPath, slideNumber);
            if (videoUrl) {
              note(videoPath);
              shape.videoUrl = videoUrl;
            }
          }
        }
        loadedMedia.add(slideNumber);
      }
    })().finally(() => {
      // Completed and failed jobs both leave the map retryable. A full request
      // waiting on a preview starts its continuation after this cleanup.
      inflight.delete(slideNumber);
    });
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
      if (!lazyMedia) slides.forEach((s) => {
        loadedPreviewMedia.add(s.slideNumber);
        loadedMedia.add(s.slideNumber);
      });
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
      let slideDoc: Document | null = null;
      try {
        slideDoc = new DOMParser().parseFromString(content, 'text/xml');
        const lines: string[] = [];
        walkEffectiveElements(slideDoc.documentElement, (element) => {
          if (!inNamespace(element, DRAWING_NS, 'p')) return;
          const line = parseParagraph(element, { n: 0 }).runs.map((run) => run.text).join('');
          if (line.trim()) lines.push(line);
        });
        text = lines.join('\n');
      } catch {
        /* unreadable slide — skip */
      }
      // SmartArt text lives in the cached diagram/data parts, not slide.xml.
      // Include it without forcing the full visual parse so find-in-deck stays
      // lightweight and deterministic.
      const rels = await loadRelsCached(slidePath);
      if (slideDoc) {
        try {
          const diagrams = await loadSlideDiagrams(zip, slideDoc, slidePath, rels, loadRelsCached);
          const diagramLines: string[] = [];
          for (const part of diagrams.values()) {
            const values = part.drawing
              ? descendantsByLocalName(part.drawing, 't').map((node) => (node.textContent || '').trim()).filter(Boolean)
              : diagramModelTexts(part.model);
            for (const value of values) if (!diagramLines.includes(value)) diagramLines.push(value);
          }
          if (diagramLines.length) text = [text, ...diagramLines].filter(Boolean).join('\n');
        } catch {
          /* unreadable diagram — visual parse reports a fidelity diagnostic */
        }
      }

      // Speaker notes join the searchable text, matching the visual parse.
      let notes = '';
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
    loadedPreviewMedia.clear();
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
