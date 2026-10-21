/**
 * Yayra Floating Browser - Security Policy Contract & Hardening Implementation
 */

export class DefaultSecurityPolicy {
  constructor() {
    this.allowMixedContent = false;
    this.strictTlsErrors = true;
    this.allowAutoExecuteDownloads = false;

    this.allowedSchemes = new Set(['http', 'https', 'about', 'data', 'blob', 'yayra']);
    this.dangerousExecutableExtensions = new Set([
      'exe', 'deb', 'rpm', 'apk', 'sh', 'bash', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jar', 'msi', 'com', 'scr', 'pif'
    ]);

    this.windowsReservedNames = new Set([
      'con', 'prn', 'aux', 'nul',
      'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
      'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
    ]);
  }

  isSchemeAllowed(scheme) {
    const s = scheme.toLowerCase().replace(':', '');
    return this.allowedSchemes.has(s);
  }

  validateUrl(rawUrl, httpsFirst = true) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return { allowed: false, reason: 'Empty or non-string URL' };
    }

    const trimmed = rawUrl.trim();
    const lower = trimmed.toLowerCase();

    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('vbscript:') ||
      lower.startsWith('file:') ||
      lower.startsWith('intent:') ||
      lower.startsWith('market:') ||
      lower.startsWith('chrome:')
    ) {
      return {
        allowed: false,
        reason: `Blocked dangerous or unauthorized protocol scheme: ${trimmed.split(':')[0]}`
      };
    }

    if (lower.startsWith('data:')) {
      if (
        lower.startsWith('data:text/html') ||
        lower.startsWith('data:application/javascript') ||
        lower.startsWith('data:text/javascript')
      ) {
        return {
          allowed: false,
          reason: 'Blocked executable HTML/JavaScript payload in data: URL'
        };
      }
    }

    try {
      const parsed = new URL(trimmed);
      const scheme = parsed.protocol.replace(':', '').toLowerCase();

      if (!this.isSchemeAllowed(scheme)) {
        return {
          allowed: false,
          reason: `Blocked unsupported URL protocol scheme: ${scheme}`
        };
      }

      let isUpgraded = false;
      let sanitizedUrl = parsed.toString();

      if (
        httpsFirst &&
        scheme === 'http' &&
        !parsed.hostname.endsWith('.localhost') &&
        parsed.hostname !== '127.0.0.1'
      ) {
        parsed.protocol = 'https:';
        sanitizedUrl = parsed.toString();
        isUpgraded = true;
      }

      return {
        allowed: true,
        sanitizedUrl,
        isUpgradedHttps: isUpgraded
      };
    } catch {
      return { allowed: false, reason: 'Malformed URL' };
    }
  }

  enforceContentSecurityPolicy(origin) {
    return "default-src 'self' yayra: https:; img-src 'self' data: blob: https:; media-src 'self' blob: yayra:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self';";
  }

  sanitizeDownloadFilename(suggestedName) {
    if (!suggestedName || typeof suggestedName !== 'string') {
      return 'download.bin';
    }

    let cleaned = suggestedName.replace(/[\x00-\x1F\x7F]/g, '');
    const segments = cleaned.split(/[\/\\]+/).filter(Boolean);
    let name = segments.length > 0 ? segments[segments.length - 1] : 'download.bin';

    name = name.replace(/\.\.+/g, '.').replace(/[<>:"\/\\|?*]/g, '_').trim();

    const baseName = name.split('.')[0].toLowerCase();
    if (this.windowsReservedNames.has(baseName)) {
      name = `safe_${name}`;
    }

    if (!name || name === '.' || name === '..') {
      name = 'download.bin';
    }

    if (name.length > 255) {
      const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
      name = `${name.slice(0, 250 - ext.length)}${ext}`;
    }

    return name;
  }

  validateBridgeMessage(msg, trustedOriginPattern) {
    if (!msg || typeof msg !== 'object') {
      return { valid: false, error: 'Bridge message must be a valid JSON object' };
    }

    const { channel, action, origin, payload } = msg;

    if (!channel || typeof channel !== 'string') {
      return { valid: false, error: 'Missing or invalid message channel' };
    }

    if (!action || typeof action !== 'string') {
      return { valid: false, error: 'Missing or invalid message action' };
    }

    if (!origin || typeof origin !== 'string') {
      return { valid: false, error: 'Missing or invalid message origin' };
    }

    if (trustedOriginPattern && !trustedOriginPattern.test(origin)) {
      return { valid: false, error: `Unauthorized message origin: ${origin}` };
    }

    const dangerousActions = new Set([
      'eval',
      'executeCommand',
      'accessFilesystem',
      'exposePrivateKeys',
      'runBinary'
    ]);
    if (dangerousActions.has(action)) {
      return { valid: false, error: `Action '${action}' is prohibited on the native bridge` };
    }

    return { valid: true };
  }

  validateNavigationRedirect(fromUrl, toUrl) {
    const toCheck = this.validateUrl(toUrl);
    if (!toCheck.allowed) {
      return { allowed: false, reason: toCheck.reason };
    }

    if (fromUrl.startsWith('https://') && toUrl.startsWith('http://')) {
      return {
        allowed: false,
        reason: 'Blocked insecure redirect downgrade from HTTPS to HTTP'
      };
    }

    return { allowed: true };
  }
}
