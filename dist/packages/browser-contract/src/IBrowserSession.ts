/**
 * Yayra Floating Browser - Browser Session Contract
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface IBrowserSession {
  readonly isIncognito: boolean;
  readonly partitionId: string;

  getCookies(url: string): Promise<Cookie[]>;
  setCookie(cookie: Cookie): Promise<void>;
  clearCookies(): Promise<void>;
  clearCache(): Promise<void>;
  clearStorage(): Promise<void>;
}
