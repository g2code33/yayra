# Production configuration reference (single source of truth)

Every environment variable, config file, and CI secret a production
deployment of Yayra needs, in one place. If you add a new one, add it here.

Nothing in this file is a secret itself; actual values live in your shell
environment, gitignored local config files, or GitHub Actions secrets.

## 1. Google Sign-In (app-level account feature)

Published desktop builds must provide both desktop OAuth values. Google
Account navigation now intentionally enters Yayra's callback-returning sign-in
loop; releasing without its client configuration would replace a dead provider
page with a deterministic `not_configured` error instead of completing the
priority flow. Release CI therefore treats missing desktop values as a
publishing error (local/machine config remains supported for development).

| Name | Where set | Used by | Notes |
| --- | --- | --- | --- |
| `YAYRA_GOOGLE_CLIENT_ID` | env var (dev) | `electron/googleAuthConfig.cjs` | "Desktop app" OAuth client ID. See `docs/GOOGLE_SIGNIN.md`. |
| `YAYRA_GOOGLE_CLIENT_SECRET` | env var (dev) | `electron/googleAuthConfig.cjs` | Google requires it for Desktop clients even with PKCE; treated as non-confidential per Google's own definition. |
| `electron/google-auth.config.json` | local file (packaged builds) | `electron/googleAuthConfig.cjs` | `{ "clientId": ..., "clientSecret": ... }`. **Gitignored.** |
| `YAYRA_GOOGLE_WEB_CLIENT_ID` | env var (build time) | `scripts/build-web.mjs` → `<meta>` → `src/config/googleAuthWeb.js` | "Web application" OAuth client ID (public by design). |
| `YAYRA_GOOGLE_AUTH_EXCHANGE_URL` | env var (build time, optional) | same | Overrides the Worker exchange endpoint; defaults to the production worker. |
| `google-auth.web.config.json` | local file at repo root (alternative to the env vars) | `scripts/build-web.mjs` | `{ "clientId": ..., "exchangeUrl"?: ... }`. **Gitignored.** |
| `GOOGLE_WEB_CLIENT_ID` / `GOOGLE_WEB_CLIENT_SECRET` | **Worker secrets** (`wrangler secret put`) | `worker/update-worker.mjs` (`/auth/google/exchange`) | The web client's secret lives ONLY here — Google requires it for Web-application clients even with PKCE; it must never appear in web-delivered files. |
| `YAYRA_GOOGLE_ANDROID_CLIENT_ID` / `YAYRA_GOOGLE_IOS_CLIENT_ID` | env vars (build time) or `google-auth.web.config.json` fields `androidClientId`/`iosClientId` | `scripts/build-web.mjs` → `<meta>` → `src/config/googleAuthCapacitor.js` | "Android"/"iOS" OAuth clients have **no secret** (verified by package name + SHA-1 / bundle ID); the IDs ship in the app bundle by design. |
| `GOOGLE_ANDROID_CLIENT_ID` / `GOOGLE_IOS_CLIENT_ID` | Worker bindings | `worker/update-worker.mjs` (`/auth/google/exchange`, `platform: android\|ios`) | Same endpoint as web; secretless exchange for native client types. |
| `GOOGLE_WEB_ALLOWED_ORIGINS` | Worker var | `worker/update-worker.mjs` auth CORS + redirect validation | Exact comma-separated web origins; each must register its exact `/auth/callback`. Never use `*`. |
| `GOOGLE_NATIVE_ALLOWED_ORIGINS` | Worker var | `worker/update-worker.mjs` auth CORS | Exact Capacitor WebView origins (production defaults: `https://localhost,http://localhost,capacitor://localhost`). Never use `*`. |

## 2. Update worker (Cloudflare Worker: `yayra-updates-api`)

| Name | Where set | Used by | Notes |
| --- | --- | --- | --- |
| `UPDATES_MANIFEST_JSON` | Worker binding (wrangler secret/var) | `worker/update-worker.mjs` | Full JSON update manifest; falls back to a built-in default when unset. |
| `GITHUB_TOKEN` | Worker secret | `worker/update-worker.mjs` (`/api/latest-release`) | Raises GitHub API rate limits; read-only PAT with no scopes is sufficient. |
| `UPDATE_MANIFEST_URL` | build-time env | `scripts/build-web.mjs` / `src/config/updates.js` | Points clients at your worker's `/updates/manifest.json`. |

### Update-artifact signature pinning (recommended once a Linux key exists)

`UpdateService` accepts an `updatePublicKey` option (SPKI public-key PEM —
the `linux-signing-public-key.pem` that `scripts/sign-linux-artifacts.mjs`
publishes alongside release artifacts). When configured, every downloaded
update must carry a valid detached RSA-SHA256 signature (embedded in the
manifest as `downloads.<target>.sig` by `scripts/generate-update-manifest.mjs`)
and the client **fails closed** on a missing or invalid signature — this
protects against a compromised manifest host, which plain sha256 cannot.
Wiring the real key into app startup is a deliberate human step: generate
the key per `docs/SIGNING_REQUIREMENTS.md`, commit the *public* PEM, and
pass it where the app constructs its `UpdateService`. Until then, clients
verify sha256 + byte length only (unchanged behavior).

## 3. Cloudflare deployment

| Name | Where set | Used by |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | env / GH Actions secret | `scripts/deploy-cloudflare.mjs`, `scripts/deploy-cloudflare-worker.mjs`, `release.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | env / GH Actions secret | same |
| `CLOUDFLARE_PROJECT_NAME` | env (optional) | `scripts/deploy-cloudflare.mjs` (Pages project) |
| `CLOUDFLARE_WORKER_NAME` | env (optional) | `scripts/deploy-cloudflare-worker.mjs` (defaults to `wrangler.worker.toml` name) |

## 4. Release signing (GitHub Actions secrets consumed by `release.yml`)

See `docs/SIGNING_REQUIREMENTS.md` (Phase B5) for how a human obtains each
credential. None of these may ever be committed.

| Platform | Secrets |
| --- | --- |
| Linux | `LINUX_SIGNING_KEY` (OpenSSL RSA/EC private key PEM, raw or base64-encoded — consumed by `scripts/sign-linux-artifacts.mjs` via `openssl dgst -sha256 -sign`), optional `LINUX_SIGNING_KEY_PASSWORD` passphrase |
| Windows | `WINDOWS_CERTIFICATE_PATH`/`WINDOWS_CERTIFICATE_PASSWORD` (Authenticode PFX) |
| Android | `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEYSTORE_TYPE`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (via `scripts/configure-android-signing.mjs`) |
| macOS / iOS | `APPLE_TEAM_ID`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_AUTH_KEY_PATH`, `APPLE_KEYCHAIN_PATH`/`KEYCHAIN_PASSWORD`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` |
| GitHub | `GH_TOKEN` / `GITHUB_TOKEN` (provided by Actions; used for release feed checks and publishing) |

## 5. Build/dev toggles (not secrets)

| Name | Purpose |
| --- | --- |
| `PORT` | `scripts/dev-server.mjs` listen port (default 4173). |
| `BUILT_AT`, `GITHUB_SHA`, `GITHUB_REPOSITORY`, `RUNNER_OS`, `RELEASE_TARGETS`, `VERSION_OVERRIDE` | CI metadata consumed by build/release scripts. |
| `YAYRA_SMOKE` / `YAYRA_FORCE_BAD_LOAD` (legacy `IBROWSE_*` aliases) | Desktop smoke-test harness toggles (`scripts/smoke-desktop.mjs`). |
| `ELECTRON_SKIP_BINARY_DOWNLOAD=1` | Install deps without downloading the Electron binary (CI lint/test-only jobs, restricted sandboxes). |

## 6. Dependency security posture (kept current with `npm audit`)

Current status: **`npm audit` reports 0 vulnerabilities** after:

- **Electron `31.7.7` → `44.5.1`** (31.x was an EOL line with ~37 published
  advisories including sandbox escapes and context-isolation bypasses; this
  is the runtime shipped to users, so it was the highest-risk item). The
  upgrade also removed the unpatchable `extract-zip` advisories, which only
  affected Electron's own install-time extraction of its HTTPS-downloaded,
  checksum-verified binary. `package.json#build.electronVersion` is kept in
  lockstep. **Human follow-up required:** run `npm run smoke:desktop` and
  the manual desktop QA checklist on a real machine — the unit suite is
  dependency-injected pure Node and cannot exercise the Electron runtime.
- **Capacitor `6.2.2` → `8.5.2`** (core/cli/android/ios, browser plugin
  `^8.0.5`), which eliminated the critical `tar@6` advisory chain in the
  CLI. `cap add android` + `cap sync android` verified working in-sandbox;
  real Gradle/Xcode release builds need human verification (Capacitor 8
  requires newer Android SDK / Xcode toolchains — see Capacitor's upgrade
  guide).

Targeted `overrides` in `package.json` (do not remove without re-auditing):

- `tar: ^7.5.21` — keeps the whole tree on the patched tar line
  (electron-builder/node-gyp/@capacitor/cli all resolve to it).
- `http-cache-semantics: ^4.3.0` — patches GHSA-ch52-4w7c-c8xp in the
  `electron → @electron/get → got` install chain.
- `uuid: ^11.1.1` — patches GHSA-w5hq-g745-h8pq in `@capacitor/cli → xcode`
  (build-time only; verified the CLI still works with the override).
