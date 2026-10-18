export const DESKTOP_CUSTOM_SCHEME = 'yayra';
export const ASSET_ORIGINS = Object.freeze([
  'https://yayra.pages.dev',
  'https://icons.duckduckgo.com',
  // Google's OAuth userinfo "picture" claim always resolves to this exact
  // host (confirmed across Google's own docs/SDKs) - needed so a signed-in
  // user's avatar renders in Settings -> Account instead of a broken image
  // icon. Deliberately NOT *.googleusercontent.com, which also serves
  // arbitrary user-uploaded content for many unrelated Google products.
  'https://lh3.googleusercontent.com'
]);
export const API_ORIGINS = Object.freeze(['https://yayra-updates-api.g2code335.workers.dev']);

export function buildContentSecurityPolicy() {
  const scheme = `${DESKTOP_CUSTOM_SCHEME}:`;
  const imgSources = [`'self'`, 'data:', 'blob:', scheme, ...ASSET_ORIGINS];
  const connectSources = [`'self'`, scheme, ...API_ORIGINS];
  return [
    `default-src 'self' ${scheme}`,
    `script-src 'self' ${scheme}`,
    // The offline PDF.js worker normally runs from the same origin; blob:
    // is also required for its cross-origin wrapper on file:// fallbacks.
    `worker-src 'self' blob: ${scheme}`,
    `style-src 'self' 'unsafe-inline' ${scheme}`,
    `img-src ${imgSources.join(' ')}`,
    `connect-src ${connectSources.join(' ')}`,
    // The browser shell intentionally hosts navigated HTTP(S) pages in its
    // sandboxed webview. frame-ancestors is an HTTP-response directive and is
    // ignored when this policy is delivered through the index meta tag.
    `frame-src http: https: ${scheme}`,
    // Local-image Lens searches use a native multipart form so the File goes
    // straight from the user's browser to Google; no Yayra server can see it.
    `form-action 'self' https://lens.google.com`,
    `object-src 'none'`,
    `base-uri 'self'`
  ].join('; ');
}
