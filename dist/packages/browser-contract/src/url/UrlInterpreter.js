/**
 * Yayra Floating Browser - Safe URL Interpretation & Normalization Engine (JS runtime)
 */

export class UrlInterpreter {
  static SEARCH_TEMPLATES = Object.freeze({
    duckduckgo: 'https://duckduckgo.com/?q={query}',
    searx: 'https://searx.be/search?q={query}',
    google: 'https://www.google.com/search?q={query}',
    bing: 'https://www.bing.com/search?q={query}',
    custom: 'https://duckduckgo.com/?q={query}'
  });

  static BLOCKED_SCHEMES = Object.freeze([
    'javascript:',
    'data:',
    'vbscript:',
    'file:',
    'intent:',
    'content:',
    'blob:',
    'chrome:',
    'edge:'
  ]);

  static ALLOWED_SPECIAL_SCHEMES = Object.freeze([
    'about:blank',
    'about:config',
    'yayra://newtab',
    'yayra://dashboard',
    'yayra://settings',
    'yayra://history',
    'yayra://bookmarks',
    'yayra://downloads',
    'yayra://passwords',
    'yayra://extensions',
    'yayra://permissions',
    'yayra://about'
  ]);

  constructor(options = {}) {
    this.defaultSearchEngine = options.defaultSearchEngine || 'google';
    this.customSearchUrl = options.customSearchUrl;
  }

  static interpret(input, searchEngineOverride) {
    return new UrlInterpreter().interpret(input, searchEngineOverride);
  }

  interpret(input, searchEngineOverride) {
    const raw = (input || '').trim();

    if (!raw) {
      return {
        originalInput: '',
        normalizedUrl: 'about:blank',
        isSearchQuery: false,
        isSpecialScheme: true,
        isSecure: true,
        isBlockedScheme: false,
        hostname: null
      };
    }

    const lower = raw.toLowerCase();

    for (const blocked of UrlInterpreter.BLOCKED_SCHEMES) {
      if (lower.startsWith(blocked)) {
        return {
          originalInput: raw,
          normalizedUrl: this.buildSearchUrl(raw, searchEngineOverride),
          isSearchQuery: true,
          isSpecialScheme: false,
          isBlockedScheme: true,
          isSecure: false,
          hostname: null,
          searchEngine: searchEngineOverride || this.defaultSearchEngine
        };
      }
    }

    if (UrlInterpreter.ALLOWED_SPECIAL_SCHEMES.includes(lower) || lower.startsWith('yayra://')) {
      return {
        originalInput: raw,
        normalizedUrl: raw,
        isSearchQuery: false,
        isSpecialScheme: true,
        isBlockedScheme: false,
        isSecure: true,
        hostname: null
      };
    }

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      try {
        const parsed = new URL(raw);
        const host = this.normalizeHostname(parsed.hostname);
        parsed.hostname = host;

        return {
          originalInput: raw,
          normalizedUrl: parsed.toString(),
          isSearchQuery: false,
          isSpecialScheme: false,
          isBlockedScheme: false,
          isSecure: parsed.protocol === 'https:',
          hostname: host
        };
      } catch {
        return {
          originalInput: raw,
          normalizedUrl: this.buildSearchUrl(raw, searchEngineOverride),
          isSearchQuery: true,
          isSpecialScheme: false,
          isBlockedScheme: false,
          isSecure: true,
          hostname: null,
          searchEngine: searchEngineOverride || this.defaultSearchEngine
        };
      }
    }

    const sanitizedDomainCandidate = raw.replace(/\.+$/, '');

    if (this.looksLikeDomainOrIp(sanitizedDomainCandidate)) {
      const scheme = lower.startsWith('localhost') || /^127\.\d+\.\d+\.\d+/.test(sanitizedDomainCandidate) ? 'http://' : 'https://';
      const candidateUrl = scheme + sanitizedDomainCandidate;
      try {
        const parsed = new URL(candidateUrl);
        const host = this.normalizeHostname(parsed.hostname);
        parsed.hostname = host;

        return {
          originalInput: raw,
          normalizedUrl: parsed.toString(),
          isSearchQuery: false,
          isSpecialScheme: false,
          isBlockedScheme: false,
          isSecure: parsed.protocol === 'https:',
          hostname: host
        };
      } catch {
        // Fall back to search
      }
    }

    return {
      originalInput: raw,
      normalizedUrl: this.buildSearchUrl(raw, searchEngineOverride),
      isSearchQuery: true,
      isSpecialScheme: false,
      isBlockedScheme: false,
      isSecure: true,
      hostname: null,
      searchEngine: searchEngineOverride || this.defaultSearchEngine
    };
  }

  buildSearchUrl(query, engine) {
    const activeEngine = engine || this.defaultSearchEngine;
    const encodedQuery = encodeURIComponent(query.trim());

    if (activeEngine === 'custom' && this.customSearchUrl) {
      return this.customSearchUrl.replace('{query}', encodedQuery);
    }

    const template = UrlInterpreter.SEARCH_TEMPLATES[activeEngine] || UrlInterpreter.SEARCH_TEMPLATES.duckduckgo;
    return template.replace('{query}', encodedQuery);
  }

  looksLikeDomainOrIp(input) {
    if (input.includes(' ') || input.includes('\n') || input.includes('\t')) {
      return false;
    }

    const domainPart = input.split('/')[0].split('?')[0].split('#')[0];

    if (domainPart === 'localhost' || domainPart.startsWith('localhost:')) {
      return true;
    }

    if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/.test(domainPart)) {
      return true;
    }

    if (/^\[[0-9a-fA-F:]+\](?::[0-9]{1,5})?$/.test(domainPart)) {
      return true;
    }

    const domainRegex = /^[a-zA-Z0-9\u00a1-\uffff](?:[a-zA-Z0-9\u00a1-\uffff-]{0,61}[a-zA-Z0-9\u00a1-\uffff])?(?:\.[a-zA-Z0-9\u00a1-\uffff](?:[a-zA-Z0-9\u00a1-\uffff-]{0,61}[a-zA-Z0-9\u00a1-\uffff])?)+(?::[0-9]{1,5})?$/;
    return domainRegex.test(domainPart);
  }

  normalizeHostname(hostname) {
    let clean = hostname.replace(/\.+$/, '');
    try {
      clean = clean.normalize('NFC');
    } catch {
      // Ignore
    }
    return clean;
  }
}

export const defaultUrlInterpreter = new UrlInterpreter();
