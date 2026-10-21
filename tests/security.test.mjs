import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContentSecurityPolicy, DESKTOP_CUSTOM_SCHEME } from '../src/security/csp.js';
import { isJavaScriptMime, mimeTypeFor, normalizeAssetPath } from '../src/security/localAssets.js';

test('CSP is pinned to self, exact hosts, and desktop custom scheme', () => {
  const csp = buildContentSecurityPolicy();
  assert.match(csp, /default-src 'self' yayra:/);
  assert.match(csp, /script-src 'self' yayra:/);
  assert.match(csp, /worker-src 'self' blob: yayra:/, 'offline PDF.js workers work on both the app scheme and file fallback');
  assert.match(csp, /style-src 'self' 'unsafe-inline' yayra:/);
  assert.match(csp, /img-src 'self' data: blob: yayra: https:\/\/yayra\.pages\.dev https:\/\/icons\.duckduckgo\.com https:\/\/lh3\.googleusercontent\.com/);
  assert.match(csp, /media-src 'self' blob: yayra:/, 'embedded PPTX video can play only from same-origin or local in-memory blobs');
  assert.match(csp, /connect-src 'self' yayra: https:\/\/yayra-updates-api\.g2code335\.workers\.dev/);
  assert.match(csp, /form-action 'self' https:\/\/lens\.google\.com/,
    'local image files can post directly to Google Lens without passing through Yayra');
  assert.equal(DESKTOP_CUSTOM_SCHEME, 'yayra');
});

test('web/PWA deployment explicitly allows user-initiated same-origin microphone access', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const devServer = readFileSync(new URL('../scripts/dev-server.mjs', import.meta.url), 'utf8');
  assert.match(headers, /Permissions-Policy:\s*microphone=\(self\)/);
  assert.match(devServer, /setHeader\('Permissions-Policy', 'microphone=\(self\)'\)/);
});

test('local asset serving refuses traversal and preserves JS MIME type', () => {
  assert.equal(normalizeAssetPath('/../secret'), null);
  assert.equal(normalizeAssetPath('/%2e%2e/secret'), null);
  assert.equal(normalizeAssetPath('/..%5csecret'), null);
  assert.equal(normalizeAssetPath('/'), '/index.html');
  assert.equal(mimeTypeFor('/src/browser/main.js'), 'text/javascript; charset=utf-8');
  assert.equal(isJavaScriptMime(mimeTypeFor('/src/browser/main.js')), true);
});
