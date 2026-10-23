/*
 * Local Windows Metafile bridge for PowerPoint image parts.
 *
 * PowerPoint frequently stores diagrams as EMF/WMF. Chromium cannot decode
 * either format, so handing the raw Blob to <img> produces the broken-image
 * marker seen on otherwise valid slides. emf-converter replays the local GDI
 * records into a standalone SVG; no package bytes leave the device.
 */
import { convertMetafileToSvg } from 'emf-converter';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_SVG_BYTES = 32 * 1024 * 1024;

function ownedArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new TypeError('Metafile input must be binary data');
}

function supportsExactCanvasMirror(): boolean {
  if (typeof document === 'undefined') return true; // pure-JS/worker backend
  try {
    const context = document.createElement('canvas').getContext('2d');
    return Boolean(context
      && typeof context.setLineDash === 'function'
      && typeof context.getImageData === 'function'
      && typeof context.putImageData === 'function'
      && typeof context.createImageData === 'function');
  } catch {
    return false;
  }
}

export async function convertMetafileToSafeSvg(value: ArrayBuffer | ArrayBufferView): Promise<Blob> {
  const input = ownedArrayBuffer(value);
  if (!input.byteLength) throw new Error('Metafile is empty');
  if (input.byteLength > MAX_INPUT_BYTES) throw new Error('Metafile exceeds the local conversion limit');

  const svg = await convertMetafileToSvg(input, {
    maxWidth: 8192,
    maxHeight: 8192,
    maxCanvasDimension: 8192,
    maxRecords: 500_000,
    gdiAntialias: true,
    // Partial canvas shims exist in some embedded shells. Fall back to SVG
    // blend modes there rather than failing the whole picture conversion.
    exactRasterOps: supportsExactCanvasMirror(),
    includeSize: true
  });
  if (typeof svg !== 'string' || !/^\s*<svg(?:\s|>)/i.test(svg)) {
    throw new Error('Metafile could not be converted');
  }
  const size = new TextEncoder().encode(svg).byteLength;
  if (size > MAX_SVG_BYTES) throw new Error('Converted metafile exceeds the SVG limit');
  return new Blob([svg], { type: 'image/svg+xml' });
}
