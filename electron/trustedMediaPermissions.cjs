'use strict';

function webContentsUrl(webContents) {
  try { return String(webContents?.getURL?.() || ''); } catch { return ''; }
}

function mediaTypes(details) {
  const requested = Array.isArray(details?.mediaTypes)
    ? details.mediaTypes.map((value) => String(value).toLowerCase())
    : [];
  if (requested.length > 0) return requested;

  // Electron's request handler reports `mediaTypes: ['audio']`, while its
  // permission-check handler reports one Chromium capability name.
  const checkedType = String(details?.mediaType || '').toLowerCase();
  if (checkedType === 'audiocapture') return ['audio'];
  if (checkedType === 'videocapture') return ['video'];
  return [];
}

function classifyTrustedMediaRequest(webContents, permission, details = {}, { recorderPreloadPath = '' } = {}) {
  if (permission !== 'media') return { allowed: false, kind: 'none' };
  const url = webContentsUrl(webContents);
  const requested = mediaTypes(details);

  // Voice search runs only in Yayra's signed internal shell. Website pages
  // live in separate WebContentsViews and never match this URL, so this does
  // not silently grant microphone/camera access to arbitrary origins.
  if (/^yayra:\/\/app(?:\/|$)/i.test(url)) {
    const audioOnly = requested.length === 1 && requested[0] === 'audio';
    return { allowed: audioOnly, kind: 'shell-audio' };
  }

  // The hidden screen-recorder page is app-generated and data:-backed. It
  // needs desktop video/system audio and the optional microphone. Preserve
  // that existing explicit user-initiated recording flow.
  if (/^data:text\/html(?:[;,])/i.test(url)) {
    let actualPreload = '';
    try { actualPreload = String(webContents?.getLastWebPreferences?.()?.preload || ''); } catch { /* denied below */ }
    const isAppRecorder = Boolean(recorderPreloadPath) && actualPreload === String(recorderPreloadPath);
    const knownTypes = requested.every((type) => type === 'audio' || type === 'video');
    return { allowed: isAppRecorder && knownTypes, kind: 'screen-recorder' };
  }

  return { allowed: false, kind: 'none' };
}

function configureTrustedMediaPermissions({
  defaultSession,
  systemPreferences,
  recorderPreloadPath = '',
  platform = process.platform,
  logger = console
} = {}) {
  if (!defaultSession
      || typeof defaultSession.setPermissionRequestHandler !== 'function'
      || typeof defaultSession.setPermissionCheckHandler !== 'function') {
    return false;
  }

  defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => {
    const request = classifyTrustedMediaRequest(webContents, permission, details, { recorderPreloadPath });
    if (!request.allowed) return false;
    if (platform === 'darwin' && request.kind === 'shell-audio'
        && typeof systemPreferences?.getMediaAccessStatus === 'function') {
      return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
    }
    return true;
  });

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const request = classifyTrustedMediaRequest(webContents, permission, details, { recorderPreloadPath });
    let completed = false;
    const finish = (allowed) => {
      if (completed) return;
      completed = true;
      callback(Boolean(allowed));
    };

    if (!request.allowed) {
      finish(false);
      return;
    }

    if (platform === 'darwin' && request.kind === 'shell-audio'
        && typeof systemPreferences?.askForMediaAccess === 'function') {
      Promise.resolve(systemPreferences.askForMediaAccess('microphone'))
        .then((allowed) => finish(allowed))
        .catch((err) => {
          logger?.warn?.('[yayra] microphone permission request failed', err?.message || err);
          finish(false);
        });
      return;
    }

    finish(true);
  });

  return true;
}

module.exports = {
  classifyTrustedMediaRequest,
  configureTrustedMediaPermissions
};
