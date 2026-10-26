import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import * as FixtureXlsx from '@e965/xlsx';
import { parseHTML } from 'linkedom';
import { DOMParser as NamespaceDomParser, XMLSerializer } from '@xmldom/xmldom';
import {
  buildPowerPointCompatibilityMathDeck,
  buildPowerPointDeck,
  buildPowerPointVideoDeck
} from './fixtures/pptx-powerpoint-fixture.mjs';

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
  sniffCompoundOfficeKind,
  sniffDocumentKind
} = await import('../packages/shared-ui/src/services/documentWorkspace.js');
const {
  convertLegacyOfficeBytes,
  createDocxViewer,
  createImageViewer,
  createLegacyDocViewer,
  createLegacyPptViewer,
  createPptxViewer,
  createSpreadsheetViewer,
  createTextViewer,
  createUnsupportedViewer,
  createViewerForKind
} = await import('../packages/shared-ui/src/services/documentViewers.js');
const pptxEngine = await import('../packages/shared-ui/src/vendor/documents/pptxRenderer.mjs');
const metafileEngine = await import('../packages/shared-ui/src/vendor/documents/metafile.mjs');
const { renderPptxSlide } = await import('../packages/shared-ui/src/services/pptxDomRenderer.js');

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

const legacyFixture = async (name) => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));

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

test('FORMAT ROUTING: signatures outrank spoofed names; OOXML and CFB siblings are byte-sniffed', async () => {
  const [pptx, docx, doc, ppt, xls] = await Promise.all([
    buildPowerPointDeck(), buildDocx(), legacyFixture('legacy-word.doc'),
    legacyFixture('legacy-slides.ppt'), legacyFixture('legacy-sheet.xls')
  ]);
  const xlsx = buildWorkbook();

  assert.equal(sniffDocumentKind(PDF_PREFIX, 'renamed.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'pdf');
  assert.equal(sniffDocumentKind(PNG_BYTES, 'download.bin', 'application/octet-stream'), 'image');
  assert.equal(sniffDocumentKind(pptx, 'upload.bin'), 'pptx');
  assert.equal(sniffDocumentKind(docx, 'upload.bin'), 'docx');
  assert.equal(sniffDocumentKind(xlsx, 'upload.bin'), 'xlsx');
  assert.equal(sniffCompoundOfficeKind(doc), 'doc');
  assert.equal(sniffCompoundOfficeKind(ppt), 'ppt');
  assert.equal(sniffCompoundOfficeKind(xls), 'xls');
  assert.equal(sniffDocumentKind(doc, 'spoofed.ppt', 'application/vnd.ms-powerpoint'), 'doc');
  assert.equal(sniffDocumentKind(ppt, 'spoofed.xls', 'application/vnd.ms-excel'), 'ppt');
  assert.equal(sniffDocumentKind(xls, 'spoofed.doc', 'application/msword'), 'xls');
  const unknownCompound = new Uint8Array(512);
  unknownCompound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(sniffDocumentKind(unknownCompound, 'spoofed.doc'), 'unsupported', 'an unknown CFB is not trusted as Word by extension');

  // Plausible directory records outside a valid FAT/root tree are embedded
  // content, not authoritative format evidence.
  const recordSpoof = new Uint8Array(512);
  recordSpoof.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const writeFakeRecord = (offset, name) => {
    for (let index = 0; index < name.length; index += 1) {
      recordSpoof[offset + index * 2] = name.charCodeAt(index);
    }
    new DataView(recordSpoof.buffer).setUint16(offset + 64, (name.length + 1) * 2, true);
    recordSpoof[offset + 66] = 2;
  };
  writeFakeRecord(128, 'WordDocument');
  writeFakeRecord(256, '1Table');
  assert.equal(sniffCompoundOfficeKind(recordSpoof), 'unsupported');
  assert.equal(sniffDocumentKind(recordSpoof, 'spoofed.doc'), 'unsupported', 'aligned embedded records cannot impersonate root streams');
  assert.equal(sniffDocumentKind(new Uint8Array([1, 2, 3]), 'upload', 'application/pdf; charset=binary'), 'pdf');
  assert.equal(sniffDocumentKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'art.txt'), 'image');

  const store = new DocumentStore();
  const stored = store.add({ name: 'mystery.bin', bytes: pptx, mime: 'application/octet-stream' });
  assert.equal(stored.type, 'pptx');
  assert.equal(stored.route.viewer, 'pptx');
  assert.strictEqual(stored.bytes, pptx, 'the original byte buffer is retained unchanged');
  const legacyStored = store.add({ name: 'misleading.bin', bytes: doc, mime: 'application/octet-stream' });
  assert.equal(legacyStored.type, 'doc');
  assert.equal(legacyStored.route.viewer, 'doc');
  assert.equal(legacyStored.route.capabilities.view, true);
  assert.strictEqual(legacyStored.bytes, doc, 'the legacy original—not its viewing copy—belongs to the Documents library');
});

test('PPTX TITLES: title frames that extend beyond slide edges are brought fully into view', () => {
  const host = mount(960, 540);
  try {
    const slide = {
      slideNumber: 1,
      background: '#ffffff',
      shapes: [{
        type: 'text', isTitle: true, x: 910, y: -18, w: 220, h: 80,
        text: {
          anchor: 'ctr', fontScale: 1, defaultSizePt: 32, levels: [],
          paragraphs: [{ level: 0, runs: [{ text: 'Presynaptic modulation' }] }]
        }
      }]
    };
    renderPptxSlide(host, { slide, width: 960, height: 540 });
    const title = host.querySelector('.fb-pptx-title');
    assert.ok(title, 'title placeholders keep their title identity');
    assert.equal(title.style.left, '740px', 'an off-slide right edge shifts the full-width title frame inward');
    assert.equal(title.style.top, '0px', 'an off-slide top edge is clamped into the slide');
    assert.equal(title.style.width, '220px', 'the original title width is retained when it fits');
    assert.match(title.textContent, /Presynaptic modulation/, 'all heading text remains in the rendered title');
  } finally {
    removeMount(host);
  }
});

test('PPTX PROJECTOR COLOURS: tables with automatic text never inherit the white slideshow chrome', () => {
  const host = mount(960, 540);
  host.style.color = '#f8fafc'; // projector chrome deliberately uses a light foreground
  try {
    const slide = {
      slideNumber: 1,
      background: '#ffffff',
      shapes: [{
        type: 'table', x: 40, y: 40, w: 700, h: 240,
        table: {
          cells: [[
            { text: 'Automatic on slide' },
            { text: 'Automatic on white cell', fill: '#ffffff' },
            { text: 'Automatic on dark cell', fill: '#111827' },
            { text: 'Automatic on mid cell', fill: '#777777' }
          ]]
        }
      }]
    };
    const rendered = renderPptxSlide(host, { slide, width: 960, height: 540 });
    assert.match(rendered.canvas.getAttribute('style') || '', /color:\s*#000000/i,
      'the light slide owns a black automatic-text fallback instead of inheriting projector white');
    const cells = host.querySelectorAll('td');
    assert.equal(cells[0].style.color, '', 'an unfilled cell inherits from the authored slide canvas');
    assert.equal(cells[1].style.color, '#000000', 'a light filled cell receives readable dark text');
    assert.equal(cells[2].style.color, '#ffffff', 'a dark filled cell receives readable light text');
    assert.equal(cells[3].style.color, '#000000', 'mid-tone fills choose the higher WCAG-contrast foreground');

    slide.background = '#111827';
    renderPptxSlide(host, { slide, width: 960, height: 540 });
    assert.match(host.querySelector('.fb-pptx-slide-canvas').getAttribute('style') || '', /color:\s*#ffffff/i,
      'automatic text also remains readable on genuinely dark authored slides');
  } finally {
    removeMount(host);
  }
});

test('PPTX METAFILE RECOVERY: embedded WMF/EMF becomes local browser-safe SVG', async () => {
  const bytes = await legacyFixture('metafile-objects.wmf');
  const original = bytes.slice();
  const svgBlob = await metafileEngine.convertMetafileToSafeSvg(bytes);
  assert.equal(svgBlob.type, 'image/svg+xml');
  const svg = await svgBlob.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox=/);
  assert.match(svg, /<path|<rect|<text/);
  assert.deepEqual(bytes, original, 'metafile conversion never mutates the package image bytes');
});

test('PPTX IMAGE RECOVERY: alternate sources are tried and broken-image glyphs are retired', () => {
  const host = mount(640, 360);
  try {
    renderPptxSlide(host, {
      width: 640,
      height: 360,
      slide: {
        slideNumber: 1,
        title: 'Image recovery',
        background: '#ffffff',
        shapes: [{
          id: 1, type: 'image', x: 20, y: 20, w: 300, h: 180, rot: 0,
          imageUrl: 'blob:first-source', imageUrls: ['blob:first-source', 'blob:second-source'],
          textScale: 1, isTitle: false
        }]
      }
    });
    const image = host.querySelector('img');
    assert.equal(image.getAttribute('src'), 'blob:first-source');
    image.dispatchEvent(new window.Event('error'));
    assert.equal(image.getAttribute('src'), 'blob:second-source', 'decode failure advances to the packaged alternate');
    image.dispatchEvent(new window.Event('error'));
    assert.equal(host.querySelector('img'), null, 'an exhausted source list never leaves the browser broken-image icon');
    assert.match(host.textContent, /Image unavailable/);
  } finally {
    removeMount(host);
  }
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

test('PPTX COMPATIBILITY: AlternateContent math renders and slide numbers inherit lower-right master geometry', async () => {
  const bytes = await buildPowerPointCompatibilityMathDeck();
  const deck = await pptxEngine.openPptxDeck(new Blob([bytes]), { lazyMedia: true });
  try {
    const slide = await deck.getSlide(1);
    assert.equal(slide.title, 'Basic Sample Size Formulas');
    assert.match(slide.body.join('\n'), /For Estimating a Mean/);
    assert.match(slide.body.join('\n'), /estimated standard deviation/);
    assert.doesNotMatch(slide.body.join('\n'), /Fallback preview/);

    const title = slide.shapes.find((shape) => shape.isTitle);
    assert.equal(title.x, 72, 'title geometry can pass layout → master → slide');
    assert.equal(title.y, 36);

    const equationRun = slide.shapes
      .flatMap((shape) => shape.text?.paragraphs || [])
      .flatMap((paragraph) => paragraph.runs)
      .find((run) => run.mathMl);
    assert.ok(equationRun, 'a14:m inside run-level AlternateContent becomes a visible equation run');
    assert.match(equationRun.mathMl, /<mfrac/);
    assert.match(equationRun.mathMl, /<msub/);
    assert.equal(equationRun.text, 'nₒ = (Z² × σ²) ⁄ d²', 'fallback remains the copy/search representation');
    assert.equal(equationRun.sizePt, 26, 'fallback formatting sizes the structural equation consistently');

    const slideNumber = slide.shapes.find((shape) => shape.placeholderType === 'sldNum');
    assert.ok(slideNumber, 'slide-number field is retained');
    assert.equal(slideNumber.x, 1128);
    assert.equal(slideNumber.y, 664);
    assert.ok(slideNumber.x > deck.slideWidth * 0.8 && slideNumber.y > deck.slideHeight * 0.85,
      'the footer is at the lower-right, not the generic upper-left fallback');
    assert.equal(slideNumber.text.paragraphs[0].runs[0].text, '11');

    const director = slide.shapes.find((shape) => shape.text?.paragraphs.some((p) => p.runs.some((r) => r.text === 'Director')));
    const operations = slide.shapes.find((shape) => shape.text?.paragraphs.some((p) => p.runs.some((r) => r.text === 'Operations')));
    assert.ok(director && operations, 'SmartArt cached drawing shapes and text are rendered');
    assert.equal(director.fill, '#4472c4');
    assert.equal(operations.fill, '#70ad47');
    assert.ok(Math.abs(director.x - 800) < 0.1 && Math.abs(director.w - 133.33) < 0.1,
      'cached drawing coordinates are mapped into the graphic frame');
    assert.ok(operations.x > director.x + director.w, 'organisation nodes preserve their cached placement');
    const diagramImage = slide.shapes.find((shape) => shape.imagePaths?.includes('ppt/media/smartart-badge.png'));
    assert.ok(diagramImage, 'images related from the cached diagram part survive rId collisions with slide relationships');
    assert.equal(slide.diagnostics, undefined, 'a resolved cached SmartArt drawing does not report a false fidelity warning');

    const compatibilityImage = slide.shapes.find((shape) => shape.imageRid === 'rId2');
    assert.ok(compatibilityImage, 'an unsupported modern branch uses its p:sp picture fallback');
    assert.equal(compatibilityImage.type, 'image');
    await deck.ensureSlideMedia(1, { includeClips: false });
    assert.match(compatibilityImage.imageUrl, /^blob:/);
    assert.match(diagramImage.imageUrl, /^blob:/, 'cached SmartArt image bytes resolve from drawing1.xml.rels');
    assert.equal((await fetch(diagramImage.imageUrl)).headers.get('content-type'), 'image/png');

    const svgAlternative = slide.shapes.find((shape) => shape.imageRid === 'rId4');
    assert.ok(svgAlternative, 'an SVG alternate is preferred over its legacy EMF source');
    assert.deepEqual(svgAlternative.imageRids, ['rId4', 'rId3']);
    assert.equal(svgAlternative.imageUrls.length, 2, 'both local sources remain available for decode fallback');
    const svgMarkup = await (await fetch(svgAlternative.imageUrl)).text();
    assert.match(svgMarkup, /^<svg/);
    assert.match(svgMarkup, /SVG fallback/);

    const index = await deck.textIndex();
    assert.match(index[0].text, /margin of error/);
    assert.match(index[0].text, /nₒ = \(Z² × σ²\) ⁄ d²/);
  } finally {
    deck.dispose();
  }

  const host = mount();
  const state = createDocumentViewerState('pptx');
  const viewer = createPptxViewer({ container: host, state, fileName: 'Research Methodology.pptx' });
  try {
    await viewer.load(bytes);
    assert.equal(state.status, 'ready');
    assert.match(host.textContent, /For Estimating a Mean/);
    assert.match(host.textContent, /estimated standard deviation/);
    assert.ok(host.querySelector('math'), 'the DOM stage contains native MathML');
    assert.ok(host.querySelector('mfrac'), 'fraction structure is preserved rather than discarded');
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('PPTX SMARTART RECOVERY: a missing cached drawing gets a searchable native fallback and visible diagnostic', async () => {
  const bytes = await buildPowerPointCompatibilityMathDeck({ omitDiagramDrawing: true });
  const deck = await pptxEngine.openPptxDeck(new Blob([bytes]), { lazyMedia: true });
  const host = mount();
  try {
    const slide = await deck.getSlide(1);
    assert.ok(slide.shapes.some((shape) => shape.text?.paragraphs.some((p) => p.runs.some((r) => r.text === 'Director'))));
    assert.ok(slide.diagnostics?.some((item) => item.code === 'pptx/smartart-native-fallback'));
    assert.match((await deck.textIndex())[0].text, /Director/);
    renderPptxSlide(host, { slide, width: deck.slideWidth, height: deck.slideHeight });
    assert.match(host.textContent, /Rendering issue/);
    assert.match(host.querySelector('.fb-pptx-fidelity-warning').getAttribute('aria-label'), /SmartArt cached drawing is missing/);
  } finally {
    deck.dispose();
    removeMount(host);
  }
});

test('PPTX VIDEO ENGINE: legacy and p14 clips stay lazy, preserve posters, and receive a playable MIME', async () => {
  for (const modern of [false, true]) {
    const bytes = await buildPowerPointVideoDeck({ modern });
    const deck = await pptxEngine.openPptxDeck(new Blob([bytes]), { lazyMedia: true });
    try {
      const slide = await deck.getSlide(1);
      const video = slide.shapes.find((shape) => shape.type === 'video');
      assert.ok(video, `${modern ? 'p14:media' : 'a:videoFile'} is recognised as a video shape`);
      assert.equal(video.imageUrl, undefined, 'poster starts lazy');
      assert.equal(video.videoUrl, undefined, 'clip starts lazy');

      await deck.ensureSlideMedia(1, { includeClips: false });
      assert.match(video.imageUrl, /^blob:/, 'thumbnail pass resolves the poster');
      assert.equal(video.videoUrl, undefined, 'thumbnail pass never decompresses the movie');
      assert.equal((await fetch(video.imageUrl)).headers.get('content-type'), 'image/png');

      await deck.ensureSlideMedia(1);
      assert.match(video.videoUrl, /^blob:/, 'opening the slide resolves the embedded clip locally');
      assert.equal((await fetch(video.videoUrl)).headers.get('content-type'), 'video/mp4');
      assert.equal(video.w, 384);
      assert.equal(video.h, 288);
    } finally {
      deck.dispose();
    }
  }
});

test('PPTX VIDEO CONTROLLER: embedded clips use native controls, poster thumbnails, and media-owned keyboard input', async () => {
  const host = mount();
  const state = createDocumentViewerState('pptx');
  const viewer = createPptxViewer({ container: host, state, fileName: 'video-training.pptx' });
  try {
    await viewer.load(await buildPowerPointVideoDeck());
    assert.equal(state.status, 'ready');
    const video = host.querySelector('video.fb-pptx-video');
    assert.ok(video, 'the embedded movie is a real HTML video element');
    assert.equal(video.hasAttribute('controls'), true);
    assert.equal(video.hasAttribute('autoplay'), false, 'opening a deck never starts sound unexpectedly');
    assert.equal(video.getAttribute('preload'), 'metadata');
    assert.equal(video.hasAttribute('playsinline'), true);
    assert.match(video.getAttribute('src'), /^blob:/);
    assert.match(video.getAttribute('poster'), /^blob:/);
    assert.equal(host.querySelector('.fb-pptx-slide-canvas').getAttribute('role'), 'group', 'interactive media remains exposed to assistive technology');
    assert.equal(viewer.handleKeydown({ key: 'ArrowRight', target: video }), null, 'focused video keeps arrow keys for seeking');

    const thumbnail = mount(150, 100);
    await viewer.renderThumbnail(1, thumbnail);
    assert.equal(thumbnail.querySelector('video'), null, 'thumbnail rails never create media players');
    assert.ok(thumbnail.querySelector('.fb-pptx-video-poster'), 'the static poster represents video in a thumbnail');
    removeMount(thumbnail);

    video.dispatchEvent(new window.Event('error'));
    assert.equal(host.querySelector('video'), null, 'unsupported codecs degrade to the slide’s poster instead of a broken player');
    assert.ok(host.querySelector('.fb-pptx-video-codec-fallback'));
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('PPTX VIDEO OFFLINE FALLBACK: linked-only movies never fetch externally and retain their poster', async () => {
  const host = mount();
  const state = createDocumentViewerState('pptx');
  const viewer = createPptxViewer({ container: host, state, fileName: 'linked-video.pptx' });
  try {
    await viewer.load(await buildPowerPointVideoDeck({ linked: true }));
    assert.equal(state.status, 'ready');
    assert.equal(host.querySelector('video'), null, 'an unavailable linked clip is not exposed as a broken player');
    const poster = host.querySelector('.fb-pptx-video-poster');
    assert.ok(poster, 'PowerPoint poster remains visible');
    assert.match(poster.title, /linked rather than embedded/i);
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('PPTX CONTROLLER: original bytes render a slide, thumbnails, colourable notes and search offline', async () => {
  const host = mount();
  const state = createDocumentViewerState('pptx');
  assert.equal(state.notesColor, '#000000', 'speaker notes default to readable black');
  const viewer = createPptxViewer({ container: host, state, fileName: 'lecture.pptx' });
  try {
    await viewer.load(await buildPowerPointDeck());
    assert.equal(state.status, 'ready');
    assert.equal(state.numPages, 1);
    assert.equal(state.aspectRatio, '1280 × 720');
    assert.match(host.textContent, /Cardiovascular Pharmacology/);
    assert.match(host.textContent, /Atenolol/);
    const notesPane = host.querySelector('.fb-pptx-notes');
    const notesBody = host.querySelector('.fb-pptx-notes-body');
    assert.match(notesBody.textContent, /contraindication/);
    assert.match(notesPane.getAttribute('style'), /background:\s*#FBF9F4/i, 'notes use the fixed light reference card');
    assert.equal(notesBody.style.color, '#000000');
    assert.notEqual(notesPane.querySelector('strong').style.color, notesBody.style.color,
      'the independent heading style is not recoloured');
    assert.equal(host.querySelectorAll('table').length, 1);
    assert.equal(host.querySelectorAll('img').length, 1);

    const slideBeforeColourChange = host.querySelector('.fb-pptx-slide-canvas');
    viewer.setNotesColor('#ff0000');
    assert.equal(state.notesColor, '#ff0000');
    assert.equal(notesBody.style.color, '#ff0000', 'the selected colour applies immediately');
    assert.equal(host.querySelector('.fb-pptx-slide-canvas'), slideBeforeColourChange,
      'a notes-only style update does not rebuild presentation media');

    await viewer.search('contraindication');
    assert.equal(state.matches.length, 1, 'speaker notes are included in search');
    assert.equal(host.querySelector('.fb-pptx-notes-body').style.color, '#ff0000',
      'the selected colour survives slide re-rendering');
    viewer.setNotesColor('red; background:url(https://invalid.example)');
    assert.equal(state.notesColor, '#000000', 'malformed values safely fall back to black');
    assert.equal(host.querySelector('.fb-pptx-notes-body').style.color, '#000000');

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

test('LEGACY OFFICE CONVERSION: DOC and PPT become local viewing copies without touching original bytes', async () => {
  const [doc, ppt] = await Promise.all([
    legacyFixture('legacy-word.doc'),
    legacyFixture('legacy-slides.ppt')
  ]);
  const docOriginal = doc.slice();
  const pptOriginal = ppt.slice();
  const [convertedDoc, convertedPpt] = await Promise.all([
    convertLegacyOfficeBytes('doc', doc, { workerFactory: () => null }),
    convertLegacyOfficeBytes('ppt', ppt, { workerFactory: () => null })
  ]);

  for (const result of [convertedDoc, convertedPpt]) {
    assert.deepEqual([...result.bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'the viewing copy is OOXML');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.usedWorker, false);
  }
  assert.deepEqual(doc, docOriginal, 'Word source bytes remain byte-for-byte unchanged');
  assert.deepEqual(ppt, pptOriginal, 'PowerPoint source bytes remain byte-for-byte unchanged');
  assert.notStrictEqual(convertedDoc.bytes.buffer, doc.buffer);
  assert.notStrictEqual(convertedPpt.bytes.buffer, ppt.buffer);
});

test('LEGACY DOC VIEWER: styled text, tables, zoom and search reuse the Word controls', async () => {
  const bytes = await legacyFixture('legacy-word.doc');
  const original = bytes.slice();
  const host = mount();
  const state = createDocumentViewerState('doc');
  const viewer = createLegacyDocViewer({
    container: host,
    state,
    fileName: 'legacy-word.doc',
    legacyWorkerFactory: () => null
  });
  try {
    await viewer.load(bytes);
    assert.equal(state.status, 'ready');
    assert.equal(state.viewer, 'doc');
    assert.equal(state.transformedForViewing, true);
    assert.match(state.engineName, /doc-codec/i);
    assert.match(host.textContent, /Legacy Clinical Notes/);
    assert.match(host.textContent, /Atenolol reduces heart rate/);
    assert.equal(host.querySelectorAll('table').length, 1);
    await viewer.setZoom(1.5);
    assert.match(host.querySelector('.fb-docx-scale').style.transform, /1\.5/);
    await viewer.search('metoprolol');
    assert.equal(state.matches.length, 1);
    assert.deepEqual(bytes, original, 'rendering never rewrites or detaches the original DOC');
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('LEGACY PPT VIEWER: slides, tables, notes, thumbnails, search and presentation controls are retained', async () => {
  const bytes = await legacyFixture('legacy-slides.ppt');
  const original = bytes.slice();
  const host = mount();
  const state = createDocumentViewerState('ppt');
  const viewer = createLegacyPptViewer({
    container: host,
    state,
    fileName: 'legacy-slides.ppt',
    legacyWorkerFactory: () => null
  });
  try {
    await viewer.load(bytes);
    assert.equal(state.status, 'ready');
    assert.equal(state.viewer, 'ppt');
    assert.equal(state.numPages, 2);
    assert.equal(state.transformedForViewing, true);
    assert.match(state.engineName, /ppt-codec/i);
    assert.match(host.textContent, /Legacy Pharmacology/);
    assert.match(host.querySelector('.fb-pptx-notes-body').textContent, /check pulse/i);

    await viewer.search('examples only');
    assert.equal(state.matches.length, 1, 'legacy speaker notes participate in search');
    assert.equal(state.page, 2);
    assert.match(host.textContent, /Dose reference/);
    assert.equal(host.querySelectorAll('table').length, 1, 'the converted legacy table is fully rendered');

    const thumbnail = mount(160, 110);
    await viewer.renderThumbnail(1, thumbnail);
    assert.match(thumbnail.textContent, /Legacy Pharmacology/);
    removeMount(thumbnail);
    assert.deepEqual(bytes, original, 'rendering never rewrites or detaches the original PPT');
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('LEGACY XLS VIEWER: SheetJS opens binary workbooks with sheets and search', async () => {
  const bytes = await legacyFixture('legacy-sheet.xls');
  const original = bytes.slice();
  const host = mount();
  const state = createDocumentViewerState('xls');
  const viewer = createViewerForKind('xls', { container: host, state, fileName: 'legacy-sheet.xls' });
  try {
    await viewer.load(bytes);
    assert.equal(state.status, 'ready');
    assert.equal(state.viewer, 'xls');
    assert.deepEqual(state.sheetNames, ['Legacy doses']);
    assert.match(host.textContent, /Atenolol/);
    await viewer.search('check pulse');
    assert.equal(state.matches.length, 1);
    assert.equal(state.matches[0].cell, 'C2');
    assert.deepEqual(bytes, original, 'the binary XLS is read directly and stays unchanged');
  } finally {
    viewer.destroy();
    removeMount(host);
  }
});

test('LEGACY OFFICE WORKER BOUNDARY: only a disposable copy is transferred and the worker is terminated', async () => {
  const source = await legacyFixture('legacy-word.doc');
  const original = source.slice();
  let transferred = null;
  let terminated = 0;
  const workerFactory = () => {
    const listeners = new Map();
    return {
      addEventListener(type, listener) { listeners.set(type, listener); },
      postMessage(request, transfer) {
        transferred = { request, transfer };
        queueMicrotask(() => listeners.get('message')?.({
          data: {
            id: request.id,
            ok: true,
            bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
            warnings: ['fixture warning']
          }
        }));
      },
      terminate() { terminated += 1; }
    };
  };
  const result = await convertLegacyOfficeBytes('doc', source, { workerFactory });
  assert.equal(result.usedWorker, true);
  assert.deepEqual(result.warnings, ['fixture warning']);
  assert.equal(transferred.transfer.length, 1);
  assert.strictEqual(transferred.transfer[0], transferred.request.bytes);
  assert.notStrictEqual(transferred.request.bytes, source.buffer, 'the DocumentStore-owned buffer is never transferred');
  assert.equal(terminated, 1);
  assert.deepEqual(source, original);
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

test('FAILURE AND FALLBACK: corrupt or password-locked files stop honestly and originals stay usable', async () => {
  const corruptHost = mount();
  const corruptState = createDocumentViewerState('pptx');
  const corrupt = createPptxViewer({ container: corruptHost, state: corruptState, fileName: 'broken.pptx', loadTimeoutMs: 2000 });
  try {
    await corrupt.load(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    assert.equal(corruptState.status, 'error');
    assert.match(corruptState.error, /corrupted|password-protected|unchanged original/i);
    assert.doesNotMatch(corruptState.error, /loading/i);
  } finally {
    corrupt.destroy();
    removeMount(corruptHost);
  }

  for (const kind of ['doc', 'ppt']) {
    const host = mount();
    const state = createDocumentViewerState(kind);
    const damaged = new Uint8Array(512);
    damaged.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const original = damaged.slice();
    const viewer = createViewerForKind(kind, {
      container: host,
      state,
      fileName: `damaged.${kind}`,
      legacyWorkerFactory: () => null,
      loadTimeoutMs: 2000
    });
    try {
      await viewer.load(damaged);
      assert.equal(state.status, 'error', `${kind} corruption never becomes a false success`);
      assert.match(state.error, /corrupted|password-protected|unsupported legacy objects/i);
      assert.doesNotMatch(state.error, /loading/i);
      assert.deepEqual(damaged, original);
    } finally {
      viewer.destroy();
      removeMount(host);
    }
  }

  const passwordHost = mount();
  const passwordState = createDocumentViewerState('doc');
  const passwordViewer = createLegacyDocViewer({
    container: passwordHost,
    state: passwordState,
    fileName: 'locked.doc',
    moduleLoader: async () => ({ renderAsync: async () => {} }),
    prepareBytes: async () => { throw new Error('Password required'); }
  });
  try {
    await passwordViewer.load(new Uint8Array([1]));
    assert.equal(passwordState.status, 'error');
    assert.match(passwordState.error, /password-protected/i);
    assert.match(passwordState.error, /unchanged original/i);
  } finally {
    passwordViewer.destroy();
    removeMount(passwordHost);
  }

  const fallbackHost = mount();
  const fallbackState = createDocumentViewerState('unsupported');
  let opened = 0;
  const fallback = createUnsupportedViewer({
    container: fallbackHost,
    state: fallbackState,
    fileName: 'unknown.bin',
    onOpenOriginal: () => { opened += 1; }
  });
  try {
    await fallback.load(new Uint8Array([1]));
    assert.equal(fallbackState.status, 'ready');
    assert.match(fallbackHost.textContent, /No safe built-in view/);
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
