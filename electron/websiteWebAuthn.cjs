'use strict';

// Electron exposes Chromium's roaming security-key WebAuthn path by default.
// Its macOS Touch ID platform authenticator is intentionally opt-in: the
// configured keychain group must be present in the app's signed entitlements.
// This module enables it only when that exact, trustworthy configuration is
// available. It never invents a group or treats Yayra's vault-unlock key as a
// website credential.

const KEYCHAIN_GROUP_PATTERN = /^[A-Z0-9]{5,20}\.[A-Za-z0-9](?:[A-Za-z0-9.-]{1,238}[A-Za-z0-9])?$/;

function normalizeKeychainAccessGroup(value) {
  const group = typeof value === 'string' ? value.trim() : '';
  return group && group.length <= 255 && KEYCHAIN_GROUP_PATTERN.test(group) ? group : null;
}

function decodePlistString(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .trim();
}

function extractKeychainAccessGroups(entitlements) {
  const xml = String(entitlements || '');
  const section = xml.match(/<key>\s*keychain-access-groups\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1] || '';
  if (!section) return [];
  const groups = [];
  const strings = section.matchAll(/<string>([\s\S]*?)<\/string>/gi);
  for (const match of strings) {
    const group = normalizeKeychainAccessGroup(decodePlistString(match[1]));
    if (group && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

function extractWebAuthnKeychainAccessGroup(entitlements) {
  // A dedicated suffix avoids silently repurposing a broad/shared keychain
  // group. An environment selection is still accepted only when it appears
  // verbatim in this signed list (see configureWebsiteWebAuthn below).
  return extractKeychainAccessGroups(entitlements)
    .find((group) => group.toLowerCase().endsWith('.webauthn')) || null;
}

function readSignedEntitlements(executablePath, spawnSyncImpl) {
  if (!executablePath || typeof spawnSyncImpl !== 'function') return '';
  try {
    const result = spawnSyncImpl(
      '/usr/bin/codesign',
      ['-d', '--entitlements', ':-', executablePath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }
    );
    // codesign diagnostics traditionally use stderr; entitlement XML has
    // appeared on either stream across macOS versions, so inspect both.
    return `${result?.stdout || ''}\n${result?.stderr || ''}`;
  } catch {
    return '';
  }
}

function configureWebsiteWebAuthn({
  app,
  platform = process.platform,
  env = process.env,
  executablePath = process.execPath,
  spawnSyncImpl = null,
  logger = console
} = {}) {
  if (platform !== 'darwin') return { configured: false, reason: 'not-macos' };
  if (!app || typeof app.configureWebAuthn !== 'function') {
    return { configured: false, reason: 'electron-api-unavailable' };
  }

  let runner = spawnSyncImpl;
  if (!runner) {
    try { ({ spawnSync: runner } = require('node:child_process')); } catch { runner = null; }
  }
  const signedEntitlements = readSignedEntitlements(executablePath, runner);
  const signedGroups = extractKeychainAccessGroups(signedEntitlements);
  const requestedGroup = normalizeKeychainAccessGroup(env?.YAYRA_WEBAUTHN_KEYCHAIN_ACCESS_GROUP);
  const requestedAndSigned = requestedGroup && signedGroups.includes(requestedGroup) ? requestedGroup : null;
  const keychainAccessGroup = requestedAndSigned || extractWebAuthnKeychainAccessGroup(signedEntitlements);
  const source = requestedAndSigned ? 'environment-and-signed-entitlements' : 'signed-entitlements';
  if (!keychainAccessGroup) {
    logger.info?.('[yayra:webauthn] macOS Touch ID is unavailable: no dedicated signed keychain-access-group was found; roaming security keys and the system-browser fallback remain available');
    return { configured: false, reason: 'missing-entitlement' };
  }

  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup,
        promptReason: 'verify your identity on $1'
      }
    });
    logger.info?.(`[yayra:webauthn] macOS Touch ID website passkeys enabled from ${source}`);
    return { configured: true, source };
  } catch (error) {
    logger.warn?.(`[yayra:webauthn] Touch ID configuration was rejected; check the signed keychain entitlement: ${error?.message || error}`);
    return { configured: false, reason: 'configuration-rejected' };
  }
}

module.exports = {
  normalizeKeychainAccessGroup,
  extractKeychainAccessGroups,
  extractWebAuthnKeychainAccessGroup,
  readSignedEntitlements,
  configureWebsiteWebAuthn
};
