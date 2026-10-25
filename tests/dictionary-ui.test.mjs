import test from 'node:test';
import assert from 'node:assert/strict';
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
    assert.match(viewport.textContent, /literal text/);
    assert.equal(viewport.querySelector('img'), null);
    assert.equal(viewport.querySelector('script'), null);
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
