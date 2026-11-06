/**
 * Yayra Floating Browser - Safe URL Interpretation & Normalization Engine
 * Zero-trust URL parser that distinguishes direct web addresses, special browser schemes,
 * internationalized domain names (IDN), and converts natural language queries to search URLs.
 */

import { SearchEngineType } from '../models/BrowserSettings.js';

export interface InterpretedUrl {
  originalInput: string;
  normalizedUrl: string;
  isSearchQuery: boolean;
  isSpecialScheme: boolean;
  isBlockedScheme: boolean;
  isSecure: boolean;
  hostname: string | null;
  searchEngine?: SearchEngineType;
}

export interface UrlInterpreterOptions {
  defaultSearchEngine?: SearchEngineType;
  customSearchUrl?: string;
  allowedSpecialSchemes?: string[];
  blockedSchemes?: string[];
}

export class UrlInterpreter {
  public static readonly SEARCH_TEMPLATES: Record<SearchEngineType, string> = Object.freeze({
    duckduckgo: 'https://duckduckgo.com/?q={query}',
    searx: 'https://searx.be/search?q={query}',
    google: 'https://www.google.com/search?q={query}',
    bing: 'https://www.bing.com/search?q={query}',
    custom: 'https://duckduckgo.com/?q={query}'
  });

  public static readonly BLOCKED_SCHEMES = Object.freeze([
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

  public static readonly ALLOWED_SPECIAL_SCHEMES = Object.freeze([
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

  private defaultSearchEngine: SearchEngineType;
  private customSearchUrl?: string;

  constructor(options: UrlInterpreterOptions = {}) {
    this.defaultSearchEngine = options.defaultSearchEngine || 'duckduckgo';
    this.customSearchUrl = options.customSearchUrl;
  }

  public static interpret(input: string, searchEngineOverride?: SearchEngineType): InterpretedUrl {
    return new UrlInterpreter().interpret(input, searchEngineOverride);
  }

  /**
   * Interprets and sanitizes any user input string from the omnibox/address bar.
   */
  public interpret(input: string, searchEngineOverride?: SearchEngineType): InterpretedUrl {
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

    // Check blocked schemes (prevent XSS via javascript: or data: navigation)
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

    // Check special allowed browser schemes
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

    // Check explicit http:// or https://
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

    // Sanitize trailing dots for domain checking (e.g. "github.com..." -> "github.com")
    const sanitizedDomainCandidate = raw.replace(/\.+$/, '');

    // Candidate domain check (e.g. "example.com", "sub.domain.org/path", "localhost:3000", "192.168.1.1:8080", "münchen.de")
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

    // Default: natural language search query
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

  /**
   * Builds an encoded search query URL based on the active search engine.
   */
  public buildSearchUrl(query: string, engine?: SearchEngineType): string {
    const activeEngine = engine || this.defaultSearchEngine;
    const encodedQuery = encodeURIComponent(query.trim());

    if (activeEngine === 'custom' && this.customSearchUrl) {
      return this.customSearchUrl.replace('{query}', encodedQuery);
    }

    const template = UrlInterpreter.SEARCH_TEMPLATES[activeEngine] || UrlInterpreter.SEARCH_TEMPLATES.duckduckgo;
    return template.replace('{query}', encodedQuery);
  }

  /**
   * Tests whether an input string has typical domain/hostname patterns.
   */
  private looksLikeDomainOrIp(input: string): boolean {
    if (input.includes(' ') || input.includes('\n') || input.includes('\t')) {
      return false;
    }

    const domainPart = input.split('/')[0].split('?')[0].split('#')[0];

    // Localhost / Local IP addresses
    if (domainPart === 'localhost' || domainPart.startsWith('localhost:')) {
      return true;
    }

    // IPv4 address with optional port
    if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/.test(domainPart)) {
      return true;
    }

    // IPv6 address enclosed in brackets
    if (/^\[[0-9a-fA-F:]+\](?::[0-9]{1,5})?$/.test(domainPart)) {
      return true;
    }

    // Domain name with valid TLD or IDN unicode characters
    const domainRegex = /^[a-zA-Z0-9\u00a1-\uffff](?:[a-zA-Z0-9\u00a1-\uffff-]{0,61}[a-zA-Z0-9\u00a1-\uffff])?(?:\.[a-zA-Z0-9\u00a1-\uffff](?:[a-zA-Z0-9\u00a1-\uffff-]{0,61}[a-zA-Z0-9\u00a1-\uffff])?)+(?::[0-9]{1,5})?$/;
    return domainRegex.test(domainPart);
  }

  /**
   * Normalizes internationalized hostnames (IDN) and strips trailing dots.
   */
  private normalizeHostname(hostname: string): string {
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
