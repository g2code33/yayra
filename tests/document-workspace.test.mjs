import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import {
  classifyDocument,
  unsupportedDocumentKinds,
  DOCUMENT_ENGINES,
  DocumentStore,
  createPdfViewer
} from '../packages/shared-ui/src/services/documentWorkspace.js';

/**
 * DOCUMENT WORKSPACE - PHASE 1 (PDF): the spec's first milestone.
 * "Yayra gains a sound, tested foundation for integrated document
 *  viewing, beginning with local PDFs, while preserving the existing
 *  browser."
 *
 * Pinned here:
 *  - the capability registry is HONEST (no placeholder claims)
 *  - document tabs are real tabs (own tab, own title, doc icon) and NEVER
 *    touch the web frame / native engine path
 *  - the viewer: load, page navigation, zoom, search, error and password
 *    states - with the PDF engine injected (testable without a canvas)
 *  - security: the Electron IPC returns bytes only - never a file path
 *  - session restore excludes document tabs (bytes are in-memory only)
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

test('REGISTRY: PDF is the Phase 1 engine and its capabilities are HONEST', () => {
  assert.equal(classifyDocument('report.pdf'), 'pdf');
  assert.equal(classifyDocument('REPORT.PDF'), 'pdf');
  assert.equal(classifyDocument('file.tar.pdf'), 'pdf');
  // Roadmap formats are NOT pretend-supported.
  for (const ext of unsupportedDocumentKinds()) {
    assert.equal(classifyDocument(`doc.${ext}`), null, `${ext} is not claimable yet`);
  }
  assert.equal(classifyDocument('no-extension'), null);
  assert.equal(classifyDocument(''), null);

  const caps = DOCUMENT_ENGINES.pdf.capabilities;
  assert.equal(caps.view, true);
  assert.equal(caps.search, true);
  assert.equal(caps.zoom, true);
  assert.equal(caps.pageNavigation, true);
  // Explicitly NOT claimed in Phase 1 - no placeholder buttons.
  assert.equal(caps.annotate, false);
  assert.equal(caps.edit, false);
  assert.equal(caps.save, false);
  assert.equal(caps.export, false);
  assert.equal(caps.print, false);
});

test('STORE: in-memory, no paths, unique ids, empty files refused', () => {
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
    assert.equal(viewport.querySelector('iframe'), null, 'no web iframe is created for a document');
    assert.equal(viewport.querySelector('.fb-native-webview-slot'), null, 'the native engine is never attached');
    // The engine promise resolves async; give it a tick then check the ready state.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(['loading', 'ready'].includes(tab.docState.status), 'the viewer state is tracked on the tab');
  } finally {
    shell.destroy();
  }
});

test('TAB INTEGRATION: the Close button closes the document tab and returns to browsing', async () => {
  const { shell, container } = await bootShell();
  try {
    shell._docEngineOverride = fakePdfjs();
    const before = shell.state.tabs.length;
    shell.addDocumentTab({ name: 'close-me.pdf', bytes: new Uint8Array([9]) });
    assert.equal(shell.state.tabs.length, before + 1);
    const closeBtn = shell.viewportElement.querySelector('.fb-doc-btn');
    assert.ok(closeBtn, 'toolbar buttons exist');
    // The close control is the last toolbar button.
    const allBtns = shell.viewportElement.querySelectorAll('.fb-doc-btn');
    allBtns[allBtns.length - 1].click();
    assert.equal(shell.state.tabs.length, before, 'document tab closed');
    assert.equal(shell.state.tabs.every((t) => !t.isDocument), true);
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
  const start = src.indexOf("ipcMain.handle('yayra:doc-open'");
  assert.ok(start > -1, 'the doc-open handler exists');
  const block = src.slice(start, src.indexOf("'read-failed'", start) + 40);
  assert.match(block, /showOpenDialog/, 'the native picker is used');
  assert.match(block, /extensions: \['pdf'\]/, 'only PDFs are offered');
  assert.match(block, /150 \* 1024 \* 1024/, 'a size cap exists');
  // The response object carries exactly { ok, canceled?, reason?, name, size, data }.
  const returns = [...block.matchAll(/return \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(returns.every((r) => !/:\s*filePath/.test(r)), 'no return value exposes the filesystem path');
  const preloadSrc = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preloadSrc, /documents:\s*\{\s*openPdf/, 'the preload exposes only openPdf');
});

test('NO REGRESSION (source pin): document tabs cannot reach the web-frame path, and the session filter stays https-only', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const fnStart = src.indexOf('renderViewportContent(viewport, activeTab) {');
  const fn = src.slice(fnStart, fnStart + 2200);
  const docAt = fn.indexOf("url.startsWith('yayra://doc/')");
  assert.ok(docAt > -1, 'document routing exists');
  assert.ok(fn.indexOf('renderDocumentViewer') > docAt, 'the doc branch renders the viewer');
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
  // The wrapped module keeps the worker assignment and the engine surface.
  assert.match(src, /GlobalWorkerOptions\.workerSrc = new URL\('\.\.\/vendor\/pdfjs\/pdf\.worker\.mjs'/, 'worker still set on the real module');
}
);
