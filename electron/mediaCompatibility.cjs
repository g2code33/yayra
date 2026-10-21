'use strict';

/**
 * Browser-grade media compatibility for native website views.
 *
 * Cloudinary's `f_auto` can occasionally select an image representation that
 * the Chromium build embedded by Electron cannot decode on a particular Linux
 * machine (the system Firefox build may have a different codec set). A failed
 * full-screen backdrop then exposes the site's light fallback and Chromium's
 * small "sad image" glyph even though the exact page works in Firefox.
 *
 * Keep the fix at the delivery boundary: request universally supported WebP
 * from Cloudinary while preserving the original host/path/transforms. A tiny
 * page recovery script retries JPEG if WebP still fails, hides only decorative
 * broken images, and uses the site's own theme-color for a failed full-screen
 * backdrop. Meaningful images (non-empty alt text) remain visible/accessibly
 * described on final failure.
 */

const CLOUDINARY_HOST = 'res.cloudinary.com';
const installedSessions = new WeakSet();

/**
 * Return an equivalent Cloudinary delivery URL with an explicit output format.
 * Signed transformation URLs are intentionally left alone because changing a
 * signed path invalidates its signature. Non-Cloudinary URLs are never touched.
 */
function forceCloudinaryImageFormat(rawUrl, format = 'webp') {
  // Keep this function self-contained: buildMediaCompatibilityScript embeds
  // its source verbatim in website documents for the late JPEG retry.
  const cloudinaryHost = 'res.cloudinary.com';
  const imageMarker = '/image/upload/';
  const signedSegment = /^s--[A-Za-z0-9_-]+--$/;
  const autoFormat = /(^|[,/])f_auto(?::[^,/]+)?(?=,|\/|$)/gi;
  const jpegRetryFormat = /(^|[,/])f_(?:auto(?::[^,/]+)?|webp)(?=,|\/|$)/gi;
  const explicitFormat = /(^|[,/])f_(?:webp|jpe?g|png)(?=,|\/|$)/i;
  const rawHeifPath = /\.(?:heic|heif)$/i;
  const safeFormat = format === 'jpg' ? 'jpg' : 'webp';
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); }
  catch { return rawUrl; }

  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.hostname.toLowerCase() !== cloudinaryHost
      || !parsed.pathname.includes(imageMarker)) return rawUrl;

  const segments = parsed.pathname.split('/');
  if (segments.some((segment) => signedSegment.test(segment))) return rawUrl;

  const markerIndex = parsed.pathname.indexOf(imageMarker);
  const prefix = parsed.pathname.slice(0, markerIndex + imageMarker.length);
  const deliveryPath = parsed.pathname.slice(markerIndex + imageMarker.length);
  const formatPattern = safeFormat === 'jpg' ? jpegRetryFormat : autoFormat;
  const replaced = deliveryPath.replace(formatPattern, (_match, boundary) => `${boundary}f_${safeFormat}`);
  // Cloudinary can let a terminal .heic/.heif extension win over an f_auto
  // transform on some delivery paths. Its public image ID works without the
  // raw source extension (the same normalization the affected site uses in
  // its current Firefox-compatible build), so remove it whenever an explicit
  // browser-safe format is present.
  const normalized = rawHeifPath.test(replaced) && explicitFormat.test(replaced)
    ? replaced.replace(rawHeifPath, '')
    : replaced;

  if (normalized !== deliveryPath) {
    parsed.pathname = `${prefix}${normalized}`;
    return parsed.toString();
  }

  // A raw HEIC/HEIF URL has no negotiation transform at all. Ask Cloudinary
  // to transcode it rather than handing an unsupported source codec to the
  // renderer. Strip the source extension so it cannot override f_webp/f_jpg.
  if (rawHeifPath.test(parsed.pathname) && !explicitFormat.test(deliveryPath)) {
    const publicId = deliveryPath.replace(rawHeifPath, '');
    parsed.pathname = `${prefix}q_auto,f_${safeFormat}/${publicId}`;
    return parsed.toString();
  }

  return rawUrl;
}

function rewriteCloudinaryImageUrl(rawUrl) {
  return forceCloudinaryImageFormat(rawUrl, 'webp');
}

/** Dynamic same-origin API reads must reflect the live site, not a heuristic
 * disk-cache entry from an older deployment/profile session. */
function isLiveApiRequest(details = {}) {
  if (details.resourceType && details.resourceType !== 'xhr') return false;
  if (details.method && !/^(?:GET|HEAD)$/i.test(details.method)) return false;
  let target;
  try { target = new URL(String(details.url || '')); }
  catch { return false; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  if (!/(?:^|\/)api(?:\/|$)/i.test(target.pathname) && !/(?:^|\/)graphql\/?$/i.test(target.pathname)) return false;

  const requestHeaders = details.requestHeaders || {};
  const fetchSiteName = Object.keys(requestHeaders).find((name) => /^sec-fetch-site$/i.test(name));
  const fetchSite = fetchSiteName ? String(requestHeaders[fetchSiteName] || '').toLowerCase() : '';
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const sourceUrl = details.initiator || details.referrer;
  if (sourceUrl) {
    try {
      const source = new URL(String(sourceUrl));
      if (source.origin !== target.origin) return false;
    } catch { return false; }
  } else if (fetchSite !== 'same-origin') {
    // Never guess that an origin-less request is same-origin: adding these
    // headers to a cross-origin fetch could create a new CORS preflight.
    return false;
  }
  return true;
}

function withLiveApiRequestHeaders(headers = {}) {
  const next = { ...headers };
  for (const name of Object.keys(next)) {
    if (/^(?:cache-control|pragma)$/i.test(name)) delete next[name];
  }
  next['Cache-Control'] = 'no-cache';
  next.Pragma = 'no-cache';
  return next;
}

/**
 * Install once per Electron Session. `onBeforeRequest` runs before cache lookup,
 * so the rewritten WebP URL also escapes a stale/undecodable cached f_auto
 * response without clearing cookies, logins, local storage, or unrelated cache.
 */
function installMediaCompatibility(session, logger = console) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return false;
  if (installedSessions.has(session)) return true;
  const onBeforeRequest = session.webRequest && session.webRequest.onBeforeRequest;
  if (typeof onBeforeRequest !== 'function') return false;

  try {
    onBeforeRequest.call(
      session.webRequest,
      { urls: [`https://${CLOUDINARY_HOST}/*`, `http://${CLOUDINARY_HOST}/*`] },
      (details, callback) => {
        let result = {};
        try {
          // Main documents/scripts are never rewritten. CSS backgrounds and
          // <img>/<picture> requests both arrive as resourceType "image".
          if (!details?.resourceType || details.resourceType === 'image') {
            const redirectURL = rewriteCloudinaryImageUrl(details?.url);
            if (redirectURL && redirectURL !== details?.url) result = { redirectURL };
          }
        } catch (error) {
          logger?.warn?.(`[yayra:media] compatibility rewrite failed: ${error?.message || error}`);
        }
        try { callback(result); }
        catch { /* request was canceled while the listener was running */ }
      }
    );

    const onBeforeSendHeaders = session.webRequest && session.webRequest.onBeforeSendHeaders;
    if (typeof onBeforeSendHeaders === 'function') {
      try {
        onBeforeSendHeaders.call(
          session.webRequest,
          { urls: ['https://*/*', 'http://*/*'] },
          (details, callback) => {
            let result = {};
            try {
              if (isLiveApiRequest(details)) {
                result = { requestHeaders: withLiveApiRequestHeaders(details.requestHeaders || {}) };
              }
            } catch (error) {
              logger?.warn?.(`[yayra:media] live API freshness failed: ${error?.message || error}`);
            }
            try { callback(result); } catch { /* request already canceled */ }
          }
        );
      } catch (error) {
        // Media decoding still works even on an older WebRequest fake/API.
        logger?.warn?.(`[yayra:media] could not install live API freshness: ${error?.message || error}`);
      }
    }

    installedSessions.add(session);
    return true;
  } catch (error) {
    logger?.warn?.(`[yayra:media] could not install compatibility listener: ${error?.message || error}`);
    return false;
  }
}

/**
 * Main-world recovery installed in each website document. The network rewrite
 * above handles the normal case before paint. This catches cached failures,
 * late/lazy images, and third-party markup that would otherwise leave the
 * broken-image glyph visible in the page.
 */
function buildMediaCompatibilityScript() {
  const forceFormatSource = forceCloudinaryImageFormat.toString();
  return `(function () {
    try {
      var previousInstall = window.__yayraMediaCompatibilityV1;
      try { if (previousInstall && previousInstall.cleanup) previousInstall.cleanup(); } catch (_err) {}
      var installKey = '__yayraMediaCompatibilityV2';
      if (window[installKey]) return;
      var attempts = new WeakMap();
      var forceCloudinaryImageFormat = ${forceFormatSource};

      var themeColor = function () {
        try {
          var metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
          var selected = metas.find(function (meta) {
            var media = meta.getAttribute('media');
            return !media || !window.matchMedia || window.matchMedia(media).matches;
          }) || metas[0];
          var value = String(selected && selected.getAttribute('content') || '').trim();
          if (!value) return '';
          var probe = document.createElement('span');
          probe.style.color = '';
          probe.style.color = value;
          return probe.style.color ? value : '';
        } catch (_err) { return ''; }
      };

      var coversViewport = function (element) {
        try {
          var rect = element.getBoundingClientRect();
          var width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
          var height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
          return width > 0 && height > 0 && rect.width >= width * 0.7 && rect.height >= height * 0.7;
        } catch (_err) { return false; }
      };

      var looksLikeBackdrop = function (image) {
        try {
          var className = typeof image.className === 'string' ? image.className : (image.className && image.className.baseVal) || '';
          var hints = [className, image.id, image.getAttribute('alt'), image.getAttribute('role')].join(' ').toLowerCase();
          if (/(?:background|backdrop|wallpaper|hero|object-cover|inset-0|h-full|w-full)/.test(hints)) return true;
          var style = getComputedStyle(image);
          return (style.position === 'fixed' || style.position === 'absolute')
            && (style.objectFit === 'cover' || style.width === '100%' || style.height === '100%');
        } catch (_err) { return false; }
      };

      var applyBackdropFallback = function (image) {
        var color = themeColor();
        if (!color) return false;
        try {
          var imageCovers = coversViewport(image);
          var hintedBackdrop = looksLikeBackdrop(image);
          var target = image.parentElement;
          var coveringAncestor = null;
          for (var depth = 0; target && depth < 4; depth += 1) {
            if (coversViewport(target)) { coveringAncestor = target; break; }
            target = target.parentElement;
          }
          // A failed image may collapse to Chromium's tiny glyph even though
          // its backdrop wrapper still fills the screen. Conversely, when the
          // image box itself fills the viewport, its nearest parent is the
          // correct paint layer even if that parent's measured box is odd.
          target = coveringAncestor || ((imageCovers || hintedBackdrop) ? image.parentElement : null);
          if (!target) return false;
          target.style.setProperty('background-color', color, 'important');
          return true;
        } catch (_err) { return false; /* the page replaced the failed node */ }
      };

      var retireDecorativeFailure = function (image) {
        // Meaningful ordinary images retain their alt fallback. A viewport
        // backdrop is decorative by geometry even when old site code gave it
        // alt text; hide its broken glyph and paint the site's own theme.
        var isBackdrop = applyBackdropFallback(image);
        if (String(image.getAttribute('alt') || '').trim() && !isBackdrop) return;
        try {
          image.style.setProperty('visibility', 'hidden', 'important');
          image.setAttribute('data-yayra-media-failed', 'true');
        } catch (_err) { /* detached during error dispatch */ }
      };

      var parseColor = function (value) {
        var text = String(value || '').trim().toLowerCase();
        var hex = text.match(/^#([0-9a-f]{3,8})$/i);
        if (hex) {
          var raw = hex[1];
          if (raw.length === 3 || raw.length === 4) raw = raw.split('').map(function (part) { return part + part; }).join('');
          if (raw.length === 6 || raw.length === 8) return [
            parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16),
            raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1
          ];
        }
        var rgb = text.match(/^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$/);
        if (!rgb) return null;
        var alpha = rgb[4] == null ? 1 : (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]));
        return [parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3]), alpha];
      };
      var brightness = function (color) {
        return color ? (color[0] * 299 + color[1] * 587 + color[2] * 114) / 255000 : -1;
      };
      var paintedBackground = function (element) {
        for (var depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
          try {
            var color = parseColor(getComputedStyle(element).backgroundColor);
            if (color && color[3] > 0.05) return color;
          } catch (_err) { return null; }
        }
        return null;
      };
      var healLowContrastTheme = function () {
        try {
          var color = themeColor();
          var theme = parseColor(color);
          if (!theme || brightness(theme) > 0.42 || !document.body) return false;
          var unreadable = false;
          var textNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,label,button,[role="heading"]')).slice(0, 160);
          for (var i = 0; i < textNodes.length; i += 1) {
            var node = textNodes[i];
            if (!String(node.textContent || '').trim()) continue;
            var rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            var style = getComputedStyle(node);
            var foreground = parseColor(style.color);
            var background = paintedBackground(node);
            if (foreground && brightness(foreground) > 0.78 && background && brightness(background) > 0.82) {
              unreadable = true;
              break;
            }
          }
          if (!unreadable) return false;

          var candidates = [document.documentElement, document.body, document.getElementById('root'), document.body.firstElementChild];
          try { candidates = candidates.concat(Array.from(document.querySelectorAll('#root > *,#app,#app > *,body > main,body > [style]')).slice(0, 120)); } catch (_err) {}
          var changed = false;
          Array.from(new Set(candidates.filter(Boolean))).forEach(function (candidate) {
            if (!coversViewport(candidate)) return;
            var current = null;
            try { current = parseColor(getComputedStyle(candidate).backgroundColor); } catch (_err) {}
            if (!current || current[3] < 0.05 || brightness(current) > 0.78) {
              try { candidate.style.setProperty('background-color', color, 'important'); changed = true; } catch (_err) {}
            }
          });
          return changed;
        } catch (_err) { return false; }
      };

      var recover = function (image) {
        if (!image || String(image.tagName || '').toLowerCase() !== 'img') return false;
        var source = String(image.currentSrc || image.src || image.getAttribute('src') || '');
        if (!source || source.indexOf('data:') === 0 || source.indexOf('blob:') === 0) {
          retireDecorativeFailure(image);
          return false;
        }

        var state = attempts.get(image);
        if (!state || (state.source !== source && state.retry !== source)) state = { source: source, count: 0, retry: '' };
        if (state.count < 1) {
          var jpeg = forceCloudinaryImageFormat(source, 'jpg');
          if (jpeg && jpeg !== source) {
            state.count += 1;
            state.retry = jpeg;
            attempts.set(image, state);
            try {
              image.style.removeProperty('visibility');
              image.removeAttribute('data-yayra-media-failed');
              image.removeAttribute('srcset');
              image.removeAttribute('sizes');
              image.src = jpeg;
              return true;
            } catch (_err) { /* continue to clean fallback */ }
          }
        }
        attempts.set(image, { source: source, count: 2, retry: state && state.retry || '' });
        retireDecorativeFailure(image);
        return false;
      };

      var onError = function (event) {
        var target = event && event.target;
        if (!target || String(target.tagName || '').toLowerCase() !== 'img') return;
        // Capture before React/Vue removes its failed <img>. When a safe
        // Cloudinary JPEG retry starts, suppress only this first decode error
        // so the site's onError handler does not unmount the retry itself.
        var retried = recover(target);
        if (retried) {
          try { event.preventDefault && event.preventDefault(); } catch (_err) {}
          try { event.stopImmediatePropagation && event.stopImmediatePropagation(); } catch (_err) {}
          try { event.stopPropagation && event.stopPropagation(); } catch (_err) {}
        }
      };
      var onLoad = function (event) {
        var target = event && event.target;
        if (!target || String(target.tagName || '').toLowerCase() !== 'img') return;
        attempts.delete(target);
        if (target.getAttribute('data-yayra-media-failed') === 'true') {
          target.removeAttribute('data-yayra-media-failed');
          target.style.removeProperty('visibility');
        }
      };

      window.addEventListener('error', onError, true);
      window.addEventListener('load', onLoad, true);

      var scan = function (root) {
        var images = [];
        try {
          if (root && String(root.tagName || '').toLowerCase() === 'img') images.push(root);
          if (root && root.querySelectorAll) images = images.concat(Array.from(root.querySelectorAll('img')));
        } catch (_err) { return; }
        images.forEach(function (image) {
          try {
            if (image.complete && image.naturalWidth === 0 && (image.currentSrc || image.src || image.getAttribute('src'))) recover(image);
          } catch (_err) { /* cross-document node */ }
        });
      };
      scan(document);
      var healTimers = [0, 250, 1000, 3000].map(function (delay) {
        return setTimeout(healLowContrastTheme, delay);
      });

      var observer = typeof MutationObserver === 'function' ? new MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.from(record.addedNodes || []).forEach(scan);
        });
        healLowContrastTheme();
      }) : null;
      if (observer && document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

      window[installKey] = {
        cleanup: function () {
          try { window.removeEventListener('error', onError, true); } catch (_err) {}
          try { window.removeEventListener('load', onLoad, true); } catch (_err) {}
          try { observer && observer.disconnect(); } catch (_err) {}
          try { healTimers.forEach(clearTimeout); } catch (_err) {}
          try { delete window[installKey]; } catch (_err) {}
        }
      };
    } catch (_err) { /* compatibility enhancement must never affect page use */ }
  })();`;
}

module.exports = {
  buildMediaCompatibilityScript,
  forceCloudinaryImageFormat,
  installMediaCompatibility,
  isLiveApiRequest,
  rewriteCloudinaryImageUrl,
  withLiveApiRequestHeaders
};
