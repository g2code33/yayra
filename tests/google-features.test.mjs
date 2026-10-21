import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  GOOGLE_LENS_MAX_BYTES,
  buildGoogleLensUploadUrl,
  isGoogleLensPickerUrl,
  requestGoogleLensWithElectronNet,
  searchGoogleLensImageUrl,
  uploadGoogleLensImage
} = require('../electron/googleFeatures.cjs');

const resultResponse = (url, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: () => null }
});

test('Google Lens: Electron captures the exact redirect instead of relying on net.fetch Response.url', async () => {
  let requestOptions = null;
  let requestBody = null;
  let followed = false;
  class FakeClientRequest extends EventEmitter {
    end(body) {
      requestBody = body;
      queueMicrotask(() => this.emit(
        'redirect',
        303,
        'GET',
        'https://lens.google.com/search?p=real-result',
        { location: ['https://lens.google.com/search?p=real-result'] }
      ));
    }
    followRedirect() { followed = true; }
    abort() {}
  }

  const result = await uploadGoogleLensImage({
    requestTransport: (url, options) => requestGoogleLensWithElectronNet({
      createRequest: (nextOptions) => {
        requestOptions = nextOptions;
        return new FakeClientRequest();
      },
      url,
      options,
      timeoutMs: 2_000
    }),
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    name: 'camera.png',
    type: 'image/png',
    width: 640,
    height: 480
  });

  assert.deepEqual(result, { ok: true, url: 'https://lens.google.com/search?p=real-result' });
  assert.equal(requestOptions.redirect, 'manual');
  assert.equal(requestOptions.credentials, 'include');
  assert.match(requestOptions.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.equal(Buffer.isBuffer(requestBody), true);
  assert.match(requestBody.toString('latin1'), /name="encoded_image"; filename="camera.png"/);
  assert.match(requestBody.toString('latin1'), /name="processed_image_dimensions"[\s\S]*640,480/);
  assert.equal(followed, false, 'the hidden request must not download the Lens result page');
});

test('Google Lens: native uploads use the current direct-search contract and completed result URL', async () => {
  let request = null;
  const result = await uploadGoogleLensImage({
    netFetch: async (url, options) => {
      request = { url, options };
      return resultResponse('https://lens.google.com/search?p=direct-result');
    },
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    name: 'camera.png',
    type: 'image/png',
    language: 'en-GH',
    startedAt: 123456,
    width: 640,
    height: 480,
    viewportWidth: 1440,
    viewportHeight: 900,
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'
  });

  assert.deepEqual(result, { ok: true, url: 'https://lens.google.com/search?p=direct-result' });
  const endpoint = new URL(request.url);
  assert.equal(endpoint.origin + endpoint.pathname, 'https://lens.google.com/v3/upload');
  assert.equal(endpoint.searchParams.get('ep'), 'ccm');
  assert.equal(endpoint.searchParams.get('hl'), 'en-GH');
  assert.equal(endpoint.searchParams.get('st'), '123456');
  assert.equal(endpoint.searchParams.get('vpw'), '1440');
  assert.equal(endpoint.searchParams.get('vph'), '900');
  assert.equal(endpoint.searchParams.has('re'), false);
  assert.equal(endpoint.searchParams.has('s'), false);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'follow', 'Chromium transport follows into a completed result URL');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.headers['User-Agent'], 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36');
  assert.equal(request.options.headers['Accept-Language'], 'en-GH');
  const image = request.options.body.get('encoded_image');
  assert.equal(image.type, 'image/png');
  assert.equal(image.name, 'camera.png');
  assert.equal(image.size, 4);
  assert.equal(request.options.body.get('processed_image_dimensions'), '640,480');
});

test('Google Lens: image URLs are executed natively and empty upload pickers are rejected', async () => {
  let request = null;
  const direct = await searchGoogleLensImageUrl({
    netFetch: async (url, options) => {
      request = { url, options };
      return resultResponse('https://www.google.com/search?vsrid=image-token');
    },
    imageUrl: 'https://images.example/cat.jpg',
    language: 'en-GH',
    startedAt: 99,
    viewportWidth: 800,
    viewportHeight: 600
  });
  assert.deepEqual(direct, { ok: true, url: 'https://www.google.com/search?vsrid=image-token' });
  const endpoint = new URL(request.url);
  assert.equal(endpoint.origin + endpoint.pathname, 'https://lens.google.com/uploadbyurl');
  assert.equal(endpoint.searchParams.get('url'), 'https://images.example/cat.jpg');
  assert.equal(endpoint.searchParams.get('ep'), 'ccm');
  assert.equal(request.options.redirect, 'follow');

  const picker = await searchGoogleLensImageUrl({
    netFetch: async () => resultResponse('https://www.google.com/?olud='),
    imageUrl: 'https://images.example/cat.jpg'
  });
  assert.deepEqual(picker, { ok: false, reason: 'google-no-result' });
  assert.equal(isGoogleLensPickerUrl('https://www.google.com/?olud='), true);
  assert.equal(isGoogleLensPickerUrl('https://www.google.com/'), true);
  assert.equal(isGoogleLensPickerUrl('https://lens.google.com/'), true);
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
    netFetch: async () => resultResponse('https://example.com/stolen'),
    data: new Uint8Array([1]),
    name: 'safe.png',
    type: 'image/png'
  });
  assert.equal(untrustedRedirect.ok, false);

  const authRedirect = await uploadGoogleLensImage({
    netFetch: async () => resultResponse('https://accounts.google.com/o/oauth2/auth'),
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
  assert.match(main, /searchGoogleLensImageUrl/);
  assert.match(main, /session\.fromPartition\(partition\)/,
    'Lens uses the destination tab session so Google result cookies are retained');
  assert.match(main, /requestGoogleLensWithElectronNet/,
    'desktop Lens captures ClientRequest redirect events');
  assert.match(main, /net\.request\(\{ \.\.\.requestOptions, session: tabSession \}\)/,
    'Lens requests use the destination tab Chromium session');
  assert.doesNotMatch(main, /tabSession\.fetch\(/,
    'Lens must not rely on Electron’s documented-incorrect fetch Response.url');
  assert.match(preload, /googleLensUpload:[\s\S]*yayra:google-lens-upload/);
  assert.doesNotMatch(main, /yayra:open-google-feature/,
    'main process cannot launch Voice or Lens in the system browser');
  assert.doesNotMatch(preload, /openGoogleFeature|yayra:open-google-feature/,
    'renderer is not exposed an external Google-feature launcher');
});

test('Android Google features: runtime mic approval and direct Lens results are wired into the plugin', () => {
  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../packages/platform-packaging/android/AndroidManifest.xml', import.meta.url), 'utf8');
  const ensureScript = readFileSync(new URL('../scripts/ensure-capacitor-platform.mjs', import.meta.url), 'utf8');
  assert.match(plugin, /Permission\(alias = "microphone", strings = \[Manifest\.permission\.RECORD_AUDIO\]\)/);
  assert.match(plugin, /requestPermissionForAlias\("microphone"/);
  assert.match(plugin, /@PermissionCallback[\s\S]*googleVoiceMicrophonePermissionResult/);
  assert.match(plugin, /RecognizerIntent\.ACTION_RECOGNIZE_SPEECH/);
  assert.match(plugin, /@ActivityCallback[\s\S]*googleVoiceSearchResult/);
  assert.match(plugin, /fun googleLensUpload\(call: PluginCall\)/);
  assert.match(plugin, /https:\/\/lens\.google\.com\/v3\/upload/);
  assert.match(plugin, /https:\/\/lens\.google\.com\/uploadbyurl/);
  assert.match(plugin, /instanceFollowRedirects = false/);
  assert.match(plugin, /processed_image_dimensions/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(ensureScript, /android\.permission\.RECORD_AUDIO/);
});
