/**
 * Yayra Floating Browser - Browser Session Contract (JS runtime)
 */

export class AbstractBrowserSession {
  constructor(partitionId = 'default', isIncognito = false) {
    this.partitionId = partitionId;
    this.isIncognito = isIncognito;
    this.cookies = new Map();
  }

  async getCookies(url) {
    return Array.from(this.cookies.values());
  }

  async setCookie(cookie) {
    this.cookies.set(cookie.name, cookie);
  }

  async clearCookies() {
    this.cookies.clear();
  }

  async clearCache() {}

  async clearStorage() {}
}
