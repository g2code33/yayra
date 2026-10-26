/*
 * DOM renderer for the visual model emitted by the bundled pharmaTRACK PPTX
 * parser. This is intentionally framework-free so the same original deck is
 * rendered inside Yayra's existing browser shell on Electron, PWA and Android.
 */

const FONT_STACK = 'Calibri, Aptos, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const PT_TO_PX = 4 / 3;

const px = (value) => `${Math.max(0, Number(value) || 0)}px`;

function append(parent, child) {
  if (parent && child) parent.appendChild(child);
  return child;
}

function geometryRadius(geometry) {
  if (geometry === 'ellipse') return '50%';
  if (geometry === 'roundRect' || geometry === 'round1Rect' || geometry === 'round2SameRect' || geometry === 'round2DiagRect') return '10px';
  return '';
}

/**
 * OOXML can leave “automatic” text without a concrete run colour. Keep that
 * fallback tied to the authored slide/cell surface rather than inheriting the
 * surrounding Yayra theme (the projector chrome intentionally uses white).
 */
function readableForeground(background, fallback = '#000000') {
  const match = String(background || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return fallback;
  const raw = match[1].length === 3
    ? Array.from(match[1], (value) => `${value}${value}`).join('')
    : match[1];
  const channels = [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  // 0.179 is the crossover at which WCAG contrast against black becomes
  // greater than contrast against white; choose the stronger of the two.
  return luminance < 0.179 ? '#ffffff' : '#000000';
}

function symbolText(text, font, helpers) {
  const symbol = helpers?.isSymbolBulletFont?.(font);
  if (!symbol) return text;
  return Array.from(String(text || '')).map((char) => {
    const code = char.codePointAt(0) || 0;
    if (code < 0xf000 || code > 0xf0ff) return char;
    return helpers?.mapSymbolFontChar?.(char, font)
      || helpers?.normalizeBulletGlyph?.(char)
      || char;
  }).join('');
}

function fitTextFrame(frame, inner, anchor) {
  const run = () => {
    if (!frame?.isConnected || !inner) return;
    let scale = 1;
    inner.style.transform = '';
    inner.style.width = '100%';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const overflowY = Number(inner.scrollHeight || 0) - Number(frame.clientHeight || 0);
      const overflowX = Number(inner.scrollWidth || 0) - Number(frame.clientWidth || 0);
      if (overflowY <= Math.max(4, Number(frame.clientHeight || 0) * 0.04) && overflowX <= 2) break;
      const hRatio = Number(frame.clientHeight || 1) / Math.max(Number(inner.scrollHeight || 1), 1);
      const wRatio = Number(frame.clientWidth || 1) / Math.max(Number(inner.scrollWidth || 1), 1);
      scale = Math.max(0.55, Math.min(scale * 0.92, scale * hRatio, scale * wRatio));
      inner.style.transform = `scale(${scale})`;
      inner.style.width = `${100 / scale}%`;
      if (scale <= 0.55) break;
    }
    inner.style.transformOrigin = anchor === 'ctr' ? 'center top' : anchor === 'b' ? 'center bottom' : 'top left';
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function renderParagraph(doc, paragraph, textModel, helpers) {
  const row = doc.createElement('div');
  row.className = 'fb-pptx-paragraph';
  const level = textModel.levels?.[paragraph.level] || {};
  const runSize = paragraph.runs?.find((run) => Number(run.sizePt) > 0)?.sizePt;
  const baseSize = (runSize || level.sizePt || textModel.defaultSizePt || 18) * (textModel.fontScale || 1);
  const hasMath = Boolean(paragraph.runs?.some((run) => run.mathMl));
  if (hasMath) row.className += ' fb-pptx-math-paragraph';
  row.style.cssText = [
    `text-align:${paragraph.align || level.align || 'left'}`,
    `font-size:${baseSize * PT_TO_PX}px`,
    `line-height:${paragraph.lineSpacing || (hasMath ? 1.35 : 1.15)}`,
    `margin-top:${(paragraph.spaceBeforePt || 0) * PT_TO_PX}px`,
    `margin-bottom:${(paragraph.spaceAfterPt || 0) * PT_TO_PX}px`,
    level.indentPx ? `margin-left:${level.indentPx}px` : '',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere'
  ].filter(Boolean).join(';');

  const explicitBullet = paragraph.bullet;
  const bullet = explicitBullet === undefined ? (level.bullet || null) : explicitBullet;
  if (bullet) {
    const bulletEl = doc.createElement('span');
    bulletEl.className = 'fb-pptx-bullet';
    bulletEl.setAttribute('aria-hidden', 'true');
    bulletEl.textContent = `${helpers?.normalizeBulletGlyph?.(bullet) || bullet}\u00a0`;
    bulletEl.style.cssText = 'display:inline-block; width:1.4em; white-space:pre; vertical-align:top;';
    row.appendChild(bulletEl);
  }

  const runs = doc.createElement('span');
  runs.className = 'fb-pptx-runs';
  for (const run of paragraph.runs || []) {
    const span = doc.createElement('span');
    const inheritedSymbol = !run.font && helpers?.isSymbolBulletFont?.(level.font);
    const runIsSymbol = helpers?.isSymbolBulletFont?.(run.font) || inheritedSymbol;
    if (run.mathMl) {
      span.className = 'fb-pptx-math-run';
      // mathMl is produced exclusively by the local OMML converter, which
      // emits a fixed MathML vocabulary and escapes every package string.
      span.innerHTML = run.mathMl;
      span.setAttribute('aria-label', String(run.text || 'Equation'));
    } else {
      span.textContent = runIsSymbol
        ? symbolText(run.text, run.font || level.font, helpers)
        : String(run.text || '');
    }
    const family = run.mathMl
      ? 'Cambria Math'
      : runIsSymbol ? '' : (run.font || (helpers?.isSymbolBulletFont?.(level.font) ? '' : level.font) || '');
    span.style.cssText = [
      run.mathMl ? 'display:inline-block;vertical-align:middle;max-width:100%' : '',
      run.sizePt ? `font-size:${run.sizePt * PT_TO_PX * (textModel.fontScale || 1)}px` : '',
      (run.bold ?? level.bold) ? 'font-weight:700' : '',
      (run.italic ?? level.italic) ? 'font-style:italic' : '',
      run.underline ? 'text-decoration:underline' : '',
      (run.color || level.color) ? `color:${run.color || level.color}` : '',
      family ? `font-family:${JSON.stringify(family)},${run.mathMl ? '"STIX Two Math", "Latin Modern Math", serif' : FONT_STACK}` : ''
    ].filter(Boolean).join(';');
    runs.appendChild(span);
  }
  row.appendChild(runs);
  return row;
}

function titleShapeWithinSlide(shape, width, height) {
  if (!shape?.isTitle) return shape;
  const slideWidth = Math.max(0, Number(width) || 0);
  const slideHeight = Math.max(0, Number(height) || 0);
  const boundedWidth = Math.min(slideWidth, Math.max(0, Number(shape.w) || 0));
  const boundedHeight = Math.min(slideHeight, Math.max(0, Number(shape.h) || 0));
  if (!slideWidth || !slideHeight || !boundedWidth || !boundedHeight) return shape;
  // PowerPoint occasionally places a title placeholder partly beyond the
  // slide edge (often after a layout/theme conversion). The canvas clips
  // everything outside its bounds, so shift the whole title frame inward
  // instead of silently losing the end of the heading.
  return {
    ...shape,
    x: Math.max(0, Math.min(Number(shape.x) || 0, slideWidth - boundedWidth)),
    y: Math.max(0, Math.min(Number(shape.y) || 0, slideHeight - boundedHeight)),
    w: boundedWidth,
    h: boundedHeight
  };
}

function shapeBase(shape) {
  return [
    'position:absolute',
    `left:${px(shape.x)}`,
    `top:${px(shape.y)}`,
    `width:${px(shape.w)}`,
    `height:${px(shape.h)}`,
    shape.rot ? `transform:rotate(${shape.rot}deg)` : '',
    'transform-origin:center center'
  ].filter(Boolean).join(';');
}

function renderTable(doc, shape) {
  if (!shape.table?.cells?.length) return null;
  const wrap = doc.createElement('div');
  wrap.className = 'fb-pptx-shape fb-pptx-table-shape';
  wrap.style.cssText = `${shapeBase(shape)};overflow:hidden;`;
  const table = doc.createElement('table');
  table.style.cssText = `width:100%;height:100%;table-layout:fixed;border-collapse:collapse;font-family:${FONT_STACK};`;
  if (shape.table.colWidths?.length) {
    const group = doc.createElement('colgroup');
    for (const width of shape.table.colWidths) {
      const col = doc.createElement('col');
      if (shape.w > 0) col.style.width = `${((width / shape.w) * 100).toFixed(2)}%`;
      group.appendChild(col);
    }
    table.appendChild(group);
  }
  const body = doc.createElement('tbody');
  shape.table.cells.forEach((row, rowIndex) => {
    const tr = doc.createElement('tr');
    if (shape.table.rowHeights?.[rowIndex]) tr.style.height = px(shape.table.rowHeights[rowIndex]);
    row.forEach((cell) => {
      if (cell.merged) return;
      const td = doc.createElement('td');
      if (cell.gridSpan) td.colSpan = cell.gridSpan;
      if (cell.rowSpan) td.rowSpan = cell.rowSpan;
      td.textContent = String(cell.text || '');
      const borders = cell.borders || {};
      td.style.cssText = [
        cell.fill ? `background:${cell.fill}` : '',
        `border-top:${borders.t ? `1px solid ${borders.t}` : '1px solid rgba(0,0,0,.25)'}`,
        `border-right:${borders.r ? `1px solid ${borders.r}` : '1px solid rgba(0,0,0,.25)'}`,
        `border-bottom:${borders.b ? `1px solid ${borders.b}` : '1px solid rgba(0,0,0,.25)'}`,
        `border-left:${borders.l ? `1px solid ${borders.l}` : '1px solid rgba(0,0,0,.25)'}`,
        'padding:2px 5px',
        `font-size:${(cell.sizePt || 14) * PT_TO_PX * (shape.textScale || 1)}px`,
        cell.bold ? 'font-weight:700' : '',
        cell.color ? `color:${cell.color}` : (cell.fill ? `color:${readableForeground(cell.fill)}` : ''),
        'vertical-align:middle',
        'overflow:hidden'
      ].filter(Boolean).join(';');
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function imageSources(shape) {
  const candidates = Array.isArray(shape.imageUrls) ? shape.imageUrls : [];
  return [...new Set([shape.imageUrl, ...candidates].filter((value) => typeof value === 'string' && value))];
}

function unavailableImage(doc, shape, thumbnail) {
  const fallback = doc.createElement('div');
  fallback.className = 'fb-pptx-shape fb-pptx-image-unavailable';
  fallback.setAttribute('role', 'img');
  fallback.setAttribute('aria-label', 'Presentation image unavailable');
  fallback.style.cssText = `${shapeBase(shape)};display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:8px;overflow:hidden;border:1px solid rgba(100,116,139,.35);background:linear-gradient(135deg,#f8fafc,#e2e8f0);color:#475569;font:600 ${thumbnail ? 8 : 12}px ${FONT_STACK};text-align:center;`;
  fallback.textContent = thumbnail ? 'Image' : 'Image unavailable';
  return fallback;
}

function installImageFallback(img, sources, onExhausted) {
  let index = 0;
  img.addEventListener('error', () => {
    index += 1;
    if (index < sources.length) {
      img.src = sources[index];
      img.setAttribute?.('src', sources[index]);
      return;
    }
    onExhausted?.();
  });
}

function renderImage(doc, shape, showImages, thumbnail) {
  const sources = imageSources(shape);
  if (!showImages || !sources.length || shape.w <= 0 || shape.h <= 0) return null;
  const radius = geometryRadius(shape.geom);
  if (!shape.crop) {
    const img = doc.createElement('img');
    img.className = 'fb-pptx-shape fb-pptx-image';
    img.src = sources[0];
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.style.cssText = `${shapeBase(shape)};object-fit:fill;${radius ? `border-radius:${radius};` : ''}user-select:none;`;
    installImageFallback(img, sources, () => img.replaceWith?.(unavailableImage(doc, shape, thumbnail)));
    return img;
  }
  const crop = shape.crop;
  const keptWidth = Math.max(1 - crop.l - crop.r, 0.01);
  const keptHeight = Math.max(1 - crop.t - crop.b, 0.01);
  const clip = doc.createElement('div');
  clip.className = 'fb-pptx-shape fb-pptx-image-crop';
  clip.style.cssText = `${shapeBase(shape)};overflow:hidden;${radius ? `border-radius:${radius};` : ''}`;
  const img = doc.createElement('img');
  img.src = sources[0];
  img.alt = '';
  img.draggable = false;
  img.style.cssText = `position:absolute;max-width:none;left:${-(crop.l * shape.w) / keptWidth}px;top:${-(crop.t * shape.h) / keptHeight}px;width:${shape.w / keptWidth}px;height:${shape.h / keptHeight}px;object-fit:fill;user-select:none;`;
  installImageFallback(img, sources, () => clip.replaceWith?.(unavailableImage(doc, shape, thumbnail)));
  clip.appendChild(img);
  return clip;
}

function stopMediaEvent(event) {
  event?.stopPropagation?.();
}

function renderVideo(doc, shape, showImages, thumbnail) {
  if (!showImages || shape.w <= 0 || shape.h <= 0) return null;

  // Thumbnails must stay lightweight and non-interactive. Linked-only clips
  // also remain offline: PowerPoint's poster frame is the honest fallback and
  // no external relationship is fetched by the document engine.
  if (thumbnail || !shape.videoUrl) {
    if (shape.imageUrl) {
      const poster = doc.createElement('img');
      poster.className = 'fb-pptx-shape fb-pptx-video-poster';
      poster.src = shape.imageUrl;
      poster.alt = thumbnail ? '' : 'Video poster; the linked clip is unavailable offline';
      poster.draggable = false;
      poster.loading = 'lazy';
      poster.style.cssText = `${shapeBase(shape)};object-fit:contain;background:#000;user-select:none;`;
      if (!thumbnail && !shape.videoUrl) poster.title = 'This video is linked rather than embedded, so only its poster is available offline.';
      return poster;
    }
    const unavailable = doc.createElement('div');
    unavailable.className = 'fb-pptx-shape fb-pptx-video-unavailable';
    unavailable.setAttribute('role', 'img');
    unavailable.setAttribute('aria-label', 'Embedded video unavailable');
    unavailable.style.cssText = `${shapeBase(shape)};display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;background:#000;color:#fff;font:600 12px ${FONT_STACK};text-align:center;`;
    unavailable.textContent = thumbnail ? 'Video' : 'Video unavailable';
    return unavailable;
  }

  const video = doc.createElement('video');
  video.className = 'fb-pptx-shape fb-pptx-video';
  video.dataset.pptxVideo = 'true';
  video.src = shape.videoUrl;
  video.setAttribute('src', shape.videoUrl);
  if (shape.imageUrl) {
    video.poster = shape.imageUrl;
    video.setAttribute('poster', shape.imageUrl);
  }
  video.controls = true;
  video.setAttribute('controls', '');
  video.preload = 'metadata';
  video.setAttribute('preload', 'metadata');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.tabIndex = 0;
  video.setAttribute('aria-label', 'Embedded video');
  video.title = 'Click to play. When focused, Space pauses or resumes and arrow keys seek.';
  video.style.cssText = `${shapeBase(shape)};object-fit:contain;background:#000;`;
  // Slide navigation uses the same keys as native media controls. Once the
  // player is focused, its clicks and key presses belong to it alone.
  for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'keydown']) {
    video.addEventListener(type, stopMediaEvent);
  }
  video.addEventListener('error', () => {
    // Chromium cannot decode every historical PowerPoint codec (notably some
    // WMV variants). Keep the slide visually faithful instead of replacing
    // the entire video frame with a broken-media glyph.
    if (!shape.imageUrl || !video.parentElement) return;
    const poster = doc.createElement('img');
    poster.className = 'fb-pptx-shape fb-pptx-video-poster fb-pptx-video-codec-fallback';
    poster.src = shape.imageUrl;
    poster.alt = 'Video poster; this video codec is not supported on this device';
    poster.draggable = false;
    poster.title = 'This video’s codec is not supported on this device. The embedded poster is shown instead.';
    poster.style.cssText = `${shapeBase(shape)};object-fit:contain;background:#000;user-select:none;`;
    video.parentElement.replaceChild(poster, video);
  });
  return video;
}

function renderShape(doc, shape, helpers, showImages, thumbnail) {
  if (shape.type === 'video') return renderVideo(doc, shape, showImages, thumbnail);
  if (shape.type === 'image') return renderImage(doc, shape, showImages, thumbnail);
  if (shape.type === 'table') return renderTable(doc, shape);
  if (shape.type === 'line') {
    const line = doc.createElement('div');
    line.className = 'fb-pptx-shape fb-pptx-line';
    line.setAttribute('aria-hidden', 'true');
    line.style.cssText = `${shapeBase(shape)};background:${shape.fill || shape.borderColor || '#000'};min-width:${Math.max(shape.w || 0, 1)}px;min-height:${Math.max(shape.h || 0, shape.borderWidth || 2)}px;border-radius:2px;`;
    return line;
  }
  if (shape.type === 'chart') {
    const chart = doc.createElement('div');
    chart.className = 'fb-pptx-shape fb-pptx-chart';
    chart.style.cssText = `${shapeBase(shape)};display:flex;align-items:center;justify-content:center;border:1px dashed #94a3b8;background:rgba(248,250,252,.88);color:#64748b;font:600 12px ${FONT_STACK};`;
    chart.textContent = 'Chart (static preview unavailable)';
    return chart;
  }

  const frame = doc.createElement('div');
  frame.className = `fb-pptx-shape fb-pptx-text${shape.isTitle ? ' fb-pptx-title' : ''}`;
  frame.dataset.shape = shape.isTitle ? 'title' : 'text';
  frame.style.cssText = [
    shapeBase(shape),
    shape.isTitle ? 'overflow:visible' : 'overflow:hidden',
    shape.fill ? `background:${shape.fill}` : '',
    shape.fill ? `color:${readableForeground(shape.fill)}` : '',
    shape.borderColor ? `border:${Math.max(1, shape.borderWidth || 1)}px solid ${shape.borderColor}` : '',
    geometryRadius(shape.geom) ? `border-radius:${geometryRadius(shape.geom)}` : '',
    'cursor:text',
    'user-select:text'
  ].filter(Boolean).join(';');
  const text = shape.text;
  if (!text) return frame;
  const inner = doc.createElement('div');
  inner.className = 'fb-pptx-text-inner';
  const justify = text.anchor === 'ctr' ? 'center' : text.anchor === 'b' ? 'flex-end' : 'flex-start';
  inner.style.cssText = `height:100%;display:flex;flex-direction:column;justify-content:${justify};padding:5px 9px;box-sizing:border-box;transform-origin:top left;`;
  for (const paragraph of text.paragraphs || []) inner.appendChild(renderParagraph(doc, paragraph, text, helpers));
  frame.appendChild(inner);
  fitTextFrame(frame, inner, text.anchor);
  return frame;
}

/** Render one slide at native PowerPoint coordinates, scaled by its wrapper. */
export function renderPptxSlide(container, {
  slide,
  width,
  height,
  scale = 1,
  helpers = null,
  showImages = true,
  thumbnail = false
} = {}) {
  if (!container || !slide) return null;
  container.replaceChildren?.();
  const doc = container.ownerDocument || document;
  const frame = doc.createElement('div');
  frame.className = thumbnail ? 'fb-pptx-thumbnail-frame' : 'fb-pptx-stage-frame';
  frame.style.cssText = `position:relative;flex:0 0 auto;width:${px(width * scale)};height:${px(height * scale)};`;
  const canvas = doc.createElement('div');
  canvas.className = 'fb-pptx-slide-canvas';
  canvas.dataset.slide = String(slide.slideNumber || '');
  // role=img makes descendants presentational, which would hide playable
  // videos from assistive technology. Interactive slides are labelled groups;
  // ordinary slides retain the concise image-like announcement.
  const hasVideo = !thumbnail && (slide.shapes || []).some((shape) => shape.type === 'video');
  canvas.setAttribute('role', hasVideo ? 'group' : 'img');
  canvas.setAttribute('aria-label', `Slide ${slide.slideNumber || ''}${slide.title ? `: ${slide.title}` : ''}`);
  canvas.style.cssText = [
    'position:relative',
    'overflow:hidden',
    `width:${px(width)}`,
    `height:${px(height)}`,
    `transform:scale(${scale})`,
    'transform-origin:top left',
    `background:${slide.background || '#fff'}`,
    // PowerPoint's unresolved/automatic text defaults to the slide canvas,
    // not to Yayra's surrounding chrome. Pin a surface-aware default so
    // tables and runs without an explicit OOXML colour cannot inherit the
    // white text used by the projector overlay.
    `color:${readableForeground(slide.background)}`,
    slide.backgroundImageUrl ? `background-image:url(${JSON.stringify(slide.backgroundImageUrl)})` : '',
    slide.backgroundImageUrl ? 'background-size:cover;background-position:center' : '',
    `font-family:${FONT_STACK}`,
    thumbnail ? 'pointer-events:none;user-select:none' : ''
  ].filter(Boolean).join(';');
  for (const shape of slide.shapes || []) {
    append(canvas, renderShape(doc, titleShapeWithinSlide(shape, width, height), helpers, showImages, thumbnail));
  }
  const diagnostics = Array.isArray(slide.diagnostics) ? slide.diagnostics.filter((item) => item?.message) : [];
  if (diagnostics.length) {
    const warning = doc.createElement('div');
    warning.className = 'fb-pptx-fidelity-warning';
    warning.setAttribute('role', 'status');
    warning.setAttribute('aria-label', diagnostics.map((item) => item.message).join(' '));
    warning.title = diagnostics.map((item) => item.message).join('\n');
    warning.textContent = thumbnail ? '⚠' : `⚠ Rendering issue${diagnostics.length > 1 ? `s (${diagnostics.length})` : ''}`;
    warning.style.cssText = `position:absolute;right:8px;bottom:8px;z-index:999;max-width:45%;padding:${thumbnail ? '1px 3px' : '4px 7px'};border:1px solid #d97706;border-radius:5px;background:#fffbeb;color:#92400e;font:700 ${thumbnail ? 8 : 11}px ${FONT_STACK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(15,23,42,.18);`;
    canvas.appendChild(warning);
  }
  frame.appendChild(canvas);
  container.appendChild(frame);
  return { frame, canvas };
}
