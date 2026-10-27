import {
  GOOGLE_SERVICE_IDS,
  googleServiceById,
  googleServiceApiUrl,
  normalizeGoogleServiceItems
} from '../src/services/googleServiceCatalog.js';

const DEFAULT_MANIFEST = {
  schema: 1,
  channel: 'stable',
  latest: { windows: '0.1.0', linux: '0.1.0', ios: '0.1.0', android: '0.1.0', pwa: '0.1.0' },
  minSupported: { windows: '0.1.0', linux: '0.1.0', ios: '0.1.0', android: '0.1.0', pwa: '0.1.0' },
  downloads: {},
  notes: { en: 'Initial yayra release infrastructure.' },
  rollout: { percent: 100, allowlist: [] },
  publishedAt: '2026-10-02T00:00:00.000Z',
  ttlSeconds: 300
};

const WINDOW_MS = 60_000;
const LIMIT = 120;
const buckets = new Map();
const AUTH_LIMIT = 20;
const AUTH_MAX_BODY_BYTES = 16 * 1024;
const authBuckets = new Map();
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DRIVE_MAX_FILE_BYTES = 300 * 1024 * 1024;
const GMAIL_BODY_MAX_CHARS = 2 * 1024 * 1024;
const DRIVE_SESSION_PREFIX = 'drive-session:';
const GMAIL_SESSION_PREFIX = 'gmail-session:';
const GOOGLE_SERVICES_SESSION_PREFIX = 'google-services-session:';
const GOOGLE_SERVICE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/classroom.courses.readonly'
]);


// --- /api/ai : Yayra's managed AI, backed by a POOL of NVIDIA keys -------
// NVIDIA's NIM endpoint is OpenAI-compatible; the Worker holds MANY API
// keys (10+, any number) and spreads users across them so no single key
// gets crowded: round-robin start + failover walk, with per-key cooldown
// benches for keys that answer 429 (rate-limited) or 401/403 (dead key).
const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
// Default model for Yayra's managed AI. Kimi K3 on NVIDIA NIM: ~2.8T MoE,
// 1M context, strong reasoning. Override WITHOUT code changes by setting
// the NVIDIA_MODEL var on the worker (see docs/CLOUDFLARE.md).
const NVIDIA_DEFAULT_MODEL = 'moonshotai/kimi-k3';
const AI_WINDOW_MS = 60_000;
const AI_LIMIT = 15; // per-IP AI budget, separate from the global limiter
const aiBuckets = new Map();
const keyBench = new Map(); // api key -> benched-until timestamp
let aiRotor = Math.floor(Math.random() * 0xffff); // random per-isolate start

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return new Response('HTTPS required', { status: 400 });
    if (!['/updates/manifest.json', '/api/suggestions', '/api/latest-release', '/api/ai', '/api/drive/download', '/api/drive/session/revoke', '/api/gmail/messages', '/api/gmail/message', '/api/gmail/session/revoke', '/api/google/services', '/api/google/services/session/revoke', '/auth/google/exchange'].includes(url.pathname)) {
      return new Response('not found', { status: 404 });
    }

    const isGoogleExchange = url.pathname === '/auth/google/exchange';
    const isDriveDownload = url.pathname === '/api/drive/download';
    const isDriveRevoke = url.pathname === '/api/drive/session/revoke';
    const isGmailList = url.pathname === '/api/gmail/messages';
    const isGmailMessage = url.pathname === '/api/gmail/message';
    const isGmailRevoke = url.pathname === '/api/gmail/session/revoke';
    const isGoogleServiceList = url.pathname === '/api/google/services';
    const isGoogleServicesRevoke = url.pathname === '/api/google/services/session/revoke';
    const isDelegatedGoogleRoute = isGoogleExchange || isDriveDownload || isDriveRevoke
      || isGmailList || isGmailMessage || isGmailRevoke || isGoogleServiceList || isGoogleServicesRevoke;
    const authOrigin = isDelegatedGoogleRoute ? authorizeGoogleExchangeOrigin(request, env) : null;
    const headers = isDelegatedGoogleRoute ? googleAuthHeaders(authOrigin) : baseHeaders();
    if (isDelegatedGoogleRoute && authOrigin === false) {
      return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403, headers });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    if (!take(ip, now)) return new Response('rate limited', { status: 429, headers });
    if (isDelegatedGoogleRoute && !takeFrom(authBuckets, ip, now, WINDOW_MS, AUTH_LIMIT)) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers });
    }

    if (url.pathname === '/api/suggestions') return proxySuggestions(request, url, headers, ctx);
    if (url.pathname === '/api/latest-release') return proxyLatestRelease(request, headers, env, ctx);
    if (url.pathname === '/api/ai') return answerWithNvidiaPool(request, headers, env, ip);
    if (isDriveDownload) return downloadDelegatedDriveFile(request, url, headers, env, authOrigin);
    if (isDriveRevoke) return revokeDelegatedDriveSession(request, headers, env, authOrigin);
    if (isGmailList) return listDelegatedGmailMessages(request, url, headers, env, authOrigin);
    if (isGmailMessage) return getDelegatedGmailMessage(request, url, headers, env, authOrigin);
    if (isGmailRevoke) return revokeDelegatedGmailSession(request, headers, env, authOrigin);
    if (isGoogleServiceList) return getDelegatedGoogleServiceItems(request, url, headers, env, authOrigin);
    if (isGoogleServicesRevoke) return revokeDelegatedGoogleServicesSession(request, headers, env, authOrigin);
    if (isGoogleExchange) return exchangeGoogleAuthCode(request, headers, env, authOrigin);
    return serveManifest(request, env, headers);
  }
};

/**
 * Build the NVIDIA key pool from the Worker's secret bindings. Two styles,
 * merged and deduped, so ANY number of keys (10, 20, 50...) works:
 *   1. NVIDIA_API_KEYS - one secret holding many keys separated by commas,
 *      whitespace or newlines (easiest: one `wrangler secret put` call).
 *   2. NVIDIA_API_KEY_1, NVIDIA_API_KEY_2, ... NVIDIA_API_KEY_42 - numbered
 *      individual secrets, so keys can be added/revoked one at a time.
 *
 * EVERY KEY CAN CARRY ITS OWN MODEL (per-key model routing):
 *   - numbered keys: bind NVIDIA_MODEL_n next to NVIDIA_API_KEY_n
 *     (e.g. NVIDIA_MODEL_3 = "meta/llama-3.3-70b-instruct");
 *   - list entries: append the model inline as key@model
 *     (e.g. "nvapi-xxx@moonshotai/kimi-k3, nvapi-yyy" - keys are
 *     nvapi-... strings, so '@' is a safe separator);
 *   - any key WITHOUT its own model uses NVIDIA_MODEL, then the default.
 * Keys never appear in wrangler.worker.toml or the repo - secrets only.
 * Returns [{ key, model }, ...].
 */
function collectNvidiaKeys(env) {
  const entries = [];
  const seen = new Set();
  const defaultModel = env?.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL;
  const push = (raw, boundModel) => {
    for (const token of String(raw || '').split(/[\s,;]+/)) {
      if (!token) continue;
      const at = token.indexOf('@');
      const key = at > 0 ? token.slice(0, at) : token;
      const inlineModel = at > 0 ? token.slice(at + 1) : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, model: inlineModel || boundModel || defaultModel });
    }
  };
  push(env?.NVIDIA_API_KEYS);
  const numbered = Object.keys(env || {})
    .filter((name) => /^NVIDIA_API_KEY_\d+$/.test(name))
    .sort((a, b) => Number(a.slice(15)) - Number(b.slice(15)));
  for (const name of numbered) {
    const n = name.slice(15); // 'NVIDIA_API_KEY_'.length
    push(env[name], typeof env[`NVIDIA_MODEL_${n}`] === 'string' && env[`NVIDIA_MODEL_${n}`] ? env[`NVIDIA_MODEL_${n}`] : '');
  }
  return entries;
}

/** Only well-formed chat turns reach NVIDIA; everything else is clamped. */
function sanitizeAiMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) return null;
  const out = [];
  let total = 0;
  for (const m of raw) {
    const role = m?.role;
    if (!['system', 'user', 'assistant'].includes(role)) return null;
    if (typeof m?.content !== 'string') return null;
    const content = m.content.slice(0, 8000);
    total += content.length;
    if (total > 32_000) return null;
    out.push({ role, content });
  }
  return out;
}

async function answerWithNvidiaPool(request, headers, env, ip) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });

  const keys = collectNvidiaKeys(env);
  if (!keys.length) {
    // Honest 501: the client (aiService) maps this to "backend not
    // deployed" instead of fabricating an answer.
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers });
  }

  // Dedicated AI budget per IP (cheaper endpoints keep the global 120/min).
  if (!takeFrom(aiBuckets, ip, Date.now(), AI_WINDOW_MS, AI_LIMIT)) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers });
  }
  const messages = sanitizeAiMessages(body?.messages);
  if (!messages) return new Response(JSON.stringify({ error: 'invalid_messages' }), { status: 400, headers });

  // SPEED: when the client asks for `stream: true`, tokens are piped
  // straight through from NVIDIA as Server-Sent Events the moment they are
  // generated (same system as the CLINICAL-RX app) - first words appear in
  // well under a second instead of after the whole completion. The
  // non-streamed JSON contract stays for old clients and simple callers.
  const wantStream = body?.stream === true;

  // SPEED + CORRECTNESS for reasoning models (Kimi K3, DeepSeek-R1, ...):
  // these models "think" (reasoning_content) BEFORE answering. Left
  // unconfigured they think at max effort - tens of seconds before the
  // first visible word - and the thinking also consumes max_tokens, which
  // with a small budget can leave the actual answer EMPTY or truncated.
  // So: (1) reasoning models default to reasoning_effort "low" - snappy
  // answers, still smart (override with the NVIDIA_REASONING_EFFORT var:
  // low|medium|high|max, or "off" to send nothing); (2) the token budget
  // is 4096 (override with NVIDIA_MAX_TOKENS) so thinking can never
  // starve the answer. Non-reasoning models get NO reasoning_effort key -
  // strict OpenAI-compatible servers reject unknown parameters.
  const REASONING_MODEL_RE = /kimi|deepseek(-ai\/)?deepseek-r1|qwq|thinking|reasoning|gpt-oss|openai\/o[134]/i;
  const reasoningEffortFor = (model) => {
    const configured = typeof env?.NVIDIA_REASONING_EFFORT === 'string' ? env.NVIDIA_REASONING_EFFORT.trim().toLowerCase() : '';
    if (configured === 'off' || configured === 'none') return null;
    if (['low', 'medium', 'high', 'max'].includes(configured)) return configured;
    return REASONING_MODEL_RE.test(model) ? 'low' : null;
  };
  const maxTokens = Number.parseInt(env?.NVIDIA_MAX_TOKENS, 10) > 0 ? Number.parseInt(env.NVIDIA_MAX_TOKENS, 10) : 4096;

  // The request body is built PER KEY: every pool entry carries its own
  // model (NVIDIA_MODEL_n / key@model), so a failover hop to another key
  // automatically speaks that key's model.
  const bodyFor = (model) => {
    const effort = reasoningEffortFor(model);
    return JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: maxTokens,
      stream: wantStream,
      ...(effort ? { reasoning_effort: effort } : {})
    });
  };

  // Round-robin start (random per isolate, advancing per request) spreads
  // simultaneous users across DIFFERENT keys; the failover walk tries the
  // next keys when one is benched, rate-limited or dead.
  const now = Date.now();
  const start = aiRotor++ % keys.length;
  const maxAttempts = Math.min(keys.length, 5);
  let attempted = 0;
  let sawRateLimit = false;
  let lastStatus = 0;

  for (let i = 0; i < keys.length && attempted < maxAttempts; i += 1) {
    const { key, model } = keys[(start + i) % keys.length];
    const benchedUntil = keyBench.get(key) || 0;
    if (benchedUntil > now) continue; // benched key: let it cool down
    attempted += 1;

    let upstream;
    try {
      upstream = await fetch(env?.NVIDIA_BASE_URL || NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: wantStream ? 'text/event-stream' : 'application/json'
        },
        body: bodyFor(model)
      });
    } catch {
      lastStatus = 0;
      continue; // network blip: try the next key
    }

    if (upstream.ok) {
      if (wantStream && upstream.body) {
        // Pipe NVIDIA's SSE body straight through, untouched - zero
        // buffering in the worker, so the client paints each token the
        // instant the model emits it. Failover already happened above:
        // only a healthy 200 reaches this point.
        return new Response(upstream.body, {
          status: 200,
          headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
      let payload;
      try { payload = await upstream.json(); } catch { payload = null; }
      const answer = typeof payload?.choices?.[0]?.message?.content === 'string'
        ? payload.choices[0].message.content.trim()
        : '';
      if (!answer) { lastStatus = 502; continue; }
      return new Response(JSON.stringify({ answer }), { status: 200, headers: { ...headers, 'cache-control': 'no-store' } });
    }

    lastStatus = upstream.status;
    if (upstream.status === 429) {
      // This key is crowded right now - bench it a minute and move on so
      // the next user lands on a fresh key.
      sawRateLimit = true;
      keyBench.set(key, Date.now() + 60_000);
    } else if (upstream.status === 401 || upstream.status === 403) {
      // Revoked/exhausted key - bench it long so it stops eating attempts.
      keyBench.set(key, Date.now() + 10 * 60_000);
      console.log(`[ai] NVIDIA key rejected (status=${upstream.status}) - benched 10min`);
    }
    // 5xx: just walk on to the next key.
  }

  if (sawRateLimit) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers });
  console.log(`[ai] pool exhausted keys=${keys.length} attempted=${attempted} lastStatus=${lastStatus}`);
  return new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 502, headers });
}

async function serveManifest(request, env, headers) {
  const manifest = readManifest(env);
  const body = JSON.stringify(manifest, null, 2);
  const etag = await sha256Etag(body);
  console.log(`[updates] manifest check ip=${request.headers.get('cf-connecting-ip') || 'unknown'} etag=${etag}`);
  const responseHeaders = { ...headers, ETag: etag, 'cache-control': 'public, max-age=300' };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: responseHeaders });
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: responseHeaders });
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: responseHeaders });
  return new Response(body, { status: 200, headers: responseHeaders });
}

async function proxySuggestions(request, url, headers, ctx) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers });
  const query = (url.searchParams.get('q') || '').trim().slice(0, 200);
  if (!query) return new Response(JSON.stringify(['', []]), { status: 200, headers });
  const upstreamUrl = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`;
  const upstream = await proxyJson(upstreamUrl, headers, {}, ctx, 'public, max-age=60');
  if (upstream.ok) return upstream;
  // Suggestions are optional. Return the same empty payload shape on an
  // upstream outage instead of leaking a noisy 502 into every address-bar
  // keystroke; the client still has profile-local suggestions to show.
  return new Response(JSON.stringify([query, []]), {
    status: 200,
    headers: { ...headers, 'cache-control': 'no-store', 'x-yayra-suggestions': 'fallback' }
  });
}

/**
 * GitHub's REST API allows only 60 unauthenticated requests/hour, and that
 * quota is keyed by the calling IP - which for a Cloudflare Worker is drawn
 * from Cloudflare's shared edge egress range, not a dedicated address. That
 * means this endpoint can get rate-limited by *other* Workers' traffic
 * entirely outside yayra's control, independent of this Worker's own
 * per-client rate limiter above. Two defenses, both applied:
 *   1. An edge Cache API layer in proxyJson() below, so repeat requests
 *      within the cache TTL never reach GitHub at all.
 *   2. Optional GITHUB_TOKEN support here: if a token is bound to the
 *      Worker (wrangler secret put GITHUB_TOKEN - never committed to the
 *      repo or wrangler.worker.toml), GitHub's authenticated quota of
 *      5,000 requests/hour applies instead of the shared 60/hour pool.
 *      Falls back to the previous unauthenticated behavior when unset.
 */
async function proxyLatestRelease(request, headers, env, ctx) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers });
  const requestHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yayra-updates-api',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (env?.GITHUB_TOKEN) requestHeaders.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return proxyJson('https://api.github.com/repos/g2code33/yayra/releases/latest', headers, requestHeaders, ctx, 'public, max-age=300');
}

async function proxyJson(target, headers, requestHeaders = {}, ctx, cacheControl = 'public, max-age=60') {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(target, { method: 'GET' });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, { status: cached.status, headers: { ...headers, 'cache-control': cacheControl, 'x-yayra-cache': 'HIT' } });
    }
  }

  try {
    const upstream = await fetch(target, { headers: requestHeaders });
    const body = await upstream.text();
    if (cache && upstream.ok) {
      const toCache = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl }
      });
      const putPromise = cache.put(cacheKey, toCache);
      if (ctx?.waitUntil) ctx.waitUntil(putPromise);
      else await putPromise;
    }
    return new Response(body, {
      status: upstream.ok ? 200 : 502,
      headers: { ...headers, 'cache-control': cacheControl, 'x-yayra-cache': 'MISS' }
    });
  } catch {
    return new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 502, headers });
  }
}

/**
 * Server-side half of the Web/PWA "Sign in with Google" flow (the browser
 * half is src/services/googleAuthWeb.js; architecture + threat model in
 * docs/GOOGLE_SIGNIN.md).
 *
 * WHY THIS EXISTS: Google's token endpoint requires a client_secret for
 * "Web application" OAuth clients even with PKCE, and a secret cannot live
 * in browser-delivered JS. So the browser sends ONLY its one-shot
 * authorization code + PKCE code_verifier here; this Worker (holding
 * GOOGLE_WEB_CLIENT_ID / GOOGLE_WEB_CLIENT_SECRET as bindings - wrangler
 * secret put, never committed) performs the code-for-token exchange AND the
 * userinfo fetch, then returns ONLY the basic profile. The access token is
 * a local variable in this function and is gone when it returns - raw
 * tokens are never stored anywhere and never sent to any client, which is
 * a STRONGER guarantee than the desktop build (where tokens at least exist
 * encrypted on the user's own machine).
 *
 * The Android/iOS (Capacitor) flow reuses this endpoint with
 * `platform: 'android' | 'ios'` (see src/services/googleAuthCapacitor.js).
 * Those Google client types have NO secret (they're verified by package
 * name + SHA-1 / bundle ID), so only GOOGLE_ANDROID_CLIENT_ID /
 * GOOGLE_IOS_CLIENT_ID bindings are needed - the server-side exchange is
 * kept anyway so raw tokens never exist in the app's JS context either.
 *
 * Replay/abuse resistance: the code is single-use and PKCE-bound (Google
 * enforces both), redirect_uri must match a URI registered on the Google
 * client, and the Worker's existing per-IP rate limiter applies.
 */
function resolveGoogleClient(env, platform) {
  if (platform === 'android') {
    return env?.GOOGLE_ANDROID_CLIENT_ID ? { clientId: env.GOOGLE_ANDROID_CLIENT_ID, clientSecret: null } : null;
  }
  if (platform === 'ios') {
    return env?.GOOGLE_IOS_CLIENT_ID ? { clientId: env.GOOGLE_IOS_CLIENT_ID, clientSecret: null } : null;
  }
  if (platform === 'web') {
    return env?.GOOGLE_WEB_CLIENT_ID && env?.GOOGLE_WEB_CLIENT_SECRET
      ? { clientId: env.GOOGLE_WEB_CLIENT_ID, clientSecret: env.GOOGLE_WEB_CLIENT_SECRET }
      : null;
  }
  return null;
}

const DEFAULT_GOOGLE_WEB_ALLOWED_ORIGINS = ['https://yayra.pages.dev', 'http://localhost:4173'];
const DEFAULT_GOOGLE_NATIVE_ALLOWED_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost'];

function configuredGoogleWebOrigins(env = {}) {
  return typeof env.GOOGLE_WEB_ALLOWED_ORIGINS === 'string'
    ? env.GOOGLE_WEB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_GOOGLE_WEB_ALLOWED_ORIGINS;
}

function configuredGoogleNativeOrigins(env = {}) {
  return typeof env.GOOGLE_NATIVE_ALLOWED_ORIGINS === 'string'
    ? env.GOOGLE_NATIVE_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_GOOGLE_NATIVE_ALLOWED_ORIGINS;
}

function configuredGoogleAuthOrigins(env = {}) {
  return new Set([...configuredGoogleWebOrigins(env), ...configuredGoogleNativeOrigins(env)]);
}

/**
 * CORS for the code-exchange seam is exact-origin, never `*`. Requests made
 * by native HTTP stacks can legitimately omit Origin; browser/WebView calls
 * must present one of the explicitly configured web or Capacitor origins.
 */
function authorizeGoogleExchangeOrigin(request, env = {}) {
  const rawOrigin = request.headers.get('origin');
  if (!rawOrigin) return null;
  if (rawOrigin === 'null' || rawOrigin.length > 256) return false;
  let normalized;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password) return false;
    normalized = parsed.origin;
  } catch {
    return false;
  }
  return configuredGoogleAuthOrigins(env).has(normalized) ? normalized : false;
}

function googleAuthHeaders(allowedOrigin) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    vary: 'Origin',
    ...(typeof allowedOrigin === 'string' ? { 'access-control-allow-origin': allowedOrigin } : {})
  };
}

function isAcceptableRedirectUri(redirectUri, platform, env = {}) {
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return false;
  }
  if (redirect.username || redirect.password || redirect.search || redirect.hash) return false;
  if (platform === 'android' || platform === 'ios') {
    // Mobile builds register exactly this RFC 8252 reverse-DNS callback.
    // Do not accept arbitrary non-HTTP schemes or lookalike callback paths.
    return redirectUri === 'com.yayra.app:/oauth2redirect'
      && redirect.protocol === 'com.yayra.app:'
      && redirect.host === ''
      && redirect.pathname === '/oauth2redirect';
  }
  if (redirect.pathname !== '/auth/callback') return false;
  return configuredGoogleWebOrigins(env).includes(redirect.origin);
}

async function exchangeGoogleAuthCode(request, headers, env, authorizedOrigin = null) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return new Response(JSON.stringify({ error: 'unsupported_media_type' }), { status: 415, headers });
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > AUTH_MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: 'request_too_large' }), { status: 413, headers });
  }

  let body;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > AUTH_MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'request_too_large' }), { status: 413, headers });
    }
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['code', 'codeVerifier', 'redirectUri', 'platform', 'capability'].includes(key))) {
    return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers });
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const codeVerifier = typeof body.codeVerifier === 'string' ? body.codeVerifier : '';
  const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : '';
  const platform = typeof body.platform === 'string' ? body.platform : 'web';
  const capability = body.capability === undefined ? 'profile' : body.capability;
  if (!['profile', 'drive-readonly', 'gmail-readonly', 'google-services'].includes(capability)) {
    return new Response(JSON.stringify({ error: 'invalid_capability' }), { status: 400, headers });
  }
  if (!['web', 'android', 'ios'].includes(platform)) {
    return new Response(JSON.stringify({ error: 'invalid_platform' }), { status: 400, headers });
  }
  const client = resolveGoogleClient(env, platform);
  if (!client) {
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers });
  }
  if (capability === 'drive-readonly' && !delegatedDriveConfigured(env)) {
    return new Response(JSON.stringify({ error: 'drive_session_not_configured' }), { status: 501, headers });
  }
  if (capability === 'gmail-readonly' && !delegatedDriveConfigured(env)) {
    return new Response(JSON.stringify({ error: 'gmail_session_not_configured' }), { status: 501, headers });
  }
  if (capability === 'google-services' && !delegatedDriveConfigured(env)) {
    return new Response(JSON.stringify({ error: 'google_services_session_not_configured' }), { status: 501, headers });
  }
  if (!code || !codeVerifier || !redirectUri) {
    return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400, headers });
  }
  if (code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code) || redirectUri.length > 2048) {
    return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers });
  }
  // RFC 7636 code_verifier: 43-128 unreserved characters. The clients
  // generate a 43-character base64url verifier; reject malformed requests
  // before forwarding anything to Google.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    return new Response(JSON.stringify({ error: 'invalid_code_verifier' }), { status: 400, headers });
  }
  if (!isAcceptableRedirectUri(redirectUri, platform, env)) {
    return new Response(JSON.stringify({ error: 'invalid_redirect_uri' }), { status: 400, headers });
  }
  if (platform === 'web' && authorizedOrigin) {
    let redirectOrigin = '';
    try { redirectOrigin = new URL(redirectUri).origin; } catch { /* rejected above */ }
    if (redirectOrigin !== authorizedOrigin) {
      return new Response(JSON.stringify({ error: 'origin_redirect_mismatch' }), { status: 403, headers });
    }
  }
  if ((platform === 'android' || platform === 'ios') && authorizedOrigin
    && !configuredGoogleNativeOrigins(env).includes(authorizedOrigin)) {
    return new Response(JSON.stringify({ error: 'origin_platform_mismatch' }), { status: 403, headers });
  }

  const tokenParams = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    client_id: client.clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  // Only the Web client type has (and requires) a secret; Android/iOS
  // clients are public and Google rejects a secret param it never issued.
  if (client.clientSecret) tokenParams.set('client_secret', client.clientSecret);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString()
  });
  if (!tokenResponse.ok) {
    // Pass only Google's bounded OAuth error CODE through (useful:
    // invalid_grant = expired/reused code). Never echo an arbitrary response
    // body into client JSON or Worker logs.
    let detail = 'token_exchange_failed';
    try {
      const candidate = (await tokenResponse.json())?.error;
      if (typeof candidate === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(candidate)) detail = candidate;
    } catch { /* keep generic */ }
    console.log(`[auth] google exchange failed status=${tokenResponse.status} error=${detail}`);
    return new Response(JSON.stringify({ error: detail }), { status: 502, headers });
  }
  const tokens = await tokenResponse.json();
  const accessToken = typeof tokens?.access_token === 'string'
    && tokens.access_token.length > 0
    && tokens.access_token.length <= 8192
    && !/[\u0000-\u0020\u007f]/.test(tokens.access_token)
    ? tokens.access_token
    : null;
  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'token_exchange_malformed' }), { status: 502, headers });
  }

  const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!userinfoResponse.ok) {
    console.log(`[auth] google userinfo failed status=${userinfoResponse.status}`);
    return new Response(JSON.stringify({ error: 'userinfo_failed' }), { status: 502, headers });
  }
  const userinfo = await userinfoResponse.json();
  const sub = typeof userinfo?.sub === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(userinfo.sub) ? userinfo.sub : null;
  const email = typeof userinfo?.email === 'string' && userinfo.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(userinfo.email)
    ? userinfo.email
    : null;
  if (!sub || !email) {
    return new Response(JSON.stringify({ error: 'userinfo_malformed' }), { status: 502, headers });
  }
  const name = typeof userinfo.name === 'string' ? userinfo.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : null;
  let picture = null;
  if (typeof userinfo.picture === 'string' && userinfo.picture.length <= 2048) {
    try {
      const parsedPicture = new URL(userinfo.picture);
      if (parsedPicture.protocol === 'https:' && !parsedPicture.username && !parsedPicture.password) picture = parsedPicture.toString();
    } catch { /* optional profile image is dropped */ }
  }
  // Explicitly reconstruct every client-facing object so no Google token can
  // ride along. The ordinary identity flow still drops tokens immediately.
  const profile = { sub, name, email, picture };
  if (capability === 'profile') {
    return new Response(JSON.stringify({ profile }), { status: 200, headers });
  }

  const delegated = capability === 'drive-readonly'
    ? { requiredScope: DRIVE_SCOPE, errorPrefix: 'drive', sessionScope: 'drive.readonly', prefix: DRIVE_SESSION_PREFIX }
    : (capability === 'gmail-readonly'
      ? { requiredScope: GMAIL_SCOPE, errorPrefix: 'gmail', sessionScope: 'gmail.readonly', prefix: GMAIL_SESSION_PREFIX }
      : { requiredScope: null, errorPrefix: 'google_services', sessionScope: 'google.services', prefix: GOOGLE_SERVICES_SESSION_PREFIX });
  const grantedScopes = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean));
  const serviceScopes = GOOGLE_SERVICE_SCOPES.filter((scope) => grantedScopes.has(scope));
  if (delegated.requiredScope && !grantedScopes.has(delegated.requiredScope)) {
    return new Response(JSON.stringify({ error: `${delegated.errorPrefix}_scope_not_granted` }), { status: 403, headers });
  }
  if (capability === 'google-services' && serviceScopes.length === 0) {
    return new Response(JSON.stringify({ error: 'google_services_scope_not_granted' }), { status: 403, headers });
  }
  try {
    const delegatedSession = await createDelegatedGoogleSession(env, {
      accessToken,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
      expiresIn: Number(tokens.expires_in),
      platform,
      sub,
      origin: typeof authorizedOrigin === 'string' ? authorizedOrigin : null,
      scope: delegated.sessionScope,
      prefix: delegated.prefix,
      grantedScopes: serviceScopes
    });
    return new Response(JSON.stringify(capability === 'drive-readonly'
      ? { profile, driveSession: delegatedSession }
      : (capability === 'gmail-readonly'
        ? { profile, gmailSession: delegatedSession }
        : { profile, googleServicesSession: delegatedSession, grantedScopes: serviceScopes })), { status: 200, headers });
  } catch (error) {
    console.log(`[auth] delegated ${delegated.errorPrefix} session creation failed: ${error?.message || error}`);
    return new Response(JSON.stringify({ error: `${delegated.errorPrefix}_session_unavailable` }), { status: 503, headers });
  }
}

function delegatedDriveConfigured(env) {
  return Boolean(env?.GOOGLE_DRIVE_SESSIONS
    && typeof env.GOOGLE_DRIVE_SESSIONS.get === 'function'
    && typeof env.GOOGLE_DRIVE_SESSIONS.put === 'function'
    && typeof env.GOOGLE_DRIVE_SESSIONS.delete === 'function'
    && typeof env.GOOGLE_DRIVE_SESSION_SECRET === 'string'
    && env.GOOGLE_DRIVE_SESSION_SECRET.length >= 32);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function delegatedSessionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sealDelegatedSession(env, value) {
  const key = await delegatedSessionKey(env.GOOGLE_DRIVE_SESSION_SECRET);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function openDelegatedSession(env, value) {
  if (typeof value !== 'string' || value.length > 16 * 1024) throw new Error('invalid_session_record');
  const [version, ivValue, cipherValue, extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !cipherValue || extra !== undefined) throw new Error('invalid_session_record');
  const iv = base64UrlDecode(ivValue);
  const ciphertext = base64UrlDecode(cipherValue);
  if (iv.byteLength !== 12 || !ciphertext.byteLength) throw new Error('invalid_session_record');
  const key = await delegatedSessionKey(env.GOOGLE_DRIVE_SESSION_SECRET);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  if (!parsed || typeof parsed !== 'object' || typeof parsed.accessToken !== 'string'
    || typeof parsed.platform !== 'string' || typeof parsed.sub !== 'string'
    || !Number.isFinite(parsed.expiresAt) || !Number.isFinite(parsed.sessionExpiresAt)) {
    throw new Error('invalid_session_record');
  }
  return parsed;
}

async function createDelegatedGoogleSession(env, {
  accessToken,
  refreshToken,
  expiresIn,
  platform,
  sub,
  origin,
  scope,
  prefix,
  grantedScopes = []
}) {
  if (!delegatedDriveConfigured(env)) throw new Error('delegated_session_not_configured');
  if (!['drive.readonly', 'gmail.readonly', 'google.services'].includes(scope)
    || ![DRIVE_SESSION_PREFIX, GMAIL_SESSION_PREFIX, GOOGLE_SERVICES_SESSION_PREFIX].includes(prefix)) throw new Error('invalid_delegated_capability');
  const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const sessionExpiresAt = now + DRIVE_SESSION_TTL_SECONDS * 1000;
  const session = {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86_400) : 3600) * 1000,
    sessionExpiresAt,
    platform,
    sub,
    origin,
    scope,
    grantedScopes: Array.isArray(grantedScopes) ? grantedScopes.filter((item) => GOOGLE_SERVICE_SCOPES.includes(item)) : []
  };
  await env.GOOGLE_DRIVE_SESSIONS.put(
    `${prefix}${id}`,
    await sealDelegatedSession(env, session),
    { expirationTtl: DRIVE_SESSION_TTL_SECONDS }
  );
  return { id, expiresAt: new Date(sessionExpiresAt).toISOString(), scope };
}

async function refreshDelegatedGoogleSession(env, id, session, prefix, reconnectError) {
  if (session.expiresAt > Date.now() + 60_000) return session;
  if (!session.refreshToken || session.sessionExpiresAt <= Date.now()) throw new Error(reconnectError);
  const client = resolveGoogleClient(env, session.platform);
  if (!client) throw new Error(reconnectError);
  const params = new URLSearchParams({
    client_id: client.clientId,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token'
  });
  if (client.clientSecret) params.set('client_secret', client.clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!response.ok) throw new Error(reconnectError);
  const tokens = await response.json();
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token
    || tokens.access_token.length > 8192 || /[\u0000-\u0020\u007f]/.test(tokens.access_token)) {
    throw new Error(reconnectError);
  }
  const next = {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token
      ? tokens.refresh_token
      : session.refreshToken,
    expiresAt: Date.now() + (Number(tokens.expires_in) > 0 ? Math.min(Number(tokens.expires_in), 86_400) : 3600) * 1000
  };
  const remainingSeconds = Math.max(60, Math.ceil((next.sessionExpiresAt - Date.now()) / 1000));
  await env.GOOGLE_DRIVE_SESSIONS.put(
    `${prefix}${id}`,
    await sealDelegatedSession(env, next),
    { expirationTtl: remainingSeconds }
  );
  return next;
}

function delegatedSessionId(request, scheme = 'YayraDrive') {
  const authorization = request.headers.get('authorization') || '';
  const escapedScheme = ['YayraGmail', 'YayraServices'].includes(scheme) ? scheme : 'YayraDrive';
  const match = new RegExp(`^${escapedScheme} ([A-Za-z0-9_-]{43})$`).exec(authorization);
  return match ? match[1] : null;
}

async function revokeDelegatedDriveSession(request, headers, env, authorizedOrigin) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  if (!delegatedDriveConfigured(env)) {
    return new Response(JSON.stringify({ error: 'drive_session_not_configured' }), { status: 501, headers });
  }
  const id = delegatedSessionId(request);
  if (!id) return new Response(JSON.stringify({ error: 'drive_session_required' }), { status: 401, headers });

  const key = `${DRIVE_SESSION_PREFIX}${id}`;
  let session;
  try {
    const sealed = await env.GOOGLE_DRIVE_SESSIONS.get(key);
    if (!sealed) return new Response(JSON.stringify({ error: 'drive_reconnect_required' }), { status: 401, headers });
    session = await openDelegatedSession(env, sealed);
  } catch {
    try { await env.GOOGLE_DRIVE_SESSIONS.delete(key); } catch { /* best effort */ }
    return new Response(JSON.stringify({ error: 'drive_session_invalid' }), { status: 401, headers });
  }
  if ((session.origin || null) !== (typeof authorizedOrigin === 'string' ? authorizedOrigin : null)) {
    return new Response(JSON.stringify({ error: 'drive_session_origin_mismatch' }), { status: 403, headers });
  }

  // Invalidate Yayra's opaque capability first. Provider revocation is then
  // best-effort: a Google outage must never leave a supposedly signed-out
  // Yayra session usable. No token or upstream body is returned or logged.
  try { await env.GOOGLE_DRIVE_SESSIONS.delete(key); }
  catch { return new Response(JSON.stringify({ error: 'drive_session_unavailable' }), { status: 503, headers }); }

  const token = session.refreshToken || session.accessToken;
  let providerRevoked = false;
  if (typeof token === 'string' && token) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5_000) : null;
    try {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        ...(controller ? { signal: controller.signal } : {})
      });
      providerRevoked = response.ok;
    } catch { /* local session is already irreversibly revoked */ }
    finally { if (timer) clearTimeout(timer); }
  }
  return new Response(JSON.stringify({ ok: true, providerRevoked }), { status: 200, headers });
}

async function loadDelegatedGmailSession(request, headers, env, authorizedOrigin) {
  if (!delegatedDriveConfigured(env)) {
    return { response: new Response(JSON.stringify({ error: 'gmail_session_not_configured' }), { status: 501, headers }) };
  }
  const id = delegatedSessionId(request, 'YayraGmail');
  if (!id) return { response: new Response(JSON.stringify({ error: 'gmail_session_required' }), { status: 401, headers }) };
  const key = `${GMAIL_SESSION_PREFIX}${id}`;
  try {
    const sealed = await env.GOOGLE_DRIVE_SESSIONS.get(key);
    if (!sealed) return { response: new Response(JSON.stringify({ error: 'gmail_reconnect_required' }), { status: 401, headers }) };
    let session = await openDelegatedSession(env, sealed);
    if (session.scope !== 'gmail.readonly' || session.sessionExpiresAt <= Date.now()) throw new Error('gmail_reconnect_required');
    if ((session.origin || null) !== (typeof authorizedOrigin === 'string' ? authorizedOrigin : null)) {
      return { response: new Response(JSON.stringify({ error: 'gmail_session_origin_mismatch' }), { status: 403, headers }) };
    }
    session = await refreshDelegatedGoogleSession(env, id, session, GMAIL_SESSION_PREFIX, 'gmail_reconnect_required');
    return { id, key, session };
  } catch (error) {
    try { await env.GOOGLE_DRIVE_SESSIONS.delete?.(key); } catch { /* optional KV delete */ }
    return { response: new Response(JSON.stringify({ error: error?.message === 'gmail_reconnect_required'
      ? 'gmail_reconnect_required'
      : 'gmail_session_invalid' }), { status: 401, headers }) };
  }
}

async function revokeDelegatedGmailSession(request, headers, env, authorizedOrigin) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  const loaded = await loadDelegatedGmailSession(request, headers, env, authorizedOrigin);
  if (loaded.response) return loaded.response;
  try { await env.GOOGLE_DRIVE_SESSIONS.delete(loaded.key); }
  catch { return new Response(JSON.stringify({ error: 'gmail_session_unavailable' }), { status: 503, headers }); }
  const token = loaded.session.refreshToken || loaded.session.accessToken;
  let providerRevoked = false;
  if (typeof token === 'string' && token) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5_000) : null;
    try {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        ...(controller ? { signal: controller.signal } : {})
      });
      providerRevoked = response.ok;
    } catch { /* local capability is already gone */ }
    finally { if (timer) clearTimeout(timer); }
  }
  return new Response(JSON.stringify({ ok: true, providerRevoked }), { status: 200, headers });
}

async function loadDelegatedGoogleServicesSession(request, headers, env, authorizedOrigin) {
  if (!delegatedDriveConfigured(env)) {
    return { response: new Response(JSON.stringify({ error: 'google_services_session_not_configured' }), { status: 501, headers }) };
  }
  const id = delegatedSessionId(request, 'YayraServices');
  if (!id) return { response: new Response(JSON.stringify({ error: 'google_services_session_required' }), { status: 401, headers }) };
  const key = `${GOOGLE_SERVICES_SESSION_PREFIX}${id}`;
  try {
    const sealed = await env.GOOGLE_DRIVE_SESSIONS.get(key);
    if (!sealed) return { response: new Response(JSON.stringify({ error: 'google_services_reconnect_required' }), { status: 401, headers }) };
    let session = await openDelegatedSession(env, sealed);
    if (session.scope !== 'google.services' || session.sessionExpiresAt <= Date.now()) throw new Error('google_services_reconnect_required');
    if ((session.origin || null) !== (typeof authorizedOrigin === 'string' ? authorizedOrigin : null)) {
      return { response: new Response(JSON.stringify({ error: 'google_services_session_origin_mismatch' }), { status: 403, headers }) };
    }
    session = await refreshDelegatedGoogleSession(env, id, session, GOOGLE_SERVICES_SESSION_PREFIX, 'google_services_reconnect_required');
    return { id, key, session };
  } catch (error) {
    try { await env.GOOGLE_DRIVE_SESSIONS.delete?.(key); } catch { /* optional KV delete */ }
    return { response: new Response(JSON.stringify({ error: error?.message === 'google_services_reconnect_required'
      ? 'google_services_reconnect_required'
      : 'google_services_session_invalid' }), { status: 401, headers }) };
  }
}

async function revokeDelegatedGoogleServicesSession(request, headers, env, authorizedOrigin) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  const loaded = await loadDelegatedGoogleServicesSession(request, headers, env, authorizedOrigin);
  if (loaded.response) return loaded.response;
  try { await env.GOOGLE_DRIVE_SESSIONS.delete(loaded.key); }
  catch { return new Response(JSON.stringify({ error: 'google_services_session_unavailable' }), { status: 503, headers }); }
  const token = loaded.session.refreshToken || loaded.session.accessToken;
  let providerRevoked = false;
  if (typeof token === 'string' && token) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5_000) : null;
    try {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        ...(controller ? { signal: controller.signal } : {})
      });
      providerRevoked = response.ok;
    } catch { /* local capability is already gone */ }
    finally { if (timer) clearTimeout(timer); }
  }
  return new Response(JSON.stringify({ ok: true, providerRevoked }), { status: 200, headers });
}

async function getDelegatedGoogleServiceItems(request, url, headers, env, authorizedOrigin) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  const serviceId = String(url.searchParams.get('service') || '');
  if (!GOOGLE_SERVICE_IDS.has(serviceId)) {
    return new Response(JSON.stringify({ error: 'invalid_google_service' }), { status: 400, headers });
  }
  const service = googleServiceById(serviceId);
  if (!service?.api) {
    return new Response(JSON.stringify({ ok: true, service: serviceId, items: [], count: 0, truncated: false }), { status: 200, headers });
  }
  const loaded = await loadDelegatedGoogleServicesSession(request, headers, env, authorizedOrigin);
  if (loaded.response) return loaded.response;
  const grantedScopes = Array.isArray(loaded.session.grantedScopes) ? loaded.session.grantedScopes : [];
  if (service.scope && !grantedScopes.includes(service.scope)) {
    return new Response(JSON.stringify({ error: 'service_scope_required', scope: service.scope }), { status: 403, headers });
  }
  const apiUrl = googleServiceApiUrl(serviceId, Date.now());
  if (!apiUrl) return new Response(JSON.stringify({ error: 'invalid_google_service' }), { status: 400, headers });
  let response;
  try {
    response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${loaded.session.accessToken}`, Accept: 'application/json' }
    });
  } catch {
    return new Response(JSON.stringify({ error: 'google_service_upstream_unavailable' }), { status: 502, headers });
  }
  if (!response.ok) {
    const authExpired = response.status === 401;
    const permissionDenied = response.status === 403;
    return new Response(JSON.stringify({ error: authExpired
      ? 'google_services_reconnect_required'
      : (permissionDenied ? 'google_service_permission_denied' : 'google_service_upstream_failed') }), {
      status: authExpired ? 401 : (permissionDenied ? 403 : 502),
      headers
    });
  }
  let payload;
  try { payload = await readBoundedUpstreamJson(response, 1024 * 1024, 'google_service_response_too_large'); }
  catch { return new Response(JSON.stringify({ error: 'google_service_response_invalid' }), { status: 502, headers }); }
  const normalized = normalizeGoogleServiceItems(serviceId, payload);
  return new Response(JSON.stringify({ ok: true, service: serviceId, ...normalized }), { status: 200, headers });
}

async function readBoundedUpstreamJson(response, maxBytes, errorCode = 'upstream_response_too_large') {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 0 || declared > maxBytes)) throw new Error(errorCode);
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(errorCode);
    try { return JSON.parse(text); } catch { throw new Error(errorCode); }
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    total += chunk.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(errorCode); } catch { /* best effort */ }
      throw new Error(errorCode);
    }
    chunks.push(chunk);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(combined)); }
  catch { throw new Error(errorCode); }
}

function cleanGmailText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength);
}

function gmailHeaders(payload) {
  const values = new Map();
  for (const header of Array.isArray(payload?.headers) ? payload.headers : []) {
    const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
    if (['subject', 'from', 'to', 'date'].includes(name) && !values.has(name)) {
      values.set(name, cleanGmailText(header.value, name === 'subject' ? 998 : 2000));
    }
  }
  return {
    subject: values.get('subject') || '(no subject)',
    from: values.get('from') || '',
    to: values.get('to') || '',
    date: values.get('date') || ''
  };
}

function normalizeGmailMetadata(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id)) return null;
  return {
    id: value.id,
    threadId: typeof value.threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.threadId)
      ? value.threadId
      : value.id,
    labelIds: (Array.isArray(value.labelIds) ? value.labelIds : [])
      .filter((label) => typeof label === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(label))
      .slice(0, 50),
    snippet: cleanGmailText(value.snippet, 1000),
    internalDate: typeof value.internalDate === 'string' && /^\d{1,20}$/.test(value.internalDate) ? value.internalDate : null,
    headers: gmailHeaders(value.payload)
  };
}

function decodeGmailPart(value) {
  if (typeof value !== 'string' || !value || value.length > GMAIL_BODY_MAX_CHARS * 2
    || !/^[A-Za-z0-9_-]+$/.test(value)) return '';
  try {
    return new TextDecoder().decode(base64UrlDecode(value)).replace(/\u0000/g, '').slice(0, GMAIL_BODY_MAX_CHARS);
  } catch {
    return '';
  }
}

function gmailBodyText(payload) {
  let plain = '';
  let html = '';
  const visit = (part, depth = 0) => {
    if (!part || depth > 20 || plain) return;
    const decoded = decodeGmailPart(part?.body?.data);
    const mime = String(part?.mimeType || '').toLowerCase();
    if (decoded && mime === 'text/plain') plain = decoded;
    else if (decoded && mime === 'text/html' && !html) html = decoded;
    for (const child of Array.isArray(part?.parts) ? part.parts.slice(0, 200) : []) visit(child, depth + 1);
  };
  visit(payload);
  if (plain) return cleanGmailText(plain, GMAIL_BODY_MAX_CHARS);
  return cleanGmailText(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), GMAIL_BODY_MAX_CHARS);
}

async function listDelegatedGmailMessages(request, url, headers, env, authorizedOrigin) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  const maxResults = Number(url.searchParams.get('maxResults') || 25);
  const query = url.searchParams.get('q') || '';
  const pageToken = url.searchParams.get('pageToken') || '';
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 30
    || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)
    || (pageToken && !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(pageToken))) {
    return new Response(JSON.stringify({ error: 'invalid_gmail_list_request' }), { status: 400, headers });
  }
  const loaded = await loadDelegatedGmailSession(request, headers, env, authorizedOrigin);
  if (loaded.response) return loaded.response;
  const authHeaders = { Authorization: `Bearer ${loaded.session.accessToken}`, Accept: 'application/json' };
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query) params.set('q', query);
  if (pageToken) params.set('pageToken', pageToken);
  let response;
  try { response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: authHeaders }); }
  catch { return new Response(JSON.stringify({ error: 'gmail_upstream_unavailable' }), { status: 502, headers }); }
  if (!response.ok) {
    return new Response(JSON.stringify({ error: response.status === 401 || response.status === 403
      ? 'gmail_reconnect_required'
      : 'gmail_list_failed' }), { status: response.status === 401 || response.status === 403 ? 401 : 502, headers });
  }
  let list;
  try { list = await readBoundedUpstreamJson(response, 256 * 1024, 'gmail_response_too_large'); } catch { list = null; }
  if (!list || typeof list !== 'object') return new Response(JSON.stringify({ error: 'gmail_response_malformed' }), { status: 502, headers });
  const ids = (Array.isArray(list.messages) ? list.messages : [])
    .map((message) => message?.id)
    .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id))
    .slice(0, maxResults);
  const messages = (await Promise.all(ids.map(async (id) => {
    const detailParams = new URLSearchParams({ format: 'metadata' });
    for (const name of ['Subject', 'From', 'To', 'Date']) detailParams.append('metadataHeaders', name);
    try {
      const detail = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${detailParams}`, { headers: authHeaders });
      return detail.ok
        ? normalizeGmailMetadata(await readBoundedUpstreamJson(detail, 256 * 1024, 'gmail_response_too_large'))
        : null;
    } catch { return null; }
  }))).filter(Boolean);
  const nextPageToken = typeof list.nextPageToken === 'string' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(list.nextPageToken)
    ? list.nextPageToken
    : null;
  const resultSizeEstimate = Number.isSafeInteger(Number(list.resultSizeEstimate))
    ? Math.max(0, Number(list.resultSizeEstimate))
    : null;
  return new Response(JSON.stringify({ messages, nextPageToken, resultSizeEstimate }), { status: 200, headers });
}

async function getDelegatedGmailMessage(request, url, headers, env, authorizedOrigin) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  const id = url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    return new Response(JSON.stringify({ error: 'invalid_gmail_message_id' }), { status: 400, headers });
  }
  const loaded = await loadDelegatedGmailSession(request, headers, env, authorizedOrigin);
  if (loaded.response) return loaded.response;
  let response;
  try {
    response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {
      headers: { Authorization: `Bearer ${loaded.session.accessToken}`, Accept: 'application/json' }
    });
  } catch {
    return new Response(JSON.stringify({ error: 'gmail_upstream_unavailable' }), { status: 502, headers });
  }
  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 401 : 502;
    return new Response(JSON.stringify({ error: status === 404
      ? 'gmail_message_not_found'
      : (status === 401 ? 'gmail_reconnect_required' : 'gmail_message_failed') }), { status, headers });
  }
  let value;
  try { value = await readBoundedUpstreamJson(response, 6 * 1024 * 1024, 'gmail_response_too_large'); } catch { value = null; }
  const metadata = normalizeGmailMetadata(value);
  if (!metadata) return new Response(JSON.stringify({ error: 'gmail_response_malformed' }), { status: 502, headers });
  const message = { ...metadata, bodyText: gmailBodyText(value.payload), bodyTruncated: false };
  return new Response(JSON.stringify({ message }), { status: 200, headers });
}

function safeDownloadFilename(value, fallback = 'Google Drive download') {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 180);
  return clean || fallback;
}

const GOOGLE_WORKSPACE_EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx'
  },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', extension: '.pdf' }
});

function boundedDriveBody(body, maxBytes = DRIVE_MAX_FILE_BYTES) {
  const reader = body?.getReader?.();
  if (!reader) return body;
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel('drive_file_too_large'); } catch { /* best effort */ }
          controller.error(new Error('drive_file_too_large'));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* best effort */ }
    }
  });
}

async function downloadDelegatedDriveFile(request, url, headers, env, authorizedOrigin) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  if (!delegatedDriveConfigured(env)) {
    return new Response(JSON.stringify({ error: 'drive_session_not_configured' }), { status: 501, headers });
  }
  const id = delegatedSessionId(request);
  const fileId = url.searchParams.get('fileId') || '';
  if (!id) return new Response(JSON.stringify({ error: 'drive_session_required' }), { status: 401, headers });
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
    return new Response(JSON.stringify({ error: 'invalid_file_id' }), { status: 400, headers });
  }

  const key = `${DRIVE_SESSION_PREFIX}${id}`;
  let session;
  try {
    const sealed = await env.GOOGLE_DRIVE_SESSIONS.get(key);
    if (!sealed) return new Response(JSON.stringify({ error: 'drive_reconnect_required' }), { status: 401, headers });
    session = await openDelegatedSession(env, sealed);
    if (session.sessionExpiresAt <= Date.now()) throw new Error('drive_reconnect_required');
    if ((session.origin || null) !== (typeof authorizedOrigin === 'string' ? authorizedOrigin : null)) {
      return new Response(JSON.stringify({ error: 'drive_session_origin_mismatch' }), { status: 403, headers });
    }
    session = await refreshDelegatedGoogleSession(env, id, session, DRIVE_SESSION_PREFIX, 'drive_reconnect_required');
  } catch (error) {
    try { await env.GOOGLE_DRIVE_SESSIONS.delete?.(key); } catch { /* optional KV delete */ }
    return new Response(JSON.stringify({ error: error?.message === 'drive_reconnect_required'
      ? 'drive_reconnect_required'
      : 'drive_session_invalid' }), { status: 401, headers });
  }

  const authHeaders = { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' };
  const metadataUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,capabilities%28canDownload%29&supportsAllDrives=true`;
  let metadataResponse;
  try { metadataResponse = await fetch(metadataUrl, { headers: authHeaders }); }
  catch { return new Response(JSON.stringify({ error: 'drive_upstream_unavailable' }), { status: 502, headers }); }
  if (!metadataResponse.ok) {
    const status = metadataResponse.status === 404 ? 404 : metadataResponse.status === 403 ? 403 : 502;
    return new Response(JSON.stringify({ error: status === 404 ? 'drive_file_not_found' : status === 403 ? 'drive_file_not_downloadable' : 'drive_upstream_failed' }), { status, headers });
  }
  let metadata;
  try { metadata = await metadataResponse.json(); } catch { metadata = null; }
  if (!metadata || metadata.capabilities?.canDownload === false) {
    return new Response(JSON.stringify({ error: 'drive_file_not_downloadable' }), { status: 403, headers });
  }
  const declaredSize = Number(metadata.size);
  if (Number.isFinite(declaredSize) && declaredSize > DRIVE_MAX_FILE_BYTES) {
    return new Response(JSON.stringify({ error: 'drive_file_too_large' }), { status: 413, headers });
  }

  const exportInfo = GOOGLE_WORKSPACE_EXPORTS[metadata.mimeType];
  const mediaUrl = exportInfo
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportInfo.mime)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  let mediaResponse;
  try { mediaResponse = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${session.accessToken}` } }); }
  catch { return new Response(JSON.stringify({ error: 'drive_upstream_unavailable' }), { status: 502, headers }); }
  if (!mediaResponse.ok || !mediaResponse.body) {
    return new Response(JSON.stringify({ error: mediaResponse.status === 403 ? 'drive_file_not_downloadable' : 'drive_download_failed' }), {
      status: mediaResponse.status === 403 ? 403 : 502,
      headers
    });
  }
  const upstreamLength = Number(mediaResponse.headers.get('content-length'));
  if (Number.isFinite(upstreamLength) && upstreamLength > DRIVE_MAX_FILE_BYTES) {
    try { await mediaResponse.body.cancel(); } catch { /* best effort */ }
    return new Response(JSON.stringify({ error: 'drive_file_too_large' }), { status: 413, headers });
  }

  let filename = safeDownloadFilename(metadata.name);
  if (exportInfo && !filename.toLowerCase().endsWith(exportInfo.extension)) filename += exportInfo.extension;
  const responseHeaders = {
    ...headers,
    'content-type': exportInfo?.mime || mediaResponse.headers.get('content-type') || 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'private, no-store, max-age=0',
    'x-yayra-drive-fallback': 'delegated'
  };
  if (Number.isFinite(upstreamLength) && upstreamLength >= 0) responseHeaders['content-length'] = String(upstreamLength);
  return new Response(boundedDriveBody(mediaResponse.body), { status: 200, headers: responseHeaders });
}

function readManifest(env) {
  if (!env?.UPDATES_MANIFEST_JSON) return DEFAULT_MANIFEST;
  try {
    return JSON.parse(env.UPDATES_MANIFEST_JSON);
  } catch {
    return DEFAULT_MANIFEST;
  }
}

function baseHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'Accept, Content-Type',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}

function take(key, now) {
  return takeFrom(buckets, key, now, WINDOW_MS, LIMIT);
}

function takeFrom(map, key, now, windowMs, limit) {
  const bucket = map.get(key) || { at: now, count: 0 };
  if (now - bucket.at > windowMs) {
    bucket.at = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  map.set(key, bucket);
  return bucket.count <= limit;
}

async function sha256Etag(body) {
  const data = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}
