const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * Find a desktop-opened PDF in Electron's launch arguments. Linux desktop
 * entries using the %U field code pass file:/// URLs (including percent-
 * encoded spaces); Windows/macOS commonly pass a filesystem path instead.
 * Only local, existing .pdf files are returned.
 */
function parsePdfFileArg(argv) {
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
      // Do not mistake arbitrary URLs for paths (a drive-letter path such
      // as C:\\docs\\file.pdf is intentionally not matched by this test).
      continue;
    }

    if (!/\.pdf$/i.test(candidate)) continue;
    try {
      const absolutePath = path.resolve(candidate);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) return absolutePath;
    } catch {
      // Not a readable local file - keep scanning for the next argument.
    }
  }
  return null;
}

module.exports = { parsePdfFileArg };
