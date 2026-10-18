import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  GOOGLE_LENS_MAX_BYTES,
  buildGoogleLensUploadUrl,
  uploadGoogleLensImage
} = require('../electron/googleFeatures.cjs');

test('Google Lens: native uploads use Chromium current endpoint contract and multipart image field', async () => {
  let request = null;
  const result = await uploadGoogleLensImage({
    netFetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        url: 'https://lens.google.com/search?p=direct-result'
      };
    },
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    name: 'camera.png',
    type: 'image/png',
    language: 'en-GH',
    startedAt: 123456
  });

  assert.deepEqual(result, { ok: true, url: 'https://lens.google.com/search?p=direct-result' });
  const endpoint = new URL(request.url);
  assert.equal(endpoint.origin + endpoint.pathname, 'https://lens.google.com/v3/upload');
  assert.equal(endpoint.searchParams.get('ep'), 'cntpubb');
  assert.equal(endpoint.searchParams.get('hl'), 'en-GH');
  assert.equal(endpoint.searchParams.get('st'), '123456');
  assert.equal(endpoint.searchParams.get('re'), 'df');
  assert.equal(endpoint.searchParams.get('s'), '4');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'follow');
  const image = request.options.body.get('encoded_image');
  assert.equal(image.type, 'image/png');
  assert.equal(image.name, 'camera.png');
  assert.equal(image.size, 4);
});

test('Google Lens: native transport rejects unsafe payloads and non-Google result URLs', async () => {
  const unsupported = await uploadGoogleLensImage({
    netFetch: async () => { throw new Error('must not fetch'); },
    data: new Uint8Array([1]),
    name: 'notes.txt',
    type: 'text/plain'
  });
  assert.equal(unsupported.reason, 'unsupported-file-type');

  const tooLarge = await uploadGoogleLensImage({
    netFetch: async () => { throw new Error('must not fetch'); },
    data: new Uint8Array(GOOGLE_LENS_MAX_BYTES + 1),
    name: 'large.png',
    type: 'image/png'
  });
  assert.equal(tooLarge.reason, 'file-too-large');

  const untrustedRedirect = await uploadGoogleLensImage({
    netFetch: async () => ({ ok: true, status: 200, url: 'https://example.com/stolen' }),
    data: new Uint8Array([1]),
    name: 'safe.png',
    type: 'image/png'
  });
  assert.equal(untrustedRedirect.ok, false);

  const authRedirect = await uploadGoogleLensImage({
    netFetch: async () => ({ ok: true, status: 200, url: 'https://accounts.google.com/o/oauth2/auth' }),
    data: new Uint8Array([1]),
    name: 'safe.png',
    type: 'image/png'
  });
  assert.equal(authRedirect.ok, false, 'Lens cannot redirect into the external OAuth handoff path');
});

test('Google Lens: URL builder normalizes invalid locale input', () => {
  const url = new URL(buildGoogleLensUploadUrl({ language: 'not a locale!', startedAt: 42 }));
  assert.equal(url.searchParams.get('hl'), 'en-US');
  assert.equal(url.searchParams.get('st'), '42');
});

test('Desktop Google features: Lens upload is connected but external Voice/Lens handoff IPC does not exist', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('yayra:google-lens-upload'/);
  assert.match(preload, /googleLensUpload:[\s\S]*yayra:google-lens-upload/);
  assert.doesNotMatch(main, /yayra:open-google-feature/,
    'main process cannot launch Voice or Lens in the system browser');
  assert.doesNotMatch(preload, /openGoogleFeature|yayra:open-google-feature/,
    'renderer is not exposed an external Google-feature launcher');
});

test('Android Google features: native speech result and direct Lens upload are wired into the Capacitor plugin', () => {
  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../packages/platform-packaging/android/AndroidManifest.xml', import.meta.url), 'utf8');
  const ensureScript = readFileSync(new URL('../scripts/ensure-capacitor-platform.mjs', import.meta.url), 'utf8');
  assert.match(plugin, /RecognizerIntent\.ACTION_RECOGNIZE_SPEECH/);
  assert.match(plugin, /@ActivityCallback[\s\S]*googleVoiceSearchResult/);
  assert.match(plugin, /fun googleLensUpload\(call: PluginCall\)/);
  assert.match(plugin, /https:\/\/lens\.google\.com\/v3\/upload/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(ensureScript, /android\.permission\.RECORD_AUDIO/);
});
