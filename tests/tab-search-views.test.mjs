import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function makeShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  shell.state.tabs = [
    { id: 'tab-current', title: 'Google Search', url: 'https://www.google.com/search?q=ghana', isPrivate: false },
    { id: 'tab-docs', title: 'Example Docs', url: 'https://example.com/docs', isPrivate: false },
    { id: 'tab-chat', title: 'External login sync', url: 'https://chatgpt.com/', isPrivate: false }
  ];
  shell.state.activeTabId = 'tab-current';
  shell.state.closedTabsHistory = [
    { id: 'closed-example', title: 'Example Portal', url: 'https://example.com/portal', isPrivate: false },
    { id: 'closed-github', title: 'GitHub', url: 'https://github.com/', isPrivate: false }
  ];
  shell.render(container);
  return { shell, container };
}

test('tab search offers the existing card view and a persistent Chrome-style list view', () => {
  const { shell, container } = makeShell();
  try {
    let persistedView = null;
    shell.settingsRepo = {
      updateSettings: (settings) => { persistedView = settings.tabSwitcherView; }
    };
    shell.openModal('tab-switcher');
    assert.ok(container.querySelector('.fb-mobile-tabswitcher-card'), 'the existing preview-card view remains available');
    assert.equal(container.querySelectorAll('.fb-mobile-tab-card').length, 3);
    const gridListButton = [...container.querySelectorAll('.fb-tab-search-view-btn')]
      .find((button) => button.getAttribute('data-tab-search-view') === 'list');
    assert.ok(gridListButton, 'the current view offers a List choice');
    gridListButton.click();

    assert.equal(shell.state.settings.tabSwitcherView, 'list', 'view choice is stored in settings');
    assert.equal(persistedView, 'list', 'view choice is saved through the settings repository');
    assert.equal(shell.state.activeModal, 'tab-switcher', 'switching views keeps tab search open');
    const panel = container.querySelector('.fb-tab-search-list-panel');
    assert.ok(panel, 'the alternate view is a compact popover panel');
    assert.ok(panel.querySelector('.fb-tab-search-input'), 'list view includes tab search input');
    assert.equal(panel.querySelector('.fb-tab-search-open-list').querySelectorAll('.fb-tab-search-row').length, 3);
    assert.equal(panel.querySelector('.fb-tab-search-recent-toggle').textContent.includes('Recently Closed'), true);
    assert.equal(panel.querySelector('.fb-tab-search-closed-list').style.display, 'none', 'Recently Closed starts collapsed like the reference');

    const cardsButton = panel.querySelector('[data-tab-search-view="grid"]');
    cardsButton.click();
    assert.equal(shell.state.settings.tabSwitcherView, 'grid', 'users can switch back to the original card view');
    assert.equal(persistedView, 'grid');
    assert.ok(container.querySelector('.fb-mobile-tabswitcher-card'));
  } finally {
    shell.destroy();
  }
});

test('Chrome-style tab search filters both lists and reopens the selected recently closed tab', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.settings.tabSwitcherView = 'list';
    shell.openModal('tab-switcher');
    const panel = container.querySelector('.fb-tab-search-list-panel');
    const search = panel.querySelector('.fb-tab-search-input');

    search.value = 'example';
    search.dispatchEvent({ type: 'input', target: search });
    const openRows = panel.querySelector('.fb-tab-search-open-list').querySelectorAll('.fb-tab-search-row');
    assert.equal(openRows[0].style.display, 'none', 'nonmatching open tabs are hidden');
    assert.equal(openRows[1].style.display, '', 'matching open tabs remain visible');
    assert.equal(openRows[2].style.display, 'none', 'other open tabs are hidden');
    assert.equal(panel.querySelector('.fb-tab-search-closed-list').style.display, 'flex', 'matching closed tabs expand for search');

    const closedRows = panel.querySelector('.fb-tab-search-closed-list').querySelectorAll('.fb-tab-search-row');
    assert.equal(closedRows[0].style.display, '', 'matching recently closed tab is shown');
    assert.equal(closedRows[1].style.display, 'none', 'nonmatching recently closed tab is filtered');
    const recentToggle = panel.querySelector('.fb-tab-search-recent-toggle');
    recentToggle.click();
    assert.equal(panel.querySelector('.fb-tab-search-closed-list').style.display, 'none', 'users can collapse Recently Closed even while searching');
    recentToggle.click();
    assert.equal(panel.querySelector('.fb-tab-search-closed-list').style.display, 'flex');
    closedRows[0].querySelector('.fb-tab-search-row-main').click();

    assert.equal(shell.state.activeModal, null, 'opening a closed tab dismisses the search popover');
    assert.equal(shell.getActiveTab().url, 'https://example.com/portal', 'the selected closed tab is restored');
    assert.equal(shell.state.closedTabsHistory.length, 1, 'only the selected entry is removed from Recently Closed');
  } finally {
    shell.destroy();
  }
});

test('recently closed search skips private entries without reopening them', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.closedTabsHistory.unshift({
      id: 'closed-private', title: 'Private tab', url: 'https://private.example/', isPrivate: true
    });
    shell.state.settings.tabSwitcherView = 'list';
    shell.openModal('tab-switcher');
    const panel = container.querySelector('.fb-tab-search-list-panel');
    const search = panel.querySelector('.fb-tab-search-input');
    search.value = 'example';
    search.dispatchEvent({ type: 'input', target: search });
    panel.querySelector('.fb-tab-search-closed-list')?.querySelector('.fb-tab-search-row-main')?.click();

    assert.equal(shell.getActiveTab().url, 'https://example.com/portal', 'visible non-private closure is restored');
    assert.equal(shell.state.closedTabsHistory[0].id, 'closed-private', 'hidden private entry is not consumed');
  } finally {
    shell.destroy();
  }
});

test('reopenLastClosedTab uses the newest-first order shown by Recently Closed', () => {
  const { shell } = makeShell();
  try {
    const reopened = shell.reopenLastClosedTab();
    assert.equal(reopened.url, 'https://example.com/portal', 'the newest closure is restored first');
    assert.equal(shell.state.closedTabsHistory.length, 1);
    assert.equal(shell.state.closedTabsHistory[0].url, 'https://github.com/');
  } finally {
    shell.destroy();
  }
});

test('Chrome-style tab search can close an open tab from its row without closing the view', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.settings.tabSwitcherView = 'list';
    shell.openModal('tab-switcher');
    const panel = container.querySelector('.fb-tab-search-list-panel');
    panel.querySelector('[aria-label="Close Example Docs"]').click();
    assert.equal(shell.state.tabs.some((tab) => tab.id === 'tab-docs'), false, 'the row close button closes its tab');
    assert.equal(shell.state.activeModal, 'tab-switcher', 'the compact tab search stays open after closing a row');
    assert.ok(container.querySelector('.fb-tab-search-list-panel'), 'the view redraws with current tabs');
    assert.ok(shell.state.closedTabsHistory.some((tab) => tab.title === 'Example Docs'), 'closed website appears under Recently Closed');
  } finally {
    shell.destroy();
  }
});
