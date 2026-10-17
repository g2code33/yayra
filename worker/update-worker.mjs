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
    if (!['/updates/manifest.json', '/api/suggestions', '/api/latest-release', '/api/ai', '/auth/google/exchange'].includes(url.pathname)) {
      return new Response('not found', { status: 404 });
    }

    const headers = baseHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    if (!take(ip, Date.now())) return new Response('rate limited', { status: 429, headers });

    if (url.pathname === '/api/suggestions') return proxySuggestions(request, url, headers, ctx);
    if (url.pathname === '/api/latest-release') return proxyLatestRelease(request, headers, env, ctx);
    if (url.pathname === '/api/ai') return answerWithNvidiaPool(request, headers, env, ip);
    if (url.pathname === '/auth/google/exchange') return exchangeGoogleAuthCode(request, headers, env);
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
  const configuredOrigins = typeof env.GOOGLE_WEB_ALLOWED_ORIGINS === 'string'
    ? env.GOOGLE_WEB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_GOOGLE_WEB_ALLOWED_ORIGINS;
  return configuredOrigins.includes(redirect.origin);
}

async function exchangeGoogleAuthCode(request, headers, env) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers });
  }
  const code = typeof body?.code === 'string' ? body.code : '';
  const codeVerifier = typeof body?.codeVerifier === 'string' ? body.codeVerifier : '';
  const redirectUri = typeof body?.redirectUri === 'string' ? body.redirectUri : '';
  const platform = typeof body?.platform === 'string' ? body.platform : 'web';
  if (!['web', 'android', 'ios'].includes(platform)) {
    return new Response(JSON.stringify({ error: 'invalid_platform' }), { status: 400, headers });
  }
  const client = resolveGoogleClient(env, platform);
  if (!client) {
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers });
  }
  if (!code || !codeVerifier || !redirectUri) {
    return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400, headers });
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
    // Pass Google's OAuth error code through (useful: invalid_grant =
    // expired/reused code) but never echo request contents back.
    let detail = 'token_exchange_failed';
    try { detail = (await tokenResponse.json())?.error || detail; } catch { /* keep generic */ }
    console.log(`[auth] google exchange failed status=${tokenResponse.status} error=${detail}`);
    return new Response(JSON.stringify({ error: detail }), { status: 502, headers });
  }
  const tokens = await tokenResponse.json();
  if (!tokens?.access_token) {
    return new Response(JSON.stringify({ error: 'token_exchange_malformed' }), { status: 502, headers });
  }

  const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  if (!userinfoResponse.ok) {
    console.log(`[auth] google userinfo failed status=${userinfoResponse.status}`);
    return new Response(JSON.stringify({ error: 'userinfo_failed' }), { status: 502, headers });
  }
  const userinfo = await userinfoResponse.json();
  // Profile only. Explicitly reconstruct the object so no token-ish field
  // can ever ride along, and drop the tokens on the floor right here.
  const profile = { sub: userinfo.sub, name: userinfo.name, email: userinfo.email, picture: userinfo.picture };
  return new Response(JSON.stringify({ profile }), { status: 200, headers: { ...headers, 'cache-control': 'no-store' } });
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
    'content-type': 'application/json; charset=utf-8'
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
