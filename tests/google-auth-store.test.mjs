import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore, fileNameForProfile } from '../electron/authStore.cjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-auth-store-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    // Trivial reversible "encryption" stand-in for an OS keychain - good
    // enough to prove the store round-trips through it correctly.
    encryptString: (str) => Buffer.from(`enc:${str}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
  };
}

test('authStore: save() then load() round-trips profile and tokens when encryption is available', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });

  store.save({ profile: { sub: '1', email: 'a@b.com' }, tokens: { access_token: 'at', refresh_token: 'rt' } });
  const loaded = store.load();

  assert.deepEqual(loaded.profile, { sub: '1', email: 'a@b.com' });
  assert.deepEqual(loaded.tokens, { access_token: 'at', refresh_token: 'rt' });
  assert.ok(loaded.savedAt);
});

test('authStore: tokens are never written to disk in plaintext', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });
  store.save({ profile: { sub: '1' }, tokens: { access_token: 'super-secret-access-token', refresh_token: 'super-secret-refresh-token' } });

  const raw = fs.readFileSync(path.join(dir, 'google-session.json'), 'utf8');
  assert.ok(!raw.includes('super-secret-access-token'));
  assert.ok(!raw.includes('super-secret-refresh-token'));
});

test('authStore: load() returns null when nothing has been saved', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });
  assert.equal(store.load(), null);
});

test('authStore: clear() removes the session so a subsequent load() returns null', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });
  store.save({ profile: { sub: '1' }, tokens: { access_token: 'at' } });
  assert.ok(store.load());
  store.clear();
  assert.equal(store.load(), null);
});

test('authStore: clear() on an already-empty store does not throw', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });
  assert.doesNotThrow(() => store.clear());
});

test('authStore: when OS keychain encryption is unavailable, profile is still kept but tokens are not persisted unencrypted', () => {
  const dir = makeTempDir();
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(false), userDataDir: dir });
  store.save({ profile: { sub: '1', email: 'a@b.com' }, tokens: { access_token: 'secret' } });

  const raw = fs.readFileSync(path.join(dir, 'google-session.json'), 'utf8');
  assert.ok(!raw.includes('secret'));

  const loaded = store.load();
  assert.deepEqual(loaded.profile, { sub: '1', email: 'a@b.com' });
  assert.equal(loaded.tokens, null);
});

test('authStore: load() tolerates a corrupted session file instead of throwing', () => {
  const dir = makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'google-session.json'), 'not valid json {{{');
  const store = createAuthStore({ fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir });
  assert.equal(store.load(), null);
});

test('authStore: two browsing profiles persist different encrypted accounts and clear independently', () => {
  const dir = makeTempDir();
  const personal = createAuthStore({
    fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir, profileId: 'default'
  });
  const work = createAuthStore({
    fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir, profileId: 'profile-work-42'
  });

  personal.save({
    profile: { sub: 'personal', email: 'personal@example.com' },
    tokens: { access_token: 'personal-access', refresh_token: 'personal-refresh' }
  });
  work.save({
    profile: { sub: 'work', email: 'work@example.com' },
    tokens: { access_token: 'work-access', refresh_token: 'work-refresh' }
  });

  assert.notEqual(personal.filePath, work.filePath, 'each profile owns a different file');
  assert.equal(personal.load().profile.email, 'personal@example.com');
  assert.equal(work.load().profile.email, 'work@example.com');
  for (const file of [personal.filePath, work.filePath]) {
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('personal-access'), false);
    assert.equal(raw.includes('work-access'), false);
  }

  work.clear();
  assert.equal(work.load(), null, 'work account is signed out');
  assert.equal(personal.load().profile.email, 'personal@example.com', 'personal account survives work sign-out');
});

test('authStore: default profile reuses the legacy file while non-default profiles never inherit it', () => {
  const dir = makeTempDir();
  // Simulate the pre-profile release: no profileId/version metadata, but the
  // same encrypted payload in google-session.json.
  const tokens = { access_token: 'legacy-access', refresh_token: 'legacy-refresh' };
  const encrypted = fakeSafeStorage(true).encryptString(JSON.stringify(tokens)).toString('base64');
  fs.writeFileSync(path.join(dir, 'google-session.json'), JSON.stringify({
    profile: { sub: 'legacy', email: 'legacy@example.com' },
    tokensEncrypted: encrypted,
    savedAt: '2026-01-01T00:00:00.000Z'
  }));

  const defaultStore = createAuthStore({
    fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir, profileId: 'default'
  });
  const otherStore = createAuthStore({
    fs, safeStorageImpl: fakeSafeStorage(true), userDataDir: dir, profileId: 'profile-new'
  });

  assert.equal(defaultStore.filePath, path.join(dir, 'google-session.json'));
  assert.equal(defaultStore.load().profile.email, 'legacy@example.com', 'legacy user stays signed in');
  assert.deepEqual(defaultStore.load().tokens, tokens);
  assert.equal(otherStore.load(), null, 'a new profile cannot see the legacy default account');
  assert.notEqual(fileNameForProfile('profile-new'), 'google-session.json');
  assert.match(fileNameForProfile('profile-new'), /^google-session-[a-f0-9]{64}\.json$/);
});

test('authStore: unsafe profile ids are contained to the default filename, never used as paths', () => {
  assert.equal(fileNameForProfile('../../escape'), 'google-session.json');
  assert.equal(fileNameForProfile('profile/work'), 'google-session.json');
  assert.equal(fileNameForProfile('profile-work'), fileNameForProfile('profile-work'));
});
