import { searchDictionary, normalizeDictionaryTerm, validateDictionaryEntry } from './dictionaryEngine.js';
import { createDictionaryStore } from './dictionaryStore.js';
import { DictionaryPackManager } from './dictionaryPackManager.js';

const HISTORY_LIMIT = 500;
const EXPORT_FORMAT = 'yayra-vocabulary-export';
const EXPORT_VERSION = 1;

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `vocab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class DictionaryLibrary {
  constructor({ profileId = 'default', store = createDictionaryStore(), manager = null, onPackState = () => {} } = {}) {
    this.profileId = String(profileId || 'default').slice(0, 180);
    this.store = store;
    this.manager = manager || new DictionaryPackManager({ store, onState: onPackState });
    this.history = [];
  }

  async search(query, options = {}) {
    const result = await searchDictionary(this.store, query, options);
    if (result.normalizedQuery && options.recordHistory !== false) await this.recordHistory(result.query, options.isPrivate === true);
    return result;
  }

  async recordHistory(query, isPrivate = false) {
    if (isPrivate) return;
    const term = String(query || '').trim().slice(0, 240);
    if (!term) return;
    const id = makeId();
    await this.store.saveVocabulary({
      id, ownerProfile: this.profileId, kind: 'history', term,
      normalizedTerm: normalizeDictionaryTerm(term), createdAt: Date.now(), updatedAt: Date.now(),
      tags: [], collectionId: '', source: 'local-search'
    });
    const history = (await this.store.getVocabulary(this.profileId)).filter((item) => item.kind === 'history')
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const item of history.slice(HISTORY_LIMIT)) await this.store.deleteVocabulary(this.profileId, item.id);
  }

  async saveEntry(entry, { note = '', tags = [], collectionId = '', starred = false, sourceText = '' } = {}) {
    const clean = validateDictionaryEntry(entry, { packId: entry?.packId, category: entry?.category });
    if (!clean) throw new Error('dictionary-entry-invalid');
    const existing = (await this.store.getVocabulary(this.profileId)).find((item) => item.kind === 'saved' && item.normalizedTerm === clean.normalizedTerm);
    const now = Date.now();
    const item = {
      ...(existing || {}), id: existing?.id || makeId(), ownerProfile: this.profileId, kind: 'saved',
      term: clean.term, normalizedTerm: clean.normalizedTerm, category: clean.category,
      packId: clean.packId, source: clean.source, sourceUrl: clean.sourceUrl,
      definitions: clean.definitions, pronunciation: clean.pronunciation,
      starred: existing?.starred === true || Boolean(starred), note: String(note || existing?.note || '').slice(0, 10_000),
      tags: normalizeTags(tags.length ? tags : existing?.tags || []),
      collectionId: String(collectionId || existing?.collectionId || '').slice(0, 180),
      sourceText: String(sourceText || existing?.sourceText || '').slice(0, 3000),
      createdAt: existing?.createdAt || now, updatedAt: now
    };
    await this.store.saveVocabulary(item);
    return item;
  }

  async saveSelection(text, { sourceTitle = '', sourceUrl = '', isPrivate = false } = {}) {
    const term = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!term) throw new Error('selection-empty');
    const item = {
      id: makeId(), ownerProfile: this.profileId, kind: 'saved', term,
      normalizedTerm: normalizeDictionaryTerm(term), category: 'general', packId: '',
      source: 'User selection', sourceUrl: '', definitions: [], selectedText: term,
      sourceTitle: String(sourceTitle || '').slice(0, 500), sourcePage: sanitizePageUrl(sourceUrl),
      isPrivateSource: Boolean(isPrivate), starred: false, note: '', tags: [], collectionId: '',
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await this.store.saveVocabulary(item);
    return item;
  }

  async saveHighlight(entryOrText, { selectedText = '', note = '', tags = [], sourceTitle = '', sourceUrl = '' } = {}) {
    const text = String(selectedText || (typeof entryOrText === 'string' ? entryOrText : '') || entryOrText?.term || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 3000);
    if (!text) throw new Error('highlight-empty');
    const item = {
      id: makeId(), ownerProfile: this.profileId, kind: 'highlight',
      term: String(entryOrText?.term || text).slice(0, 240), normalizedTerm: normalizeDictionaryTerm(entryOrText?.term || text),
      selectedText: text, note: String(note || '').slice(0, 10_000), tags: normalizeTags(tags),
      sourceTitle: String(sourceTitle || '').slice(0, 500), sourcePage: sanitizePageUrl(sourceUrl),
      packId: String(entryOrText?.packId || '').slice(0, 120), category: entryOrText?.category || 'general',
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await this.store.saveVocabulary(item);
    return item;
  }

  async toggleStar(entry) {
    const saved = await this.saveEntry(entry);
    saved.starred = !saved.starred;
    saved.updatedAt = Date.now();
    await this.store.saveVocabulary(saved);
    return saved;
  }

  async updatePersonalItem(id, changes = {}) {
    const existing = (await this.store.getVocabulary(this.profileId)).find((item) => item.id === id);
    if (!existing) throw new Error('vocabulary-item-not-found');
    const updated = { ...existing, updatedAt: Date.now() };
    for (const key of ['note', 'collectionId', 'starred']) {
      if (Object.hasOwn(changes, key)) updated[key] = key === 'starred' ? Boolean(changes[key]) : String(changes[key] || '').slice(0, key === 'note' ? 10_000 : 180);
    }
    if (Object.hasOwn(changes, 'tags')) updated.tags = normalizeTags(changes.tags);
    await this.store.saveVocabulary(updated);
    return updated;
  }

  async deletePersonalItem(id) { return this.store.deleteVocabulary(this.profileId, id); }

  async getPersonalData({ includeHistory = true } = {}) {
    const items = await this.store.getVocabulary(this.profileId);
    return items.filter((item) => includeHistory || item.kind !== 'history')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getCollections() {
    const items = await this.getPersonalData({ includeHistory: false });
    const groups = new Map();
    for (const item of items) {
      const id = item.collectionId || '';
      if (!groups.has(id)) groups.set(id, { id, title: id || 'Unfiled', count: 0 });
      groups.get(id).count += 1;
    }
    return [...groups.values()];
  }

  async exportPersonalData({ includeHistory = true } = {}) {
    const items = (await this.getPersonalData({ includeHistory })).map((item) => {
      const exported = { ...item };
      delete exported.ownerProfile;
      return exported;
    });
    const pack = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), items };
    return JSON.stringify(pack, null, 2);
  }

  async importPersonalData(serialized, { merge = true } = {}) {
    if (typeof serialized !== 'string' || serialized.length > 25 * 1024 * 1024) throw new Error('vocabulary-import-file-too-large');
    let data;
    try { data = JSON.parse(serialized); } catch { throw new Error('vocabulary-import-invalid-json'); }
    if (data?.format !== EXPORT_FORMAT || data?.version !== EXPORT_VERSION || !Array.isArray(data.items) || data.items.length > 50_000) throw new Error('vocabulary-import-unsupported-format');
    const current = await this.getPersonalData();
    const byKey = new Map(current.map((item) => [`${item.kind}:${item.normalizedTerm}:${item.selectedText || ''}`, item]));
    let imported = 0;
    for (const raw of data.items) {
      if (!raw || !['saved', 'highlight', 'history'].includes(raw.kind)) continue;
      const term = String(raw.term || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!term) continue;
      const key = `${raw.kind}:${normalizeDictionaryTerm(term)}:${String(raw.selectedText || '').slice(0, 3000)}`;
      const previous = byKey.get(key);
      const safe = {
        ...raw, id: merge && previous ? previous.id : makeId(), ownerProfile: this.profileId,
        term, normalizedTerm: normalizeDictionaryTerm(term), note: String(raw.note || '').slice(0, 10_000),
        tags: normalizeTags(raw.tags), collectionId: String(raw.collectionId || '').slice(0, 180),
        sourceUrl: '', sourcePage: sanitizePageUrl(raw.sourcePage),
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), updatedAt: Date.now()
      };
      if (safe.kind === 'saved') {
        safe.definitions = Array.isArray(raw.definitions) ? raw.definitions.slice(0, 30).map((definition) => ({ text: String(definition.text || '').slice(0, 12_000), partOfSpeech: String(definition.partOfSpeech || '').slice(0, 60), examples: Array.isArray(definition.examples) ? definition.examples.slice(0, 20).map((example) => String(example).slice(0, 1200)) : [] })) : [];
        safe.starred = raw.starred === true;
      }
      await this.store.saveVocabulary(safe);
      imported += 1;
    }
    return { imported };
  }
}

function normalizeTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(',')).map((tag) => String(tag || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 50)).filter(Boolean))].slice(0, 30);
}

function sanitizePageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 2000) : '';
  } catch { return ''; }
}

export { normalizeTags };
