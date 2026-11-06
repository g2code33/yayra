/**
 * Resolves the Web/PWA "Sign in with Google" configuration.
 *
 * The Web Client ID is injected at build time by scripts/build-web.mjs into
 * a <meta> tag (from the YAYRA_GOOGLE_WEB_CLIENT_ID env var or the
 * gitignored google-auth.web.config.json - see docs/GOOGLE_SIGNIN.md).
 * A Client ID is public by design (it ships in every page load), so a meta
 * tag is an appropriate home for it; the client SECRET never appears
 * anywhere in web-delivered code - it lives only in the Cloudflare Worker
 * (see src/services/googleAuthWeb.js for the full rationale).
 *
 * Resolution order (first hit wins):
 *   1. window.__YAYRA_GOOGLE_WEB_AUTH__ = { clientId, exchangeUrl } - an
 *      explicit runtime override, used by local experiments/tests.
 *   2. <meta name="yayra-google-web-client-id"> /
 *      <meta name="yayra-google-auth-exchange-url"> - the build-injected
 *      production path.
 * Unresolved (empty/placeholder) values yield null, which the caller treats
 * as "feature not configured for this deployment" - the Settings UI then
 * shows its honest "not available on this build" message.
 */

const DEFAULT_EXCHANGE_URL = 'https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange';

function cleanValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Unreplaced build placeholders (local `python -m http.server`-style
  // serving of the raw public/ dir) must not look like real config.
  if (!trimmed || trimmed.startsWith('__')) return null;
  return trimmed;
}

export function resolveWebGoogleAuthConfig({ win = typeof window !== 'undefined' ? window : undefined, doc = typeof document !== 'undefined' ? document : undefined } = {}) {
  const override = win && win.__YAYRA_GOOGLE_WEB_AUTH__;
  if (override && cleanValue(override.clientId)) {
    return {
      clientId: cleanValue(override.clientId),
      exchangeUrl: cleanValue(override.exchangeUrl) || DEFAULT_EXCHANGE_URL
    };
  }
  const meta = (name) => cleanValue(doc?.querySelector?.(`meta[name="${name}"]`)?.getAttribute?.('content'));
  const clientId = meta('yayra-google-web-client-id');
  if (!clientId) return { clientId: null, exchangeUrl: null };
  return {
    clientId,
    exchangeUrl: meta('yayra-google-auth-exchange-url') || DEFAULT_EXCHANGE_URL
  };
}
