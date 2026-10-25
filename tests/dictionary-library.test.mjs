import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDictionaryTerm, searchDictionary, validateDictionaryEntry, compareDictionaryEntries } from '../packages/shared-ui/src/services/dictionaryEngine.js';
import { MemoryDictionaryStore } from '../packages/shared-ui/src/services/dictionaryStore.js';
import { DictionaryPackManager, verifyPackIntegrity, bytesToBase64, DICTIONARY_PACK_CATALOG } from '../packages/shared-ui/src/services/dictionaryPackManager.js';
import { DictionaryLibrary } from '../packages/shared-ui/src/services/dictionaryLibrary.js';

const META = {
  id: 'test-general', title: 'Licensed test pack', category: 'general', version: '1.0.0',
  datasetVersion: 'test dataset 1', packVersion: '1.0.0', source: 'Test corpus by Example Author',
  sourceUrl: 'https://example.test/corpus', license: 'CC BY 4.0', attribution: 'Example Author, CC BY 4.0',
  buildDate: '2026-10-25', updatedAt: '2026-10-25', description: 'Fixture only; not shipped as dictionary data.'
};
const entries = [
  { term: 'bank', category: 'general', source: META.title, definitions: [{ text: 'A financial institution.', partOfSpeech: 'noun', synonyms: ['depository'] }] },
  { term: 'banker', category: 'general', source: META.title, definitions: [{ text: 'A person who works at a bank.', partOfSpeech: 'noun' }] },
  { term: 'walk', category: 'general', source: META.title, definitions: [{ text: 'To move by foot.', partOfSpeech: 'verb' }] },
  { term: 'bank', category: 'general', source: META.title, definitions: [{ text: 'The land alongside a river.', partOfSpeech: 'noun' }] }
];

function createFixturePack() {
  return JSON.stringify({ format: 'yayra-dictionary-pack', formatVersion: 1, metadata: META, entries });
}

test('dictionary term normalization is Unicode-aware and bounded', () => {
  assert.equal(normalizeDictionaryTerm('  BANK—Account  '), 'bank account');
  assert.equal(normalizeDictionaryTerm('Cafe\u0301'), 'café');
  assert.ok(normalizeDictionaryTerm('x'.repeat(500)).length <= 240);
});

test('entry validation rejects empty definitions and sanitizes data fields', () => {
  assert.equal(validateDictionaryEntry({ term: '<img src=x>', definitions: [] }), null);
  const entry = validateDictionaryEntry({ term: 'bank', category: 'general', definitions: [{ text: '  A bank.\u0000 ', examples: ['x\u0001y'] }] });
  assert.equal(entry.definitions[0].text, 'A bank.');
  assert.equal(entry.definitions[0].examples[0], 'xy');
});

test('offline search supports prefix results, source/category filters, and comparison', async () => {
  const store = new MemoryDictionaryStore();
  await store.savePack({ ...META, enabled: true }, entries.map((entry) => validateDictionaryEntry(entry, { packId: META.id, category: META.category })));
  const result = await searchDictionary(store, 'bank');
  assert.equal(result.results[0].term, 'bank');
  assert.ok(result.results.some((entry) => entry.term === 'banker'));
  assert.equal(result.results[0].sourcePack.license, 'CC BY 4.0');
  assert.equal((await searchDictionary(store, 'bank', { categories: ['medical'] })).results.length, 0);
  assert.equal((await searchDictionary(store, 'walking')).results[0].term, 'walk', 'common inflections resolve to their local stem');
  assert.equal(compareDictionaryEntries(result.results.slice(0, 2)).length, 2);
});

test('pack import requires provenance and stores an integrity checksum', async () => {
  const store = new MemoryDictionaryStore();
  const manager = new DictionaryPackManager({ store });
  const result = await manager.importPack(createFixturePack());
  assert.equal(result.ok, true);
  assert.equal(result.pack.entryCount, 3, 'same-term entries are coalesced to avoid losing sense rows');
  const search = await searchDictionary(store, 'bank');
  assert.equal(search.results.find((entry) => entry.term === 'bank').definitions.length, 2);
  assert.match(result.pack.checksum, /^sha256-/);
  assert.equal((await store.getActivePacks())[0].id, META.id);
  const bad = JSON.parse(createFixturePack());
  delete bad.metadata.license;
  await assert.rejects(manager.importPack(JSON.stringify(bad)), /dictionary-import-metadata-license-required/);
  assert.equal(DICTIONARY_PACK_CATALOG.some((pack) => pack.available), false);
});

test('dictionary checksum verification uses declared SHA-256 / SHA-512 algorithms', async () => {
  const bytes = new TextEncoder().encode('test data');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const integrity = `sha256-${bytesToBase64(digest)}`;
  assert.equal(await verifyPackIntegrity(bytes, integrity), true);
  await assert.rejects(verifyPackIntegrity(bytes, 'sha256-AAAA'), /pack-checksum-mismatch/);
});

test('pack removal never deletes profile-owned saved words, stars, highlights, or notes', async () => {
  const store = new MemoryDictionaryStore();
  const library = new DictionaryLibrary({ profileId: 'profile-a', store });
  const manager = library.manager;
  const imported = await manager.importPack(createFixturePack());
  const search = await library.search('bank', { recordHistory: false });
  const saved = await library.saveEntry(search.results[0], { note: 'Personal note', tags: ['finance'], collectionId: 'Work', starred: true });
  const highlight = await library.saveHighlight(search.results[0], { selectedText: 'A financial institution.', note: 'Review later' });
  await manager.remove(imported.pack.id);
  const remaining = await library.getPersonalData();
  assert.ok(remaining.some((item) => item.id === saved.id && item.note === 'Personal note' && item.starred));
  assert.ok(remaining.some((item) => item.id === highlight.id && item.selectedText === 'A financial institution.'));
  assert.equal((await store.getActivePacks()).length, 0);
});

test('private lookups do not enter history; personal export/import is profile-scoped', async () => {
  const store = new MemoryDictionaryStore();
  const first = new DictionaryLibrary({ profileId: 'profile-a', store });
  const other = new DictionaryLibrary({ profileId: 'profile-b', store });
  await first.recordHistory('private term', true);
  assert.equal((await first.getPersonalData()).length, 0);
  const item = await first.saveSelection('A word selected by the user', { sourceTitle: 'A page', sourceUrl: 'https://example.test/path?secret=1' });
  assert.equal(item.sourcePage, 'https://example.test/path');
  const backup = await first.exportPersonalData();
  assert.doesNotMatch(backup, /profile-a/, 'exports do not reveal internal profile identifiers');
  assert.equal((await other.importPersonalData(backup)).imported, 1);
  assert.equal((await other.getPersonalData())[0].term, item.term);
  assert.equal((await first.getPersonalData()).length, 1);
});
