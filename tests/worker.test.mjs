import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/update-worker.mjs';

test('update worker serves manifest with cache, cors, etag and HEAD support', async () => {
  const request = new Request('https://yayra-updates-api.g2code335.workers.dev/updates/manifest.json');
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.ok(response.headers.get('etag'));
  const body = await response.json();
  assert.equal(body.schema, 1);
  const head = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/updates/manifest.json', { method: 'HEAD', headers: { 'if-none-match': response.headers.get('etag') } }), {});
  assert.equal(head.status, 304);
});

test('update worker proxies browser-safe suggestions and release metadata with CORS', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (target, options) => {
    requests.push({ target: String(target), options });
    if (String(target).includes('suggestqueries.google.com')) {
      return new Response(JSON.stringify(['gha', ['ghana', 'ghana news']]), { status: 200 });
    }
    return new Response(JSON.stringify({ tag_name: 'v0.1.8', body: 'release notes' }), { status: 200 });
  };
  try {
    const suggestions = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/suggestions?q=ghana'), {});
    assert.equal(suggestions.status, 200);
    assert.deepEqual(await suggestions.json(), ['gha', ['ghana', 'ghana news']]);
    assert.equal(suggestions.headers.get('access-control-allow-origin'), '*');

    const release = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/latest-release'), {});
    assert.equal(release.status, 200);
    assert.equal((await release.json()).tag_name, 'v0.1.8');
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// GitHub's unauthenticated REST API quota (60 requests/hour) is shared
// across Cloudflare's entire egress IP range, not just this Worker's own
// traffic - it can be exhausted by load this Worker never generated. An
// optional GITHUB_TOKEN binding raises that to the authenticated 5,000/hour
// quota instead; this proves the header is actually attached when present,
// and that we still work (just unauthenticated) when it isn't configured.
test('suggestions endpoint degrades to a valid empty payload when Google suggestions are unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 });
  try {
    const response = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/suggestions?q=long%20query'), {});
    assert.equal(response.status, 200, 'optional suggestion failure is not exposed as a repeated browser 502');
    assert.deepEqual(await response.json(), ['long query', []]);
    assert.equal(response.headers.get('x-yayra-suggestions'), 'fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('update worker attaches GITHUB_TOKEN as a Bearer header when bound, and omits it when not configured', async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (target, options) => {
    seenHeaders.push(options?.headers || {});
    return new Response(JSON.stringify({ tag_name: 'v0.1.9' }), { status: 200 });
  };
  try {
    await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/latest-release'), {});
    assert.equal(seenHeaders[0].Authorization, undefined, 'no token configured -> no Authorization header sent');

    await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/latest-release'), { GITHUB_TOKEN: 'secret-test-token' });
    assert.equal(seenHeaders[1].Authorization, 'Bearer secret-test-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The edge Cache API layer is the primary defense against GitHub's shared
// rate limit: once a response is cached, repeat requests for the same
// upstream URL never leave the Worker, regardless of how many different
// client IPs are asking. Node has no global `caches`, so this installs a
// minimal in-memory stand-in to prove the integration is wired correctly
// (cache.match consulted first, cache.put called on a real upstream MISS).
test('update worker serves a cached response on a repeat request instead of re-hitting the upstream API', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ tag_name: 'v0.1.9' }), { status: 200 });
  };
  globalThis.caches = { default: makeFakeEdgeCache() };
  try {
    const first = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/latest-release'), {});
    assert.equal(first.headers.get('x-yayra-cache'), 'MISS');
    assert.equal(upstreamCalls, 1);

    const second = await worker.fetch(new Request('https://yayra-updates-api.g2code335.workers.dev/api/latest-release'), {});
    assert.equal(second.headers.get('x-yayra-cache'), 'HIT');
    assert.equal(upstreamCalls, 1, 'the second request must be served from the edge cache, not a new upstream call');
    assert.equal((await second.json()).tag_name, 'v0.1.9');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

// --- /auth/google/exchange (Web/PWA sign-in, server-side half) -----------
// The browser half (src/services/googleAuthWeb.js) never sees a client
// secret or a token; these tests prove the Worker holds up its side of that
// contract: secret attached server-side only, profile-only response, and
// honest errors when unconfigured or when Google rejects the code.

const EXCHANGE_URL = 'https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange';
const AUTH_ENV = { GOOGLE_WEB_CLIENT_ID: 'web-id.apps.googleusercontent.com', GOOGLE_WEB_CLIENT_SECRET: 'server-side-secret' };
const VALID_CODE_VERIFIER = 'A'.repeat(43);

function exchangeRequest(body, method = 'POST') {
  return new Request(EXCHANGE_URL, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

test('auth exchange returns 501 not_configured when the Google client bindings are missing', async () => {
  const response = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'https://yayra.pages.dev/auth/callback' }), {});
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, 'not_configured');
});

test('auth exchange only accepts POST and rejects malformed bodies before touching Google', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not reach upstream'); };
  try {
    const get = await worker.fetch(new Request(EXCHANGE_URL), AUTH_ENV);
    assert.equal(get.status, 405);

    const badJson = await worker.fetch(new Request(EXCHANGE_URL, { method: 'POST', body: 'not json' }), AUTH_ENV);
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    const missing = await worker.fetch(exchangeRequest({ code: 'c' }), AUTH_ENV);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'missing_fields');

    const badUri = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'http://evil.example/cb' }), AUTH_ENV);
    assert.equal(badUri.status, 400);
    assert.equal((await badUri.json()).error, 'invalid_redirect_uri');

    const badCallbackPath = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'https://yayra.pages.dev/not-callback' }), AUTH_ENV);
    assert.equal(badCallbackPath.status, 400);
    assert.equal((await badCallbackPath.json()).error, 'invalid_redirect_uri');

    const untrustedOrigin = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'https://attacker.example/auth/callback' }), AUTH_ENV);
    assert.equal(untrustedOrigin.status, 400);
    assert.equal((await untrustedOrigin.json()).error, 'invalid_redirect_uri');

    const badVerifier = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: 'short', redirectUri: 'https://yayra.pages.dev/auth/callback' }), AUTH_ENV);
    assert.equal(badVerifier.status, 400);
    assert.equal((await badVerifier.json()).error, 'invalid_code_verifier');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auth exchange attaches the client secret server-side, forwards PKCE verifier, and returns ONLY the profile', async () => {
  const originalFetch = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (target, options) => {
    upstream.push({ target: String(target), options });
    if (String(target).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.secret', id_token: 'jwt.secret', refresh_token: 'should-not-exist' }), { status: 200 });
    }
    return new Response(JSON.stringify({ sub: '42', name: 'Ama Mensah', email: 'ama@example.com', picture: 'https://lh3.googleusercontent.com/a/p', email_verified: true }), { status: 200 });
  };
  try {
    const response = await worker.fetch(exchangeRequest({ code: 'one-shot-code', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'https://yayra.pages.dev/auth/callback' }), AUTH_ENV);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const tokenCall = upstream.find((u) => u.target.includes('/token'));
    const params = new URLSearchParams(tokenCall.options.body);
    assert.equal(params.get('code'), 'one-shot-code');
    assert.equal(params.get('code_verifier'), VALID_CODE_VERIFIER);
    assert.equal(params.get('client_secret'), 'server-side-secret');
    assert.equal(params.get('grant_type'), 'authorization_code');

    const userinfoCall = upstream.find((u) => u.target.includes('userinfo'));
    assert.equal(userinfoCall.options.headers.Authorization, 'Bearer ya29.secret');

    const body = await response.json();
    assert.deepEqual(body, { profile: { sub: '42', name: 'Ama Mensah', email: 'ama@example.com', picture: 'https://lh3.googleusercontent.com/a/p' } });
    const raw = JSON.stringify(body);
    for (const needle of ['access_token', 'id_token', 'refresh_token', 'ya29.secret', 'jwt.secret']) {
      assert.equal(raw.includes(needle), false, `response must never contain ${needle}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auth exchange serves Android/iOS clients WITHOUT a secret and accepts only the registered app redirect', async () => {
  const originalFetch = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (target, options) => {
    upstream.push({ target: String(target), options });
    if (String(target).includes('/token')) return new Response(JSON.stringify({ access_token: 'ya29.mobile' }), { status: 200 });
    return new Response(JSON.stringify({ sub: '9', name: 'Kofi', email: 'kofi@example.com', picture: 'p' }), { status: 200 });
  };
  const env = { GOOGLE_ANDROID_CLIENT_ID: 'android-id.apps.googleusercontent.com' };
  try {
    const response = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'com.yayra.app:/oauth2redirect', platform: 'android' }), env);
    assert.equal(response.status, 200);
    const params = new URLSearchParams(upstream[0].options.body);
    assert.equal(params.get('client_id'), 'android-id.apps.googleusercontent.com');
    assert.equal(params.get('client_secret'), null, 'native clients have no secret - Google rejects one it never issued');
    assert.equal(params.get('redirect_uri'), 'com.yayra.app:/oauth2redirect');
    assert.deepEqual(await response.json(), { profile: { sub: '9', name: 'Kofi', email: 'kofi@example.com', picture: 'p' } });

    // The same request without the matching platform binding is honestly unconfigured.
    const unconfigured = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'com.yayra.app:/oauth2redirect', platform: 'ios' }), env);
    assert.equal(unconfigured.status, 501);

    for (const redirectUri of ['com.yayra.app:/oauth2redirect.evil', 'javascript:alert(1)', 'com.attacker.app:/oauth2redirect']) {
      const untrusted = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri, platform: 'android' }), env);
      assert.equal(untrusted.status, 400, redirectUri);
      assert.equal((await untrusted.json()).error, 'invalid_redirect_uri', redirectUri);
    }

    // And a web-platform request must NOT accept a custom-scheme redirect.
    const badScheme = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'com.yayra.app:/oauth2redirect', platform: 'web' }), AUTH_ENV);
    assert.equal(badScheme.status, 400);

    const badPlatform = await worker.fetch(exchangeRequest({ code: 'c', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'com.yayra.app:/x', platform: 'desktop' }), env);
    assert.equal(badPlatform.status, 400);
    assert.equal((await badPlatform.json()).error, 'invalid_platform');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auth exchange passes Google OAuth error codes through without echoing request contents', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code was already redeemed.' }), { status: 400 });
  try {
    const response = await worker.fetch(exchangeRequest({ code: 'reused-code', codeVerifier: VALID_CODE_VERIFIER, redirectUri: 'http://localhost:4173/auth/callback' }), AUTH_ENV);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'invalid_grant');
    assert.equal(JSON.stringify(body).includes('reused-code'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- /api/ai (managed Yayra AI on an NVIDIA key POOL) ---------------------
// The Worker holds MANY NVIDIA keys (10+) and spreads users across them so
// nobody crowds a single key: round-robin start, failover walk, per-key
// cooldown benches. Contract with aiService.js: POST { messages } ->
// { answer }; 501 = not configured; 429 = every key is busy right now.

const AI_URL = 'https://yayra-updates-api.g2code335.workers.dev/api/ai';

function aiRequest(body, ip = '203.0.113.7') {
  return new Request(AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body)
  });
}

const AI_MESSAGES = [
  { role: 'system', content: 'You are Yayra AI.' },
  { role: 'user', content: 'What is the capital of Ghana?' }
];

test('ai route is honestly 501 not_configured until NVIDIA keys are bound', async () => {
  const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }), {});
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, 'not_configured');
});

test('ai route answers through the NVIDIA pool and NEVER leaks a key to the client', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (target, options) => {
    seen.push({ target: String(target), options });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' Accra. ' } }] }), { status: 200 });
  };
  try {
    const env = { NVIDIA_API_KEYS: 'nvapi-answer-a, nvapi-answer-b' };
    const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.21'), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { answer: 'Accra.' });
    assert.equal(JSON.stringify(body).includes('nvapi-'), false, 'response must never contain an API key');

    const call = seen[0];
    assert.ok(call.target.includes('integrate.api.nvidia.com'), 'talks to NVIDIA NIM');
    assert.match(call.options.headers.Authorization, /^Bearer nvapi-answer-/, 'key attached server-side only');
    const upstreamBody = JSON.parse(call.options.body);
    assert.equal(upstreamBody.model, 'moonshotai/kimi-k3', 'Kimi K3 is the default model');
    assert.deepEqual(upstreamBody.messages, AI_MESSAGES);

    // NVIDIA_MODEL overrides the default without code changes.
    const overridden = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.22'), { ...env, NVIDIA_MODEL: 'meta/llama-3.3-70b-instruct' });
    assert.equal(overridden.status, 200);
    assert.equal(JSON.parse(seen.at(-1).options.body).model, 'meta/llama-3.3-70b-instruct');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('key pool merges NVIDIA_API_KEYS list + numbered NVIDIA_API_KEY_n secrets (10+ keys) and dedupes', async () => {
  const originalFetch = globalThis.fetch;
  const usedKeys = new Set();
  // Every key is rate-limited except the very last numbered one, so the
  // failover walk must discover keys from BOTH binding styles.
  globalThis.fetch = async (target, options) => {
    const key = options.headers.Authorization.replace('Bearer ', '');
    usedKeys.add(key);
    if (key === 'nvapi-pool-12') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'from key 12' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
  };
  try {
    // 12 keys total: 10 in the list secret (one is a duplicate of a
    // numbered one) + 3 numbered - duplicate collapses to 12 unique.
    const env = {
      NVIDIA_API_KEYS: 'nvapi-pool-1,nvapi-pool-2,nvapi-pool-3,nvapi-pool-4,nvapi-pool-5\nnvapi-pool-6 nvapi-pool-7,nvapi-pool-8,nvapi-pool-9,nvapi-pool-10',
      NVIDIA_API_KEY_1: 'nvapi-pool-10', // duplicate - must not double-count
      NVIDIA_API_KEY_2: 'nvapi-pool-11',
      NVIDIA_API_KEY_3: 'nvapi-pool-12'
    };
    // Keep asking until the walk lands on the good key (benching removes
    // 429'd keys from later walks, so this converges fast).
    let answer = null;
    for (let i = 0; i < 12 && !answer; i += 1) {
      const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.33'), env);
      if (response.status === 200) answer = (await response.json()).answer;
    }
    assert.equal(answer, 'from key 12', 'failover reached the one healthy key');
    // NOTE: the rotor's start index is RANDOM per isolate (good production
    // behaviour - it spreads simultaneous users across keys), so the walk
    // may legitimately reach the healthy key in a single step when the
    // random start lands on it. What must ALWAYS hold here: only keys from
    // the configured bindings are ever used. (An old `usedKeys.size >= 2`
    // assertion here made this test fail ~1 run in 12 purely by chance -
    // it flipped the release build. The merge/dedupe count is proven
    // deterministically below instead.)
    for (const k of usedKeys) assert.match(k, /^nvapi-pool-\d+$/, 'only configured keys ever used');

    // DETERMINISTIC merge + dedupe proof: a fresh key set (fresh bench
    // state - keyBench is module-level), every key 429s, and enough
    // requests for the 5-attempt walk + benching to sweep the ENTIRE
    // pool. Exactly 12 distinct keys must be tried: 13 would mean the
    // duplicate was not deduped; fewer would mean a binding was dropped.
    const seenAll = new Set();
    globalThis.fetch = async (target, options) => {
      seenAll.add(options.headers.Authorization.replace('Bearer ', ''));
      return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
    };
    const env2 = {
      NVIDIA_API_KEYS: 'nvapi-merge-1,nvapi-merge-2,nvapi-merge-3,nvapi-merge-4,nvapi-merge-5\nnvapi-merge-6 nvapi-merge-7,nvapi-merge-8,nvapi-merge-9,nvapi-merge-10',
      NVIDIA_API_KEY_1: 'nvapi-merge-10', // duplicate - must collapse
      NVIDIA_API_KEY_2: 'nvapi-merge-11',
      NVIDIA_API_KEY_3: 'nvapi-merge-12'
    };
    for (let i = 0; i < 8; i += 1) {
      await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.34'), env2);
    }
    assert.equal(seenAll.size, 12, 'exactly the 12 unique merged keys exist (both binding styles, duplicate deduped)');
    for (const k of seenAll) assert.match(k, /^nvapi-merge-\d+$/, 'only configured keys ever used');
    assert.ok(seenAll.has('nvapi-merge-11') && seenAll.has('nvapi-merge-12'), 'numbered bindings are part of the pool');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ai route spreads consecutive requests across DIFFERENT keys (round-robin, no crowding)', async () => {
  const originalFetch = globalThis.fetch;
  const keysPerRequest = [];
  globalThis.fetch = async (target, options) => {
    keysPerRequest.push(options.headers.Authorization.replace('Bearer ', ''));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const env = { NVIDIA_API_KEYS: 'nvapi-rr-1,nvapi-rr-2,nvapi-rr-3,nvapi-rr-4' };
    for (let i = 0; i < 4; i += 1) {
      const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.44'), env);
      assert.equal(response.status, 200);
    }
    assert.equal(new Set(keysPerRequest).size, 4,
      `4 consecutive requests used 4 different keys (got ${keysPerRequest.join(', ')}) - users never pile on one key`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('EVERY key can carry ITS OWN model: NVIDIA_MODEL_n next to NVIDIA_API_KEY_n, or inline key@model', async () => {
  const originalFetch = globalThis.fetch;
  const modelByKey = new Map();
  globalThis.fetch = async (target, options) => {
    const key = options.headers.Authorization.replace('Bearer ', '');
    modelByKey.set(key, JSON.parse(options.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const env = {
      // Inline style inside the list secret: key@model.
      NVIDIA_API_KEYS: 'nvapi-pk-list1@meta/llama-3.3-70b-instruct, nvapi-pk-list2',
      // Numbered style: NVIDIA_MODEL_n pairs with NVIDIA_API_KEY_n.
      NVIDIA_API_KEY_1: 'nvapi-pk-num1',
      NVIDIA_MODEL_1: 'deepseek-ai/deepseek-v3.2',
      NVIDIA_API_KEY_2: 'nvapi-pk-num2' // no model -> pool default
    };
    // Round-robin spreads consecutive requests over all 4 keys.
    for (let i = 0; i < 4; i += 1) {
      const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.66'), env);
      assert.equal(response.status, 200);
    }
    assert.equal(modelByKey.get('nvapi-pk-list1'), 'meta/llama-3.3-70b-instruct', 'inline key@model respected');
    assert.equal(modelByKey.get('nvapi-pk-num1'), 'deepseek-ai/deepseek-v3.2', 'NVIDIA_MODEL_1 pairs with NVIDIA_API_KEY_1');
    assert.equal(modelByKey.get('nvapi-pk-list2'), 'moonshotai/kimi-k3', 'keys without their own model fall back to the default');
    assert.equal(modelByKey.get('nvapi-pk-num2'), 'moonshotai/kimi-k3', 'numbered key without NVIDIA_MODEL_n falls back too');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SPEED: ai route STREAMS - {stream:true} pipes NVIDIA SSE tokens straight through as text/event-stream', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  const sse = [
    'data: {"choices":[{"delta":{"content":"Acc"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ra"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  globalThis.fetch = async (target, options) => {
    upstreamBody = JSON.parse(options.body);
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of sse) controller.enqueue(enc.encode(chunk));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const env = { NVIDIA_API_KEYS: 'nvapi-stream-key' };
    const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES, stream: true }, '203.0.113.77'), env);
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.stream, true, 'upstream request asks NVIDIA to stream');
    assert.equal(response.headers.get('content-type').includes('text/event-stream'), true, 'SSE reaches the client');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text, sse.join(''), 'tokens pass through UNBUFFERED and untouched');
    assert.equal(text.includes('nvapi-stream-key'), false, 'key never leaks into the stream');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SPEED: without {stream:true} the buffered JSON contract is unchanged (old clients keep working)', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (target, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Accra' } }] }), { status: 200 });
  };
  try {
    const response = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.78'), { NVIDIA_API_KEYS: 'nvapi-k' });
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.stream, false, 'non-stream clients get a non-stream upstream call');
    assert.equal((await response.json()).answer, 'Accra');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SPEED: reasoning models (Kimi K3) get reasoning_effort "low" + a 4096 token budget so thinking never starves or stalls the answer', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (target, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    // Default model (kimi-k3) -> reasoning model -> low effort by default.
    const r1 = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.81'), { NVIDIA_API_KEYS: 'nvapi-r1' });
    assert.equal(r1.status, 200);
    assert.equal(bodies[0].model, 'moonshotai/kimi-k3');
    assert.equal(bodies[0].reasoning_effort, 'low', 'reasoning models default to low effort = fast answers');
    assert.equal(bodies[0].max_tokens, 4096, 'budget big enough that thinking cannot starve the answer');

    // Non-reasoning model -> NO reasoning_effort key at all (strict
    // OpenAI-compatible servers reject unknown parameters).
    const r2 = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.82'), { NVIDIA_API_KEYS: 'nvapi-r2', NVIDIA_MODEL: 'meta/llama-3.3-70b-instruct' });
    assert.equal(r2.status, 200);
    assert.equal('reasoning_effort' in bodies[1], false, 'non-reasoning models get no reasoning_effort key');

    // Operator overrides, no code changes: effort level and token budget.
    const r3 = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.83'), { NVIDIA_API_KEYS: 'nvapi-r3', NVIDIA_REASONING_EFFORT: 'max', NVIDIA_MAX_TOKENS: '16384' });
    assert.equal(r3.status, 200);
    assert.equal(bodies[2].reasoning_effort, 'max');
    assert.equal(bodies[2].max_tokens, 16384);

    // NVIDIA_REASONING_EFFORT=off sends nothing even for reasoning models.
    const r4 = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.84'), { NVIDIA_API_KEYS: 'nvapi-r4', NVIDIA_REASONING_EFFORT: 'off' });
    assert.equal(r4.status, 200);
    assert.equal('reasoning_effort' in bodies[3], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ai route validates input and reports honest statuses: 405, 400s, 429 when every key is busy', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'busy' }), { status: 429 });
  try {
    const env = { NVIDIA_API_KEYS: 'nvapi-busy-1,nvapi-busy-2' };

    const get = await worker.fetch(new Request(AI_URL, { headers: { 'cf-connecting-ip': '203.0.113.55' } }), env);
    assert.equal(get.status, 405);

    const badJson = await worker.fetch(new Request(AI_URL, { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.55' }, body: 'not json' }), env);
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    const noMessages = await worker.fetch(aiRequest({ messages: [] }, '203.0.113.55'), env);
    assert.equal(noMessages.status, 400);
    assert.equal((await noMessages.json()).error, 'invalid_messages');

    const badRole = await worker.fetch(aiRequest({ messages: [{ role: 'tool', content: 'x' }] }, '203.0.113.55'), env);
    assert.equal(badRole.status, 400);

    const allBusy = await worker.fetch(aiRequest({ messages: AI_MESSAGES }, '203.0.113.55'), env);
    assert.equal(allBusy.status, 429, 'every key rate-limited -> client sees rate-limited, never a fake answer');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeFakeEdgeCache() {
  const store = new Map();
  return {
    async match(request) {
      const entry = store.get(request.url);
      if (!entry) return undefined;
      return new Response(entry.body, { status: entry.status, headers: entry.headers });
    },
    async put(request, response) {
      const body = await response.text();
      store.set(request.url, { status: response.status, headers: Object.fromEntries(response.headers), body });
    }
  };
}
