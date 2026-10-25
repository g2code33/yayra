import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_SERVICE_CATALOG,
  googleServiceById,
  googleServiceDestination
} from '../src/services/googleServiceCatalog.js';

test('Google app-launcher products shown in the screenshots are available in the signed-in services hub', () => {
  const expectedIds = [
    'account', 'search', 'maps', 'youtube', 'news', 'gmail', 'meet', 'chat',
    'contacts', 'drive', 'calendar', 'play', 'translate', 'photos', 'chrome',
    'shopping', 'finance', 'docs', 'sheets', 'slides', 'books', 'blogger',
    'keep', 'earth', 'saved', 'arts-culture', 'ads', 'merchant-center'
  ];
  for (const id of expectedIds) {
    assert.ok(googleServiceById(id), `${id} exists in the services catalog`);
    assert.match(googleServiceById(id).url, /^https:\/\//, `${id} opens over HTTPS`);
  }
  assert.ok(GOOGLE_SERVICE_CATALOG.length >= expectedIds.length);
});

test('every listed service opens with the verified Google account hint when available', () => {
  for (const service of GOOGLE_SERVICE_CATALOG) {
    const destination = googleServiceDestination(service.id, 'person@example.com');
    assert.ok(destination, `${service.id} has a safe destination`);
    const url = new URL(destination);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.get('authuser'), 'person@example.com');
  }
});
