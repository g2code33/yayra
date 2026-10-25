import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

const require = createRequire(import.meta.url);
const privacyShield = require('../electron/privacyShield.cjs');
const webviewBridge = require('../electron/webviewBridge.cjs');
const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

async function makeShell(auth = null) {
  globalThis.localStorage = makeStorage();
  delete window.Capacitor;
  delete window.ibrowse;
  window.yayra = auth ? { auth } : {};
  window.open = () => null;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

function fireChange(el) {
  el.dispatchEvent({ type: 'change', target: el, preventDefault() {}, stopPropagation() {} });
}

function cleanup(shell) {
  shell.destroy();
  delete globalThis.localStorage;
  delete window.yayra;
  delete window.open;
}

test('Privacy shield normalizes renderer policy and blocks trackers, third-party cookies and unsafe URLs locally', () => {
  const policy = privacyShield.sanitizePrivacyPolicy({
    httpsFirst: 'yes',
    safeBrowsingLevel: 'nonsense',
    thirdPartyCookies: 'javascript:alert(1)',
    secureDnsProvider: 'https://attacker.example/dns',
    cookieExceptions: ['Example.COM', 'bad host', 'Accounts.GOOGLE.com'],
    permissionDefaults: { camera: 'always', location: 'ask' },
    sitePermissions: {
      'https://trusted.example': { camera: 'allow', microphone: 'javascript:bad' },
      'javascript:alert(1)': { camera: 'allow' }
    }
  });
  assert.equal(policy.httpsFirst, true);
  assert.equal(policy.safeBrowsingLevel, 'enhanced');
  assert.equal(policy.thirdPartyCookies, 'block');
  assert.equal(policy.secureDnsProvider, 'automatic');
  assert.deepEqual(policy.cookieExceptions, ['example.com', 'accounts.google.com']);
  assert.equal(policy.permissionDefaults.camera, 'block');
  assert.equal(policy.permissionDefaults.location, 'ask');
  assert.deepEqual(policy.sitePermissions['https://trusted.example'], { camera: 'allow' });

  const redirect = privacyShield.upgradedHttpsUrl('http://example.com/page?q=1');
  assert.equal(redirect, 'https://example.com/page?q=1');
  assert.equal(privacyShield.upgradedHttpsUrl('http://127.0.0.1:8080/'), null, 'local development is not forced to HTTPS');

  const thirdParty = {
    resourceType: 'image',
    url: 'https://tracker.example/pixel.gif',
    initiator: 'https://news.example/article'
  };
  assert.equal(privacyShield.isThirdPartyRequest(thirdParty, 'https://news.example/article'), true);
  assert.equal(privacyShield.isThirdPartyRequest({
    resourceType: 'image', url: 'https://cdn.news.example/logo.png', initiator: 'https://news.example/article'
  }, 'https://news.example/article'), false, 'same registrable site remains first-party');

  const headers = privacyShield.applyPrivacyRequestHeaders(thirdParty, {
    Cookie: 'sid=private',
    'Sec-Browsing-Topics': 'topic',
    'Set-Cookie': 'unexpected'
  }, policy, 'https://news.example/article');
  assert.equal(headers.Cookie, undefined, 'third-party cookies are stripped');
  assert.equal(headers['Sec-Browsing-Topics'], undefined);
  assert.equal(headers.DNT, '1');
  assert.equal(headers['Sec-GPC'], '1');
  const responseHeaders = privacyShield.applyPrivacyResponseHeaders(thirdParty, {
    'Set-Cookie': 'sid=private',
    'Observe-Browsing-Topics': '1',
    'Content-Type': 'image/gif'
  }, policy, 'https://news.example/article');
  assert.equal(responseHeaders['Set-Cookie'], undefined);
  assert.equal(responseHeaders['Observe-Browsing-Topics'], undefined);
  assert.equal(responseHeaders['Content-Type'], 'image/gif');

  assert.equal(privacyShield.isTrackerRequest({
    resourceType: 'script', url: 'https://www.google-analytics.com/analytics.js'
  }, policy), true);
  assert.equal(privacyShield.isUnsafeRequest({
    resourceType: 'mainFrame', url: 'https://user:pass@accounts.google.com/'
  }, policy), true);
  assert.equal(privacyShield.isUnsafeRequest({
    resourceType: 'mainFrame', url: 'https://example.com/'
  }, policy), false);
});

test('Google page reflection script carries only the exact account and never a token', () => {
  const script = webviewBridge.buildGoogleServiceAccountScript({
    email: 'Selected.User@Example.com',
    name: 'Selected User',
    access_token: 'ya29.must-not-appear',
    refresh_token: 'must-not-appear'
  });
  assert.match(script, /selected\.user@example\.com/);
  assert.match(script, /Yayra connected/);
  assert.match(script, /do NOT rewrite Google's own Sign in button/i);
  assert.doesNotMatch(script, /data-yayra-google-connected|node\.textContent\s*=\s*email|querySelectorAll\('a,button/i, 'the reflection strip never disguises Google website auth state');
  assert.doesNotMatch(script, /ya29|refresh_token|access_token/i);
  assert.equal(webviewBridge.sanitizeGoogleServiceAccount({ email: 'bad address' }), null);
});

test('Security Center: all screenshot destinations render and every control is wired to persisted state', async () => {
  const { shell } = await makeShell();
  try {
    shell.navigateActiveTab('yayra://settings');
    shell.showPrivacyView('overview');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="guide"]'), 'Privacy Guide card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="clear-data"]'), 'Delete browsing data card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="cookies"]'), 'Third-party cookies card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="ad-privacy"]'), 'Ad privacy card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="site-settings"]'), 'Site settings card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="security"]'), 'Security card exists');
    assert.ok(shell.rootElement.querySelector('[data-privacy-action="safety-check"]'), 'Safety Check is clickable');
    assert.ok(shell.rootElement.querySelector('[data-privacy-action="apply-recommended"]'), 'Maximum protection is clickable');

    shell.rootElement.querySelector('[data-privacy-action="safety-check"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shell.state.privacySafetyCheck.status, 'done');
    assert.ok(shell.rootElement.querySelector('.fb-privacy-status'), 'Safety Check result is visible');

    shell.showPrivacyView('guide');
    assert.match(shell.rootElement.textContent, /A guide to your privacy choices/);
    for (let i = 0; i < 5; i += 1) {
      shell.rootElement.querySelector('[data-privacy-action="guide-next"]')?.click();
    }
    assert.equal(shell.state.privacyGuideStep, 5);
    assert.match(shell.rootElement.textContent, /Review complete/);
    shell.rootElement.querySelector('[data-privacy-action="guide-done"]')?.click();
    assert.equal(shell.state.privacySettingsView, 'overview');

    shell.showPrivacyView('clear-data');
    assert.equal(shell.rootElement.querySelectorAll('[data-privacy-range]').length, 5);
    shell.rootElement.querySelector('[data-privacy-range="15m"]').click();
    assert.equal(shell.state.privacyDeleteRange, '15m');
    assert.equal(shell.rootElement.querySelectorAll('[data-privacy-delete]').length, 4);
    assert.ok(shell.rootElement.querySelector('[data-privacy-action="delete-data"]'));

    shell.showPrivacyView('cookies');
    const cookieSelect = shell.rootElement.querySelector('[data-privacy-setting="thirdPartyCookies"]');
    assert.ok(cookieSelect);
    cookieSelect.value = 'allow';
    fireChange(cookieSelect);
    assert.equal(shell.state.settings.thirdPartyCookies, 'allow');
    const cookieInput = shell.rootElement.querySelector('#fb-privacy-cookie-site');
    cookieInput.value = 'Trusted.Example.com';
    shell.rootElement.querySelector('[data-privacy-action="add-cookie-exception"]').click();
    assert.deepEqual(shell.state.settings.cookieExceptions, ['trusted.example.com']);

    shell.showPrivacyView('site-settings');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="permissions"]'));
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="site-data"]'));
    const javascript = shell.rootElement.querySelector('[data-privacy-setting="javascriptEnabled"]');
    javascript.checked = false;
    fireChange(javascript);
    assert.equal(shell.state.settings.javascriptEnabled, false);

    shell.showPrivacyView('site-data');
    assert.match(shell.rootElement.textContent, /requires the Yayra desktop app|Reading site data/);

    shell.showPrivacyView('security');
    assert.equal(shell.rootElement.querySelectorAll('[data-privacy-setting="safeBrowsingLevel"]').length, 3);
    const secureDns = shell.rootElement.querySelector('[data-privacy-setting="secureDnsEnabled"]');
    secureDns.checked = false;
    fireChange(secureDns);
    assert.equal(shell.state.settings.secureDnsEnabled, false);

    shell.showPrivacyView('ad-privacy');
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="ad-topics"]'));
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="site-suggested-ads"]'));
    assert.ok(shell.rootElement.querySelector('[data-privacy-view="ad-measurement"]'));

    for (const view of ['ad-topics', 'site-suggested-ads', 'ad-measurement', 'permissions']) {
      shell.showPrivacyView(view);
      assert.ok(shell.rootElement.querySelector('.fb-privacy-body'), `${view} renders`);
    }
    shell.showPrivacyView('overview');
    shell.rootElement.querySelector('[data-privacy-action="apply-recommended"]').click();
    assert.equal(shell.state.settings.thirdPartyCookies, 'block');
    assert.equal(shell.state.settings.javascriptEnabled, true);
    assert.equal(shell.state.settings.secureDnsEnabled, true);
    assert.equal(shell.state.settings.safeBrowsingLevel, 'enhanced');
  } finally {
    cleanup(shell);
  }
});

test('Google services: external-browser consent reflects the exact account and every service opens inside Yayra', async () => {
  const listeners = new Set();
  let connected = 0;
  const auth = {
    getSession: async () => ({ signedIn: false }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    connectGoogleServices: async () => {
      connected += 1;
      const profile = { sub: 'g-services', email: 'selected.user@example.com', name: 'Selected User' };
      for (const listener of listeners) listener({ type: 'google-services-connected', profile, grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'] });
      return { ok: true, profile, grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'] };
    },
    getGoogleServiceItems: async (serviceId) => ({ ok: true, items: [{ id: 'doc-1', title: 'Private proposal', detail: 'Today', url: '' }], count: 1, service: serviceId }),
    signOut: async () => ({ ok: true })
  };
  const { shell } = await makeShell(auth);
  try {
    shell.navigateActiveTab('yayra://google-services');
    assert.match(shell.rootElement.textContent, /Connect Google services through the external browser/i);
    shell.rootElement.querySelector('.fb-google-services-connect').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(connected, 1);
    assert.equal(shell.state.googleServices.signedIn, true);
    assert.equal(shell.state.googleServices.profile.email, 'selected.user@example.com');
    assert.match(shell.rootElement.textContent, /selected\.user@example\.com/);
    assert.ok(shell.rootElement.querySelector('.fb-google-services-gmail'), 'Gmail in Yayra action exists');
    assert.ok(shell.rootElement.querySelector('.fb-google-services-disconnect'), 'Disconnect action exists');
    assert.ok(shell.rootElement.querySelectorAll('.fb-google-services-card').length >= 30, 'full Google service catalog is rendered');

    const previewButton = shell.rootElement.querySelector('.fb-google-services-preview-btn');
    assert.ok(previewButton, 'API-backed services expose a real preview action');
    previewButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shell.state.googleServicesPreview.status, 'ready');
    assert.match(shell.rootElement.textContent, /Private proposal/);

    const openButton = shell.rootElement.querySelector('.fb-google-services-open');
    assert.ok(openButton);
    openButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const activeUrl = shell.getActiveTab().url;
    assert.match(activeUrl, /^https:\/\//);
    assert.match(activeUrl, /authuser=selected\.user%40example\.com/, 'exact selected account is carried into the service destination');

    shell.navigateActiveTab('https://drive.google.com/drive/u/0/my-drive');
    const banner = shell.rootElement.querySelector('.fb-google-connected-banner');
    assert.ok(banner, 'Google product pages get a connected-account strip');
    assert.match(banner.textContent, /selected\.user@example\.com/);
    assert.match(banner.textContent, /Google services connected in Yayra/);
    assert.ok(banner.querySelector('.fb-google-services-hub-btn'), 'Google services hub button is present');
  } finally {
    cleanup(shell);
  }
});
