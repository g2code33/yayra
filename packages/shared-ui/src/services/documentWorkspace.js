/**
 * YAYRA DOCUMENT WORKSPACE - the core abstraction (Phase 1: PDF).
 *
 * Design contract (docs/DOCUMENT_WORKSPACE.md):
 *  - Documents open in their OWN tab (`yayra://doc/<id>`) through the
 *    existing tab system - never by navigating a browsing tab away from
 *    its site.
 *  - Every engine reports its capabilities EXPLICITLY. The UI never
 *    implies an operation the engine does not support (no placeholder
 *    buttons for editing/annotation/export).
 *  - Documents are local-first: bytes live in memory in the renderer
 *    (Electron: chosen through the native dialog in the main process and
 *    transferred WITHOUT the file path; web/Android: the standard file
 *    input). No account, no backend, no cloud.
 *  - The PDF engine (PDF.js, Apache-2.0 - vendored under
 *    packages/shared-ui/src/vendor/pdfjs/) is INJECTED into the viewer so
 *    the viewer logic is unit-testable without a browser canvas.
 */

/** The document-engine registry. Formats without an engine yet are
 *  intentionally absent - the UI says "on the roadmap" instead of
 *  pretending. Capabilities are per-format facts, not guesses. */
export const DOCUMENT_ENGINES = Object.freeze({
  pdf: Object.freeze({
    label: 'PDF document',
    extensions: Object.freeze(['pdf']),
    mimeTypes: Object.freeze(['application/pdf']),
    /** What the PDF engine can HONESTLY do (updated Phase 2 viewer). */
    capabilities: Object.freeze({
      view: true,       // full-page rendering with zoom
      search: true,     // text search across pages (text layer extraction)
      zoom: true,
      pageNavigation: true,
      rotate: true,     // 90-degree rotation steps
      nightMode: true,  // inverted reading mode for the dark
      outline: true,    // document table of contents (when the PDF has one)
      thumbnails: true, // page thumbnail sidebar
      annotate: false,  // roadmap
      edit: false,      // not applicable to PDF in this architecture
      save: false,
      export: false,
      print: false      // roadmap (Electron printToPDF/toPrinter)
    })
  })
});

/** Classify a file name into a supported document type, or null. */
export function classifyDocument(fileName) {
  const m = /\.([a-z0-9]+)$/i.exec(String(fileName || '').trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  for (const [type, engine] of Object.entries(DOCUMENT_ENGINES)) {
    if (engine.extensions.includes(ext)) return type;
  }
  return null;
}

/** The human-side fact for honest UI: what is NOT supported yet. */
export function unsupportedDocumentKinds() {
  return ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
}

let docSeq = 0;

/**
 * In-memory document store. Holds the bytes the user explicitly opened -
 * nothing is written to disk, no paths are kept, nothing survives a
 * restart (the session snapshot deliberately excludes document tabs).
 */
export class DocumentStore {
  constructor() {
    this._docs = new Map();
  }

  /** Add a document; returns { id, name, bytes, type, size, openedAt }. */
  add({ name, bytes }) {
    if (!bytes || (bytes.byteLength !== undefined && bytes.byteLength === 0)) {
      throw new Error('empty-document');
    }
    const cleanName = String(name || 'document.pdf').slice(0, 120);
    const type = classifyDocument(cleanName) || 'pdf';
    docSeq += 1;
    const id = `doc-${Date.now().toString(36)}-${docSeq}`;
    const doc = {
      id,
      name: cleanName,
      bytes,
      type,
      size: bytes.byteLength !== undefined ? bytes.byteLength : bytes.length,
      openedAt: Date.now()
    };
    this._docs.set(id, doc);
    return doc;
  }

  get(id) {
    return this._docs.get(id) || null;
  }

  remove(id) {
    return this._docs.delete(id);
  }

  list() {
    return [...this._docs.values()];
  }
}

/** Default state shape for a document viewer instance. */
export function createDocumentViewerState() {
  return {
    status: 'idle', numPages: 0, page: 1, zoom: 1.25,
    query: '', matches: [], matchIndex: -1, error: null,
    rotation: 0,          // 0 | 90 | 180 | 270 (user rotation steps)
    night: false,         // inverted reading mode
    outline: [],          // flattened TOC: [{ title, page, depth }]
    sidebarOpen: false,
    sidebarTab: 'outline' // 'outline' | 'thumbnails'
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
export function createPdfViewer({ pdfjs, container, state, onStateChange = null } = {}) {
  const viewerState = state || createDocumentViewerState();
  let pdfDoc = null;
  let loadToken = 0;

  const notify = () => { try { onStateChange?.(viewerState); } catch { /* listener is optional */ } };
  const setState = (patch) => { Object.assign(viewerState, patch); notify(); };

  const clampPage = (n) => Math.min(Math.max(1, n), Math.max(1, viewerState.numPages || 1));

  async function load(bytes) {
    const token = ++loadToken;
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
      setState({ status: 'error', error: 'engine-unavailable' });
      return viewerState;
    }
    setState({ status: 'loading', error: null, matches: [], matchIndex: -1 });
    try {
      // Copy into a plain Uint8Array: PDF.js DETACHES the buffer it is
      // given (transfers it to the worker), which would neuter the
      // renderer's copy for later re-renders.
      const data = bytes.byteLength !== undefined
        ? new Uint8Array(bytes.slice(0))
        : new Uint8Array(Buffer.from(bytes));
      const task = pdfjs.getDocument({ data });
      pdfDoc = await (task.promise ? task.promise : task);
      if (token !== loadToken) return viewerState; // superseded by a newer load
      setState({ status: 'ready', numPages: pdfDoc.numPages || 1, page: clampPage(viewerState.page || 1) });
      await renderCurrent();
    } catch (err) {
      if (token !== loadToken) return viewerState;
      const name = err && err.name ? String(err.name) : '';
      if (name === 'PasswordException') {
        setState({ status: 'password', error: 'This PDF is password-protected. Unlocking encrypted PDFs is not available yet.' });
      } else {
        setState({ status: 'error', error: 'This file could not be opened as a PDF - it may be damaged or not a PDF at all.' });
      }
    }
    return viewerState;
  }

  async function renderCurrent() {
    if (!pdfDoc || viewerState.status !== 'ready') return;
    const pageNum = clampPage(viewerState.page);
    try {
      const page = await pdfDoc.getPage(pageNum);
      const scale = Math.min(4, Math.max(0.5, viewerState.zoom));
      // User rotation adds to the page's own default rotation.
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale, rotation });
      // Paint only where a real canvas exists (skipped in headless tests).
      if (container && typeof container.ownerDocument !== 'undefined' && viewerState.status === 'ready') {
        try {
          const canvas = container.ownerDocument.createElement('canvas');
          if (typeof canvas.getContext === 'function') {
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            // Night reading mode: invert luminance but keep hues usable
            // (the classic dark-PDF trick - white pages become near-black
            // without mangling colored diagrams).
            canvas.style.cssText = 'max-width:100%; height:auto; box-shadow:0 8px 30px rgba(0,0,0,0.5); background:#fff;'
              + (viewerState.night ? ' filter:invert(1) hue-rotate(180deg);' : '');
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const prev = container.querySelector ? container.querySelector('.fb-doc-canvas') : null;
              if (prev && prev.remove) prev.remove();
              if (container.appendChild) container.appendChild(canvas);
              await page.render({ canvasContext: ctx, viewport }).promise;
            }
          }
        } catch { /* headless environment - state stays authoritative */ }
      }
    } catch { /* page render failures keep the last good paint */ }
  }

  async function setPage(n) {
    if (viewerState.status !== 'ready') return viewerState;
    setState({ page: clampPage(n) });
    await renderCurrent();
    return viewerState;
  }

  async function nextPage() { return setPage((viewerState.page || 1) + 1); }
  async function prevPage() { return setPage((viewerState.page || 1) - 1); }

  async function setZoom(z) {
    const zoom = Math.min(4, Math.max(0.5, Number(z) || 1));
    setState({ zoom });
    await renderCurrent();
    return viewerState;
  }

  /** Rotate the view in 90-degree steps (cumulative, wraps at 360). */
  async function rotate(delta = 90) {
    setState({ rotation: (((viewerState.rotation || 0) + delta) % 360 + 360) % 360 });
    await renderCurrent();
    return viewerState;
  }

  /** Night reading mode (inverted canvas). */
  async function setNight(enabled) {
    if (viewerState.night === Boolean(enabled)) return viewerState;
    setState({ night: Boolean(enabled) });
    await renderCurrent();
    return viewerState;
  }

  /**
   * Loads the document's table of contents (outline), flattened with
   * depth for indentation and best-effort page numbers resolved from
   * each destination. PDFs without an outline get an empty list - the
   * sidebar shows the honest empty state.
   */
  async function loadOutline() {
    if (!pdfDoc || typeof pdfDoc.getOutline !== 'function') return [];
    let raw = [];
    try { raw = await pdfDoc.getOutline(); } catch { raw = []; }
    const out = [];
    const walk = async (items, depth) => {
      for (const item of raw ? items : []) {
        if (!item) continue;
        let pageNumber = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string' && typeof pdfDoc.getDestination === 'function') {
            dest = await pdfDoc.getDestination(dest);
          }
          if (Array.isArray(dest) && dest[0] !== undefined && typeof pdfDoc.getPageIndex === 'function') {
            pageNumber = (await pdfDoc.getPageIndex(dest[0])) + 1;
          }
        } catch { /* unresolvable destination - keep the title, no jump */ }
        out.push({ title: String(item.title || 'Section'), page: pageNumber, depth });
        if (Array.isArray(item.items) && item.items.length && depth < 8) await walk(item.items, depth + 1);
      }
    };
    await walk(raw || [], 0);
    setState({ outline: out });
    return out;
  }

  /** Fit the page to the container's width (accounting for rotation). */
  async function fitToWidth() {
    const width = container && (container.clientWidth || (container.parentElement && container.parentElement.clientWidth));
    if (!width || !pdfDoc) return viewerState;
    try {
      const page = await pdfDoc.getPage(viewerState.page);
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      const target = Math.max(0.5, Math.min(4, (width - 32) / base.width));
      setState({ zoom: target });
      await renderCurrent();
    } catch { /* headless - nothing to fit */ }
    return viewerState;
  }

  /** Fit the whole page inside the container (width AND height). */
  async function fitToPage() {
    const box = container && (container.parentElement || container);
    const width = box && (box.clientWidth || (box.parentElement && box.parentElement.clientWidth));
    const height = box && (box.clientHeight || (box.parentElement && box.parentElement.clientHeight));
    if (!width || !height || !pdfDoc) return viewerState;
    try {
      const page = await pdfDoc.getPage(viewerState.page);
      const rotation = ((page.rotate || 0) + (viewerState.rotation || 0)) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      const target = Math.max(0.5, Math.min(4, Math.min((width - 32) / base.width, (height - 32) / base.height)));
      setState({ zoom: target });
      await renderCurrent();
    } catch { /* headless - nothing to fit */ }
    return viewerState;
  }

  /**
   * Keyboard map for the focused viewer. Returns the action taken so the
   * host can do the parts that need DOM focus (e.g. focusing search).
   *   ArrowRight/PageDown/Space -> next page; ArrowLeft/PageUp -> prev
   *   Home/End -> first/last page; +/=/- and 0 -> zoom
   *   r -> rotate 90deg; n -> night mode; f -> fit width
   *   Ctrl/Cmd+F -> focus the search field
   */
  function handleKeydown(e) {
    if (!e) return null;
    const tag = String((e.target && e.target.tagName) || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
    const key = String(e.key || '');
    if ((e.ctrlKey || e.metaKey) && (key === 'f' || key === 'F')) return 'focus-search';
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    switch (key) {
      case 'ArrowRight': case 'PageDown': case ' ': nextPage(); return 'page';
      case 'ArrowLeft': case 'PageUp': prevPage(); return 'page';
      case 'Home': setPage(1); return 'page';
      case 'End': setPage(viewerState.numPages || 1); return 'page';
      case '+': case '=': setZoom((viewerState.zoom || 1) + 0.25); return 'zoom';
      case '-': case '_': setZoom((viewerState.zoom || 1) - 0.25); return 'zoom';
      case '0': setZoom(1); return 'zoom';
      case 'r': case 'R': rotate(90); return 'rotate';
      case 'n': case 'N': setNight(!viewerState.night); return 'night';
      case 'f': case 'F': fitToWidth(); return 'fit';
      default: return null;
    }
  }

  /** Text search across every page (case-insensitive). Returns all
   *  matches { page, snippet } and jumps to the first. */
  async function search(query) {
    const q = String(query || '').trim();
    setState({ query: q, matches: [], matchIndex: -1 });
    if (!q || !pdfDoc || viewerState.status !== 'ready') return viewerState;
    const needle = q.toLowerCase();
    const matches = [];
    for (let p = 1; p <= (pdfDoc.numPages || 0); p += 1) {
      let text = '';
      try {
        const page = await pdfDoc.getPage(p);
        const content = await page.getTextContent();
        text = (content.items || []).map((item) => String(item.str || '')).join(' ');
      } catch { continue; }
      const hay = text.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1 && matches.length < 500) {
        const start = Math.max(0, idx - 30);
        matches.push({ page: p, snippet: text.slice(start, idx + needle.length + 40).trim() });
        idx = hay.indexOf(needle, idx + needle.length);
      }
    }
    setState({ matches, matchIndex: matches.length ? 0 : -1 });
    if (matches.length) await setPage(matches[0].page);
    return viewerState;
  }

  function nextMatch() {
    if (!viewerState.matches.length) return viewerState;
    const matchIndex = (viewerState.matchIndex + 1) % viewerState.matches.length;
    setState({ matchIndex });
    setPage(viewerState.matches[matchIndex].page);
    return viewerState;
  }

  function destroy() {
    try { pdfDoc?.destroy?.(); } catch { /* already gone */ }
    pdfDoc = null;
    setState({ status: 'idle', numPages: 0, page: 1, matches: [], matchIndex: -1 });
  }

  return {
    get state() { return viewerState; },
    load, setPage, nextPage, prevPage, setZoom, search, nextMatch, renderCurrent, destroy,
    rotate, setNight, loadOutline, fitToWidth, fitToPage, handleKeydown
  };
}
