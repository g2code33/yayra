export const APP_ID = 'com.yayra.app';
export const APP_NAME = 'yayra';
export const UPDATE_CHANNEL = 'stable';

export const DEFAULT_UPDATE_CONFIG = Object.freeze({
  enabled: true,
  channel: 'stable',
  notes: { en: 'Initial yayra release infrastructure.' },
  checkIntervalMinutes: 720,
  telemetry: false,
  minSupported: {
    windows: '0.1.0',
    linux: '0.1.0',
    ios: '0.1.0',
    android: '0.1.0',
    pwa: '0.1.0'
  },
  desktop: {
    headerControl: 'persistent',
    autoCheck: true,
    autoDownload: false,
    autoInstall: false,
    manualCheckThrottleSeconds: 20
  },
  mobile: {
    promptCadence: 'per-open',
    snoozeOptions: ['session', '1d', '7d', 'never-for-version'],
    defaultSnooze: 'session',
    autoCheckMobile: false
  },
  pwa: { reloadStrategy: 'prompt' },
  rollout: { percent: 100, allowlistRoles: ['admin'] },
  sources: {
    windows: 'https://github.com/g2code33/yayra/releases/latest',
    linux: 'https://github.com/g2code33/yayra/releases/latest',
    android: 'https://github.com/g2code33/yayra/releases/latest',
    ios: 'https://testflight.apple.com/join/yayra',
    pwa: 'https://yayra.pages.dev'
  }
});

export const MOBILE_PROMPT_CADENCES = Object.freeze(['per-open', 'once-a-day', 'off']);

export function cloneUpdateConfig(config = DEFAULT_UPDATE_CONFIG) {
  return JSON.parse(JSON.stringify(config));
}

export function mergeWithUpdateDefaults(config) {
  const next = cloneUpdateConfig(DEFAULT_UPDATE_CONFIG);
  deepMerge(next, config || {});
  next.desktop.headerControl = DEFAULT_UPDATE_CONFIG.desktop.headerControl;
  if (!MOBILE_PROMPT_CADENCES.includes(next.mobile.promptCadence)) {
    next.mobile.promptCadence = DEFAULT_UPDATE_CONFIG.mobile.promptCadence;
  }
  return next;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function validateUpdateConfig(config, context = {}) {
  const errors = [];
  const candidate = mergeWithUpdateDefaults(config);
  if (config?.desktop?.headerControl && config.desktop.headerControl !== 'persistent') {
    errors.push('desktop.headerControl is locked to persistent and cannot be disabled');
  }
  const requestedCadence = config?.mobile?.promptCadence ?? candidate.mobile.promptCadence;
  if (!MOBILE_PROMPT_CADENCES.includes(requestedCadence)) {
    errors.push(`mobile.promptCadence must be one of ${MOBILE_PROMPT_CADENCES.join(', ')}`);
  }
  if (requestedCadence === 'every-check') {
    errors.push('mobile.promptCadence cannot be every-check; prompts are never shown more than once per open');
  }
  const latest = context.latest || {};
  for (const [platform, minimum] of Object.entries(candidate.minSupported || {})) {
    if (latest[platform] && compareSemver(minimum, latest[platform]) > 0) {
      errors.push(`minSupported.${platform} (${minimum}) cannot be higher than latest ${latest[platform]}`);
    }
  }
  if (candidate.desktop.autoInstall && !candidate.desktop.autoDownload) {
    errors.push('desktop.autoInstall requires desktop.autoDownload');
  }
  if ((candidate.desktop.autoInstall || candidate.desktop.autoDownload) && context.confirmedAutomationTradeoffs !== true) {
    errors.push('enabling desktop autoDownload/autoInstall requires explicit confirmation of the automation tradeoffs');
  }
  return { ok: errors.length === 0, errors, config: candidate };
}

export function applyAdminUpdateConfig(previous, requested, context = {}) {
  const validation = validateUpdateConfig(requested, context);
  if (!validation.ok) {
    const error = new Error(validation.errors.join('; '));
    error.name = 'UpdateConfigValidationError';
    error.errors = validation.errors;
    throw error;
  }
  const beforeRollout = JSON.stringify((previous || DEFAULT_UPDATE_CONFIG).rollout || {});
  const afterRollout = JSON.stringify(validation.config.rollout || {});
  const audit = Array.isArray(context.auditLog) ? context.auditLog.slice() : [];
  if (beforeRollout !== afterRollout) {
    audit.push({
      actor: context.actor || 'unknown',
      at: context.now || new Date().toISOString(),
      field: 'updates.rollout',
      before: JSON.parse(beforeRollout),
      after: JSON.parse(afterRollout)
    });
  }
  return { config: validation.config, audit };
}

export function resolveStartupUpdateConfig({ fetchedConfig, lastKnownGood } = {}) {
  if (fetchedConfig) {
    return { config: mergeWithUpdateDefaults(fetchedConfig), source: 'remote' };
  }
  if (lastKnownGood) {
    const config = mergeWithUpdateDefaults(lastKnownGood);
    config.desktop.autoCheck = false;
    return { config, source: 'last-known-good' };
  }
  const config = cloneUpdateConfig(DEFAULT_UPDATE_CONFIG);
  config.desktop.autoCheck = false;
  config.desktop.autoDownload = false;
  config.desktop.autoInstall = false;
  config.mobile.promptCadence = 'per-open';
  return { config, source: 'defaults-degraded' };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  const lp = left.prerelease;
  const rp = right.prerelease;
  if (!lp.length && !rp.length) return 0;
  if (!lp.length) return 1;
  if (!rp.length) return -1;
  const max = Math.max(lp.length, rp.length);
  for (let i = 0; i < max; i += 1) {
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    const ln = /^\d+$/.test(lp[i]);
    const rn = /^\d+$/.test(rp[i]);
    if (ln && rn) {
      const li = Number(lp[i]);
      const ri = Number(rp[i]);
      if (li !== ri) return li > ri ? 1 : -1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (lp[i] !== rp[i]) {
      return lp[i] > rp[i] ? 1 : -1;
    }
  }
  return 0;
}

export function parseSemver(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid semver: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}
