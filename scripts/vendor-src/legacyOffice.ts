/*!
 * Yayra local legacy-Office bridge.
 *
 * Word 97-2003 and PowerPoint 97-2003 parsing is provided by the MIT-licensed
 * doc-codec and ppt-codec projects. The parsed, inert content model is rebuilt
 * as macro-free OOXML with documents.js/ooxml.js so Yayra can reuse its
 * existing DOCX and PPTX viewers. No source bytes are modified or uploaded.
 * See packages/shared-ui/src/vendor/documents/LEGACY-OFFICE-NOTICES.md.
 */
import { readDocContent } from 'doc-codec';
import { readPptContent } from 'ppt-codec';
import { buildDocxPackage } from 'documents.js/edit/docx/content';
import { buildPptxPackage } from 'documents.js/edit/pptx/content';
import { encodePackage } from 'ooxml.js';

export type LegacyOfficeFormat = 'doc' | 'ppt';

export interface LegacyOfficeConversionResult {
  bytes: Uint8Array;
  warnings: string[];
}

function asBytes(value: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Legacy Office conversion requires binary bytes');
}

function diagnosticMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value || 'Some legacy content was simplified.');
  const item = value as { code?: unknown; message?: unknown };
  const code = typeof item.code === 'string' ? item.code.trim() : '';
  const message = typeof item.message === 'string' ? item.message.trim() : '';
  return [code, message].filter(Boolean).join(': ') || 'Some legacy content was simplified.';
}

function warningCollector() {
  const warnings: string[] = [];
  return {
    warnings,
    receive(value: unknown) {
      const message = diagnosticMessage(value);
      if (!warnings.includes(message) && warnings.length < 24) warnings.push(message);
    }
  };
}

/**
 * Convert an inert binary Office document into an in-memory OOXML viewing
 * copy. The caller owns the original source bytes and must retain them for
 * Download/Open-original actions. The result contains no VBA project.
 */
export function convertLegacyOffice(
  format: LegacyOfficeFormat,
  value: Uint8Array | ArrayBuffer | ArrayBufferView,
  options: { password?: string } = {}
): LegacyOfficeConversionResult {
  const bytes = asBytes(value);
  if (bytes.byteLength < 512) throw new Error('Legacy Office container is incomplete');
  const diagnostics = warningCollector();
  let converted: Uint8Array;

  if (format === 'doc') {
    const content = readDocContent(bytes, options.password);
    converted = encodePackage(buildDocxPackage(content, {
      onDiagnostic: (diagnostic) => diagnostics.receive(diagnostic)
    }));
  } else if (format === 'ppt') {
    const source = readPptContent(bytes, options.password);
    const content = {
      kind: 'presentation' as const,
      metadata: { ...source.metadata },
      slides: [...source.slides]
    };
    converted = encodePackage(buildPptxPackage(content, {
      onDiagnostic: (diagnostic) => diagnostics.receive(diagnostic)
    }));
  } else {
    throw new TypeError(`Unsupported legacy Office format: ${String(format)}`);
  }

  if (converted.byteLength < 4
    || converted[0] !== 0x50 || converted[1] !== 0x4b
    || converted[2] !== 0x03 || converted[3] !== 0x04) {
    throw new Error('Legacy Office conversion did not produce a valid viewing package');
  }
  return { bytes: converted, warnings: diagnostics.warnings };
}
