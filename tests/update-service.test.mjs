import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_UPDATE_CONFIG, compareSemver } from '../src/config/updates.js';
import { MemoryStorage, PromptSession, UpdateService, stablePercent } from '../src/services/updateService.js';
import { resolvePackageAssetPath } from '../src/services/archivePath.js';

const manifest = {
  schema: 1,
  channel: 'stable',
  latest: { windows: '1.2.0', linux: '1.2.0', android: '1.2.0', ios: '1.2.0', pwa: '1.2.0' },
  minSupported: { windows: '1.0.0', linux: '1.0.0', android: '1.0.0', ios: '1.0.0', pwa: '1.0.0' },
  downloads: {},
  notes: { en: 'notes' },
  rollout: { percent: 100, allowlist: [] },
  publishedAt: '2026-10-02T00:00:00.000Z',
  ttlSeconds: 300
};

test('semver comparison handles v prefix, prerelease, and build metadata', () => {
  assert.equal(compareSemver('v1.2.3+build.1', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(compareSemver('1.2.3-rc.2', '1.2.3-rc.10'), -1);
});

test('never offers a downgrade and reports ahead distinctly', async () => {
  const service = new UpdateService({
    target: 'windows',
    installedVersion: '2.0.0',
    fetchImpl: async () => jsonResponse(manifest),
    logger: () => {}
  });
  const state = await service.check({ manual: true });
  assert.equal(state.status, 'ahead');
  assert.equal(state.reason, 'installed-newer-than-release-channel');
});

test('up-to-date checks are logged as up_to_date rather than not_available', async () => {
  const lines = [];
  const current = { ...manifest, latest: { ...manifest.latest, linux: '1.0.44' } };
  const service = new UpdateService({
    target: 'linux', installedVersion: '1.0.44',
    fetchImpl: async () => jsonResponse(current),
    logger: (line) => lines.push(line)
  });
  const state = await service.check({ manual: true });
  assert.equal(state.status, 'upToDate');
  assert.ok(lines.some((line) => line.startsWith('[updates] up_to_date target=linux state=upToDate installed=1.0.44 available=1.0.44')));
  assert.equal(lines.some((line) => line.includes('[updates] not_available')), false);
});

test('offline state is unknown with lastSeenAt and not upToDate', async () => {
  let online = true;
  const storage = new MemoryStorage();
  const service = new UpdateService({
    target: 'linux',
    installedVersion: '1.1.0',
    storage,
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    fetchImpl: async () => {
      if (!online) throw new Error('offline');
      return jsonResponse(manifest);
    },
    logger: () => {}
  });
  assert.equal((await service.check({ manual: true })).status, 'available');
  online = false;
  service.lastManualCheckAt = 0;
  const offline = await service.check({ manual: true });
  assert.equal(offline.status, 'unknown');
  assert.equal(offline.lastSeenAt, '2026-10-02T12:00:00.000Z');
  assert.equal(offline.reason, 'offline');
});

test('download verifies byte size and sha256 before staging', async () => {
  const payload = new TextEncoder().encode('good-payload');
  const badSha = createHash('sha256').update('different').digest('hex');
  const service = new UpdateService({
    target: 'pwa',
    installedVersion: '1.0.0',
    fetchImpl: async (url) => {
      if (String(url).includes('manifest')) return jsonResponse({ ...manifest, downloads: { pwa: { url: 'https://yayra-updates-api.g2code335.workers.dev/payload', sha256: badSha, bytes: payload.byteLength } } });
      return bytesResponse(payload);
    },
    logger: () => {}
  });
  assert.equal((await service.check({ manual: true })).status, 'available');
  const result = await service.download();
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'checksum:sha256-mismatch');
  assert.equal(result.keptOldFile, true);
});

test('manual checks are throttled and one request is in flight', async () => {
  let count = 0;
  const service = new UpdateService({
    target: 'pwa',
    installedVersion: '1.0.0',
    now: () => 1000,
    fetchImpl: async () => { count += 1; return jsonResponse(manifest); },
    logger: () => {}
  });
  await Promise.all([service.check({ manual: true }), service.check({ manual: true })]);
  assert.equal(count, 1);
  const throttled = await service.check({ manual: true });
  assert.equal(count, 1);
  assert.ok(throttled.throttledUntil);
});

test('rollout hash is stable per device', () => {
  assert.equal(stablePercent('device-a'), stablePercent('device-a'));
  assert.notEqual(stablePercent('device-a'), stablePercent('device-b'));
});

test('snooze is persisted per version and prompt is shown once per open', () => {
  const storage = new MemoryStorage();
  const session = new PromptSession({ storage, platform: 'android', now: () => 1000 });
  const state = { status: 'available', version: '1.2.0' };
  assert.equal(session.shouldPrompt(state, DEFAULT_UPDATE_CONFIG), true);
  assert.equal(session.shouldPrompt(state, DEFAULT_UPDATE_CONFIG), false);
  const nextSession = new PromptSession({ storage, platform: 'android', now: () => 2000 });
  assert.equal(nextSession.shouldPrompt(state, DEFAULT_UPDATE_CONFIG), true);
  nextSession.dismiss('1.2.0', 'never-for-version');
  const afterDismiss = new PromptSession({ storage, platform: 'android', now: () => 3000 });
  assert.equal(afterDismiss.shouldPrompt(state, DEFAULT_UPDATE_CONFIG), false);
  assert.equal(afterDismiss.shouldPrompt({ status: 'available', version: '1.3.0' }, DEFAULT_UPDATE_CONFIG), true);
});

test('desktop header control is always mounted without manifest reachability', async () => {
  const index = await readFile('public/index.html', 'utf8');
  const main = await readFile('src/browser/main.js', 'utf8');
  const button = await readFile('src/browser/updateButton.js', 'utf8');
  assert.match(index, /id="top-header"/);
  assert.match(main, /mountUpdateButton/);
  assert.match(button, /dataset\.locked = 'persistent'/);
});

test('mobile and pwa targets ignore path-inside-archive desktop logic', () => {
  assert.equal(resolvePackageAssetPath('android', 'app.asar/dist/index.html'), null);
  assert.equal(resolvePackageAssetPath('ios', 'app.asar/dist/index.html'), null);
  assert.equal(resolvePackageAssetPath('pwa', 'app.asar/dist/index.html'), null);
  assert.equal(resolvePackageAssetPath('windows', 'app.asar/dist/index.html'), 'dist/index.html');
});

// --- artifact signature verification (pinned release key) -----------------
// scripts/sign-linux-artifacts.mjs signs artifacts (RSA-SHA256, detached);
// scripts/generate-update-manifest.mjs embeds the signature base64 as
// downloads.<target>.sig. When an UpdateService is constructed with the
// pinned public key, verification is END-TO-END and FAILS CLOSED: a
// compromised manifest host can rewrite url+sha256, but cannot produce a
// signature the pinned release key never made.

import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyRsaSha256 } from '../src/services/updateService.js';

function makeSigningFixture(payloadText = 'signed-release-payload') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = new TextEncoder().encode(payloadText);
  const signer = createSign('sha256');
  signer.update(payload);
  const sig = signer.sign(privateKey).toString('base64');
  return {
    payload,
    sig,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sha256: createHash('sha256').update(payload).digest('hex')
  };
}

function signedService(fixture, { sig = fixture.sig, updatePublicKey = fixture.publicKeyPem } = {}) {
  const download = { url: 'https://yayra-updates-api.g2code335.workers.dev/payload', sha256: fixture.sha256, bytes: fixture.payload.byteLength };
  if (sig !== null) download.sig = sig;
  return new UpdateService({
    target: 'pwa',
    installedVersion: '1.0.0',
    updatePublicKey,
    fetchImpl: async (url) => {
      if (String(url).includes('manifest')) return jsonResponse({ ...manifest, downloads: { pwa: download } });
      return bytesResponse(fixture.payload);
    },
    logger: () => {}
  });
}

test('download with a pinned public key stages only a correctly signed artifact', async () => {
  const fixture = makeSigningFixture();
  const service = signedService(fixture);
  assert.equal((await service.check({ manual: true })).status, 'available');
  const result = await service.download();
  assert.equal(result.status, 'ready');
  assert.equal(result.stagedDownload.sha256, fixture.sha256);
});

test('download with a pinned public key FAILS CLOSED on a missing or forged signature', async () => {
  const missing = signedService(makeSigningFixture(), { sig: null });
  assert.equal((await missing.check({ manual: true })).status, 'available');
  const missingResult = await missing.download();
  assert.equal(missingResult.status, 'error');
  assert.equal(missingResult.reason, 'signature:missing');
  assert.equal(missingResult.keptOldFile, true);

  // A signature made by a DIFFERENT key (attacker-controlled manifest host
  // signing with its own key) must be rejected even though url, bytes and
  // sha256 are all self-consistent.
  const fixture = makeSigningFixture();
  const attacker = makeSigningFixture(); // same payload text, different key
  const forged = signedService(fixture, { sig: attacker.sig });
  assert.equal((await forged.check({ manual: true })).status, 'available');
  const forgedResult = await forged.download();
  assert.equal(forgedResult.status, 'error');
  assert.equal(forgedResult.reason, 'signature:invalid');
  assert.equal(forgedResult.keptOldFile, true);
});

test('download without a pinned key keeps the existing sha256-only behavior (no silent new requirement)', async () => {
  const fixture = makeSigningFixture();
  const service = signedService(fixture, { sig: null, updatePublicKey: null });
  assert.equal((await service.check({ manual: true })).status, 'available');
  assert.equal((await service.download()).status, 'ready');
});

test('verifyRsaSha256 works through both the WebCrypto and node:crypto paths', async () => {
  const fixture = makeSigningFixture();
  // WebCrypto path (globalThis.crypto.subtle exists in Node 20+).
  assert.equal(await verifyRsaSha256(fixture.publicKeyPem, fixture.payload, fixture.sig), true);
  assert.equal(await verifyRsaSha256(fixture.publicKeyPem, new TextEncoder().encode('tampered'), fixture.sig), false);
  // node:crypto fallback path.
  const subtle = globalThis.crypto;
  delete globalThis.crypto;
  try {
    assert.equal(await verifyRsaSha256(fixture.publicKeyPem, fixture.payload, fixture.sig), true);
    assert.equal(await verifyRsaSha256(fixture.publicKeyPem, new TextEncoder().encode('tampered'), fixture.sig), false);
  } finally {
    globalThis.crypto = subtle;
  }
});

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}
function bytesResponse(bytes) {
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

// ---------------------------------------------------------------------------
// Invalid installed version must be reported honestly - not as "offline".
// A build that injected a non-semver version (the dev server used to inject
// literally "dev") previously blew up INSIDE the comparison after a
// successful manifest fetch, and the catch block reported "could not reach
// the update server" even though the server was fine.
// ---------------------------------------------------------------------------
import { pickArtifact } from '../scripts/lib/update-artifacts.mjs';

test('check() with a non-semver installed version reports invalid-installed-version, never a fake offline state', async () => {
  let fetched = 0;
  const service = new UpdateService({
    target: 'pwa',
    installedVersion: 'dev',
    storage: new MemoryStorage(),
    fetchImpl: async () => { fetched += 1; return jsonResponse({ schema: 1, latest: { pwa: '9.9.9' } }); }
  });
  const state = await service.check({ manual: true });
  assert.equal(state.status, 'unknown');
  assert.match(state.reason, /invalid-installed-version:dev/);
  assert.equal(fetched, 0, 'does not waste a network round-trip on a version that can never compare');
});

// ---------------------------------------------------------------------------
// Update manifest artifact selection (scripts/lib/update-artifacts.mjs).
// The real 0.3.2 release manifest pointed Windows clients at elevate.exe
// (electron-builder's UAC helper) and Linux clients at the signing public
// key .pem, because generation took the alphabetically-first file of each
// artifact folder. These tests pin the CORRECT choices.
// ---------------------------------------------------------------------------
test('pickArtifact chooses real installers and never keys/signatures/helpers', () => {
  // Exact file sets from the v0.3.2 release artifact folders:
  assert.equal(
    pickArtifact('windows', ['SHA256SUMS.txt', 'build-info.json', 'elevate.exe', 'yayra-setup-0.3.2.exe', 'yayra-win-x64-0.3.2.exe', 'yayra.exe']),
    'yayra-setup-0.3.2.exe',
    'windows -> the NSIS setup, not elevate.exe'
  );
  assert.equal(
    pickArtifact('linux', ['SHA256SUMS.txt', 'build-info.json', 'linux-signing-public-key.pem', 'yayra-0.3.2.AppImage', 'yayra-0.3.2.AppImage.sig', 'yayra_0.3.2_amd64.deb', 'yayra_0.3.2_amd64.deb.sig']),
    'yayra_0.3.2_amd64.deb',
    'linux -> the .deb, not the signing key or a .sig'
  );
  assert.equal(pickArtifact('pwa', ['SHA256SUMS.txt', 'build-info.json', 'yayra-pwa-0.3.2.tar.gz']), 'yayra-pwa-0.3.2.tar.gz');
  assert.equal(pickArtifact('android', ['SHA256SUMS.txt', 'app-release.apk', 'build-info.json']), 'app-release.apk');
  assert.equal(pickArtifact('ios', ['build-info.json', 'yayra-0.3.2.ipa']), 'yayra-0.3.2.ipa');
});

test('pickArtifact returns null (omit download) rather than guessing when no installable file exists', () => {
  assert.equal(pickArtifact('windows', ['SHA256SUMS.txt', 'build-info.json', 'elevate.exe']), null, 'elevate.exe alone is never shippable');
  assert.equal(pickArtifact('linux', ['linux-signing-public-key.pem', 'something.sig']), null);
  assert.equal(pickArtifact('pwa', []), null);
  // Fallback ranking: without a setup exe, the portable x64 build wins over a bare .exe.
  assert.equal(pickArtifact('windows', ['yayra.exe', 'yayra-win-x64-0.3.2.exe']), 'yayra-win-x64-0.3.2.exe');
});
