import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { PasswordManager } from '../packages/persistence/src/PasswordManager.js';
import { ExtensionManager } from '../packages/browser-contract/src/extensions/ExtensionManager.js';
import { MemoryPersistenceAdapter, HistoryRepository, SettingsRepository } from '../packages/persistence/src/index.js';

test('Floating Browser Default Launch: Opens directly into floating browser mode without dashboard gating', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const settingsRepo = new SettingsRepository(storage);

  // Verify default settings have floatingEnabledByDefault = true
  const settings = await settingsRepo.getSettings();
  assert.equal(settings.floatingEnabledByDefault, true);

  const shell = new BrowserShell({
    container,
    platform: 'windows',
    isMobile: false,
    settingsRepo,
    desktopFloatingMode: 'browser-first'
  });

  await shell.initialize();
  shell.render(container);

  // Directly renders full browser shell with Omnibox & Tab strip
  assert.ok(container.querySelector('.fb-browser-shell'));
  assert.ok(container.querySelector('.fb-omnibox-input'));
  assert.ok(container.querySelector('.fb-tab-item'));
  assert.equal(shell.state.desktopFloatingMode, 'browser-first');
  assert.equal(shell.state.isMinimizedToBubble, false);
});

test('Floating Full Browser: Multi-tab management, tab reordering, and Reopen Closed Tab (Ctrl+Shift+T)', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'https://example.com'
  });

  await shell.initialize();
  shell.render(container);

  assert.equal(shell.state.tabs.length, 1);
  const firstTabId = shell.getActiveTab().id;

  // 1. Create a second tab
  shell.createNewTab();
  assert.equal(shell.state.tabs.length, 2);
  shell.navigateActiveTab('https://developer.mozilla.org');
  assert.equal(shell.getActiveTab().url, 'https://developer.mozilla.org');

  // 2. Create a third tab
  shell.createNewTab();
  assert.equal(shell.state.tabs.length, 3);
  shell.navigateActiveTab('https://wikipedia.org');
  const thirdTabId = shell.getActiveTab().id;

  // 3. Close the third tab -> Recorded in closedTabsHistory
  shell.closeTab(thirdTabId);
  assert.equal(shell.state.tabs.length, 2);
  assert.equal(shell.state.closedTabsHistory.length, 1);
  assert.equal(shell.state.closedTabsHistory[0].url, 'https://wikipedia.org');

  // 4. Reopen last closed tab (Ctrl+Shift+T equivalent)
  shell.reopenLastClosedTab();
  assert.equal(shell.state.tabs.length, 3);
  assert.equal(shell.getActiveTab().url, 'https://wikipedia.org');
  assert.equal(shell.state.closedTabsHistory.length, 0);

  // 5. Reorder tabs
  shell.reorderTabs(0, 2);
  assert.equal(shell.state.tabs[2].id, firstTabId);
});

test('Private / Incognito Mode: Isolated ephemeral browsing with stealth styling and zero credential tracking', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const historyRepo = new HistoryRepository(storage);
  const passwordManager = new PasswordManager({ storageAdapter: storage });
  
  await passwordManager.initialize();

  const shell = new BrowserShell({
    container,
    isMobile: false,
    historyRepo,
    passwordManager
  });

  await shell.initialize();
  shell.render(container);

  // Open incognito tab
  shell.createNewTab(true);
  const activeTab = shell.getActiveTab();
  assert.equal(activeTab.isPrivate, true);

  // Navigate inside incognito tab
  shell.navigateActiveTab('https://duckduckgo.com');
  assert.equal(activeTab.url, 'https://duckduckgo.com');

  // Check history repo: Should NOT record entries from private tabs
  const historyEntries = await historyRepo.getEntries();
  const matchingPrivateEntry = historyEntries.find((h) => h.url.includes('duckduckgo.com'));
  assert.equal(matchingPrivateEntry, undefined);

  // Password saving prompt should be disabled in incognito
  const promptCheck = passwordManager.shouldPromptToSave('duckduckgo.com', true);
  assert.equal(promptCheck, false);
});

test('Zoom & Fullscreen Controls: Zoom in/out, clamping bounds, and full-screen toggling', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  assert.equal(shell.state.zoomLevel, 100);

  // Zoom in
  shell.zoomIn();
  assert.equal(shell.state.zoomLevel, 110);

  shell.zoomIn();
  assert.equal(shell.state.zoomLevel, 120);

  // Zoom out
  shell.zoomOut();
  assert.equal(shell.state.zoomLevel, 110);

  // Set zoom with bounds checking
  shell.setZoom(600);
  assert.equal(shell.state.zoomLevel, 500); // Clamped to 500%

  shell.setZoom(10);
  assert.equal(shell.state.zoomLevel, 25); // Clamped to 25%

  // Reset zoom
  shell.resetZoom();
  assert.equal(shell.state.zoomLevel, 100);
});

test('Find In Page: Searches query occurrences and navigates matches', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  // Execute find query
  shell.executeFindInPage('privacy');
  assert.equal(shell.state.findInPage.isOpen, true);
  assert.equal(shell.state.findInPage.query, 'privacy');
  assert.ok(shell.state.findInPage.matchesCount > 0);
  assert.equal(shell.state.findInPage.currentMatch, 1);

  // Next match
  shell.findNext();
  assert.equal(shell.state.findInPage.currentMatch, 2);

  // Previous match
  shell.findPrev();
  assert.equal(shell.state.findInPage.currentMatch, 1);

  // Close find bar
  shell.closeFindInPage();
  assert.equal(shell.state.findInPage.isOpen, false);
  assert.equal(shell.state.findInPage.query, '');
});

test('Chrome-Style 3-Dot Menu: Full architectural structure with all operational groups', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  // Open 3-dot menu
  shell.openModal('menu');
  assert.equal(shell.state.activeModal, 'menu');

  const menuCard = container.querySelector('.fb-chrome-menu-card');
  assert.ok(menuCard);

  // Verify essential action items exist in DOM
  const actions = Array.from(menuCard.querySelectorAll('.fb-menu-item')).map((el) => el.dataset.action);
  assert.ok(actions.includes('new-tab'));
  assert.ok(actions.includes('new-window'));
  assert.ok(actions.includes('new-incognito-tab'));
  assert.ok(actions.includes('reopen-closed-tab'));
  assert.ok(actions.includes('find-in-page'));
  assert.ok(actions.includes('print'));
  assert.ok(actions.includes('share'));
  assert.ok(actions.includes('passwords'));
  assert.ok(actions.includes('history'));
  assert.ok(actions.includes('downloads'));
  assert.ok(actions.includes('dictionary'));
  assert.ok(actions.includes('bookmarks'));
  assert.ok(actions.includes('clear-data'));
  assert.ok(actions.includes('extensions'));
  assert.ok(actions.includes('permissions'));
  assert.ok(actions.includes('settings'));
  assert.ok(actions.includes('about'));
  let dictionaryRoute = '';
  shell.openInternalPage = (url) => { dictionaryRoute = url; };
  menuCard.querySelector('[data-action="dictionary"]').click();
  assert.equal(dictionaryRoute, 'yayra://dictionary', 'the new menu item opens the dictionary page');
});

test('Password Manager: Secure origin-scoped encryption, autofill matching, and lifecycle', async () => {
  const storage = new MemoryPersistenceAdapter();
  const pm = new PasswordManager({ storageAdapter: storage });
  await pm.initialize();

  // 1. Save credential
  const cred = await pm.saveCredential({
    origin: 'https://accounts.google.com',
    username: 'user@example.com',
    password: 'SuperSecretPassword123!'
  });

  assert.ok(cred.id);
  assert.equal(cred.origin, 'https://accounts.google.com');
  assert.equal(cred.username, 'user@example.com');
  assert.notEqual(cred.encryptedPassword, 'SuperSecretPassword123!'); // Not stored in plaintext

  // 2. Retrieve for origin
  const matches = await pm.getCredentialsForOrigin('https://accounts.google.com');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].password, 'SuperSecretPassword123!');

  // 3. Non-matching origin returns empty
  const otherMatches = await pm.getCredentialsForOrigin('https://github.com');
  assert.equal(otherMatches.length, 0);

  // 4. Update credential
  await pm.saveCredential({
    origin: 'https://accounts.google.com',
    username: 'user@example.com',
    password: 'NewUpdatedPassword456!'
  });

  const updatedMatches = await pm.getCredentialsForOrigin('https://accounts.google.com');
  assert.equal(updatedMatches.length, 1);
  assert.equal(updatedMatches[0].password, 'NewUpdatedPassword456!');

  // 5. Delete credential
  await pm.deleteCredential(cred.id);
  const remaining = await pm.getAllCredentials();
  assert.equal(remaining.length, 0);
});

test('Extension Manager: Manifest validation, enable/disable lifecycle, and private browsing controls', async () => {
  const storage = new MemoryPersistenceAdapter();
  const em = new ExtensionManager({ storageAdapter: storage });
  await em.initialize();

  // Built-in extensions should be registered
  const exts = await em.getExtensions();
  assert.ok(exts.length >= 3);
  assert.ok(exts.some((e) => e.id === 'yayra-shield'));
  assert.ok(exts.some((e) => e.id === 'dark-reader'));
  assert.ok(exts.some((e) => e.id === 'clean-reader'));

  // Disable extension
  await em.disableExtension('yayra-shield');
  assert.equal(em.isExtensionActive('yayra-shield', false), false);

  // Enable extension
  await em.enableExtension('yayra-shield');
  assert.equal(em.isExtensionActive('yayra-shield', false), true);

  // Private mode permissions
  assert.equal(em.isExtensionActive('dark-reader', true), false); // Disabled in private
  await em.setAllowedInPrivate('dark-reader', true);
  await em.enableExtension('dark-reader');
  assert.equal(em.isExtensionActive('dark-reader', true), true); // Allowed after toggle
});

test('Floating Transparency Controls: Bubble opacity, frame opacity, blur sliders, and live preview', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const settingsRepo = new SettingsRepository(storage);

  const shell = new BrowserShell({
    container,
    isMobile: false,
    settingsRepo
  });

  await shell.initialize();
  shell.render(container);

  // Open Settings modal
  shell.openModal('settings');
  const settingsCard = container.querySelector('.fb-settings-modal-card');
  assert.ok(settingsCard);

  // Check sliders exist
  const bubbleSlider = settingsCard.querySelector('#fb-slider-bubble-opacity');
  const shadowSlider = settingsCard.querySelector('#fb-slider-bubble-shadow');
  const frameSlider = settingsCard.querySelector('#fb-slider-frame-opacity');
  const blurSlider = settingsCard.querySelector('#fb-slider-blur');
  const previewCard = settingsCard.querySelector('#fb-transparency-live-preview');

  assert.ok(bubbleSlider);
  assert.ok(shadowSlider);
  assert.equal(shadowSlider.getAttribute('value'), '0', 'bubble shadow defaults to none');
  assert.ok(frameSlider);
  assert.ok(blurSlider);
  assert.ok(previewCard);

  shadowSlider.value = '16';
  shadowSlider.dispatchEvent(new Event('input'));
  assert.equal(shell.state.settings.bubbleShadowPx, 16, 'shadow slider previews immediately');
  assert.equal(settingsCard.querySelector('#val-bubble-shadow').textContent, '16px');

  // Change frame opacity
  frameSlider.value = '75';
  frameSlider.dispatchEvent(new Event('input'));
  assert.equal(shell.state.settings.frameOpacity, 0.75);

  // Change blur
  blurSlider.value = '32';
  blurSlider.dispatchEvent(new Event('input'));
  assert.equal(shell.state.settings.glassmorphismBlurRadius, 32);

  // Reset to default
  const resetBtn = settingsCard.querySelector('.fb-reset-transparency-btn');
  resetBtn.dispatchEvent(new Event('click'));
  assert.equal(shell.state.settings.bubbleOpacity, 0.88);
  assert.equal(shell.state.settings.bubbleShadowPx, 0, 'reset returns shadow to none');
  assert.equal(shadowSlider.value, '0');
  assert.equal(shell.state.settings.frameOpacity, 0.85);
  assert.equal(shell.state.settings.glassmorphismBlurRadius, 24);
});
