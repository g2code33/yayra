import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

async function makeShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false, initialUrl: 'yayra://newtab' });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('Google service preview errors explain how to repair missing scopes and disabled APIs', async () => {
  const { shell } = await makeShell();
  try {
    assert.match(shell.formatGoogleServiceError('drive', 'service_scope_required'), /read-only Drive permission/);
    assert.match(shell.formatGoogleServiceError('drive', 'google_services_reconnect_required'), /Reconnect Google services/);
    assert.match(shell.formatGoogleServiceError('drive', 'google_service_permission_denied'), /enable Google Drive API/);
  } finally {
    shell.destroy();
  }
});

test('Voice Search fallback and results stay in the active Yayra tab without window.open', async () => {
  const previousOpen = window.open;
  const previousRecognition = window.SpeechRecognition;
  const previousWebkitRecognition = window.webkitSpeechRecognition;
  const previousYayra = window.yayra;
  const previousCapacitor = window.Capacitor;
  let externalOpens = 0;
  window.open = () => { externalOpens += 1; return {}; };
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  delete window.yayra;
  delete window.Capacitor;

  const { shell, container } = await makeShell();
  try {
    container.querySelector('.fb-newtab-mic-btn').click();
    const voice = container.querySelector('.fb-google-voice-overlay');
    assert.ok(voice, 'voice surface opens inside Yayra');
    assert.equal(voice.querySelector('.fb-google-voice-status').textContent, 'Voice recognition is unavailable here');
    voice.querySelector('.fb-google-voice-google-btn').click();

    assert.equal(shell.getActiveTab().url, 'https://www.google.com/');
    assert.equal(shell._inAppOnlyGoogleTabs.has(shell.getActiveTab().id), true);
    assert.equal(externalOpens, 0, 'unsupported voice search never launches another browser');
    assert.ok(container.querySelector('.fb-google-in-app-only-fallback'),
      'plain web/PWA keeps an honest in-Yayra card when Google blocks framing');

    shell.navigateActiveTab('yayra://newtab');
    assert.equal(shell._inAppOnlyGoogleTabs.has(shell.getActiveTab().id), false,
      'leaving Google clears the feature-only routing marker');
  } finally {
    shell.destroy();
    if (previousOpen === undefined) delete window.open; else window.open = previousOpen;
    if (previousRecognition === undefined) delete window.SpeechRecognition; else window.SpeechRecognition = previousRecognition;
    if (previousWebkitRecognition === undefined) delete window.webkitSpeechRecognition; else window.webkitSpeechRecognition = previousWebkitRecognition;
    if (previousYayra === undefined) delete window.yayra; else window.yayra = previousYayra;
    if (previousCapacitor === undefined) delete window.Capacitor; else window.Capacitor = previousCapacitor;
  }
});


test('Voice Search asks for audio-only permission before recognition and fails closed when denied', async () => {
  const previousRecognition = window.SpeechRecognition;
  const previousMediaDevices = navigator.mediaDevices;
  const previousCapacitor = window.Capacitor;
  let recognitionConstructions = 0;
  let permissionRequests = 0;
  delete window.Capacitor;
  window.SpeechRecognition = class FakeRecognition {
    constructor() { recognitionConstructions += 1; }
    start() {}
    abort() {}
  };
  navigator.mediaDevices = {
    getUserMedia: async (constraints) => {
      permissionRequests += 1;
      assert.deepEqual(constraints, { audio: true });
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      throw error;
    }
  };

  const { shell, container } = await makeShell();
  try {
    container.querySelector('.fb-newtab-mic-btn').click();
    const voice = container.querySelector('.fb-google-voice-overlay');
    assert.equal(voice.querySelector('.fb-google-voice-status').textContent, 'Requesting microphone permission…');
    await flush();
    assert.equal(permissionRequests, 1);
    assert.equal(recognitionConstructions, 0, 'speech recognition is never created before permission is granted');
    assert.equal(voice.querySelector('.fb-google-voice-status').textContent, 'Microphone access is blocked');
    assert.match(voice.querySelector('.fb-google-voice-help').textContent, /Allow microphone access/);
    assert.equal(shell.getActiveTab().url, 'yayra://newtab');
  } finally {
    shell.destroy();
    if (previousRecognition === undefined) delete window.SpeechRecognition;
    else window.SpeechRecognition = previousRecognition;
    if (previousMediaDevices === undefined) delete navigator.mediaDevices;
    else navigator.mediaDevices = previousMediaDevices;
    if (previousCapacitor === undefined) delete window.Capacitor;
    else window.Capacitor = previousCapacitor;
  }
});

test('Lens processes each supplied file/URL directly and never falls back to an empty picker', async () => {
  const previousOpen = window.open;
  const previousYayra = window.yayra;
  const previousCapacitor = window.Capacitor;
  let externalOpens = 0;
  let nativeMode = 'fail';
  const nativeCalls = [];
  window.open = () => { externalOpens += 1; return {}; };
  delete window.Capacitor;
  window.yayra = {
    system: {
      googleLensUpload: async (payload) => {
        nativeCalls.push(payload);
        if (nativeMode === 'fail') return { ok: false, reason: 'google-no-result' };
        if (nativeMode === 'url-success') {
          return { ok: true, url: 'https://www.google.com/search?vsrid=url-result' };
        }
        return { ok: true, url: 'https://lens.google.com/search?p=file-result' };
      }
    }
  };

  const { shell, container } = await makeShell();
  shell.showTransientNotice = () => {};
  try {
    container.querySelector('.fb-newtab-lens-btn').click();
    let lens = container.querySelector('.fb-google-lens-overlay');
    const form = lens.querySelector('.fb-google-lens-upload-form');
    assert.equal(form.getAttribute('target'), null);
    assert.equal(form.getAttribute('data-yayra-in-app-only'), 'true');

    const file = {
      name: 'cat.png', type: 'image/png', size: 4,
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
    };
    const fileInput = lens.querySelector('.fb-google-lens-file');
    fileInput.files = [file];
    fileInput.dispatchEvent({ type: 'change' });
    await flush();

    assert.equal(shell.getActiveTab().url, 'yayra://newtab',
      'a failed direct upload never navigates to the empty Lens picker');
    assert.ok(container.querySelector('.fb-google-lens-overlay'), 'the original chooser remains open');
    assert.equal(fileInput.files[0], file, 'the chosen file is retained for retry');
    assert.match(lens.querySelector('.fb-google-lens-status').textContent, /selection is still here/i);
    assert.equal(lens.querySelector('.fb-google-lens-retry').hasAttribute('hidden'), false);
    assert.equal(externalOpens, 0);
    assert.equal(shell._inAppOnlyGoogleTabs.has(shell.getActiveTab().id), false);

    nativeMode = 'file-success';
    lens.querySelector('.fb-google-lens-retry').click();
    await flush();
    assert.equal(shell.getActiveTab().url, 'https://lens.google.com/search?p=file-result',
      'retry opens the completed result directly in the active Yayra tab');
    assert.equal(shell._inAppOnlyGoogleTabs.has(shell.getActiveTab().id), true);
    assert.equal(nativeCalls[0].name, 'cat.png');
    assert.equal(nativeCalls[0].tabId, shell.getActiveTab().id);

    shell.navigateActiveTab('yayra://newtab');
    delete window.yayra;
    container.querySelector('.fb-newtab-lens-btn').click();
    lens = container.querySelector('.fb-google-lens-overlay');
    const webFileInput = lens.querySelector('.fb-google-lens-file');
    webFileInput.files = [file];
    webFileInput.dispatchEvent({ type: 'change' });
    await flush();
    assert.equal(shell.getActiveTab().url, 'yayra://newtab',
      'web/PWA local upload keeps the chooser in Yayra instead of submitting a new window');
    assert.ok(container.querySelector('.fb-google-lens-overlay'));
    assert.equal(externalOpens, 0);

    lens.querySelector('.fb-google-lens-close').click();
    let urlAttempts = 0;
    window.yayra = {
      system: {
        googleLensUpload: async (payload) => {
          nativeCalls.push(payload);
          urlAttempts += 1;
          return urlAttempts === 1
            ? { ok: false, reason: 'google-no-result' }
            : { ok: true, url: 'https://www.google.com/search?vsrid=url-result' };
        }
      }
    };
    container.querySelector('.fb-newtab-lens-btn').click();
    lens = container.querySelector('.fb-google-lens-overlay');
    const imageUrlInput = lens.querySelector('.fb-google-lens-url');
    imageUrlInput.value = 'https://example.com/image.jpg';
    lens.querySelector('.fb-google-lens-url-search').click();
    await flush();
    assert.equal(shell.getActiveTab().url, 'yayra://newtab',
      'a rejected image URL does not navigate to Google’s empty picker');
    assert.equal(imageUrlInput.value, 'https://example.com/image.jpg', 'the supplied URL remains available for retry');
    lens.querySelector('.fb-google-lens-retry').click();
    await flush();
    assert.equal(shell.getActiveTab().url, 'https://www.google.com/search?vsrid=url-result');
    assert.equal(nativeCalls.at(-1).imageUrl, 'https://example.com/image.jpg',
      'the retained URL is resent through the native direct-result transport');
    assert.equal(externalOpens, 0, 'Lens URL search never launches another browser');
  } finally {
    shell.destroy();
    if (previousOpen === undefined) delete window.open; else window.open = previousOpen;
    if (previousYayra === undefined) delete window.yayra; else window.yayra = previousYayra;
    if (previousCapacitor === undefined) delete window.Capacitor; else window.Capacitor = previousCapacitor;
  }
});

test('source pin: Voice/Lens external launcher was removed from renderer, preload, and main', () => {
  const shellSource = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

  assert.doesNotMatch(shellSource, /openGoogleFeatureExternally/);
  assert.doesNotMatch(preload, /openGoogleFeature|yayra:open-google-feature/);
  assert.doesNotMatch(main, /yayra:open-google-feature/);
  assert.match(shellSource, /openGoogleFeatureInYayra/);
});
