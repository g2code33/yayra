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

test('Lens URL and failed native upload remain in Yayra; local web upload never submits a new window', async () => {
  const previousOpen = window.open;
  const previousYayra = window.yayra;
  const previousCapacitor = window.Capacitor;
  let externalOpens = 0;
  window.open = () => { externalOpens += 1; return {}; };
  delete window.Capacitor;
  window.yayra = {
    system: {
      googleLensUpload: async () => ({ ok: false, reason: 'simulated-upload-failure' })
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

    assert.equal(shell.getActiveTab().url, 'https://lens.google.com/',
      'native upload failure falls back to Lens in the same Yayra tab');
    assert.equal(externalOpens, 0);
    assert.equal(shell._inAppOnlyGoogleTabs.has(shell.getActiveTab().id), true);

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
    container.querySelector('.fb-newtab-lens-btn').click();
    lens = container.querySelector('.fb-google-lens-overlay');
    lens.querySelector('.fb-google-lens-url').value = 'https://example.com/image.jpg';
    lens.querySelector('.fb-google-lens-url-search').click();
    const result = new URL(shell.getActiveTab().url);
    assert.equal(result.origin + result.pathname, 'https://lens.google.com/uploadbyurl');
    assert.equal(result.searchParams.get('url'), 'https://example.com/image.jpg');
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
