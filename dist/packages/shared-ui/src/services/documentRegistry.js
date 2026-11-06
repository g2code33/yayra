/*
 * Yayra local-document capability registry.
 *
 * This follows the proven contract used by pharmaTRACK_PERFECT_new:
 *   - render the original bytes (never replace an upload with a conversion),
 *   - sniff bytes before trusting a filename,
 *   - keep text extraction/search off the critical opening path, and
 *   - show an explicit Download/Open Original fallback for formats that a
 *     browser engine cannot honestly render.
 */

const caps = (value) => Object.freeze(value);

export const DOCUMENT_ENGINES = Object.freeze({
  pdf: Object.freeze({
    viewer: 'pdf',
    label: 'PDF document',
    shortLabel: 'PDF',
    extensions: Object.freeze(['pdf']),
    mimeTypes: Object.freeze(['application/pdf']),
    engine: 'PDF.js (bundled)',
    limitations: 'Scanned pages without a text layer remain images and are not searchable.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: true,
      rotate: true, nightMode: true, outline: true, thumbnails: true,
      presentation: true, notes: false, sheets: false, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  pptx: Object.freeze({
    viewer: 'pptx',
    label: 'PowerPoint presentation',
    shortLabel: 'PowerPoint',
    extensions: Object.freeze(['pptx', 'pptm']),
    mimeTypes: Object.freeze([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint.presentation.macroenabled.12'
    ]),
    engine: 'Native PPTX renderer (bundled)',
    limitations: 'Animations, transitions, macros and OLE objects are not executed. Embedded videos play when the browser supports their codec; linked-only clips stay offline and show their poster. Charts and SmartArt use static or explanatory frames.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: true,
      rotate: false, nightMode: false, outline: false, thumbnails: true,
      presentation: true, notes: true, sheets: false, animate: false, embeddedVideo: true,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  ppt: Object.freeze({
    viewer: 'ppt',
    label: 'PowerPoint 97–2003 presentation',
    shortLabel: 'PowerPoint',
    extensions: Object.freeze(['ppt']),
    mimeTypes: Object.freeze(['application/vnd.ms-powerpoint']),
    engine: 'ppt-codec + native PowerPoint renderer (bundled, local)',
    limitations: 'Yayra creates a temporary macro-free viewing copy in memory; the original stays unchanged. Legacy animations, transitions, VBA, linked media and unsupported OLE objects are not executed, and uncommon drawing effects may be simplified.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: true,
      rotate: false, nightMode: false, outline: false, thumbnails: true,
      presentation: true, notes: true, sheets: false, animate: false, embeddedVideo: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  docx: Object.freeze({
    viewer: 'docx',
    label: 'Word document',
    shortLabel: 'Word',
    extensions: Object.freeze(['docx']),
    mimeTypes: Object.freeze(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    engine: 'docx-preview (bundled)',
    limitations: 'Tracked-change balloons, macros and embedded OLE objects are not drawn.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: false,
      rotate: false, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: false, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  doc: Object.freeze({
    viewer: 'doc',
    label: 'Word 97–2003 document',
    shortLabel: 'Word',
    extensions: Object.freeze(['doc']),
    mimeTypes: Object.freeze(['application/msword']),
    engine: 'doc-codec + docx-preview (bundled, local)',
    limitations: 'Yayra creates a temporary macro-free viewing copy in memory; the original stays unchanged. VBA and OLE objects are not executed, and uncommon legacy layout, fields, headers or revision markup may be simplified.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: false,
      rotate: false, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: false, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  xlsx: Object.freeze({
    viewer: 'xlsx',
    label: 'Spreadsheet',
    shortLabel: 'Spreadsheet',
    extensions: Object.freeze(['xlsx', 'xlsm', 'csv']),
    mimeTypes: Object.freeze([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'text/csv'
    ]),
    engine: 'SheetJS Community Edition (bundled)',
    limitations: 'Charts, conditional formatting and frozen panes are not drawn. Formula cells show their stored result and expose the formula in a tooltip.',
    capabilities: caps({
      view: true, search: true, zoom: false, pageNavigation: true,
      rotate: false, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: true, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  xls: Object.freeze({
    viewer: 'xls',
    label: 'Excel 97–2003 spreadsheet',
    shortLabel: 'Spreadsheet',
    extensions: Object.freeze(['xls']),
    mimeTypes: Object.freeze(['application/vnd.ms-excel']),
    engine: 'SheetJS Community Edition (bundled)',
    limitations: 'Legacy workbook bytes are read directly and remain unchanged. VBA and embedded OLE objects are not executed; charts, conditional formatting and frozen panes are not drawn.',
    capabilities: caps({
      view: true, search: true, zoom: false, pageNavigation: true,
      rotate: false, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: true, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  image: Object.freeze({
    viewer: 'image',
    label: 'Image',
    shortLabel: 'Image',
    extensions: Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg']),
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/svg+xml']),
    engine: 'Browser image decoder',
    limitations: '',
    capabilities: caps({
      view: true, search: false, zoom: true, pageNavigation: false,
      rotate: true, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: false, animate: true,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  text: Object.freeze({
    viewer: 'text',
    label: 'Text document',
    shortLabel: 'Text',
    extensions: Object.freeze(['txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml']),
    mimeTypes: Object.freeze(['text/plain', 'text/markdown', 'application/json', 'application/xml', 'text/xml']),
    engine: 'Safe plain-text renderer',
    limitations: 'Markup and scripts are shown as text and are never executed.',
    capabilities: caps({
      view: true, search: true, zoom: true, pageNavigation: false,
      rotate: false, nightMode: true, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: false, animate: false,
      annotate: false, edit: false, save: false, export: false, print: true
    })
  }),
  unsupported: Object.freeze({
    viewer: 'unsupported',
    label: 'Unsupported document',
    shortLabel: 'Original file',
    extensions: Object.freeze([]),
    mimeTypes: Object.freeze([]),
    engine: 'Safe original-file fallback',
    limitations: 'Yayra could not identify a safe built-in viewer for this file. The unchanged original remains available to download or open with an installed desktop application.',
    capabilities: caps({
      view: false, search: false, zoom: false, pageNavigation: false,
      rotate: false, nightMode: false, outline: false, thumbnails: false,
      presentation: false, notes: false, sheets: false, animate: false,
      annotate: false, edit: false, save: false, export: false, print: false
    })
  })
});

export const MAX_DOCUMENT_BYTES = 300 * 1024 * 1024;

export const DOCUMENT_ACCEPT = Object.freeze([
  '.pdf', '.pptx', '.pptm', '.docx', '.xlsx', '.xlsm', '.xls', '.csv',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.svg',
  '.txt', '.md', '.markdown', '.log', '.json', '.xml', '.yaml', '.yml',
  // Binary Office 97–2003 is parsed locally; source bytes remain unchanged.
  '.ppt', '.doc'
]);

const EXTENSION_KIND = new Map();
const MIME_KIND = new Map();
for (const [kind, engine] of Object.entries(DOCUMENT_ENGINES)) {
  if (kind !== 'unsupported') {
    for (const ext of engine.extensions) EXTENSION_KIND.set(ext, kind);
  }
  for (const mime of engine.mimeTypes) MIME_KIND.set(String(mime).toLowerCase(), kind);
}
for (const ext of DOCUMENT_ENGINES.unsupported.extensions) EXTENSION_KIND.set(ext, 'unsupported');

export function documentExtension(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** Classify from filename and, when supplied, its declared MIME type. */
export function classifyDocument(fileName, mimeType = '') {
  const extensionKind = EXTENSION_KIND.get(documentExtension(fileName));
  if (extensionKind) return extensionKind;
  const normalizedMime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (!normalizedMime || normalizedMime === 'application/octet-stream') return null;
  if (MIME_KIND.has(normalizedMime)) return MIME_KIND.get(normalizedMime);
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('text/')) return 'text';
  return null;
}

export function isAcceptedDocument(fileName, mimeType = '') {
  return classifyDocument(fileName, mimeType) !== null;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.length || 0);
  }
  return new Uint8Array(0);
}

const starts = (bytes, values, offset = 0) => values.every((value, index) => bytes[offset + index] === value);

const COMPOUND_FILE_SIGNATURE = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const CFB_FREE_SECTOR = 0xffffffff;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_NO_STREAM = 0xffffffff;

function readUint16LE(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.byteLength) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function compoundDirectoryEntry(bytes, offset) {
  if (offset < 0 || offset + 128 > bytes.byteLength) return null;
  const type = bytes[offset + 66];
  const nameBytes = readUint16LE(bytes, offset + 64);
  if (![1, 2, 5].includes(type) || !nameBytes || nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0) return null;
  let name = '';
  for (let cursor = offset; cursor < offset + nameBytes - 2; cursor += 2) {
    const code = readUint16LE(bytes, cursor);
    if (!code) break;
    name += String.fromCharCode(code);
  }
  if (!name) return null;
  return {
    name,
    type,
    left: readUint32LE(bytes, offset + 68),
    right: readUint32LE(bytes, offset + 72),
    child: readUint32LE(bytes, offset + 76)
  };
}

/** Read only the CFB FAT + directory tree; no document stream is decoded. */
function compoundRootNames(bytes) {
  if (bytes.byteLength < 512 || !starts(bytes, COMPOUND_FILE_SIGNATURE)) return null;
  if (readUint16LE(bytes, 28) !== 0xfffe || readUint16LE(bytes, 32) !== 6) return [];
  const majorVersion = readUint16LE(bytes, 26);
  const sectorShift = readUint16LE(bytes, 30);
  if (!((majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12))) return [];
  const sectorSize = 2 ** sectorShift;
  const sectorsInFile = Math.max(0, Math.floor(bytes.byteLength / sectorSize) - 1);
  const sectorOffset = (sector) => {
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectorsInFile) return -1;
    const offset = (sector + 1) * sectorSize;
    return offset + sectorSize <= bytes.byteLength ? offset : -1;
  };

  const fatSectorIds = [];
  const declaredFatSectors = readUint32LE(bytes, 44) || 0;
  if (!declaredFatSectors || declaredFatSectors > sectorsInFile) return [];
  for (let index = 0; index < 109; index += 1) {
    const sector = readUint32LE(bytes, 76 + index * 4);
    if (sector !== null && sector < sectorsInFile) fatSectorIds.push(sector);
  }
  let difatSector = readUint32LE(bytes, 68);
  const declaredDifatSectors = readUint32LE(bytes, 72) || 0;
  if (declaredDifatSectors > sectorsInFile) return [];
  const seenDifat = new Set();
  const difatEntriesPerSector = (sectorSize / 4) - 1;
  for (let count = 0; count < declaredDifatSectors; count += 1) {
    if (difatSector === null || difatSector === CFB_END_OF_CHAIN || seenDifat.has(difatSector)) break;
    seenDifat.add(difatSector);
    const offset = sectorOffset(difatSector);
    if (offset < 0) break;
    for (let index = 0; index < difatEntriesPerSector; index += 1) {
      const sector = readUint32LE(bytes, offset + index * 4);
      if (sector !== null && sector < sectorsInFile) fatSectorIds.push(sector);
    }
    difatSector = readUint32LE(bytes, offset + difatEntriesPerSector * 4);
  }
  if (fatSectorIds.length < declaredFatSectors) return [];
  fatSectorIds.length = declaredFatSectors;
  const fatEntriesPerSector = sectorSize / 4;
  const nextSector = (sector) => {
    const fatIndex = Math.floor(sector / fatEntriesPerSector);
    const fatSector = fatSectorIds[fatIndex];
    const offset = sectorOffset(fatSector);
    if (offset < 0) return CFB_END_OF_CHAIN;
    return readUint32LE(bytes, offset + (sector % fatEntriesPerSector) * 4) ?? CFB_END_OF_CHAIN;
  };

  const records = [];
  let directorySector = readUint32LE(bytes, 48);
  const seenDirectory = new Set();
  while (directorySector !== null
    && directorySector !== CFB_END_OF_CHAIN
    && !seenDirectory.has(directorySector)
    && seenDirectory.size <= sectorsInFile) {
    seenDirectory.add(directorySector);
    const offset = sectorOffset(directorySector);
    if (offset < 0) break;
    for (let entryOffset = offset; entryOffset < offset + sectorSize; entryOffset += 128) {
      records.push(compoundDirectoryEntry(bytes, entryOffset));
    }
    directorySector = nextSector(directorySector);
  }

  const rootIndex = records.findIndex((record) => record?.type === 5);
  const root = records[rootIndex];
  if (!root || root.child === CFB_NO_STREAM || root.child === null) return [];
  const names = [];
  const pending = [root.child];
  const visited = new Set();
  while (pending.length && visited.size <= records.length) {
    const id = pending.pop();
    if (!Number.isInteger(id) || id < 0 || id >= records.length || visited.has(id)) continue;
    visited.add(id);
    const record = records[id];
    if (!record) continue;
    names.push(record.name);
    if (record.left !== CFB_NO_STREAM && record.left !== null) pending.push(record.left);
    if (record.right !== CFB_NO_STREAM && record.right !== null) pending.push(record.right);
  }
  return names;
}

/** Distinguish binary Office siblings that all share D0 CF 11 E0... bytes. */
export function sniffCompoundOfficeKind(value) {
  const bytes = bytesOf(value);
  if (!starts(bytes, COMPOUND_FILE_SIGNATURE)) return null;
  // Only names reachable through the header-declared FAT and root directory
  // are authoritative. Scanning arbitrary aligned bytes can mistake an
  // embedded stream—or hostile payload—for a top-level Office stream.
  const names = compoundRootNames(bytes) || [];
  const normalized = new Set(names.map((name) => String(name).toLocaleLowerCase()));
  const has = (name) => normalized.has(name.toLocaleLowerCase());
  // Require each format's characteristic root streams when possible. This
  // avoids mistaking an embedded workbook/deck for its containing document.
  if (has('PowerPoint Document') && has('Current User')) return 'ppt';
  if (has('WordDocument') && (has('0Table') || has('1Table'))) return 'doc';
  if (has('Workbook') || has('Book')) return 'xls';
  if (has('PowerPoint Document')) return 'ppt';
  if (has('WordDocument')) return 'doc';
  return 'unsupported';
}

function hasAscii(bytes, needle, start = 0, end = bytes.length) {
  if (!needle || end - start < needle.length) return false;
  const first = needle.charCodeAt(0);
  const max = Math.min(bytes.length, end) - needle.length;
  outer: for (let i = Math.max(0, start); i <= max; i += 1) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Sniff a document's real type without uploading or converting it.
 * ZIP entry names are present uncompressed in both local and central headers,
 * so Office Open XML packages can be distinguished without parsing the whole
 * archive. We scan a bounded prefix plus the central-directory tail to keep a
 * 300 MB deck from causing an equally large temporary string allocation.
 */
export function sniffDocumentKind(value, fileName = '', mimeType = '') {
  const bytes = bytesOf(value);
  if (!bytes.length) return classifyDocument(fileName, mimeType);
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image';
  if (starts(bytes, [0x42, 0x4d])) return 'image';
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image';
  if (bytes.length > 12 && hasAscii(bytes, 'ftypavif', 4, 20)) return 'image';

  const compoundKind = sniffCompoundOfficeKind(bytes);
  if (compoundKind) return compoundKind;

  const headEnd = Math.min(bytes.length, 8 * 1024 * 1024);
  const tailStart = Math.max(headEnd, bytes.length - 2 * 1024 * 1024);
  const inZip = (needle) => hasAscii(bytes, needle, 0, headEnd)
    || (tailStart < bytes.length && hasAscii(bytes, needle, tailStart, bytes.length));
  if (starts(bytes, [0x50, 0x4b])) {
    if (inZip('ppt/presentation.xml')) return 'pptx';
    if (inZip('word/document.xml')) return 'docx';
    if (inZip('xl/workbook.xml')) return 'xlsx';
  }

  // SVG is text, but it belongs in the image viewer. Only inspect a small
  // UTF-8/ASCII prefix; scripts still cannot execute when loaded as <img>.
  const prefix = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 2048))).replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image';

  return classifyDocument(fileName, mimeType);
}

export function routeDocument(kind) {
  return DOCUMENT_ENGINES[kind] || DOCUMENT_ENGINES.unsupported;
}

export function mimeForDocument(kind, fileName = '') {
  const ext = documentExtension(fileName);
  const exact = {
    pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xls: 'application/vnd.ms-excel', csv: 'text/csv',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', log: 'text/plain', json: 'application/json',
    xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', doc: 'application/msword', ppt: 'application/vnd.ms-powerpoint'
  };
  if (exact[ext]) return exact[ext];
  const engine = routeDocument(kind);
  return engine.mimeTypes[0] || 'application/octet-stream';
}

export function supportedDocumentKinds() {
  return Object.keys(DOCUMENT_ENGINES).filter((kind) => kind !== 'unsupported');
}

export function unsupportedDocumentKinds() {
  return [...DOCUMENT_ENGINES.unsupported.extensions];
}
