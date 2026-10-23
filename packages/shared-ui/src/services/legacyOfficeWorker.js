/*
 * Short-lived, same-origin worker for Word/PowerPoint 97-2003 conversion.
 * It receives a disposable COPY of the source bytes. The DocumentStore keeps
 * the unchanged original in the renderer for Download/Open-original.
 */
import { convertLegacyOffice } from '../vendor/documents/legacyOffice.mjs';

function safeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error',
    message: typeof error?.message === 'string'
      ? error.message.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 500)
      : 'The legacy Office file could not be converted.',
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : ''
  };
}

globalThis.addEventListener('message', (event) => {
  const request = event?.data || {};
  const id = String(request.id || '');
  try {
    const input = new Uint8Array(request.bytes);
    const result = convertLegacyOffice(request.format, input, {
      password: typeof request.password === 'string' ? request.password : undefined
    });
    const output = result.bytes.byteOffset === 0
      && result.bytes.byteLength === result.bytes.buffer.byteLength
      ? result.bytes
      : result.bytes.slice();
    globalThis.postMessage({ id, ok: true, bytes: output.buffer, warnings: result.warnings }, [output.buffer]);
  } catch (error) {
    globalThis.postMessage({ id, ok: false, error: safeError(error) });
  }
});
