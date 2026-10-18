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
  createDocumentViewerState
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
  assert.throws(() => store.add({ name: 'too-large.pdf', bytes: { byteLength: MAX_DOCUMENT_BYTES + 1 } }), /document-too-large/,
    'the document store enforces the same 150 MB ceiling for every open path');
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
    'the smoke gate fails a desktop package that cannot parse its PDF fixture');
  assert.match(smoke, /YAYRA_SMOKE_REPORT:\s*reportPath/,
    'packaged Linux and Windows apps receive a deterministic result channel');
  assert.match(smoke, /usePackagedRuntime \? \['--headless'\]/,
    'headless mode is supplied before Chromium initializes on display-less runners');
  assert.doesNotMatch(smoke, /disable.{0,12}sandbox|no.{0,3}sandbox/i,
    'the PDF smoke must keep Chromium sandboxing enabled');
  assert.match(smoke, /release\/linux-unpacked\/yayra/,
    'when a package exists, smoke uses the app.asar runtime rather than loose source files');
  assert.match(smoke, /release\/win-unpacked\/yayra\.exe/);
  assert.match(ci, /Smoke packaged Linux shell and PDF\.js worker/);
  assert.match(ci, /chmod 4755 release\/linux-unpacked\/chrome-sandbox/,
    'build-only CI keeps the Linux Chromium sandbox enabled for its unpacked smoke runtime');
  assert.match(ci, /Smoke packaged Windows shell and PDF\.js worker/);
  assert.match(release, /Smoke packaged Linux shell and PDF\.js worker/);
  assert.match(release, /chmod 4755 release\/linux-unpacked\/chrome-sandbox/,
    'release CI keeps the Linux Chromium sandbox enabled for its unpacked smoke runtime');
  assert.match(release, /Smoke packaged Windows shell and PDF\.js worker/,
    'build and release workflows enforce the packaged PDF parse on both desktop targets');
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
  // The wrapped module keeps the worker assignment and the engine surface.
  assert.match(src, /GlobalWorkerOptions\.workerSrc = new URL\('\.\.\/vendor\/pdfjs\/pdf\.worker\.mjs'/, 'worker still set on the real module');
}
);
