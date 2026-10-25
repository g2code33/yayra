import { validateDictionaryEntry } from './dictionaryEngine.js';

// No downloadable pack is exposed until a primary source's exact data version,
// licence, attribution requirements and redistribution rights are verified.
export const DICTIONARY_PACK_CATALOG = Object.freeze([
  Object.freeze({
    id: 'english-general', title: 'General English', category: 'general', available: false,
    description: 'No verified general-English data pack is bundled yet. Import a source dataset only when you can provide its exact version and redistribution licence.'
  }),
  Object.freeze({
    id: 'medical-open', title: 'Medical', category: 'medical', available: false,
    description: 'No medical terminology dataset is bundled. Clinical and medical content requires a verified redistribution licence and is not medical advice.'
  }),
  Object.freeze({
    id: 'pharmacy-open', title: 'Pharmacy', category: 'pharmacy', available: false,
    description: 'No pharmacy dataset is bundled until a source with verified redistribution rights and attribution is selected.'
  }),
  Object.freeze({
    id: 'business-open', title: 'Business', category: 'business', available: false,
    description: 'No business terminology dataset is bundled until a source with verified redistribution rights and attribution is selected.'
  })
]);

export function bytesToBase64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

export async function verifyPackIntegrity(bytes, integrity, subtle = globalThis.crypto?.subtle) {
  const [algorithm, expected] = String(integrity || '').split('-', 2);
  if (!['sha256', 'sha512'].includes(algorithm) || !expected || !subtle?.digest) throw new Error('pack-integrity-verifier-unavailable');
  const digest = new Uint8Array(await subtle.digest(algorithm.toUpperCase().replace('SHA', 'SHA-'), bytes));
  if (bytesToBase64(digest) !== expected) throw new Error('pack-checksum-mismatch');
  return true;
}

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 100_000;

export class DictionaryPackManager {
  constructor({ store, subtle = globalThis.crypto?.subtle, onState = () => {} } = {}) {
    this.store = store;
    this.subtle = subtle;
    this.onState = onState;
  }

  getCatalog() { return DICTIONARY_PACK_CATALOG; }

  async getStatus() {
    const installed = await this.store.getPackCatalog();
    const active = await this.store.getActivePacks();
    const activeById = new Map(active.map((pack) => [pack.id, pack]));
    const catalogRows = DICTIONARY_PACK_CATALOG.map((pack) => ({
      ...pack,
      installed: false,
      enabled: false,
      entryCount: 0,
      operation: 'unavailable'
    }));
    const catalogIds = new Set(catalogRows.map((pack) => pack.id));
    const importedRows = installed.filter((pack) => !catalogIds.has(pack.id)).map((pack) => ({
      ...pack,
      available: false,
      imported: true,
      installed: true,
      enabled: activeById.has(pack.id),
      operation: 'idle'
    }));
    for (const row of catalogRows) {
      const pack = installed.find((candidate) => candidate.id === row.id);
      if (!pack) continue;
      Object.assign(row, pack);
      row.available = false;
      row.installed = true;
      row.enabled = activeById.has(row.id);
      row.entryCount = pack.entryCount || 0;
      row.installedAt = pack.installedAt;
      row.operation = 'idle';
    }
    return [...catalogRows, ...importedRows];
  }

  async importPack(source) {
    if (typeof source !== 'string' || source.length > MAX_IMPORT_BYTES) throw new Error('dictionary-import-file-too-large');
    let data;
    try { data = JSON.parse(source); } catch { throw new Error('dictionary-import-invalid-json'); }
    if (data?.format !== 'yayra-dictionary-pack' || data?.formatVersion !== 1 || !data.metadata || !Array.isArray(data.entries)) throw new Error('dictionary-import-unsupported-format');
    if (data.entries.length < 1 || data.entries.length > MAX_IMPORT_ENTRIES) throw new Error('dictionary-import-entry-count-invalid');
    const meta = data.metadata;
    const id = String(meta.id || '');
    const category = String(meta.category || '');
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/i.test(id) || !['general', 'medical', 'pharmacy', 'business'].includes(category)) throw new Error('dictionary-import-metadata-invalid');
    for (const key of ['title', 'version', 'datasetVersion', 'packVersion', 'source', 'license', 'attribution', 'buildDate', 'updatedAt']) {
      if (typeof meta[key] !== 'string' || !meta[key].trim() || meta[key].length > 2000) throw new Error(`dictionary-import-metadata-${key}-required`);
    }
    if (!validDate(meta.buildDate) || !validDate(meta.updatedAt)) throw new Error('dictionary-import-metadata-date-invalid');
    const entriesByTerm = new Map();
    for (const raw of data.entries) {
      const entry = validateDictionaryEntry(raw, { packId: id, category });
      if (!entry) continue;
      const existing = entriesByTerm.get(entry.normalizedTerm);
      if (!existing) entriesByTerm.set(entry.normalizedTerm, entry);
      else {
        for (const definition of entry.definitions) {
          if (existing.definitions.length >= 30) break;
          if (!existing.definitions.some((item) => item.text === definition.text && item.partOfSpeech === definition.partOfSpeech)) existing.definitions.push(definition);
        }
      }
    }
    const entries = [...entriesByTerm.values()];
    if (entries.length < 1) throw new Error('dictionary-import-no-valid-entries');
    const bytes = new TextEncoder().encode(source);
    const digest = this.subtle ? new Uint8Array(await this.subtle.digest('SHA-256', bytes)) : null;
    const checksum = digest ? `sha256-${bytesToBase64(digest)}` : 'not-available';
    const version = String(meta.version).trim().slice(0, 120);
    const installed = await this.store.getPack(id, version);
    if (installed) return { ok: true, duplicate: true, pack: installed };
    const packMeta = {
      id,
      title: meta.title.trim().slice(0, 180),
      category,
      version,
      packVersion: String(meta.packVersion || '1.0.0').slice(0, 80),
      source: meta.source.trim().slice(0, 2000),
      sourceUrl: safeHttps(meta.sourceUrl),
      license: meta.license.trim().slice(0, 2000),
      attribution: meta.attribution.trim().slice(0, 2000),
      datasetVersion: String(meta.datasetVersion || version).slice(0, 120),
      buildDate: validDate(meta.buildDate),
      updatedAt: validDate(meta.updatedAt),
      description: String(meta.description || '').slice(0, 1200),
      imported: true,
      checksum,
      enabled: true
    };
    await this.store.savePack(packMeta, entries);
    try { this.onState({ id, state: 'installed', progress: 1 }); } catch { /* UI observer */ }
    return { ok: true, pack: { ...packMeta, entryCount: entries.length } };
  }

  async setEnabled(id, enabled) { return this.store.setPackEnabled(id, enabled); }
  async remove(id) { return this.store.removePack(id); }
  async install() { throw new Error('no-verified-downloadable-dictionary-packs'); }
  pause() { return false; }
  cancel() { return false; }
}

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 2000) : '';
  } catch { return ''; }
}

function validDate(value) {
  const text = String(value || '').slice(0, 32);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}
