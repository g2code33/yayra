import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { MAX_DOCUMENT_BYTES } from '../packages/shared-ui/src/services/documentWorkspace.js';

const require = createRequire(import.meta.url);
const { parsePdfFileArg } = require('../electron/pdfLaunch.cjs');

/**
 * "PDF EVERYWHERE" (user request):
 *  1. Right-clicking a DOWNLOADED pdf offers "Open in Yayra" so the
 *     built-in document viewer handles it (no OS app needed).
 *  2. PDFs viewed in Yayra have a button to use the DESKTOP pdf app
 *     instead (honest escape hatch).
 *  3. The OS "Open with > yayra" flow works: Yayra registers as a pdf
 *     handler (.desktop MimeType + Windows fileAssociations) and a
 *     launched pdf file opens in the viewer.
 *  4. Dragging any pdf onto ANY part of Yayra opens it in the viewer.
 */

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]).buffer; // "%PDF-1.7"

function fakeDesktop({ openPdfResult } = {}) {
  const calls = { openExternal: [], openPdf: [] };
  // Real bridge shape: documents live under yayra.system (preload.cjs),
  // downloads at the top level.
  window.yayra = {
    system: {
      documents: {
        openExternal: async (opts) => { calls.openExternal.push(opts); return { ok: true }; },
        onOpenPdfFile: (cb) => { fakeDesktop.push = cb; return () => { fakeDesktop.push = null; }; }
      }
    },
    downloads: {
      list: async () => ({ items: [], downloadRoot: null }),
      openPdf: async (id) => {
        calls.openPdf.push(id);
        return typeof openPdfResult === 'function'
          ? openPdfResult(id)
          : (openPdfResult || { ok: true, name: 'downloaded-report.pdf', data: PDF_BYTES });
      }
    }
  };
  return calls;
}

async function makeShell() {
  globalThis.localStorage = makeStorage();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test('DRAG & DROP: a PDF dropped anywhere in Yayra opens in the built-in viewer', async () => {
  const { shell } = await makeShell();
  try {
    assert.ok(shell._pdfDropHandlers, 'the global drop zone is armed');
    const tabsBefore = shell.state.tabs.length;
    const file = { name: 'dragged doc.pdf', arrayBuffer: async () => PDF_BYTES.slice(0) };
    await shell._openDroppedPdfFiles([file]);
    const tab = shell.getActiveTab();
    assert.ok(tab.isDocument, 'a document tab opened');
    assert.equal(tab.title, 'dragged doc.pdf');
    assert.equal(shell.state.tabs.length, tabsBefore + 1);
    // The drop handler itself: preventDefault + files -> open.
    let prevented = false;
    shell._pdfDropHandlers.drop({
      dataTransfer: { types: ['Files'], files: [file] },
      target: { tagName: 'DIV' },
      preventDefault: () => { prevented = true; }
    });
    await flush();
    assert.equal(prevented, true, 'the default (navigate-away) is prevented');
    assert.equal(shell.state.tabs.filter((t) => t.isDocument).length, 2, 'the dropped pdf opened a viewer tab');
  } finally {
    shell.destroy();
    delete window.yayra;
    delete globalThis.localStorage;
  }
});

test('DRAG & DROP: oversized PDFs are refused before reading into memory', async () => {
  const { shell } = await makeShell();
  try {
    let readCalls = 0;
    const notices = [];
    shell.showTransientNotice = (message) => notices.push(message);
    await shell._openDroppedPdfFiles([{
      name: 'huge.pdf',
      size: MAX_DOCUMENT_BYTES + 1,
      arrayBuffer: async () => { readCalls += 1; return new ArrayBuffer(1); }
    }]);
    assert.equal(readCalls, 0, 'the 300 MB guard runs before allocating file bytes');
    assert.equal(shell.state.tabs.filter((tab) => tab.isDocument).length, 0, 'no dead document tab is created');
    assert.match(notices[0], /300 MB/);
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('FILE PICKER: oversized PDFs are rejected before FileReader and the input can be reused', async () => {
  const { shell } = await makeShell();
  try {
    const notices = [];
    shell.showTransientNotice = (message) => notices.push(message);
    shell._openDocumentFileInput();
    const input = shell._docFileInput;
    input.files = [{ name: 'huge.pdf', size: MAX_DOCUMENT_BYTES + 1 }];
    input.value = 'selected';
    input.dispatchEvent({ type: 'change', target: input });
    assert.match(notices[0], /300 MB/);
    assert.equal(input.value, '', 'reset allows selecting a different file after rejection');
    assert.equal(shell.state.tabs.filter((tab) => tab.isDocument).length, 0);
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('DRAG & DROP: supported files render internally and unknown files get an honest original-file fallback', async () => {
  const { shell } = await makeShell();
  try {
    const tabsBefore = shell.state.tabs.length;
    await shell._openDroppedPdfFiles([{ name: 'budget.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }]);
    assert.equal(shell.state.tabs.filter((t) => t.isDocument).length, 1, 'a spreadsheet receives an internal document tab');
    assert.equal(shell.getActiveTab().docState.viewer, 'xlsx');
    assert.equal(shell.state.tabs.length, tabsBefore + 1);

    const afterSpreadsheet = shell.state.tabs.length;
    await shell._openDroppedPdfFiles([{ name: 'program.exe', arrayBuffer: async () => new ArrayBuffer(4) }]);
    assert.equal(shell.state.tabs.length, afterSpreadsheet + 1, 'every explicitly opened local file receives a safe tab');
    assert.equal(shell.getActiveTab().docState.viewer, 'unsupported', 'unknown bytes are never rendered as trusted content');
    assert.ok(shell.state.documentsItems.some((entry) => entry.name === 'program.exe' && entry.source === 'session'),
      'the unknown file is still accessible from the session Documents hub');

    // Existing download-specific PDF detection remains deliberately narrow.
    assert.equal(shell.isPdfDownload({ filename: 'x.pdf' }), true);
    assert.equal(shell.isPdfDownload({ filename: 'x.docx' }), false);
    assert.equal(shell.isPdfDownload({ filename: 'x.bin', mime: 'application/pdf' }), true);
  } finally {
    shell.destroy();
    delete window.yayra;
    delete globalThis.localStorage;
  }
});

test('SHELL DISPOSAL: PDF byte buffers and the hidden file input are released', async () => {
  const { shell } = await makeShell();
  let destroyed = false;
  try {
    shell.addDocumentTab({ name: 'temporary.pdf', bytes: new Uint8Array([1, 2, 3]) });
    shell._openDocumentFileInput();
    const hiddenInput = shell._docFileInput;
    assert.ok(hiddenInput.parentElement, 'file input is attached while the shell is active');

    shell.destroy();
    destroyed = true;
    assert.equal(shell.documentStore.list().length, 0, 'document byte references are removed on disposal');
    assert.equal(hiddenInput.parentElement, null, 'hidden file input is detached');
    assert.equal(shell._docFileInput, null);
  } finally {
    if (!destroyed) shell.destroy();
    delete globalThis.localStorage;
  }
});

test('OPEN WITH ARGUMENTS: registered document paths and Linux file:// URIs resolve locally', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'yayra-document-open-'));
  const pdfPath = join(tempDir, 'annual report 2026.pdf');
  const pptxPath = join(tempDir, 'board deck.pptx');
  const unknownPath = join(tempDir, 'program.exe');
  writeFileSync(pdfPath, '%PDF-1.7');
  writeFileSync(pptxPath, 'PK');
  writeFileSync(unknownPath, 'MZ');
  const fileUri = pathToFileURL(pdfPath).href;
  try {
    assert.equal(parsePdfFileArg(['--some-electron-flag', pdfPath]), pdfPath, 'ordinary OS path works');
    assert.equal(parsePdfFileArg(['--some-electron-flag', fileUri]), pdfPath, 'URI-encoded spaces from Linux %U become a filesystem path');
    assert.equal(parsePdfFileArg([`"${fileUri}"`]), pdfPath, 'quoted desktop URI is also accepted');
    assert.equal(parsePdfFileArg([pptxPath]), pptxPath, 'non-PDF viewable documents use the same byte-only launch route');
    assert.equal(parsePdfFileArg([unknownPath]), null, 'unregistered files are ignored');
    assert.equal(parsePdfFileArg(['https://example.com/remote.pdf']), null, 'remote URLs are never read as local files');
    assert.equal(parsePdfFileArg(['--pdf', join(tempDir, 'missing.pdf')]), null, 'a nonexistent PDF is ignored');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('OPEN WITH: a pdf pushed by the OS launch ("Open with > yayra") opens in the viewer as a new tab', async () => {
  const calls = fakeDesktop();
  const { shell } = await makeShell();
  try {
    assert.ok(fakeDesktop.push, 'the shell subscribed to open-pdf-file pushes');
    const tabsBefore = shell.state.tabs.length;
    fakeDesktop.push({ name: 'from-desktop.pdf', data: PDF_BYTES.slice(0) });
    assert.equal(shell.state.tabs.length, tabsBefore + 1, 'the desktop-opened PDF gets its own new tab');
    const tab = shell.getActiveTab();
    assert.ok(tab.isDocument, 'the OS-provided pdf opened in the viewer');
    assert.equal(tab.title, 'from-desktop.pdf');
    assert.deepEqual(calls.openExternal, [], 'nothing external happened');
  } finally {
    shell.destroy();
    delete window.yayra;
    delete globalThis.localStorage;
  }
});

test('VIEWER BUTTON: "Desktop app" hands the CURRENT pdf to the OS pdf reader', async () => {
  const calls = fakeDesktop();
  const { shell, container } = await makeShell();
  try {
    shell._docEngineOverride = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve() }), getTextContent: async () => ({ items: [] }) }), destroy: () => {} }) }) };
    shell.addDocumentTab({ name: 'in-viewer.pdf', bytes: PDF_BYTES.slice(0) });
    const btns = Array.from(container.querySelectorAll('.fb-doc-btn'));
    const desktopBtn = btns.find((b) => (b.textContent || '').includes('Desktop app'));
    assert.ok(desktopBtn, 'the "use the desktop pdf app instead" button exists');
    desktopBtn.click();
    await flush();
    assert.equal(calls.openExternal.length, 1, 'the bytes were handed to the OS');
    assert.equal(calls.openExternal[0].name, 'in-viewer.pdf');
    assert.ok(calls.openExternal[0].data.byteLength > 0, 'with the document bytes');
  } finally {
    shell.destroy();
    delete window.yayra;
    delete globalThis.localStorage;
  }
});

test('DOWNLOADS RIGHT-CLICK: downloaded PDFs and images open in the matching built-in viewer', async () => {
  const calls = fakeDesktop({
    openPdfResult: (id) => id === 'dl-2'
      ? { ok: true, name: 'downloaded-photo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer }
      : { ok: true, name: 'downloaded-report.pdf', data: PDF_BYTES }
  });
  const { shell, container } = await makeShell();
  try {
    shell.state.downloadsItems = [
      { id: 'dl-1', filename: 'annual-report.pdf', state: 'Completed', path: '/home/me/Downloads/annual-report.pdf' },
      { id: 'dl-2', filename: 'photo.png', state: 'Completed', path: '/home/me/Downloads/photo.png' }
    ];
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);
    const rows = Array.from(container.querySelectorAll('.fb-dl-item'));
    assert.ok(rows.length >= 2, 'download rows render');

    // The context menu on the PDF download offers "Open in Yayra".
    const pdfItem = shell.state.downloadsItems[0];
    shell.showDownloadsContextMenu({ clientX: 120, clientY: 80, preventDefault: () => {} }, pdfItem);
    const menu = document.getElementById('yayra-dl-context-menu');
    assert.ok(menu, 'the context menu opened');
    assert.match(menu.style.cssText, /z-index:2147483647/, 'the downloaded-file context menu stacks above the downloads panel');
    const entries = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent);
    assert.ok(entries.includes('Open in Yayra'), '"Open in Yayra" is offered for pdf downloads');

    // Clicking it reads the bytes (IPC) and opens the document viewer.
    const openInYayra = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent === 'Open in Yayra');
    openInYayra.click();
    await flush();
    assert.deepEqual(calls.openPdf, ['dl-1'], 'the bytes were requested through the bridge');
    const tab = shell.getActiveTab();
    assert.ok(tab.isDocument, 'the downloaded pdf opened in the built-in viewer');
    assert.equal(tab.title, 'downloaded-report.pdf');

    // Images and the other registered document formats use the same action.
    shell.showDownloadsContextMenu({ clientX: 120, clientY: 80, preventDefault: () => {} }, shell.state.downloadsItems[1]);
    const menu2 = document.getElementById('yayra-dl-context-menu');
    const imageOpen = Array.from(menu2.querySelectorAll('button')).find((b) => b.textContent === 'Open in Yayra');
    assert.ok(imageOpen, 'a downloaded image gets the internal viewer entry');
    imageOpen.click();
    await flush();
    assert.deepEqual(calls.openPdf, ['dl-1', 'dl-2']);
    assert.equal(shell.getActiveTab().title, 'downloaded-photo.png');
    assert.equal(shell.getActiveTab().docState.viewer, 'image');
  } finally {
    shell.destroy();
    delete window.yayra;
    delete globalThis.localStorage;
  }
});

test('DOWNLOADS RIGHT-CLICK: without the desktop bridge the honest notice shows (no dead button)', async () => {
  delete window.yayra;
  const { shell } = await makeShell();
  try {
    const item = { id: 'dl-9', filename: 'doc.pdf', state: 'Completed', url: 'https://example.com/doc.pdf' };
    shell.showDownloadsContextMenu({ clientX: 10, clientY: 10, preventDefault: () => {} }, item);
    const menu = document.getElementById('yayra-dl-context-menu');
    assert.ok(menu, 'menu opens');
    const openInYayra = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent === 'Open in Yayra');
    openInYayra.click();
    await flush();
    assert.equal(shell.state.tabs.filter((t) => t.isDocument).length, 0, 'nothing pretends to open');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('SOURCE PIN (main.cjs): OS "Open With" launches, desktop-app escape hatch, downloads->viewer bytes IPC', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /const MAX_DOCUMENT_BYTES = 300 \* 1024 \* 1024;/, 'desktop document routes share the 300 MB ceiling');
  // Open With: a real .pdf file argument is parsed, capped, and delivered.
  const parser = readFileSync(new URL('../electron/pdfLaunch.cjs', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/pdfLaunch\.cjs'\)/, 'main process uses the desktop-argument parser');
  assert.match(parser, /fileURLToPath\(fileUrl\)/, 'Linux file:// launches are decoded to local paths');
  assert.match(parser, /DOCUMENT_EXTENSIONS\.has\(extension\)/, 'only registered local document extensions are accepted');
  for (const extension of ['pdf', 'pptx', 'docx', 'xlsx', 'png', 'txt']) {
    assert.match(parser, new RegExp(`['"]${extension}['"]`), `${extension} is accepted from OS Open With`);
  }
  assert.match(src, /mainWindow\.webContents\.send\('yayra:open-pdf-file'/, 'bytes are pushed to the renderer');
  assert.match(src, /did-finish-load', \(\) => flushPendingPdfFiles\(\)\)/, 'cold-start launches flush once the shell is up');
  assert.match(src, /webContents\.isLoadingMainFrame\(\)/, 'a second-instance launch waits for a newly-created renderer');
  assert.match(src, /const pdfFile = parsePdfFileArg\(argv \|\| \[\]\);/, 'second-instance pdf launches are handled');
  // Desktop app escape hatch: temp file + OS open, sanitized name.
  const ext = src.indexOf("ipcMain.handle('yayra:doc-open-externally'");
  assert.ok(ext > -1, 'doc-open-externally handler exists');
  const extBlock = src.slice(ext, ext + 1400);
  assert.match(extBlock, /shell\.openPath\(filePath\)/, 'opened with the OS handler');
  assert.match(extBlock, /yayra-docs/, 'a dedicated temp directory');
  assert.match(extBlock, /replace\(/, 'the file name is sanitized');
  // Downloads -> viewer: bytes only, size-capped.
  const dl = src.indexOf("ipcMain.handle('yayra:downloads-open-pdf'");
  assert.ok(dl > -1, 'downloads-open-pdf handler exists');
  const dlBlock = src.slice(dl, dl + 1000);
  assert.match(dlBlock, /downloadsStore\.load\(\)/, 'the download is looked up by id');
  assert.match(dlBlock, /stat\.size > MAX_DOCUMENT_BYTES/, 'downloaded documents use the shared 300 MB cap');
  assert.ok(!/:\s*item\.path\s*[,}]/.test(dlBlock), 'no path leaks to the renderer');
});

test('SOURCE PIN (packaging): Yayra registers its internal document formats for OS Open With', () => {
  const mainDesktop = readFileSync(new URL('../build/linux/yayra.desktop', import.meta.url), 'utf8');
  assert.match(mainDesktop, /MimeType=.*application\/pdf/, 'the deb desktop entry claims PDF handling');
  assert.match(mainDesktop, /vnd\.openxmlformats-officedocument\.presentationml\.presentation/, 'the deb desktop entry claims PPTX handling');
  assert.match(mainDesktop, /vnd\.openxmlformats-officedocument\.wordprocessingml\.document/, 'the deb desktop entry claims DOCX handling');
  assert.match(mainDesktop, /vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/, 'the deb desktop entry claims XLSX handling');
  assert.match(mainDesktop, /Exec=yayra %U/, 'and receives file arguments');
  const appimageDesktop = readFileSync(new URL('../build/linux/yayra-appimage.desktop', import.meta.url), 'utf8');
  assert.match(appimageDesktop, /MimeType=.*application\/pdf/, 'the AppImage entry too');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(pkg.build.fileAssociations), 'electron-builder fileAssociations configured');
  const associations = pkg.build.fileAssociations.flatMap((fa) => Array.isArray(fa.ext) ? fa.ext : [fa.ext]);
  for (const extension of ['pdf', 'pptx', 'docx', 'xlsx', 'png']) assert.ok(associations.includes(extension), `${extension} is associated`);
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /openExternal: \(\{ name, data \}/, 'the desktop-app bridge exists');
  assert.match(preload, /onOpenPdfFile: \(callback\)/, 'the open-with push channel exists');
  assert.match(preload, /openPdf: \(id\) => ipcRenderer\.invoke\('yayra:downloads-open-pdf'/, 'the downloads bridge exists');
});
