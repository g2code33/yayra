import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as FixtureXlsx from '@e965/xlsx';
import { parseHTML } from 'linkedom';
import { DOMParser as NamespaceDomParser, XMLSerializer } from '@xmldom/xmldom';
import { buildPowerPointDeck } from './fixtures/pptx-powerpoint-fixture.mjs';

// docx-preview needs namespace-aware XML localName values. linkedom provides
// the live HTML tree while xmldom parses the OOXML package parts.
class OfficeDomParser extends NamespaceDomParser {
  parseFromString(...args) {
    const parsed = super.parseFromString(...args);
    if (!('firstElementChild' in parsed)) {
      Object.defineProperty(parsed, 'firstElementChild', { value: parsed.documentElement, configurable: true });
    }
    return parsed;
  }
}

const { document, window } = parseHTML('<html><head></head><body></body></html>');
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true, writable: true },
  document: { value: document, configurable: true, writable: true },
  DOMParser: { value: OfficeDomParser, configurable: true, writable: true },
  XMLSerializer: { value: XMLSerializer, configurable: true, writable: true },
  Node: { value: window.Node, configurable: true, writable: true },
  HTMLElement: { value: window.HTMLElement, configurable: true, writable: true },
  HTMLImageElement: { value: window.HTMLImageElement, configurable: true, writable: true },
  SVGElement: { value: window.SVGElement, configurable: true, writable: true }
});

const createHtmlElement = document.createElement.bind(document);
document.createElement = (tagName, options) => {
  const element = createHtmlElement(tagName, options);
  if (String(tagName).toLowerCase() === 'canvas') {
    element.getContext = () => ({
      canvas: element,
      setTransform() {},
      save() {},
      restore() {},
      clearRect() {},
      fillRect() {},
      transform() {},
      drawImage() {}
    });
  }
  return element;
};

const {
  DocumentStore,
  createDocumentViewerState,
  createPdfViewer,
  sniffDocumentKind
} = await import('../packages/shared-ui/src/services/documentWorkspace.js');
const {
  createDocxViewer,
  createImageViewer,
  createPptxViewer,
  createSpreadsheetViewer,
  createTextViewer,
  createUnsupportedViewer,
  createViewerForKind
} = await import('../packages/shared-ui/src/services/documentViewers.js');
const pptxEngine = await import('../packages/shared-ui/src/vendor/documents/pptxRenderer.mjs');

function mount(width = 1100, height = 760) {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { value: width, configurable: true },
    clientHeight: { value: height, configurable: true }
  });
  document.body.appendChild(host);
  return host;
}

function removeMount(host) {
  try { host.remove(); } catch { /* already detached */ }
}

async function buildDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Clinical Notes</w:t></w:r></w:p>
    <w:p><w:r><w:t>Atenolol reduces heart rate.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Drug</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Dose</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>`);
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  return zip.generateAsync({ type: 'uint8array' });
}

function buildWorkbook() {
  const workbook = FixtureXlsx.utils.book_new();
  const doses = FixtureXlsx.utils.aoa_to_sheet([
    ['Drug', 'Dose', 'Adjusted dose'],
    ['Atenolol', 50, 60],
    ['Metoprolol', 25, 35]
  ]);
  doses.C2.f = 'B2+10';
  doses['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 18 }];
  doses['!merges'] = [FixtureXlsx.utils.decode_range('A4:C4')];
  doses.A4 = { t: 's', v: 'Review with food' };
  doses['!ref'] = 'A1:C4';
  const notes = FixtureXlsx.utils.aoa_to_sheet([['Note'], ['Monitor pulse']]);
  FixtureXlsx.utils.book_append_sheet(workbook, doses, 'Doses');
  FixtureXlsx.utils.book_append_sheet(workbook, notes, 'Notes');
  return new Uint8Array(FixtureXlsx.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

const PDF_PREFIX = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

test('FORMAT ROUTING: signatures outrank spoofed names; MIME and OOXML parts fill missing extensions', async () => {
  const [pptx, docx] = await Promise.all([buildPowerPointDeck(), buildDocx()]);
  const xlsx = buildWorkbook();

  assert.equal(sniffDocumentKind(PDF_PREFIX, 'renamed.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'pdf');
  assert.equal(sniffDocumentKind(PNG_BYTES, 'download.bin', 'application/octet-stream'), 'image');
  assert.equal(sniffDocumentKind(pptx, 'upload.bin'), 'pptx');
  assert.equal(sniffDocumentKind(docx, 'upload.bin'), 'docx');
  assert.equal(sniffDocumentKind(xlsx, 'upload.bin'), 'xlsx');
  assert.equal(sniffDocumentKind(new Uint8Array([1, 2, 3]), 'upload', 'application/pdf; charset=binary'), 'pdf');
  assert.equal(sniffDocumentKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'art.txt'), 'image');

  const store = new DocumentStore();
  const stored = store.add({ name: 'mystery.bin', bytes: pptx, mime: 'application/octet-stream' });
  assert.equal(stored.type, 'pptx');
  assert.equal(stored.route.viewer, 'pptx');
  assert.strictEqual(stored.bytes, pptx, 'the original byte buffer is retained unchanged');
});

test('PPTX REAL ENGINE: PowerPoint geometry, themes, image crop, merged table, notes and text index survive', async () => {
  const bytes = await buildPowerPointDeck();
  const deck = await pptxEngine.openPptxDeck(new Blob([bytes]), { lazyMedia: true });
  try {
    assert.equal(deck.slideCount, 1);
    assert.equal(deck.slideWidth, 1280);
    assert.equal(deck.slideHeight, 720);
    const slide = await deck.getSlide(1);
    assert.equal(slide.title, 'Cardiovascular Pharmacology');
    assert.equal(slide.notes, 'Emphasise the beta blocker contraindication');
    assert.equal(slide.background, '#ffffff');

    const title = slide.shapes.find((shape) => shape.isTitle);
    assert.equal(title.text.defaultSizePt, 44);
    assert.equal(title.text.levels[0].font, 'Georgia');
    assert.equal(title.text.levels[0].align, 'center');
    const accent = slide.shapes.find((shape) => shape.fill === '#00a651');
    assert.ok(accent, 'theme accent color is resolved through the master');

    const picture = slide.shapes.find((shape) => shape.type === 'image');
    assert.equal(picture.geom, 'ellipse');
    assert.deepEqual(picture.crop, { l: 0.25, t: 0.1, r: 0.1, b: 0.2 });
    await deck.ensureSlideMedia(1);
    assert.match(picture.imageUrl, /^blob:/, 'embedded media is resolved locally');

    const table = slide.shapes.find((shape) => shape.type === 'table').table;
    assert.equal(table.cells[0][2].gridSpan, 2);
    assert.equal(table.cells[1][0].rowSpan, 2);
    assert.equal(table.cells[2][0].merged, 'v');
    const index = await deck.textIndex();
    assert.match(index[0].text, /Atenolol/);
    assert.match(index[0].text, /Notes: Emphasise the beta blocker contraindication/);
  } finally {
    deck.dispose();
  }
});

test('PPTX CONTROLLER: original bytes render a slide, thumbnails, notes and search offline', async () => {
  const host = mount();
  const state = createDocumentViewerState('pptx');
  const viewer = createPptxViewer({ container: host, state, fileName: 'lecture.pptx' });
  try {
    await viewer.load(await buildPowerPointDeck());
    assert.equal(state.status, 'ready');
    assert.equal(state.numPages, 1);
    assert.equal(state.aspectRatio, '1280 × 720');
    assert.match(host.textContent, /Cardiovascular Pharmacology/);
    assert.match(host.textContent, /Atenolol/);
    assert.match(host.querySelector('.fb-pptx-notes-body').textContent, /contraindication/);
    assert.equal(host.querySelectorAll('table').length, 1);
    assert.equal(host.querySelectorAll('img').length, 1);

    await viewer.search('contraindication');
    assert.equal(state.matches.length, 1, 'speaker notes are included in search');
    const thumb = mount(150, 100);
    await viewer.renderThumbnail(1, thumb);
    assert.match(thumb.textContent, /Cardiovascular Pharmacology/);
    removeMount(thumb);
    await viewer.toggleNotes(false);
    assert.equal(host.querySelector('.fb-pptx-notes').style.display, 'none');
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('DOCX REAL ENGINE: paragraphs and tables render, zoom and find work on original OOXML bytes', async () => {
  const host = mount();
  const state = createDocumentViewerState('docx');
  const viewer = createDocxViewer({ container: host, state, fileName: 'clinical-notes.docx' });
  try {
    await viewer.load(await buildDocx());
    assert.equal(state.status, 'ready');
    assert.equal(host.querySelectorAll('section.docx').length, 1);
    assert.match(host.textContent, /Clinical Notes/);
    assert.match(host.textContent, /Atenolol reduces heart rate/);
    assert.equal(host.querySelectorAll('table').length, 1);

    await viewer.setZoom(1.5);
    assert.match(host.querySelector('.fb-docx-scale').style.transform, /1\.5/);
    await viewer.search('atenolol');
    assert.equal(state.matches.length, 1);
    assert.equal(host.querySelectorAll('mark[data-yayra-doc-find]').length, 1);
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('SPREADSHEET REAL ENGINE: worksheets, formatting metadata, formulas, merges and search render offline', async () => {
  const host = mount();
  const state = createDocumentViewerState('xlsx');
  const viewer = createSpreadsheetViewer({ container: host, state, fileName: 'doses.xlsx' });
  try {
    await viewer.load(buildWorkbook());
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.sheetNames, ['Doses', 'Notes']);
    assert.equal(state.numPages, 2);
    assert.match(host.textContent, /Atenolol/);
    assert.equal(host.querySelector('[data-cell="C2"]').title, '=B2+10');
    assert.equal(host.querySelector('[data-cell="A4"]').colSpan, 3);

    await viewer.search('atenolol');
    assert.equal(state.matches.length, 1);
    assert.equal(state.matches[0].cell, 'A2');
    await viewer.setPage(2);
    assert.equal(state.page, 2);
    assert.match(host.textContent, /Monitor pulse/);
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('IMAGE AND TEXT: images stay internal, SVG is sanitised, and markup in text never executes', async () => {
  const svgHost = mount();
  const svgState = createDocumentViewerState('image');
  const svgViewer = createImageViewer({ container: svgHost, state: svgState, fileName: 'unsafe.svg' });
  try {
    const unsafeSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><image href="https://tracker.example/pixel"/><rect width="10" height="10" fill="red"/></svg>');
    await svgViewer.load(unsafeSvg);
    assert.equal(svgState.status, 'ready');
    const image = svgHost.querySelector('img');
    assert.ok(image);
    const sanitised = await (await fetch(image.src)).text();
    assert.doesNotMatch(sanitised, /<script|onload=|tracker\.example/i);
    assert.match(sanitised, /<rect/);
    await svgViewer.setZoom(2);
    await svgViewer.rotate(90);
    assert.match(image.style.transform, /rotate\(90deg\) scale\(2\)/);
  } finally {
    svgViewer.destroy();
    removeMount(svgHost);
  }

  const textHost = mount();
  const textState = createDocumentViewerState('text');
  const textViewer = createTextViewer({ container: textHost, state: textState, fileName: 'readme.md' });
  try {
    const source = '# Yayra\n<script>globalThis.compromised = true</script>\nOffline document search';
    await textViewer.load(new TextEncoder().encode(source));
    assert.equal(textState.status, 'ready');
    assert.equal(textHost.querySelector('script'), null, 'plain text is never parsed as markup');
    assert.match(textHost.textContent, /<script>/);
    await textViewer.search('document');
    assert.equal(textState.matches.length, 1);
    assert.equal(textHost.querySelectorAll('mark').length, 1);
    await textViewer.setNight(true);
    assert.match(textHost.querySelector('.fb-text-reader').style.background, /#0b1020/);
  } finally {
    textViewer.destroy();
    removeMount(textHost);
  }
});

test('PDF CONTINUOUS VIEW: pages are selectable and windowed while outline and thumbnails remain available', async () => {
  const host = mount(900, 700);
  const state = createDocumentViewerState('pdf');
  const renderCounts = new Map();
  const pages = 20;
  const pdfjs = {
    renderTextLayer: ({ textContentSource, container }) => {
      for (const item of textContentSource.items) {
        const span = document.createElement('span');
        span.textContent = item.str;
        container.appendChild(span);
      }
      return { promise: Promise.resolve() };
    },
    getDocument: ({ data }) => {
      assert.ok(data instanceof Uint8Array, 'PDF.js receives bytes rather than a URL');
      return { promise: Promise.resolve({
        numPages: pages,
        getPage: async (pageNumber) => ({
          rotate: 0,
          getViewport: ({ scale = 1, rotation = 0 }) => ({ width: (rotation % 180 ? 800 : 600) * scale, height: (rotation % 180 ? 600 : 800) * scale, scale }),
          render: () => {
            renderCounts.set(pageNumber, (renderCounts.get(pageNumber) || 0) + 1);
            return { promise: Promise.resolve(), cancel() {} };
          },
          getTextContent: async () => ({ items: [{ str: `Selectable text on page ${pageNumber}` }] })
        }),
        getOutline: async () => [{ title: 'Chapter ten', dest: [{ ref: 10 }] }],
        getPageIndex: async () => 9,
        destroy() {}
      }) };
    }
  };
  const viewer = createPdfViewer({ pdfjs, container: host, state });
  try {
    await viewer.load(PDF_PREFIX);
    assert.equal(state.status, 'ready');
    assert.equal(host.querySelectorAll('.fb-pdf-page').length, pages, 'the continuous document has a stable page shell for every page');
    assert.deepEqual([...renderCounts.keys()], [1, 2, 3], 'opening paints only the visible/nearby window');
    assert.match(host.querySelector('.fb-pdf-text-layer[data-page="1"]').textContent, /Selectable text/, 'the selectable text layer is attached');

    await viewer.setPage(10);
    for (const page of [8, 9, 10, 11, 12]) assert.ok(renderCounts.has(page), `nearby page ${page} is painted`);
    assert.equal(host.querySelector('.fb-pdf-page-canvas[data-page="1"]').width, 1, 'far-away canvas pixels are evicted');

    assert.equal(await viewer.preparePrint(), true);
    for (let page = 1; page <= pages; page += 1) assert.ok(renderCounts.has(page), `print preparation paints page ${page}`);
    assert.equal(state.printProgress, 100);
    await viewer.finishPrint();
    assert.equal(host.querySelector('.fb-pdf-page-canvas[data-page="1"]').width, 1, 'print pixels are evicted after the dialog');

    await viewer.rotate(90);
    assert.equal(state.rotation, 90);
    await viewer.setNight(true);
    assert.equal(state.night, true);

    const outline = await viewer.loadOutline();
    assert.deepEqual(outline, [{ title: 'Chapter ten', page: 10, depth: 0 }]);
    const thumbnail = mount(140, 180);
    await viewer.renderThumbnail(10, thumbnail);
    assert.ok(thumbnail.querySelector('.fb-pdf-thumbnail-canvas'));
    removeMount(thumbnail);
  } finally {
    viewer.destroy();
    assert.equal(host.childNodes.length, 0, 'destroy releases the continuous page tree');
    removeMount(host);
  }
});

test('FAILURE AND FALLBACK: corrupt files stop with actionable errors and original-file fallback stays usable', async () => {
  const corruptHost = mount();
  const corruptState = createDocumentViewerState('pptx');
  const corrupt = createPptxViewer({ container: corruptHost, state: corruptState, fileName: 'broken.pptx', loadTimeoutMs: 2000 });
  try {
    await corrupt.load(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    assert.equal(corruptState.status, 'error');
    assert.match(corruptState.error, /corrupted|password-protected|older binary/i);
    assert.doesNotMatch(corruptState.error, /loading/i);
  } finally {
    corrupt.destroy();
    removeMount(corruptHost);
  }

  const fallbackHost = mount();
  const fallbackState = createDocumentViewerState('unsupported');
  let opened = 0;
  const fallback = createUnsupportedViewer({
    container: fallbackHost,
    state: fallbackState,
    fileName: 'legacy.ppt',
    onOpenOriginal: () => { opened += 1; }
  });
  try {
    await fallback.load(new Uint8Array([1]));
    assert.equal(fallbackState.status, 'ready');
    assert.match(fallbackHost.textContent, /needs a desktop app/);
    const button = fallbackHost.querySelector('button');
    assert.match(button.textContent, /Open original/);
    button.click();
    assert.equal(opened, 1);
    assert.equal(createViewerForKind('unknown', { container: null, state: createDocumentViewerState('unsupported') }).state.viewer, 'unsupported');
  } finally {
    fallback.destroy();
    removeMount(fallbackHost);
  }
});
