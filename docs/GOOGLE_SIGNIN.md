# Sign in with Google (Electron desktop) — setup & architecture

## What this is, and what it is not

This feature gives **Yayra itself** a real, app-level Google identity (name,
email, profile picture), so Yayra's own UI can show "Signed in as ..." /
"Sign out". It is **not** a way to use Gmail, Drive, or any other Google
service logged-in *inside* Yayra's embedded browsing view — Google actively
detects and blocks sign-in inside any embedded browser surface (WebView,
WebContentsView, iframe, etc.) as an anti-phishing measure. See
[Google's own policy](https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews).
Yayra does not attempt to bypass that. `electron/webviewBridge.cjs` sends
Google sign-in/OAuth endpoints to the user's real system browser, while
ordinary Google pages and Search remain in the native in-app view where the
platform allows it. System-browser cookies are not copied into Yayra.

The setup and architecture are documented here for Electron desktop, Web/PWA,
and Android/iOS. The original implementation started with desktop; all three
transports are now implemented, with remaining live-provider/device checks
listed in "Status by platform" below.

## How it works

Yayra uses the OAuth 2.0 flow Google explicitly recommends for native/desktop
apps (RFC 8252, "OAuth 2.0 for Native Apps"):

1. Yayra opens your **real system browser** (never an embedded view) to
   Google's consent screen.
2. It uses **Authorization Code + PKCE**. Google calls "Desktop app" OAuth
   clients public/non-confidential, but Google's token endpoint still
   requires the **Client Secret** in the code-exchange request even with
   PKCE — a known Google-specific quirk, not a security requirement (the
   secret is still fine to ship inside the built app, same as the Client ID;
   see step 5 below).
3. A short-lived local HTTP server on `127.0.0.1` (an OS-assigned free port,
   picked fresh every sign-in) catches Google's redirect. This is Google's
   own documented ["loopback interface redirect"](https://developers.google.com/identity/protocols/oauth2/native-app#loopback-ip-address)
   pattern — **no domain, no custom URL scheme, and no fixed port need to be
   registered.**
4. Yayra exchanges the authorization code for tokens directly with Google,
   then fetches your basic profile (name/email/picture).
5. The profile (not the tokens) is shown in Yayra's UI. The raw tokens are
   encrypted at rest using Electron's `safeStorage` (backed by your OS
   keychain — Keychain on macOS, libsecret on Linux, DPAPI on Windows) and
   are never sent to the renderer/web UI process.

Relevant source files:
- `electron/googleAuth.cjs` — the OAuth flow itself (PKCE, loopback server,
  token exchange, userinfo fetch). Fully unit-tested in
  `tests/google-oauth.test.mjs` with a real local socket and a fake Google
  (no live network access).
- `electron/authStore.cjs` — encrypted-at-rest session persistence. Tested in
  `tests/google-auth-store.test.mjs`.
- `electron/authBridge.cjs` — wires the above to IPC channels
  (`yayra:auth-sign-in`, `yayra:auth-sign-out`, `yayra:auth-get-session`).
  Tested in `tests/google-auth-bridge.test.mjs`.
- `electron/googleAuthConfig.cjs` — resolves your Client ID and Client
  Secret. Tested in `tests/google-auth-config.test.mjs`.
- `electron/preload.cjs` — exposes `window.yayra.auth.{signIn, signOut,
  getSession, onEvent}` to the renderer.
- `packages/shared-ui/src/components/BrowserShell.js` — the "Account"
  section inside Settings (`yayra://settings`) that calls the above.

## Creating your own Google Cloud OAuth Client ID

You (not this agent) need to create this, because it ties to a Google Cloud
project you own. **No domain purchase is required.**

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or select) a project.
2. Go to **APIs & Services → OAuth consent screen**. Choose "External" (or
   "Internal" if you have a Google Workspace), fill in the app name/logo/
   support email, and add the `openid`, `email`, and `profile` scopes (these
   are the only ones Yayra requests). While the app is in "Testing" mode you
   can add your own Google account as a test user; "Publish" it later if you
   want any Google account to be able to sign in.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
4. For **Application type, choose "Desktop app"**. Give it any name (e.g.
   "Yayra Desktop"). Click Create.
5. Copy the generated **Client ID** (it looks like
   `123456789-abc...apps.googleusercontent.com`) **and the Client Secret**
   shown right next to it. Despite the "Desktop app" type and PKCE, Google's
   token endpoint rejects sign-in with `client_secret is missing` if you
   don't configure the secret too — you need both values.
6. No redirect URI needs to be registered for "Desktop app" clients using the
   loopback pattern — Google allows any `http://127.0.0.1:<port>/...` or
   `http://localhost:<port>/...` redirect automatically for this client type.

## Configuring Yayra with your Client ID

Pick one:

- **Local development:** export both environment variables before launching
  Electron:
  ```bash
  export YAYRA_GOOGLE_CLIENT_ID="123456789-abc...apps.googleusercontent.com"
  export YAYRA_GOOGLE_CLIENT_SECRET="GOCSPX-..."
  ```
- **Packaged builds:** create `electron/google-auth.config.json` (already
  gitignored — it will never be committed) before running
  `npm run package:linux` / `package:win` / etc.:
  ```json
  { "clientId": "123456789-abc...apps.googleusercontent.com", "clientSecret": "GOCSPX-..." }
  ```
  This file is included by electron-builder's existing `electron/**/*` files
  glob, so it travels with the built installer.
- **Already-installed builds (no rebuild needed):** copy the same JSON file
  into the app's per-user config directory and restart Yayra:
  - Linux: `~/.config/yayra/google-auth.config.json`
  - Windows: `%APPDATA%\yayra\google-auth.config.json`
  - macOS: `~/Library/Application Support/yayra/google-auth.config.json`

  A machine-local file deliberately **wins** over whatever was baked into the
  installer, so you can point an official build at your own OAuth client.
- **CI releases (GitHub Actions):** the repo checkout in CI never contains
  the gitignored file, so `release.yml` writes it from two repository
  secrets before packaging the Linux and Windows desktop builds. Add them
  under **GitHub repo → Settings → Secrets and variables → Actions**:
  `YAYRA_GOOGLE_CLIENT_ID` and `YAYRA_GOOGLE_CLIENT_SECRET`. Every release
  built after that ships with Sign in with Google working out of the box;
  without them the step logs a warning and builds proceed unconfigured.

If either value is missing, the "Sign in with Google" button in Settings →
Account will show a clear "not configured" error instead of failing deep
inside the token exchange.

### Troubleshooting

- **`Couldn't sign in: token_exchange_failed:400:{"error":"invalid_request","error_description":"client_secret is missing."}`**
  — you only set the Client ID. Set `YAYRA_GOOGLE_CLIENT_SECRET` too (see
  above) and restart the app.
- **`Couldn't sign in: fetch failed`** — the token/userinfo request itself
  couldn't reach Google (not an auth error). Most common on Windows machines
  behind a corporate proxy, VPN, or TLS-inspecting antivirus: Node's own
  `fetch` doesn't automatically use the OS proxy/certificate store the way
  your system browser does. Yayra's main process now uses Electron's
  `net.fetch` (Chromium's own network stack) for these requests instead of
  Node's `fetch`, which should resolve this on most machines; if it still
  happens, it usually means outbound HTTPS to `oauth2.googleapis.com` /
  `www.googleapis.com` is blocked entirely by that machine's firewall/proxy.

---

# Web / PWA (`yayra.pages.dev`) — setup & architecture

Same feature, same protocol (Authorization Code + PKCE), different
transport: a browser can't run a loopback redirect server, so Google
redirects back to a real HTTPS page, `/auth/callback`, served by the same
static deployment.

## Design decisions (and why)

- **Full-page redirect, not popup+postMessage.** Installed PWAs run in
  `display: standalone` where `window.opener`/popup relationships are
  unreliable, and popup blockers plus Safari/Brave tracking protections
  break popup flows routinely; a redirect behaves identically in a tab and
  an installed PWA, and avoids postMessage's origin-validation attack
  surface entirely. The in-flight state (PKCE verifier, CSRF `state`,
  return path) survives the round trip in `sessionStorage`.
- **The token exchange happens in the Cloudflare Worker, not the browser.**
  Google's token endpoint requires a `client_secret` for "Web application"
  OAuth clients **even with PKCE** (same Google quirk as the Desktop-app
  client type above), and a secret in browser-delivered JS is public by
  definition. So the callback page sends only `{code, codeVerifier,
  redirectUri}` to the update worker's `/auth/google/exchange` endpoint;
  the Worker holds the secret (as a `wrangler secret`), does the exchange
  AND the userinfo fetch server-side, and returns **only the profile**.
- **Raw tokens never enter the browser at all.** Electron can encrypt
  tokens at rest with the OS keychain (`safeStorage`); a browser has no
  equivalent — anything it stores is readable by same-origin script. This
  design sidesteps that trade-off: no refresh token is ever requested
  (`access_type=online` semantics), the access token lives and dies inside
  one Worker invocation, and the only thing persisted client-side
  (localStorage) is the display profile the UI shows anyway. Consequence:
  the web session is profile-only — which is all Yayra needs. The full
  rationale is written into `src/services/googleAuthWeb.js`.

Relevant source files:
- `src/services/googleAuthWeb.js` — browser half (PKCE, redirect, state
  round trip, bridge adapter). Tested in `tests/google-auth-web.test.mjs`.
- `worker/update-worker.mjs` (`exchangeGoogleAuthCode`) — server half.
  Tested in `tests/worker.test.mjs`.
- `src/browser/authCallback.js` + `public/auth/callback/index.html` — the
  callback page.
- `src/config/googleAuthWeb.js` — build-injected config resolution.
- `src/browser/main.js` — installs the bridge as `window.yayra.auth` (the
  same surface `BrowserShell` already drives on desktop) when configured.

## Creating the "Web application" OAuth Client ID (console steps)

1. Same Google Cloud project and consent screen as the Desktop steps above.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
3. For **Application type, choose "Web application"**. Name it e.g. "Yayra
   Web".
4. Under **Authorized JavaScript origins** add:
   - `https://yayra.pages.dev`
   - `http://localhost:4173` (the dev server, for local testing)
5. Under **Authorized redirect URIs** add:
   - `https://yayra.pages.dev/auth/callback`
   - `http://localhost:4173/auth/callback`
6. Copy the **Client ID** and the **Client Secret**. The secret is
   genuinely confidential for this client type — it must ONLY ever be
   configured on the Worker (next section), never in any web-delivered
   file or committed anywhere.

## Configuring the deployment

Worker (holds the secret):
```bash
npx wrangler secret put GOOGLE_WEB_CLIENT_ID  --config wrangler.worker.toml
npx wrangler secret put GOOGLE_WEB_CLIENT_SECRET --config wrangler.worker.toml
```

`wrangler.worker.toml` also pins the exchange endpoint to the exact web
callback origins `https://yayra.pages.dev` and `http://localhost:4173`.
If you deploy Yayra on another origin, add that exact origin to the
non-secret `GOOGLE_WEB_ALLOWED_ORIGINS` variable and register its matching
`/auth/callback` URI with the same Google Web OAuth client.

Web build (public values only — injected into `<meta>` tags by
`scripts/build-web.mjs`): either export before `npm run build:web`
```bash
export YAYRA_GOOGLE_WEB_CLIENT_ID="123456789-web...apps.googleusercontent.com"
# optional - defaults to the production worker URL:
export YAYRA_GOOGLE_AUTH_EXCHANGE_URL="https://yayra-updates-api.g2code335.workers.dev/auth/google/exchange"
```
or create a gitignored `google-auth.web.config.json` at the repo root:
```json
{ "clientId": "123456789-web...apps.googleusercontent.com" }
```
When neither is set, the build injects empty values and Settings → Account
shows the honest "not available on this build" message.

---

# Android / iOS (Capacitor) — setup & architecture

Same protocol again (Authorization Code + PKCE, RFC 8252 "OAuth 2.0 for
Native Apps"), mobile transport:

1. The consent screen opens in the **system browser surface** —
   SFSafariViewController (iOS) / Chrome Custom Tabs (Android) — via the
   first-party `@capacitor/browser` plugin. Never the app's own WebView
   (Google blocks that, and RFC 8252 §8.12 forbids it).
2. Google redirects to the app's **custom URL scheme**
   `com.yayra.app:/oauth2redirect` (RFC 8252 §7.1). The OS reopens the
   app; the first-party `@capacitor/app` plugin surfaces the URL as an
   `appUrlOpen` event. Yayra accepts only this exact scheme/path (not a
   prefix or lookalike URL), rejects duplicate OAuth parameters, and checks
   the returned state before either handling an error or exchanging a code.
3. The one-shot code + PKCE verifier go to the **same Worker exchange
   endpoint as the web flow** with `platform: 'android' | 'ios'`. These
   Google client types have **no secret at all** (verified by package
   name + SHA-1 / bundle ID), so a direct on-device exchange would also
   be valid AppAuth-style — the Worker hop is kept deliberately so **raw
   tokens never exist in the app's JS context** (UI and flow logic share
   one WebView in Capacitor; the only way to keep tokens away from
   UI-reachable code is to never let them arrive). Trade-off: mobile
   sign-in needs the Worker reachable, which the app already requires
   for update checks.

**Plugin choice (researched 2026-10):** the once-standard
`@byteowls/capacitor-oauth2` is unmaintained (last publish 2023,
officially superseded), and its successor
`@capacitor-community/generic-oauth2` currently supports only Capacitor 7
while Yayra is on Capacitor 8. First-party `@capacitor/app` +
`@capacitor/browser` are maintained in lockstep with Capacitor itself, and
the OAuth logic they don't cover (PKCE/state/exchange) is code this repo
already owns and tests on the other platforms.

Relevant source files:
- `src/services/googleAuthCapacitor.js` — the flow + bridge adapter.
  Tested in `tests/google-auth-capacitor.test.mjs`.
- `src/config/googleAuthCapacitor.js` — build-injected per-platform
  client-ID resolution.
- `worker/update-worker.mjs` — the shared exchange endpoint
  (`platform` selector; secretless for native clients).
- `scripts/ensure-capacitor-platform.mjs` — injects the native deep-link
  plumbing (below) into the generated projects.
- `src/browser/main.js` — installs the bridge on native platforms.

## Native project changes (automated — do not do these by hand)

`android/` and `ios/` are generated and gitignored, so
`scripts/ensure-capacitor-platform.mjs` (already part of
`npm run build:android` / `build:ios`) injects the deep-link registration
idempotently every run:

- **Android** (`AndroidManifest.xml`): a `VIEW` + `BROWSABLE`
  intent-filter on `MainActivity` for `@string/custom_url_scheme` (which
  Capacitor already defines as `com.yayra.app`). No `autoVerify` — this is
  a custom scheme, not an https App Link.
- **iOS** (`Info.plist`): a `CFBundleURLTypes` entry registering the
  `com.yayra.app` scheme.

## Creating the "Android" and "iOS" OAuth Client IDs (console steps)

Same project/consent screen as the Desktop steps. These client types issue
**no client secret** — identity is proven by app signature instead.

Android — **Credentials → Create Credentials → OAuth client ID →
"Android"**:
1. Package name: `com.yayra.app`.
2. SHA-1 fingerprint: for local testing use the debug keystore
   (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA1`).
   For production you need **two more Android clients or added
   fingerprints**: your upload/release keystore's SHA-1 AND — if you use
   Play App Signing (you should) — the **app signing key SHA-1 from Play
   Console → Setup → App signing**, because that's what actually signs
   what users install.
3. No redirect URI is registered for Android clients; Google accepts the
   package-name custom scheme automatically.

iOS — **Create Credentials → OAuth client ID → "iOS"**:
1. Bundle ID: `com.yayra.app`.
2. (App Store ID / Team ID optional until store release.)
3. No secret, no redirect registration — the custom scheme is derived
   from the bundle ID.

## Configuring the build

The per-platform client IDs ship inside the app bundle by design (nothing
secret). Injected by `scripts/build-web.mjs` into the `dist/` bundle that
`cap sync` copies into the native projects — either:
```bash
export YAYRA_GOOGLE_ANDROID_CLIENT_ID="123-android...apps.googleusercontent.com"
export YAYRA_GOOGLE_IOS_CLIENT_ID="123-ios...apps.googleusercontent.com"
```
or add `androidClientId` / `iosClientId` fields to the gitignored
`google-auth.web.config.json`. The Worker needs matching bindings (no
secrets for these two):
```bash
npx wrangler secret put GOOGLE_ANDROID_CLIENT_ID --config wrangler.worker.toml
npx wrangler secret put GOOGLE_IOS_CLIENT_ID     --config wrangler.worker.toml
```

---

## Status by platform

| Platform | Status |
| --- | --- |
| Electron desktop (Linux/Windows) | **Implemented**; the live round trip against real Google servers has **not** been run by this agent (no GUI browser or registered Client ID in this sandbox) and must be verified by you on your own machine with your own Client ID. |
| Web / PWA (`yayra.pages.dev`) | **Implemented** (full-page redirect + Worker-side exchange, see above). Fully unit-tested with mocks (`tests/google-auth-web.test.mjs`, `tests/worker.test.mjs`); the live round trip needs a human with a real "Web application" Client ID, the Worker secrets deployed, and a real browser — see verification steps below. |
| Android / iOS (Capacitor) | **Implemented** (system browser + custom-scheme deep link + shared Worker exchange, see above). Fully unit-tested with mocks (`tests/google-auth-capacitor.test.mjs`); native deep-link injection verified against freshly generated Capacitor 8 projects in-sandbox. The live round trip needs a human with real "Android"/"iOS" Client IDs, Worker bindings deployed, and a real device/emulator — this sandbox can run neither a mobile emulator nor a consent screen. |

## How to verify it actually works (you must do this)

### Web / PWA

1. Create the "Web application" Client ID per the steps above; put the
   secret on the Worker (`wrangler secret put ...`) and redeploy it
   (`npm run deploy:cloudflare:worker`).
2. Local first pass: `export YAYRA_GOOGLE_WEB_CLIENT_ID=...` then
   `npm run dev`, open `http://localhost:4173`, Settings → Account →
   "Sign in with Google". The page should redirect to Google's consent
   screen, back to `/auth/callback`, then to where you started — now
   showing your name/email/avatar.
3. Production pass: build with the same env var, deploy to Pages, repeat
   from `https://yayra.pages.dev` in a normal tab AND as an installed PWA.
4. Negative paths worth 60 seconds: cancel on the consent screen (should
   land on a clear "cancelled" message, not a blank page); press Back
   after signing in (should NOT re-run the callback); sign out and reload
   (stays signed out).

### Android / iOS (Capacitor)

1. Create the "Android" and/or "iOS" Client IDs per the steps above; bind
   `GOOGLE_ANDROID_CLIENT_ID` / `GOOGLE_IOS_CLIENT_ID` on the Worker and
   redeploy it.
2. Build with the matching env vars set
   (`YAYRA_GOOGLE_ANDROID_CLIENT_ID=... npm run build:android`), install
   on a real device/emulator whose signing cert SHA-1 matches the Android
   client (debug keystore for a debug build!).
3. Settings → Account → "Sign in with Google": a Custom Tab/Safari sheet
   must open (NOT an in-app webview), and after consent the app must come
   back to the foreground signed in.
4. Negative paths: dismiss the sheet without finishing (expect a clear
   "cancelled" state, not a stuck spinner — there is also a 5-minute
   timeout); kill and relaunch the app (session persists until explicit
   sign-out).
5. If the redirect never returns to the app, verify the injected
   intent-filter / CFBundleURLTypes survived your build (run
   `node scripts/ensure-capacitor-platform.mjs android` / `ios` again and
   grep for "YAYRA GOOGLE SIGN-IN").

### Electron desktop

1. Create your Client ID per the steps above and set it via the environment
   variable (fastest for a first test).
2. Run the desktop app (`npm run build:web && npx electron .` or your usual
   dev launch command) on a machine with a real display.
3. Open Settings → Account → "Sign in with Google".
4. Your default system browser should open to Google's consent screen. Sign
   in and approve.
5. Your browser tab should show "Signed in to Yayra — you can close this tab"
   and Yayra's Settings → Account should now show your name/email.
6. Confirm "Sign out" clears it, and relaunching Yayra without signing in
   again still remembers you were signed in (session persistence) until you
   explicitly sign out.
