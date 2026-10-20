import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMediaCompatibilityScript,
  forceCloudinaryImageFormat,
  installMediaCompatibility,
  rewriteCloudinaryImageUrl
} = require('../electron/mediaCompatibility.cjs');

test('media compatibility: Cloudinary auto images use deterministic WebP while preserving transforms and query data', () => {
  const source = 'https://res.cloudinary.com/demo/image/upload/q_auto,f_auto:good,c_scale,w_1600/folder/hero.heic?version=7';
  assert.equal(
    rewriteCloudinaryImageUrl(source),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_webp,c_scale,w_1600/folder/hero.heic?version=7'
  );
  assert.equal(
    forceCloudinaryImageFormat(source, 'jpg'),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_jpg,c_scale,w_1600/folder/hero.heic?version=7'
  );
});

test('media compatibility: raw HEIC is transcoded but signed, explicit, video and unrelated URLs are untouched', () => {
  assert.equal(
    rewriteCloudinaryImageUrl('https://res.cloudinary.com/demo/image/upload/v42/folder/photo.HEIC'),
    'https://res.cloudinary.com/demo/image/upload/q_auto,f_webp/v42/folder/photo.HEIC'
  );
  for (const url of [
    'https://res.cloudinary.com/demo/image/upload/s--signed-token--/f_auto/folder/photo.jpg',
    'https://res.cloudinary.com/demo/image/upload/f_webp/folder/photo.heic',
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
  const session = {
    webRequest: {
      onBeforeRequest(nextFilter, nextListener) {
        registrations += 1;
        filter = nextFilter;
        listener = nextListener;
      }
    }
  };

  assert.equal(installMediaCompatibility(session), true);
  assert.equal(installMediaCompatibility(session), true);
  assert.equal(registrations, 1, 'a shared profile Session never stacks listeners');
  assert.deepEqual(filter.urls, ['https://res.cloudinary.com/*', 'http://res.cloudinary.com/*']);

  let response = null;
  listener({
    resourceType: 'image',
    url: 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/background.heic'
  }, (value) => { response = value; });
  assert.deepEqual(response, {
    redirectURL: 'https://res.cloudinary.com/demo/image/upload/f_webp,q_auto/background.heic'
  });

  listener({
    resourceType: 'script',
    url: 'https://res.cloudinary.com/demo/image/upload/f_auto/app.js'
  }, (value) => { response = value; });
  assert.deepEqual(response, {}, 'scripts/documents are never redirected');
});

test('media compatibility: failed decorative backdrop retries JPEG, then hides the glyph over the site theme color', () => {
  const listeners = new Map();
  const styleValues = new Map();
  const parentStyle = new Map();
  const attrs = new Map([['alt', ''], ['src', 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/hero.heic']]);
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

test('media compatibility: meaningful broken images retain their alt fallback', () => {
  const script = buildMediaCompatibilityScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /String\(image\.getAttribute\('alt'\)/);
  assert.match(script, /if \(String\(image\.getAttribute\('alt'\) \|\| ''\)\.trim\(\)\) return;/);
  assert.match(script, /data-yayra-media-failed/);
  assert.match(script, /meta\[name="theme-color"\]/);
});
