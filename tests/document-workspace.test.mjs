import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import {
  classifyDocument,
  unsupportedDocumentKinds,
  DOCUMENT_ENGINES,
  DocumentStore,
  MAX_DOCUMENT_BYTES,
  createPdfViewer,
  createPptxViewer,
  createDocumentViewerState
} from '../packages/shared-ui/src/services/documentWorkspace.js';

/**
 * UNIFIED DOCUMENT WORKSPACE.
 *
 * Pinned here:
 *  - the registry advertises only real bundled/offline capabilities
 *  - local files use real document tabs and never touch a website engine
 *  - PDF load, continuous painting, navigation, search and failure states
 *  - security: Electron transfers selected bytes, never source paths
 *  - session restore excludes ephemeral in-memory document tabs
 */

/** A deterministic fake PDF.js engine (no canvas needed). */
function fakePdfjs({ pages = 3, texts = null, failWith = null } = {}) {
  const pageTexts = texts || [
    'Welcome to the quarterly report.',
    'Revenue grew by forty percent.',
    'Thanks for reading the report.'
  ];
  return {
    getDocument: () => {
      const promise = (async () => {
        if (failWith) throw failWith;
        return {
          numPages: pages,
          getPage: async (n) => ({
            getViewport: ({ scale = 1 } = {}) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: Promise.resolve() }),
            getTextContent: async () => ({ items: [{ str: pageTexts[(n - 1) % pageTexts.length] }] })
          }),
          destroy: () => {}
        };
      })();
      return { promise };
    }
  };
}

function makeStore() {
  const store = new DocumentStore();
  return store;
}

function makeTinyPdfBytes(text = 'Fast local PDF reader') {
  const stream = `BT /F1 18 Tf 30 70 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'ascii'));
}

test('REGISTRY: bundled viewers and explicit legacy fallbacks advertise honest capabilities', () => {
  for (const [file, kind] of [
    ['report.pdf', 'pdf'], ['DECK.PPTX', 'pptx'], ['notes.pptm', 'pptx'],
    ['letter.docx', 'docx'], ['book.xlsx', 'xlsx'], ['old.xls', 'xlsx'],
    ['table.csv', 'xlsx'], ['photo.webp', 'image'], ['readme.md', 'text'],
    ['legacy.doc', 'unsupported'], ['legacy.ppt', 'unsupported']
  ]) assert.equal(classifyDocument(file), kind, file);
  assert.deepEqual(unsupportedDocumentKinds().sort(), ['doc', 'ppt']);
  assert.equal(classifyDocument('no-extension'), null);
  assert.equal(classifyDocument(''), null);

  for (const kind of ['pdf', 'pptx', 'docx', 'xlsx', 'image', 'text']) {
    assert.equal(DOCUMENT_ENGINES[kind].capabilities.view, true, `${kind} is actually viewable`);
    assert.equal(DOCUMENT_ENGINES[kind].capabilities.edit, false, `${kind} does not claim editing`);
    assert.equal(DOCUMENT_ENGINES[kind].capabilities.save, false, `${kind} does not claim editing the source`);
    assert.equal(DOCUMENT_ENGINES[kind].capabilities.print, true, `${kind} exposes real browser printing`);
  }
  assert.equal(DOCUMENT_ENGINES.pdf.capabilities.print, true);
  assert.equal(DOCUMENT_ENGINES.pdf.capabilities.presentation, true);
  assert.equal(DOCUMENT_ENGINES.pptx.capabilities.presentation, true);
  assert.equal(DOCUMENT_ENGINES.pptx.capabilities.notes, true);
  assert.equal(DOCUMENT_ENGINES.pptx.capabilities.embeddedVideo, true);
  assert.equal(DOCUMENT_ENGINES.xlsx.capabilities.sheets, true);
  assert.equal(DOCUMENT_ENGINES.image.capabilities.search, false);
  assert.equal(DOCUMENT_ENGINES.unsupported.capabilities.view, false);
});

test('STORE: in-memory, no paths, unique ids, empty files refused', () => {
  assert.equal(MAX_DOCUMENT_BYTES, 300 * 1024 * 1024, 'every renderer entry point shares the requested 300 MB ceiling');
  const store = makeStore();
  const a = store.add({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]) });
  const b = store.add({ name: 'b.pdf', bytes: new Uint8Array([4, 5]) });
  assert.notEqual(a.id, b.id);
  assert.equal(a.type, 'pdf');
  assert.equal(a.size, 3);
  assert.equal(store.get(a.id).name, 'a.pdf');
  assert.equal(store.list().length, 2);
  assert.ok(store.remove(a.id));
  assert.equal(store.get(a.id), null);
  assert.throws(() => store.add({ name: 'empty.pdf', bytes: new Uint8Array([]) }), /empty/);
  assert.throws(() => store.add({ name: 'too-large.pdf', bytes: { byteLength: MAX_DOCUMENT_BYTES + 1 } }), /document-too-large/,
    'the document store enforces the same 300 MB ceiling for every open path');
});

test('VIEWER: load -> ready with page count; navigation is clamped to the document', async () => {
  const state = { status: 'idle', numPages: 0, page: 1, zoom: 1.25, query: '', matches: [], matchIndex: -1, error: null };
  const viewer = createPdfViewer({ pdfjs: fakePdfjs({ pages: 3 }), container: null, state });
  await viewer.load(new Uint8Array([1, 2, 3]));
  assert.equal(state.status, 'ready');
  assert.equal(state.numPages, 3);
  await viewer.setPage(2);
  assert.equal(state.page, 2);
  await viewer.nextPage();
  await viewer.nextPage(); // past the end - clamped
  assert.equal(state.page, 3);
  await viewer.prevPage();
  await viewer.prevPage();
  await viewer.prevPage(); // before the start - clamped
  assert.equal(state.page, 1);
  viewer.destroy();
});

test('VIEWER: paints the first PDF page to a live canvas and repaints on zoom', async () => {
  const state = createDocumentViewerState();
  const container = document.createElement('div');
  let renders = 0;
  let lastViewport = null;
  container.ownerDocument = {
    createElement(tagName) {
      const element = document.createElement(tagName);
      if (String(tagName).toLowerCase() === 'canvas') {
        element.getContext = () => ({ canvas: element });
      }
      return element;
    }
  };
  const pdfjs = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          rotate: 0,
          getViewport: ({ scale = 1 } = {}) => ({ width: 400 * scale, height: 600 * scale, scale }),
          render: ({ canvasContext, viewport }) => {
            assert.ok(canvasContext, 'a real 2D context is supplied');
            renders += 1;
            lastViewport = viewport;
            return { promise: Promise.resolve() };
          }
        }),
        destroy: () => {}
      })
    })
  };
  const viewer = createPdfViewer({ pdfjs, container, state });
  try {
    await viewer.load(new Uint8Array([1, 2, 3]));
    assert.equal(state.status, 'ready');
    assert.equal(renders, 1, 'the first page paints as part of opening the document');
    assert.equal(lastViewport.scale, 1.25);
    assert.ok(container.querySelector('.fb-doc-canvas'), 'the painted page is attached to the visible PDF host');

    await viewer.setZoom(2);
    assert.equal(renders, 2, 'zoom repaints the current page');
    assert.equal(lastViewport.scale, 2);
    assert.equal(container.querySelectorAll('.fb-doc-canvas').length, 1, 'the old canvas is replaced, not stacked');
  } finally {
    viewer.destroy();
  }
});

test('VIEWER: zoom is clamped to a sane range', async () => {
  const state = { status: 'idle', numPages: 0, page: 1, zoom: 1.25, query: '', matches: [], matchIndex: -1, error: null };
  const viewer = createPdfViewer({ pdfjs: fakePdfjs(), container: null, state });
  await viewer.load(new Uint8Array([1]));
  await viewer.setZoom(50);
  assert.equal(state.zoom, 4, 'max 400%');
  await viewer.setZoom(0.01);
  assert.equal(state.zoom, 0.5, 'min 50%');
  viewer.destroy();
});

test('VIEWER: PDF projector mode fits one page at a time, including tall pages below the reader zoom floor', async () => {
  const state = createDocumentViewerState('pdf');
  const frame = document.createElement('div');
  frame.clientWidth = 320;
  frame.clientHeight = 240;
  const projectorHost = document.createElement('div');
  projectorHost.className = 'fb-document-slideshow-host';
  projectorHost.clientWidth = 320;
  projectorHost.clientHeight = 240;
  frame.appendChild(projectorHost);
  const sizes = [{ width: 600, height: 1200 }, { width: 1200, height: 600 }];
  const pdfjs = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (number) => ({
          rotate: 0,
          getViewport: ({ scale = 1 } = {}) => ({
            width: sizes[number - 1].width * scale,
            height: sizes[number - 1].height * scale,
            scale
          }),
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: async () => ({ items: [] })
        }),
        destroy() {}
      })
    })
  };
  const viewer = createPdfViewer({ pdfjs, container: projectorHost, state });
  try {
    await viewer.load(new Uint8Array([1]));
    await viewer.fitToPage();
    assert.ok(state.zoom < 0.5 && state.zoom > 0.19,
      'a tall projector page can fit below the normal reader’s 50% floor');
    assert.equal(projectorHost.querySelectorAll('.fb-pdf-page').filter((page) => page.style.display !== 'none').length, 1);

    await viewer.setPage(2);
    assert.equal(state.page, 2);
    assert.ok(state.zoom > 0.25 && state.zoom < 0.27,
      'a differently proportioned page is re-fitted when it becomes current');
    assert.equal(projectorHost.querySelectorAll('.fb-pdf-page').filter((page) => page.style.display !== 'none').length, 1);

    const readerHost = document.createElement('div');
    readerHost.clientWidth = 900;
    readerHost.clientHeight = 700;
    await viewer.attach(readerHost);
    await viewer.setZoom(0.01);
    assert.equal(state.zoom, 0.5, 'leaving the projector restores the established continuous-reader floor');
    assert.equal(readerHost.querySelectorAll('.fb-pdf-page').filter((page) => page.style.display !== 'none').length, 2,
      'continuous reading shows every page shell again');
  } finally {
    viewer.destroy();
  }
});

test('VIEWER: reports PDF.js progress and marks parsing complete before the first page draw', async () => {
  let resolvePdf;
  const task = { promise: new Promise((resolve) => { resolvePdf = resolve; }), onProgress: null };
  const state = createDocumentViewerState();
  const viewer = createPdfViewer({ pdfjs: { getDocument: () => task }, state });
  const loading = viewer.load(new Uint8Array([1, 2, 3]));
  task.onProgress({ loaded: 25, total: 100 });
  assert.equal(state.status, 'loading');
  assert.equal(state.progress, 25);
  assert.match(state.loadingStage, /Reading PDF/);
  resolvePdf({
    numPages: 1,
    getPage: async () => ({ getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }) }),
    destroy: () => {}
  });
  await loading;
  assert.equal(state.status, 'ready');
  assert.equal(state.progress, 100);
  viewer.destroy();
});

test('VIEWER: a stalled PDF worker times out with a useful error instead of loading forever', async () => {
  let destroyed = 0;
  const state = createDocumentViewerState();
  const viewer = createPdfViewer({
    pdfjs: { getDocument: () => ({ promise: new Promise(() => {}), destroy: () => { destroyed += 1; } }) },
    state,
    loadTimeoutMs: 10
  });
  // Keep Node's event loop alive while the viewer's timeout itself is
  // unref'd, matching a real browser where the shell stays open.
  const keepAlive = setTimeout(() => {}, 30);
  try {
    await viewer.load(new Uint8Array([1, 2, 3]));
    assert.equal(state.status, 'error');
    assert.match(state.error, /taking too long/i);
    assert.equal(destroyed, 1, 'the abandoned PDF.js task is cancelled');
  } finally {
    clearTimeout(keepAlive);
    viewer.destroy();
  }
});

test('VIEWER: text search finds matches across pages and jumps to the first', async () => {
  const state = { status: 'idle', numPages: 0, page: 1, zoom: 1, query: '', matches: [], matchIndex: -1, error: null };
  const viewer = createPdfViewer({ pdfjs: fakePdfjs(), container: null, state });
  await viewer.load(new Uint8Array([1]));
  await viewer.search('report');
  assert.equal(state.matches.length, 2, 'found on page 1 and page 3');
  assert.equal(state.matches[0].page, 1);
  assert.equal(state.page, 1, 'already on the first match');
  viewer.nextMatch();
  assert.equal(state.matchIndex, 1);
  assert.equal(state.page, 3, 'jumps to the next match page');
  await viewer.search('zzz-not-there');
  assert.equal(state.matches.length, 0);
  viewer.destroy();
});

test('VIEWER: honest error states - damaged files vs password-protected files', async () => {
  const state1 = { status: 'idle', numPages: 0, page: 1, zoom: 1, query: '', matches: [], matchIndex: -1, error: null };
  const v1 = createPdfViewer({ pdfjs: fakePdfjs({ failWith: new Error('Invalid PDF structure') }), container: null, state: state1 });
  await v1.load(new Uint8Array([1, 2]));
  assert.equal(state1.status, 'error');
  assert.match(state1.error, /damaged|not a PDF/i);
  v1.destroy();

  const state2 = { status: 'idle', numPages: 0, page: 1, zoom: 1, query: '', matches: [], matchIndex: -1, error: null };
  const passErr = new Error('password required');
  passErr.name = 'PasswordException';
  const v2 = createPdfViewer({ pdfjs: fakePdfjs({ failWith: passErr }), container: null, state: state2 });
  await v2.load(new Uint8Array([1, 2]));
  assert.equal(state2.status, 'password');
  assert.match(state2.error, /password-protected/i);
  v2.destroy();
});

test('TAB INTEGRATION: a document opens in its OWN tab - never the web frame or native engine path', async () => {
  const { shell, container } = await bootShell();
  try {
    shell._docEngineOverride = fakePdfjs({ pages: 2 });
    const doc = shell.addDocumentTab({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]) });
    assert.ok(doc, 'document registered');
    const tab = shell.getActiveTab();
    assert.equal(tab.isDocument, true);
    assert.equal(tab.docId, doc.id);
    assert.ok(tab.url.startsWith('yayra://doc/'), 'document tabs use the internal doc scheme');
    assert.equal(tab.title, 'report.pdf');

    const viewport = shell.viewportElement;
    assert.ok(viewport.querySelector('.fb-doc-viewer'), 'the integrated viewer renders');
    assert.ok(viewport.querySelector('.fb-doc-toolbar'), 'with its toolbar');
    assert.equal(viewport.querySelector('.fb-doc-notes-color-input'), null,
      'the speaker-notes colour picker never leaks into non-PPTX viewers');
    assert.equal(viewport.querySelector('iframe'), null, 'no web iframe is created for a document');
    assert.equal(viewport.querySelector('.fb-native-webview-slot'), null, 'the native engine is never attached');
    // The engine promise resolves async; give it a tick then check the ready state.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(['loading', 'ready'].includes(tab.docState.status), 'the viewer state is tracked on the tab');
  } finally {
    shell.destroy();
  }
});

test('TAB INTEGRATION: a shell re-render during PDF loading keeps the new viewer mount attached', async () => {
  const { shell, container } = await bootShell();
  let finishLoad;
  let getDocumentCalls = 0;
  const delayedPdf = {
    getDocument: () => {
      getDocumentCalls += 1;
      return { promise: new Promise((resolve) => { finishLoad = resolve; }) };
    }
  };
  try {
    shell._docEngineOverride = delayedPdf;
    shell.addDocumentTab({ name: 'slow-report.pdf', bytes: new Uint8Array([1, 2, 3]) });
    const tab = shell.getActiveTab();
    assert.equal(typeof finishLoad, 'function', 'PDF load started');

    // A normal browser-shell render (resize, tab state change, etc.) replaces
    // the DOM while the worker is still parsing the PDF.
    shell.render(container);
    finishLoad({
      numPages: 1,
      getPage: async () => ({
        rotate: 0,
        getViewport: ({ scale = 1 } = {}) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: async () => ({ items: [] })
      }),
      getOutline: async () => [],
      destroy: () => {}
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(tab.docState.status, 'ready', 'the parsed document is ready');
    assert.equal(getDocumentCalls, 1, 're-rendering reuses the in-flight PDF parse instead of starting a second worker');
    const liveViewer = container.querySelector('.fb-doc-viewer');
    assert.ok(liveViewer, 'the active tab has a viewer mount');
    assert.equal(liveViewer.querySelector('.fb-doc-status').style.display, 'none',
      'the latest mount receives the completed load state instead of staying on Opening document');
  } finally {
    shell.destroy();
  }
});

test('TAB INTEGRATION: PDF.js startup failures are shown with a working retry, never a permanent spinner', async () => {
  const { shell, container } = await bootShell();
  let attempts = 0;
  try {
    shell._pdfjsModule = async () => {
      attempts += 1;
      throw new Error('worker bundle unavailable');
    };
    shell.addDocumentTab({ name: 'retry-report.pdf', bytes: new Uint8Array([1, 2, 3]) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tab = shell.getActiveTab();
    const status = container.querySelector('.fb-doc-status');
    const retry = container.querySelector('.fb-doc-retry-btn');
    assert.equal(tab.docState.status, 'error');
    assert.match(status.textContent, /could not start the PDF reader/i);
    assert.equal(retry.style.display, 'inline-flex');

    // The toolbar and focused viewer exist before (and after a failed)
    // asynchronous engine startup, while the controller is still null. Every
    // action must no-op rather than throwing `handleKeydown`/method errors.
    const viewerSurface = container.querySelector('.fb-doc-viewer');
    assert.doesNotThrow(() => viewerSurface.dispatchEvent({
      type: 'keydown',
      key: 'ArrowRight',
      preventDefault() {}
    }));
    for (const button of viewerSurface.querySelector('.fb-doc-toolbar2').querySelectorAll('.fb-doc-btn')) {
      assert.doesNotThrow(() => button.click(), `${button.title || button.textContent} is safe while the engine is unavailable`);
    }

    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attempts, 2, 'Retry starts a fresh module load attempt');
    assert.equal(tab.docState.status, 'error', 'a repeated failure remains visible and actionable');
  } finally {
    shell.destroy();
  }
});

test('TAB INTEGRATION: navigating from a PDF updates the tab title, Back restores it, and closing releases bytes', async () => {
  const { shell } = await bootShell();
  try {
    shell._docEngineOverride = fakePdfjs();
    const doc = shell.addDocumentTab({ name: 'navigation.pdf', bytes: new Uint8Array([9]) });
    const tab = shell.getActiveTab();
    assert.equal(shell.getTabTitle(tab), 'navigation.pdf');

    shell.navigateActiveTab('https://example.com/report');
    assert.equal(shell.getTabTitle(tab), 'example.com', 'the PDF filename does not stick on the website tab');
    assert.equal(shell.documentStore.get(doc.id)?.name, 'navigation.pdf', 'document bytes remain for Back navigation');

    assert.equal(shell.goBack(), true);
    assert.equal(tab.url, `yayra://doc/${doc.id}`);
    assert.equal(shell.getTabTitle(tab), 'navigation.pdf', 'Back restores the local document title');
    shell.closeTab(tab.id);
    assert.equal(shell.documentStore.get(doc.id), null, 'closing the tab releases the in-memory document');
  } finally {
    shell.destroy();
  }
});

test('TAB INTEGRATION: the Close button closes the document tab and returns to browsing', async () => {
  const { shell, container } = await bootShell();
  try {
    shell._docEngineOverride = fakePdfjs();
    const before = shell.state.tabs.length;
    const doc = shell.addDocumentTab({ name: 'close-me.pdf', bytes: new Uint8Array([9]) });
    assert.equal(shell.state.tabs.length, before + 1);
    const closeBtn = shell.viewportElement.querySelector('.fb-doc-close-btn');
    assert.ok(closeBtn, 'the dedicated close control exists');
    closeBtn.click();
    assert.equal(shell.state.tabs.length, before, 'document tab closed');
    assert.equal(shell.state.tabs.every((t) => !t.isDocument), true);
    assert.equal(shell.documentStore.get(doc.id), null, 'closing the last tab releases the PDF bytes from memory');
    assert.equal(shell.state.closedTabsHistory.some((tab) => tab.url === `yayra://doc/${doc.id}`), false,
      'a byte-less PDF tab is never offered as a broken Ctrl+Shift+T restore');
  } finally {
    shell.destroy();
  }
});

test('SESSION: document tabs are NEVER written to the last-session snapshot (bytes are in-memory)', async () => {
  const { shell } = await bootShell();
  try {
    const saved = [];
    shell.sessionRepo = { saveSession: async (tabs) => { saved.push(tabs); } };
    shell._lastSessionSnapshotJson = null;
    shell._docEngineOverride = fakePdfjs();
    shell.addDocumentTab({ name: 'secret.pdf', bytes: new Uint8Array([1]) });
    shell.state.tabs[0].url = 'https://example.com/live'; // plus one real page
    shell.queueSessionSnapshot();
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(saved.length >= 1, 'a snapshot was queued');
    for (const tabs of saved) {
      assert.equal(tabs.some((t) => String(t.url).startsWith('yayra://doc/')), false, 'no document tabs persisted');
      assert.ok(tabs.some((t) => t.url === 'https://example.com/live'), 'browsing tabs still persist');
    }
  } finally {
    shell.destroy();
  }
});

test('DRAWER ENTRY: "Open document" is offered in the menu on every platform', async () => {
  const { shell, container } = await bootShell();
  try {
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    const item = container.querySelector('.fb-dr-open-doc');
    assert.ok(item, 'the drawer item exists');
    assert.match(item.textContent, /Open document/);
    shell.state.isSideDrawerOpen = false;
  } finally {
    shell.destroy();
  }
});

test('SECURITY (source pin): the Electron document IPC returns BYTES ONLY - never a file path', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /const MAX_DOCUMENT_BYTES = 300 \* 1024 \* 1024;/, 'Electron pins the same 300 MB limit before reading');
  const start = src.indexOf("ipcMain.handle('yayra:doc-open'");
  assert.ok(start > -1, 'the doc-open handler exists');
  const block = src.slice(start, src.indexOf("'read-failed'", start) + 40);
  assert.match(block, /showOpenDialog/, 'the native picker is used');
  for (const extension of ['pdf', 'pptx', 'docx', 'xlsx', 'csv', 'png', 'txt']) {
    assert.match(block, new RegExp(`['"]${extension}['"]`), `${extension} is offered by the document picker`);
  }
  assert.match(block, /stat\.size > MAX_DOCUMENT_BYTES/, 'the shared 300 MB size cap is checked before readFile');
  // The response object carries exactly { ok, canceled?, reason?, name, size, data }.
  const returns = [...block.matchAll(/return \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(returns.every((r) => !/:\s*filePath/.test(r)), 'no return value exposes the filesystem path');
  const preloadSrc = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preloadSrc, /documents:\s*\{\s*openFile:/, 'the preload exposes the format-neutral picker');
  assert.match(preloadSrc, /openPdf:/, 'the backward-compatible PDF alias remains available');
  assert.match(preloadSrc, /saveCopy:[\s\S]{0,180}yayra:doc-save-copy/,
    'the visible Download button uses a dedicated native save bridge');
  const saveAt = src.indexOf("ipcMain.handle('yayra:doc-save-copy'");
  const saveBlock = src.slice(saveAt, saveAt + 1800);
  assert.ok(saveAt > -1, 'the unchanged-original save handler exists');
  assert.match(saveBlock, /bytes\.length > MAX_DOCUMENT_BYTES/, 'save IPC enforces the document size boundary');
  assert.match(saveBlock, /showSaveDialog/, 'desktop Download uses the user-selected Save destination');
  assert.doesNotMatch(saveBlock, /convert|encode|render/i, 'saving never transforms the source bytes');
});

test('NO REGRESSION (source pin): document tabs cannot reach the web-frame path, and the session filter stays https-only', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const fnStart = src.indexOf('renderViewportContent(viewport, activeTab) {');
  const fnEnd = src.indexOf('\n  /* -------------------------------------------------------------\n   * EXTERNAL WEB CONTENT FRAME HELPER', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'the viewport router is bounded in source');
  const fn = src.slice(fnStart, fnEnd);
  const docAt = fn.indexOf("if (url.startsWith('yayra://doc/')");
  const renderDocAt = fn.indexOf('this.renderDocumentViewer(viewport, activeTab)', docAt);
  const nativeFrameAt = fn.indexOf('this.createWebContentFrame(activeTab.url', docAt);
  assert.ok(docAt > -1, 'document routing exists');
  assert.ok(renderDocAt > docAt, 'the document branch renders the viewer');
  assert.ok(nativeFrameAt > renderDocAt, 'web-frame creation is only the later else branch');
  assert.match(fn.slice(docAt, nativeFrameAt), /if \(url\.startsWith\('yayra:\/\/doc\/'\)\)\s*\{\s*this\.renderDocumentViewer\(viewport, activeTab\);\s*\}\s*else if/, 'document routing is exclusive and cannot fall through to a web frame');
  // Session snapshots remain https-only (document tabs auto-excluded).
  const snap = src.indexOf('queueSessionSnapshot() {');
  const snapBlock = src.slice(snap, snap + 700);
  assert.match(snapBlock, /\^https\?:/, 'session persistence keeps filtering to real web pages');
});

/* ---------------- helpers ---------------- */

async function bootShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

function makeMemoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] || null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); }
  };
}

function fakePptxEngine({ slides = 1 } = {}) {
  return {
    openPptxDeck: async () => ({
      slideCount: slides,
      slideWidth: 1280,
      slideHeight: 720,
      getSlide: async (page = 1) => ({
        slideNumber: page,
        title: `Colour notes fixture ${page}`,
        text: `Colour notes fixture ${page}`,
        notes: 'This note changes colour immediately.',
        background: '#ffffff',
        shapes: []
      }),
      ensureSlideMedia: async () => {},
      textIndex: async () => [{ slide: 1, text: 'Colour notes fixture This note changes colour immediately.' }],
      dispose() {}
    })
  };
}

test('DOCUMENT ACTIONS: PDF, PowerPoint, Word, and PNG viewers expose visible Download and Print buttons', async () => {
  const { shell, container } = await bootShell();
  shell._docEngineOverride = fakePdfjs({ pages: 1 });
  shell._documentEngineOverrides = {
    pptx: fakePptxEngine(),
    docx: { renderAsync: async () => {} }
  };
  try {
    for (const [name, bytes] of [
      ['report.pdf', new Uint8Array([1])],
      ['slides.pptx', new Uint8Array([2])],
      ['letter.docx', new Uint8Array([3])],
      ['photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
    ]) {
      shell.addDocumentTab({ name, bytes });
      const primary = shell.viewportElement.querySelector('.fb-doc-toolbar-primary');
      assert.ok(primary?.querySelector('.fb-doc-download-btn'), `${name} has a visible Download action`);
      assert.ok(primary?.querySelector('.fb-doc-btn-print'), `${name} has a visible Print action`);
    }
    assert.ok(container.querySelector('.fb-doc-viewer'), 'each file remains in Yayra’s integrated viewer');
  } finally {
    shell.destroy();
  }
});

test('DOCUMENT DOWNLOAD: the visible action saves unchanged bytes through the native bridge', async () => {
  const previousYayra = globalThis.window.yayra;
  const saves = [];
  globalThis.window.yayra = {
    system: {
      documents: {
        saveCopy: async (payload) => { saves.push(payload); return { ok: true, name: payload.name }; }
      }
    }
  };
  const { shell } = await bootShell();
  try {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    shell.addDocumentTab({ name: 'unchanged.png', bytes });
    shell.viewportElement.querySelector('.fb-doc-download-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, 'unchanged.png');
    assert.deepEqual(Array.from(saves[0].data), Array.from(bytes), 'Download receives the exact original byte sequence');
    await shell.savePageAs();
    assert.equal(saves.length, 2, 'Ctrl+S / Save routes document tabs through the same unchanged download path');
  } finally {
    shell.destroy();
    if (previousYayra === undefined) delete globalThis.window.yayra;
    else globalThis.window.yayra = previousYayra;
  }
});

test('PPTX PRINT: every slide is materialised temporarily and normal single-slide viewing is restored', async () => {
  const host = document.createElement('div');
  const state = createDocumentViewerState('pptx');
  const viewer = createPptxViewer({
    container: host,
    state,
    fileName: 'print-all.pptx',
    moduleLoader: async () => fakePptxEngine({ slides: 3 })
  });
  try {
    await viewer.load(new Uint8Array([1, 2, 3]));
    const preparing = viewer.preparePrint();
    assert.equal(viewer.preparePrint(), preparing, 'repeated Print requests share one preparation job');
    assert.equal(await preparing, true);
    assert.equal(host.querySelectorAll('.fb-pptx-print-slide').length, 3,
      'printing includes every slide rather than only the selected one');
    const printFrame = host.querySelector('.fb-pptx-print-slide')?.querySelector('.fb-pptx-stage-frame');
    assert.match(printFrame?.style?.cssText || '',
      /width:960px;height:540px/,
      'standard widescreen slides are scaled into a Letter/A4-safe landscape frame');
    assert.ok(host.querySelector('.fb-pptx-reader').classList.contains('fb-pptx-print-current-hidden'));
    viewer.finishPrint();
    assert.equal(host.querySelector('.fb-pptx-print-deck'), null, 'temporary print DOM is released');
    assert.equal(host.querySelector('.fb-pptx-reader').classList.contains('fb-pptx-print-current-hidden'), false);
  } finally {
    viewer.destroy();
  }
});

test('DOCUMENT PRINT: duplicate requests coalesce and a tab switch cancels the stale print snapshot', async () => {
  let resolvePreparation;
  let prepareCalls = 0;
  let finishCalls = 0;
  let printCalls = 0;
  const preparation = new Promise((resolve) => { resolvePreparation = resolve; });
  const tab = { id: 'doc-print-tab', isDocument: true, docState: { status: 'ready', viewer: 'pptx' } };
  const session = {
    disposed: false,
    viewer: {
      preparePrint: async () => { prepareCalls += 1; return preparation; },
      finishPrint: async () => { finishCalls += 1; }
    }
  };
  let activeTab = tab;
  const notices = [];
  const shell = {
    _activeDocViewer: { tabId: tab.id, ...session },
    _documentViewerSessions: new Map(),
    _documentPrintInFlight: null,
    getActiveTab: () => activeTab,
    showTransientNotice: (message) => notices.push(message)
  };
  shell._documentViewerSessions.set(tab.id, shell._activeDocViewer);
  const previousPrint = globalThis.window.print;
  globalThis.window.print = () => { printCalls += 1; };
  try {
    const first = BrowserShell.prototype.printActivePage.call(shell);
    await Promise.resolve();
    await BrowserShell.prototype.printActivePage.call(shell);
    assert.equal(prepareCalls, 1, 'a second shortcut/button cannot start a competing full-deck build');
    assert.ok(notices.some((message) => /already preparing/.test(message)));
    activeTab = { id: 'different-tab', url: 'https://example.com' };
    resolvePreparation(true);
    await first;
    assert.equal(printCalls, 0, 'detached document DOM is never sent to a blank/stale print dialog');
    assert.equal(finishCalls, 1, 'temporary print state is still cleaned up');
    assert.equal(shell._documentPrintInFlight, null, 'the print lock is released on cancellation');
  } finally {
    globalThis.window.print = previousPrint;
  }
});

test('PPTX NOTES COLOUR: native wheel stays live beside the accessible presentation overflow and persists by profile', async () => {
  const priorStorage = globalThis.localStorage;
  const storage = makeMemoryStorage();
  globalThis.localStorage = storage;
  let firstShell = null;
  let secondShell = null;
  try {
    const firstContainer = document.createElement('div');
    firstShell = new BrowserShell({ container: firstContainer, platform: 'linux', isMobile: false });
    firstShell._documentEngineOverrides = { pptx: fakePptxEngine() };
    await firstShell.initialize();
    firstShell.render(firstContainer);
    firstShell.addDocumentTab({ name: 'lecture.pptx', bytes: new Uint8Array([1, 2, 3]) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const primary = firstShell.viewportElement.querySelector('.fb-doc-toolbar');
    const picker = primary.querySelector('.fb-doc-notes-color-input');
    const control = primary.querySelector('.fb-doc-notes-color-control');
    const overflow = primary.querySelector('.fb-doc-overflow-btn');
    const overflowMenu = primary.querySelector('.fb-doc-overflow-menu');
    const download = primary.querySelector('.fb-doc-download-btn');
    const print = primary.querySelector('.fb-doc-btn-print');
    const presentFirst = primary.querySelector('.fb-doc-btn-present-first');
    const presentCurrent = firstShell.viewportElement.querySelector('.fb-doc-btn-present-current');
    assert.ok(picker && control && overflow && overflowMenu && download && print && presentFirst && presentCurrent,
      'PPTX exposes notes, Download, Print, first-slide and current-slide presentation actions');
    assert.equal(primary.querySelector('.fb-doc-original-btn'), null,
      'Desktop app is no longer exposed as a direct PPTX toolbar control');
    assert.equal(primary.querySelector('.fb-doc-close-btn'), null,
      'Close is no longer exposed as a direct PPTX toolbar control');
    assert.equal(overflow.getAttribute('aria-haspopup'), 'menu');
    assert.equal(overflow.getAttribute('aria-expanded'), 'false');
    assert.equal(picker.type, 'color', 'the browser/OS-native colour input is used');
    assert.equal(picker.getAttribute('aria-label'), 'Speaker notes text colour');
    assert.match(control.title, /Speaker notes text colour: #000000/, 'the control exposes its colour in a tooltip');
    assert.equal(picker.getAttribute('tabindex'), null, 'native keyboard focus is not suppressed');
    assert.equal(picker.value, '#000000');
    assert.equal(primary.children.indexOf(control) + 1, primary.children.indexOf(download),
      'the colour wheel stays immediately beside the now-visible Download button');
    assert.match(presentFirst.getAttribute('aria-label'), /slide 1 \(F5\)/,
      'the top Present action always starts from the beginning');
    assert.match(presentCurrent.textContent, /From current slide/,
      'the lower controls expose an immediate selected-slide start action');
    assert.match(presentCurrent.getAttribute('aria-label'), /selected slide \(Shift\+F5\)/);
    overflow.click();
    assert.equal(overflow.getAttribute('aria-expanded'), 'true', 'the overflow reports its open state');
    assert.equal(overflowMenu.hidden, false, 'the menu opens from the keyboard-accessible button');
    assert.doesNotMatch(overflowMenu.textContent, /Present from beginning/,
      'presentation start is no longer buried or duplicated in the overflow');
    assert.match(overflowMenu.textContent, /Close presentation/);
    for (const action of overflowMenu.querySelectorAll('.fb-doc-overflow-item')) {
      assert.equal(action.getAttribute('title'), null,
        'menu explanations use accessible labels, not native tooltip bubbles that cover adjacent actions');
      assert.match(action.getAttribute('aria-label') || '', /\./,
        'each action keeps its longer accessible explanation');
      assert.match(action.style.cssText, /color:(?:#f8fafc|#fca5a5)/,
        'dark overflow actions carry an explicit high-contrast foreground');
    }
    assert.ok(primary.classList.contains('fb-doc-toolbar-primary'), 'the identity row uses compact toolbar geometry');
    assert.equal(control.hidden, false, 'the picker starts visible with speaker notes');

    picker.value = '#ff0000';
    picker.dispatchEvent({ type: 'input', target: picker });
    assert.equal(firstShell.getActiveTab().docState.notesColor, '#ff0000');
    assert.equal(control.dataset.notesColor, '#ff0000', 'the visible swatch tracks the chosen colour');
    assert.equal(firstShell.viewportElement.querySelector('.fb-pptx-notes-body').style.color, '#ff0000',
      'the mounted notes update without a viewer remount');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = JSON.parse(storage.getItem('yayra:p:default:settings'));
    assert.equal(saved.pptxNotesColor, '#ff0000', 'the preference is scoped to the active profile');

    firstShell.viewportElement.querySelector('.fb-doc-btn-notes').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(control.hidden, true, 'hiding notes hides the colour control in sync');
    assert.equal(control.style.display, 'none');

    const otherProfile = firstShell.profileService.createProfile({ name: 'Separate notes profile' });
    firstShell.profileService.switchTo(otherProfile.id);
    await firstShell.reloadProfileScopedState();
    assert.equal(firstShell.state.settings.pptxNotesColor, '#000000',
      'a new profile does not inherit another profile’s notes colour');
    firstShell.profileService.switchTo('default');
    await firstShell.reloadProfileScopedState();
    assert.equal(firstShell.state.settings.pptxNotesColor, '#ff0000',
      'switching back restores the original profile preference');

    firstShell.destroy();
    firstShell = null;
    const secondContainer = document.createElement('div');
    secondShell = new BrowserShell({ container: secondContainer, platform: 'linux', isMobile: true });
    secondShell._documentEngineOverrides = { pptx: fakePptxEngine() };
    await secondShell.initialize();
    secondShell.render(secondContainer);
    secondShell.addDocumentTab({ name: 'remounted.pptx', bytes: new Uint8Array([4, 5, 6]) });
    const remountedPicker = secondShell.viewportElement.querySelector('.fb-doc-notes-color-input');
    assert.equal(remountedPicker.value, '#ff0000', 'a fresh mobile/remounted viewer restores the profile colour');
    assert.equal(secondShell.getActiveTab().docState.notesColor, '#ff0000');
  } finally {
    firstShell?.destroy();
    secondShell?.destroy();
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  }
});

test('PPTX SLIDESHOW: dedicated projector surface mounts the live deck, hides notes, and restores it on exit', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  shell._documentEngineOverrides = { pptx: fakePptxEngine() };
  try {
    await shell.initialize();
    shell.render(container);
    shell.addDocumentTab({ name: 'projector.pptx', bytes: new Uint8Array([1, 2, 3]) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tab = shell.getActiveTab();
    assert.equal(tab.docState.showNotes, true, 'ordinary viewer starts with notes visible');

    const started = await shell.startPptxSlideshow(tab.id, { fromBeginning: true });
    assert.equal(started, true);
    assert.ok(shell._pptxSlideshow?.active);
    assert.ok(document.getElementById('yayra-pptx-slideshow'));
    assert.equal(tab.docState.slideshowMode, true);
    assert.equal(tab.docState.showNotes, false, 'projector starts with a clean slide');
    assert.ok(shell._pptxSlideshow.host.querySelector('.fb-pptx-reader'), 'the existing PPTX deck is moved into the projector host');

    shell._pptxSlideshow.setBlank('black');
    assert.equal(shell._pptxSlideshow.blank.hidden, false);
    shell._pptxSlideshow.setPointerMode('laser');
    assert.equal(shell._pptxSlideshow.pointerMode, 'laser');
    shell._pptxSlideshow.toggleHelp(true);
    assert.equal(shell._pptxSlideshow.help.hidden, false);
    let helpEscapePrevented = false;
    shell._pptxSlideshow.handleKeyDown({
      key: 'Escape', target: { tagName: 'DIV' },
      preventDefault() { helpEscapePrevented = true; }, stopImmediatePropagation() {}
    });
    assert.equal(helpEscapePrevented, true);
    assert.equal(shell._pptxSlideshow.help.hidden, true, 'first Escape closes shortcut help without ending the show');
    assert.equal(shell._pptxSlideshow.active, true);

    assert.equal(await shell.exitPptxSlideshow(), true);
    assert.equal(shell._pptxSlideshow, null);
    assert.equal(document.getElementById('yayra-pptx-slideshow'), null);
    assert.equal(tab.docState.slideshowMode, false);
    assert.equal(tab.docState.showNotes, true, 'normal-view notes choice is restored');
    assert.ok(shell.viewportElement.querySelector('.fb-doc-host-pptx .fb-pptx-reader')
      || shell.viewportElement.querySelector('.fb-pptx-reader'), 'the live deck returns to the normal viewer');
  } finally {
    shell.destroy();
  }
});

test('PDF SLIDESHOW: live PDF pages use the projector, show one fitted page, and restore continuous reading', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  shell._docEngineOverride = fakePdfjs({ pages: 3 });
  try {
    await shell.initialize();
    shell.render(container);
    shell.addDocumentTab({ name: 'briefing.pdf', bytes: new Uint8Array([1, 2, 3]) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tab = shell.getActiveTab();
    const session = shell._documentViewerSessions.get(tab.id);
    await session.viewer.setPage(2);
    await session.viewer.setZoom(1.5);
    assert.match(shell.viewportElement.querySelector('.fb-doc-btn-present-current')?.textContent || '', /From current page/,
      'PDF toolbar offers an explicit current-page presentation action');

    let prevented = false;
    shell.handleGlobalKeyDown({
      key: 'F5', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() { prevented = true; }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(prevented, true, 'Shift+F5 belongs to the PDF presentation instead of hard reload');
    assert.equal(await shell.startPdfSlideshow(tab.id), true, 'the compatibility PDF entry point focuses the active show');
    assert.equal(document.getElementById('yayra-pdf-slideshow'), shell._documentSlideshow.overlay);
    assert.equal(shell._pptxSlideshow, shell._documentSlideshow, 'the previous private field remains a compatibility alias');
    assert.ok(shell._documentSlideshow.overlay.classList.contains('is-pdf'));
    assert.equal(tab.docState.slideshowMode, true);
    assert.equal(tab.docState.page, 2, 'present-current keeps the selected PDF page');
    assert.ok(shell._pptxSlideshow.host.querySelector('.fb-pdf-continuous-pages'),
      'the live selectable PDF.js document moves into the projector host');
    assert.equal(shell._pptxSlideshow.controls.querySelector('.fb-pptx-slideshow-notes'), null,
      'PDF presentation does not invent speaker notes');
    assert.match(shell._pptxSlideshow.navigator.textContent, /All pages/);
    const projectedPages = shell._pptxSlideshow.host.querySelectorAll('.fb-pdf-page');
    assert.equal(projectedPages.filter((page) => page.style.display !== 'none').length, 1,
      'projector mode hides every continuous-reader page except the current page');
    let disruptiveShortcutPrevented = false;
    shell._documentSlideshow.handleKeyDown({
      key: 'n', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false,
      target: { tagName: 'DIV' }, preventDefault() { disruptiveShortcutPrevented = true; }, stopImmediatePropagation() {}
    });
    assert.equal(disruptiveShortcutPrevented, true,
      'PDF mode suppresses the PowerPoint-only notes chord instead of opening a browser window');
    shell._documentSlideshow.handleKeyDown({
      key: 'ArrowRight', target: { tagName: 'BUTTON' },
      preventDefault() {}, stopImmediatePropagation() {}
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(tab.docState.page, 3, 'navigation still works after a projector control receives focus');
    shell._pptxSlideshow.setBlank('white');
    assert.equal(shell._pptxSlideshow.blank.hidden, false);
    shell._pptxSlideshow.setPointerMode('pen');
    assert.equal(shell._pptxSlideshow.pointerMode, 'pen');

    assert.equal(await shell.exitDocumentSlideshow(), true);
    assert.equal(document.getElementById('yayra-pdf-slideshow'), null);
    assert.equal(tab.docState.slideshowMode, false);
    assert.equal(tab.docState.page, 3, 'the presented page becomes the restored reading position');
    assert.equal(tab.docState.zoom, 1.5, 'the reader zoom is restored after presentation');
    assert.ok(shell.viewportElement.querySelector('.fb-doc-host-pdf .fb-pdf-continuous-pages')
      || shell.viewportElement.querySelector('.fb-pdf-continuous-pages'),
    'the same live PDF returns to continuous reading without reloading');
  } finally {
    shell.destroy();
  }
});

test('PPTX NOTES COLOUR: compact responsive styling keeps the native control keyboard-visible', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  assert.match(css, /\.fb-doc-notes-color-control\s*\{[\s\S]*?flex:\s*0 0 34px;[\s\S]*?height:\s*30px;/,
    'the wheel remains compact in the primary toolbar');
  assert.match(css, /\.fb-doc-notes-color-control:focus-within\s*\{[\s\S]*?outline:\s*2px solid/,
    'the transparent native input gets a visible keyboard focus ring');
  assert.match(css, /\.fb-doc-toolbar-primary\s*\{[\s\S]*?max-height:\s*36px;/,
    'the PowerPoint identity/header row cannot expand into a tall banner');
  assert.match(css, /\.fb-doc-toolbar2\s*\{[\s\S]*?max-height:\s*36px;[\s\S]*?flex-wrap:\s*nowrap !important;[\s\S]*?overflow-x:\s*auto;/,
    'the controls stay in one compact scrollable row instead of doubling the toolbar height');
  assert.match(css, /\.fb-doc-overflow-menu\s*\{[\s\S]*?color:\s*#f8fafc !important;/,
    'the dark overflow surface always has a readable foreground in every theme');
  const mobile = css.slice(css.indexOf('@media (max-width: 680px)'));
  assert.match(mobile, /\.fb-doc-toolbar2\s*\{[\s\S]*?overflow-x:\s*auto;/,
    'the narrow control row scrolls while the primary overflow menu remains unclipped');
  assert.match(mobile, /\.fb-pptx-notes\s*\{[\s\S]*?width:\s*100% !important;/,
    'the cream notes card fits mobile viewports');
});

test('PPTX NOTES COLOUR: malformed or unavailable storage safely falls back to black', async () => {
  const priorStorage = globalThis.localStorage;
  let shell = null;
  try {
    globalThis.localStorage = makeMemoryStorage({
      'yayra:p:default:settings': JSON.stringify({ pptxNotesColor: 'red; background:url(https://invalid.example)' })
    });
    const container = document.createElement('div');
    shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    shell._documentEngineOverrides = { pptx: fakePptxEngine() };
    await shell.initialize();
    shell.render(container);
    shell.addDocumentTab({ name: 'malformed.pptx', bytes: new Uint8Array([1]) });
    assert.equal(shell.viewportElement.querySelector('.fb-doc-notes-color-input').value, '#000000');
    shell.destroy();
    shell = null;

    globalThis.localStorage = {
      get length() { throw new Error('blocked'); },
      key() { throw new Error('blocked'); },
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); }
    };
    const blockedContainer = document.createElement('div');
    shell = new BrowserShell({ container: blockedContainer, platform: 'linux', isMobile: false });
    shell._documentEngineOverrides = { pptx: fakePptxEngine() };
    await shell.initialize();
    shell.render(blockedContainer);
    shell.addDocumentTab({ name: 'blocked-storage.pptx', bytes: new Uint8Array([2]) });
    const blockedPicker = shell.viewportElement.querySelector('.fb-doc-notes-color-input');
    assert.equal(blockedPicker.value, '#000000');
    blockedPicker.value = '#00ff00';
    assert.doesNotThrow(() => blockedPicker.dispatchEvent({ type: 'input', target: blockedPicker }));
    assert.equal(shell.getActiveTab().docState.notesColor, '#00ff00', 'in-memory live colour still works');
  } finally {
    shell?.destroy();
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  }
});

test('PDF OFFLINE: local document bytes and the vendored PDF.js engine do not require a network fetch', async () => {
  const { existsSync } = await import('node:fs');
  for (const asset of ['pdf.mjs', 'pdf.worker.mjs']) {
    assert.ok(existsSync(new URL(`../packages/shared-ui/src/vendor/pdfjs/${asset}`, import.meta.url)), `${asset} is bundled locally`);
  }
  const workspace = readFileSync(new URL('../packages/shared-ui/src/services/documentWorkspace.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  assert.match(workspace, /pdfjs\.getDocument\(\{ data \}\)/, 'PDF.js receives the selected file bytes directly');
  assert.match(shell, /_pdfjsLibPromise\s*=\s*import\('\.\.\/vendor\/pdfjs\/pdf\.mjs'\)/, 'the PDF engine is imported once from the local package and shared across tabs');
  assert.match(shell, /new URL\('\.\.\/vendor\/pdfjs\/pdf\.worker\.mjs'/, 'the worker is also a local bundled asset');
  assert.doesNotMatch(shell, /https?:\/\/(?:cdn\.)?mozilla\.github\.io\/pdf\.js/, 'the viewer never depends on a PDF.js CDN');
});

test('PDF DESKTOP BUNDLE: yayra:// serves lazy ESM with strict MIME and smoke-parses the packaged worker', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const smoke = readFileSync(new URL('../scripts/smoke-desktop.mjs', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../scripts/build-web.mjs', import.meta.url), 'utf8');
  const verifyPackaging = readFileSync(new URL('../scripts/verify-packaging.mjs', import.meta.url), 'utf8');
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(build, /cp\(path\.join\(root, 'packages', packageName\)/,
    'the web/desktop input recursively copies shared-ui and its vendored PDF assets');
  assert.ok(pkg.build.files.includes('dist/**/*'), 'Electron packages the complete built tree');
  assert.match(main, /lower\.endsWith\('\.js'\) \|\| lower\.endsWith\('\.mjs'\)/,
    'the custom protocol recognizes JavaScript modules on every host OS');
  assert.match(main, /headers\.set\('content-type', type\)/,
    'the custom protocol explicitly supplies the strict module MIME header');
  assert.match(main, /hasPdfEngine:\s*false/);
  assert.match(main, /output\.pdfPages = pdf\?\.numPages \|\| 0/,
    'desktop smoke opens a real local fixture through the PDF.js worker');
  assert.match(main, /writeSmokeReport\(smokeResult\)/,
    'the GUI executable returns machine-readable results without relying on stdout');
  assert.match(smoke, /report\.hasPdfEngine === true/);
  assert.match(smoke, /report\.pdfPages === 1/,
    'the runtime diagnostic detects a desktop package that cannot parse its PDF fixture');
  assert.match(smoke, /YAYRA_SMOKE_REPORT:\s*reportPath/,
    'packaged Linux and Windows apps receive a deterministic result channel');
  assert.match(smoke, /usePackagedRuntime \? \['--headless'\]/,
    'headless mode is supplied before Chromium initializes on display-less runners');
  assert.doesNotMatch(smoke, /disable.{0,12}sandbox|no.{0,3}sandbox/i,
    'the PDF smoke must keep Chromium sandboxing enabled');
  assert.match(smoke, /release\/linux-unpacked\/yayra/,
    'when a package exists, smoke uses the app.asar runtime rather than loose source files');
  assert.match(smoke, /release\/win-unpacked\/yayra\.exe/);
  assert.match(verifyPackaging, /release\/linux-unpacked\/resources\/app\.asar/);
  assert.match(verifyPackaging, /release\/win-unpacked\/resources\/app\.asar/);
  assert.match(verifyPackaging, /pdf\.worker\.mjs/,
    'packaged PDF engine and worker presence remain a deterministic release gate');
  for (const [name, workflow] of [['build-only', ci], ['release', release]]) {
    assert.match(workflow, /Diagnose packaged Linux shell and PDF\.js worker\s*\n\s*continue-on-error:\s*true/,
      `${name} Linux runtime smoke is diagnostic and cannot suppress verified artifacts`);
    assert.match(workflow, /Diagnose packaged Windows shell and PDF\.js worker\s*\n\s*continue-on-error:\s*true/,
      `${name} Windows runtime smoke is diagnostic and cannot suppress verified artifacts`);
    assert.match(workflow, /chmod 4755 release\/linux-unpacked\/chrome-sandbox/,
      `${name} CI keeps the Linux Chromium sandbox enabled for its unpacked diagnostic`);
  }
});

test('PDF PACKAGED SMOKE HARNESS: report files work when a packaged GUI process has no stdout', {
  skip: process.platform !== 'linux'
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'yayra-smoke-harness-'));
  const fakeRuntime = join(fixture, 'fake-packaged-electron.cjs');
  const argsLog = join(fixture, 'args.log');
  mkdirSync(join(fixture, 'dist'), { recursive: true });
  writeFileSync(join(fixture, 'dist/index.html'), '<title>yayra</title><main id="app"></main>');
  writeFileSync(fakeRuntime, `#!/usr/bin/env node
const fs = require('node:fs');
const fallback = process.env.YAYRA_FORCE_BAD_LOAD === '1';
const report = fallback
  ? { title: 'yayra', hasRoot: true, hasPdfEngine: false, pdfPages: 0, pdfError: null, fallbackUsed: true, loadError: { code: -6, description: 'forced smoke fallback' } }
  : { title: 'yayra', hasRoot: true, hasPdfEngine: true, pdfPages: 1, pdfError: null, fallbackUsed: false, loadError: null };
fs.appendFileSync(process.env.YAYRA_SMOKE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(process.env.YAYRA_SMOKE_REPORT, JSON.stringify(report));
`);
  chmodSync(fakeRuntime, 0o755);

  try {
    const smokeScript = fileURLToPath(new URL('../scripts/smoke-desktop.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [smokeScript], {
      cwd: fixture,
      env: {
        ...process.env,
        YAYRA_SMOKE_RUNTIME: fakeRuntime,
        YAYRA_SMOKE_ARGS_LOG: argsLog
      },
      encoding: 'utf8',
      timeout: 15_000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PDF\.js parsed one page/);
    const launches = readFileSync(argsLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(launches, [['--headless']],
      'the packaged runtime gets headless mode before Chromium initializes, without weakening its sandbox');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('PDF.js REAL ENGINE: a local PDF opens quickly and its text is searchable offline', async () => {
  const { shell } = await bootShell();
  try {
    const engine = await shell._pdfjsModule();
    assert.equal(Object.getPrototypeOf(engine), Object.prototype,
      'the browser receives an ordinary adapter, never an immutable ESM namespace prototype');
    assert.equal(Object.hasOwn(engine, 'getDocument'), true);
    const pdfjs = await import('../packages/shared-ui/src/vendor/pdfjs/pdf.mjs');
    // Node's PDF.js factory reads native filesystem paths; the app itself
    // uses same-origin fetch URLs in the browser/Electron renderer.
    const nodeEngine = Object.create(engine);
    nodeEngine.getDocument = (params = {}) => pdfjs.getDocument({
      standardFontDataUrl: fileURLToPath(new URL('../packages/shared-ui/src/vendor/pdfjs/standard_fonts/', import.meta.url)),
      cMapUrl: fileURLToPath(new URL('../packages/shared-ui/src/vendor/pdfjs/cmaps/', import.meta.url)),
      cMapPacked: true,
      ...params
    });
    const state = createDocumentViewerState();
    const viewer = createPdfViewer({ pdfjs: nodeEngine, container: null, state, loadTimeoutMs: 5000 });
    try {
      await viewer.load(makeTinyPdfBytes());
      assert.equal(state.status, 'ready');
      assert.equal(state.numPages, 1);
      await viewer.search('fast local');
      assert.equal(state.matches.length, 1);
      assert.match(state.matches[0].snippet, /Fast local PDF reader/);
    } finally {
      viewer.destroy();
    }
  } finally {
    shell.destroy();
  }
});

test('PDF FONTS: standard-14 font data and CJK cmaps are vendored and wired into every getDocument call', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const fontsDir = new URL('../packages/shared-ui/src/vendor/pdfjs/standard_fonts/', import.meta.url);
  const cmapsDir = new URL('../packages/shared-ui/src/vendor/pdfjs/cmaps/', import.meta.url);
  assert.ok(existsSync(fontsDir), 'standard_fonts vendored');
  const fonts = readdirSync(fontsDir);
  assert.ok(fonts.includes('FoxitSerif.pfb'), 'the Foxit standard-14 faces are present');
  assert.ok(fonts.includes('LiberationSans-Regular.ttf'), 'the Liberation fallback faces are present');
  assert.ok(fonts.length >= 14, `the standard font set is complete (${fonts.length})`);
  assert.ok(existsSync(cmapsDir), 'cmaps vendored');
  assert.ok(readdirSync(cmapsDir).length >= 100, 'CJK cmap tables present');

  // The shell wraps the vendored engine so text renders even in PDFs that
  // rely on non-embedded standard fonts (very common in the wild).
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  assert.match(src, /standardFontDataUrl: stdFontUrl/, 'standardFontDataUrl is passed');
  assert.match(src, /cMapUrl,/, 'cMapUrl is passed');
  assert.match(src, /cMapPacked: true/, 'cmaps are packed (bcmap)');
  assert.doesNotMatch(src, /Object\.create\(lib\)/,
    'Chromium cannot shadow exports through an immutable ESM namespace prototype');
  assert.match(src, /const wrapped = \{[\s\S]*\.\.\.lib,[\s\S]*getDocument:/,
    'the PDF.js adapter is an ordinary object with its own configured getDocument');
  // The wrapped module keeps the worker assignment and the engine surface.
  assert.match(src, /GlobalWorkerOptions\.workerSrc = new URL\('\.\.\/vendor\/pdfjs\/pdf\.worker\.mjs'/, 'worker still set on the real module');
}
);
