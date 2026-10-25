import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim, MockElement } from './dom-shim.mjs';
setupDomShim();
if (!document.createTextNode) document.createTextNode = (text) => { const node = new MockElement('#text'); node.textContent = String(text); return node; };

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { MemoryDictionaryStore } from '../packages/shared-ui/src/services/dictionaryStore.js';
import { DictionaryLibrary } from '../packages/shared-ui/src/services/dictionaryLibrary.js';
import { validateDictionaryEntry } from '../packages/shared-ui/src/services/dictionaryEngine.js';

function makeShell() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const shell = new BrowserShell({ container });
  shell.showTransientNotice = () => {};
  return { shell, container };
}

test('dictionary page renders local results and untrusted definitions as text, never markup', async () => {
  const { shell, container } = makeShell();
  const viewport = document.createElement('div');
  const store = new MemoryDictionaryStore();
  const sourcePack = {
    id: 'safe-fixture', title: 'User supplied fixture', category: 'general', version: '1.0',
    datasetVersion: '1.0', source: 'Fixture', license: 'CC BY 4.0', attribution: 'Fixture author',
    sourceUrl: 'https://example.test/source', enabled: true
  };
  await store.savePack(sourcePack, [validateDictionaryEntry({
    term: 'safe', packId: sourcePack.id, category: 'general', source: sourcePack.source,
    definitions: [{ text: '<img src=x onerror=alert(1)> literal text' }]
  }, { packId: sourcePack.id, category: 'general' })]);
  shell.dictionaryLibrary = new DictionaryLibrary({ profileId: 'default', store });
  try {
    shell.renderInternalDictionaryPage(viewport, { id: 'tab-1', url: 'yayra://dictionary?q=safe', isPrivate: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(viewport.textContent, /Offline Dictionary/);
    assert.ok(viewport.querySelector('.fb-dict-logo'), 'the dictionary page has its coloured brand mark');
    assert.equal(viewport.querySelectorAll('[data-dict-view]').length, 3, 'one compact set of page tabs replaces duplicate nav rows');
    assert.match(viewport.textContent, /literal text/);
    assert.equal(viewport.querySelector('img'), null);
    assert.equal(viewport.querySelector('script'), null);
  } finally { shell.destroy(); container.remove(); }
});

test('Dictionary is a working side-drawer destination and pack source links have independent spacing', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    const dictionaryButton = container.querySelector('.fb-dr-dictionary');
    assert.ok(dictionaryButton, 'the side drawer includes the Dictionary entry');
    dictionaryButton.click();
    assert.equal(shell.getActiveTab().url, 'yayra://dictionary', 'the menu opens the offline dictionary page');
    const source = requireBrowserShellSource();
    assert.match(source, /\.fb-dict-link\{display:block[^}]*margin-top:7px/,
      'license and verification links stack with visible spacing in pack cards');
  } finally { shell.destroy(); container.remove(); }
});

function requireBrowserShellSource() {
  return readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
}

test('Dictionary entry point and selection shortcut are visible in Settings', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.settingsActiveCategory = 'dictionary';
    const viewport = document.createElement('div');
    shell.renderInternalSettingsPage(viewport);
    assert.ok(viewport.querySelector('#sec-dictionary'));
    assert.ok(viewport.querySelector('.fb-in-open-dictionary'));
    assert.match(viewport.textContent, /Ctrl\/Command \+ Alt \+ Shift \+ D/);
    assert.ok(viewport.querySelector('[data-cat="dictionary"]'));
  } finally { shell.destroy(); container.remove(); }
});

test('dictionary pages route imported packs and personal vocabulary in both internal schemes', () => {
  const { shell, container } = makeShell();
  try {
    const viewport = document.createElement('div');
    shell.renderInternalDictionaryPage(viewport, { id: 'tab-packs', url: 'yayra://dictionary?view=packs' });
    assert.match(viewport.textContent, /Manage dictionary packs/);
    const secondViewport = document.createElement('div');
    shell.renderInternalDictionaryPage(secondViewport, { id: 'tab-vocab', url: 'yayra://vocabulary' });
    assert.match(secondViewport.textContent, /My vocabulary/);
  } finally { shell.destroy(); container.remove(); }
});


test('dictionary result cards keep only a concise source label and visibly activate Save and Star', async () => {
  const { shell, container } = makeShell();
  const viewport = document.createElement('div');
  const store = new MemoryDictionaryStore();
  const sourcePack = {
    id: 'compact-fixture', title: 'Local word list', category: 'general', version: '1.0',
    datasetVersion: '1.0', source: 'Fixture', license: 'CC BY 4.0', attribution: 'Fixture author',
    sourceUrl: 'https://example.test/source', enabled: true
  };
  await store.savePack(sourcePack, [validateDictionaryEntry({
    term: 'compact', packId: sourcePack.id, category: sourcePack.category, source: sourcePack.source,
    definitions: [{ text: 'A concise test definition.' }]
  }, { packId: sourcePack.id, category: sourcePack.category })]);
  shell.dictionaryLibrary = new DictionaryLibrary({ profileId: 'default', store });
  try {
    shell.renderInternalDictionaryPage(viewport, { id: 'tab-compact', url: 'yayra://dictionary?q=compact', isPrivate: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const card = viewport.querySelector('.fb-dict-card');
    assert.ok(card);
    assert.match(card.textContent, /Local word list/);
    assert.match(card.textContent, /A concise test definition/);
    assert.doesNotMatch(card.textContent, /CC BY 4\.0|Attribution:|integrity|checksum/i);
    assert.equal(card.querySelector('.fb-dict-link'), null, 'the verbose source link is not repeated on result cards');
    assert.equal(card.querySelectorAll('button').length, 2, 'result controls are Save and Star; highlighting appears only for a selection');
    const [saveButton, starButton] = card.querySelectorAll('button');
    saveButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    starButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saveButton.textContent, 'Saved ✓');
    assert.equal(saveButton.getAttribute('aria-pressed'), 'true');
    assert.equal(starButton.textContent, 'Starred ★');
    assert.equal(starButton.getAttribute('aria-pressed'), 'true');
    assert.ok(saveButton.classList.contains('is-active'));
    assert.ok(starButton.classList.contains('is-active'));
    const [saved] = (await shell.getDictionaryLibrary().getPersonalData()).filter((item) => item.kind === 'saved');
    assert.equal(saved.term, 'compact');
    assert.equal(saved.starred, true);
    const reloadedViewport = document.createElement('div');
    shell.renderInternalDictionaryPage(reloadedViewport, { id: 'tab-compact-reload', url: 'yayra://dictionary?q=compact', isPrivate: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reloadedCard = reloadedViewport.querySelector('.fb-dict-card');
    assert.ok(reloadedCard, 'the reopened search renders its result card');
    const [reloadedSave, reloadedStar] = reloadedCard.querySelectorAll('button');
    assert.equal(reloadedSave.textContent, 'Saved ✓', 'saved state remains active after reopening the result');
    assert.equal(reloadedStar.textContent, 'Starred ★', 'star state remains active after reopening the result');
  } finally { shell.destroy(); container.remove(); }
});

test('comparison selection supports different dictionaries and different words, and clears correctly', () => {
  const { shell, container } = makeShell();
  const wrapper = document.createElement('div');
  const output = document.createElement('div');
  const compareButton = document.createElement('button'); compareButton.className = 'fb-dict-compare-button'; compareButton.disabled = true; wrapper.appendChild(compareButton); wrapper.appendChild(output);
  const status = document.createElement('p');
  const makeEntry = (term, packId, title) => ({ term, packId, source: title, sourcePack: { version: '1.0', title }, definitions: [{ text: `${term} from ${title}` }] });
  const first = makeEntry('bank', 'one', 'WordNet');
  const sameWordOtherDictionary = makeEntry('bank', 'two', 'Other dictionary');
  const differentWord = makeEntry('money', 'one', 'WordNet');
  try {
    const firstBox = document.createElement('input'); firstBox.checked = true;
    shell.updateDictionaryCompareSelection(first, firstBox, status, output);
    const secondBox = document.createElement('input'); secondBox.checked = true;
    shell.updateDictionaryCompareSelection(sameWordOtherDictionary, secondBox, status, output);
    assert.equal(shell._dictionaryCompareSelection.length, 2);
    assert.equal(compareButton.disabled, false);
    assert.equal(status.textContent, '2 of 2 comparison entries selected.');
    firstBox.checked = false;
    shell.updateDictionaryCompareSelection(first, firstBox, status, output);
    assert.equal(shell._dictionaryCompareSelection.length, 1, 'unchecking removes rather than re-adding the selected definition');
    assert.equal(compareButton.disabled, true);
    secondBox.checked = false;
    shell.updateDictionaryCompareSelection(sameWordOtherDictionary, secondBox, status, output);
    const bankBox = document.createElement('input'); bankBox.checked = true;
    const moneyBox = document.createElement('input'); moneyBox.checked = true;
    shell.updateDictionaryCompareSelection(first, bankBox, status, output);
    shell.updateDictionaryCompareSelection(differentWord, moneyBox, status, output);
    assert.deepEqual(shell._dictionaryCompareSelection.map((item) => item.term), ['bank', 'money']);
  } finally { shell.destroy(); container.remove(); }
});

test('Google OAuth test-user errors explain the required consent-screen fix', () => {
  const { shell, container } = makeShell();
  try {
    const message = shell.formatGoogleSignInError('oauth_error:access_denied');
    assert.match(message, /Google Auth Platform → Audience → Test users/);
    assert.match(message, /cannot be bypassed in Yayra/);
  } finally { shell.destroy(); container.remove(); }
});
