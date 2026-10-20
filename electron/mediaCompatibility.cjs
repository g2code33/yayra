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
  const replaced = deliveryPath.replace(autoFormat, (_match, boundary) => `${boundary}f_${safeFormat}`);

  if (replaced !== deliveryPath) {
    parsed.pathname = `${prefix}${replaced}`;
    return parsed.toString();
  }

  // A raw HEIC/HEIF URL has no negotiation transform at all. Ask Cloudinary
  // to transcode it rather than handing an unsupported source codec to the
  // renderer. Existing explicit browser-safe transformations need no change.
  if (rawHeifPath.test(parsed.pathname) && !explicitFormat.test(deliveryPath)) {
    parsed.pathname = `${prefix}q_auto,f_${safeFormat}/${deliveryPath}`;
    return parsed.toString();
  }

  return rawUrl;
}

function rewriteCloudinaryImageUrl(rawUrl) {
  return forceCloudinaryImageFormat(rawUrl, 'webp');
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
      var installKey = '__yayraMediaCompatibilityV1';
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

      var applyBackdropFallback = function (image) {
        var color = themeColor();
        if (!color) return;
        try {
          var imageCovers = coversViewport(image);
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
          target = coveringAncestor || (imageCovers ? image.parentElement : null);
          if (target) target.style.setProperty('background-color', color, 'important');
        } catch (_err) { /* the page replaced the failed node */ }
      };

      var retireDecorativeFailure = function (image) {
        // Preserve meaningful broken images: their alt text is useful to the
        // user and assistive technology. Empty-alt decoration gets no glyph.
        if (String(image.getAttribute('alt') || '').trim()) return;
        try {
          image.style.setProperty('visibility', 'hidden', 'important');
          image.setAttribute('data-yayra-media-failed', 'true');
          applyBackdropFallback(image);
        } catch (_err) { /* detached during error dispatch */ }
      };

      var recover = function (image) {
        if (!image || String(image.tagName || '').toLowerCase() !== 'img') return;
        var source = String(image.currentSrc || image.src || image.getAttribute('src') || '');
        if (!source || source.indexOf('data:') === 0 || source.indexOf('blob:') === 0) {
          retireDecorativeFailure(image);
          return;
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
              return;
            } catch (_err) { /* continue to clean fallback */ }
          }
        }
        attempts.set(image, { source: source, count: 2, retry: state && state.retry || '' });
        retireDecorativeFailure(image);
      };

      var onError = function (event) {
        var target = event && event.target;
        if (!target || String(target.tagName || '').toLowerCase() !== 'img') return;
        // Let the site's own onError handler run first; only repair a node
        // that remains connected after that handler has had its turn.
        setTimeout(function () { if (target.isConnected !== false) recover(target); }, 0);
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

      var observer = typeof MutationObserver === 'function' ? new MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.from(record.addedNodes || []).forEach(scan);
        });
      }) : null;
      if (observer && document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

      window[installKey] = {
        cleanup: function () {
          try { window.removeEventListener('error', onError, true); } catch (_err) {}
          try { window.removeEventListener('load', onLoad, true); } catch (_err) {}
          try { observer && observer.disconnect(); } catch (_err) {}
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
  rewriteCloudinaryImageUrl
};
