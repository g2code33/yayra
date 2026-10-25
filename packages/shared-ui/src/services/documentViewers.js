import { mimeForDocument, routeDocument } from './documentRegistry.js';
import { renderPptxSlide } from './pptxDomRenderer.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const DEFAULT_TIMEOUT = 90000;

export const DEFAULT_PPTX_NOTES_COLOR = '#000000';

/**
 * Native colour inputs emit six-digit hexadecimal values. Keep that narrow
 * shape at every persistence/render boundary so malformed profile data can
 * never leak into presentation styles.
 */
export function normalizePptxNotesColor(value) {
  const candidate = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(candidate)
    ? candidate.toLowerCase()
    : DEFAULT_PPTX_NOTES_COLOR;
}

function notifyFactory(state, callback) {
  let listener = callback;
  return {
    setListener(next) { if (typeof next === 'function') listener = next; },
    patch(values) {
      Object.assign(state, values);
      try { listener?.(state); } catch { /* a host repaint is optional */ }
    },
    emit() { try { listener?.(state); } catch { /* optional */ } }
  };
}

function byteArray(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return new Uint8Array(value || []);
}

function timed(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'Document load timed out')), ms);
    timer?.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function defaultLegacyOfficeWorkerFactory() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('./legacyOfficeWorker.js', import.meta.url), {
    type: 'module',
    name: 'yayra-legacy-office'
  });
}

function normaliseLegacyConversionResult(value) {
  const bytes = byteArray(value?.bytes ?? value);
  if (!bytes.byteLength) throw new Error('Legacy Office conversion returned no viewing bytes');
  return {
    bytes,
    warnings: Array.isArray(value?.warnings)
      ? value.warnings.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 24)
      : [],
    usedWorker: Boolean(value?.usedWorker)
  };
}

/**
 * Build a disposable, macro-free OOXML viewing copy of a Word/PowerPoint
 * 97-2003 file. A copied ArrayBuffer is transferred to a short-lived worker;
 * callers retain their source buffer byte-for-byte for Download/Open original.
 */
export async function convertLegacyOfficeBytes(format, value, {
  password = undefined,
  timeoutMs = DEFAULT_TIMEOUT,
  signal = undefined,
  workerFactory = defaultLegacyOfficeWorkerFactory,
  moduleLoader = () => import('../vendor/documents/legacyOffice.mjs')
} = {}) {
  if (format !== 'doc' && format !== 'ppt') throw new TypeError('Legacy Office format must be doc or ppt');
  if (signal?.aborted) throw new Error('Legacy Office conversion was cancelled');
  // byteArray always allocates, so a worker can never detach the caller's
  // DocumentStore-owned buffer.
  const source = byteArray(value);
  if (!source.byteLength) throw new Error('Legacy Office file is empty');

  let worker = null;
  if (typeof workerFactory === 'function') {
    try { worker = workerFactory(); } catch { worker = null; }
  }
  if (worker) {
    const id = `${format}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const conversion = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const response = event?.data || {};
        if (String(response.id || '') !== id) return;
        if (!response.ok) {
          const error = new Error(String(response.error?.message || 'The legacy Office file could not be converted.'));
          error.name = String(response.error?.name || 'LegacyOfficeConversionError');
          if (response.error?.code) error.code = String(response.error.code);
          reject(error);
          return;
        }
        try {
          resolve(normaliseLegacyConversionResult({
            bytes: response.bytes,
            warnings: response.warnings,
            usedWorker: true
          }));
        } catch (error) { reject(error); }
      };
      const onError = () => reject(new Error('Legacy Office conversion worker failed'));
      if (typeof worker.addEventListener === 'function') {
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError, { once: true });
        worker.addEventListener('messageerror', onError, { once: true });
      } else {
        worker.onmessage = onMessage;
        worker.onerror = onError;
        worker.onmessageerror = onError;
      }
      try {
        worker.postMessage({ id, format, bytes: source.buffer, password }, [source.buffer]);
      } catch (error) { reject(error); }
    });
    let onAbort = null;
    const abort = signal ? new Promise((_, reject) => {
      onAbort = () => reject(new Error('Legacy Office conversion was cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }) : null;
    try {
      return await timed(abort ? Promise.race([conversion, abort]) : conversion,
        timeoutMs, `Legacy ${format.toUpperCase()} conversion timed out`);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      try { worker.terminate?.(); } catch { /* already stopped */ }
    }
  }

  // Worker-less webviews and test environments keep a compatible fallback.
  // Yield first so the loading state can paint before synchronous parsing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw new Error('Legacy Office conversion was cancelled');
  const module = await timed(moduleLoader(), timeoutMs, 'Legacy Office engine load timed out');
  if (signal?.aborted) throw new Error('Legacy Office conversion was cancelled');
  const converted = module.convertLegacyOffice(format, source, { password });
  if (signal?.aborted) throw new Error('Legacy Office conversion was cancelled');
  return normaliseLegacyConversionResult(converted);
}

function clearHost(host) {
  if (!host) return;
  if (typeof host.replaceChildren === 'function') host.replaceChildren();
  else host.innerHTML = '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function isTypingTarget(event) {
  const tag = String(event?.target?.tagName || '').toUpperCase();
  // Native media players own Space/arrow keys for play, seek and volume. Do
  // not let the document wrapper steal those keys for slide navigation.
  return ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'BUTTON', 'A'].includes(tag)
    || Boolean(event?.target?.isContentEditable);
}

function searchMatches(text, query, page, limit = 500) {
  const source = String(text || '');
  const q = String(query || '').trim();
  if (!q) return [];
  const lower = source.toLocaleLowerCase();
  const needle = q.toLocaleLowerCase();
  const out = [];
  let index = lower.indexOf(needle);
  while (index >= 0 && out.length < limit) {
    const start = Math.max(0, index - 42);
    const end = Math.min(source.length, index + q.length + 58);
    out.push({ page, index, snippet: source.slice(start, end).replace(/\s+/g, ' ').trim() });
    index = lower.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return out;
}

/**
 * PowerPoint-style slideshow shortcut resolver shared by presentations and
 * PDF page shows. It is deliberately pure so projector controls can be
 * regression-tested without a DOM/fullscreen API. The historic PPTX export
 * remains public for compatibility; resolveDocumentSlideshowShortcut below
 * is the format-neutral name used by the shell.
 */
export function resolvePptxSlideshowShortcut(event, { digitBuffer = '' } = {}) {
  if (!event) return null;
  const key = String(event.key || '');
  const lower = key.toLocaleLowerCase();
  const tag = String(event?.target?.tagName || '').toUpperCase();
  const mediaOrTyping = ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO'].includes(tag)
    || Boolean(event?.target?.isContentEditable);
  const nativeActivation = ['BUTTON', 'A'].includes(tag) && (key === ' ' || key === 'Enter');
  if ((mediaOrTyping && key !== 'Escape') || nativeActivation) return null;

  if (key === 'Escape') return { action: 'exit', digitBuffer: '' };
  if (key === 'F1') return { action: 'help', digitBuffer };
  if (key === 'F5' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return { action: event.shiftKey ? 'current' : 'first', digitBuffer: '' };
  }
  if (event.altKey && key === 'F5') return { action: 'notes', digitBuffer };
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (lower === 'l') return { action: 'laser', digitBuffer };
    if (lower === 'p') return { action: 'pen', digitBuffer };
    if (lower === 'a') return { action: 'pointer', digitBuffer };
    if (lower === 'h') return { action: 'hide-pointer', digitBuffer };
    if (event.shiftKey && lower === 'n') return { action: 'notes', digitBuffer };
    return null;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  if (/^[0-9]$/.test(key)) {
    return { action: 'digits', digitBuffer: `${digitBuffer}${key}`.replace(/^0+(?=\d)/, '').slice(0, 5) || '0' };
  }
  if (key === 'Enter' && digitBuffer) return { action: 'jump', slide: Number(digitBuffer), digitBuffer: '' };
  if (key === 'Backspace' && digitBuffer) return { action: 'digits', digitBuffer: digitBuffer.slice(0, -1) };
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key) || lower === 'n' || lower === 'h') {
    return { action: 'next', digitBuffer: '' };
  }
  if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(key) || lower === 'p') {
    return { action: 'previous', digitBuffer: '' };
  }
  if (key === 'Home') return { action: 'first', digitBuffer: '' };
  if (key === 'End') return { action: 'last', digitBuffer: '' };
  if (lower === 'b' || key === '.') return { action: 'black', digitBuffer };
  if (lower === 'w' || key === ',') return { action: 'white', digitBuffer };
  if (lower === 'e') return { action: 'erase', digitBuffer };
  if (lower === 'a') return { action: 'pointer', digitBuffer };
  if (lower === 'g' || key === '-') return { action: 'navigator', digitBuffer };
  if (lower === 's') return { action: 'notes', digitBuffer };
  return null;
}

export const resolveDocumentSlideshowShortcut = resolvePptxSlideshowShortcut;

export function resolveDocumentSlideshowClick(clientX, bounds = {}) {
  const x = Number(clientX);
  const left = Number(bounds.left) || 0;
  const width = Math.max(0, Number(bounds.width) || 0);
  return Number.isFinite(x) && x < left + width / 2 ? 'previous' : 'next';
}

function handleCommonKeys(event, controller, state, { canRotate = false, canNight = false } = {}) {
  if (!event || isTypingTarget(event)) return null;
  const key = String(event.key || '');
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f') return 'focus-search';
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (['ArrowRight', 'PageDown', ' '].includes(key)) { controller.nextPage?.(); return 'page'; }
  if (['ArrowLeft', 'PageUp'].includes(key)) { controller.prevPage?.(); return 'page'; }
  if (key === 'Home' && state.numPages > 1) { controller.setPage?.(1); return 'page'; }
  if (key === 'End' && state.numPages > 1) { controller.setPage?.(state.numPages); return 'page'; }
  if (key === '+' || key === '=') { controller.setZoom?.((state.zoom || 1) + 0.25); return 'zoom'; }
  if (key === '-' || key === '_') { controller.setZoom?.((state.zoom || 1) - 0.25); return 'zoom'; }
  if (key === '0') { controller.setZoom?.(1); return 'zoom'; }
  if (canRotate && key.toLowerCase() === 'r') { controller.rotate?.(90); return 'rotate'; }
  if (canNight && key.toLowerCase() === 'n') { controller.setNight?.(!state.night); return 'night'; }
  if (key.toLowerCase() === 'f') { controller.fitToWidth?.(); return 'fit'; }
  return null;
}

function moveRoot(root, host) {
  if (!root || !host) return;
  clearHost(host);
  host.appendChild(root);
}

/* ------------------------------------------------------------------ */
/* Native PPTX viewer                                                  */
/* ------------------------------------------------------------------ */

export function createPptxViewer({
  container,
  state,
  fileName = 'presentation.pptx',
  onStateChange = null,
  moduleLoader = () => import('../vendor/documents/pptxRenderer.mjs'),
  prepareBytes = null,
  documentKind = 'pptx',
  loadTimeoutMs = DEFAULT_TIMEOUT
} = {}) {
  const viewerState = state;
  viewerState.notesColor = normalizePptxNotesColor(viewerState.notesColor);
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  let stage = null;
  let notes = null;
  let deck = null;
  let engine = null;
  let disposed = false;
  let loadToken = 0;
  let loadAbort = null;
  let renderToken = 0;
  let textIndex = null;
  let textIndexPromise = null;
  let prefetchTimer = null;
  let printDeck = null;
  let printPreparation = null;
  let printGeneration = 0;

  function scheduleNeighbourPreviews(page) {
    if (!deck || disposed) return;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    const activeDeck = deck;
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      for (const neighbour of [page + 1, page - 1]) {
        if (disposed || activeDeck !== deck || neighbour < 1 || neighbour > activeDeck.slideCount) continue;
        // Warm layout, pictures and video posters only. A large movie is
        // decompressed when its slide is actually opened, never speculatively.
        void activeDeck.getSlide(neighbour)
          .then((slideData) => slideData && activeDeck.ensureSlideMedia(neighbour, { includeClips: false }))
          .catch(() => undefined);
      }
    }, 0);
    prefetchTimer?.unref?.();
  }

  function buildRoot() {
    const doc = host?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const nextRoot = doc.createElement('div');
    nextRoot.className = 'fb-pptx-reader';
    nextRoot.style.cssText = 'width:100%;min-height:100%;display:flex;flex-direction:column;align-items:center;gap:12px;box-sizing:border-box;';
    const stageHost = doc.createElement('div');
    stageHost.className = 'fb-pptx-stage';
    stageHost.style.cssText = 'flex:0 0 auto;box-shadow:0 14px 45px rgba(0,0,0,.38);background:#fff;';
    const notesHost = doc.createElement('section');
    notesHost.className = 'fb-pptx-notes';
    // Adapted from g2code33/pharmaTRACK_PERFECT_new v1.4.22: keep a
    // fixed cream reading surface so the black default and manual colours
    // stay independent from Yayra's app theme.
    notesHost.style.cssText = 'width:min(960px,96%);max-height:38vh;overflow-y:auto;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:12px 14px;background:#FBF9F4;color:#000000;white-space:pre-wrap;line-height:1.5;box-shadow:0 8px 24px rgba(15,23,42,.2);display:none;';
    const notesTitle = doc.createElement('strong');
    notesTitle.textContent = 'Speaker notes';
    notesTitle.style.cssText = 'display:block;margin-bottom:6px;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;';
    const notesBody = doc.createElement('div');
    notesBody.className = 'fb-pptx-notes-body';
    notesBody.style.cssText = 'font-size:.94rem;line-height:1.625;cursor:text;user-select:text;overflow-wrap:anywhere;';
    notesBody.style.color = normalizePptxNotesColor(viewerState.notesColor);
    notesHost.appendChild(notesTitle);
    notesHost.appendChild(notesBody);
    nextRoot.appendChild(stageHost);
    nextRoot.appendChild(notesHost);
    root = nextRoot;
    stage = stageHost;
    notes = notesHost;
    return root;
  }

  function fitScale(mode = viewerState.zoomMode || 'fit-width') {
    if (!deck) return viewerState.zoom || 1;
    const box = host?.parentElement || host;
    const presenting = Boolean(host?.classList?.contains?.('fb-pptx-slideshow-host'));
    // In slideshow mode notes float over the projector surface; they must not
    // shrink the slide. The normal reader still reserves a notes row.
    const availableWidth = Math.max(220, Number(box?.clientWidth || host?.clientWidth || 1000) - (presenting ? 8 : 42));
    const availableHeight = Math.max(180, Number(box?.clientHeight || host?.clientHeight || 700) - (presenting ? 8 : (viewerState.showNotes ? 170 : 34)));
    if (mode === 'fit-page') return clamp(Math.min(availableWidth / deck.slideWidth, availableHeight / deck.slideHeight), MIN_ZOOM, MAX_ZOOM);
    if (mode === 'fit-width') return clamp(availableWidth / deck.slideWidth, MIN_ZOOM, MAX_ZOOM);
    return clamp(viewerState.zoom || 1, MIN_ZOOM, MAX_ZOOM);
  }

  async function renderCurrent({ thumbnail = false } = {}) {
    if (!deck || disposed || viewerState.status !== 'ready') return;
    const token = ++renderToken;
    const page = clamp(viewerState.page || 1, 1, deck.slideCount);
    updates.patch({ page, slidePending: true });
    try {
      const slideData = await deck.getSlide(page);
      if (!slideData || token !== renderToken || disposed) return;
      // Match the reference implementation: visual XML is available first;
      // media for this slide alone is decoded lazily afterwards.
      await deck.ensureSlideMedia(page);
      if (token !== renderToken || disposed) return;
      if (!root) buildRoot();
      if (root && host && root.parentElement !== host) moveRoot(root, host);
      const scale = viewerState.zoomMode === 'custom'
        ? clamp(viewerState.zoom || 1, MIN_ZOOM, MAX_ZOOM)
        : fitScale(viewerState.zoomMode);
      viewerState.zoom = scale;
      if (notes) {
        notes.style.width = `${Math.max(220, deck.slideWidth * scale)}px`;
        notes.style.maxWidth = '96%';
      }
      renderPptxSlide(stage, {
        slide: slideData,
        width: deck.slideWidth,
        height: deck.slideHeight,
        scale,
        helpers: engine,
        showImages: true,
        thumbnail
      });
      const body = notes?.querySelector?.('.fb-pptx-notes-body');
      if (body) {
        const hasSpeakerNotes = Boolean(slideData.notes);
        body.textContent = hasSpeakerNotes ? slideData.notes : 'No speaker notes on this slide.';
        body.style.color = hasSpeakerNotes
          ? normalizePptxNotesColor(viewerState.notesColor)
          : '#94a3b8';
        body.style.fontStyle = hasSpeakerNotes ? 'normal' : 'italic';
      }
      if (notes) notes.style.display = viewerState.showNotes ? 'block' : 'none';
      updates.patch({ slidePending: false, currentText: slideData.text || '', currentNotes: slideData.notes || '' });
      scheduleNeighbourPreviews(page);
    } catch (error) {
      if (token !== renderToken || disposed) return;
      console.error?.('[yayra:pptx] slide render failed', error);
      updates.patch({ status: 'error', slidePending: false, error: 'This slide could not be rendered. The original presentation is still available.' });
    }
  }

  async function load(bytes) {
    const token = ++loadToken;
    loadAbort?.abort?.();
    loadAbort = new AbortController();
    const signal = loadAbort.signal;
    const legacy = documentKind === 'ppt';
    disposed = false;
    updates.patch({
      viewer: documentKind,
      status: 'loading',
      loadingStage: legacy ? 'Converting PowerPoint 97–2003 locally…' : 'Opening presentation…',
      progress: null, error: null, numPages: 0, page: Math.max(1, Number(viewerState.page) || 1), matches: [], matchIndex: -1,
      conversionWarnings: [], transformedForViewing: legacy
    });
    try {
      const enginePromise = timed(moduleLoader(), loadTimeoutMs, 'PowerPoint engine load timed out');
      const preparationPromise = typeof prepareBytes === 'function'
        ? Promise.resolve(prepareBytes(bytes, { signal, timeoutMs: loadTimeoutMs }))
        : Promise.resolve({ bytes: byteArray(bytes), warnings: [] });
      const [loadedEngine, preparedValue] = await Promise.all([enginePromise, preparationPromise]);
      engine = loadedEngine;
      const prepared = normaliseLegacyConversionResult(preparedValue);
      if (token !== loadToken || disposed || signal.aborted) return viewerState;
      updates.patch({
        loadingStage: legacy ? 'Laying out the local viewing copy…' : 'Opening presentation…',
        conversionWarnings: prepared.warnings,
        conversionUsedWorker: prepared.usedWorker
      });
      const blob = new Blob([prepared.bytes], {
        type: mimeForDocument('pptx', 'yayra-viewing-copy.pptx')
      });
      deck = await timed(engine.openPptxDeck(blob, { lazyMedia: true }), loadTimeoutMs, 'PowerPoint parse timed out');
      if (token !== loadToken || disposed || signal.aborted) { deck?.dispose?.(); return viewerState; }
      if (!deck?.slideCount) throw new Error('No slides found');
      updates.patch({
        status: 'ready', loadingStage: '', progress: 100, numPages: deck.slideCount,
        page: clamp(viewerState.page || 1, 1, deck.slideCount),
        zoomMode: viewerState.zoomMode || 'fit-page',
        zoom: viewerState.zoom || 1,
        showNotes: viewerState.showNotes !== false,
        aspectRatio: `${Math.round(deck.slideWidth)} × ${Math.round(deck.slideHeight)}`,
        engineName: routeDocument(documentKind).engine
      });
      if (!root) buildRoot();
      if (root && host) moveRoot(root, host);
      await renderCurrent();
    } catch (error) {
      if (token !== loadToken || disposed || signal.aborted) return viewerState;
      console.error?.(`[yayra:${documentKind}] presentation open failed`, error);
      updates.patch({
        status: 'error', loadingStage: '', progress: null,
        error: legacy
          ? 'This PowerPoint 97–2003 file could not be opened. It may be corrupted, password-protected, or use unsupported legacy objects. The unchanged original is still available.'
          : 'This presentation could not be read. It may be corrupted or password-protected. The unchanged original is still available.'
      });
    }
    return viewerState;
  }

  async function setPage(value) {
    if (!deck || viewerState.status !== 'ready') return viewerState;
    updates.patch({ page: clamp(value, 1, deck.slideCount) });
    await renderCurrent();
    return viewerState;
  }
  const nextPage = () => setPage((viewerState.page || 1) + 1);
  const prevPage = () => setPage((viewerState.page || 1) - 1);

  async function setZoom(value) {
    updates.patch({ zoomMode: 'custom', zoom: clamp(value, MIN_ZOOM, MAX_ZOOM) });
    await renderCurrent();
    return viewerState;
  }
  async function fitToWidth() {
    updates.patch({ zoomMode: 'fit-width', zoom: fitScale('fit-width') });
    await renderCurrent();
    return viewerState;
  }
  async function fitToPage() {
    updates.patch({ zoomMode: 'fit-page', zoom: fitScale('fit-page') });
    await renderCurrent();
    return viewerState;
  }
  async function toggleNotes(force) {
    updates.patch({ showNotes: typeof force === 'boolean' ? force : !viewerState.showNotes });
    await renderCurrent();
    return viewerState;
  }

  function setNotesColor(value) {
    const notesColor = normalizePptxNotesColor(value);
    updates.patch({ notesColor });
    // Do not re-render the slide: changing a note colour must not restart an
    // embedded video or rebuild any of the presentation media.
    const body = notes?.querySelector?.('.fb-pptx-notes-body');
    if (body && viewerState.currentNotes) body.style.color = notesColor;
    return viewerState;
  }

  async function ensureTextIndex() {
    if (textIndex) return textIndex;
    if (!textIndexPromise && deck) {
      updates.patch({ searchPending: true });
      textIndexPromise = deck.textIndex((done, total) => {
        updates.patch({ searchProgress: total ? Math.round((done / total) * 100) : null });
      }).then((value) => {
        textIndex = value;
        return value;
      }).finally(() => {
        textIndexPromise = null;
        updates.patch({ searchPending: false, searchProgress: null });
      });
    }
    return textIndexPromise || [];
  }

  async function search(query) {
    const q = String(query || '').trim();
    updates.patch({ query: q, matches: [], matchIndex: -1 });
    if (!q || !deck) return viewerState;
    try {
      const index = await ensureTextIndex();
      if (disposed || viewerState.query !== q) return viewerState;
      const matches = [];
      for (const item of index) matches.push(...searchMatches(item.text, q, item.slide, 500 - matches.length));
      updates.patch({ matches, matchIndex: matches.length ? 0 : -1 });
      if (matches.length) await setPage(matches[0].page);
    } catch {
      updates.patch({ searchPending: false, searchProgress: null });
    }
    return viewerState;
  }

  function nextMatch() {
    if (!viewerState.matches?.length) return viewerState;
    const index = ((viewerState.matchIndex || 0) + 1) % viewerState.matches.length;
    updates.patch({ matchIndex: index });
    void setPage(viewerState.matches[index].page);
    return viewerState;
  }

  async function renderThumbnail(page, target) {
    if (!deck || !target || disposed) return;
    try {
      const slideData = await deck.getSlide(page);
      if (!slideData || disposed) return;
      await deck.ensureSlideMedia(page, { includeClips: false });
      const width = Math.max(90, Number(target.clientWidth || 132) - 8);
      renderPptxSlide(target, {
        slide: slideData, width: deck.slideWidth, height: deck.slideHeight,
        scale: width / deck.slideWidth, helpers: engine, showImages: true, thumbnail: true
      });
    } catch { /* a label remains an honest thumbnail fallback */ }
  }

  /** Paint every slide only when the user explicitly prints. Normal viewing
   * keeps one full slide plus lightweight thumbnails, so large decks stay
   * fast; the temporary print deck is removed as soon as the dialog closes. */
  function preparePrint() {
    if (!deck || !host || disposed || viewerState.status !== 'ready') return Promise.resolve(false);
    if (printDeck?.parentElement) return Promise.resolve(true);
    if (printPreparation) return printPreparation;
    const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return Promise.resolve(false);
    const generation = ++printGeneration;
    const activeDeck = deck;
    updates.patch({ printPending: true, printProgress: 0, loadingStage: 'Preparing slides for print…' });
    const nextPrintDeck = doc.createElement('div');
    nextPrintDeck.className = 'fb-pptx-print-deck';
    nextPrintDeck.setAttribute('aria-label', `Printable presentation with ${activeDeck.slideCount} slides`);

    printPreparation = (async () => {
      try {
        // Standard widescreen slides are 1280 CSS px wide. Scale to a bounded
        // landscape print frame so Letter/A4 output never clips the right edge.
        const printScale = Math.min(
          1,
          960 / Math.max(1, Number(activeDeck.slideWidth) || 1),
          680 / Math.max(1, Number(activeDeck.slideHeight) || 1)
        );
        for (let page = 1; page <= activeDeck.slideCount; page += 1) {
          if (disposed || generation !== printGeneration || activeDeck !== deck) throw new Error('viewer disposed');
          const slideData = await activeDeck.getSlide(page);
          if (!slideData) throw new Error(`slide ${page} unavailable`);
          await activeDeck.ensureSlideMedia(page, { includeClips: false });
          if (disposed || generation !== printGeneration || activeDeck !== deck) throw new Error('viewer disposed');
          const pageEl = doc.createElement('section');
          pageEl.className = 'fb-pptx-print-slide';
          pageEl.dataset.slide = String(page);
          pageEl.setAttribute('aria-label', `Slide ${page}`);
          renderPptxSlide(pageEl, {
            slide: slideData,
            width: activeDeck.slideWidth,
            height: activeDeck.slideHeight,
            scale: printScale,
            helpers: engine,
            showImages: true,
            thumbnail: false
          });
          // Print DOM is hidden until the print media query activates. Force
          // images out of lazy mode and decode now; otherwise Chromium can take
          // its print snapshot before an unvisited slide's picture is ready.
          const decodes = [];
          for (const image of pageEl.querySelectorAll?.('img') || []) {
            image.loading = 'eager';
            if (typeof image.decode === 'function') decodes.push(image.decode().catch(() => {}));
          }
          const ImageCtor = doc.defaultView?.Image || globalThis.Image;
          if (slideData.backgroundImageUrl && typeof ImageCtor === 'function') {
            const background = new ImageCtor();
            background.src = slideData.backgroundImageUrl;
            if (typeof background.decode === 'function') decodes.push(background.decode().catch(() => {}));
          }
          if (decodes.length) await Promise.all(decodes);
          nextPrintDeck.appendChild(pageEl);
          updates.patch({ printProgress: Math.round((page / activeDeck.slideCount) * 100) });
          if (page % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (disposed || generation !== printGeneration || activeDeck !== deck) throw new Error('viewer disposed');
        printDeck = nextPrintDeck;
        root?.classList?.add('fb-pptx-print-current-hidden');
        host.appendChild(printDeck);
        updates.patch({ printPending: false, printProgress: 100, loadingStage: '' });
        return true;
      } catch {
        nextPrintDeck.remove?.();
        root?.classList?.remove('fb-pptx-print-current-hidden');
        if (printDeck === nextPrintDeck) printDeck = null;
        updates.patch({ printPending: false, printProgress: null, loadingStage: '' });
        return false;
      } finally {
        printPreparation = null;
      }
    })();
    return printPreparation;
  }

  function finishPrint() {
    printGeneration += 1;
    printDeck?.remove?.();
    printDeck = null;
    root?.classList?.remove('fb-pptx-print-current-hidden');
    updates.patch({ printPending: false, printProgress: null, loadingStage: '' });
  }

  function attach(nextContainer, listener) {
    host = nextContainer || null;
    updates.setListener(listener);
    if (root && host) moveRoot(root, host);
    else if (deck && viewerState.status === 'ready') void renderCurrent();
    updates.emit();
    return Promise.resolve(viewerState);
  }

  function destroy() {
    disposed = true;
    loadToken += 1;
    loadAbort?.abort?.();
    loadAbort = null;
    renderToken += 1;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = null;
    finishPrint();
    try { deck?.dispose?.(); } catch { /* already gone */ }
    deck = null;
    textIndex = null;
    textIndexPromise = null;
    clearHost(host);
    root = stage = notes = null;
    updates.patch({ status: 'idle', loadingStage: '', progress: null, numPages: 0, slidePending: false });
  }

  const controller = {
    get state() { return viewerState; }, load, attach, destroy, renderCurrent,
    setPage, nextPage, prevPage, setZoom, fitToWidth, fitToPage, search, nextMatch,
    toggleNotes, setNotesColor, renderThumbnail, preparePrint, finishPrint,
    loadOutline: async () => [], rotate: async () => viewerState,
    setNight: async () => viewerState,
    handleKeydown: (event) => handleCommonKeys(event, controller, viewerState)
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* Browser-decoded image viewer                                        */
/* ------------------------------------------------------------------ */

function sanitiseSvg(bytes) {
  let source = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  source = source
    .replace(/<\s*(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed)\b[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href)\s*=\s*(["'])(?!#|data:image\/)[\s\S]*?\1/gi, '')
    .replace(/url\(\s*(["']?)(?:https?:|file:|javascript:)[^)]+\)/gi, 'none');
  return new TextEncoder().encode(source);
}

export function createImageViewer({ container, state, fileName = 'image', onStateChange = null } = {}) {
  const viewerState = state;
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  let image = null;
  let objectUrl = null;
  let sourceBytes = null;

  function applyTransform() {
    if (!image) return;
    image.style.transform = `rotate(${viewerState.rotation || 0}deg) scale(${viewerState.zoom || 1})`;
    image.style.filter = viewerState.night ? 'brightness(.82) contrast(1.08)' : '';
    updates.emit();
  }

  function render() {
    if (!host || !objectUrl) return;
    const doc = host.ownerDocument || document;
    root = doc.createElement('div');
    root.className = 'fb-image-reader';
    root.style.cssText = 'width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;overflow:auto;background:repeating-conic-gradient(rgba(255,255,255,.035) 0 25%,transparent 0 50%) 50%/20px 20px;';
    image = doc.createElement('img');
    image.className = 'fb-document-image';
    image.alt = fileName;
    image.src = objectUrl;
    image.draggable = false;
    image.style.cssText = 'display:block;max-width:none;max-height:none;transform-origin:center center;transition:transform 120ms ease;box-shadow:0 12px 42px rgba(0,0,0,.35);';
    image.addEventListener?.('load', () => updates.patch({ naturalWidth: image.naturalWidth || 0, naturalHeight: image.naturalHeight || 0 }));
    image.addEventListener?.('error', () => updates.patch({ status: 'error', error: 'This image could not be decoded by the browser. The original file is still available.' }));
    root.appendChild(image);
    moveRoot(root, host);
    applyTransform();
  }

  async function load(bytes) {
    updates.patch({ viewer: 'image', status: 'loading', loadingStage: 'Decoding image…', error: null, numPages: 1, page: 1, zoom: viewerState.zoom || 1, rotation: viewerState.rotation || 0 });
    try {
      sourceBytes = byteArray(bytes);
      const svg = /\.svg$/i.test(fileName);
      const safeBytes = svg ? sanitiseSvg(sourceBytes) : sourceBytes;
      objectUrl = URL.createObjectURL(new Blob([safeBytes], { type: mimeForDocument('image', fileName) }));
      updates.patch({ status: 'ready', loadingStage: '', progress: 100 });
      render();
    } catch {
      updates.patch({ status: 'error', loadingStage: '', error: 'This image could not be opened.' });
    }
    return viewerState;
  }
  async function setZoom(value) { updates.patch({ zoom: clamp(value, 0.1, 10) }); applyTransform(); return viewerState; }
  async function rotate(delta = 90) { updates.patch({ rotation: (((viewerState.rotation || 0) + delta) % 360 + 360) % 360 }); applyTransform(); return viewerState; }
  async function setNight(value) { updates.patch({ night: Boolean(value) }); applyTransform(); return viewerState; }
  async function fitToWidth() {
    const width = Number(host?.clientWidth || host?.parentElement?.clientWidth || 0) - 40;
    const natural = Number(image?.naturalWidth || viewerState.naturalWidth || 0);
    if (width > 0 && natural > 0) updates.patch({ zoom: clamp(width / natural, 0.1, 10) });
    else updates.patch({ zoom: 1 });
    applyTransform();
    return viewerState;
  }
  const fitToPage = fitToWidth;
  function attach(next, listener) { host = next || null; updates.setListener(listener); if (root && host) moveRoot(root, host); else render(); updates.emit(); return Promise.resolve(viewerState); }
  function destroy() { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; sourceBytes = null; clearHost(host); root = image = null; updates.patch({ status: 'idle' }); }
  const controller = {
    get state() { return viewerState; }, load, attach, destroy, setZoom, rotate, setNight, fitToWidth, fitToPage,
    setPage: async () => viewerState, nextPage: async () => viewerState, prevPage: async () => viewerState,
    search: async () => viewerState, nextMatch: () => viewerState, loadOutline: async () => [],
    handleKeydown: (event) => handleCommonKeys(event, controller, viewerState, { canRotate: true, canNight: true })
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* DOCX visual viewer                                                  */
/* ------------------------------------------------------------------ */

function markDomText(root, query) {
  if (!root) return [];
  for (const mark of root.querySelectorAll?.('mark[data-yayra-doc-find]') || []) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(root.ownerDocument.createTextNode(mark.textContent || ''), mark);
    parent.normalize?.();
  }
  const q = String(query || '').trim();
  if (!q) return [];
  const lowerNeedle = q.toLocaleLowerCase();
  const nodes = [];
  const collect = (node) => {
    for (const child of Array.from(node?.childNodes || [])) {
      if (child.nodeType === 3 && child.textContent?.toLocaleLowerCase().includes(lowerNeedle)) nodes.push(child);
      else if (child.nodeType === 1 && String(child.tagName || '').toUpperCase() !== 'MARK') collect(child);
    }
  };
  collect(root);
  const matches = [];
  for (const node of nodes) {
    const text = node.textContent || '';
    const lower = text.toLocaleLowerCase();
    const fragment = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    let index = lower.indexOf(lowerNeedle);
    while (index >= 0 && matches.length < 500) {
      if (index > cursor) fragment.appendChild(root.ownerDocument.createTextNode(text.slice(cursor, index)));
      const mark = root.ownerDocument.createElement('mark');
      mark.dataset.yayraDocFind = '1';
      mark.setAttribute('data-yayra-doc-find', '1');
      mark.textContent = text.slice(index, index + q.length);
      mark.style.cssText = 'background:#fde047;color:#111827;border-radius:2px;';
      fragment.appendChild(mark);
      matches.push({ page: 1, snippet: text.slice(Math.max(0, index - 35), index + q.length + 45).trim(), element: mark });
      cursor = index + q.length;
      index = lower.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) fragment.appendChild(root.ownerDocument.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return matches;
}

export function createDocxViewer({
  container, state, fileName = 'document.docx', onStateChange = null,
  moduleLoader = () => import('../vendor/documents/docxPreview.mjs'),
  prepareBytes = null,
  documentKind = 'docx',
  loadTimeoutMs = DEFAULT_TIMEOUT
} = {}) {
  const viewerState = state;
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  let pageWrap = null;
  let body = null;
  let disposed = false;
  let loadToken = 0;
  let loadAbort = null;

  async function load(bytes) {
    const token = ++loadToken;
    loadAbort?.abort?.();
    loadAbort = new AbortController();
    const signal = loadAbort.signal;
    const legacy = documentKind === 'doc';
    disposed = false;
    updates.patch({
      viewer: documentKind,
      status: 'loading',
      loadingStage: legacy ? 'Converting Word 97–2003 locally…' : 'Laying out Word document…',
      progress: null, error: null, numPages: 1, page: 1,
      conversionWarnings: [], transformedForViewing: legacy
    });
    try {
      const modulePromise = timed(moduleLoader(), loadTimeoutMs, 'Word engine load timed out');
      const preparationPromise = typeof prepareBytes === 'function'
        ? Promise.resolve(prepareBytes(bytes, { signal, timeoutMs: loadTimeoutMs }))
        : Promise.resolve({ bytes: byteArray(bytes), warnings: [] });
      const [module, preparedValue] = await Promise.all([modulePromise, preparationPromise]);
      const prepared = normaliseLegacyConversionResult(preparedValue);
      if (token !== loadToken || disposed || signal.aborted) return viewerState;
      updates.patch({
        loadingStage: legacy ? 'Laying out the local viewing copy…' : 'Laying out Word document…',
        conversionWarnings: prepared.warnings,
        conversionUsedWorker: prepared.usedWorker
      });
      const doc = host?.ownerDocument || document;
      root = doc.createElement('div');
      root.className = 'fb-docx-reader';
      root.style.cssText = 'width:100%;min-height:100%;padding:20px;box-sizing:border-box;background:#cbd5e1;color:#111827;overflow:auto;';
      pageWrap = doc.createElement('div');
      pageWrap.className = 'fb-docx-scale';
      pageWrap.style.cssText = 'width:max-content;min-width:100%;transform-origin:top center;';
      const styleHost = doc.createElement('div');
      styleHost.className = 'fb-docx-styles';
      body = doc.createElement('div');
      body.className = 'fb-docx-body';
      pageWrap.appendChild(styleHost);
      pageWrap.appendChild(body);
      root.appendChild(pageWrap);
      if (host) moveRoot(root, host);
      const blob = new Blob([prepared.bytes], {
        type: mimeForDocument('docx', 'yayra-viewing-copy.docx')
      });
      await timed(module.renderAsync(blob, body, styleHost, {
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true
      }), loadTimeoutMs, 'Word rendering timed out');
      if (token !== loadToken || disposed || signal.aborted) return viewerState;
      updates.patch({
        status: 'ready', loadingStage: '', progress: 100,
        zoom: viewerState.zoom || 1, engineName: routeDocument(documentKind).engine
      });
      pageWrap.style.transform = `scale(${viewerState.zoom || 1})`;
    } catch (error) {
      if (token !== loadToken || disposed || signal.aborted) return viewerState;
      console.error?.(`[yayra:${documentKind}] render failed`, error);
      updates.patch({
        status: 'error', loadingStage: '', progress: null,
        error: legacy
          ? 'This Word 97–2003 file could not be opened. It may be corrupted, password-protected, or use unsupported legacy objects. The unchanged original is still available.'
          : 'This Word document could not be rendered. It may be corrupted or password-protected. The unchanged original is still available.'
      });
    }
    return viewerState;
  }
  async function setZoom(value) { updates.patch({ zoom: clamp(value, 0.5, 3) }); if (pageWrap) pageWrap.style.transform = `scale(${viewerState.zoom})`; return viewerState; }
  async function fitToWidth() { return setZoom(1); }
  const fitToPage = fitToWidth;
  async function search(query) {
    const q = String(query || '').trim();
    const matches = markDomText(body, q);
    updates.patch({ query: q, matches, matchIndex: matches.length ? 0 : -1 });
    matches[0]?.element?.scrollIntoView?.({ block: 'center' });
    return viewerState;
  }
  function nextMatch() {
    if (!viewerState.matches?.length) return viewerState;
    const index = ((viewerState.matchIndex || 0) + 1) % viewerState.matches.length;
    updates.patch({ matchIndex: index });
    viewerState.matches[index]?.element?.scrollIntoView?.({ block: 'center' });
    return viewerState;
  }
  function attach(next, listener) { host = next || null; updates.setListener(listener); if (root && host) moveRoot(root, host); updates.emit(); return Promise.resolve(viewerState); }
  function destroy() {
    disposed = true;
    loadToken += 1;
    loadAbort?.abort?.();
    loadAbort = null;
    clearHost(host);
    root = pageWrap = body = null;
    updates.patch({ status: 'idle' });
  }
  const controller = {
    get state() { return viewerState; }, load, attach, destroy, setZoom, fitToWidth, fitToPage, search, nextMatch,
    setPage: async () => viewerState, nextPage: async () => viewerState, prevPage: async () => viewerState,
    rotate: async () => viewerState, setNight: async () => viewerState, loadOutline: async () => [],
    handleKeydown: (event) => handleCommonKeys(event, controller, viewerState)
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* Spreadsheet viewer                                                  */
/* ------------------------------------------------------------------ */

const SHEET_ROWS_PER_VIEW = 300;

function displayedCell(cell) {
  if (!cell) return '';
  if (cell.w != null) return String(cell.w);
  if (cell.v == null) return '';
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  return String(cell.v);
}

export function createSpreadsheetViewer({
  container, state, fileName = 'spreadsheet.xlsx', onStateChange = null,
  moduleLoader = () => import('../vendor/documents/xlsx.mjs'),
  documentKind = 'xlsx',
  loadTimeoutMs = DEFAULT_TIMEOUT
} = {}) {
  const viewerState = state;
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  let workbook = null;
  let XLSX = null;
  let disposed = false;
  let token = 0;

  function colName(n) {
    let value = '';
    let column = n;
    while (column >= 0) {
      value = String.fromCharCode((column % 26) + 65) + value;
      column = Math.floor(column / 26) - 1;
    }
    return value;
  }

  function renderSheet() {
    if (!host || !workbook || !XLSX || disposed) return;
    const doc = host.ownerDocument || document;
    const sheetIndex = clamp(viewerState.page || 1, 1, workbook.SheetNames.length) - 1;
    const name = workbook.SheetNames[sheetIndex];
    const sheet = workbook.Sheets[name];
    root = doc.createElement('div');
    root.className = 'fb-xlsx-reader';
    root.style.cssText = 'width:100%;min-height:100%;box-sizing:border-box;padding:12px;overflow:auto;background:#dbe3e8;color:#111827;';
    const header = doc.createElement('div');
    header.className = 'fb-xlsx-sheet-tabs';
    header.style.cssText = 'position:sticky;top:0;z-index:4;display:flex;gap:4px;overflow-x:auto;padding:6px;background:rgba(248,250,252,.96);border:1px solid #cbd5e1;border-radius:9px 9px 0 0;';
    workbook.SheetNames.forEach((sheetName, index) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'fb-xlsx-sheet-tab';
      button.dataset.sheet = String(index + 1);
      button.textContent = sheetName;
      button.style.cssText = `border:0;border-bottom:2px solid ${index === sheetIndex ? '#16a34a' : 'transparent'};border-radius:6px;padding:5px 10px;background:${index === sheetIndex ? '#dcfce7' : '#f1f5f9'};color:#334155;white-space:nowrap;cursor:pointer;font-weight:600;`;
      button.addEventListener('click', () => { void setPage(index + 1); });
      header.appendChild(button);
    });
    root.appendChild(header);

    const range = sheet?.['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const totalRows = Math.max(0, range.e.r - range.s.r + 1);
    const rowPages = Math.max(1, Math.ceil(totalRows / SHEET_ROWS_PER_VIEW));
    const rowPage = clamp(viewerState.rowPage || 1, 1, rowPages);
    viewerState.rowPage = rowPage;
    viewerState.rowPages = rowPages;
    const firstRow = range.s.r + (rowPage - 1) * SHEET_ROWS_PER_VIEW;
    const lastRow = Math.min(range.e.r, firstRow + SHEET_ROWS_PER_VIEW - 1);

    if (rowPages > 1) {
      const pager = doc.createElement('div');
      pager.className = 'fb-xlsx-row-pager';
      pager.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:8px;background:#f8fafc;border-inline:1px solid #cbd5e1;';
      const previous = doc.createElement('button');
      previous.textContent = 'Previous rows';
      previous.disabled = rowPage <= 1;
      previous.addEventListener('click', () => { viewerState.rowPage = rowPage - 1; renderSheet(); updates.emit(); });
      const label = doc.createElement('span');
      label.textContent = `Rows ${firstRow + 1}–${lastRow + 1} of ${totalRows}`;
      const next = doc.createElement('button');
      next.textContent = 'Next rows';
      next.disabled = rowPage >= rowPages;
      next.addEventListener('click', () => { viewerState.rowPage = rowPage + 1; renderSheet(); updates.emit(); });
      for (const button of [previous, next]) button.style.cssText = 'border:1px solid #cbd5e1;border-radius:7px;background:white;padding:5px 9px;color:#334155;cursor:pointer;';
      label.style.cssText = 'font-size:.75rem;color:#64748b;font-weight:600;';
      pager.appendChild(previous); pager.appendChild(label); pager.appendChild(next);
      root.appendChild(pager);
    }

    const frame = doc.createElement('div');
    frame.style.cssText = 'width:max-content;min-width:100%;overflow:auto;background:#fff;border:1px solid #cbd5e1;box-shadow:0 8px 28px rgba(15,23,42,.15);';
    const table = doc.createElement('table');
    table.className = 'fb-xlsx-grid';
    table.style.cssText = 'border-collapse:collapse;table-layout:fixed;font:13px "Segoe UI",Arial,sans-serif;min-width:100%;';
    const colgroup = doc.createElement('colgroup');
    const rowHeadCol = doc.createElement('col'); rowHeadCol.style.width = '48px'; colgroup.appendChild(rowHeadCol);
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const col = doc.createElement('col');
      const metadata = sheet?.['!cols']?.[column];
      if (metadata?.wpx) col.style.width = `${Math.max(24, metadata.wpx)}px`;
      else if (metadata?.wch) col.style.width = `${Math.max(24, Math.round(metadata.wch * 7.5 + 8))}px`;
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
    const body = doc.createElement('tbody');
    const headings = doc.createElement('tr');
    const corner = doc.createElement('th'); corner.textContent = ''; headings.appendChild(corner);
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const th = doc.createElement('th'); th.textContent = colName(column); headings.appendChild(th);
    }
    for (const th of headings.children || []) th.style.cssText = 'position:sticky;top:0;border:1px solid #dbe3e8;background:#f1f5f9;padding:3px 7px;color:#64748b;font-size:10px;z-index:2;';
    body.appendChild(headings);

    const merges = sheet?.['!merges'] || [];
    const anchors = new Map();
    const covered = new Set();
    for (const merge of merges) {
      anchors.set(`${merge.s.r},${merge.s.c}`, { rowspan: merge.e.r - merge.s.r + 1, colspan: merge.e.c - merge.s.c + 1 });
      for (let row = merge.s.r; row <= merge.e.r; row += 1) for (let column = merge.s.c; column <= merge.e.c; column += 1) {
        if (row !== merge.s.r || column !== merge.s.c) covered.add(`${row},${column}`);
      }
    }
    const query = String(viewerState.query || '').trim().toLocaleLowerCase();
    const matches = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const tr = doc.createElement('tr');
      const rowHeight = sheet?.['!rows']?.[row];
      if (rowHeight?.hpx) tr.style.height = `${Math.max(18, rowHeight.hpx)}px`;
      const rowHead = doc.createElement('th');
      rowHead.textContent = String(row + 1);
      rowHead.style.cssText = 'position:sticky;left:0;z-index:1;border:1px solid #dbe3e8;background:#f1f5f9;padding:2px 5px;color:#94a3b8;font-size:10px;';
      tr.appendChild(rowHead);
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const key = `${row},${column}`;
        if (covered.has(key)) continue;
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet?.[address];
        const text = displayedCell(cell);
        const td = doc.createElement('td');
        td.dataset.cell = address;
        td.textContent = text;
        if (cell?.f) td.title = `=${cell.f}`;
        const merge = anchors.get(key);
        if (merge) { td.rowSpan = merge.rowspan; td.colSpan = merge.colspan; }
        const match = Boolean(query && text.toLocaleLowerCase().includes(query));
        if (match) matches.push({ page: sheetIndex + 1, cell: address, snippet: `${address}: ${text}`, element: td });
        td.style.cssText = `border:1px solid #e2e8f0;padding:3px 7px;white-space:nowrap;min-width:72px;background:${match ? '#fef08a' : '#fff'};color:#1e293b;${/^[0-9.,()%\s-]+$/.test(text) ? 'text-align:right;font-variant-numeric:tabular-nums;' : ''}`;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    frame.appendChild(table);
    root.appendChild(frame);
    moveRoot(root, host);
    if (query) updates.patch({ matches, matchIndex: matches.length ? 0 : -1 });
  }

  async function load(bytes) {
    const loadToken = ++token;
    disposed = false;
    updates.patch({ viewer: documentKind, status: 'loading', loadingStage: 'Reading workbook…', progress: null, error: null, numPages: 0, page: Math.max(1, Number(viewerState.page) || 1), rowPage: Math.max(1, Number(viewerState.rowPage) || 1) });
    try {
      XLSX = await timed(moduleLoader(), loadTimeoutMs, 'Spreadsheet engine load timed out');
      if (disposed || loadToken !== token) return viewerState;
      workbook = XLSX.read(byteArray(bytes), { type: 'array', cellStyles: true, cellDates: true });
      if (!workbook?.SheetNames?.length) throw new Error('No worksheets found');
      updates.patch({ status: 'ready', loadingStage: '', progress: 100, numPages: workbook.SheetNames.length, page: clamp(viewerState.page || 1, 1, workbook.SheetNames.length), sheetNames: [...workbook.SheetNames], engineName: routeDocument(documentKind).engine });
      renderSheet();
    } catch (error) {
      if (disposed || loadToken !== token) return viewerState;
      console.error?.('[yayra:xlsx] parse failed', error);
      updates.patch({ status: 'error', loadingStage: '', progress: null, error: 'This spreadsheet could not be read. It may be corrupted or password-protected.' });
    }
    return viewerState;
  }
  async function setPage(value) { if (!workbook) return viewerState; updates.patch({ page: clamp(value, 1, workbook.SheetNames.length), rowPage: 1 }); renderSheet(); return viewerState; }
  const nextPage = () => setPage((viewerState.page || 1) + 1);
  const prevPage = () => setPage((viewerState.page || 1) - 1);
  async function search(query) { updates.patch({ query: String(query || '').trim() }); renderSheet(); return viewerState; }
  function nextMatch() { if (!viewerState.matches?.length) return viewerState; const index = ((viewerState.matchIndex || 0) + 1) % viewerState.matches.length; updates.patch({ matchIndex: index }); viewerState.matches[index]?.element?.scrollIntoView?.({ block: 'center', inline: 'center' }); return viewerState; }
  function attach(next, listener) { host = next || null; updates.setListener(listener); if (root && host) moveRoot(root, host); else renderSheet(); updates.emit(); return Promise.resolve(viewerState); }
  function destroy() { disposed = true; token += 1; workbook = XLSX = null; clearHost(host); root = null; updates.patch({ status: 'idle' }); }
  const controller = {
    get state() { return viewerState; }, load, attach, destroy, setPage, nextPage, prevPage, search, nextMatch,
    setZoom: async () => viewerState, fitToWidth: async () => viewerState, fitToPage: async () => viewerState,
    rotate: async () => viewerState, setNight: async () => viewerState, loadOutline: async () => [],
    handleKeydown: (event) => handleCommonKeys(event, controller, viewerState)
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* Safe text viewer                                                    */
/* ------------------------------------------------------------------ */

export function createTextViewer({ container, state, fileName = 'document.txt', onStateChange = null } = {}) {
  const viewerState = state;
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  let pre = null;
  let text = '';

  function paint() {
    if (!host) return;
    const doc = host.ownerDocument || document;
    root = doc.createElement('div');
    root.className = 'fb-text-reader';
    root.style.cssText = `width:100%;min-height:100%;box-sizing:border-box;padding:28px;background:${viewerState.night ? '#0b1020' : '#f8fafc'};color:${viewerState.night ? '#dbeafe' : '#1e293b'};`;
    pre = doc.createElement('pre');
    pre.className = 'fb-text-document';
    pre.style.cssText = `margin:0 auto;max-width:1000px;white-space:pre-wrap;overflow-wrap:anywhere;font:${14 * (viewerState.zoom || 1)}px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4;`;
    const q = String(viewerState.query || '').trim();
    if (!q) pre.textContent = text;
    else {
      const matches = searchMatches(text, q, 1);
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) pre.appendChild(doc.createTextNode(text.slice(cursor, match.index)));
        const mark = doc.createElement('mark');
        mark.textContent = text.slice(match.index, match.index + q.length);
        mark.style.cssText = 'background:#fde047;color:#111827;';
        pre.appendChild(mark);
        match.element = mark;
        cursor = match.index + q.length;
      }
      if (cursor < text.length) pre.appendChild(doc.createTextNode(text.slice(cursor)));
      viewerState.matches = matches;
      viewerState.matchIndex = matches.length ? 0 : -1;
    }
    root.appendChild(pre);
    moveRoot(root, host);
  }
  async function load(bytes) {
    updates.patch({ viewer: 'text', status: 'loading', loadingStage: 'Reading text…', error: null, numPages: 1, page: 1 });
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(byteArray(bytes)).replace(/^\uFEFF/, '');
      updates.patch({ status: 'ready', loadingStage: '', progress: 100, zoom: viewerState.zoom || 1, engineName: routeDocument('text').engine });
      paint();
    } catch { updates.patch({ status: 'error', loadingStage: '', error: 'This text file could not be decoded.' }); }
    return viewerState;
  }
  async function setZoom(value) { updates.patch({ zoom: clamp(value, 0.5, 3) }); paint(); return viewerState; }
  async function setNight(value) { updates.patch({ night: Boolean(value) }); paint(); return viewerState; }
  async function search(query) { updates.patch({ query: String(query || '').trim(), matches: [], matchIndex: -1 }); paint(); updates.emit(); viewerState.matches?.[0]?.element?.scrollIntoView?.({ block: 'center' }); return viewerState; }
  function nextMatch() { if (!viewerState.matches?.length) return viewerState; const index = ((viewerState.matchIndex || 0) + 1) % viewerState.matches.length; updates.patch({ matchIndex: index }); viewerState.matches[index]?.element?.scrollIntoView?.({ block: 'center' }); return viewerState; }
  function attach(next, listener) { host = next || null; updates.setListener(listener); if (root && host) moveRoot(root, host); else paint(); updates.emit(); return Promise.resolve(viewerState); }
  function destroy() { text = ''; clearHost(host); root = pre = null; updates.patch({ status: 'idle' }); }
  const controller = {
    get state() { return viewerState; }, load, attach, destroy, setZoom, setNight, search, nextMatch,
    fitToWidth: async () => setZoom(1), fitToPage: async () => setZoom(1), rotate: async () => viewerState,
    setPage: async () => viewerState, nextPage: async () => viewerState, prevPage: async () => viewerState,
    loadOutline: async () => [], handleKeydown: (event) => handleCommonKeys(event, controller, viewerState, { canNight: true })
  };
  return controller;
}

/* ------------------------------------------------------------------ */
/* Honest original-file fallback                                       */
/* ------------------------------------------------------------------ */

export function createUnsupportedViewer({ container, state, fileName = 'document', onStateChange = null, onOpenOriginal = null } = {}) {
  const viewerState = state;
  const updates = notifyFactory(viewerState, onStateChange);
  let host = container || null;
  let root = null;
  function render() {
    if (!host) return;
    const doc = host.ownerDocument || document;
    root = doc.createElement('div');
    root.className = 'fb-unsupported-reader';
    root.style.cssText = 'width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
    const card = doc.createElement('div');
    card.style.cssText = 'width:min(520px,100%);padding:28px;border:1px solid var(--fb-border-glass,rgba(255,255,255,.12));border-radius:16px;background:var(--fb-bg-elevated,#141824);color:var(--fb-text-primary,#e2e8f0);box-shadow:0 16px 50px rgba(0,0,0,.35);text-align:center;';
    const title = doc.createElement('h2'); title.textContent = 'No safe built-in view for this file'; title.style.cssText = 'margin:0 0 10px;font-size:1.1rem;';
    const legacyOffice = /\.(?:doc|ppt|xls)$/i.test(String(fileName || ''));
    const copy = doc.createElement('p');
    copy.textContent = legacyOffice
      ? `${fileName} could not be identified as a valid Word, PowerPoint or Excel 97–2003 file. The unchanged original is still available.`
      : `${fileName} does not have a safe built-in Yayra viewer. Open the unchanged original with its desktop app.`;
    copy.style.cssText = 'margin:0;color:var(--fb-text-secondary,#a8b0bf);line-height:1.55;';
    card.appendChild(title); card.appendChild(copy);
    if (typeof onOpenOriginal === 'function') {
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = 'Open original or save unchanged file';
      button.style.cssText = 'margin-top:18px;border:0;border-radius:9px;padding:9px 14px;background:var(--fb-accent-primary,#6d5df2);color:white;font-weight:700;cursor:pointer;';
      button.addEventListener('click', onOpenOriginal);
      card.appendChild(button);
    }
    root.appendChild(card); moveRoot(root, host);
  }
  async function load() { updates.patch({ viewer: 'unsupported', status: 'ready', loadingStage: '', progress: 100, numPages: 0, page: 1, error: null }); render(); return viewerState; }
  function attach(next, listener) { host = next || null; updates.setListener(listener); if (root && host) moveRoot(root, host); else render(); updates.emit(); return Promise.resolve(viewerState); }
  function destroy() { clearHost(host); root = null; updates.patch({ status: 'idle' }); }
  return {
    get state() { return viewerState; }, load, attach, destroy,
    setPage: async () => viewerState, nextPage: async () => viewerState, prevPage: async () => viewerState,
    setZoom: async () => viewerState, fitToWidth: async () => viewerState, fitToPage: async () => viewerState,
    rotate: async () => viewerState, setNight: async () => viewerState, search: async () => viewerState,
    nextMatch: () => viewerState, loadOutline: async () => [], handleKeydown: () => null
  };
}

function legacyPreparation(format, options) {
  if (typeof options.prepareBytes === 'function') return options.prepareBytes;
  return (bytes, context = {}) => convertLegacyOfficeBytes(format, bytes, {
    signal: context.signal,
    timeoutMs: context.timeoutMs,
    password: options.password,
    workerFactory: options.legacyWorkerFactory,
    moduleLoader: options.legacyModuleLoader
  });
}

export function createLegacyDocViewer(options = {}) {
  return createDocxViewer({
    ...options,
    documentKind: 'doc',
    prepareBytes: legacyPreparation('doc', options)
  });
}

export function createLegacyPptViewer(options = {}) {
  return createPptxViewer({
    ...options,
    documentKind: 'ppt',
    prepareBytes: legacyPreparation('ppt', options)
  });
}

export function createViewerForKind(kind, options = {}) {
  switch (kind) {
    case 'ppt': return createLegacyPptViewer(options);
    case 'pptx': return createPptxViewer(options);
    case 'doc': return createLegacyDocViewer(options);
    case 'docx': return createDocxViewer(options);
    case 'xls': return createSpreadsheetViewer({ ...options, documentKind: 'xls' });
    case 'xlsx': return createSpreadsheetViewer(options);
    case 'image': return createImageViewer(options);
    case 'text': return createTextViewer(options);
    default: return createUnsupportedViewer(options);
  }
}
