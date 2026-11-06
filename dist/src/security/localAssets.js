const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon']
]);

export function normalizeAssetPath(urlPath) {
  const raw = String(urlPath || '/');
  let decoded = raw;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  if (!normalized.startsWith('/')) return null;
  const path = normalized === '/' ? '/index.html' : normalized;
  if (path.endsWith('/')) return `${path}index.html`;
  return path;
}

export function mimeTypeFor(assetPath) {
  const match = String(assetPath).match(/(\.[^.?#/]+)(?:[?#].*)?$/);
  const type = match ? MIME_TYPES.get(match[1]) : null;
  if (!type) return 'application/octet-stream';
  return type;
}

export function isJavaScriptMime(type) {
  return /^(text|application)\/(javascript|ecmascript)/i.test(type || '');
}
