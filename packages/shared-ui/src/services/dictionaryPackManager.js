import { validateDictionaryEntry } from './dictionaryEngine.js';

// The General English pack is generated from the source archive listed in its
// manifest. WordNet's own 3.0 licence is embedded in the original data files
// and copied verbatim into every generated pack; the remaining catalog slots
// stay unavailable until equally clear, redistributable sources are verified.
export const DICTIONARY_PACK_CATALOG = Object.freeze([
  Object.freeze({
    id: 'wordnet-30', title: 'General English — Princeton WordNet 3.0', category: 'general', available: true,
    version: '3.0.0', datasetVersion: '3.0', packVersion: '1.0.0',
    source: 'Princeton University WordNet 3.0 database files, packaged by wordnet@2.0.0',
    sourceUrl: 'https://registry.npmjs.org/wordnet/-/wordnet-2.0.0.tgz',
    sourceIntegrity: 'sha512-VQOEUBHU6drwXGQx37bVaRqi042IZ8NwJiT9qLtM2x1QzqgIJIRoyZa++rWrUvICK+tYz9ttfYFk1c8IiN6DVQ==',
    downloadUrl: './dictionary-packs/wordnet-3.0-v1.yayrapack',
    integrity: 'sha512-VYO6M4h9frFzSXs7viXurFdv/jR2hksMOFjuWWM3NJaf7DNjOYzHUPg5iwRZFioEMEXYStpLJxEIdNgHu4YHeA==',
    downloadSize: 6_922_545,
    license: 'Princeton University WordNet Release 3.0 License; the complete licence text is included verbatim in the pack metadata.',
    licenseUrl: './dictionary-packs/WORDNET-LICENSE-3.0.txt',
    attribution: 'WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.',
    description: '147,806 English terms with WordNet senses and definitions. One-time download; after installation, lookups work offline.'
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
const MAX_IMPORT_ENTRIES = 200_000;
const MAX_COMPRESSED_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const PARTIAL_SAVE_INTERVAL = 1024 * 1024;

export class DictionaryPackManager {
  constructor({
    store,
    subtle = globalThis.crypto?.subtle,
    onState = () => {},
    fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
    DecompressionStreamImpl = globalThis.DecompressionStream
  } = {}) {
    this.store = store;
    this.subtle = subtle;
    this.onState = onState;
    this.fetchImpl = fetchImpl;
    this.DecompressionStreamImpl = DecompressionStreamImpl;
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
      operation: pack.available ? 'idle' : 'unavailable'
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
      const downloadable = row.available;
      Object.assign(row, pack);
      row.available = downloadable;
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
    if (meta.licenseText !== undefined && (typeof meta.licenseText !== 'string' || meta.licenseText.length > 5000)) throw new Error('dictionary-import-license-text-invalid');
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
      licenseText: typeof meta.licenseText === 'string' ? meta.licenseText.trim().slice(0, 5000) : '',
      attribution: meta.attribution.trim().slice(0, 2000),
      sourceIntegrity: typeof meta.sourceIntegrity === 'string' ? meta.sourceIntegrity.trim().slice(0, 200) : '',
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

  async install(id, { onProgress = () => {} } = {}) {
    const definition = DICTIONARY_PACK_CATALOG.find((pack) => pack.id === id && pack.available);
    if (!definition) throw new Error('no-verified-downloadable-dictionary-packs');
    if (this.store?.persistent === false) throw new Error('dictionary-persistent-storage-required');
    if (!this.fetchImpl) throw new Error('dictionary-download-unavailable');
    const installed = await this.store.getPack(definition.id, definition.version);
    if (installed) return { ok: true, duplicate: true, pack: installed };

    const base = globalThis.document?.baseURI || globalThis.location?.href || 'http://localhost/';
    const url = new URL(definition.downloadUrl, base).toString();
    let partial = await this.store.getPartial(definition.id);
    if (partial && (partial.url !== url || partial.integrity !== definition.integrity)) {
      await this.store.removePartial(definition.id);
      partial = null;
    }

    try {
      let bytes = partial?.complete === true ? asBytes(partial.bytes) : null;
      if (!bytes) bytes = await this.downloadVerifiedAsset(definition, url, partial, onProgress);
      reportProgress(this.onState, onProgress, { id, state: 'verifying', loaded: bytes.length, total: bytes.length, progress: 1 });
      await verifyPackIntegrity(bytes, definition.integrity, this.subtle);
      await this.store.savePartial(definition.id, { url, integrity: definition.integrity, bytes, complete: true, total: bytes.length });
      if (!this.DecompressionStreamImpl || typeof Blob === 'undefined' || typeof Response === 'undefined') {
        throw new Error('dictionary-gzip-not-supported');
      }
      reportProgress(this.onState, onProgress, { id, state: 'installing', loaded: bytes.length, total: bytes.length, progress: 1 });
      const decompressed = new Blob([bytes]).stream().pipeThrough(new this.DecompressionStreamImpl('gzip'));
      const source = await new Response(decompressed).text();
      const result = await this.importPack(source);
      await this.store.removePartial(definition.id);
      reportProgress(this.onState, onProgress, { id, state: 'installed', loaded: bytes.length, total: bytes.length, progress: 1 });
      return result;
    } catch (error) {
      reportProgress(this.onState, onProgress, { id, state: 'error', error: String(error?.message || error) });
      throw error;
    }
  }

  async downloadVerifiedAsset(definition, url, partial, onProgress) {
    let prefix = asBytes(partial?.bytes);
    let response = null;
    if (prefix.length) {
      response = await this.fetchImpl(url, { headers: { Range: `bytes=${prefix.length}-` }, cache: 'no-store', credentials: 'same-origin' });
      const range = response.headers?.get?.('content-range') || '';
      const rangeStart = /^bytes (\d+)-\d+\/\d+$/i.exec(range);
      if (response.status !== 206 || !rangeStart || Number(rangeStart[1]) !== prefix.length) {
        await this.store.removePartial(definition.id);
        prefix = new Uint8Array();
        if (response.status !== 200) response = await this.fetchImpl(url, { cache: 'no-store', credentials: 'same-origin' });
      }
    } else {
      response = await this.fetchImpl(url, { cache: 'no-store', credentials: 'same-origin' });
    }
    if (!response?.ok) throw new Error('dictionary-download-failed');
    const range = response.headers?.get?.('content-range') || '';
    const rangeMatch = /^bytes \d+-\d+\/(\d+)$/i.exec(range);
    const contentLength = Number(response.headers?.get?.('content-length')) || 0;
    const total = rangeMatch ? Number(rangeMatch[1]) : (prefix.length + contentLength || definition.downloadSize);
    if (total > MAX_COMPRESSED_DOWNLOAD_BYTES) throw new Error('dictionary-download-too-large');
    const chunks = prefix.length ? [prefix] : [];
    let loaded = prefix.length;
    let lastSaved = loaded;
    const savePartial = async (complete = false) => {
      const bytes = joinBytes(chunks, loaded);
      await this.store.savePartial(definition.id, { url, integrity: definition.integrity, bytes, complete, total });
      lastSaved = loaded;
    };
    const pushChunk = async (chunk) => {
      if (!chunk?.length) return;
      loaded += chunk.length;
      if (loaded > MAX_COMPRESSED_DOWNLOAD_BYTES) throw new Error('dictionary-download-too-large');
      chunks.push(chunk);
      reportProgress(this.onState, onProgress, { id: definition.id, state: 'downloading', loaded, total, progress: total ? Math.min(0.99, loaded / total) : 0 });
      if (loaded - lastSaved >= PARTIAL_SAVE_INTERVAL) await savePartial(false);
    };

    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await pushChunk(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    } else {
      await pushChunk(new Uint8Array(await response.arrayBuffer()));
    }
    if (!loaded || (total && loaded !== total)) throw new Error('dictionary-download-incomplete');
    if (lastSaved !== loaded) await savePartial(true);
    else await this.store.savePartial(definition.id, { url, integrity: definition.integrity, bytes: joinBytes(chunks, loaded), complete: true, total });
    return joinBytes(chunks, loaded);
  }

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}

function joinBytes(chunks, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function reportProgress(onState, onProgress, payload) {
  try { onState(payload); } catch { /* observers cannot interrupt installation */ }
  try { onProgress(payload); } catch { /* UI observers cannot interrupt installation */ }
}
