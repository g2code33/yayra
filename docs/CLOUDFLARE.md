# Cloudflare Pages and API Worker: terminal-only setup

Yayra uses a static Cloudflare Pages project for the frontend and a standalone Cloudflare Worker for the update API. Pages serves `https://yayra.pages.dev`; the Worker serves `https://yayra-updates-api.g2code335.workers.dev/updates/manifest.json`. The setup, first deployment, and GitHub Actions secret configuration can all be run from a terminal. No Cloudflare Pages dashboard project creation or GitHub settings clicks are required.

## 1. Authenticate in the terminal

Use Wrangler if this machine is not authenticated yet:

```bash
npx --yes wrangler@4 login
npx --yes wrangler@4 whoami
```

For the local deploy and GitHub Actions, use a scoped Cloudflare API token with Pages edit/deploy access for the target account. Read the real token into the shell without writing it into this repository:

```bash
read -rsp 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN; echo
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID='fe5831c612073527054235c8d18f8e4c'
export CLOUDFLARE_PROJECT_NAME='yayra'
```

The setup command can discover `CLOUDFLARE_ACCOUNT_ID` when the token has access to exactly one account. Set it explicitly when the token can access more than one account.

## 2. Create, deploy, and configure GitHub Actions from the terminal

Run this from the repository root:

```bash
npm ci
npm run setup:cloudflare
```

The command is idempotent. It will:

1. Create the Pages project if it does not exist, with `main` as its production branch.
2. Build the PWA into `dist/`.
3. Deploy `dist/` to the `main` Pages deployment.
4. Deploy the `yayra-updates-api` Worker from `worker/update-worker.mjs` using `wrangler.worker.toml`.
5. Deploy the Worker to the account workers.dev subdomain shown in the configuration.
6. Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_PROJECT_NAME` as GitHub Actions secrets using `gh`.

If `CLOUDFLARE_API_TOKEN` is not already exported, the Bash wrapper prompts for it with hidden input. The setup command never prints the token or writes it to the repository. It requires GitHub CLI authentication:

```bash
gh auth login
gh auth status
```

To use a different project, export its real Pages project name in the shell before running the setup command; do not write that value into this repository.

## 3. Terminal-only redeploys

After the project exists, a local production deployment deploys both the Pages frontend and the API Worker:

```bash
npm run deploy:cloudflare
```

To deploy only the update API Worker after changing its manifest or code:

```bash
npm run deploy:cloudflare:worker
```

The Worker configuration is committed in `wrangler.worker.toml`; it uses the account workers.dev hostname and injects the built `dist/updates/manifest.json` as the non-secret `UPDATES_MANIFEST_JSON` variable.

The command requires the same three environment variables:

```bash
read -rsp 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN; echo
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID='fe5831c612073527054235c8d18f8e4c'
export CLOUDFLARE_PROJECT_NAME='yayra'
npm run deploy:cloudflare
```

## 3a. Google OAuth and delegated Drive sessions

The Worker is the token-isolation boundary for Web/PWA and Capacitor. Basic
Google sign-in uses `/auth/google/exchange` and returns only a verified profile.
The separately consented Drive fallback stores Google credentials encrypted in
Cloudflare KV and gives the app only an opaque, origin-bound capability for
`/api/drive/download`; `/api/drive/session/revoke` deletes it on logout before
best-effort provider revocation.

Create the applicable OAuth client bindings as Worker secrets (never `[vars]`):

```bash
npx --yes wrangler@4 secret put GOOGLE_WEB_CLIENT_ID --config wrangler.worker.toml
npx --yes wrangler@4 secret put GOOGLE_WEB_CLIENT_SECRET --config wrangler.worker.toml
npx --yes wrangler@4 secret put GOOGLE_ANDROID_CLIENT_ID --config wrangler.worker.toml
npx --yes wrangler@4 secret put GOOGLE_IOS_CLIENT_ID --config wrangler.worker.toml
```

Android/iOS client IDs are public identifiers but are secrets here only to keep
all deployment-specific OAuth configuration out of the repository; native
Google client types do not have client secrets. Omit a platform binding if that
platform is not shipped.

Provision production and preview KV namespaces once:

```bash
npx --yes wrangler@4 kv namespace create GOOGLE_DRIVE_SESSIONS --config wrangler.worker.toml
npx --yes wrangler@4 kv namespace create GOOGLE_DRIVE_SESSIONS --preview --config wrangler.worker.toml
```

Copy the IDs printed by Wrangler into the committed deployment configuration:

```toml
[[kv_namespaces]]
binding = "GOOGLE_DRIVE_SESSIONS"
id = "<production namespace id>"
preview_id = "<preview namespace id>"
```

Namespace IDs identify storage and are safe to commit. KV values are not:
Yayra seals every record with AES-GCM before `put`, applies a 30-day KV TTL,
and binds it to the initiating exact origin. Now generate a distinct encryption
secret directly into Wrangler:

```bash
openssl rand -base64 48 | npx --yes wrangler@4 secret put GOOGLE_DRIVE_SESSION_SECRET --config wrangler.worker.toml
```

The secret must be at least 32 characters. Never reuse an OAuth client secret,
Cloudflare API token, NVIDIA key, or package-signing key. Rotating this value or
deleting the namespace intentionally invalidates every delegated session; users
will be prompted to reconnect. Deploy after adding the binding:

```bash
npm run deploy:cloudflare:worker
```

Verify configuration without revealing secret values:

```bash
npx --yes wrangler@4 kv namespace list
npx --yes wrangler@4 secret list --config wrangler.worker.toml
```

The Drive routes return `501 drive_session_not_configured` unless the KV binding
supports `get`, `put`, and `delete` and the encryption secret is present. This
is intentional fail-closed behavior. Keep
`GOOGLE_WEB_ALLOWED_ORIGINS`/`GOOGLE_NATIVE_ALLOWED_ORIGINS` exact, register
matching callbacks in Google Cloud, and read `docs/GOOGLE_SIGNIN.md` for the
OAuth client matrix, threat model, revocation behavior, and manual tests.

## 3b. Yayra AI: the NVIDIA key pool (`/api/ai`)

The Worker's `/api/ai` route powers the built-in "Ask Yayra AI" (managed mode — users never need their own key). It calls NVIDIA's OpenAI-compatible NIM endpoint (`https://integrate.api.nvidia.com/v1/chat/completions`) using a **pool of many API keys** so users are spread out and never crowd a single key: each request starts at a rotating position in the pool, rate-limited (429) keys are benched for a minute, and dead keys (401/403) are benched for ten.

Create keys at <https://build.nvidia.com> (one per account/project as needed), then bind them as Worker secrets — never in `wrangler.worker.toml`, never in the repo. Two binding styles, usable together, any number of keys:

```bash
# Style 1: the whole pool in ONE secret (comma/space/newline separated)
npx --yes wrangler@4 secret put NVIDIA_API_KEYS --config wrangler.worker.toml
# paste: nvapi-xxx1,nvapi-xxx2,nvapi-xxx3,... (10+ keys recommended)

# Style 2: numbered secrets, added/revoked one at a time
npx --yes wrangler@4 secret put NVIDIA_API_KEY_1 --config wrangler.worker.toml
npx --yes wrangler@4 secret put NVIDIA_API_KEY_2 --config wrangler.worker.toml
# ... up to any NVIDIA_API_KEY_n
```

Both styles are merged and deduplicated. Until at least one key is bound, `/api/ai` honestly returns `501 not_configured` and the app tells users the managed backend is not live — it never fabricates answers.

**Streaming:** POST `{ messages, stream: true }` and `/api/ai` pipes NVIDIA's Server-Sent Events straight through (`text/event-stream`, OpenAI-style `data: {"choices":[{"delta":{"content":"..."}}]}` chunks, `data: [DONE]` terminator) — tokens reach the client the instant the model emits them, which is what makes the in-app AI feel instant. Without `stream: true` the original buffered `{ answer }` JSON contract is unchanged.

**Model selection** — the default is `moonshotai/kimi-k3` (Kimi K3: ~2.8T MoE, 1M context). Three ways to change it, strongest-override first:

1. Edit `NVIDIA_MODEL` under `[vars]` in `wrangler.worker.toml`, then redeploy (`npm run deploy:cloudflare:worker`). This is the committed, visible default.
2. One-off deploy override: `npx wrangler@4 deploy --config wrangler.worker.toml --var NVIDIA_MODEL:moonshotai/kimi-k3`.
3. Live change without any deploy: Cloudflare dashboard → Workers & Pages → `yayra-updates-api` → Settings → Variables → edit `NVIDIA_MODEL` → Save (note: a later `wrangler deploy` re-applies the toml value over a dashboard edit).

Use any model id from <https://build.nvidia.com> (the id shown on the model page, e.g. `moonshotai/kimi-k3`, `meta/llama-3.3-70b-instruct`). `NVIDIA_BASE_URL` can likewise override the endpoint (default: NVIDIA's integrate endpoint).

**Per-key models** — every key in the pool can carry its OWN model; the failover walk automatically speaks each key's model:

```bash
# Numbered style: NVIDIA_MODEL_n pairs with NVIDIA_API_KEY_n.
npx wrangler@4 secret put NVIDIA_API_KEY_1 --config wrangler.worker.toml   # nvapi-xxx
npx wrangler@4 secret put NVIDIA_MODEL_1  --config wrangler.worker.toml    # deepseek-ai/deepseek-v3.2

# List style: append the model inline as key@model.
npx wrangler@4 secret put NVIDIA_API_KEYS --config wrangler.worker.toml
# paste: nvapi-xxx@moonshotai/kimi-k3,nvapi-yyy@meta/llama-3.3-70b-instruct,nvapi-zzz
```

Resolution order per key: its own model (`NVIDIA_MODEL_n` / `key@model`) → the pool-wide `NVIDIA_MODEL` → the built-in default (`moonshotai/kimi-k3`).

**Reasoning speed** — reasoning models (Kimi K3, DeepSeek-R1, …) "think" before answering; unconfigured they think at max effort (tens of seconds before the first visible word) and the thinking consumes the token budget. The worker therefore sends `reasoning_effort: "low"` for reasoning models (fast answers, still smart) and a `max_tokens` budget of 4096 so thinking can never starve the answer. Tune with worker vars, no code changes: `NVIDIA_REASONING_EFFORT` = `low` | `medium` | `high` | `max` | `off` (send nothing), and `NVIDIA_MAX_TOKENS` (e.g. `16384`). Non-reasoning models never get a `reasoning_effort` key.

**Local deploys** don't need `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`: `npm run deploy:cloudflare:worker` falls back to your `wrangler login` session when they're absent (CI still uses the env-var path).

Redeploy the Worker after changing its code (`npm run deploy:cloudflare:worker`); secrets persist across deployments.

## 4. GitHub Actions behavior

Every push to `main` builds the PWA, Android, Linux, and Windows artifacts. When the three Cloudflare secrets are present, the release workflow deploys the exact web bundle from the PWA build job to the Pages `main` branch and deploys `yayra-updates-api` to the account workers.dev hostname. If the secrets are absent, the workflow records a warning instead of falsely claiming that a deployment occurred.

Verify the configured secrets without revealing their values:

```bash
gh secret list --repo "$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
```

Verify the live deployment from the terminal:

```bash
curl --fail --silent --show-error "https://${CLOUDFLARE_PROJECT_NAME}.pages.dev/" >/dev/null
echo 'Cloudflare Pages is reachable'
```

Never commit `.env` files, tokens, private keys, or credentials.
