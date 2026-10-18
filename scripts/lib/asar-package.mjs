import { listPackage } from '@electron/asar';

/**
 * Read an ASAR directory table in-process. Using `npx.cmd asar list` is not
 * portable: Node's Windows spawn API can reject .cmd launchers and return a
 * result whose stdout is undefined. This wrapper always returns a structured
 * result, so a damaged package becomes an actionable verification failure
 * instead of a TypeError that hides the real cause.
 */
export function inspectAsarPackage(asarPath, { listPackageImpl = listPackage } = {}) {
  try {
    const listed = listPackageImpl(asarPath);
    if (!Array.isArray(listed)) {
      return {
        ok: false,
        entries: new Set(),
        error: `ASAR reader returned ${listed === null ? 'null' : typeof listed} instead of an entry list`
      };
    }
    const entries = new Set(listed.map(normalizeEntry).filter(Boolean));
    return { ok: true, entries, error: '' };
  } catch (error) {
    return {
      ok: false,
      entries: new Set(),
      error: String(error?.message || error || 'unknown ASAR read failure').slice(0, 500)
    };
  }
}

function normalizeEntry(entry) {
  const value = String(entry || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return value;
}
