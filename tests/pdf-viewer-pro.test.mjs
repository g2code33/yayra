import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import {
  createPdfViewer,
  createDocumentViewerState,
  DOCUMENT_ENGINES
} from '../packages/shared-ui/src/services/documentWorkspace.js';

/**
 * PDF VIEWER PRO (user request: "enhance the pdf view and also add more
 * features - make users prefer it better than other pdf viewers"):
 * rotation, night reading mode, document outline (TOC), fit-to-width /
 * fit-to-page, direct page jumps, a match list for search, and full
 * keyboard control - on top of the existing zoom/search/fonts viewer.
 */

/** Fake engine: pages with rotation, text, and a nested outline. */
function fakePdfjs({ pages = 4 } = {}) {
  const texts = [
    'Quarterly report introduction.',
    'Revenue grew by forty percent.',
    'Costs stayed flat this quarter.',
    'Thanks for reading the report.'
  ];
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages,
        rotate: 0,
        getPage: async (n) => ({
          rotate: 0,
          getViewport: ({ scale = 1, rotation = 0 } = {}) => {
            const [w, h] = rotation === 90 || rotation === 270 ? [800, 600] : [600, 800];
            return { width: w * scale, height: h * scale };
          },
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: async () => ({ items: [{ str: texts[(n - 1) % texts.length] }] })
        }),
        getOutline: async () => ([
          { title: 'Introduction', dest: [{ num: 1 }] },
          {
            title: 'Results',
            dest: 'results-dest',
            items: [
              { title: 'Revenue', dest: [{ num: 2 }] },
              { title: 'Costs', dest: [{ num: 3 }] }
            ]
          }
        ]),
        getDestination: async (name) => (name === 'results-dest' ? [{ num: 2 }] : null),
        getPageIndex: async (ref) => (ref && typeof ref.num === 'number' ? ref.num - 1 : 0),
        destroy: () => {}
      })
    })
  };
}

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function bootViewer({ container = null } = {}) {
  const state = createDocumentViewerState();
  const viewer = createPdfViewer({ pdfjs: fakePdfjs(), container, state });
  return { viewer, state };
}

test('CAPABILITIES: the upgraded feature set is honestly declared', () => {
  const caps = DOCUMENT_ENGINES.pdf.capabilities;
  for (const cap of ['view', 'search', 'zoom', 'pageNavigation', 'rotate', 'nightMode', 'outline', 'thumbnails']) {
    assert.equal(caps[cap], true, `${cap} is supported`);
  }
  for (const cap of ['annotate', 'edit', 'save', 'export', 'print']) {
    assert.equal(caps[cap], false, `${cap} is still honestly NOT claimed`);
  }
});

test('ROTATE: 90-degree steps wrap at 360 and feed the real page rotation', async () => {
  const { viewer, state } = bootViewer();
  await viewer.load(new Uint8Array([1]));
  await viewer.rotate(90);
  assert.equal(state.rotation, 90);
  await viewer.rotate(90);
  await viewer.rotate(90);
  assert.equal(state.rotation, 270);
  await viewer.rotate(90);
  assert.equal(state.rotation, 0, 'wraps back to no rotation');
  await viewer.rotate(-90);
  assert.equal(state.rotation, 270, 'negative steps wrap too');
  viewer.destroy();
});

test('NIGHT MODE: toggles state (and the canvas filter is pinned in source)', async () => {
  const { viewer, state } = bootViewer();
  await viewer.load(new Uint8Array([1]));
  assert.equal(state.night, false);
  await viewer.setNight(true);
  assert.equal(state.night, true);
  await viewer.setNight(true); // idempotent
  assert.equal(state.night, true);
  await viewer.setNight(false);
  assert.equal(state.night, false);
  const src = readFileSync(new URL('../packages/shared-ui/src/services/documentWorkspace.js', import.meta.url), 'utf8');
  assert.match(src, /filter:invert\(1\) hue-rotate\(180deg\)/, 'the inverted reading filter is applied to the canvas');
  viewer.destroy();
});

test('OUTLINE: the PDF table of contents loads flattened, indented, with resolved pages', async () => {
  const { viewer, state } = bootViewer();
  await viewer.load(new Uint8Array([1]));
  const outline = await viewer.loadOutline();
  assert.deepEqual(
    outline.map((o) => [o.title, o.page, o.depth]),
    [
      ['Introduction', 1, 0],
      ['Results', 2, 0],
      ['Revenue', 2, 1],
      ['Costs', 3, 1]
    ],
    'titles, pages (including named destinations) and nesting depths'
  );
  assert.equal(state.outline.length, 4, 'state carries the outline for the sidebar');
  viewer.destroy();
});

test('OUTLINE: PDFs without an outline get an empty list (honest empty state)', async () => {
  const state = createDocumentViewerState();
  const engine = fakePdfjs();
  // Strip the outline API.
  const docPromise = engine.getDocument().promise;
  const viewer = createPdfViewer({ pdfjs: engine, container: null, state });
  await viewer.load(new Uint8Array([1]));
  const bare = createPdfViewer({
    pdfjs: {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: async () => ({ rotate: 0, getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve() }), getTextContent: async () => ({ items: [] }) }),
          destroy: () => {}
        })
      })
    },
    container: null,
    state
  });
  await bare.load(new Uint8Array([1]));
  assert.deepEqual(await bare.loadOutline(), [], 'no outline -> empty, no crash');
  viewer.destroy();
  bare.destroy();
});

test('FIT: fit-to-width and fit-to-page compute the zoom from the container', async () => {
  const container = { clientWidth: 832, clientHeight: 600, parentElement: { clientWidth: 832, clientHeight: 600 } };
  const { viewer, state } = bootViewer({ container });
  await viewer.load(new Uint8Array([1]));
  await viewer.fitToWidth();
  // (832 - 32 margin) / 600pt page width.
  assert.ok(Math.abs(state.zoom - 1.3333333333333333) < 1e-9, `fit-to-width -> ${state.zoom}`);
  await viewer.fitToPage();
  // min((832-32)/600, (600-32)/800) - the whole page fits.
  assert.ok(Math.abs(state.zoom - 0.71) < 1e-9, `fit-to-page -> ${state.zoom}`);
  viewer.destroy();
});

test('KEYBOARD: the full shortcut map drives the viewer', async () => {
  const { viewer, state } = bootViewer();
  await viewer.load(new Uint8Array([1]));
  const key = (k, extra = {}) => ({ key: k, preventDefault: () => {}, target: { tagName: 'DIV' }, ...extra });

  assert.equal(viewer.handleKeydown(key('ArrowRight')), 'page');
  assert.equal(state.page, 2);
  assert.equal(viewer.handleKeydown(key('ArrowLeft')), 'page');
  assert.equal(state.page, 1);
  assert.equal(viewer.handleKeydown(key('End')), 'page');
  assert.equal(state.page, 4, 'End jumps to the last page');
  assert.equal(viewer.handleKeydown(key('Home')), 'page');
  assert.equal(state.page, 1);
  assert.equal(viewer.handleKeydown(key('+')), 'zoom');
  assert.equal(state.zoom, 1.5);
  assert.equal(viewer.handleKeydown(key('-')), 'zoom');
  assert.equal(state.zoom, 1.25);
  assert.equal(viewer.handleKeydown(key('0')), 'zoom');
  assert.equal(state.zoom, 1);
  assert.equal(viewer.handleKeydown(key('r')), 'rotate');
  assert.equal(state.rotation, 90);
  assert.equal(viewer.handleKeydown(key('n')), 'night');
  assert.equal(state.night, true);

  // Ctrl+F is the search focus signal (the host focuses the input).
  assert.equal(viewer.handleKeydown(key('f', { ctrlKey: true })), 'focus-search');
  // Typing in a field is NEVER hijacked.
  assert.equal(viewer.handleKeydown(key('ArrowRight', { target: { tagName: 'INPUT' } })), null);
  // Unknown keys pass through.
  assert.equal(viewer.handleKeydown(key('q')), null);
  viewer.destroy();
});

test('SHELL INTEGRATION: the pro toolbar (jump-to-page, fit, rotate, night, outline) renders and works', async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  try {
    shell._docEngineOverride = fakePdfjs();
    shell.addDocumentTab({ name: 'pro.pdf', bytes: new Uint8Array([1, 2, 3]) });
    await flush(25);
    const vp = shell.viewportElement;
    for (const cls of ['fb-doc-page-input', 'fb-doc-btn-fitw', 'fb-doc-btn-fitp', 'fb-doc-btn-rotate', 'fb-doc-btn-night', 'fb-doc-btn-outline', 'fb-doc-close-btn']) {
      assert.ok(vp.querySelector(`.${cls}`), `${cls} renders`);
    }
    // Rotate + night work through the buttons.
    vp.querySelector('.fb-doc-btn-rotate').click();
    await flush();
    assert.equal(shell.getActiveTab().docState.rotation, 90, 'rotate button turns the page');
    vp.querySelector('.fb-doc-btn-night').click();
    await flush();
    assert.equal(shell.getActiveTab().docState.night, true, 'night button inverts the page');

    // The sidebar opens with the outline and jumps on click.
    vp.querySelector('.fb-doc-btn-outline').click();
    await flush(25);
    const sidebar = vp.querySelector('.fb-doc-sidebar');
    assert.ok(sidebar, 'sidebar renders');
    assert.equal(sidebar.style.display, 'block', 'sidebar opens');
    const items = Array.from(vp.querySelectorAll('.fb-doc-outline-item'));
    assert.equal(items.length, 4, 'outline entries render');
    const revenue = items.find((i) => i.textContent === 'Revenue');
    revenue.click();
    await flush();
    assert.equal(shell.getActiveTab().docState.page, 2, 'outline click jumps to the section page');

    // Thumbnails tab + page jump input.
    vp.querySelector('.fb-doc-sidebar-tab-thumbnails').click();
    await flush(25);
    const thumbs = Array.from(vp.querySelectorAll('.fb-doc-thumb'));
    assert.equal(thumbs.length, 4, 'one thumbnail per page');
    thumbs[3].click();
    await flush();
    assert.equal(shell.getActiveTab().docState.page, 4, 'thumbnail click jumps');

    const input = vp.querySelector('.fb-doc-page-input');
    input.value = '2';
    input.dispatchEvent({ type: 'change', target: input });
    await flush();
    assert.equal(shell.getActiveTab().docState.page, 2, 'direct page jump');

    // Search results panel.
    const search = vp.querySelector('.fb-doc-search-input');
    search.value = 'report';
    shell._activeDocViewer.viewer.search('report');
    await flush(25);
    shell.getActiveTab().docState.showMatchList = true;
    shell._activeDocViewer.sync();
    const rows = Array.from(vp.querySelectorAll('.fb-doc-match-row'));
    assert.equal(rows.length, 2, 'the match list shows every hit');
    assert.match(rows[0].textContent, /p\.1/);
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});
