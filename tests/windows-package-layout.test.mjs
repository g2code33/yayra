import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findPackagedWindowsExecutable } from '../scripts/lib/windows-package-layout.mjs';

test('Windows packaging verifier selects yayra.exe, never Electron helper or installer executables', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yayra-win-layout-'));
  const release = path.join(root, 'release');
  const unpacked = path.join(release, 'win-unpacked');
  try {
    await mkdir(unpacked, { recursive: true });
    await writeFile(path.join(unpacked, 'elevate.exe'), 'helper');
    await writeFile(path.join(release, 'yayra-setup-1.0.60.exe'), 'installer');
    assert.equal(await findPackagedWindowsExecutable(release, 'yayra'), null,
      'helpers and top-level installers cannot impersonate the packaged application');

    const appExe = path.join(unpacked, 'yayra.exe');
    await writeFile(appExe, 'application');
    assert.equal(await findPackagedWindowsExecutable(release, 'yayra'), appExe);
    assert.equal(await findPackagedWindowsExecutable(release, 'yayra.exe'), appExe,
      'an executableName that already includes .exe remains supported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows packaging verifier supports architecture-specific unpacked roots deterministically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yayra-win-arch-layout-'));
  const release = path.join(root, 'release');
  try {
    const arm = path.join(release, 'win-arm64-unpacked');
    const x64 = path.join(release, 'win-x64-unpacked');
    await mkdir(arm, { recursive: true });
    await mkdir(x64, { recursive: true });
    await writeFile(path.join(arm, 'yayra.exe'), 'arm');
    await writeFile(path.join(x64, 'yayra.exe'), 'x64');
    assert.equal(await findPackagedWindowsExecutable(release, 'yayra'), path.join(arm, 'yayra.exe'),
      'architecture directories are sorted rather than filesystem-order dependent');
    assert.equal(await findPackagedWindowsExecutable(release, '../elevate'), null,
      'configured executable names cannot escape the unpacked root');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Packaging verification reports actionable GitHub annotations and exact app selection', async () => {
  const source = await readFile(new URL('../scripts/verify-packaging.mjs', import.meta.url), 'utf8');
  assert.match(source, /findPackagedWindowsExecutable\(path\.join\(root, 'release'\), build\.executableName\)/);
  assert.doesNotMatch(source, /else if \(\/\\\.exe\$\/i\.test\(entry\)\)/,
    'the verifier must not recursively accept the first arbitrary .exe');
  assert.match(source, /::error title=Packaging verification::/,
    'future release-gate failures remain visible even when Actions log archives are inaccessible');
});
