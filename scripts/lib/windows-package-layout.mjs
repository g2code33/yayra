import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Find the packaged application executable, never a bundled helper such as
 * elevate.exe. electron-builder puts the main binary at the root of an
 * unpacked Windows directory; installers and helper executables are different
 * artifacts and must not stand in for the app's ProductVersion check.
 */
export async function findPackagedWindowsExecutable(releaseDir, executableName = 'yayra') {
  if (!existsSync(releaseDir)) return null;
  const rawName = String(executableName || 'yayra');
  if (path.basename(rawName) !== rawName) return null;
  const baseName = rawName.replace(/\.exe$/i, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(baseName)) return null;
  const expectedName = `${baseName}.exe`;

  const preferred = path.join(releaseDir, 'win-unpacked', expectedName);
  if (await isFile(preferred)) return preferred;

  // Multi-architecture electron-builder layouts may include the architecture
  // in the unpacked directory name. Inspect only those directory roots and
  // only the exact configured executable name—never recurse into helpers.
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const unpackedDirs = entries
    .filter((entry) => entry.isDirectory() && /^win(?:-[a-z0-9_-]+)?-unpacked$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const directory of unpackedDirs) {
    const candidate = path.join(releaseDir, directory, expectedName);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function isFile(file) {
  if (!existsSync(file)) return false;
  try { return (await stat(file)).isFile(); } catch { return false; }
}
