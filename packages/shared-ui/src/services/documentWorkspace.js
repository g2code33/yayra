import {
  DOCUMENT_ACCEPT,
  DOCUMENT_ENGINES,
  MAX_DOCUMENT_BYTES,
  classifyDocument,
  documentExtension,
  isAcceptedDocument,
  mimeForDocument,
  routeDocument,
  sniffCompoundOfficeKind,
  sniffDocumentKind,
  supportedDocumentKinds,
  unsupportedDocumentKinds
} from './documentRegistry.js';
import { DEFAULT_PPTX_NOTES_COLOR } from './documentViewers.js';

export {
  DOCUMENT_ACCEPT,
  DOCUMENT_ENGINES,
  MAX_DOCUMENT_BYTES,
  classifyDocument,
  documentExtension,
  isAcceptedDocument,
  mimeForDocument,
  routeDocument,
  sniffCompoundOfficeKind,
  sniffDocumentKind,
  supportedDocumentKinds,
  unsupportedDocumentKinds
};
export {
  createViewerForKind,
  createPptxViewer,
  createLegacyPptViewer,
  createDocxViewer,
  createLegacyDocViewer,
  createSpreadsheetViewer,
  convertLegacyOfficeBytes,
  createImageViewer,
  createTextViewer,
  createUnsupportedViewer,
  DEFAULT_PPTX_NOTES_COLOR,
  normalizePptxNotesColor,
  resolveDocumentSlideshowShortcut,
  resolvePptxSlideshowShortcut
} from './documentViewers.js';

/**
 * YAYRA UNIFIED DOCUMENT WORKSPACE.
 *
 * Design contract (docs/DOCUMENT_WORKSPACE.md):
 *  - Documents open in their OWN tab (`yayra://doc/<id>`) through the
 *    existing tab system, never through the website frame.
 *  - Every engine reports capabilities explicitly; the UI never claims
 *    editing, annotation or export that the engine cannot perform.
 *  - Original bytes remain unchanged. Electron transfers bytes plus an opaque
 *    catalog id but never a source path; web/PWA/mobile recovery uses an
 *    origin-private exact-byte copy keyed by an opaque id.
 *  - All engines are injected/lazy local modules, making them independently
 *    testable and keeping PDF, PPTX, DOCX and spreadsheet rendering offline.
 */

/** Sequence used only to make in-memory tab IDs unique. */
let docSeq = 0;

/**
 * Live in-memory original-file store. Bytes are never rewritten into another
 * format and are released when the last live tab closes. Cross-restart
 * recovery is deliberately separate: opaque desktop catalog ids or
 * profile-scoped origin-private byte copies, never a renderer-visible path.
 */
export class DocumentStore {
  constructor() {
    this._docs = new Map();
  }

  add({ name, bytes, mime = '', libraryId = null }) {
    const size = bytes && Number.isFinite(bytes.byteLength)
      ? bytes.byteLength
      : (bytes && Number.isFinite(bytes.length) ? bytes.length : 0);
    if (size <= 0) throw new Error('empty-document');
    if (size > MAX_DOCUMENT_BYTES) throw new Error('document-too-large');
    const cleanName = String(name || 'document').replace(/[\u0000-\u001f]/g, '').slice(0, 160) || 'document';
    const sniffed = sniffDocumentKind(bytes, cleanName, mime);
    const type = sniffed || classifyDocument(cleanName, mime) || 'unsupported';
    docSeq += 1;
    const id = `doc-${Date.now().toString(36)}-${docSeq}`;
    const doc = {
      id,
      name: cleanName,
      bytes,
      type,
      extension: documentExtension(cleanName),
      mime: String(mime || '').split(';', 1)[0].trim() || mimeForDocument(type, cleanName),
      route: routeDocument(type),
      size,
      // Opaque main-process catalog capability. This is not a path and is
      // useful only through the narrow document bridge.
      libraryId: typeof libraryId === 'string' ? libraryId : null,
      openedAt: Date.now()
    };
    this._docs.set(id, doc);
    return doc;
  }

  get(id) { return this._docs.get(id) || null; }
  remove(id) { return this._docs.delete(id); }
  list() { return [...this._docs.values()]; }
}

/** Default state shape for a document viewer instance. */
export function createDocumentViewerState(kind = 'pdf') {
  const presentation = kind === 'pptx' || kind === 'ppt';
  return {
    viewer: kind,
    status: 'idle', numPages: 0, page: 1, zoom: 1.25,
    zoomMode: presentation ? 'fit-page' : 'custom',
    query: '', matches: [], matchIndex: -1, error: null,
    progress: null, loadingStage: '',
    transformedForViewing: false, conversionWarnings: [], conversionUsedWorker: false,
    rotation: 0,          // 0 | 90 | 180 | 270 where the engine supports it
    night: false,
    outline: [],          // flattened PDF TOC: [{ title, page, depth }]
    sidebarOpen: presentation,
    sidebarTab: presentation ? 'thumbnails' : 'outline',
    showNotes: presentation,
    notesColor: DEFAULT_PPTX_NOTES_COLOR,
    slideshowMode: false,
    slidePending: false,
    searchPending: false,
    searchProgress: null,
    printPending: false,
    printProgress: null,
    sheetNames: [],
    rowPage: 1,
    rowPages: 1
  };
}

/**
 * PDF viewer controller. Renders into a container via the INJECTED
 * pdfjs module (the vendored PDF.js build in production, a fake in
 * tests). All DOM access is guarded so headless environments degrade
 * honestly (status stays 'ready'; painting is skipped where no canvas
 * 2d context exists).
 *
 * State shape (mirrored on the tab so re-renders restore it):
 *   { status, numPages, page, zoom, query, matches, matchIndex, error }
 */
export function createPdfViewer({ pdfjs, container, state, onStateChange = null, loadTimeoutMs = 90000 } = {}) {
  const viewerState = state || createDocumentViewerState('pdf');
  let pdfDoc = null;
  let loadingTask = null;
  let mountedContainer = container || null;
  let stateChange = onStateChange;
  let root = null;
  let loadToken = 0;
  let renderGeneration = 0;
  let activeLoadTimeout = null;
  let scrollHost = null;
  let scrollFrame = null;
  let measurePromise = null;

  const pageShells = new Map();
  const pageCanvases = new Map();
  const textLayers = new Map();
  const renderedKeys = new Map();
  const renderTasks = new Map();
  const rendering = new Set();
  const baseSizes = [];
  const pageTexts = [];
  const textContents = [];
  const RENDER_WINDOW = 2;
  const KEEP_WINDOW = 8;

  const notify = () => { try { stateChange?.(viewerState); } catch { /* optional listener */ } };
  const setState = (patch) => { Object.assign(viewerState, patch); notify(); };
  const clampPage = (value) => Math.min(Math.max(1, Math.round(Number(value) || 1)), Math.max(1, viewerState.numPages || 1));
  const ownerDocument = () => mountedContainer?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  // The same PDF controller powers normal continuous reading and projector
  // mode. Presentation hosts show exactly one page and fit it to the display;
  // normal hosts keep the windowed, selectable continuous document.
  const isPresentationMode = () => Boolean(
    mountedContainer?.classList?.contains?.('fb-document-slideshow-host')
    || mountedContainer?.classList?.contains?.('fb-pptx-slideshow-host')
  );

  function removeFromParent(element) {
    if (!element?.parentElement) return;
    try { element.parentElement.removeChild(element); } catch { /* native append will move it */ }
  }

  function clearElement(element) {
    if (!element) return;
    if (typeof element.replaceChildren === 'function') element.replaceChildren();
    else element.innerHTML = '';
  }

  function scaledSize(pageNumber) {
    const base = baseSizes[pageNumber - 1] || baseSizes[0] || { width: 612, height: 792 };
    const swapped = (viewerState.rotation || 0) % 180 !== 0;
    return {
      width: Math.max(1, Math.floor((swapped ? base.height : base.width) * (viewerState.zoom || 1))),
      height: Math.max(1, Math.floor((swapped ? base.width : base.height) * (viewerState.zoom || 1)))
    };
  }

  function styleRoot() {
    if (!root) return;
    root.classList?.toggle?.('is-slideshow', isPresentationMode());
    root.style.cssText = isPresentationMode()
      ? 'width:100%;height:100%;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;overflow:hidden;'
      : 'width:max-content;min-width:100%;min-height:100%;display:flex;flex-direction:column;align-items:center;box-sizing:border-box;padding:4px 8px 24px;';
  }

  function stylePageShell(shell, pageNumber) {
    const size = scaledSize(pageNumber);
    shell.style.width = `${size.width}px`;
    shell.style.height = `${size.height}px`;
    const presenting = isPresentationMode();
    shell.style.cssText = presenting
      ? `position:relative;flex:0 0 auto;width:${size.width}px;height:${size.height}px;margin:0;background:#fff;box-shadow:0 0 70px rgba(0,0,0,.72);border-radius:2px;overflow:hidden;display:${pageNumber === clampPage(viewerState.page) ? 'block' : 'none'};content-visibility:visible;`
      : `position:relative;flex:0 0 auto;width:${size.width}px;height:${size.height}px;margin:0 auto 16px;background:#fff;box-shadow:0 6px 26px rgba(0,0,0,.28);border-radius:2px;overflow:hidden;content-visibility:auto;`;
    // Keep the visibility state explicit as well as in cssText. Besides being
    // friendlier to limited embedders/test DOMs, this prevents a stale inline
    // display value from surviving the move back to continuous reading.
    shell.style.display = presenting
      ? (pageNumber === clampPage(viewerState.page) ? 'block' : 'none')
      : 'block';
  }

  function buildPages() {
    const doc = ownerDocument();
    if (!mountedContainer || !doc || typeof doc.createElement !== 'function' || !viewerState.numPages) return null;
    if (root) {
      removeFromParent(root);
      mountedContainer.appendChild?.(root);
      styleRoot();
      refreshPageBoxes();
      return root;
    }
    root = doc.createElement('div');
    root.className = 'fb-pdf-continuous-pages';
    styleRoot();
    pageShells.clear();
    pageCanvases.clear();
    textLayers.clear();
    for (let pageNumber = 1; pageNumber <= viewerState.numPages; pageNumber += 1) {
      const shell = doc.createElement('section');
      shell.className = 'fb-pdf-page';
      shell.dataset.page = String(pageNumber);
      shell.setAttribute?.('aria-label', `PDF page ${pageNumber}`);
      stylePageShell(shell, pageNumber);

      const canvas = doc.createElement('canvas');
      canvas.className = 'fb-doc-canvas fb-pdf-page-canvas';
      canvas.dataset.page = String(pageNumber);
      canvas.style.cssText = 'position:absolute;inset:0;display:block;z-index:1;';
      if (viewerState.night) canvas.style.cssText += 'filter:invert(1) hue-rotate(180deg);';

      const textLayer = doc.createElement('div');
      textLayer.className = 'fb-pdf-text-layer';
      textLayer.dataset.page = String(pageNumber);
      textLayer.style.cssText = 'position:absolute;inset:0;z-index:2;overflow:hidden;line-height:1;transform-origin:0 0;-webkit-text-size-adjust:none;text-size-adjust:none;';

      const label = doc.createElement('span');
      label.className = 'fb-pdf-page-number';
      label.textContent = String(pageNumber);
      label.style.cssText = 'position:absolute;right:7px;bottom:6px;z-index:3;padding:2px 5px;border-radius:5px;background:rgba(255,255,255,.8);color:#64748b;font:700 10px system-ui;pointer-events:none;';

      shell.appendChild?.(canvas);
      shell.appendChild?.(textLayer);
      shell.appendChild?.(label);
      root.appendChild?.(shell);
      pageShells.set(pageNumber, shell);
      pageCanvases.set(pageNumber, canvas);
      textLayers.set(pageNumber, textLayer);
    }
    clearElement(mountedContainer);
    mountedContainer.appendChild?.(root);
    bindScroll();
    return root;
  }

  function refreshPageBoxes() {
    styleRoot();
    for (const [pageNumber, shell] of pageShells) stylePageShell(shell, pageNumber);
  }

  function bindScroll() {
    const nextHost = mountedContainer;
    if (scrollHost === nextHost) return;
    if (scrollHost && typeof scrollHost.removeEventListener === 'function') scrollHost.removeEventListener('scroll', onScroll);
    scrollHost = nextHost;
    if (scrollHost && typeof scrollHost.addEventListener === 'function') scrollHost.addEventListener('scroll', onScroll, { passive: true });
  }

  function pageNearestViewport() {
    if (isPresentationMode()) return viewerState.page || 1;
    if (!mountedContainer || !pageShells.size) return viewerState.page || 1;
    const hostRect = mountedContainer.getBoundingClientRect?.();
    const target = hostRect && Number.isFinite(hostRect.top)
      ? hostRect.top + (Number(hostRect.height || mountedContainer.clientHeight || 0) * 0.42)
      : null;
    if (target === null) return viewerState.page || 1;
    let best = viewerState.page || 1;
    let distance = Infinity;
    for (const [pageNumber, shell] of pageShells) {
      const rect = shell.getBoundingClientRect?.();
      if (!rect) continue;
      const centre = Number(rect.top || 0) + Number(rect.height || 0) / 2;
      const next = Math.abs(centre - target);
      if (next < distance) { distance = next; best = pageNumber; }
    }
    return best;
  }

  function onScroll() {
    if (scrollFrame !== null) return;
    const run = () => {
      scrollFrame = null;
      const page = pageNearestViewport();
      if (page !== viewerState.page) setState({ page });
      void renderWindow(page);
    };
    if (typeof requestAnimationFrame === 'function') scrollFrame = requestAnimationFrame(run);
    else scrollFrame = setTimeout(run, 0);
  }

  async function ensureBaseSize(pageNumber) {
    if (baseSizes[pageNumber - 1]) return baseSizes[pageNumber - 1];
    if (!pdfDoc) return null;
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const size = { width: viewport.width || 612, height: viewport.height || 792 };
      baseSizes[pageNumber - 1] = size;
      const shell = pageShells.get(pageNumber);
      if (shell) stylePageShell(shell, pageNumber);
      return size;
    } catch {
      const fallback = baseSizes[pageNumber - 2] || baseSizes[0] || { width: 612, height: 792 };
      baseSizes[pageNumber - 1] = fallback;
      return fallback;
    }
  }

  async function measureAllPages(token) {
    if (!pdfDoc) return;
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      if (token !== loadToken || !pdfDoc) return;
      await ensureBaseSize(pageNumber);
      if (pageNumber % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token === loadToken) {
      refreshPageBoxes();
      setState({ pagesMeasured: baseSizes.length });
    }
  }

  function clearTextLayer(layer) {
    if (!layer) return;
    if (typeof layer.replaceChildren === 'function') layer.replaceChildren();
    else layer.innerHTML = '';
  }

  function paintSearchMarks(pageNumber) {
    const layer = textLayers.get(pageNumber);
    const query = String(viewerState.query || '').trim();
    if (!layer || !query || typeof layer.querySelectorAll !== 'function') return;
    // The PDF.js text layer is rebuilt on every scale change. Keeping search
    // highlights as a translucent page badge avoids mutating its positioned
    // spans while still making every matching page immediately discoverable.
    const matching = (viewerState.matches || []).some((match) => match.page === pageNumber);
    const shell = pageShells.get(pageNumber);
    if (shell) shell.style.outline = matching ? '2px solid rgba(250,204,21,.8)' : '';
  }

  async function renderTextLayer(pageNumber, page, viewport) {
    const layer = textLayers.get(pageNumber);
    if (!layer || typeof page.getTextContent !== 'function') return;
    try {
      const content = textContents[pageNumber - 1] || await page.getTextContent();
      textContents[pageNumber - 1] = content;
      pageTexts[pageNumber - 1] = (content.items || []).map((item) => String(item.str || '')).join(' ');
      clearTextLayer(layer);
      layer.style.setProperty?.('--scale-factor', String(viewport.scale || viewerState.zoom || 1));
      layer.style.width = `${Math.floor(viewport.width)}px`;
      layer.style.height = `${Math.floor(viewport.height)}px`;
      if (typeof pdfjs.renderTextLayer === 'function') {
        await pdfjs.renderTextLayer({ textContentSource: content, container: layer, viewport }).promise;
      } else if (typeof pdfjs.TextLayer === 'function' && viewport.rawDims) {
        const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
        await textLayer.render();
      }
      paintSearchMarks(pageNumber);
    } catch { /* text selection/search remains best-effort; pixels still render */ }
  }

  async function renderPage(pageNumber, force = false) {
    if (!pdfDoc || viewerState.status !== 'ready') return;
    const generation = renderGeneration;
    const canvas = pageCanvases.get(pageNumber);
    if (!canvas) return;
    const key = `${Number(viewerState.zoom || 1).toFixed(3)}|${viewerState.rotation || 0}|${viewerState.night ? 1 : 0}`;
    if (!force && renderedKeys.get(pageNumber) === key) { paintSearchMarks(pageNumber); return; }
    if (rendering.has(pageNumber)) return;
    rendering.add(pageNumber);
    try { renderTasks.get(pageNumber)?.cancel?.(); } catch { /* old task settled */ }
    try {
      const page = await pdfDoc.getPage(pageNumber);
      if (generation !== renderGeneration || !pdfDoc) return;
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale: viewerState.zoom || 1, rotation });
      baseSizes[pageNumber - 1] ||= (() => {
        const base = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
        return { width: base.width || 612, height: base.height || 792 };
      })();
      const shell = pageShells.get(pageNumber);
      if (shell) {
        shell.style.width = `${Math.floor(viewport.width)}px`;
        shell.style.height = `${Math.floor(viewport.height)}px`;
      }
      const ratio = Math.min(Number(globalThis.devicePixelRatio || globalThis.window?.devicePixelRatio || 1), 2);
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.style.cssText = `position:absolute;inset:0;display:block;z-index:1;width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px;${viewerState.night ? 'filter:invert(1) hue-rotate(180deg);' : ''}`;
      const context = canvas.getContext?.('2d', { alpha: false });
      if (!context) return;
      context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
      const task = page.render({ canvasContext: context, viewport });
      renderTasks.set(pageNumber, task);
      await task.promise;
      if (generation !== renderGeneration || !pdfDoc) return;
      renderedKeys.set(pageNumber, key);
      await renderTextLayer(pageNumber, page, viewport);
      if (pageNumber === viewerState.page) setState({ pagePainted: pageNumber });
    } catch (error) {
      if (String(error?.name || '') !== 'RenderingCancelledException') console.warn?.('[yayra:pdf] page render failed', pageNumber, error);
    } finally {
      rendering.delete(pageNumber);
      renderTasks.delete(pageNumber);
    }
  }

  async function renderWindow(centre = viewerState.page || 1, force = false) {
    if (!pdfDoc || viewerState.status !== 'ready') return;
    buildPages();
    const current = clampPage(centre);
    const first = Math.max(1, current - RENDER_WINDOW);
    const last = Math.min(viewerState.numPages, current + RENDER_WINDOW);
    const jobs = [];
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) jobs.push(renderPage(pageNumber, force));
    for (const [pageNumber, canvas] of pageCanvases) {
      if (Math.abs(pageNumber - current) <= KEEP_WINDOW) continue;
      try { renderTasks.get(pageNumber)?.cancel?.(); } catch { /* settled */ }
      renderedKeys.delete(pageNumber);
      if (canvas) { canvas.width = 1; canvas.height = 1; }
      clearTextLayer(textLayers.get(pageNumber));
    }
    await Promise.all(jobs);
  }

  async function load(bytes) {
    const token = ++loadToken;
    renderGeneration += 1;
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
      setState({ status: 'error', progress: null, loadingStage: '', error: 'The PDF reader is unavailable. Try again or open this file with your desktop PDF app.' });
      return viewerState;
    }
    setState({ viewer: 'pdf', status: 'loading', progress: null, loadingStage: 'Preparing PDF…', error: null, matches: [], matchIndex: -1, pagesMeasured: 0 });
    let task = null;
    let timeoutId = null;
    let timedOut = false;
    try {
      const data = bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes.slice(0))
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          : new Uint8Array(bytes || []);
      task = pdfjs.getDocument({ data });
      loadingTask = task;
      if (task && typeof task === 'object') {
        task.onProgress = ({ loaded, total } = {}) => {
          if (token !== loadToken || timedOut) return;
          const progress = Number.isFinite(loaded) && Number.isFinite(total) && total > 0
            ? Math.max(0, Math.min(99, Math.round((loaded / total) * 100)))
            : null;
          setState({ progress, loadingStage: 'Reading PDF…' });
        };
      }
      const documentPromise = task?.promise || Promise.resolve(task);
      const guarded = Number.isFinite(loadTimeoutMs) && loadTimeoutMs > 0
        ? Promise.race([
            documentPromise,
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                const error = new Error('PDF load timed out');
                error.name = 'PDFLoadTimeoutError';
                reject(error);
              }, loadTimeoutMs);
              activeLoadTimeout = timeoutId;
              timeoutId?.unref?.();
            })
          ])
        : documentPromise;
      pdfDoc = await guarded;
      if (token !== loadToken) return viewerState;
      const total = Math.max(1, pdfDoc?.numPages || 1);
      viewerState.numPages = total;
      viewerState.page = clampPage(viewerState.page || 1);
      await ensureBaseSize(viewerState.page);
      setState({ status: 'ready', progress: 100, loadingStage: '', numPages: total, page: viewerState.page, engineName: 'PDF.js (bundled)' });
      buildPages();
      await renderWindow(viewerState.page, true);
      // Measure the remaining page boxes after the first visible window is
      // painted. This is the reference viewer's key responsiveness rule.
      measurePromise = measureAllPages(token).catch(() => {});
    } catch (error) {
      if (token !== loadToken) return viewerState;
      const name = String(error?.name || '');
      if (name === 'PDFLoadTimeoutError') {
        try { task?.destroy?.(); } catch { /* worker already gone */ }
        if (loadingTask === task) loadingTask = null;
        setState({ status: 'error', progress: null, loadingStage: '', error: 'This PDF is taking too long to open. Try again or use Desktop app to open it externally.' });
      } else if (name === 'PasswordException') {
        setState({ status: 'password', progress: null, loadingStage: '', error: 'This PDF is password-protected. Unlocking encrypted PDFs is not available yet.' });
      } else {
        setState({ status: 'error', progress: null, loadingStage: '', error: 'This file could not be opened as a PDF - it may be damaged or not a PDF at all.' });
      }
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (activeLoadTimeout === timeoutId) activeLoadTimeout = null;
    }
    return viewerState;
  }

  async function setPage(value) {
    if (viewerState.status !== 'ready') return viewerState;
    const page = clampPage(value);
    setState({ page });
    refreshPageBoxes();
    // PDF pages may have different proportions. Re-fit each newly presented
    // page instead of carrying a landscape page's scale into a portrait page.
    if (isPresentationMode() && viewerState.zoomMode === 'fit-page') {
      await fitToPage();
      return viewerState;
    }
    await renderWindow(page);
    if (!isPresentationMode()) pageShells.get(page)?.scrollIntoView?.({ behavior: 'auto', block: 'start', inline: 'center' });
    return viewerState;
  }
  const nextPage = () => setPage((viewerState.page || 1) + 1);
  const prevPage = () => setPage((viewerState.page || 1) - 1);

  async function setZoom(value) {
    // Very tall pages still need to fit on a short projector/mobile display;
    // preserve the established 50% reader floor outside slideshow mode.
    const minimumZoom = isPresentationMode() ? 0.1 : 0.5;
    const zoom = Math.min(4, Math.max(minimumZoom, Number(value) || 1));
    renderGeneration += 1;
    for (const task of renderTasks.values()) { try { task.cancel?.(); } catch { /* settled */ } }
    rendering.clear();
    renderedKeys.clear();
    setState({ zoom, zoomMode: 'custom' });
    refreshPageBoxes();
    await renderWindow(viewerState.page, true);
    return viewerState;
  }

  async function rotate(delta = 90) {
    renderGeneration += 1;
    for (const task of renderTasks.values()) { try { task.cancel?.(); } catch { /* settled */ } }
    rendering.clear();
    renderedKeys.clear();
    setState({ rotation: (((viewerState.rotation || 0) + delta) % 360 + 360) % 360 });
    refreshPageBoxes();
    await renderWindow(viewerState.page, true);
    return viewerState;
  }

  async function setNight(enabled) {
    setState({ night: Boolean(enabled) });
    for (const canvas of pageCanvases.values()) {
      canvas.style.filter = viewerState.night ? 'invert(1) hue-rotate(180deg)' : '';
    }
    return viewerState;
  }

  async function fitToWidth() {
    const width = mountedContainer && (mountedContainer.clientWidth || mountedContainer.parentElement?.clientWidth);
    if (!width || !pdfDoc) return viewerState;
    try {
      const page = await pdfDoc.getPage(viewerState.page);
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale: 1, rotation });
      const gutter = isPresentationMode() ? 8 : 32;
      await setZoom(Math.min(4, (width - gutter) / viewport.width));
      setState({ zoomMode: 'fit-width' });
    } catch { /* keep current zoom */ }
    return viewerState;
  }

  async function fitToPage() {
    const box = mountedContainer?.parentElement || mountedContainer;
    const width = box && (box.clientWidth || mountedContainer?.clientWidth || box.parentElement?.clientWidth);
    const height = box && (box.clientHeight || mountedContainer?.clientHeight || box.parentElement?.clientHeight);
    if (!width || !height || !pdfDoc) return viewerState;
    try {
      const page = await pdfDoc.getPage(viewerState.page);
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale: 1, rotation });
      const gutter = isPresentationMode() ? 8 : 32;
      await setZoom(Math.min(4, Math.min((width - gutter) / viewport.width, (height - gutter) / viewport.height)));
      setState({ zoomMode: 'fit-page' });
    } catch { /* keep current zoom */ }
    return viewerState;
  }

  async function loadOutline() {
    if (!pdfDoc || typeof pdfDoc.getOutline !== 'function') return [];
    let raw = [];
    try { raw = await pdfDoc.getOutline() || []; } catch { raw = []; }
    const outline = [];
    const walk = async (items, depth) => {
      for (const item of items || []) {
        let page = null;
        try {
          let destination = item.dest;
          if (typeof destination === 'string' && typeof pdfDoc.getDestination === 'function') destination = await pdfDoc.getDestination(destination);
          if (Array.isArray(destination) && destination[0] !== undefined && typeof pdfDoc.getPageIndex === 'function') page = (await pdfDoc.getPageIndex(destination[0])) + 1;
        } catch { /* preserve an unresolvable title */ }
        outline.push({ title: String(item?.title || 'Section'), page, depth });
        if (item?.items?.length && depth < 8) await walk(item.items, depth + 1);
      }
    };
    await walk(raw, 0);
    setState({ outline });
    return outline;
  }

  async function textForPage(pageNumber) {
    if (pageTexts[pageNumber - 1] !== undefined) return pageTexts[pageNumber - 1];
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const content = await page.getTextContent();
      textContents[pageNumber - 1] = content;
      const text = (content.items || []).map((item) => String(item.str || '')).join(' ');
      pageTexts[pageNumber - 1] = text;
      return text;
    } catch { pageTexts[pageNumber - 1] = ''; return ''; }
  }

  async function search(query) {
    const q = String(query || '').trim();
    setState({ query: q, matches: [], matchIndex: -1, searchPending: Boolean(q) });
    if (!q || !pdfDoc || viewerState.status !== 'ready') { setState({ searchPending: false }); return viewerState; }
    const needle = q.toLocaleLowerCase();
    const matches = [];
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages && matches.length < 500; pageNumber += 1) {
      const text = await textForPage(pageNumber);
      const lower = text.toLocaleLowerCase();
      let index = lower.indexOf(needle);
      while (index >= 0 && matches.length < 500) {
        const start = Math.max(0, index - 36);
        matches.push({ page: pageNumber, index, snippet: text.slice(start, index + q.length + 52).trim() });
        index = lower.indexOf(needle, index + Math.max(needle.length, 1));
      }
      if (pageNumber % 4 === 0) {
        setState({ searchProgress: Math.round((pageNumber / pdfDoc.numPages) * 100) });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    setState({ matches, matchIndex: matches.length ? 0 : -1, searchPending: false, searchProgress: null });
    for (let pageNumber = 1; pageNumber <= viewerState.numPages; pageNumber += 1) paintSearchMarks(pageNumber);
    if (matches.length) await setPage(matches[0].page);
    return viewerState;
  }

  function nextMatch() {
    if (!viewerState.matches?.length) return viewerState;
    const matchIndex = ((viewerState.matchIndex || 0) + 1) % viewerState.matches.length;
    setState({ matchIndex });
    void setPage(viewerState.matches[matchIndex].page);
    return viewerState;
  }

  async function renderThumbnail(pageNumber, target) {
    if (!pdfDoc || !target) return;
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const width = Math.max(80, Number(target.clientWidth || 130) - 8);
      const viewport = page.getViewport({ scale: width / base.width, rotation: page.rotate || 0 });
      const doc = target.ownerDocument || ownerDocument();
      const canvas = doc.createElement('canvas');
      canvas.className = 'fb-pdf-thumbnail-canvas';
      const ratio = Math.min(Number(globalThis.devicePixelRatio || 1), 1.5);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext?.('2d', { alpha: false });
      if (!context) return;
      context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      clearElement(target);
      target.appendChild?.(canvas);
      const label = doc.createElement('div');
      label.textContent = String(pageNumber);
      label.style.cssText = 'padding:3px 0;color:var(--fb-text-secondary,#9aa3b2);font-size:.7rem;';
      target.appendChild?.(label);
    } catch { /* numbered tile remains */ }
  }

  /** Paint every page before the browser's print snapshot. Normal viewing
   *  deliberately keeps only a small canvas window; printing is the one
   *  operation that needs a complete, short-lived set of page pixels. */
  async function preparePrint() {
    if (!pdfDoc || viewerState.status !== 'ready') return false;
    const token = loadToken;
    setState({ printPending: true, loadingStage: 'Preparing pages for print…' });
    try {
      for (let first = 1; first <= viewerState.numPages; first += 3) {
        if (token !== loadToken || !pdfDoc) return false;
        const jobs = [];
        for (let page = first; page < first + 3 && page <= viewerState.numPages; page += 1) jobs.push(renderPage(page, true));
        await Promise.all(jobs);
        setState({ printProgress: Math.round((Math.min(first + 2, viewerState.numPages) / viewerState.numPages) * 100) });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      setState({ printPending: false, printProgress: 100, loadingStage: '' });
      return true;
    } catch {
      setState({ printPending: false, printProgress: null, loadingStage: '' });
      return false;
    }
  }

  async function finishPrint() {
    setState({ printPending: false, printProgress: null, loadingStage: '' });
    await renderWindow(viewerState.page || 1);
  }

  async function renderCurrent() {
    return renderWindow(viewerState.page, true);
  }

  function handleKeydown(event) {
    if (!event) return null;
    const tag = String(event.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return null;
    const key = String(event.key || '');
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f') return 'focus-search';
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (['ArrowRight', 'PageDown', ' '].includes(key)) { void nextPage(); return 'page'; }
    if (['ArrowLeft', 'PageUp'].includes(key)) { void prevPage(); return 'page'; }
    if (key === 'Home') { void setPage(1); return 'page'; }
    if (key === 'End') { void setPage(viewerState.numPages || 1); return 'page'; }
    if (key === '+' || key === '=') { void setZoom((viewerState.zoom || 1) + 0.25); return 'zoom'; }
    if (key === '-' || key === '_') { void setZoom((viewerState.zoom || 1) - 0.25); return 'zoom'; }
    if (key === '0') { void setZoom(1); return 'zoom'; }
    if (key.toLowerCase() === 'r') { void rotate(90); return 'rotate'; }
    if (key.toLowerCase() === 'n') { void setNight(!viewerState.night); return 'night'; }
    if (key.toLowerCase() === 'f') { void fitToWidth(); return 'fit'; }
    return null;
  }

  function attach(nextContainer, nextStateChange = null) {
    if (scrollHost && scrollHost !== nextContainer && typeof scrollHost.removeEventListener === 'function') scrollHost.removeEventListener('scroll', onScroll);
    mountedContainer = nextContainer || null;
    if (typeof nextStateChange === 'function') stateChange = nextStateChange;
    if (root && mountedContainer) {
      removeFromParent(root);
      clearElement(mountedContainer);
      mountedContainer.appendChild?.(root);
      bindScroll();
      refreshPageBoxes();
      void renderWindow(viewerState.page);
    } else if (pdfDoc && viewerState.status === 'ready') {
      buildPages();
      void renderWindow(viewerState.page);
    }
    notify();
    return Promise.resolve(viewerState);
  }

  function destroy() {
    loadToken += 1;
    renderGeneration += 1;
    if (activeLoadTimeout !== null) clearTimeout(activeLoadTimeout);
    activeLoadTimeout = null;
    if (scrollHost && typeof scrollHost.removeEventListener === 'function') scrollHost.removeEventListener('scroll', onScroll);
    if (scrollFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollFrame);
      else clearTimeout(scrollFrame);
    }
    scrollFrame = null;
    for (const task of renderTasks.values()) { try { task.cancel?.(); } catch { /* settled */ } }
    renderTasks.clear();
    rendering.clear();
    try {
      const cleanup = typeof loadingTask?.destroy === 'function' ? loadingTask.destroy() : pdfDoc?.destroy?.();
      cleanup?.catch?.(() => {});
    } catch { /* already gone */ }
    loadingTask = null;
    pdfDoc = null;
    measurePromise = null;
    clearElement(mountedContainer);
    root = null;
    mountedContainer = null;
    scrollHost = null;
    pageShells.clear(); pageCanvases.clear(); textLayers.clear(); renderedKeys.clear();
    baseSizes.length = 0; pageTexts.length = 0; textContents.length = 0;
    setState({ status: 'idle', numPages: 0, page: 1, progress: null, loadingStage: '', matches: [], matchIndex: -1, searchPending: false, printPending: false, printProgress: null });
  }

  return {
    get state() { return viewerState; },
    load, attach, setPage, nextPage, prevPage, setZoom, search, nextMatch,
    renderCurrent, renderThumbnail, destroy, rotate, setNight, loadOutline,
    fitToWidth, fitToPage, preparePrint, finishPrint, handleKeydown
  };
}
