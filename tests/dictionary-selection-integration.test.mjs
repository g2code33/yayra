import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';
setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function makeShell() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const shell = new BrowserShell({ container });
  shell.showTransientNotice = () => {};
  return { shell, container };
}

test('selection dictionary action opens a local lookup in a new private-matched tab by default', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.tabs[0].isPrivate = true;
    let created = null;
    let navigated = '';
    shell.createNewTab = (isPrivate, options) => { created = { isPrivate, options }; };
    shell.navigateActiveTab = (url) => { navigated = url; };
    assert.equal(shell.openSelectionInDictionary('  Ghana medicines  '), true);
    assert.equal(created.isPrivate, true);
    assert.equal(navigated, 'yayra://dictionary?q=Ghana%20medicines');
  } finally { shell.destroy(); container.remove(); }
});

test('the in-Yayra desktop keyboard shortcut looks up the selected word without reading clipboard data', () => {
  const { shell, container } = makeShell();
  try {
    let lookedUp = '';
    let prevented = false;
    shell._currentSelectionText = () => 'selected medicine';
    shell.openSelectionInDictionary = (text) => { lookedUp = text; return true; };
    shell.handleGlobalKeyDown({
      key: 'd', ctrlKey: true, metaKey: false, altKey: true, shiftKey: true,
      preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.equal(lookedUp, 'selected medicine');
  } finally { shell.destroy(); container.remove(); }
});

test('configured current-tab lookup stays in the source tab', () => {
  const { shell, container } = makeShell();
  try {
    const source = shell.getActiveTab();
    shell.state.settings.dictionaryLookupDestination = 'current-tab';
    let selected = '';
    let navigated = '';
    shell.selectTab = (tabId) => { selected = tabId; };
    shell.navigateActiveTab = (url) => { navigated = url; };
    shell.render = () => {};
    assert.equal(shell.openSelectionInDictionary('word'), true);
    assert.equal(selected, source.id);
    assert.equal(navigated, 'yayra://dictionary?q=word');
  } finally { shell.destroy(); container.remove(); }
});

test('selection save strips source query strings and does not leave selected text in a tab URL', async () => {
  const { shell, container } = makeShell();
  try {
    shell.state.tabs[0].url = 'https://example.test/article?token=private#fragment';
    let navigated = '';
    shell.createNewTab = () => {};
    shell.navigateActiveTab = (url) => { navigated = url; };
    assert.equal(shell.openSelectionSave('Selected words'), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(navigated, 'yayra://vocabulary');
    assert.doesNotMatch(navigated, /Selected|token|fragment/);
    const saved = await shell.getDictionaryLibrary().getPersonalData();
    assert.equal(saved[0].term, 'Selected words');
    assert.equal(saved[0].sourcePage, 'https://example.test/article');
  } finally { shell.destroy(); container.remove(); }
});
