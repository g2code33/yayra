/**
 * TRUE PWA INSTALL ("Install page as app...") - the pure parts.
 *
 * The user requirement: installing a site must install a PWA OF THAT SITE
 * to the user's desktop - the site's OWN name, OWN icon and OWN start
 * url - exactly like Chrome's "Install page as app", not a shortcut
 * stamped with the browser's identity.
 *
 * A real PWA declares itself through a Web App Manifest
 * (https://www.w3.org/TR/appmanifest/) linked from its HTML. This module
 * holds everything pure and unit-testable about reading that identity:
 *   - extractManifestLink(): find <link rel="manifest"> in the page HTML
 *   - parseManifest(): safe JSON parse
 *   - pickManifestIcon(): choose the best launcher icon (largest usable
 *     raster image; SVG/monochrome excluded - they cannot be written to
 *     an .lnk/.desktop icon without a rasterizer)
 *   - resolveStartUrl(): the manifest's start_url resolved per spec
 *   - pickInstallIdentity(): name + startUrl + icon + display/theme
 *     colors, with honest fallbacks for non-PWA sites
 *   - pngToIco(): wrap a PNG in an ICO container (Windows .lnk icons
 *     need .ico; Vista+ accepts PNG payloads inside ICO entries)
 *
 * electron/main.cjs does the network fetching and file writing.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** Magic-byte checks: the icon pipeline must never trust Content-Type. */
function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isIcoBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 22
    && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00;
}

/** Return the largest modern PNG-backed entry from an ICO container. */
function extractPngFromIco(buf) {
  if (!isIcoBuffer(buf)) return null;
  try {
    const count = buf.readUInt16LE(4);
    if (count <= 0 || count > 128 || 6 + (count * 16) > buf.length) return null;
    let best = null;
    let bestArea = -1;
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + (index * 16);
      const width = buf[entry] || 256;
      const height = buf[entry + 1] || 256;
      const length = buf.readUInt32LE(entry + 8);
      const offset = buf.readUInt32LE(entry + 12);
      if (length <= 24 || offset > buf.length || length > buf.length - offset) continue;
      const payload = buf.subarray(offset, offset + length);
      if (!isPngBuffer(payload) || width * height <= bestArea) continue;
      best = Buffer.from(payload);
      bestArea = width * height;
    }
    return best;
  } catch {
    return null;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const kind = Buffer.from(type, 'ascii');
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  kind.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(pngCrc32(Buffer.concat([kind, payload])), 8 + payload.length);
  return result;
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  if (s === 0) {
    const channel = Math.round(l * 255);
    return [channel, channel, channel];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - (l * s);
  const p = (2 * l) - q;
  const channel = (offset) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    let value = p;
    if (t < 1 / 6) value = p + ((q - p) * 6 * t);
    else if (t < 1 / 2) value = q;
    else if (t < 2 / 3) value = p + ((q - p) * (2 / 3 - t) * 6);
    return Math.round(value * 255);
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

/**
 * Create a deterministic, neutral identicon for an iconless site. The pixels
 * depend only on the normalized site origin, so two sites never inherit the
 * Yayra mark and the same site keeps a stable launcher identity. This is a
 * deliberately tiny PNG encoder (RGBA + zlib) rather than a font or packaged
 * browser asset that could accidentally reintroduce Yayra branding.
 */
function generateSiteIdentityPng(siteUrl, size = 256) {
  let identity;
  try {
    const parsed = new URL(String(siteUrl || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    identity = parsed.origin.toLowerCase();
  } catch {
    return null;
  }
  const dimension = Math.round(Math.max(64, Math.min(512, Number(size) || 256)));
  const digest = crypto.createHash('sha256').update(identity).digest();
  const hue = ((digest[0] << 8) | digest[1]) % 360;
  const background = hslToRgb(hue, 50 + (digest[2] % 20), 30 + (digest[3] % 12));
  const foreground = hslToRgb(hue + 155 + (digest[4] % 50), 62, 82);
  const accent = hslToRgb(hue + 35, 70, 62);
  const stride = 1 + (dimension * 4);
  const raw = Buffer.alloc(stride * dimension);
  const radius = Math.round(dimension * 0.18);
  const margin = Math.round(dimension * 0.18);
  const gap = Math.max(2, Math.round(dimension * 0.018));
  const cell = Math.floor((dimension - (margin * 2) - (gap * 4)) / 5);
  const gridWidth = (cell * 5) + (gap * 4);
  const gridLeft = Math.floor((dimension - gridWidth) / 2);
  const gridTop = gridLeft;

  for (let y = 0; y < dimension; y += 1) {
    const row = y * stride;
    raw[row] = 0; // PNG filter: none
    for (let x = 0; x < dimension; x += 1) {
      const cornerX = x < radius ? radius - x : (x >= dimension - radius ? x - (dimension - radius - 1) : 0);
      const cornerY = y < radius ? radius - y : (y >= dimension - radius ? y - (dimension - radius - 1) : 0);
      const outsideRoundedCorner = cornerX > 0 && cornerY > 0 && ((cornerX * cornerX) + (cornerY * cornerY) > radius * radius);
      const pixel = row + 1 + (x * 4);
      if (outsideRoundedCorner) {
        raw[pixel + 3] = 0;
        continue;
      }
      const shade = Math.round(((x + y) / (dimension * 2)) * 18) - 5;
      raw[pixel] = Math.max(0, Math.min(255, background[0] + shade));
      raw[pixel + 1] = Math.max(0, Math.min(255, background[1] + shade));
      raw[pixel + 2] = Math.max(0, Math.min(255, background[2] + shade));
      raw[pixel + 3] = 255;
    }
  }

  // A mirrored 5x5 hash grid reads as an identicon, not as Yayra artwork.
  for (let rowIndex = 0; rowIndex < 5; rowIndex += 1) {
    for (let sourceColumn = 0; sourceColumn < 3; sourceColumn += 1) {
      const digestIndex = 5 + (rowIndex * 3) + sourceColumn;
      if ((digest[digestIndex] & 1) === 0) continue;
      const columns = sourceColumn === 2 ? [2] : [sourceColumn, 4 - sourceColumn];
      for (const columnIndex of columns) {
        const left = gridLeft + (columnIndex * (cell + gap));
        const top = gridTop + (rowIndex * (cell + gap));
        const color = ((digest[digestIndex] >>> 1) & 1) === 1 ? accent : foreground;
        for (let y = top; y < top + cell; y += 1) {
          const scanline = y * stride;
          for (let x = left; x < left + cell; x += 1) {
            const pixel = scanline + 1 + (x * 4);
            raw[pixel] = color[0];
            raw[pixel + 1] = color[1];
            raw[pixel + 2] = color[2];
            raw[pixel + 3] = 255;
          }
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dimension, 0);
  ihdr.writeUInt32BE(dimension, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND')
  ]);
}

/**
 * Find the Web App Manifest url in a page's HTML. Handles attribute
 * order both ways, single/double quotes, extra attributes (crossorigin,
 * media) and relative hrefs (resolved against the page url). Returns an
 * absolute https URL or null.
 */
function extractManifestLink(html, pageUrl) {
  try {
    const text = String(html || '').slice(0, 512 * 1024); // cap: head only matters
    const linkTags = text.match(/<link\b[^>]*>/gi) || [];
    for (const tag of linkTags) {
      const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
      const relValue = rel ? String(rel[2] || rel[3] || rel[4] || '').toLowerCase().trim() : '';
      if (relValue !== 'manifest') continue;
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
      const hrefValue = href ? String(href[2] || href[3] || href[4] || '') : '';
      if (!hrefValue) continue;
      try {
        const abs = new URL(hrefValue, pageUrl);
        if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
        return abs.toString();
      } catch { /* unresolvable href - try the next tag */ }
    }
    return null;
  } catch {
    return null;
  }
}

/** Safe JSON parse of the manifest body; any garbage -> null. */
function parseManifest(jsonText) {
  try {
    const data = JSON.parse(String(jsonText));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Pick the best launcher icon from the manifest's icons array. Scoring:
 *   - raster only (PNG preferred; bare src with no type is given the
 *     benefit of the doubt; SVG and monochrome icons are skipped - they
 *     cannot become an .lnk/.desktop icon without a rasterizer)
 *   - bigger wins; purpose 'maskable' counts (launchers crop it safely);
 *     'monochrome' never does
 * Returns { src, width, height } with an ABSOLUTE url, or null.
 */
function rankedManifestIcons(manifest, manifestUrl) {
  try {
    const icons = manifest && Array.isArray(manifest.icons) ? manifest.icons : [];
    const ranked = [];
    for (let index = 0; index < icons.length; index += 1) {
      const icon = icons[index];
      if (!icon || typeof icon.src !== 'string' || icon.src === '') continue;
      const type = String(icon.type || '').toLowerCase().trim();
      if (type === 'svg' || type === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(icon.src)) continue;
      const supportedTypes = new Set([
        'png', 'jpg', 'jpeg', 'webp', 'ico', 'image/png', 'image/jpeg', 'image/jpg',
        'image/webp', 'image/vnd.microsoft.icon', 'image/x-icon', 'image/bmp',
        'image/gif', 'image/avif'
      ]);
      if (type && !supportedTypes.has(type)) continue;
      const purpose = String(icon.purpose || 'any').toLowerCase().split(/\s+/);
      if (purpose.includes('monochrome') && !purpose.includes('any') && !purpose.includes('maskable')) continue;
      let width = 0;
      let height = 0;
      const sizes = String(icon.sizes || '').trim().toLowerCase();
      for (const match of sizes.matchAll(/(\d+)\s*x\s*(\d+)/g)) {
        const candidateWidth = Number(match[1]);
        const candidateHeight = Number(match[2]);
        if ((candidateWidth * candidateHeight) > (width * height)) {
          width = candidateWidth;
          height = candidateHeight;
        }
      }
      if (sizes.split(/\s+/).includes('any') && width * height < 512 * 512) {
        width = 512;
        height = 512;
      }
      let src;
      try {
        const absolute = new URL(icon.src, manifestUrl);
        if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;
        src = absolute.toString();
      } catch {
        continue;
      }
      const typeBonus = (type === 'png' || type === 'image/png') ? 1.5 : 1;
      ranked.push({ src, width, height, score: width * height * typeBonus, index });
    }
    return ranked
      .sort((left, right) => (right.score - left.score) || (left.index - right.index))
      .map(({ src, width, height }) => ({ src, width, height }));
  } catch {
    return [];
  }
}

function pickManifestIcon(manifest, manifestUrl) {
  return rankedManifestIcons(manifest, manifestUrl)[0] || null;
}

/**
 * The PWA's start url: manifest start_url resolved against the MANIFEST
 * url (per the spec), falling back to the page's own url. http(s) only.
 */
function resolveStartUrl(manifest, manifestUrl, pageUrl) {
  const raw = manifest && typeof manifest.start_url === 'string' ? manifest.start_url : '';
  const base = manifestUrl || pageUrl;
  if (raw) {
    try {
      const abs = new URL(raw, base);
      if (abs.protocol === 'https:' || abs.protocol === 'http:') return abs.toString();
    } catch { /* fall through to the page url */ }
  }
  return pageUrl;
}

/**
 * The full install identity for a site: what shows on the user's
 * desktop. Falls back honestly for sites without a manifest.
 * Returns { name, startUrl, iconSrc|null, display, themeColor,
 * backgroundColor, pwa }.
 */
function pickInstallIdentity({ manifest, manifestUrl, pageUrl, pageTitle }) {
  let hostname = 'App';
  try { hostname = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  const manifestName = manifest
    ? String(manifest.short_name || manifest.name || '').trim().slice(0, 60)
    : '';
  const name = manifestName || String(pageTitle || '').trim().slice(0, 60) || hostname;
  const icon = manifest ? pickManifestIcon(manifest, manifestUrl) : null;
  return {
    name,
    startUrl: resolveStartUrl(manifest, manifestUrl, pageUrl),
    iconSrc: icon ? icon.src : null,
    display: manifest && typeof manifest.display === 'string' ? manifest.display : 'standalone',
    themeColor: manifest && typeof manifest.theme_color === 'string' ? manifest.theme_color : null,
    backgroundColor: manifest && typeof manifest.background_color === 'string' ? manifest.background_color : null,
    pwa: Boolean(manifestName && icon)
  };
}

/**
 * Fallback icon discovery for non-PWA sites: the page's own <link
 * rel="icon"> / rel="apple-touch-icon"> tags. Prefers PNG and larger
 * sizes (apple-touch-icons are typically the highest-quality source a
 * plain site offers). Returns an absolute http(s) url or null. The
 * caller still verifies the downloaded bytes by magic number.
 */
function rankedIconLinks(html, pageUrl) {
  try {
    const text = String(html || '').slice(0, 512 * 1024);
    const linkTags = text.match(/<link\b[^>]*>/gi) || [];
    const attr = (tag, name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
      if (!m) return ''; // attribute absent - never throw on optional attrs
      return String(m[2] || m[3] || m[4] || '').trim();
    };
    const ranked = [];
    for (let index = 0; index < linkTags.length; index += 1) {
      const tag = linkTags[index];
      const relTokens = attr(tag, 'rel').toLowerCase().split(/\s+/);
      const isIcon = relTokens.includes('icon');
      const isApple = relTokens.includes('apple-touch-icon');
      if (!isIcon && !isApple) continue;
      const href = attr(tag, 'href');
      if (!href) continue;
      const type = attr(tag, 'type').toLowerCase();
      if (type === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(href)) continue; // not rasterizable
      let size = 0;
      for (const match of attr(tag, 'sizes').matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
        size = Math.max(size, Math.min(Number(match[1]), Number(match[2])));
      }
      if (!size) size = isApple ? 180 : 32;
      let src;
      try {
        const absolute = new URL(href, pageUrl);
        if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;
        src = absolute.toString();
      } catch {
        continue;
      }
      const score = size
        * (type === 'image/png' || /\.png(\?|#|$)/i.test(href) ? 1.5 : 1)
        * (isApple ? 1.2 : 1);
      ranked.push({ src, score, index });
    }
    return ranked
      .sort((left, right) => (right.score - left.score) || (left.index - right.index))
      .map(({ src }) => src);
  } catch {
    return [];
  }
}

function extractIconLink(html, pageUrl) {
  return rankedIconLinks(html, pageUrl)[0] || null;
}

/**
 * Ordered icon sources for an installed site app. Site-declared manifest and
 * HTML icons always win. Conventional same-origin names cover sites that omit
 * metadata; privacy-compatible favicon services are last-resort mirrors of the
 * site's logo. If every candidate is unavailable, the installer generates a
 * deterministic site identity rather than substituting Yayra branding.
 */
function siteIconCandidates({ manifest, manifestUrl, html, pageUrl, preferredIcon = null }) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    try {
      const parsed = new URL(value, pageUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      const absolute = parsed.toString();
      if (!candidates.includes(absolute)) candidates.push(absolute);
    } catch { /* unusable candidate */ }
  };

  // Exhaust every declared icon in quality order: a missing 512 px file must
  // not hide the site's valid 192 px launcher icon or second favicon.
  for (const icon of rankedManifestIcons(manifest, manifestUrl)) add(icon.src);
  for (const icon of rankedIconLinks(html, pageUrl)) add(icon);
  add(preferredIcon);
  try {
    const origin = new URL(pageUrl);
    add(new URL('/favicon.ico', origin).toString());
    add(new URL('/favicon.png', origin).toString());
    add(new URL('/apple-touch-icon.png', origin).toString());
    const host = origin.hostname;
    if (host) {
      add(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`);
      add(`https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(origin.origin)}&sz=256`);
    }
  } catch { /* pageUrl validation happens in the caller */ }
  return candidates;
}

/**
 * Wrap a PNG in an ICO container so a Windows .lnk can use it as its
 * icon (shell.writeShortcutLink needs .ico; Vista+ accepts a PNG payload
 * inside an ICO entry). Width/height of 256+ are encoded as 0 per the
 * ICO spec. Throws for non-PNG input - callers fall back honestly.
 */
function pngToIco(png) {
  if (!isPngBuffer(png)) throw new Error('not-a-png');
  const width = png.readUInt32BE(16);  // IHDR width
  const height = png.readUInt32BE(20); // IHDR height
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(0, 0);                      // reserved
  ico.writeUInt16LE(1, 2);                      // type: icon
  ico.writeUInt16LE(1, 4);                      // image count
  ico.writeUInt8(width >= 256 ? 0 : width, 6);  // 0 means 256
  ico.writeUInt8(height >= 256 ? 0 : height, 7);
  ico.writeUInt8(0, 8);                         // palette color count
  ico.writeUInt8(0, 9);                         // reserved
  ico.writeUInt16LE(1, 10);                     // color planes
  ico.writeUInt16LE(32, 12);                    // bits per pixel
  ico.writeUInt32LE(png.length, 14);            // payload size
  ico.writeUInt32LE(22, 18);                    // payload offset
  png.copy(ico, 22);
  return ico;
}

module.exports = {
  isPngBuffer,
  isIcoBuffer,
  extractPngFromIco,
  generateSiteIdentityPng,
  extractManifestLink,
  extractIconLink,
  parseManifest,
  pickManifestIcon,
  resolveStartUrl,
  pickInstallIdentity,
  siteIconCandidates,
  pngToIco
};
