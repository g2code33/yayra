'use strict';

/**
 * Main-process privacy policy for native website sessions.
 *
 * The renderer may request a policy, but every field is normalized here before
 * it can affect Chromium. No page receives this object and no browsing URL is
 * sent to a remote reputation or advertising service.
 */

const TRACKER_HOSTS = Object.freeze([
  '2mdn.net',
  'adform.net',
  'adnxs.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'app-measurement.com',
  'branch.io',
  'chartbeat.com',
  'clarity.ms',
  'criteo.com',
  'criteo.net',
  'demdex.net',
  'doubleclick.net',
  'everesttech.net',
  'facebook.net',
  'flashtalking.com',
  'google-analytics.com',
  'googlesyndication.com',
  'googletagmanager.com',
  'googleadservices.com',
  'hotjar.com',
  'mathtag.com',
  'mixpanel.com',
  'moatads.com',
  'newrelic.com',
  'omtrdc.net',
  'openx.net',
  'outbrain.com',
  'quantserve.com',
  'rubiconproject.com',
  'scorecardresearch.com',
  'segment.io',
  'segment.com',
  'sentry.io',
  'taboola.com',
  'teads.tv',
  'tiktok.com',
  'twitter.com',
  'yieldmo.com'
]);

const COMMON_PUBLIC_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp',
  'co.nz', 'org.nz',
  'co.za', 'org.za',
  'com.br', 'com.mx', 'com.tr',
  'com.gh', 'edu.gh', 'gov.gh', 'org.gh',
  'co.in', 'firm.in', 'gen.in', 'net.in', 'org.in'
]);

const PERMISSION_KEYS = Object.freeze([
  'location', 'camera', 'microphone', 'notifications', 'clipboard',
  'midi', 'usb', 'serial', 'bluetooth', 'hid', 'pointerLock', 'idleDetection'
]);

const DEFAULT_PRIVACY_POLICY = Object.freeze({
  httpsFirst: true,
  safeBrowsingLevel: 'enhanced',
  adBlockEnabled: true,
  doNotTrack: true,
  globalPrivacyControl: true,
  preloadPages: false,
  thirdPartyCookies: 'block',
  privacySandboxTopics: false,
  privacySandboxSuggestedAds: false,
  privacySandboxMeasurement: false,
  javascriptEnabled: true,
  imagesEnabled: true,
  allowWebsitePopups: false,
  autoRemoveUnusedPermissions: true,
  secureDnsEnabled: true,
  secureDnsProvider: 'automatic',
  warnPasswordExposure: true,
  blockedAdSites: Object.freeze([]),
  permissionDefaults: Object.freeze({
    location: 'ask',
    camera: 'ask',
    microphone: 'ask',
    notifications: 'ask',
    clipboard: 'ask',
    midi: 'ask',
    usb: 'ask',
    serial: 'ask',
    bluetooth: 'ask',
    hid: 'ask',
    pointerLock: 'ask',
    idleDetection: 'block'
  }),
  cookieExceptions: Object.freeze([]),
  sitePermissions: Object.freeze({})
});

function cleanHostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!raw || raw.length > 253 || !/^[a-z0-9.-]+$/i.test(raw) || raw.includes('..')) return '';
  if (raw.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return '';
  return raw;
}

function hostnameFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return cleanHostname(parsed.hostname);
  } catch {
    return '';
  }
}

function hostMatches(host, rule) {
  const cleanHost = cleanHostname(host);
  const cleanRule = cleanHostname(rule);
  return Boolean(cleanHost && cleanRule && (cleanHost === cleanRule || cleanHost.endsWith(`.${cleanRule}`)));
}

function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function registrableSite(hostname) {
  const host = cleanHostname(hostname);
  if (!host || host === 'localhost' || isIpAddress(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const suffix2 = labels.slice(-2).join('.');
  return COMMON_PUBLIC_SUFFIXES.has(suffix2)
    ? labels.slice(-3).join('.')
    : suffix2;
}

function requestingSite(details = {}, topLevelUrl = '') {
  const candidates = [details.initiator, details.referrer];
  const headers = details.requestHeaders || {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^referer$/i.test(name) && value) candidates.push(value);
  }
  candidates.push(topLevelUrl);
  for (const candidate of candidates) {
    const host = hostnameFromUrl(candidate);
    if (host) return host;
  }
  return '';
}

function isThirdPartyRequest(details = {}, topLevelUrl = '') {
  const target = hostnameFromUrl(details.url);
  if (!target) return false;
  if (details.resourceType === 'mainFrame') return false;
  const source = requestingSite(details, topLevelUrl);
  if (!source) return true; // fail closed when Chromium withholds initiator data
  return registrableSite(source) !== registrableSite(target);
}

function isPrivateOrLocalHost(hostname) {
  const host = cleanHostname(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = /^172\.(\d{1,3})\./.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function upgradedHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || isPrivateOrLocalHost(url.hostname)) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

function isTrackerRequest(details = {}, policy = DEFAULT_PRIVACY_POLICY) {
  if (!policy.adBlockEnabled || details.resourceType === 'mainFrame') return false;
  const host = hostnameFromUrl(details.url);
  if (!host) return false;
  if (TRACKER_HOSTS.some((rule) => hostMatches(host, rule))) return true;
  const custom = Array.isArray(policy.blockedAdSites) ? policy.blockedAdSites : [];
  return custom.some((rule) => hostMatches(host, rule));
}

/**
 * On-device threat hardening. This is deliberately not branded as Google's
 * cloud Safe Browsing: no visited URL is uploaded to a reputation service.
 * Enhanced mode rejects malformed destinations, credential-in-URL traps,
 * impossible hostnames, long obfuscated URLs and speculative page requests;
 * standard mode retains tracker blocking and HTTPS checks only.
 */
function isUnsafeRequest(details = {}, policy = DEFAULT_PRIVACY_POLICY) {
  if (policy.safeBrowsingLevel === 'off') return false;
  const raw = String(details?.url || '');
  if (!raw || raw.length > 8192) return true;
  let parsed;
  try { parsed = new URL(raw); } catch { return true; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  if (parsed.username || parsed.password || raw.includes('@')) return true;
  const host = cleanHostname(parsed.hostname);
  if (!host || host.length > 253 || host.includes('..')) return true;
  const labels = host.split('.');
  if (labels.length > 12 || labels.some((label) => label.length > 63)) return true;
  if (policy.safeBrowsingLevel !== 'enhanced') return false;
  if (host.startsWith('xn--') && /[0-9]{4,}/.test(host)) return true;
  if (/(?:login|secure|verify|account|banking|paypal|google|microsoft|apple)[-_.]/.test(host)
    && /(?:[0-9]{5,}|--)/.test(host)) return true;
  const headers = details?.requestHeaders || {};
  const purpose = Object.entries(headers).find(([name]) => /^purpose$/i.test(name))?.[1] || '';
  if (!policy.preloadPages && (/prefetch|prerender|preview/i.test(String(purpose))
    || /prefetch|prerender/i.test(String(details?.resourceType || '')))) return true;
  return false;
}

function normalizeChoice(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function sanitizePermissionDefaults(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of PERMISSION_KEYS) {
    if (!(key in input)) {
      result[key] = DEFAULT_PRIVACY_POLICY.permissionDefaults[key];
      continue;
    }
    // A present-but-malformed choice is untrusted profile data. Fail closed
    // to block rather than silently downgrading a browser permission to ask.
    result[key] = normalizeChoice(input[key], ['ask', 'allow', 'block'], 'block');
  }
  return result;
}

function sanitizeHostList(value) {
  const result = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value) ? value : []) {
    const host = cleanHostname(candidate);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push(host);
    if (result.length >= 100) break;
  }
  return result;
}

function sanitizeCookieExceptions(value) {
  return sanitizeHostList(value);
}

function sanitizeBlockedAdSites(value) {
  return sanitizeHostList(value);
}

function sanitizeSitePermissions(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [rawOrigin, permissions] of Object.entries(input).slice(0, 100)) {
    let origin;
    try {
      const parsed = new URL(rawOrigin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      origin = parsed.origin;
    } catch { continue; }
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) continue;
    const safe = {};
    for (const key of PERMISSION_KEYS) {
      if (permissions[key] === 'allow' || permissions[key] === 'block') safe[key] = permissions[key];
    }
    if (Object.keys(safe).length) result[origin] = safe;
  }
  return result;
}

function sanitizePrivacyPolicy(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const bool = (key) => typeof input[key] === 'boolean' ? input[key] : DEFAULT_PRIVACY_POLICY[key];
  return {
    httpsFirst: bool('httpsFirst'),
    safeBrowsingLevel: normalizeChoice(input.safeBrowsingLevel, ['enhanced', 'standard', 'off'], DEFAULT_PRIVACY_POLICY.safeBrowsingLevel),
    adBlockEnabled: bool('adBlockEnabled'),
    doNotTrack: bool('doNotTrack'),
    globalPrivacyControl: bool('globalPrivacyControl'),
    preloadPages: bool('preloadPages'),
    thirdPartyCookies: normalizeChoice(input.thirdPartyCookies, ['allow', 'block'], DEFAULT_PRIVACY_POLICY.thirdPartyCookies),
    privacySandboxTopics: bool('privacySandboxTopics'),
    privacySandboxSuggestedAds: bool('privacySandboxSuggestedAds'),
    privacySandboxMeasurement: bool('privacySandboxMeasurement'),
    javascriptEnabled: bool('javascriptEnabled'),
    imagesEnabled: bool('imagesEnabled'),
    allowWebsitePopups: bool('allowWebsitePopups'),
    autoRemoveUnusedPermissions: bool('autoRemoveUnusedPermissions'),
    secureDnsEnabled: bool('secureDnsEnabled'),
    secureDnsProvider: normalizeChoice(input.secureDnsProvider, ['automatic', 'cloudflare', 'google', 'quad9', 'off'], DEFAULT_PRIVACY_POLICY.secureDnsProvider),
    warnPasswordExposure: bool('warnPasswordExposure'),
    permissionDefaults: sanitizePermissionDefaults(input.permissionDefaults),
    cookieExceptions: sanitizeCookieExceptions(input.cookieExceptions),
    blockedAdSites: sanitizeBlockedAdSites(input.blockedAdSites),
    sitePermissions: sanitizeSitePermissions(input.sitePermissions)
  };
}

function isCookieException(details, policy, topLevelUrl = '') {
  const target = hostnameFromUrl(details?.url);
  const source = requestingSite(details, topLevelUrl);
  return (policy.cookieExceptions || []).some((rule) => hostMatches(target, rule) || hostMatches(source, rule));
}

function removeHeader(headers, matcher) {
  const next = { ...(headers || {}) };
  for (const key of Object.keys(next)) {
    if (matcher.test(key)) delete next[key];
  }
  return next;
}

function applyPrivacyRequestHeaders(details, headers, policy, topLevelUrl = '') {
  let next = { ...(headers || {}) };
  if (policy.doNotTrack) next.DNT = '1';
  else next = removeHeader(next, /^DNT$/i);
  if (policy.globalPrivacyControl) next['Sec-GPC'] = '1';
  else next = removeHeader(next, /^Sec-GPC$/i);

  if (!policy.privacySandboxTopics) {
    next = removeHeader(next, /^(?:Sec-Browsing-Topics|Observe-Browsing-Topics)$/i);
  }
  if (!policy.privacySandboxSuggestedAds) {
    next = removeHeader(next, /^(?:Sec-Ad-Auction-Fetch)$/i);
  }
  if (!policy.privacySandboxMeasurement) {
    next = removeHeader(next, /^(?:Attribution-Reporting-Eligible|Attribution-Reporting-Support)$/i);
  }
  if (policy.thirdPartyCookies === 'block'
    && isThirdPartyRequest({ ...details, requestHeaders: next }, topLevelUrl)
    && !isCookieException(details, policy, topLevelUrl)) {
    next = removeHeader(next, /^Cookie$/i);
  }
  return next;
}

function applyPrivacyResponseHeaders(details, headers, policy, topLevelUrl = '') {
  let next = { ...(headers || {}) };
  if (!policy.privacySandboxTopics) next = removeHeader(next, /^Observe-Browsing-Topics$/i);
  if (!policy.privacySandboxSuggestedAds) next = removeHeader(next, /^Ad-Auction-Allowed$/i);
  if (!policy.privacySandboxMeasurement) {
    next = removeHeader(next, /^Attribution-Reporting-Register-(?:Source|Trigger)$/i);
  }
  if (policy.thirdPartyCookies === 'block'
    && isThirdPartyRequest(details, topLevelUrl)
    && !isCookieException(details, policy, topLevelUrl)) {
    next = removeHeader(next, /^Set-Cookie\d*$/i);
  }
  return next;
}

function permissionKey(permission, details = {}) {
  const raw = String(permission || '');
  if (raw === 'geolocation') return 'location';
  if (raw === 'notifications') return 'notifications';
  if (raw === 'clipboard-read' || raw === 'clipboard-sanitized-write') return 'clipboard';
  if (raw === 'midi' || raw === 'midiSysex') return 'midi';
  if (raw === 'usb') return 'usb';
  if (raw === 'serial') return 'serial';
  if (raw === 'bluetooth') return 'bluetooth';
  if (raw === 'hid') return 'hid';
  if (raw === 'pointerLock') return 'pointerLock';
  if (raw === 'idle-detection') return 'idleDetection';
  if (raw === 'media') {
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    if (mediaTypes.includes('video')) return 'camera';
    return 'microphone';
  }
  return '';
}

function policyDecisionForPermission(policy, origin, permission, runtimeSitePermissions = {}) {
  const key = permissionKey(permission.permission || permission, permission.details || {});
  if (!key) return { key: '', decision: 'block' };
  const stored = runtimeSitePermissions?.[origin]?.[key]
    || policy.sitePermissions?.[origin]?.[key]
    || policy.permissionDefaults?.[key]
    || 'block';
  return { key, decision: normalizeChoice(stored, ['ask', 'allow', 'block'], 'block') };
}

module.exports = {
  TRACKER_HOSTS,
  PERMISSION_KEYS,
  DEFAULT_PRIVACY_POLICY,
  cleanHostname,
  hostnameFromUrl,
  hostMatches,
  registrableSite,
  isThirdPartyRequest,
  isPrivateOrLocalHost,
  upgradedHttpsUrl,
  isTrackerRequest,
  isUnsafeRequest,
  sanitizePrivacyPolicy,
  sanitizeSitePermissions,
  isCookieException,
  applyPrivacyRequestHeaders,
  applyPrivacyResponseHeaders,
  permissionKey,
  policyDecisionForPermission
};
