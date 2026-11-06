/**
 * Resolves the Android/iOS (Capacitor) "Sign in with Google" configuration.
 *
 * Mirrors src/config/googleAuthWeb.js: the platform-specific Client IDs are
 * injected at build time into <meta> tags by scripts/build-web.mjs (from
 * YAYRA_GOOGLE_ANDROID_CLIENT_ID / YAYRA_GOOGLE_IOS_CLIENT_ID env vars or
 * the gitignored google-auth.web.config.json). Android/iOS OAuth clients
 * have NO secret at all - Google verifies them by package name + SHA-1
 * fingerprint (Android) / bundle ID (iOS) - so nothing here is sensitive;
 * the IDs ship inside the app bundle by design, exactly like the Desktop
 * Client ID ships inside the Electron build.
 *
 * The native platform ('android' | 'ios') comes from Capacitor's runtime
 * global; pass `getPlatform` for tests.
 */

const DEFAULT_EXCHANGE_URL = 'https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange';

function cleanValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('__')) return null; // unreplaced build placeholder
  return trimmed;
}

export function resolveCapacitorGoogleAuthConfig({
  doc = typeof document !== 'undefined' ? document : undefined,
  getPlatform
} = {}) {
  const platform = typeof getPlatform === 'function' ? getPlatform() : null;
  if (platform !== 'android' && platform !== 'ios') {
    return { platform: null, clientId: null, exchangeUrl: null };
  }
  const meta = (name) => cleanValue(doc?.querySelector?.(`meta[name="${name}"]`)?.getAttribute?.('content'));
  const clientId = meta(platform === 'android' ? 'yayra-google-android-client-id' : 'yayra-google-ios-client-id');
  if (!clientId) return { platform, clientId: null, exchangeUrl: null };
  return {
    platform,
    clientId,
    exchangeUrl: meta('yayra-google-auth-exchange-url') || DEFAULT_EXCHANGE_URL
  };
}
