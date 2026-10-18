'use strict';

const GOOGLE_LENS_UPLOAD_ORIGIN = 'https://lens.google.com';
const GOOGLE_LENS_UPLOAD_PATH = '/v3/upload';
const GOOGLE_LENS_UPLOAD_BY_URL_PATH = '/uploadbyurl';
const GOOGLE_LENS_MAX_BYTES = 20 * 1024 * 1024;
const GOOGLE_LENS_MAX_URL_LENGTH = 2000;
const GOOGLE_LENS_MIME_TYPES = new Set([
  'image/bmp',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/x-icon'
]);

function normalizeLanguage(language) {
  const clean = String(language || 'en-US').trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(clean) ? clean : 'en-US';
}

function positiveInteger(value, { max = 100000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer > 0 && integer <= max ? integer : null;
}

function appendGoogleLensEnvironment(url, {
  language = 'en-US',
  startedAt = Date.now(),
  viewportWidth,
  viewportHeight
} = {}) {
  // `ccm` is the current Chrome/Firefox Lens upload entrypoint. Supplying
  // viewport metrics and the processed image dimensions makes this a real
  // search submission rather than the incomplete request that Google turns
  // into its empty `www.google.com/?olud=` upload picker.
  url.searchParams.set('ep', 'ccm');
  url.searchParams.set('hl', normalizeLanguage(language));
  const width = positiveInteger(viewportWidth);
  const height = positiveInteger(viewportHeight);
  if (width) url.searchParams.set('vpw', String(width));
  if (height) url.searchParams.set('vph', String(height));
  url.searchParams.set('st', String(Number.isFinite(Number(startedAt)) ? Math.trunc(Number(startedAt)) : Date.now()));
  return url;
}

function buildGoogleLensUploadUrl(options = {}) {
  return appendGoogleLensEnvironment(
    new URL(GOOGLE_LENS_UPLOAD_PATH, GOOGLE_LENS_UPLOAD_ORIGIN),
    options
  ).toString();
}

function normalizeImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (encodeURI(url.href).length > GOOGLE_LENS_MAX_URL_LENGTH) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function buildGoogleLensImageUrl({ imageUrl, ...environment } = {}) {
  const safeImageUrl = normalizeImageUrl(imageUrl);
  if (!safeImageUrl) return null;
  const url = appendGoogleLensEnvironment(
    new URL(GOOGLE_LENS_UPLOAD_BY_URL_PATH, GOOGLE_LENS_UPLOAD_ORIGIN),
    environment
  );
  url.searchParams.set('url', safeImageUrl);
  return url.toString();
}

function normalizeBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  return null;
}

function safeFileName(name, mimeType) {
  const fallbackExt = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const cleaned = String(name || `lens-upload.${fallbackExt}`)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .trim()
    .slice(0, 120);
  return cleaned || `lens-upload.${fallbackExt}`;
}

function isGoogleLensPickerUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (host === 'lens.google.com'
        && (path === '/' || path === GOOGLE_LENS_UPLOAD_PATH || path === GOOGLE_LENS_UPLOAD_BY_URL_PATH)) {
      return true;
    }
    // Google redirects its Lens home/uploader to this URL. `olud` means the
    // image-upload dialog should be shown; it is not a completed search.
    return (host === 'google.com' || host === 'www.google.com')
      && path === '/'
      && (parsed.searchParams.has('olud') || parsed.searchParams.size === 0);
  } catch {
    return false;
  }
}

function isGoogleLensResultUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && host !== 'accounts.google.com'
      && (host === 'google.com' || host.endsWith('.google.com'))
      && !isGoogleLensPickerUrl(parsed.toString());
  } catch {
    return false;
  }
}

function googleRequestHeaders(language, userAgent) {
  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': normalizeLanguage(language)
  };
  const cleanUserAgent = String(userAgent || '').trim();
  if (cleanUserAgent) headers['User-Agent'] = cleanUserAgent.slice(0, 512);
  return headers;
}

function googleRedirectUrl(response, requestUrl) {
  let location = '';
  try { location = String(response?.headers?.get?.('location') || '').trim(); } catch { /* malformed response */ }
  if (location) {
    try { return new URL(location, requestUrl).toString(); } catch { return ''; }
  }
  return String(response?.url || '').trim();
}

async function requestGoogleLensResult(netFetch, requestUrl, options) {
  try {
    // Electron's Chromium-backed fetch currently cancels `redirect: manual`.
    // Follow Google's redirect in the destination tab's own Session (the same
    // proven contract used by Firefox), then validate the final URL before
    // allowing the active Yayra tab to navigate to it.
    const response = await netFetch(requestUrl, {
      ...options,
      redirect: 'follow',
      credentials: 'include'
    });
    const status = Number(response?.status) || 0;
    const resultUrl = googleRedirectUrl(response, requestUrl);
    const successfulStatus = (status >= 200 && status < 400) || response?.ok === true;
    // Only the validated URL is needed; do not retain/download Google's full
    // results document in the hidden transport request.
    try { await response?.body?.cancel?.(); } catch { /* response already drained */ }
    if (!response || !successfulStatus || !isGoogleLensResultUrl(resultUrl)) {
      const reason = isGoogleLensPickerUrl(resultUrl) ? 'google-no-result' : `google-http-${status}`;
      return { ok: false, reason };
    }
    return { ok: true, url: resultUrl };
  } catch (err) {
    return { ok: false, reason: String(err?.message || 'upload-failed').slice(0, 160) };
  }
}

/**
 * Send image bytes straight from the Electron main process to Google's
 * official Lens endpoint. `net.fetch` is used here because renderer fetches
 * are CORS-constrained; no Yayra server, proxy, or storage sees the image.
 */
async function uploadGoogleLensImage({
  netFetch,
  data,
  name,
  type,
  language,
  startedAt,
  width,
  height,
  viewportWidth,
  viewportHeight,
  userAgent
} = {}) {
  if (typeof netFetch !== 'function') return { ok: false, reason: 'transport-unavailable' };
  const bytes = normalizeBytes(data);
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty-file' };
  if (bytes.length > GOOGLE_LENS_MAX_BYTES) return { ok: false, reason: 'file-too-large' };

  const mimeType = String(type || '').toLowerCase();
  if (!GOOGLE_LENS_MIME_TYPES.has(mimeType)) return { ok: false, reason: 'unsupported-file-type' };

  const imageWidth = positiveInteger(width);
  const imageHeight = positiveInteger(height);
  const body = new FormData();
  body.append('encoded_image', new Blob([bytes], { type: mimeType }), safeFileName(name, mimeType));
  if (imageWidth && imageHeight) body.append('processed_image_dimensions', `${imageWidth},${imageHeight}`);

  const requestUrl = buildGoogleLensUploadUrl({
    language,
    startedAt,
    viewportWidth,
    viewportHeight
  });
  return requestGoogleLensResult(netFetch, requestUrl, {
    method: 'POST',
    body,
    headers: googleRequestHeaders(language, userAgent)
  });
}

/**
 * Ask Google's upload-by-URL endpoint to fetch the exact URL supplied by the
 * user, but inspect the response before changing tabs. An empty Lens picker
 * is treated as failure, so the original URL stays in Yayra for a retry.
 */
async function searchGoogleLensImageUrl({
  netFetch,
  imageUrl,
  language,
  startedAt,
  viewportWidth,
  viewportHeight,
  userAgent
} = {}) {
  if (typeof netFetch !== 'function') return { ok: false, reason: 'transport-unavailable' };
  const requestUrl = buildGoogleLensImageUrl({
    imageUrl,
    language,
    startedAt,
    viewportWidth,
    viewportHeight
  });
  if (!requestUrl) return { ok: false, reason: 'invalid-image-url' };
  return requestGoogleLensResult(netFetch, requestUrl, {
    method: 'GET',
    headers: googleRequestHeaders(language, userAgent)
  });
}

module.exports = {
  GOOGLE_LENS_MAX_BYTES,
  GOOGLE_LENS_MAX_URL_LENGTH,
  GOOGLE_LENS_MIME_TYPES,
  buildGoogleLensUploadUrl,
  buildGoogleLensImageUrl,
  isGoogleLensPickerUrl,
  isGoogleLensResultUrl,
  uploadGoogleLensImage,
  searchGoogleLensImageUrl
};
