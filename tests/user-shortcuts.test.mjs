import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
}

async function makeShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test('menu shortcut pins the active website to New Tab and Settings > Shortcuts manages it', async () => {
  const previousBridge = window.yayra;
  const previousStorage = globalThis.localStorage;
  delete window.yayra;
  globalThis.localStorage = makeStorage();
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://docs.example.com/guide';
    shell.state.tabs[0].title = 'Example Docs';
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    const create = container.querySelector('.fb-dr-create-shortcut');
    assert.ok(create, 'the page menu offers Add to New Tab shortcuts');
    create.click();
    await flush();

    assert.deepEqual(shell.state.userShortcuts.map(({ title, url }) => ({ title, url })), [
      { title: 'Example Docs', url: 'https://docs.example.com/guide' }
    ], 'the active page is stored as a profile shortcut');
    assert.equal(shell.getActiveTab().url, 'https://docs.example.com/guide', 'creating a shortcut does not navigate away');

    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    container.querySelector('.fb-dr-create-shortcut').click();
    await flush();
    assert.equal(shell.state.userShortcuts.length, 1, 'repeating the menu action does not create a duplicate');

    shell.state.tabs[0].url = 'yayra://newtab';
    shell.state.tabs[0].title = 'New Tab';
    shell.render(container);
    assert.equal(container.querySelectorAll('.fb-user-shortcut').length, 1, 'the saved site appears as a New Tab tile');

    shell.state.tabs[0].url = 'yayra://settings';
    shell.state.tabs[0].title = 'Settings';
    shell.state.settingsActiveCategory = 'shortcuts';
    shell.state.activeSettingsCategory = 'shortcuts';
    shell.render(container);
    const nav = [...container.querySelectorAll('.fb-settings-nav-item')]
      .find((button) => button.dataset?.cat === 'shortcuts');
    assert.ok(nav, 'Settings has a Shortcuts destination');
    const list = container.querySelector('#fb-in-shortcuts-list');
    assert.ok(list.textContent.includes('Example Docs'), 'the Settings page lists saved website shortcuts');
    assert.ok(list.textContent.includes('https://docs.example.com/guide'), 'the saved destination is visible');

    list.querySelector('.fb-shortcut-settings-edit').click();
    assert.equal(container.querySelector('#fb-shortcut-name').getAttribute('value'), 'Example Docs', 'edit modal is prefilled from the saved shortcut');
    const nameInput = container.querySelector('#fb-shortcut-name');
    const urlInput = container.querySelector('#fb-shortcut-url');
    nameInput.value = 'Example Workspace';
    urlInput.value = 'https://docs.example.com/workspace';
    container.querySelector('.fb-shortcut-save').click();
    await flush();
    assert.equal(shell.state.userShortcuts[0].title, 'Example Workspace', 'settings can rename a shortcut');
    assert.equal(shell.state.userShortcuts[0].url, 'https://docs.example.com/workspace', 'settings can update its URL');

    container.querySelector('#fb-in-shortcuts-list').querySelector('.fb-shortcut-settings-remove').click();
    await flush();
    assert.equal(shell.state.userShortcuts.length, 0, 'settings can remove a shortcut');
    assert.match(container.querySelector('#fb-in-shortcuts-list').textContent, /No website shortcuts yet/);

    container.querySelector('.fb-in-add-website-shortcut').click();
    container.querySelector('#fb-shortcut-name').value = 'Project portal';
    container.querySelector('#fb-shortcut-url').value = 'https://portal.example.com';
    container.querySelector('.fb-shortcut-save').click();
    await flush();
    assert.equal(shell.state.userShortcuts[0].title, 'Project portal', 'the Settings shortcut tab can add a website');
  } finally {
    shell.destroy();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousBridge === undefined) delete window.yayra;
    else window.yayra = previousBridge;
  }
});

test('desktop shortcut remains a separate OS action when the desktop bridge is available', async () => {
  const previousBridge = window.yayra;
  const previousStorage = globalThis.localStorage;
  const created = [];
  globalThis.localStorage = makeStorage();
  window.yayra = {
    system: {
      createShortcut: async (details) => {
        created.push(details);
        return { ok: true, path: '/home/test/Desktop/Example Docs.desktop' };
      }
    }
  };
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://docs.example.com/guide';
    shell.state.tabs[0].title = 'Example Docs';
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    assert.ok(container.querySelector('.fb-dr-create-desktop-shortcut'), 'desktop installs retain an explicit desktop shortcut action');
    container.querySelector('.fb-dr-create-desktop-shortcut').click();
    await flush();
    assert.deepEqual(created, [{ url: 'https://docs.example.com/guide', title: 'Example Docs' }]);
    assert.equal(shell.state.userShortcuts.length, 0, 'desktop action is distinct from the New Tab shortcut collection');
  } finally {
    shell.destroy();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousBridge === undefined) delete window.yayra;
    else window.yayra = previousBridge;
  }
});
