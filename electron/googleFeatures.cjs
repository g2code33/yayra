'use strict';

const GOOGLE_LENS_UPLOAD_ORIGIN = 'https://lens.google.com';
const GOOGLE_LENS_UPLOAD_PATH = '/v3/upload';
const GOOGLE_LENS_MAX_BYTES = 20 * 1024 * 1024;
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

function buildGoogleLensUploadUrl({ language = 'en-US', startedAt = Date.now() } = {}) {
  const url = new URL(GOOGLE_LENS_UPLOAD_PATH, GOOGLE_LENS_UPLOAD_ORIGIN);
  // These are Google's current Chromium new-tab Lens contract values:
  // cntpubb = upload-by-file entrypoint, df = desktop form, 4 = Chromium.
  url.searchParams.set('ep', 'cntpubb');
  url.searchParams.set('hl', normalizeLanguage(language));
  url.searchParams.set('st', String(Number.isFinite(Number(startedAt)) ? Math.trunc(Number(startedAt)) : Date.now()));
  url.searchParams.set('re', 'df');
  url.searchParams.set('s', '4');
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

function isGoogleLensResultUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname !== 'accounts.google.com'
      && (parsed.hostname === 'lens.google.com' || parsed.hostname.endsWith('.google.com'));
  } catch {
    return false;
  }
}

/**
 * Upload image bytes straight from the Electron main process to Google's
 * official Lens endpoint. `net.fetch` is used here because renderer fetches
 * are CORS-constrained; no Yayra server, proxy, or storage sees the image.
 */
async function uploadGoogleLensImage({ netFetch, data, name, type, language, startedAt } = {}) {
  if (typeof netFetch !== 'function') return { ok: false, reason: 'transport-unavailable' };
  const bytes = normalizeBytes(data);
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty-file' };
  if (bytes.length > GOOGLE_LENS_MAX_BYTES) return { ok: false, reason: 'file-too-large' };

  const mimeType = String(type || '').toLowerCase();
  if (!GOOGLE_LENS_MIME_TYPES.has(mimeType)) return { ok: false, reason: 'unsupported-file-type' };

  try {
    const body = new FormData();
    body.append('encoded_image', new Blob([bytes], { type: mimeType }), safeFileName(name, mimeType));
    const response = await netFetch(buildGoogleLensUploadUrl({ language, startedAt }), {
      method: 'POST',
      body,
      redirect: 'follow'
    });
    const resultUrl = String(response?.url || '');
    if (!response || !response.ok || !isGoogleLensResultUrl(resultUrl)) {
      return { ok: false, reason: `google-http-${Number(response?.status) || 0}` };
    }
    return { ok: true, url: resultUrl };
  } catch (err) {
    return { ok: false, reason: String(err?.message || 'upload-failed').slice(0, 160) };
  }
}

module.exports = {
  GOOGLE_LENS_MAX_BYTES,
  GOOGLE_LENS_MIME_TYPES,
  buildGoogleLensUploadUrl,
  isGoogleLensResultUrl,
  uploadGoogleLensImage
};
