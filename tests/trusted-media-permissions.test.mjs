import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyTrustedMediaRequest,
  configureTrustedMediaPermissions
} = require('../electron/trustedMediaPermissions.cjs');

const page = (url, preload = '') => ({
  getURL: () => url,
  getLastWebPreferences: () => ({ preload })
});
const RECORDER_PRELOAD = '/app/electron/recorderPreload.cjs';

test('Media permissions: only shell audio and the app-owned recorder are trusted', () => {
  assert.deepEqual(
    classifyTrustedMediaRequest(page('yayra://app/index.html'), 'media', { mediaTypes: ['audio'] }),
    { allowed: true, kind: 'shell-audio' }
  );
  assert.equal(
    classifyTrustedMediaRequest(page('yayra://app/index.html'), 'media', { mediaType: 'audioCapture' }).allowed,
    true,
    'Electron permission checks use the singular audioCapture capability name'
  );
  assert.equal(
    classifyTrustedMediaRequest(page('yayra://app/index.html'), 'media', { mediaTypes: ['video'] }).allowed,
    false,
    'voice-search permission never silently expands to camera access'
  );
  assert.equal(
    classifyTrustedMediaRequest(page('yayra://app/index.html'), 'media', {}).allowed,
    false,
    'ambiguous media checks are denied instead of becoming a camera grant'
  );
  assert.equal(
    classifyTrustedMediaRequest(page('https://www.google.com/'), 'media', { mediaTypes: ['audio'] }).allowed,
    false,
    'website origins remain denied by this internal-shell policy'
  );
  assert.deepEqual(
    classifyTrustedMediaRequest(
      page('data:text/html;charset=UTF-8,recorder', RECORDER_PRELOAD),
      'media',
      { mediaTypes: ['audio', 'video'] },
      { recorderPreloadPath: RECORDER_PRELOAD }
    ),
    { allowed: true, kind: 'screen-recorder' }
  );
  assert.equal(
    classifyTrustedMediaRequest(
      page('data:text/html;charset=UTF-8,untrusted'),
      'media',
      { mediaTypes: ['audio'] },
      { recorderPreloadPath: RECORDER_PRELOAD }
    ).allowed,
    false,
    'arbitrary data pages cannot impersonate the recorder without its exact preload'
  );
  assert.equal(classifyTrustedMediaRequest(page('yayra://app/index.html'), 'geolocation', {}).allowed, false);
});

test('Media permissions: request/check handlers grant trusted audio and reject websites', async () => {
  let requestHandler = null;
  let checkHandler = null;
  const configured = configureTrustedMediaPermissions({
    defaultSession: {
      setPermissionRequestHandler: (handler) => { requestHandler = handler; },
      setPermissionCheckHandler: (handler) => { checkHandler = handler; }
    },
    platform: 'linux'
  });
  assert.equal(configured, true);
  assert.equal(checkHandler(page('yayra://app/index.html'), 'media', '', { mediaTypes: ['audio'] }), true);
  assert.equal(checkHandler(page('https://example.com'), 'media', '', { mediaTypes: ['audio'] }), false);

  const decide = (webContents, details) => new Promise((resolve) => {
    requestHandler(webContents, 'media', resolve, details);
  });
  assert.equal(await decide(page('yayra://app/index.html'), { mediaTypes: ['audio'] }), true);
  assert.equal(await decide(page('yayra://app/index.html'), { mediaTypes: ['video'] }), false);
  assert.equal(await decide(page('https://example.com'), { mediaTypes: ['audio'] }), false);
});

test('Media permissions: macOS still requires real OS microphone consent', async () => {
  let requestHandler = null;
  let checkHandler = null;
  let askCount = 0;
  configureTrustedMediaPermissions({
    defaultSession: {
      setPermissionRequestHandler: (handler) => { requestHandler = handler; },
      setPermissionCheckHandler: (handler) => { checkHandler = handler; }
    },
    systemPreferences: {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: async () => { askCount += 1; return true; }
    },
    platform: 'darwin'
  });

  const shell = page('yayra://app/index.html');
  assert.equal(checkHandler(shell, 'media', '', { mediaTypes: ['audio'] }), false);
  const granted = await new Promise((resolve) => {
    requestHandler(shell, 'media', resolve, { mediaTypes: ['audio'] });
  });
  assert.equal(granted, true);
  assert.equal(askCount, 1);
});
