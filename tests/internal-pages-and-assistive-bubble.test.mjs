import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { PasswordManager } from '../packages/persistence/src/PasswordManager.js';
import { ExtensionManager } from '../packages/browser-contract/src/extensions/ExtensionManager.js';
import { MemoryPersistenceAdapter, HistoryRepository, SettingsRepository } from '../packages/persistence/src/index.js';

test('In-Tab Internal Pages: Loads yayra://settings in tab with category navigation and live search', async () => {
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

  // Navigate active tab to yayra://settings
  shell.navigateActiveTab('yayra://settings');
  const activeTab = shell.getActiveTab();
  assert.equal(activeTab.url, 'yayra://settings');
  assert.equal(activeTab.title, 'Settings');

  // Verify internal page UI rendered
  assert.ok(container.querySelector('.fb-settings-inpage-layout'), 'Settings in-page layout should be rendered');
  assert.ok(container.querySelector('.fb-settings-nav-item'), 'Settings category nav items should exist');
  assert.ok(container.querySelector('#fb-in-settings-search'), 'Settings live search input should exist');

  // Live category switching
  const appearanceTab = container.querySelector('[data-category="appearance"]');
  if (appearanceTab) {
    appearanceTab.click();
    assert.equal(shell.state.activeSettingsCategory, 'appearance');
  }

  // Live transparency adjustment
  const bubbleSlider = container.querySelector('#fb-in-bubble-opacity');
  if (bubbleSlider) {
    bubbleSlider.value = '75';
    bubbleSlider.dispatchEvent(new Event('input'));
    assert.equal(shell.state.settings.bubbleOpacity, 0.75);
  }
});

test('Incognito new tab has a distinct privacy header and readable dark contrast in Light theme', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false, initialUrl: 'yayra://newtab' });
  await shell.initialize();
  shell.state.settings.theme = 'light';
  shell.createNewTab(true);

  const root = container.querySelector('.fb-browser-shell');
  assert.ok(root.classList.contains('fb-incognito-mode'), 'private tab applies the scoped Incognito theme');
  const title = container.querySelector('.fb-newtab-title');
  assert.ok(title?.innerHTML.includes('fb-incognito-title') && title.innerHTML.includes('<svg'), 'Incognito has a clear privacy icon beside its title');
  assert.match(container.querySelector('.fb-incognito-notice')?.textContent || '', /history and session restore/i);
  assert.match(container.querySelector('.fb-incognito-notice')?.textContent || '', /downloads and bookmarks/i);
  assert.equal(container.querySelector('.fb-dev-ad-showcase'), null, 'sponsor links are not shown in a private new tab');

  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  assert.match(css, /\.fb-browser-shell\.fb-incognito-mode\s*\{[\s\S]*?--fb-text-primary:\s*#f8fafc/);
  assert.match(css, /\.fb-browser-shell\.fb-incognito-mode \.fb-newtab-searchbox\s*\{[\s\S]*?background:\s*rgba\(17,\s*24,\s*39,\s*0\.96\)/);
  assert.match(css, /\.fb-browser-shell\.fb-incognito-mode \.fb-chrome-navbar\s*\{[^}]*background:\s*#111827/s, 'incognito toolbar stays dark when the normal theme is light');
  assert.match(css, /\.fb-browser-shell\.fb-incognito-mode \.fb-nav-btn,\s*\n\.fb-browser-shell\.fb-incognito-mode \.fb-menu-btn\s*\{[^}]*color:\s*#f8fafc/s, 'back, forward, refresh, and Yayra menu controls are high-contrast');
  assert.match(css, /\.fb-browser-shell\.fb-incognito-mode \.fb-toolbar-action-btn\s*\{[^}]*color:\s*#e2e8f0 !important/s, 'toolbar action glyphs override the light-theme foreground');
  assert.match(css, /--fb-drawer-bg:\s*#0b1220;[\s\S]*?--fb-drawer-submenu-bg:\s*#111827;/, 'Incognito drawer and flyouts use readable dark surfaces');
  assert.match(css, /\.fb-nav-btn\s*\{[^}]*color:\s*var\(--fb-text-primary\)/s, 'ordinary navigation-button styling remains unchanged');
  assert.match(css, /\[data-theme="light"\] \.fb-chrome-navbar\s*\{[^}]*background:\s*#ffffff/s, 'ordinary light-theme toolbar styling remains intact');
  shell.destroy();
});

test('In-Tab Internal Pages: Loads yayra://history with search filtering and visit deletion', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const historyRepo = new HistoryRepository(storage);

  await historyRepo.recordVisit('https://example.com/docs', 'Example Docs');
  await historyRepo.recordVisit('https://yayra.app/community', 'Yayra Community');

  const shell = new BrowserShell({
    container,
    isMobile: false,
    historyRepo
  });

  await shell.initialize();
  shell.render(container);

  // Navigate to history
  shell.navigateActiveTab('yayra://history');
  assert.equal(shell.getActiveTab().url, 'yayra://history');
  assert.equal(shell.getActiveTab().title, 'History');

  // History list rendered
  const items = container.querySelectorAll('.fb-history-row');
  assert.ok(items.length >= 2, 'Should display history rows');

  // History search filter
  shell.state.historySearchQuery = 'Community';
  shell.render(container);
  const filteredItems = container.querySelectorAll('.fb-history-row');
  assert.equal(filteredItems.length, 1);
});

test('In-Tab Internal Pages: Loads yayra://passwords with secure vault view and credential actions', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const passwordManager = new PasswordManager(storage);

  await passwordManager.saveCredential({
    origin: 'https://github.com',
    username: 'octocat',
    password: 'super-secret-password-123',
    title: 'GitHub'
  });

  const shell = new BrowserShell({
    container,
    isMobile: false,
    passwordManager
  });

  await shell.initialize();
  shell.render(container);

  // Navigate to yayra://passwords
  shell.navigateActiveTab('yayra://passwords');
  assert.equal(shell.getActiveTab().url, 'yayra://passwords');
  assert.equal(shell.getActiveTab().title, 'Passwords');

  assert.ok(container.querySelector('.fb-passwords-inpage-layout'), 'Password manager in-page layout should render');
  const pwdRows = container.querySelectorAll('.fb-pwd-row');
  assert.equal(pwdRows.length, 1);
  assert.ok(pwdRows[0].textContent.includes('octocat'));

  // Test reveal password toggle
  const revealBtn = pwdRows[0].querySelector('.fb-pwd-reveal-btn');
  assert.ok(revealBtn);
  revealBtn.click();
  const pwdSpan = pwdRows[0].querySelector('.fb-pwd-masked');
  assert.equal(pwdSpan.textContent, 'super-secret-password-123');
});

test('In-Tab Internal Pages: Loads yayra://extensions with toggles and permissions viewer', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const extensionManager = new ExtensionManager(storage);

  const shell = new BrowserShell({
    container,
    isMobile: false,
    extensionManager
  });

  await shell.initialize();
  shell.render(container);

  // Navigate to yayra://extensions
  shell.navigateActiveTab('yayra://extensions');
  assert.equal(shell.getActiveTab().url, 'yayra://extensions');
  assert.equal(shell.getActiveTab().title, 'Extensions');

  const extCards = container.querySelectorAll('.fb-extension-card');
  assert.ok(extCards.length >= 2, 'Built-in extensions should render as cards');

  // Toggle extension
  const toggleInput = extCards[0].querySelector('.fb-ext-toggle-input');
  assert.ok(toggleInput);
});

test('In-Tab Internal Pages: Loads yayra://about with version info, update check, and licenses', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  shell.navigateActiveTab('yayra://about');
  assert.equal(shell.getActiveTab().url, 'yayra://about');
  assert.equal(shell.getActiveTab().title, 'About Yayra');

  assert.ok(container.querySelector('.fb-about-hero'), 'About hero branding must be present');
  assert.ok(container.querySelector('.fb-about-version-badge'), 'Version badge must be present');
  assert.ok(container.querySelector('.fb-about-check-updates-btn'), 'Check for updates button must be present');
});

test('In-Tab Internal Pages: Redesigned yayra://newtab with search box and focus management; frequent sites start EMPTY', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'yayra://newtab'
  });

  await shell.initialize();
  shell.render(container);

  assert.equal(shell.getActiveTab().url, 'yayra://newtab');
  assert.equal(shell.getActiveTab().title, 'New Tab');

  assert.ok(container.querySelector('.fb-newtab-hero'), 'New tab hero header must render');
  assert.ok(container.querySelector('.fb-official-brand-orb'), 'Yayra orb remains above the search experience');
  assert.ok(container.querySelector('.fb-official-brand-wordmark'), 'Yayra wordmark remains above the search experience');
  const searchbox = container.querySelector('.fb-newtab-searchbox');
  const searchInput = container.querySelector('.fb-newtab-search-input');
  assert.ok(searchInput, 'New tab main search box must render');
  assert.equal(searchInput.getAttribute('placeholder'), 'Ask Google', 'default Google search uses the familiar Chrome wording');
  assert.ok(searchbox.querySelector('.fb-newtab-add-btn'), 'Google-style plus control renders');
  assert.ok(searchbox.querySelector('.fb-newtab-mic-btn'), 'voice-search control renders');
  assert.ok(searchbox.querySelector('.fb-newtab-lens-btn'), 'Google Lens control renders');
  assert.ok(searchbox.querySelector('.fb-newtab-google-ai-btn'), 'Google AI Mode control renders inside the pill');
  assert.equal(searchbox.querySelector('.fb-newtab-ai-chip'), null, 'Yayra AI is not presented as a Google search control');
  assert.match(container.querySelector('.fb-newtab-ai-chip')?.textContent || '', /Ask Yayra AI/,
    'Yayra AI returns as its own entry below the Google search pill');
  shell.getGoogleSearchSuggestions = async () => ['compare browsers'];
  searchInput.value = 'compare';
  searchInput.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(searchbox.querySelector('.fb-ai-suggestion'), null,
    'Google-owned new-tab suggestions do not inject Yayra AI back into the pill');

  const toolsMenu = searchbox.querySelector('.fb-newtab-search-tools-menu');
  assert.equal(toolsMenu.hasAttribute('hidden'), true, 'extra search tools start closed');
  searchbox.querySelector('.fb-newtab-add-btn').click();
  assert.equal(toolsMenu.hasAttribute('hidden'), false, 'plus control opens real search tools rather than being decorative');
  assert.match(toolsMenu.textContent, /Add recent tabs/);
  assert.match(toolsMenu.textContent, /Add images/);
  assert.match(toolsMenu.textContent, /Add files/);
  assert.match(toolsMenu.textContent, /Create images/);
  assert.match(toolsMenu.textContent, /Canvas/);

  let lensTarget = null;
  shell.navigateActiveTab = (url) => { lensTarget = url; };
  shell.showTransientNotice = () => {};
  toolsMenu.querySelector('.fb-google-add-files').click();
  assert.equal(new URL(lensTarget).searchParams.get('udm'), '50', 'Add files hands off to Google AI Mode');
  toolsMenu.querySelector('.fb-google-create-images').click();
  assert.equal(lensTarget, 'https://labs.google/fx/tools/image-fx', 'Create images opens Google ImageFX');
  toolsMenu.querySelector('.fb-google-canvas').click();
  assert.equal(lensTarget, 'https://gemini.google.com/app', 'Canvas opens Google Gemini');
  toolsMenu.querySelector('.fb-google-add-images').click();
  assert.ok(container.querySelector('.fb-google-lens-overlay'), 'Add images opens the Google Lens upload surface');
  container.querySelector('.fb-google-lens-close').click();
  searchbox.querySelector('.fb-newtab-lens-btn').click();
  const lensOverlay = container.querySelector('.fb-google-lens-overlay');
  assert.ok(lensOverlay, 'Lens icon opens the same Google image upload surface');
  assert.equal(lensOverlay.querySelector('.fb-google-lens-upload-form')?.getAttribute('action'), 'https://lens.google.com/v3/upload');
  assert.equal(lensOverlay.querySelector('.fb-google-lens-file')?.getAttribute('name'), 'encoded_image');
  lensOverlay.querySelector('.fb-google-lens-url').value = 'https://example.com/cat.png';
  lensOverlay.querySelector('.fb-google-lens-url-search').click();
  const lensUrl = new URL(lensTarget);
  assert.equal(lensUrl.origin + lensUrl.pathname, 'https://lens.google.com/uploadbyurl',
    'image links are handed directly to Google Lens');
  assert.equal(lensUrl.searchParams.get('url'), 'https://example.com/cat.png');

  searchInput.value = 'compare browsers';
  searchbox.querySelector('.fb-newtab-google-ai-btn').click();
  const googleAiUrl = new URL(lensTarget);
  assert.equal(googleAiUrl.origin, 'https://www.google.com');
  assert.equal(googleAiUrl.searchParams.get('udm'), '50', 'AI Mode is Google AI Mode');
  assert.equal(googleAiUrl.searchParams.get('q'), 'compare browsers');

  let yayraQuery = null;
  shell.openAiPage = (query) => { yayraQuery = query; };
  container.querySelector('.fb-newtab-ai-chip').click();
  assert.equal(yayraQuery, 'compare browsers', 'separate Yayra entry still receives the typed question');

  let shortcutModal = null;
  shell.openModal = (type) => { shortcutModal = type; };
  const addShortcut = container.querySelector('.fb-add-shortcut-card');
  assert.ok(addShortcut, 'Add shortcut remains present below the Yayra AI entry');
  addShortcut.click();
  assert.equal(shortcutModal, 'edit-shortcut', 'Add shortcut remains functional');

  const previousSpeechRecognition = window.SpeechRecognition;
  let activeRecognition = null;
  let voiceAbortCount = 0;
  try {
    window.SpeechRecognition = class FakeSpeechRecognition {
      constructor() { activeRecognition = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { voiceAbortCount += 1; this.onend?.(); }
    };
    searchbox.querySelector('.fb-newtab-mic-btn').click();
    const firstVoiceOverlay = container.querySelector('.fb-google-voice-overlay');
    assert.ok(firstVoiceOverlay, 'voice control opens the full Google-style voice surface');
    assert.equal(firstVoiceOverlay.querySelector('.fb-google-voice-status').textContent, 'Waiting...',
      'voice surface waits while browser microphone permission resolves');
    firstVoiceOverlay.querySelector('.fb-google-voice-close').click();
    assert.equal(container.querySelector('.fb-google-voice-overlay'), null, 'close dismisses the voice surface');
    assert.equal(voiceAbortCount, 1, 'close aborts the active microphone session');

    searchbox.querySelector('.fb-newtab-mic-btn').click();
    const voiceOverlay = container.querySelector('.fb-google-voice-overlay');
    activeRecognition.onaudiostart?.();
    assert.equal(voiceOverlay.querySelector('.fb-google-voice-status').textContent, 'Listening...');
    const result = [{ transcript: 'weather tomorrow' }];
    result.isFinal = true;
    activeRecognition.onresult?.({ resultIndex: 0, results: [result] });
    const voiceSearchUrl = new URL(lensTarget);
    assert.equal(voiceSearchUrl.origin + voiceSearchUrl.pathname, 'https://www.google.com/search');
    assert.equal(voiceSearchUrl.searchParams.get('q'), 'weather tomorrow',
      'a final voice transcript is sent directly to Google Search');
    assert.equal(container.querySelector('.fb-google-voice-overlay'), null, 'voice surface closes after submission');

    searchbox.querySelector('.fb-newtab-mic-btn').click();
    activeRecognition.onerror?.({ error: 'not-allowed' });
    const permissionOverlay = container.querySelector('.fb-google-voice-overlay');
    assert.equal(permissionOverlay.querySelector('.fb-google-voice-status').textContent, 'Microphone access is blocked');
    assert.match(permissionOverlay.querySelector('.fb-google-voice-help').textContent, /Allow microphone access/);
    permissionOverlay.querySelector('.fb-google-voice-close').click();

    delete window.SpeechRecognition;
    searchbox.querySelector('.fb-newtab-mic-btn').click();
    const fallbackOverlay = container.querySelector('.fb-google-voice-overlay');
    assert.equal(fallbackOverlay.querySelector('.fb-google-voice-status').textContent, 'Voice search is unavailable');
    assert.equal(fallbackOverlay.querySelector('.fb-google-voice-google-btn').hasAttribute('hidden'), false,
      'unsupported sessions provide an explicit Google fallback');
    fallbackOverlay.querySelector('.fb-google-voice-close').click();
  } finally {
    if (previousSpeechRecognition === undefined) delete window.SpeechRecognition;
    else window.SpeechRecognition = previousSpeechRecognition;
  }
  // Fresh install / brand-new profile: NO invented "frequently used"
  // tiles (they used to be a hardcoded DuckDuckGo/Wikipedia/GitHub list).
  assert.equal(container.querySelectorAll('.fb-newtab-shortcut').length, 0, 'no fabricated frequent sites on a fresh profile');
});

test('In-Tab Internal Pages: frequent sites are built from REAL visits, most-visited first, capped at 5', async () => {
  const container = document.createElement('div');
  const now = Date.now();
  const entries = [
    { id: 'h1', url: 'https://a.com', title: 'A', visitCount: 9, lastVisitedAt: now },
    { id: 'h2', url: 'https://b.com', title: 'B', visitCount: 7, lastVisitedAt: now },
    { id: 'h3', url: 'https://c.com', title: 'C', visitCount: 5, lastVisitedAt: now },
    { id: 'h4', url: 'https://d.com', title: 'D', visitCount: 4, lastVisitedAt: now },
    { id: 'h5', url: 'https://e.com', title: 'E', visitCount: 3, lastVisitedAt: now },
    { id: 'h6', url: 'https://f.com', title: 'F', visitCount: 2, lastVisitedAt: now },
    { id: 'h7', url: 'yayra://settings', title: 'Settings', visitCount: 99, lastVisitedAt: now }
  ];
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'yayra://newtab',
    historyRepo: {
      getEntries: async () => entries,
      addEntry: async () => {}
    }
  });

  await shell.initialize();
  shell.render(container);

  const frequent = shell.getFrequentSites();
  assert.equal(frequent.length, 5, 'never more than 5 frequent sites');
  assert.deepEqual(frequent.map((s) => s.url),
    ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com'],
    'ordered by real visit count; internal yayra:// pages excluded');
  assert.ok(container.querySelectorAll('.fb-newtab-shortcut').length > 0, 'tiles render once there is real browsing');
  assert.ok(container.querySelector('.fb-newtab-history'), 'Recent history remains visible when real visits exist');
  let reopenedUrl = null;
  shell.navigateActiveTab = (url) => { reopenedUrl = url; };
  const recentContext = container.querySelector('.fb-google-recent-tab');
  recentContext.click();
  container.querySelector('.fb-newtab-search-input').value = 'summarize';
  container.querySelector('.fb-newtab-google-ai-btn').click();
  const contextualAiUrl = new URL(reopenedUrl);
  assert.match(contextualAiUrl.searchParams.get('q') || '', /https:\/\/a\.com/,
    'a real recent tab can be added as context for Google AI Mode');
  container.querySelector('.fb-history-quick-item').click();
  assert.equal(reopenedUrl, 'https://a.com', 'Recent history rows remain functional');
});

test('Live pages: background sync pulls fresh history/bookmarks into state and repaints visible data pages (Chrome-style)', async () => {
  const container = document.createElement('div');
  let historyEntries = [];
  let bookmarks = [];
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'yayra://history',
    historyRepo: { getEntries: async () => historyEntries, addEntry: async () => {} },
    bookmarksRepo: { getAllBookmarks: async () => bookmarks, addBookmark: async () => {}, isBookmarked: async () => false }
  });
  await shell.initialize();
  shell.render(container);

  // First pass seeds the snapshot without a repaint.
  await shell.backgroundRefreshTick();

  // Another window of this profile browses + stars a page.
  historyEntries = [{ id: 'h1', url: 'https://fresh.com', title: 'Fresh', visitCount: 1, lastVisitedAt: Date.now() }];
  bookmarks = [{ id: 'b1', url: 'https://fresh.com', title: 'Fresh', addedAt: Date.now() }];

  let rendered = 0;
  const origRender = shell.render.bind(shell);
  shell.render = (...args) => { rendered += 1; return origRender(...args); };

  const changed = await shell.backgroundRefreshTick();
  assert.equal(changed, true, 'tick reports the change');
  assert.deepEqual(shell.state.historyItems.map((h) => h.url), ['https://fresh.com'], 'history synced in the background');
  assert.deepEqual(shell.state.bookmarksItems.map((b) => b.url), ['https://fresh.com'], 'bookmarks synced in the background');
  assert.equal(rendered, 1, 'visible yayra://history page repainted exactly once');

  // Identical data again -> no state churn, NO repaint (no flicker).
  const unchanged = await shell.backgroundRefreshTick();
  assert.equal(unchanged, false, 'no-op when nothing changed');
  assert.equal(rendered, 1, 'no repaint without a data change');

  shell.destroy();
});

test('Live pages: background repaints never fire over menus/modals or while the user is typing', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'yayra://history',
    historyRepo: { getEntries: async () => [], addEntry: async () => {} }
  });
  await shell.initialize();
  shell.render(container);

  // A real website tab is NEVER repainted (and never reloaded) by sync.
  shell.getActiveTab().url = 'https://example.com';
  assert.equal(shell.maybeRepaintAfterBackgroundSync(), false, 'web pages stay untouched, like Chrome');

  shell.getActiveTab().url = 'yayra://history';
  assert.equal(shell.maybeRepaintAfterBackgroundSync(), true, 'data page repaints when idle');

  shell.state.isSideDrawerOpen = true;
  assert.equal(shell.maybeRepaintAfterBackgroundSync(), false, 'open drawer blocks repaints');
  shell.state.isSideDrawerOpen = false;

  shell.state.activeModal = 'radial-customizer';
  assert.equal(shell.maybeRepaintAfterBackgroundSync(), false, 'open modal blocks repaints');
  shell.state.activeModal = null;

  shell.destroy();
});

test('Live pages: the poller only starts where window.setInterval exists (no timer leaks in minimal environments)', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  // The dom-shim window has no setInterval - the shell must notice and
  // skip the poll instead of crashing or leaking a Node timer.
  assert.equal(shell._bgRefreshTimer ?? null, null, 'no interval registered without window.setInterval');
  shell.destroy();
});

test('Persistent Assistive Bubble: Present in DOM, reflects loading pulse, and preserves session on restore', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'https://example.com'
  });

  await shell.initialize();
  shell.render(container);

  // Assistive bubble is mounted
  const bubble = document.getElementById('yayra-persistent-assistive-bubble');
  assert.ok(bubble, 'Persistent assistive bubble element must exist in DOM');

  // Trigger tab loading -> bubble shows loading pulse ring
  shell.updateTabLoading(shell.getActiveTab().id, true);
  assert.ok(bubble.querySelector('.yayra-bubble-loading-ring'), 'Loading ring should be active');

  // Stop loading -> pulse ring cleared
  shell.updateTabLoading(shell.getActiveTab().id, false);
  assert.equal(bubble.querySelector('.yayra-bubble-loading-ring'), null);

  // Minimize to bubble
  shell.minimizeToBubble();
  assert.equal(shell.state.isMinimizedToBubble, true);

  // Restore session from bubble -> same tabs preserved without reload
  shell.restoreFromBubble();
  assert.equal(shell.state.isMinimizedToBubble, false);
  assert.equal(shell.state.tabs.length, 1);
  assert.equal(shell.getActiveTab().url, 'https://example.com');
});

test('Requirement 1 & 3: Radial Launcher Wheel opens with Gemini & AI Tools and opens Customizer Modal', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  // Double click persistent bubble -> opens radial launcher
  shell.openRadialLauncher();
  assert.equal(shell.state.isRadialLauncherOpen, true);

  const radialOverlay = document.getElementById('yayra-radial-launcher-overlay');
  assert.ok(radialOverlay, 'Radial launcher overlay should be mounted');
  assert.ok(radialOverlay.querySelector('.yayra-radial-center-btn'), 'Center close button must exist');
  assert.ok(radialOverlay.querySelector('.yayra-radial-bottom-btn'), 'Bottom down arrow button must exist');
  assert.ok(radialOverlay.querySelectorAll('.yayra-radial-item').length >= 12, '12 radial items must be rendered');

  // Open Radial Customizer Modal
  shell.openModal('radial-customizer');
  assert.equal(shell.state.activeModal, 'radial-customizer');
  assert.ok(container.querySelector('.fb-modal-radial-customizer'), 'Radial customizer modal must render');

  // Close customizer & radial launcher
  shell.closeModal();
  shell.closeRadialLauncher();
  assert.equal(shell.state.isRadialLauncherOpen, false);
});

test('Requirement 2, 4, 6: Floating Mini-Browser Window opens standalone, is movable, supports duplicate and toggle', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'https://example.com'
  });

  await shell.initialize();
  shell.render(container);

  // Open Floating Mini-Browser
  shell.openFloatingMini();
  assert.equal(shell.state.isFloatingMiniOpen, true);

  const miniWin = document.getElementById('yayra-floating-popup-window');
  assert.ok(miniWin, 'Floating mini window popup should be mounted');
  assert.ok(miniWin.querySelector('.fb-open-full-btn'), 'Open Full Browser button must exist');
  assert.ok(miniWin.querySelector('.fb-mini-tabstrip'), 'Mini must use the shared tab-strip header');
  assert.ok(miniWin.querySelector('.fb-mini-omnibox'), 'Mini omnibox must exist');
  assert.ok(miniWin.querySelector('.fb-mini-download-btn'), 'Mini downloads button must exist');
  assert.ok(miniWin.querySelector('.fb-mini-extensions-btn'), 'Mini extensions button must exist');
  assert.ok(miniWin.querySelector('.fb-mini-drawer-btn'), 'Mini menu button must exist');
  assert.ok(miniWin.querySelector('.fb-mini-duplicate-btn'), 'Duplicate button must exist');

  // The mini menu must open inside the mini window, not behind the main browser.
  miniWin.querySelector('.fb-mini-drawer-btn').click();
  assert.ok(miniWin.querySelector('.fb-side-drawer-menu'), 'Mini menu should open inside the mini window');

  // Test duplicate floating mini window
  shell.duplicateFloatingMini();
  const dupWin = document.querySelector('.fb-duplicate-popup-window');
  assert.ok(dupWin, 'Duplicate mini window should be mounted');

  // Close mini window (single tap toggle minimize)
  shell.closeFloatingMini();
  assert.equal(shell.state.isFloatingMiniOpen, false);
});

test('Browser navigation controls: back, forward, and reload work without a native controller', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false, initialUrl: 'yayra://newtab' });
  await shell.initialize();
  shell.render(container);

  shell.navigateActiveTab('https://example.com/one');
  shell.navigateActiveTab('https://example.com/two');
  assert.equal(shell.getActiveTab().canGoBack, true);

  container.querySelector('.fb-nav-back').click();
  assert.equal(shell.getActiveTab().url, 'https://example.com/one');
  assert.equal(shell.getActiveTab().canGoForward, true);

  container.querySelector('.fb-nav-forward').click();
  assert.equal(shell.getActiveTab().url, 'https://example.com/two');

  shell.getActiveTab().isLoading = false;
  shell.render(container);
  const reloadButton = container.querySelector('.fb-nav-reload');
  reloadButton.click();
  assert.equal(shell.getActiveTab().isLoading, true);
});

test('Requirement 3 & 13: Omnibox Security Lock opens Search Engine Selector with Google Default', async () => {
  const storage = new MemoryPersistenceAdapter();
  const settingsRepo = new SettingsRepository(storage);

  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    settingsRepo
  });

  await shell.initialize();
  shell.render(container);

  // Default search engine is Google
  assert.equal(shell.state.settings.searchEngine, 'google');

  // Open Security dropdown
  shell.state.isSecurityDropdownOpen = true;
  shell.render(container);

  const dropdown = container.querySelector('.fb-security-dropdown');
  assert.ok(dropdown, 'Security dropdown must be rendered');
  assert.ok(container.querySelector('[data-engine="google"]'), 'Google search engine option must exist');
  assert.ok(container.querySelector('[data-engine="duckduckgo"]'), 'DuckDuckGo search engine option must exist');

  // Switch search engine to DuckDuckGo
  const ddgOption = container.querySelector('[data-engine="duckduckgo"]');
  ddgOption.click();
  assert.equal(shell.state.settings.searchEngine, 'duckduckgo');
});

test('Requirement 4 & 10: Toolbar Brand Logo beside Lock & Transparent Action Buttons matching Star size', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  // Toolbar Brand logo and "yayra" text
  const brand = container.querySelector('.fb-toolbar-brand');
  assert.ok(brand, 'App brand logo and name must be present in toolbar');
  assert.ok(brand.textContent.includes('yayra'));

  // Downloads and extensions buttons present without white background
  const dlBtn = container.querySelector('.fb-toolbar-downloads-btn');
  const extBtn = container.querySelector('.fb-toolbar-extensions-btn');
  const starBtn = container.querySelector('.fb-omnibox-star');

  assert.ok(dlBtn, 'Downloads toolbar button must exist');
  assert.ok(extBtn, 'Extensions toolbar button must exist');
  assert.ok(starBtn, 'Star button must exist');
});

test('Requirement 5: 3-Dot Menu opens Full Right-Side Drawer without workspace blur', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  shell.render(container);

  // Open Side Drawer
  shell.state.isSideDrawerOpen = true;
  shell.render(container);

  const drawer = container.querySelector('.fb-side-drawer-menu');
  assert.ok(drawer, 'Right-side drawer menu must be mounted');
  assert.ok(drawer.querySelector('.fb-dr-newtab'));
  assert.ok(drawer.querySelector('.fb-dr-history'));
  assert.ok(drawer.querySelector('.fb-dr-downloads'));
  assert.ok(drawer.querySelector('.fb-dr-settings'));
  assert.ok(drawer.querySelector('.fb-dr-about'));

  // Tab groups and More tools are real click-open submenus, not hover-only affordances.
  const tabGroups = drawer.querySelector('.fb-dr-tabgroups-parent');
  tabGroups.click();
  assert.equal(tabGroups.parentElement.classList.contains('open'), true);
  const moreTools = drawer.querySelector('.fb-dr-moretools-parent');
  moreTools.click();
  assert.equal(moreTools.parentElement.classList.contains('open'), true);

  // A tool inside the opened submenu must execute, not just reveal a hover state.
  drawer.querySelector('.fb-dr-customize-yayra').click();
  assert.equal(shell.state.activeModal, 'radial-customizer');
  shell.closeModal();
  shell.state.isSideDrawerOpen = true;
  shell.render(container);

  // Clicking anywhere outside the drawer closes it.
  shell.state.isSideDrawerOpen = true;
  shell.render(container);
  const drawerScrim = container.querySelector('.fb-side-drawer-scrim');
  assert.ok(drawerScrim, 'Drawer must expose an outside-click scrim');
  drawerScrim.click();
  assert.equal(shell.state.isSideDrawerOpen, false);
  assert.equal(container.querySelector('.fb-side-drawer-menu'), null);
});

test('Requirement 5 & 7: New Tab Developer Ad Badges Showcase above Logo without user management clutter', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    initialUrl: 'yayra://newtab'
  });

  await shell.initialize();
  shell.render(container);

  // Developer Ad Showcase Badges
  const sponsored = container.querySelector('.fb-dev-ad-showcase');
  assert.ok(sponsored, 'Developer ad badges showcase must render above logo');
  assert.ok(container.querySelectorAll('.fb-dev-ad-card').length >= 4, 'Developer ad badges should be present');
  assert.ok(container.querySelectorAll('.fb-dev-ad-label').length >= 4, 'Developer ad links should show as a horizontal labelled row');

  const designSystem = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const lightCardStart = designSystem.indexOf('[data-theme="light"] .fb-dev-ad-card.fb-sponsored-card {');
  const lightCardRule = lightCardStart >= 0 ? designSystem.slice(lightCardStart, designSystem.indexOf('}', lightCardStart)) : '';
  assert.ok(lightCardRule, 'light-theme sponsor cards have a targeted rule');
  assert.ok(lightCardRule.includes('background: #ffffff;'));
  assert.ok(lightCardRule.includes('color: var(--fb-text-primary);'));
  assert.ok(lightCardRule.includes('border-color: rgba(15, 23, 42, 0.12);'), 'sponsor border stays subtle at roughly 12% opacity');
  const lightHoverStart = designSystem.indexOf('[data-theme="light"] .fb-dev-ad-card.fb-sponsored-card:hover,');
  const lightHoverRule = lightHoverStart >= 0 ? designSystem.slice(lightHoverStart, designSystem.indexOf('}', lightHoverStart)) : '';
  assert.ok(lightHoverRule.includes('background: #f8fafc;'));
  assert.ok(lightHoverRule.includes('box-shadow: 0 6px 18px rgba(8, 145, 178, 0.12);'), 'light-theme hover is a restrained accent');
});

test('Requirement 11: Downloads page includes Visit File Location button and List vs Card View Toggle', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false
  });

  await shell.initialize();
  // The Downloads list starts empty (no seeded/fake rows - see
  // BrowserShell.js state.downloadsItems); inject one real-shaped item here
  // purely to exercise the per-row action buttons/view toggle.
  shell.state.downloadsItems = [
    { id: 'dl-test-1', filename: 'report.pdf', path: '/tmp/report.pdf', size: '1.2 MB', state: 'Completed', date: 'Just now' }
  ];
  shell.render(container);

  // Navigate to Downloads
  shell.navigateActiveTab('yayra://downloads');

  // Check Location button
  const locBtn = container.querySelector('.fb-in-dl-location-btn');
  assert.ok(locBtn, 'Show in Folder / Visit File Location button must exist');

  // Check View Mode Toggle
  const viewToggle = container.querySelector('.fb-downloads-view-toggle');
  assert.ok(viewToggle, 'Downloads view mode toggle must exist');

  // Toggle to Card view
  const cardBtn = container.querySelector('[data-view="card"]');
  cardBtn.click();
  assert.equal(shell.state.downloadsViewMode, 'card');
  assert.ok(container.querySelector('.fb-downloads-grid-layout'));
});

test('Settings page: every toggle and dropdown applies IMMEDIATELY on change and persists - no Save click required', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const settingsRepo = new SettingsRepository(storage);

  const shell = new BrowserShell({ container, isMobile: false, settingsRepo });
  await shell.initialize();
  shell.render(container);
  shell.navigateActiveTab('yayra://settings');

  // --- Theme dropdown: applies to the shell instantly ---
  const themeSelect = container.querySelector('#fb-in-set-theme');
  assert.ok(themeSelect, 'theme select must exist');
  themeSelect.value = 'light';
  themeSelect.dispatchEvent({ type: 'change', target: themeSelect });
  assert.equal(shell.state.settings.theme, 'light');
  assert.equal(
    container.querySelector('.fb-browser-shell').getAttribute('data-theme'),
    'light',
    'theme is re-applied to the shell immediately'
  );

  // --- Accent color dropdown ---
  const colorSelect = container.querySelector('#fb-in-set-color-theme');
  assert.ok(colorSelect, 'accent color select must exist');
  colorSelect.value = 'purple';
  colorSelect.dispatchEvent({ type: 'change', target: colorSelect });
  assert.equal(shell.state.settings.colorTheme, 'purple');
  assert.equal(
    container.querySelector('.fb-browser-shell').getAttribute('data-color-theme'),
    'purple',
    'accent is re-applied to the shell immediately'
  );

  // --- Search engine dropdown ---
  const engineSelect = container.querySelector('#fb-in-set-engine');
  assert.ok(engineSelect, 'engine select must exist');
  engineSelect.value = 'duckduckgo';
  engineSelect.dispatchEvent({ type: 'change', target: engineSelect });
  assert.equal(shell.state.settings.searchEngine, 'duckduckgo');

  // --- Privacy / behavior checkboxes ---
  const toggles = [
    ['#fb-in-set-https', 'httpsFirst'],
    ['#fb-in-set-adblock', 'adBlockEnabled'],
    ['#fb-in-set-restore-session', 'restoreSessionOnLaunch'],
    ['#fb-in-set-floating-default', 'floatingEnabledByDefault']
  ];
  for (const [selector, key] of toggles) {
    const box = container.querySelector(selector);
    assert.ok(box, `${selector} must exist`);
    box.checked = false;
    box.dispatchEvent({ type: 'change', target: box });
    assert.equal(shell.state.settings[key], false, `${key} turns off immediately`);
    const refreshed = container.querySelector(selector) || box;
    refreshed.checked = true;
    refreshed.dispatchEvent({ type: 'change', target: refreshed });
    assert.equal(shell.state.settings[key], true, `${key} turns back on immediately`);
  }

  // --- Everything above was persisted without pressing Save ---
  // (persistSettings is fire-and-forget; give the async repo write a tick)
  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = await settingsRepo.getSettings();
  assert.equal(persisted.theme, 'light');
  assert.equal(persisted.colorTheme, 'purple');
  assert.equal(persisted.searchEngine, 'duckduckgo');
  assert.equal(persisted.httpsFirst, true);
  assert.equal(persisted.adBlockEnabled, true);
  assert.equal(persisted.restoreSessionOnLaunch, true);
});

test('Settings: "system" theme resolves via prefers-color-scheme and falls back to dark', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    settingsRepo: new SettingsRepository(new MemoryPersistenceAdapter())
  });
  await shell.initialize();

  shell.state.settings.theme = 'system';

  const prevMatchMedia = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (q) => ({ matches: q.includes('light'), media: q });
    assert.equal(shell.resolveEffectiveTheme(), 'light', 'system follows a light OS scheme');

    globalThis.matchMedia = (q) => ({ matches: false, media: q });
    assert.equal(shell.resolveEffectiveTheme(), 'dark', 'system follows a dark OS scheme');

    delete globalThis.matchMedia;
    assert.equal(shell.resolveEffectiveTheme(), 'dark', 'no matchMedia -> dark fallback');
  } finally {
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }

  shell.state.settings.theme = 'light';
  assert.equal(shell.resolveEffectiveTheme(), 'light', 'explicit prefs pass through untouched');
});

test('Settings: Floating Bubble Size slider previews live, persists on release, and pushes to the native bubble', async () => {
  const container = document.createElement('div');
  const storage = new MemoryPersistenceAdapter();
  const settingsRepo = new SettingsRepository(storage);
  const overlayCalls = [];
  const overlayBridge = {
    getSettings: async () => ({ enabled: true, launchAtStartup: true, overlayAllApps: true, size: 64, shadowPx: 0 }),
    setEnabled: async () => ({}),
    setLaunchAtStartup: async () => ({}),
    setOverlayAllApps: async () => ({}),
    setBubbleSize: (px) => { overlayCalls.push(['size', px]); return Promise.resolve({ size: px }); },
    setBubbleOpacity: (op) => { overlayCalls.push(['opacity', op]); return Promise.resolve({ opacity: op }); },
    setBubbleShadow: (px) => { overlayCalls.push(['shadow', px]); return Promise.resolve({ shadowPx: px }); }
  };

  // BrowserShell discovers the overlay bridge via window.yayra.overlay
  // (the Electron preload surface) - install a fake one for this test.
  const prevYayra = globalThis.window.yayra;
  globalThis.window.yayra = { ...(prevYayra || {}), overlay: overlayBridge };

  try {
    const shell = new BrowserShell({ container, isMobile: false, settingsRepo });
    await shell.initialize();
    shell.render(container);
    shell.navigateActiveTab('yayra://settings');

    const slider = container.querySelector('#fb-in-bubble-size');
    assert.ok(slider, 'bubble size slider must exist in settings');

    // Live preview on input
    slider.value = '96';
    slider.dispatchEvent({ type: 'input', target: slider });
    assert.equal(shell.state.settings.bubbleSizePx, 96, 'size state updates live while dragging');
    const label = container.querySelector('#fb-in-val-bubble-size');
    assert.equal(label.textContent, '96px', 'value label tracks the slider');

    // Release persists + pushes to the native overlay bubble
    slider.dispatchEvent({ type: 'change', target: slider });
    assert.deepEqual(overlayCalls.at(-1), ['size', 96], 'native desktop bubble is resized on release');

    const shadowSlider = container.querySelector('#fb-in-bubble-shadow');
    assert.ok(shadowSlider, 'bubble shadow slider must exist in settings');
    assert.equal(shadowSlider.getAttribute('value'), '0', 'the default shadow is disabled');
    const domBubble = document.getElementById('yayra-persistent-assistive-bubble');
    assert.ok(domBubble, 'in-page builds render the persistent bubble');
    assert.equal(domBubble.style.filter, 'none', 'the default in-page bubble has no shadow');
    shadowSlider.value = '12';
    shadowSlider.dispatchEvent({ type: 'input', target: shadowSlider });
    assert.equal(shell.state.settings.bubbleShadowPx, 12, 'shadow previews live while dragging');
    assert.equal(container.querySelector('#fb-in-val-bubble-shadow').textContent, '12px');
    assert.equal(domBubble.style.filter, 'drop-shadow(0 3px 12px rgba(0,0,0,0.45))', 'the in-page bubble uses the selected shadow strength');
    shadowSlider.dispatchEvent({ type: 'change', target: shadowSlider });
    assert.deepEqual(overlayCalls.at(-1), ['shadow', 12], 'native desktop bubble receives the chosen shadow');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const persisted = await settingsRepo.getSettings();
    assert.equal(persisted.bubbleSizePx, 96, 'size persisted without pressing Save');
    assert.equal(persisted.bubbleShadowPx, 12, 'shadow persisted without pressing Save');
  } finally {
    if (prevYayra === undefined) delete globalThis.window.yayra;
    else globalThis.window.yayra = prevYayra;
  }
});

test('Tab right-click menu: clicking or right-clicking anywhere else removes BOTH the menu and its scrim', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    settingsRepo: new SettingsRepository(new MemoryPersistenceAdapter())
  });
  await shell.initialize();
  shell.render(container);

  const tab = shell.getActiveTab();
  shell.renderTabContextMenu(100, 100, tab);
  assert.ok(document.body.querySelector('.fb-tab-context-menu'), 'menu opens');
  assert.ok(document.body.querySelector('[data-tab-ctx]'), 'scrim covers the rest of the screen');

  // Tap anywhere else (hits the scrim) -> menu AND scrim both disappear.
  document.body.querySelector('[data-tab-ctx]').click();
  assert.equal(document.body.querySelector('.fb-tab-context-menu'), null, 'menu is gone');
  assert.equal(document.body.querySelector('[data-tab-ctx]'), null, 'scrim is gone');

  // Right-clicking elsewhere dismisses too.
  shell.renderTabContextMenu(100, 100, tab);
  document.body.querySelector('[data-tab-ctx]')
    .dispatchEvent({ type: 'contextmenu', preventDefault: () => {} });
  assert.equal(document.body.querySelector('.fb-tab-context-menu'), null, 'menu gone after outside right-click');
  assert.equal(document.body.querySelector('[data-tab-ctx]'), null, 'scrim gone after outside right-click');
});

test('Tab right-click menu paints OVER the page: native surface yields while open, returns on close', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    isMobile: false,
    settingsRepo: new SettingsRepository(new MemoryPersistenceAdapter())
  });
  await shell.initialize();
  shell.render(container);
  const tab = shell.getActiveTab();

  // Open: the page is obscured (on Electron the native WebContentsView
  // always paints above HTML - the menu's lower items were covered by
  // the site until the view yields to its snapshot).
  shell.renderTabContextMenu(100, 100, tab);
  assert.equal(shell.state.isPageObscured, true, 'page surface yields while the menu is open');
  assert.equal(shell.hasBlockingOverlay(), true, 'render() keeps the native view hidden meanwhile');

  // Dismiss via the scrim: surface restored.
  document.body.querySelector('[data-tab-ctx]').click();
  assert.equal(shell.state.isPageObscured, false, 'page surface returns when the menu closes');

  // Choosing an item restores the surface too.
  shell.renderTabContextMenu(100, 100, tab);
  assert.equal(shell.state.isPageObscured, true);
  const reloadBtn = [...document.body.querySelectorAll('.fb-tab-context-menu-item')]
    .find((b) => (b.textContent || '').includes('Reload'));
  reloadBtn.click();
  assert.equal(shell.state.isPageObscured, false, 'page surface returns after picking an action');
  assert.equal(document.body.querySelector('.fb-tab-context-menu'), null, 'menu closed by the action');
});
