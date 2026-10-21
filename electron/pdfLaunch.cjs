const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Keep this module name/export backward-compatible with the v1 PDF-only
// integration. The parser now accepts every local format for which Yayra has
// either a bundled viewer or an explicit original-file fallback.
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'pptx', 'pptm', 'docx', 'xlsx', 'xlsm', 'xls', 'csv',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg',
  'txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml',
  'ppt', 'doc'
]);

/**
 * Find a desktop-opened local document in Electron's launch arguments. Linux
 * desktop entries using %U pass file:/// URLs (including encoded spaces);
 * Windows/macOS commonly pass a filesystem path. Remote URLs, command-line
 * switches, missing files and unregistered extensions are never read.
 */
function parseDocumentFileArg(argv) {
  for (const arg of argv || []) {
    if (typeof arg !== 'string' || arg === '' || arg.startsWith('--')) continue;
    const raw = arg.replace(/^["']|["']$/g, '');
    let candidate = raw;

    if (/^file:/i.test(raw)) {
      try {
        const fileUrl = new URL(raw);
        if (fileUrl.protocol !== 'file:') continue;
        candidate = fileURLToPath(fileUrl);
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
      // Do not mistake a remote URL for a path. A Windows drive path such as
      // C:\\docs\\file.pptx is intentionally not matched by this expression.
      continue;
    }

    const extension = path.extname(candidate).slice(1).toLowerCase();
    if (!DOCUMENT_EXTENSIONS.has(extension)) continue;
    try {
      const absolutePath = path.resolve(candidate);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) return absolutePath;
    } catch {
      // Not a readable local file; continue scanning arguments.
    }
  }
  return null;
}

// Legacy API name retained so packaged installs and old source pins keep
// working while its behavior grows from PDF-only to the unified workspace.
const parsePdfFileArg = parseDocumentFileArg;

module.exports = { DOCUMENT_EXTENSIONS, parseDocumentFileArg, parsePdfFileArg };
