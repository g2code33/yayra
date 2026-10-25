import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
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
  assert.equal(DICTIONARY_PACK_CATALOG.find((pack) => pack.id === 'wordnet-30')?.available, true);
  assert.equal(DICTIONARY_PACK_CATALOG.find((pack) => pack.id === 'oewn-2025')?.available, true);
  assert.equal(DICTIONARY_PACK_CATALOG.filter((pack) => pack.available).length, 6, 'only verified, attributed English datasets are downloadable');
});

test('pack import preserves complete license notices longer than the legacy 5 KB limit', async () => {
  const store = new MemoryDictionaryStore();
  const manager = new DictionaryPackManager({ store });
  const fixture = JSON.parse(createFixturePack());
  fixture.metadata.licenseText = 'LICENSE'.repeat(1_000);
  const result = await manager.importPack(JSON.stringify(fixture));
  assert.equal(result.pack.licenseText.length, fixture.metadata.licenseText.length);
});

test('dictionary checksum verification uses declared SHA-256 / SHA-512 algorithms', async () => {
  const bytes = new TextEncoder().encode('test data');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const integrity = `sha256-${bytesToBase64(digest)}`;
  assert.equal(await verifyPackIntegrity(bytes, integrity), true);
  await assert.rejects(verifyPackIntegrity(bytes, 'sha256-AAAA'), /pack-checksum-mismatch/);
});

test('bundled WordNet 3.0 pack is checksum-pinned, correctly licensed, and contains searchable definitions', async () => {
  const descriptor = DICTIONARY_PACK_CATALOG.find((pack) => pack.id === 'wordnet-30');
  const bytes = new Uint8Array(await readFile(new URL('../public/dictionary-packs/wordnet-3.0-v1.yayrapack', import.meta.url)));
  assert.equal(bytes.length, descriptor.downloadSize);
  assert.equal(await verifyPackIntegrity(bytes, descriptor.integrity), true);
  const pack = JSON.parse(gunzipSync(bytes).toString('utf8'));
  assert.equal(pack.format, 'yayra-dictionary-pack');
  assert.equal(pack.metadata.datasetVersion, '3.0');
  assert.match(pack.metadata.licenseText, /WordNet 3\.0 Copyright 2006 by Princeton University/);
  assert.equal(pack.entries.length, 147806);
  assert.ok(pack.entries.find((entry) => entry.term === 'bank')?.definitions.some((definition) => /financial institution/.test(definition.text)));
});

test('Open English WordNet 2025 pack is pinned, attributed, and safely sized for installation', async () => {
  const descriptor = DICTIONARY_PACK_CATALOG.find((pack) => pack.id === 'oewn-2025');
  const bytes = new Uint8Array(await readFile(new URL('../public/dictionary-packs/oewn-2025-v1.yayrapack', import.meta.url)));
  assert.equal(bytes.length, descriptor.downloadSize);
  assert.ok(bytes.length < 20 * 1024 * 1024);
  assert.equal(await verifyPackIntegrity(bytes, descriptor.integrity), true);
  const source = gunzipSync(bytes);
  assert.ok(source.length < 50 * 1024 * 1024, 'decompressed pack remains under the app import limit');
  const pack = JSON.parse(source.toString('utf8'));
  assert.equal(pack.format, 'yayra-dictionary-pack');
  assert.equal(pack.metadata.id, 'oewn-2025');
  assert.equal(pack.metadata.datasetVersion, '2025');
  assert.equal(pack.metadata.sourceIntegrity, descriptor.sourceIntegrity);
  assert.ok(pack.metadata.licenseText.length > 5_000);
  assert.match(pack.metadata.licenseText, /Creative Commons Attribution 4\.0/);
  assert.match(pack.metadata.licenseText, /WordNet 3\.1 Copyright 2011 by Princeton University/);
  assert.match(pack.metadata.description, /107,519 synsets/);
  assert.match(pack.metadata.description, /excludes proper names/);
  assert.equal(pack.entries.length, 127311);
  assert.ok(pack.entries.find((entry) => entry.term === 'bank')?.definitions.some((definition) => /financial institution/i.test(definition.text)));
  const license = await readFile(new URL('../public/dictionary-packs/OPEN-ENGLISH-WORDNET-LICENSE-2025.md', import.meta.url), 'utf8');
  assert.match(license, /Open English WordNet WNDB distribution notice/);
  assert.match(license, /WordNet 3\.1 Copyright 2011 by Princeton University/);
});

test('GCIDE 0.54 and FIBO Q2 2026 packs pass integrity, redistribution, scope, and manager-import checks', async () => {
  const descriptors = [
    { id: 'gcide-054', file: 'gcide-0.54-v1.yayrapack', count: 114757, version: '0.54', category: 'general', term: 'pomegranate', definition: /fruit of the tree/i, license: /GNU GENERAL PUBLIC LICENSE/i },
    { id: 'gcide-medical-054', file: 'gcide-medical-0.54-v1.yayrapack', count: 5761, version: '0.54', category: 'medical', term: 'myocarditis', definition: /inflammation of the myocardium/i, license: /GNU GENERAL PUBLIC LICENSE/i },
    { id: 'gcide-pharmacy-054', file: 'gcide-pharmacy-0.54-v1.yayrapack', count: 61, version: '0.54', category: 'pharmacy', term: 'Aspirin', definition: /acetyl salicylic acid/i, license: /GNU GENERAL PUBLIC LICENSE/i },
    { id: 'fibo-business-2026q2', file: 'fibo-business-2026q2-v1.yayrapack', count: 2667, version: 'Q2 2026', category: 'business', term: 'credit agreement', definition: /contractual agreement/i, license: /MIT License/i }
  ];
  for (const expected of descriptors) {
    const descriptor = DICTIONARY_PACK_CATALOG.find((pack) => pack.id === expected.id);
    assert.ok(descriptor?.available, `${expected.id} is available in the pack manager`);
    assert.equal(descriptor.category, expected.category);
    const bytes = new Uint8Array(await readFile(new URL(`../public/dictionary-packs/${expected.file}`, import.meta.url)));
    assert.equal(bytes.length, descriptor.downloadSize, `${expected.id} catalog size matches asset`);
    assert.ok(bytes.length < 20 * 1024 * 1024, `${expected.id} stays within the download cap`);
    assert.equal(await verifyPackIntegrity(bytes, descriptor.integrity), true, `${expected.id} pack checksum`);
    const source = gunzipSync(bytes);
    assert.ok(source.length < 50 * 1024 * 1024, `${expected.id} stays within the import cap`);
    const pack = JSON.parse(source.toString('utf8'));
    assert.equal(pack.metadata.id, expected.id);
    assert.equal(pack.metadata.datasetVersion, expected.version);
    assert.equal(pack.metadata.category, expected.category);
    assert.equal(pack.metadata.sourceIntegrity, descriptor.sourceIntegrity);
    assert.equal(pack.entries.length, expected.count);
    assert.match(pack.metadata.licenseText, expected.license);
    assert.match(pack.metadata.attribution, /GCIDE|EDM Council/);
    assert.match(pack.entries.find((entry) => entry.term.toLowerCase() === expected.term.toLowerCase())?.definitions[0]?.text || '', expected.definition);
    assert.match(pack.metadata.description, /historical|not current|terminology/i, `${expected.id} accurately scopes the vocabulary`);
    const store = new MemoryDictionaryStore();
    const manager = new DictionaryPackManager({ store });
    const installed = await manager.importPack(pack.entries.length ? source.toString('utf8') : '');
    assert.equal(installed.ok, true, `${expected.id} imports through the real pack manager`);
    assert.equal(installed.pack.entryCount, expected.count);
    assert.equal(installed.pack.licenseText, pack.metadata.licenseText, 'complete source notices are preserved without truncation');
  }
});

test('resumable dictionary download requests only the missing byte range and persists completion', async () => {
  const bytes = new TextEncoder().encode('dictionary-data');
  const prefix = bytes.slice(0, 5);
  const remainder = bytes.slice(prefix.length);
  const store = new MemoryDictionaryStore();
  const url = 'https://app.example.test/dictionary-packs/pack.yayrapack';
  const integrity = 'sha512-pinned';
  await store.savePartial('resume-pack', { url, integrity, bytes: prefix, complete: false });
  const requests = [];
  const manager = new DictionaryPackManager({ store, fetchImpl: async (_url, options) => {
    requests.push(options);
    return new Response(remainder, { status: 206, headers: { 'content-range': `bytes ${prefix.length}-${bytes.length - 1}/${bytes.length}`, 'content-length': String(remainder.length) } });
  } });
  const result = await manager.downloadVerifiedAsset({ id: 'resume-pack', integrity, downloadSize: bytes.length }, url, { url, integrity, bytes: prefix }, () => {});
  assert.deepEqual(result, bytes);
  assert.equal(requests[0].headers.Range, `bytes=${prefix.length}-`);
  const partial = await store.getPartial('resume-pack');
  assert.equal(partial.complete, true);
  assert.deepEqual(partial.bytes, bytes);
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
