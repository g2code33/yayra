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
  row.style.cssText = [
    `text-align:${paragraph.align || level.align || 'left'}`,
    `font-size:${baseSize * PT_TO_PX}px`,
    `line-height:${paragraph.lineSpacing || 1.15}`,
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
    span.textContent = runIsSymbol
      ? symbolText(run.text, run.font || level.font, helpers)
      : String(run.text || '');
    const family = runIsSymbol ? '' : (run.font || (helpers?.isSymbolBulletFont?.(level.font) ? '' : level.font) || '');
    span.style.cssText = [
      run.sizePt ? `font-size:${run.sizePt * PT_TO_PX * (textModel.fontScale || 1)}px` : '',
      (run.bold ?? level.bold) ? 'font-weight:700' : '',
      (run.italic ?? level.italic) ? 'font-style:italic' : '',
      run.underline ? 'text-decoration:underline' : '',
      (run.color || level.color) ? `color:${run.color || level.color}` : '',
      family ? `font-family:${JSON.stringify(family)},${FONT_STACK}` : ''
    ].filter(Boolean).join(';');
    runs.appendChild(span);
  }
  row.appendChild(runs);
  return row;
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
        cell.color ? `color:${cell.color}` : '',
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

function renderImage(doc, shape, showImages) {
  if (!showImages || !shape.imageUrl || shape.w <= 0 || shape.h <= 0) return null;
  const radius = geometryRadius(shape.geom);
  if (!shape.crop) {
    const img = doc.createElement('img');
    img.className = 'fb-pptx-shape fb-pptx-image';
    img.src = shape.imageUrl;
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.style.cssText = `${shapeBase(shape)};object-fit:fill;${radius ? `border-radius:${radius};` : ''}user-select:none;`;
    return img;
  }
  const crop = shape.crop;
  const keptWidth = Math.max(1 - crop.l - crop.r, 0.01);
  const keptHeight = Math.max(1 - crop.t - crop.b, 0.01);
  const clip = doc.createElement('div');
  clip.className = 'fb-pptx-shape fb-pptx-image-crop';
  clip.style.cssText = `${shapeBase(shape)};overflow:hidden;${radius ? `border-radius:${radius};` : ''}`;
  const img = doc.createElement('img');
  img.src = shape.imageUrl;
  img.alt = '';
  img.draggable = false;
  img.style.cssText = `position:absolute;max-width:none;left:${-(crop.l * shape.w) / keptWidth}px;top:${-(crop.t * shape.h) / keptHeight}px;width:${shape.w / keptWidth}px;height:${shape.h / keptHeight}px;object-fit:fill;user-select:none;`;
  clip.appendChild(img);
  return clip;
}

function renderShape(doc, shape, helpers, showImages) {
  if (shape.type === 'image') return renderImage(doc, shape, showImages);
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
    'overflow:hidden',
    shape.fill ? `background:${shape.fill}` : '',
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
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Slide ${slide.slideNumber || ''}${slide.title ? `: ${slide.title}` : ''}`);
  canvas.style.cssText = [
    'position:relative',
    'overflow:hidden',
    `width:${px(width)}`,
    `height:${px(height)}`,
    `transform:scale(${scale})`,
    'transform-origin:top left',
    `background:${slide.background || '#fff'}`,
    slide.backgroundImageUrl ? `background-image:url(${JSON.stringify(slide.backgroundImageUrl)})` : '',
    slide.backgroundImageUrl ? 'background-size:cover;background-position:center' : '',
    `font-family:${FONT_STACK}`,
    thumbnail ? 'pointer-events:none;user-select:none' : ''
  ].filter(Boolean).join(';');
  for (const shape of slide.shapes || []) append(canvas, renderShape(doc, shape, helpers, showImages));
  frame.appendChild(canvas);
  container.appendChild(frame);
  return { frame, canvas };
}
