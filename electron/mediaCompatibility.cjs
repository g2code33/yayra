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
 * above handles normal images before paint. This also catches cached/lazy
 * failures, repairs narrowly identified transparent gradient text, and keeps
 * third-party markup from leaving a broken-image glyph or box-filling gradient
 * visible in the page.
 */
function buildMediaCompatibilityScript() {
  const forceFormatSource = forceCloudinaryImageFormat.toString();
  return `(function () {
    try {
      var previousInstall = window.__yayraMediaCompatibilityV3 || window.__yayraMediaCompatibilityV2 || window.__yayraMediaCompatibilityV1;
      try { if (previousInstall && previousInstall.cleanup) previousInstall.cleanup(); } catch (_err) {}
      var installKey = '__yayraMediaCompatibilityV4';
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
          if (/(?:background|backdrop|wallpaper)/.test(hints)) return true;
          // object-cover/inset-0 are also common inside ordinary cards. They
          // only prove a page backdrop when the immediate image layer fills a
          // viewport-sized wrapper and its computed layout agrees.
          var parentCovers = coversViewport(image.parentElement);
          if (!parentCovers) return false;
          if (/\bhero(?:-|\b)/.test(hints)) return true;
          var style = getComputedStyle(image);
          return (style.position === 'fixed' || style.position === 'absolute')
            && (style.objectFit === 'cover' || style.width === '100%' || style.height === '100%'
              || /(?:object-cover|inset-0)/.test(hints));
        } catch (_err) { return false; }
      };

      var applyBackdropFallback = function (image) {
        try {
          var imageCovers = coversViewport(image);
          var hintedBackdrop = looksLikeBackdrop(image);
          // A normal failed logo/thumbnail often sits a few levels below a
          // viewport-sized app shell. That does NOT make it a backdrop. The
          // old ancestor-only test painted RX Store's #FFD600 browser theme
          // colour across the whole page when any card image failed.
          if (!imageCovers && !hintedBackdrop) return false;

          // Never climb from an image-sized wrapper to a page root. A proven
          // full-screen backdrop's immediate layer remains viewport-sized even
          // when Chromium collapses the failed image to its tiny glyph.
          var target = image.parentElement;

          // <meta name="theme-color"> primarily colours browser chrome and is
          // frequently a bright/saturated brand accent, not a page background.
          // Only a dark, low-chroma theme colour is safe as a missing-backdrop
          // substitute. Otherwise preserve the site's authored CSS surface.
          var color = themeColor();
          var parsed = parseColor(color);
          var chroma = parsed ? (Math.max(parsed[0], parsed[1], parsed[2]) - Math.min(parsed[0], parsed[1], parsed[2])) / 255 : 1;
          if (target && parsed && parsed[3] > 0.5 && brightness(parsed) <= 0.42 && chroma <= 0.35) {
            target.style.setProperty('background-color', color, 'important');
          }
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

      // Tailwind and many design systems implement gradient text with a
      // background gradient + transparent glyphs. Older WebKit/Gecko builds
      // and some embedded WebViews either ignore background-clip:text or
      // require its prefixed spelling. In that failure mode the gradient
      // paints the element's whole rectangle while its text disappears. Try
      // both clip spellings first; if the engine still does not accept text
      // clipping, remove only that decorative gradient and install a solid,
      // contrast-safe foreground. Never touch opaque gradients or ordinary
      // transparent utility elements.
      var isTransparentPaint = function (value) {
        var text = String(value || '').trim().toLowerCase();
        if (text === 'transparent') return true;
        var parsed = parseColor(text);
        return Boolean(parsed && parsed[3] <= 0.05);
      };
      var relativeLuminance = function (color) {
        if (!color) return -1;
        var linear = color.slice(0, 3).map(function (channel) {
          var value = Math.max(0, Math.min(255, channel)) / 255;
          return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
      };
      var contrastRatio = function (first, second) {
        var a = relativeLuminance(first);
        var b = relativeLuminance(second);
        if (a < 0 || b < 0) return 0;
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      var solidGradientFallback = function (element) {
        var background = paintedBackground(element);
        var parent = element && element.parentElement;
        for (var depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
          try {
            var inherited = getComputedStyle(parent).color;
            var parsed = parseColor(inherited);
            if (parsed && parsed[3] > 0.5 && (!background || contrastRatio(parsed, background) >= 4.5)) {
              return inherited;
            }
          } catch (_err) { break; }
        }
        var luminance = relativeLuminance(background);
        return luminance >= 0 && luminance < 0.179 ? '#ffffff' : '#000000';
      };
      var gradientTextSelector = '.gradient-text,[class*="gradient-text"],[class~="bg-clip-text"],[class~="text-transparent"]';
      var gradientRepairProperties = [
        'background-image', 'background-color', 'background-clip', '-webkit-background-clip',
        'color', '-webkit-text-fill-color'
      ];
      var gradientOriginalStyles = new WeakMap();
      var gradientRepairedElements = new Set();
      var pruneGradientRepairs = function () {
        gradientRepairedElements.forEach(function (element) {
          if (element && element.isConnected !== false) return;
          gradientRepairedElements.delete(element);
          gradientOriginalStyles.delete(element);
        });
      };
      var rememberGradientStyles = function (element, classIntent) {
        if (gradientOriginalStyles.has(element)) return true;
        if (gradientRepairedElements.size >= 480) pruneGradientRepairs();
        if (gradientRepairedElements.size >= 480) return false;
        var values = {};
        gradientRepairProperties.forEach(function (property) {
          try {
            values[property] = {
              value: element.style.getPropertyValue ? element.style.getPropertyValue(property) : '',
              priority: element.style.getPropertyPriority ? element.style.getPropertyPriority(property) : ''
            };
          } catch (_err) { values[property] = { value: '', priority: '' }; }
        });
        gradientOriginalStyles.set(element, { values: values, classIntent: classIntent });
        gradientRepairedElements.add(element);
        return true;
      };
      var restoreGradientStyles = function (element) {
        var original = gradientOriginalStyles.get(element);
        if (!original) return false;
        gradientRepairProperties.forEach(function (property) {
          var saved = original.values[property];
          try {
            if (saved && saved.value) element.style.setProperty(property, saved.value, saved.priority || '');
            else if (element.style.removeProperty) element.style.removeProperty(property);
          } catch (_err) {}
        });
        try { element.removeAttribute('data-yayra-gradient-text'); } catch (_err) {}
        gradientOriginalStyles.delete(element);
        gradientRepairedElements.delete(element);
        return true;
      };
      var repairGradientText = function (element) {
        if (!element || !element.style) return false;
        var style;
        try { style = getComputedStyle(element); } catch (_err) { return false; }
        var className = '';
        try { className = typeof element.className === 'string' ? element.className : (element.className && element.className.baseVal) || ''; } catch (_err) {}
        var classHints = String(className).toLowerCase();
        var classIntent = classHints.indexOf('gradient-text') >= 0
          || /(?:^|\\s)bg-clip-text(?:\\s|$)/i.test(classHints);
        var original = gradientOriginalStyles.get(element);
        if (original && original.classIntent && !classIntent) return restoreGradientStyles(element);
        var backgroundImage = String(style.backgroundImage || '');
        if (!/(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\\s*\\(/i.test(backgroundImage)) return false;
        var clip = [style.backgroundClip, style.webkitBackgroundClip].join(' ').toLowerCase();
        var intended = classIntent || clip.indexOf('text') >= 0;
        var transparent = isTransparentPaint(style.color) || isTransparentPaint(style.webkitTextFillColor);
        if (!intended || !transparent) return false;
        try {
          if (element.getAttribute('data-yayra-gradient-text') === 'clip' && clip.indexOf('text') >= 0) return false;
        } catch (_err) {}

        if (!rememberGradientStyles(element, classIntent)) return false;
        try {
          element.style.setProperty('-webkit-background-clip', 'text', 'important');
          element.style.setProperty('background-clip', 'text', 'important');
          var accepted = getComputedStyle(element);
          var acceptedClip = [accepted.backgroundClip, accepted.webkitBackgroundClip].join(' ').toLowerCase();
          if (acceptedClip.indexOf('text') >= 0) {
            // currentColor follows the site's existing transparent utility and
            // automatically becomes opaque again if the framework later
            // removes that utility; never pin dynamic text to transparent.
            element.style.setProperty('-webkit-text-fill-color', 'currentColor', 'important');
            element.setAttribute('data-yayra-gradient-text', 'clip');
            return true;
          }
        } catch (_err) { /* use the solid fallback below */ }

        var fallback = solidGradientFallback(element);
        try {
          element.style.setProperty('background-image', 'none', 'important');
          element.style.setProperty('background-color', 'transparent', 'important');
          element.style.setProperty('background-clip', 'border-box', 'important');
          element.style.setProperty('-webkit-background-clip', 'border-box', 'important');
          element.style.setProperty('color', fallback, 'important');
          element.style.setProperty('-webkit-text-fill-color', fallback, 'important');
          element.setAttribute('data-yayra-gradient-text', 'solid');
          return true;
        } catch (_err) {
          restoreGradientStyles(element);
          return false;
        }
      };
      var healGradientText = function (root) {
        var candidates = [];
        try {
          if (root && root.nodeType === 1) candidates.push(root);
          if (root && root.querySelectorAll) candidates = candidates.concat(Array.from(root.querySelectorAll(gradientTextSelector)));
        } catch (_err) { return 0; }
        var changed = 0;
        Array.from(new Set(candidates)).slice(0, 240).forEach(function (element) {
          if (repairGradientText(element)) changed += 1;
        });
        return changed;
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
      healGradientText(document);
      var healTimers = [0, 250, 1000, 3000].map(function (delay) {
        return setTimeout(function () {
          healLowContrastTheme();
          healGradientText(document);
        }, delay);
      });
      var mutationHealTimer = null;
      var scheduleMutationHeal = function () {
        if (mutationHealTimer !== null) return;
        mutationHealTimer = setTimeout(function () {
          mutationHealTimer = null;
          healLowContrastTheme();
          healGradientText(document);
        }, 50);
      };

      var observer = typeof MutationObserver === 'function' ? new MutationObserver(function (records) {
        var addedContent = false;
        records.forEach(function (record) {
          if (record.type === 'attributes') {
            try {
              if (record.target && record.target.matches
                  && (record.target.matches(gradientTextSelector)
                    || record.target.getAttribute('data-yayra-gradient-text'))) {
                healGradientText(record.target);
              }
            } catch (_err) {}
            return;
          }
          Array.from(record.addedNodes || []).forEach(function (node) {
            addedContent = true;
            scan(node);
            healGradientText(node);
          });
        });
        pruneGradientRepairs();
        if (addedContent) scheduleMutationHeal();
      }) : null;
      if (observer && document.documentElement) observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      window[installKey] = {
        cleanup: function () {
          try { window.removeEventListener('error', onError, true); } catch (_err) {}
          try { window.removeEventListener('load', onLoad, true); } catch (_err) {}
          try { observer && observer.disconnect(); } catch (_err) {}
          try { healTimers.forEach(clearTimeout); } catch (_err) {}
          try { if (mutationHealTimer !== null) clearTimeout(mutationHealTimer); } catch (_err) {}
          try { Array.from(gradientRepairedElements).forEach(restoreGradientStyles); } catch (_err) {}
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
