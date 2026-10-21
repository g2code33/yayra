import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';

import { inspectAsarPackage } from '../scripts/lib/asar-package.mjs';

const REQUIRED = [
  'dist/index.html',
  'dist/packages/shared-ui/src/vendor/pdfjs/pdf.mjs',
  'dist/packages/shared-ui/src/vendor/pdfjs/pdf.worker.mjs'
];

test('ASAR verifier reads a real package in-process with normalized entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yayra-asar-'));
  const input = path.join(root, 'input');
  const archive = path.join(root, 'app.asar');
  try {
    for (const entry of REQUIRED) {
      const target = path.join(input, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.endsWith('.html') ? '<!doctype html>' : 'export const ready = true;');
    }
    await createPackage(input, archive);
    const result = inspectAsarPackage(archive);
    assert.equal(result.ok, true, result.error);
    for (const entry of REQUIRED) assert.equal(result.entries.has(entry), true, `${entry} should be listed`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ASAR verifier returns structured failures instead of reading includes from undefined', () => {
  const missingOutput = inspectAsarPackage('unused.asar', { listPackageImpl: () => undefined });
  assert.equal(missingOutput.ok, false);
  assert.match(missingOutput.error, /undefined instead of an entry list/);
  assert.equal(missingOutput.entries.size, 0);

  const thrown = inspectAsarPackage('unused.asar', { listPackageImpl: () => { throw new Error('damaged header'); } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /damaged header/);
});

test('Packaging verification does not launch the platform-specific npx.cmd ASAR shim', async () => {
  const source = await readFile(new URL('../scripts/verify-packaging.mjs', import.meta.url), 'utf8');
  assert.match(source, /inspectAsarPackage\(asarPath\)/);
  assert.doesNotMatch(source, /npx\.cmd|\['asar', 'list'/,
    'Windows verification must use the cross-platform library API rather than spawning a .cmd file');
  assert.match(source, /if \(!asar\.ok\) continue/,
    'a reader failure is reported without dereferencing a missing entry list');
});
