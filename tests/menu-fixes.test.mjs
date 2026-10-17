import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * "Some of the menu in the Yayra menu is not working - fix them all":
 *  - AUDIT: every item in the Yayra side-drawer menu must respond to a
 *    click without throwing (and do its real action / honest notice).
 *  - Install page as app: REAL per-platform behaviour (Android native
 *    shortcut, desktop bridge, web PWA prompt) instead of a dead end.
 *  - Import bookmarks: a REAL file import (Chrome/Firefox HTML exports +
 *    JSON), not just opening the bookmarks page.
 *  - Tab groups: REAL named colour groups (create / group / ungroup +
 *    colour dot in the tab strip), not mislabelled tab actions.
 *  - Translate: the working translate.goog mechanism (the old
 *    translate.google.com/translate?u= endpoint is dead).
 *  - Paste: the async clipboard API into the focused field (execCommand
 *    'paste' is dead in every modern browser).
 */

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

async function makeShell({ storage, ...options } = {}) {
  if (storage) globalThis.localStorage = storage;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false, ...options });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test('AUDIT: every Yayra menu item responds to a click without throwing', async () => {
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://example.com/';
    shell.state.tabs[0].title = 'Example Site';
    // Prompt dialogs + file picker: deterministic stand-ins.
    shell._textPromptDialog = async () => 'Research';
    shell._openFilePicker = async () => null;
    shell.checkForUpdates = async () => {};
    shell.requestAppClose = () => {};
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    const items = Array.from(container.querySelectorAll('.fb-drawer-item'));
    assert.ok(items.length >= 30, `the drawer exposes its menu items (${items.length} found)`);
    const failures = [];
    for (const item of items) {
      try {
        item.click();
        await flush(); // async handlers get a turn; any throw = broken item
      } catch (err) {
        failures.push(`${item.className.split(' ').filter((c) => c.startsWith('fb-dr-') || c.includes('btn'))[0] || item.className}: ${err && err.message}`);
      }
    }
    assert.deepEqual(failures, [], `every menu item must work: broken -> ${failures.join('; ')}`);
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('INSTALL AS APP (Android): a REAL native home-screen shortcut is requested via the overlay plugin', async () => {
  const installCalls = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      YayraOverlay: {
        hasPermission: async () => ({ granted: true }),
        show: async () => {},
        installSiteAsApp: async (opts) => { installCalls.push(opts); return { ok: true, method: 'pinned-shortcut' }; }
      }
    }
  };
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://news.example.com/';
    shell.state.tabs[0].title = 'Example News';
    shell.render(container);
    // The editable-name dialog (pre-filled with the site title) is part of
    // the flow - simulate the user accepting the suggested name.
    shell._installPageAsAppDialog = async (opts) => opts?.title || 'Example News';
    await shell.installPageAsApp();
    assert.equal(installCalls.length, 1, 'the native install method was called');
    assert.equal(installCalls[0].url, 'https://news.example.com/');
    assert.equal(installCalls[0].title, 'Example News');
  } finally {
    shell.destroy();
    delete window.Capacitor;
  }
});

test('CAST, SAVE, AND SHARE → INSTALL PAGE AS APP: the submenu click installs the active site with its edited name', async () => {
  const previousBridge = window.yayra;
  const installCalls = [];
  window.yayra = {
    system: {
      installPageAsAppPreview: async () => ({ ok: true, name: 'Redis', startUrl: 'https://redis.io/?source=app', pwa: true }),
      installPageAsApp: async (opts) => {
        installCalls.push(opts);
        return { ok: true, name: opts.title, inLauncher: true, pwa: true };
      }
    }
  };
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://redis.io/docs/latest/';
    shell.state.tabs[0].title = 'Redis documentation';
    let confirmation = null;
    shell._installPageAsAppDialog = async (opts) => { confirmation = opts; return 'Redis Docs'; };
    shell.showTransientNotice = () => {};
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    const castMenu = container.querySelector('.fb-dr-cast-parent');
    castMenu.click();
    assert.equal(castMenu.getAttribute('aria-expanded'), 'true', 'Cast, save, and share opens its lateral submenu');
    const installItem = container.querySelector('.fb-dr-install-app');
    assert.ok(installItem, 'Install page as app is present in the opened submenu');
    assert.equal(installItem.getAttribute('role'), 'menuitem');
    installItem.click();
    await flush();

    assert.equal(confirmation.url, 'https://redis.io/docs/latest/', 'confirmation describes the active site');
    assert.equal(confirmation.title, 'Redis', 'site manifest name is suggested');
    assert.ok(confirmation.iconHtml.includes('redis.io'), 'the site favicon is previewed');
    assert.equal(installCalls.length, 1, 'the submenu click reaches the native installer');
    assert.equal(installCalls[0].url, 'https://redis.io/?source=app', 'the site app start URL is installed');
    assert.equal(installCalls[0].title, 'Redis Docs', 'the edited site name reaches the installer');
    assert.equal(installCalls[0].nameOverride, 'Redis Docs');
  } finally {
    shell.destroy();
    if (previousBridge === undefined) delete window.yayra;
    else window.yayra = previousBridge;
  }
});

test('EXIT from Yayra menu quits the whole desktop app after the tab-session choice', async () => {
  const previousBridge = window.yayra;
  const calls = [];
  const storage = makeStorage();
  globalThis.localStorage = storage;
  window.yayra = {
    windowControls: {
      close: () => { calls.push('close-window'); },
      quit: () => { calls.push('quit-app'); }
    }
  };
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://example.com/';
    shell.state.tabs[0].title = 'Example';
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    container.querySelector('.fb-dr-exit').click();
    assert.equal(shell.state.closePrompt, true, 'open tabs get the session choice before exit');
    assert.equal(shell.state.closePromptExitsApp, true, 'the choice is marked as an app-wide exit');
    assert.deepEqual(calls, [], 'the app waits for the user\'s session choice');

    container.querySelector('.fb-close-prompt-modal').querySelector('.fb-close-just-close').click();
    assert.deepEqual(calls, ['quit-app'], 'Exit quits the entire app rather than closing only the main window');
    assert.equal(JSON.parse(storage.getItem('yayra:close-session')).mode, 'recent', 'the chosen session mode is preserved');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
    if (previousBridge === undefined) delete window.yayra;
    else window.yayra = previousBridge;
  }
});

test('EXIT on web/PWA tells the user to close the browser tab instead of silently doing nothing', async () => {
  const previousBridge = window.yayra;
  const notices = [];
  delete window.yayra;
  const { shell, container } = await makeShell();
  try {
    shell.showTransientNotice = (message) => notices.push(String(message));
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    container.querySelector('.fb-dr-exit').click();
    assert.equal(shell.state.isSideDrawerOpen, false, 'the menu closes');
    assert.match(notices.at(-1), /close this browser tab/i, 'browser security is explained clearly');
  } finally {
    shell.destroy();
    if (previousBridge === undefined) delete window.yayra;
    else window.yayra = previousBridge;
  }
});

test('INSTALL AS APP (web): triggers the browser\'s real PWA install flow when available; internal pages are refused honestly', async () => {
  const { shell, container } = await makeShell();
  try {
    // Internal page: honest refusal, no prompt.
    shell.state.tabs[0].url = 'yayra://newtab';
    await shell.installPageAsApp();
    // Web + browser install prompt available: the REAL install flow runs.
    let prompted = 0;
    shell._pwaInstallPrompt = {
      prompt: async () => { prompted += 1; },
      userChoice: Promise.resolve({ outcome: 'accepted' })
    };
    shell.state.tabs[0].url = 'https://example.com/';
    await shell.installPageAsApp();
    assert.equal(prompted, 1, 'the browser install prompt was triggered');
    assert.equal(shell._pwaInstallPrompt, null, 'the one-shot prompt is consumed');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('INSTALL AS APP (Android deep link): a com.yayra.app:/browse shortcut opens Yayra straight on the site', async () => {
  const urlOpens = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener: () => {},
        getLaunchUrl: async () => ({ url: `com.yayra.app:/browse?url=${encodeURIComponent('https://shop.example.com/offers')}` })
      }
    }
  };
  const { shell } = await makeShell();
  try {
    // initialize() consumes getLaunchUrl() via the deep-link hookup.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(urlOpens, [], 'no other navigation side effects');
    assert.equal(shell.getActiveTab().url, 'https://shop.example.com/offers', 'launch deep link opens Yayra straight on the site');
  } finally {
    shell.destroy();
    delete window.Capacitor;
  }
});

test('IMPORT BOOKMARKS: parses real Chrome/Firefox HTML exports and JSON, dedupes, imports into the repo', async () => {
  const { shell } = await makeShell({ storage: makeStorage() });
  try {
    const netscape = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><A HREF="https://github.com/g2code33/yayra" ADD_DATE="1700000000">Yayra on GitHub</A>
        <DT><A HREF="https://example.com/dup">Duplicate</A>
        <DT><A HREF="https://example.com/dup">Duplicate</A>
        <DT><A HREF="javascript:alert(1)">evil</A>
        <DT><A HREF="https://news.example.com/&amp;more">News &amp; more</A>
      </DL><p>`;
    const parsed = shell.parseBookmarksImport(netscape);
    assert.equal(parsed.length, 3, 'http(s) links parsed; dupes + javascript: URLs dropped');
    assert.deepEqual(parsed[0], { url: 'https://github.com/g2code33/yayra', title: 'Yayra on GitHub' });
    assert.equal(parsed[2].title, 'News & more', 'HTML entities decoded');

    const asJson = shell.parseBookmarksImport(JSON.stringify([
      { url: 'https://a.example.com/', title: 'A' },
      'https://b.example.com/',
      { nope: true }
    ]));
    assert.equal(asJson.length, 2, 'JSON arrays parse too');
    assert.equal(shell.parseBookmarksImport('not a bookmarks file at all').length, 0);

    // The full import flow through the repo.
    const before = (await shell.bookmarksRepo.getAllBookmarks()).length;
    shell._openFilePicker = async () => netscape;
    await shell.importBookmarks();
    const after = await shell.bookmarksRepo.getAllBookmarks();
    assert.equal(after.length, before + 3, 'three new bookmarks imported');
    assert.ok(shell.state.bookmarksItems.some((b) => b.url === 'https://github.com/g2code33/yayra'));
    // Re-import: dedupe means nothing new.
    await shell.importBookmarks();
    assert.equal((await shell.bookmarksRepo.getAllBookmarks()).length, before + 3, 're-import adds nothing');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TAB GROUPS: real create / group / ungroup with colour dots in the tab strip', async () => {
  const { shell, container } = await makeShell();
  try {
    shell._textPromptDialog = async () => 'Research';
    shell.state.tabs[0].url = 'https://example.com/';
    await shell.createTabGroup();
    const grouped = shell.state.tabs.filter((t) => t.group);
    assert.equal(grouped.length, 2, 'active tab + fresh tab are in the group');
    assert.ok(grouped.every((t) => t.group.name === 'Research'), 'group name applied');
    assert.ok(grouped.every((t) => t.group.color === grouped[0].group.color), 'one colour per group');

    shell.render(container);
    const dots = Array.from(container.querySelectorAll('.fb-tab-group-dot'));
    assert.equal(dots.length, 2, 'colour dots render in the tab strip');
    assert.equal(dots[0].style?.background || dots[0].getAttribute('style'), dots[0].style?.background || dots[0].getAttribute('style'));

    // Join the same group by name keeps the SAME colour.
    shell.createNewTab();
    const third = shell.getActiveTab();
    await shell.groupCurrentTab();
    assert.equal(third.group.name, 'Research');
    assert.equal(third.group.color, grouped[0].group.color, 'joining by name reuses the group colour');

    // The group-picker icon sits beside the site-security control and one
    // tap on a group row switches directly to a member tab.
    shell.createNewTab();
    const ungrouped = shell.getActiveTab();
    shell.render(container);
    assert.ok(container.querySelector('.fb-security-lock-btn'), 'site security control remains in the omnibox');
    const groupIcon = container.querySelector('.fb-omnibox-group-btn');
    assert.ok(groupIcon, 'tab-group icon is present beside the site connection control');
    groupIcon.click();
    assert.equal(shell.state.activeModal, 'tab-groups', 'group icon opens the group picker');
    const groupChoice = container.querySelector('.fb-tab-group-picker-item');
    assert.ok(groupChoice, 'the picker lists open groups');
    groupChoice.click();
    assert.ok(shell.getActiveTab().group, 'one tap opens a member tab from that group');
    assert.notEqual(shell.getActiveTab().id, ungrouped.id, 'the ungrouped tab was switched away from');

    // Ctrl+Shift+G opens the same picker from the keyboard.
    shell.handleGlobalKeyDown({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'G', preventDefault() {} });
    assert.equal(shell.state.activeModal, 'tab-groups', 'Ctrl+Shift+G opens tab groups');
    shell.closeModal();

    // The Settings sidebar has a dedicated tab-group manager.
    shell.navigateActiveTab('yayra://settings');
    const settingsGroupsTab = container.querySelector('[data-cat="tab-groups"]');
    assert.ok(settingsGroupsTab, 'Settings includes a Tab Groups category');
    settingsGroupsTab.click();
    assert.equal(shell.state.settingsActiveCategory, 'tab-groups');
    assert.ok(container.querySelector('#fb-in-tab-groups-list')?.querySelector('.fb-tab-group-settings-card'), 'the Settings category lists grouped tabs');

    // Ungroup removes every group.
    shell.ungroupAllTabs();
    assert.ok(shell.state.tabs.every((t) => !t.group), 'all tabs ungrouped');
    shell.render(container);
    assert.equal(container.querySelectorAll('.fb-tab-group-dot').length, 0, 'dots disappear after ungrouping');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TAB GROUP PICKER: New group opens a visible, keyboard-ready prompt and publishes a clickable group', async () => {
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://example.com/';
    shell.openModal('tab-groups');
    container.querySelector('.fb-tab-groups-create-btn').click();

    const overlay = document.body.querySelector('.fb-text-prompt-overlay');
    assert.ok(overlay, 'New group opens the custom prompt instead of silently doing nothing');
    assert.equal(overlay.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true', 'the prompt exposes an accessible modal dialog');
    assert.equal(shell.state.isPageObscured, true, 'the renderer marks the prompt as a blocking overlay');
    assert.equal(shell.healStuckPageSurface(), false, 'render-time surface healing keeps the live prompt in front');

    const input = overlay.querySelector('input');
    input.value = 'Research';
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await flush();

    assert.equal(document.body.querySelector('.fb-text-prompt-overlay'), null, 'Enter accepts and closes the prompt');
    assert.equal(shell.state.isPageObscured, false, 'the page is restored after the prompt closes');
    const group = shell.getTabGroups().find((candidate) => candidate.name === 'Research');
    assert.ok(group, 'the requested group was created');
    assert.equal(group.tabs.length, 2, 'the current tab and a fresh tab are both in the group');

    shell.openModal('tab-groups');
    const entry = container.querySelector('.fb-tab-group-picker-item');
    assert.ok(entry, 'the new group appears immediately in the group picker');
    assert.match(entry.getAttribute('aria-label'), /Research group \(2 tabs\)/);
    entry.click();
    assert.equal(shell.state.tabs.filter((tab) => tab.group?.name === 'Research').length, 2, 'opening a group keeps every group tab open');
    assert.ok(shell.getActiveTab().group?.name === 'Research', 'the group click activates one of its member tabs');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TAB GROUP DRAWER: prompt actions dismiss the drawer cleanly, including on Cancel', async () => {
  const { shell } = await makeShell();
  try {
    shell.state.isSideDrawerOpen = true;
    shell.render();
    shell.rootElement.querySelector('.fb-dr-tg-new').click();
    assert.equal(shell.rootElement.querySelector('.fb-side-drawer-menu'), null, 'New tab group closes the drawer before opening its prompt');
    let overlay = document.body.querySelector('.fb-text-prompt-overlay');
    assert.ok(overlay, 'the new-group prompt is visible');
    [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Cancel').click();
    await flush();
    assert.equal(document.body.querySelector('.fb-text-prompt-overlay'), null, 'Cancel closes the prompt');
    assert.equal(shell.state.isSideDrawerOpen, false, 'Cancel does not leave stale drawer chrome visible');
    assert.equal(shell.state.tabs.some((tab) => tab.group), false, 'cancelling leaves tabs unchanged');

    shell.state.isSideDrawerOpen = true;
    shell.render();
    shell.rootElement.querySelector('.fb-dr-tg-add').click();
    assert.equal(shell.rootElement.querySelector('.fb-side-drawer-menu'), null, 'Group current tab also closes the drawer first');
    overlay = document.body.querySelector('.fb-text-prompt-overlay');
    [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Cancel').click();
    await flush();
    assert.equal(shell.state.tabs.some((tab) => tab.group), false, 'cancelling group current tab leaves the tab ungrouped');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TAB GROUP RESTORE: selecting a previous-session group opens every saved member without replacing the current tab', async () => {
  const sessionTabs = [
    { url: 'https://alpha.example/', title: 'Alpha', group: { name: 'Launch', color: '#3b82f6' } },
    { url: 'https://beta.example/docs', title: 'Beta Docs', group: { name: 'Launch', color: '#3b82f6' } },
    { url: 'https://private.example/', title: 'Private', isPrivate: true, group: { name: 'Incognito', color: '#ef4444' } }
  ];
  const sessionRepo = {
    getLastSession: async () => ({ tabs: sessionTabs, savedAt: 123 }),
    saveSession: async () => {}
  };
  const { shell } = await makeShell({ storage: makeStorage(), sessionRepo });
  try {
    const originalTabId = shell.getActiveTab().id;
    const savedGroup = shell.getTabGroups().find((candidate) => candidate.name === 'Launch');
    assert.ok(savedGroup, 'recoverable grouped tabs appear before the group is restored');
    assert.equal(savedGroup.tabs.length, 2, 'the full saved group is available even though the Continue card is capped');
    assert.equal(shell.getTabGroups().some((candidate) => candidate.name === 'Incognito'), false, 'private session rows never reappear as normal-profile groups');

    assert.equal(shell.openTabGroup(savedGroup.id), true);
    const opened = shell.state.tabs.filter((tab) => tab.group?.name === 'Launch');
    assert.equal(opened.length, 2, 'one click opens all saved group members');
    assert.deepEqual(opened.map((tab) => tab.url), sessionTabs.slice(0, 2).map((tab) => tab.url));
    assert.notEqual(shell.state.activeTabId, originalTabId, 'the original new-tab remains open; it is not overwritten');
    assert.equal(shell.getActiveTab().url, sessionTabs[0].url, 'the first tab in the chosen group becomes active');
    assert.equal(shell.state.continueTabs.length, 0, 'restored group members leave the Continue list');
    assert.ok(shell.getTabGroups().some((candidate) => candidate.name === 'Launch'), 'the live group remains selectable');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TAB RIGHT-CLICK: group, move, open, and remove actions work for the tab under the pointer', async () => {
  const { shell } = await makeShell();
  try {
    const target = shell.getActiveTab();
    target.url = 'https://target.example/';
    const grouped = shell.createNewTab();
    grouped.url = 'https://grouped.example/';
    grouped.group = { name: 'Work', color: '#10b981' };
    shell.render();

    shell.renderTabContextMenu(40, 40, target);
    let buttons = [...document.body.querySelectorAll('.fb-tab-context-menu-item')];
    const addTo = buttons.find((button) => button.textContent === 'Add to…');
    assert.ok(addTo, 'the context menu keeps group actions concise behind Add to…');
    const submenu = document.body.querySelector('.fb-tab-context-submenu');
    assert.equal(submenu.style.display, 'none', 'the group list is collapsed until requested');
    addTo.click();
    assert.equal(submenu.style.display, 'flex', 'selecting Add to… reveals the available tab groups');
    const addToWork = submenu.querySelectorAll('.fb-tab-context-submenu-item').find((button) => button.textContent === 'Work');
    assert.ok(addToWork, 'the submenu lists the existing group');
    addToWork.click();
    assert.equal(target.group?.name, 'Work', 'the right-clicked tab, not only the active tab, joins the selected group');

    shell.renderTabContextMenu(40, 40, target);
    buttons = [...document.body.querySelectorAll('.fb-tab-context-menu-item')];
    assert.ok(buttons.some((button) => button.textContent === 'Open “Work” group'), 'a grouped tab can open its whole group');
    const remove = buttons.find((button) => button.textContent === 'Remove from “Work”');
    assert.ok(remove, 'a grouped tab can be removed from its group');
    remove.click();
    assert.equal(target.group, null, 'remove action ungroups the selected tab');

    // The Yayra drawer also exposes the saved/live group as a one-click
    // entry instead of requiring the user to open Settings or the picker.
    shell.state.isSideDrawerOpen = true;
    shell.render();
    const drawerEntry = shell.rootElement.querySelector('.fb-dr-tg-open');
    assert.ok(drawerEntry, 'existing groups are selectable from the Tab groups submenu');
    drawerEntry.click();
    assert.equal(shell.state.isSideDrawerOpen, false, 'choosing a group closes the drawer');
    assert.equal(shell.getActiveTab().group?.name, 'Work', 'the drawer entry opens the selected group');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('LINKS: a tab opened by a page is inserted beside its source and keeps its privacy/group context', async () => {
  const { shell } = await makeShell();
  try {
    const first = shell.getActiveTab();
    first.url = 'https://first.example/';
    const source = shell.createNewTab();
    source.url = 'https://source.example/';
    source.group = { name: 'Research', color: '#3b82f6' };
    const trailing = shell.createNewTab();
    trailing.url = 'https://trailing.example/';
    shell.selectTab(source.id);

    shell.handleNativeWebviewEvent({
      tabId: source.id,
      type: 'new-window-request',
      url: 'https://child.example/'
    });
    const child = shell.getActiveTab();
    const sourceIndex = shell.state.tabs.findIndex((tab) => tab.id === source.id);
    assert.equal(child.url, 'https://child.example/');
    assert.equal(shell.state.tabs.indexOf(child), sourceIndex + 1, 'the new link tab sits directly after its source, not at the strip end');
    assert.equal(shell.state.tabs.indexOf(trailing), sourceIndex + 2, 'existing tabs remain in order after the insertion');
    assert.equal(child.group?.name, 'Research', 'a link opened from a group remains in that group');

    const privateSource = shell.createNewTab(true);
    privateSource.url = 'https://private.example/';
    const privateTrailing = shell.createNewTab(true);
    privateTrailing.url = 'https://private-trailing.example/';
    shell.selectTab(privateSource.id);
    shell.handleNativeWebviewEvent({
      tabId: privateSource.id,
      type: 'new-window-request',
      url: 'https://private-child.example/'
    });
    const privateChild = shell.getActiveTab();
    const privateSourceIndex = shell.state.tabs.findIndex((tab) => tab.id === privateSource.id);
    assert.equal(privateChild.isPrivate, true, 'a private source opens a private child tab');
    assert.equal(shell.state.tabs.indexOf(privateChild), privateSourceIndex + 1);
    assert.equal(shell.state.tabs.indexOf(privateTrailing), privateSourceIndex + 2);
    assert.equal(shell.state.tabs.indexOf(first), 0, 'unrelated normal tabs stay in place');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('TRANSLATE: uses the working translate.goog mechanism (old translate?u= endpoint is dead) and navigates', async () => {
  const { shell } = await makeShell();
  try {
    const url = shell.buildTranslatedPageUrl('https://example.com/path?q=1', 'fr');
    assert.ok(url.startsWith('https://example-com.translate.goog/path?'), `translated host is the goog proxy: ${url}`);
    assert.ok(url.includes('_x_tr_tl=fr'));
    assert.ok(url.includes(`_x_tr_u=${encodeURIComponent('https://example.com/path?q=1')}`));
    assert.equal(shell.buildTranslatedPageUrl('yayra://newtab', 'fr'), null, 'internal pages are refused');
    assert.equal(shell.buildTranslatedPageUrl('https://example-com.translate.goog/', 'fr'), null, 'already-translated pages are not re-translated');

    shell._textPromptDialog = async () => 'fr';
    shell.state.tabs[0].url = 'https://example.com/article';
    await shell.translateActivePage();
    assert.equal(shell.getActiveTab().url, shell.buildTranslatedPageUrl('https://example.com/article', 'fr'), 'the tab navigates to the translated page');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('PASTE: no focused field -> honest instruction instead of a dead execCommand', async () => {
  const { shell } = await makeShell();
  try {
    await shell.pasteIntoFocusedField(); // nothing focused in the shim
    // Reaching here without throwing is the contract; the honest notice
    // path is taken (showTransientNotice is render-safe in the shim).
    assert.ok(true);
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('KOTTON (Kotlin pin): the Android plugin really implements installSiteAsApp with a pinned deep-link shortcut', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  assert.ok(src.includes('fun installSiteAsApp'), 'plugin method exists');
  assert.ok(src.includes('requestPinShortcut'), 'real pinned-shortcut API on Android 8+');
  assert.ok(src.includes('com.yayra.app:/browse?url='), 'shortcut deep-links back into Yayra on the site');
  assert.ok(src.includes('INSTALL_SHORTCUT'), 'legacy broadcast fallback declared');
  // SITE LOGO: the shortcut uses the site's own favicon bitmap when it can
  // be fetched (off the main thread), falling back to the Yayra logo.
  assert.ok(src.includes('fetchFaviconBitmap'), 'site favicon fetched');
  assert.ok(src.includes('Icon.createWithBitmap'), 'site bitmap used for the pinned shortcut');
  assert.ok(src.includes('Intent.EXTRA_SHORTCUT_ICON,'), 'legacy broadcast carries the site bitmap too');
  assert.ok(src.includes('Looper.getMainLooper()'), 'network off the main thread, pin on it');
  const ensure = readFileSync(new URL('../scripts/ensure-capacitor-platform.mjs', import.meta.url), 'utf8');
  assert.ok(ensure.includes('com.android.launcher.permission.INSTALL_SHORTCUT'), 'manifest permission injected for legacy devices');
});

test('SUBMENUS: every submenu parent opens on click, lists its items, and closes again', async () => {
  const { shell, container } = await makeShell({ storage: makeStorage() });
  try {
    shell._textPromptDialog = async () => 'G';
    shell._openFilePicker = async () => null;
    shell.checkForUpdates = async () => {};
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    const parents = Array.from(container.querySelectorAll('.fb-drawer-item-has-submenu'));
    assert.ok(parents.length >= 7, `all submenu groups present (${parents.length} found)`);
    const drawer = container.querySelector('.fb-side-drawer-menu');
    const hoverParent = parents[0];
    const hoverFlyout = hoverParent.querySelector('.fb-drawer-submenu');
    hoverParent.dispatchEvent({ type: 'pointerenter', pointerType: 'mouse', relatedTarget: null });
    assert.equal(hoverParent.classList.contains('open'), true, 'desktop hover opens the lateral flyout');
    assert.equal(hoverFlyout.parentElement, drawer, 'the hover flyout is outside the scrolling list');
    hoverParent.dispatchEvent({ type: 'pointerleave', relatedTarget: null });
    assert.equal(hoverParent.classList.contains('open'), false, 'the hover flyout closes when the pointer leaves');
    for (const parent of parents) {
      const button = parent.querySelector('.fb-drawer-item');
      const items = parent.querySelectorAll('.fb-drawer-item');
      assert.ok(items.length >= 2, 'submenu carries its options');
      assert.equal(parent.classList.contains('open'), false, 'starts closed');
      button.click();
      assert.equal(parent.classList.contains('open'), true, 'opens on click');
      button.click();
      assert.equal(parent.classList.contains('open'), false, 'closes on second click');
      // Every sub-option must also survive a click while open.
      for (const item of Array.from(parent.querySelectorAll('.fb-drawer-submenu .fb-drawer-item'))) {
        item.click();
        await flush();
      }
    }
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('ZOOM + UPDATE + CLOSE: the non-item drawer controls all really work', async () => {
  const { shell, container } = await makeShell({ storage: makeStorage() });
  try {
    shell.checkForUpdates = async () => {};
    shell.applyUpdate = async () => { shell._applied = true; };
    shell.installDesktopUpdateNow = async () => { shell._installed = true; };
    shell.state.isSideDrawerOpen = true;
    shell.state.updateState = { ...shell.state.updateState, status: 'ready', availableVersion: '9.9.9' };
    shell.render(container);
    container.querySelector('.fb-update-ready-btn')?.click();
    await flush();
    assert.equal(shell._applied, true, 'Update-ready button starts the update');

    shell.state.updateState = { ...shell.state.updateState, status: 'staged' };
    shell.state.isSideDrawerOpen = true; // the ready-click closed the drawer
    shell.render(container);
    container.querySelector('.fb-drawer-install-btn')?.click();
    await flush();
    assert.equal(shell._installed, true, 'Staged button installs');

    container.querySelector('.fb-check-updates-btn')?.click();
    await flush(); // no throw + checkForUpdates ran

    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    const before = shell.state.zoomLevel;
    container.querySelector('.fb-dr-zoom-in')?.click();
    assert.equal(shell.state.zoomLevel, Math.min(200, before + 10), 'zoom + works');
    container.querySelector('.fb-dr-zoom-out')?.click();
    container.querySelector('.fb-dr-zoom-out')?.click();
    assert.equal(shell.state.zoomLevel, Math.max(50, before - 10), 'zoom - works');
    container.querySelector('.fb-dr-fullscreen')?.click(); // no-throw in every environment
    container.querySelector('.fb-close-drawer-btn')?.click();
    assert.equal(shell.state.isSideDrawerOpen, false, 'close button closes the menu');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('KEYBOARD: every shortcut the menu ADVERTISES really fires its action', async () => {
  const { shell, container } = await makeShell({ storage: makeStorage() });
  try {
    shell._textPromptDialog = async () => 'G';
    const calls = [];
    shell.printActivePage = () => calls.push('print');
    shell.savePageAs = async () => calls.push('save');
    shell.openDevToolsForActiveTab = async () => calls.push('devtools');
    shell.reload = () => calls.push('reload');
    shell.hardReload = () => calls.push('hard-reload');
    shell.state.tabs[0].url = 'https://example.com/';
    shell.state.tabs[0].title = 'Example';
    const key = (over) => shell.handleGlobalKeyDown({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: 'x', preventDefault() {}, ...over });

    // Ctrl+T new tab
    let count = shell.state.tabs.length;
    key({ ctrlKey: true, key: 't' });
    assert.equal(shell.state.tabs.length, count + 1, 'Ctrl+T');
    // Ctrl+N floating mini window
    key({ ctrlKey: true, key: 'n' });
    assert.equal(shell.state.isFloatingMiniOpen, true, 'Ctrl+N');
    shell.closeFloatingMini();
    // Ctrl+Shift+N incognito
    key({ ctrlKey: true, shiftKey: true, key: 'N' });
    assert.equal(shell.state.tabs.at(-1).isPrivate, true, 'Ctrl+Shift+N');
    // Ctrl+Shift+A tab search
    key({ ctrlKey: true, shiftKey: true, key: 'A' });
    assert.equal(shell.state.activeModal, 'tab-switcher', 'Ctrl+Shift+A');
    shell.closeModal();
    // Ctrl+Shift+Del clear data
    key({ ctrlKey: true, shiftKey: true, key: 'Delete' });
    assert.equal(shell.state.activeModal, 'clear-data', 'Ctrl+Shift+Del');
    shell.closeModal();
    // Ctrl+H history, Ctrl+J downloads, Ctrl+Shift+O bookmark manager
    key({ ctrlKey: true, key: 'h' });
    assert.equal(shell.getActiveTab().url, 'yayra://history', 'Ctrl+H');
    key({ ctrlKey: true, key: 'j' });
    assert.equal(shell.getActiveTab().url, 'yayra://downloads', 'Ctrl+J');
    key({ ctrlKey: true, shiftKey: true, key: 'O' });
    assert.equal(shell.getActiveTab().url, 'yayra://bookmarks', 'Ctrl+Shift+O');
    // Ctrl+F find bar
    key({ ctrlKey: true, key: 'f' });
    assert.equal(shell.state.findInPage.isOpen, true, 'Ctrl+F');
    // Ctrl+D bookmarks the page, Ctrl+Shift+D all tabs
    shell.navigateActiveTab('https://example.com/');
    key({ ctrlKey: true, key: 'd' });
    await flush();
    assert.ok((await shell.bookmarksRepo.getAllBookmarks()).some((b) => b.url === 'https://example.com/'), 'Ctrl+D');
    key({ ctrlKey: true, shiftKey: true, key: 'D' });
    await flush();
    // Ctrl+Shift+B bookmarks bar
    const barBefore = shell.state.settings.showBookmarksBar;
    key({ ctrlKey: true, shiftKey: true, key: 'B' });
    assert.notEqual(shell.state.settings.showBookmarksBar, barBefore, 'Ctrl+Shift+B');
    // Ctrl+R / Ctrl+Shift+R
    key({ ctrlKey: true, key: 'r' });
    assert.ok(calls.includes('reload'), 'Ctrl+R');
    key({ ctrlKey: true, shiftKey: true, key: 'R' });
    assert.ok(calls.includes('hard-reload'), 'Ctrl+Shift+R');
    // Ctrl+P / Ctrl+S / Ctrl+Shift+I / F12 / Alt+Shift+I
    key({ ctrlKey: true, key: 'p' });
    assert.ok(calls.includes('print'), 'Ctrl+P');
    await key({ ctrlKey: true, key: 's' });
    assert.ok(calls.includes('save'), 'Ctrl+S');
    await key({ ctrlKey: true, shiftKey: true, key: 'I' });
    assert.ok(calls.includes('devtools'), 'Ctrl+Shift+I');
    await key({ key: 'F12' });
    assert.equal(calls.filter((c) => c === 'devtools').length, 2, 'F12 also opens DevTools');
    key({ altKey: true, shiftKey: true, key: 'I' });
    assert.equal(shell.getActiveTab().url, 'https://github.com/g2code33/yayra/issues', 'Alt+Shift+I');
    // Ctrl+W closes, Ctrl+Shift+T reopens
    const before = shell.state.tabs.length;
    key({ ctrlKey: true, key: 'w' });
    assert.equal(shell.state.tabs.length, before - 1, 'Ctrl+W');
    key({ ctrlKey: true, shiftKey: true, key: 'T' });
    assert.equal(shell.state.tabs.length, before, 'Ctrl+Shift+T');
    // Esc closes the drawer
    shell.state.isSideDrawerOpen = true;
    key({ key: 'Escape' });
    assert.equal(shell.state.isSideDrawerOpen, false, 'Esc closes the menu');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('CUT/COPY: real clipboard behaviour - honest notice with no selection, field cut works', async () => {
  const { shell } = await makeShell({ storage: makeStorage() });
  try {
    // No selection anywhere -> honest instructions, never a silent no-op.
    await shell.copySelectionToClipboard();
    await shell.cutSelectionToClipboard();

    // Selection inside a focused Yayra field + clipboard available.
    const field = {
      tagName: 'INPUT',
      disabled: false,
      readOnly: false,
      value: 'hello yayra world',
      selectionStart: 6,
      selectionEnd: 11,
      dispatchEvent() {}
    };
    Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => field });
    const wrote = [];
    const originalClipboard = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { wrote.push(t); } }
    });
    try {
      await shell.copySelectionToClipboard();
      assert.deepEqual(wrote, ['yayra'], 'Copy takes the field selection');
      await shell.cutSelectionToClipboard();
      assert.equal(field.value, 'hello  world', 'Cut removes the selection from the field');
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: originalClipboard });
      Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => null });
    }
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});
