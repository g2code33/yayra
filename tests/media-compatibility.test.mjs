import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  buildMediaCompatibilityScript,
  forceCloudinaryImageFormat,
  installMediaCompatibility,
  isLiveApiRequest,
  rewriteCloudinaryImageUrl,
  withLiveApiRequestHeaders
} = require('../electron/mediaCompatibility.cjs');

test('media compatibility: Cloudinary auto images use deterministic WebP while preserving transforms and query data', () => {
  const source = 'https://res.cloudinary.com/demo/image/upload/q_auto,f_auto:good,c_scale,w_1600/folder/hero.heic?version=7';
  assert.equal(
    rewriteCloudinaryImageUrl(source),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_webp,c_scale,w_1600/folder/hero?version=7'
  );
  assert.equal(
    forceCloudinaryImageFormat(source, 'jpg'),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_jpg,c_scale,w_1600/folder/hero?version=7'
  );
});

test('media compatibility: raw HEIC is transcoded but signed, explicit, video and unrelated URLs are untouched', () => {
  assert.equal(
    rewriteCloudinaryImageUrl('https://res.cloudinary.com/demo/image/upload/v42/folder/photo.HEIC'),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_webp/v42/folder/photo'
  );
  assert.equal(
    rewriteCloudinaryImageUrl('https://res.cloudinary.com/demo/image/upload/f_webp/folder/photo.heic'),
    'https://res.cloudinary.com/demo/image/upload/f_webp/folder/photo'
  );
  for (const url of [
    'https://res.cloudinary.com/demo/image/upload/s--signed-token--/f_auto/folder/photo.jpg',
    'https://res.cloudinary.com/demo/video/upload/f_auto/folder/movie.mp4',
    'https://images.example/photo.heic'
  ]) {
    assert.equal(rewriteCloudinaryImageUrl(url), url);
  }
});

test('media compatibility: one request hook per Session rewrites only image resources before cache lookup', () => {
  let registrations = 0;
  let filter = null;
  let listener = null;
  let headerRegistrations = 0;
  let headerListener = null;
  const session = {
    webRequest: {
      onBeforeRequest(nextFilter, nextListener) {
        registrations += 1;
        filter = nextFilter;
        listener = nextListener;
      },
      onBeforeSendHeaders(_nextFilter, nextListener) {
        headerRegistrations += 1;
        headerListener = nextListener;
      }
    }
  };

  assert.equal(installMediaCompatibility(session), true);
  assert.equal(installMediaCompatibility(session), true);
  assert.equal(registrations, 1, 'a shared profile Session never stacks listeners');
  assert.equal(headerRegistrations, 1, 'live API freshness is also installed exactly once');
  assert.deepEqual(filter.urls, ['https://res.cloudinary.com/*', 'http://res.cloudinary.com/*']);

  let response = null;
  listener({
    resourceType: 'image',
    url: 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/background.heic'
  }, (value) => { response = value; });
  assert.deepEqual(response, {
    redirectURL: 'https://res.cloudinary.com/demo/image/upload/f_webp,q_auto/background'
  });

  listener({
    resourceType: 'script',
    url: 'https://res.cloudinary.com/demo/image/upload/f_auto/app.js'
  }, (value) => { response = value; });
  assert.deepEqual(response, {}, 'scripts/documents are never redirected');

  headerListener({
    resourceType: 'xhr',
    url: 'https://birthday.example/api/config',
    initiator: 'https://birthday.example',
    requestHeaders: { Accept: 'application/json', 'cache-control': 'max-age=86400' }
  }, (value) => { response = value; });
  assert.deepEqual(response.requestHeaders, {
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  }, 'live same-origin API configuration bypasses an old profile cache');
});

test('media compatibility: only same-origin dynamic API reads receive freshness headers', () => {
  assert.equal(isLiveApiRequest({
    resourceType: 'xhr',
    url: 'https://birthday.example/api/config',
    initiator: 'https://birthday.example/page'
  }), true);
  assert.equal(isLiveApiRequest({
    resourceType: 'xhr',
    url: 'https://api.other.example/api/config',
    initiator: 'https://birthday.example/page'
  }), false, 'cross-origin APIs are untouched so no new CORS preflight is introduced');
  assert.equal(isLiveApiRequest({
    resourceType: 'xhr',
    url: 'https://birthday.example/api/config',
    requestHeaders: { 'Sec-Fetch-Site': 'same-origin' }
  }), true, 'Chromium fetch metadata proves same-origin when no initiator URL is exposed');
  assert.equal(isLiveApiRequest({
    resourceType: 'xhr',
    url: 'https://api.other.example/api/config',
    requestHeaders: { 'sec-fetch-site': 'cross-site' }
  }), false, 'cross-site fetch metadata is never changed');
  assert.equal(isLiveApiRequest({ resourceType: 'image', url: 'https://birthday.example/api/poster' }), false);
  assert.equal(isLiveApiRequest({ resourceType: 'xhr', method: 'POST', url: 'https://birthday.example/api/answer' }), false);
  assert.deepEqual(withLiveApiRequestHeaders({ Authorization: 'Bearer kept', Pragma: 'cached' }), {
    Authorization: 'Bearer kept',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  });
});

test('media compatibility: failed decorative backdrop retries JPEG, then hides the glyph over the site theme color', () => {
  const listeners = new Map();
  const styleValues = new Map();
  const parentStyle = new Map();
  const attrs = new Map([['alt', 'Background artwork'], ['src', 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/hero.heic']]);
  let currentSource = attrs.get('src');

  const parent = {
    parentElement: null,
    style: { setProperty(name, value) { parentStyle.set(name, value); } },
    getBoundingClientRect: () => ({ width: 1200, height: 800 })
  };
  const image = {
    tagName: 'IMG',
    complete: true,
    naturalWidth: 0,
    isConnected: true,
    parentElement: parent,
    get currentSrc() { return currentSource; },
    set currentSrc(value) { currentSource = value; },
    get src() { return currentSource; },
    set src(value) { currentSource = value; attrs.set('src', value); },
    style: {
      setProperty(name, value) { styleValues.set(name, value); },
      removeProperty(name) { styleValues.delete(name); }
    },
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    // Chromium can collapse a failed full-screen image to its tiny broken
    // glyph; the still-full parent must therefore drive backdrop detection.
    getBoundingClientRect: () => ({ width: 22, height: 22 }),
    querySelectorAll: () => []
  };
  const meta = { getAttribute(name) { return name === 'content' ? '#08080c' : null; } };
  const documentElement = {
    clientWidth: 1200,
    clientHeight: 800,
    querySelectorAll: () => []
  };
  const document = {
    documentElement,
    querySelectorAll(selector) {
      if (selector === 'meta[name="theme-color"]') return [meta];
      if (selector === 'img') return [image];
      return [];
    },
    createElement() { return { style: {} }; }
  };
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: () => ({ matches: true }),
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); }
  };
  window.window = window;
  window.document = document;

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  const context = vm.createContext({
    window,
    document,
    URL,
    MutationObserver,
    setTimeout(callback) { callback(); return 1; }
  });
  vm.runInContext(buildMediaCompatibilityScript(), context);

  assert.match(currentSource, /f_jpg/, 'an undecodable WebP/auto image gets one broadly compatible JPEG attempt');
  assert.equal(styleValues.has('visibility'), false, 'the retry remains paintable');

  // The retry fails too: no broken-image face remains, and a full-screen
  // decorative backdrop falls back to the site's own declared theme color.
  listeners.get('error')({ target: image });
  assert.equal(styleValues.get('visibility'), 'hidden');
  assert.equal(attrs.get('data-yayra-media-failed'), 'true');
  assert.equal(parentStyle.get('background-color'), '#08080c');
});

test('media compatibility: ordinary failures cannot recolor a viewport ancestor and bright theme accents cannot become backdrops', () => {
  const runFailure = ({
    alt,
    className = '',
    imageRect,
    parentRect = { width: 1200, height: 800 },
    computedPosition = 'static',
    computedObjectFit = 'contain',
    themeColor
  }) => {
    const listeners = new Map();
    const imageStyle = new Map();
    const parentStyle = new Map();
    const viewportStyle = new Map();
    const attrs = new Map([['alt', alt], ['src', 'https://assets.example.invalid/missing.png']]);
    const viewport = {
      parentElement: null,
      style: { setProperty(name, value) { viewportStyle.set(name, value); } },
      getBoundingClientRect: () => ({ width: 1200, height: 800 })
    };
    const parent = {
      parentElement: viewport,
      style: { setProperty(name, value) { parentStyle.set(name, value); } },
      getBoundingClientRect: () => parentRect
    };
    const image = {
      tagName: 'IMG',
      className,
      parentElement: parent,
      currentSrc: attrs.get('src'),
      src: attrs.get('src'),
      style: {
        setProperty(name, value) { imageStyle.set(name, value); },
        removeProperty(name) { imageStyle.delete(name); }
      },
      getAttribute(name) { return attrs.get(name) ?? null; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      removeAttribute(name) { attrs.delete(name); },
      removeEventListener() {},
      getBoundingClientRect: () => imageRect
    };
    const meta = { getAttribute(name) { return name === 'content' ? themeColor : null; } };
    const documentElement = { clientWidth: 1200, clientHeight: 800, querySelectorAll: () => [] };
    const document = {
      documentElement,
      body: null,
      getElementById() { return null; },
      querySelectorAll(selector) {
        if (selector === 'meta[name="theme-color"]') return [meta];
        return [];
      },
      createElement() { return { style: {} }; }
    };
    const window = {
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: () => ({ matches: true }),
      addEventListener(type, handler) { listeners.set(type, handler); },
      removeEventListener(type) { listeners.delete(type); }
    };
    window.window = window;
    window.document = document;
    class MutationObserver { observe() {} disconnect() {} }

    vm.runInContext(buildMediaCompatibilityScript(), vm.createContext({
      window,
      document,
      URL,
      MutationObserver,
      getComputedStyle: () => ({
        position: computedPosition,
        objectFit: computedObjectFit,
        width: computedPosition === 'absolute' ? '100%' : `${imageRect.width}px`,
        height: computedPosition === 'absolute' ? '100%' : `${imageRect.height}px`,
        color: 'rgb(15, 23, 42)',
        backgroundColor: 'rgba(0, 0, 0, 0)'
      }),
      setTimeout(callback) { callback(); return 1; },
      clearTimeout() {}
    }));
    listeners.get('error')({ target: image });
    return { attrs, imageStyle, parentStyle, viewportStyle };
  };

  const ordinary = runFailure({
    alt: 'RX Store product icon',
    className: 'absolute inset-0 w-full h-full object-cover rounded-lg',
    imageRect: { width: 64, height: 64 },
    parentRect: { width: 180, height: 180 },
    computedPosition: 'absolute',
    computedObjectFit: 'cover',
    themeColor: '#08080c'
  });
  assert.equal(ordinary.parentStyle.has('background-color'), false, 'an ordinary card wrapper stays site-owned');
  assert.equal(
    ordinary.viewportStyle.has('background-color'),
    false,
    'a failed card image does not inherit backdrop status from its full-screen app shell'
  );
  assert.equal(ordinary.imageStyle.has('visibility'), false, 'its meaningful alt fallback remains visible');
  assert.equal(ordinary.attrs.has('data-yayra-media-failed'), false);

  const brightBackdrop = runFailure({
    alt: 'Background artwork',
    className: 'absolute inset-0 object-cover',
    imageRect: { width: 22, height: 22 },
    themeColor: '#FFD600'
  });
  assert.equal(brightBackdrop.imageStyle.get('visibility'), 'hidden', 'the decorative broken glyph is still retired');
  assert.equal(brightBackdrop.attrs.get('data-yayra-media-failed'), 'true');
  assert.equal(
    brightBackdrop.parentStyle.has('background-color'),
    false,
    'a bright browser/brand theme colour is never promoted to a full-page image fallback'
  );
});

test('media compatibility: site-declared dark theme heals white-on-white full-page fallback without touching page text', () => {
  const applied = new Map();
  const makeSurface = (name, parentElement = null) => ({
    name,
    parentElement,
    style: { setProperty(property, value) { applied.set(`${name}:${property}`, value); } },
    getBoundingClientRect: () => ({ width: 1200, height: 800 })
  });
  const html = makeSurface('html');
  const body = makeSurface('body', html);
  const root = makeSurface('root', body);
  const page = makeSurface('page', root);
  body.firstElementChild = root;
  root.firstElementChild = page;
  const heading = {
    textContent: 'Which lecture theatre did we meet for the first time?',
    parentElement: page,
    getBoundingClientRect: () => ({ width: 500, height: 80 })
  };
  const meta = { getAttribute(name) { return name === 'content' ? '#08080c' : null; } };
  const document = {
    documentElement: Object.assign(html, { clientWidth: 1200, clientHeight: 800 }),
    body,
    getElementById(id) { return id === 'root' ? root : null; },
    querySelectorAll(selector) {
      if (selector === 'meta[name="theme-color"]') return [meta];
      if (selector === 'h1,h2,h3,h4,p,label,button,[role="heading"]') return [heading];
      if (selector === '#root > *,#app,#app > *,body > main,body > [style]') return [page];
      return [];
    },
    createElement() { return { style: {} }; }
  };
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    removeEventListener() {}
  };
  window.window = window;
  window.document = document;
  class MutationObserver { observe() {} disconnect() {} }
  const getComputedStyle = (element) => element === heading
    ? { color: 'rgb(255, 255, 255)', backgroundColor: 'rgba(0, 0, 0, 0)' }
    : element === root
      ? { color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)' }
      : { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)' };

  vm.runInContext(buildMediaCompatibilityScript(), vm.createContext({
    window,
    document,
    URL,
    MutationObserver,
    getComputedStyle,
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {}
  }));

  assert.equal(applied.get('html:background-color'), '#08080c');
  assert.equal(applied.get('body:background-color'), '#08080c');
  assert.equal(applied.get('root:background-color'), '#08080c');
  assert.equal(applied.get('page:background-color'), '#08080c', 'the actual React full-page child is healed too');
  assert.equal(heading.textContent, 'Which lecture theatre did we meet for the first time?');
});

test('media compatibility: gradient text gets prefixed clipping or a readable solid fallback instead of a painted rectangle', () => {
  const runCase = ({ acceptsTextClip, acceptsPrefixedOnly = false, transparent = true, className = 'gradient-text bg-clip-text text-transparent' }) => {
    const applied = new Map();
    const attrs = new Map();
    let textIsTransparent = transparent;
    let currentClassName = className;
    let observerCallback = null;
    const parent = { parentElement: null };
    const element = {
      nodeType: 1,
      get className() { return currentClassName; },
      parentElement: parent,
      style: {
        getPropertyValue(name) { return applied.get(name) || ''; },
        getPropertyPriority(name) { return applied.has(name) ? 'important' : ''; },
        setProperty(name, value) { applied.set(name, value); },
        removeProperty(name) { applied.delete(name); }
      },
      getAttribute(name) { return attrs.get(name) ?? null; },
      setAttribute(name, value) { attrs.set(name, value); },
      removeAttribute(name) { attrs.delete(name); },
      matches() { return /(?:gradient-text|bg-clip-text|text-transparent)/.test(currentClassName); },
      querySelectorAll() { return []; }
    };
    const documentElement = { clientWidth: 1200, clientHeight: 800, querySelectorAll: () => [] };
    const body = { parentElement: documentElement, firstElementChild: element };
    const document = {
      documentElement,
      body,
      getElementById() { return null; },
      querySelectorAll(selector) {
        if (selector === '.gradient-text,[class*="gradient-text"],[class~="bg-clip-text"],[class~="text-transparent"]') return [element];
        return [];
      },
      createElement() { return { style: {} }; }
    };
    const window = {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: true })
    };
    window.window = window;
    window.document = document;
    class MutationObserver {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    }
    const getComputedStyle = (target) => {
      if (target === element) {
        const requestedClip = applied.get('background-clip') || 'border-box';
        return {
          backgroundImage: applied.get('background-image') || 'linear-gradient(90deg, rgb(255, 210, 0), rgb(255, 255, 255))',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          backgroundClip: acceptsTextClip ? requestedClip : 'border-box',
          webkitBackgroundClip: (acceptsTextClip || acceptsPrefixedOnly) ? requestedClip : 'border-box',
          color: applied.get('color') || (textIsTransparent ? 'rgba(0, 0, 0, 0)' : 'rgb(20, 30, 40)'),
          webkitTextFillColor: applied.get('-webkit-text-fill-color') || (textIsTransparent ? 'transparent' : 'rgb(20, 30, 40)')
        };
      }
      if (target === parent) return { color: 'rgb(15, 23, 42)', backgroundColor: 'rgb(255, 255, 255)' };
      return { color: 'rgb(15, 23, 42)', backgroundColor: 'rgb(255, 255, 255)' };
    };

    vm.runInContext(buildMediaCompatibilityScript(), vm.createContext({
      window,
      document,
      URL,
      MutationObserver,
      getComputedStyle,
      setTimeout(callback) { callback(); return 1; },
      clearTimeout() {}
    }));
    return {
      applied,
      attrs,
      makeTransparent() {
        textIsTransparent = true;
        observerCallback?.([{ type: 'attributes', target: element, addedNodes: [] }]);
      },
      removeIntent() {
        currentClassName = 'plain-heading';
        observerCallback?.([{ type: 'attributes', target: element, addedNodes: [] }]);
      }
    };
  };

  const supported = runCase({ acceptsTextClip: true });
  assert.equal(supported.applied.get('-webkit-background-clip'), 'text');
  assert.equal(supported.applied.get('background-clip'), 'text');
  assert.equal(supported.applied.get('-webkit-text-fill-color'), 'currentColor', 'the fill follows later site colour changes');
  assert.equal(supported.applied.has('background-image'), false, 'a working gradient remains authored by the site');
  assert.equal(supported.attrs.get('data-yayra-gradient-text'), 'clip');
  supported.removeIntent();
  assert.equal(supported.applied.size, 0, 'prefixed compatibility styles are reversible when intent is removed');

  const prefixed = runCase({ acceptsTextClip: false, acceptsPrefixedOnly: true });
  assert.equal(prefixed.applied.has('background-image'), false, 'a prefixed-only engine keeps the gradient rather than falling back');
  assert.equal(prefixed.attrs.get('data-yayra-gradient-text'), 'clip');

  const unsupported = runCase({ acceptsTextClip: false });
  assert.equal(unsupported.applied.get('background-image'), 'none', 'the box-filling gradient is retired');
  assert.equal(unsupported.applied.get('background-color'), 'transparent');
  assert.equal(unsupported.applied.get('color'), 'rgb(15, 23, 42)', 'the readable inherited foreground is preserved');
  assert.equal(unsupported.applied.get('-webkit-text-fill-color'), 'rgb(15, 23, 42)');
  assert.equal(unsupported.attrs.get('data-yayra-gradient-text'), 'solid');

  const opaque = runCase({ acceptsTextClip: false, transparent: false });
  assert.equal(opaque.applied.has('background-image'), false, 'ordinary opaque gradient boxes are never rewritten');
  assert.equal(opaque.attrs.has('data-yayra-gradient-text'), false);
  opaque.makeTransparent();
  assert.equal(opaque.applied.get('background-image'), 'none', 'a later framework class/style transition is repaired without reloading');
  assert.equal(opaque.attrs.get('data-yayra-gradient-text'), 'solid');
  opaque.removeIntent();
  assert.equal(opaque.applied.size, 0, 'removing text-clip intent restores the site’s original inline styles');
  assert.equal(opaque.attrs.has('data-yayra-gradient-text'), false);

  const decorative = runCase({ acceptsTextClip: false, className: 'text-transparent decorative-overlay' });
  assert.equal(decorative.applied.size, 0, 'transparent decorative gradient layers without text-clip intent remain site-owned');
  assert.equal(decorative.attrs.has('data-yayra-gradient-text'), false);
});

test('media compatibility: document-start preload catches failures before site frameworks can remove the backdrop', () => {
  const preload = readFileSync(new URL('../electron/autofillPreload.cjs', import.meta.url), 'utf8');
  const start = preload.indexOf("const installKey = '__yayraEarlyMediaCompatibilityV3'");
  const block = preload.slice(start, start + 7000);
  assert.ok(start > -1, 'document-start media guard exists');
  assert.match(block, /context|jpegCloudinaryUrl|f_jpg/);
  assert.match(block, /event\.stopImmediatePropagation\?\.\(\)/, 'the first safe retry survives React/Vue onError unmounting');
  assert.match(block, /safeBackdropThemeColor/, 'browser theme colours are screened before becoming page paint');
  assert.match(block, /brightness <= 0\.42 && chroma <= 0\.35 \? color : ''/, 'only a proven dark, low-chroma theme surface is eligible');
  assert.doesNotMatch(
    block,
    /if \(coversViewport\(target\)\) \{ backdrop = true/,
    'a generic viewport ancestor cannot promote an ordinary failed image to backdrop status'
  );
  assert.doesNotMatch(block, /\|h-full\|w-full/, 'broad sizing utilities are not backdrop evidence');
  assert.match(block, /data-yayra-media-failed/, 'the broken-image glyph is retired');
});

test('media compatibility: meaningful ordinary broken images retain their alt fallback', () => {
  const script = buildMediaCompatibilityScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /String\(image\.getAttribute\('alt'\)/);
  assert.match(script, /if \(String\(image\.getAttribute\('alt'\) \|\| ''\)\.trim\(\) && !isBackdrop\) return;/);
  assert.match(script, /data-yayra-media-failed/);
  assert.match(script, /meta\[name="theme-color"\]/);
});
