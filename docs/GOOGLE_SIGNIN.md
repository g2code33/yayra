# Google sign-in and Google website sessions

## Security contract

Yayra supports two different Google experiences. They must not be conflated:

1. **Yayra app identity** — Settings → Account → **Sign in with Google** gives
   Yayra a basic profile (`sub`, name, email, picture) using OAuth 2.0
   Authorization Code + PKCE.
2. **Google website sessions** — Gmail, Google Account, Search, YouTube, and a
   third-party website's **Continue with Google** flow use browser cookies owned
   by the browser surface that created them.

An app OAuth token does not create a Gmail/Google website cookie session, and
Yayra never copies cookies from Chrome, Edge, Safari, or Firefox. It also never
spoofs Google security checks.

The production rules are:

- Google OAuth and interactive Google Account sign-in never load in an iframe,
  Android `WebView`, Electron `WebContentsView`, or Electron `BrowserWindow`.
  They use the OS external user-agent required by RFC 8252 and Google's
  [embedded-user-agent policy](https://developers.google.com/identity/protocols/oauth2/policies#embedded-webviews).
- Matching is limited to the exact `accounts.google.com` host and known OAuth
  or interactive sign-in routes. Search, Gmail content, account management,
  logout, and other Google product navigation are not broad-matched.
- Authorization Code + PKCE (`S256`) and an unpredictable, single-use `state`
  are used on every platform.
- Only `openid email profile` scopes are requested. Yayra does **not** request
  Gmail, Drive, Calendar, or broad `googleapis.com` scopes for basic sign-in.
- A custom-scheme callback may contain only a one-time authorization code,
  state, or provider error. Access, refresh, and ID tokens in a callback URL
  are rejected. No token is ever put in a `yayra://` or
  `com.yayra.app:` URL.
- Redirect origins and paths are exact, callback and request inputs are
  bounded, duplicate security parameters are rejected, pending transactions
  expire, and auth responses are `no-store`.
- Browser/WebView code receives only the display profile. Raw Google tokens
  never enter Web/PWA or Capacitor renderer JavaScript.

## Google Account, Gmail, and Google product sign-in

Google can reject an app-controlled browser with “This browser or app may not
be secure.” A separate Electron `BrowserWindow` is still app-controlled, so
making it larger or removing `Electron` from the user-agent is not a compliant
fix.

Yayra handles the problem as follows:

- `electron/webviewBridge.cjs`, `BrowserShell.js`, and Android's
  `YayraTabWebviewManager.kt` recognize exact Google OAuth and interactive
  sign-in routes such as `/o/oauth2/...`, `/oauth2/...`, `/signin/oauth/...`,
  `/gsi/select/...`, `/signin/v2/...`, `/v3/signin/...`, `/ServiceLogin`,
  `/InteractiveLogin`, `/AccountChooser`, and `/AddSession`.
- Google-owned account entry (`accounts.google.com/`, `ManageAccount`,
  `myaccount.google.com`, and first-party interactive sign-in) now starts
  **Yayra's own callback-returning OAuth connection**. The external user-agent
  performs consent, the verified callback returns the sanitized profile, and
  the Yayra account button/tab updates automatically. Returning from the
  browser no longer leaves an `ERR_FAILED` account page retrying forever.
- A Gmail or other Google product redirect into first-party `ServiceLogin` is
  canceled before it loads. Yayra keeps the product URL, runs the same account
  connection, then shows a connected-state card with a safe continuation to
  that product's credential-free HTTPS origin.
- Third-party `/o/oauth2`, `/signin/oauth`, and `/gsi/select` requests are not
  replaced by Yayra OAuth. Their original relying-party client ID and callback
  continue in the external browser exactly as requested.
- A Google `/signin/rejected` or `/v3/signin/rejected` URL is never reopened as
  the same dead-end page. First-party rejection enters the Yayra connection
  flow; a bounded HTTPS Google-product continuation is retained only for the
  post-connection action.
- The originating Yayra tab/history stay intact. Captured first-party account
  URLs are not echoed from Electron main-process events or Android native
  events into renderer JavaScript or logs; only provider/reason metadata is
  returned. After a successful desktop callback, the initiating Yayra window
  is shown and focused so the connected state is immediately visible.

The Google product remains signed in in the external browser that created the
cookie. There is no provider-supported way to import that cookie into an
Electron/Android embedded page. Yayra therefore transfers the **verified
Google identity/profile**, not a browser cookie: the Yayra avatar and account
state are connected, while Google Account/Gmail continuation opens at a
sanitized Google-owned origin in the secure browser where its session exists.
A third-party website OAuth flow may likewise finish in that browser because
its callback belongs to the relying website, not to Yayra.

## Electron desktop: Yayra app identity

Desktop uses the native-app loopback pattern:

1. The Electron main process generates PKCE and state.
2. A one-shot HTTP listener binds only to `127.0.0.1` on an OS-assigned port.
3. Google opens through `shell.openExternal`, which invokes the user's default
   secure browser.
4. Google redirects to the exact `http://127.0.0.1:<port>/callback` URI.
5. The listener accepts only a bounded `GET /callback`, rejects duplicate or
   malformed parameters, verifies state, and consumes the code once.
6. The callback page is CSP-locked, `no-store`, `no-referrer`, and removes the
   one-time code from browser history with `history.replaceState`.
7. The main process exchanges the code with PKCE, fetches userinfo, and sends
   only the sanitized profile over IPC.
8. Token material is encrypted at rest with Electron `safeStorage`
   (Keychain/libsecret/DPAPI). If OS-backed encryption is unavailable, tokens
   are not written in plaintext.

There is no desktop `yayra://oauth-callback` handler and no bearer token in a
URL. Loopback is the registered return channel for the Desktop OAuth client.

Relevant files:

- `electron/googleAuth.cjs` — PKCE, state, bounded loopback callback, token
  exchange, and profile validation.
- `electron/authBridge.cjs` — system-browser launch and profile-only IPC.
- `electron/authStore.cjs` — OS-keychain-backed encrypted token persistence.
- `electron/googleAuthConfig.cjs` — desktop client configuration.
- `tests/google-oauth.test.mjs`, `tests/google-auth-bridge.test.mjs`, and
  `tests/google-auth-store.test.mjs` — automated coverage.

### Desktop Google Cloud setup

1. Create/select a Google Cloud project.
2. Configure the OAuth consent screen. Request only `openid`, `email`, and
   `profile`. Add test users while the app remains in Testing mode.
3. Create an OAuth client of type **Desktop app**.
4. Configure both values supplied for that client:

```bash
export YAYRA_GOOGLE_CLIENT_ID="123-...apps.googleusercontent.com"
export YAYRA_GOOGLE_CLIENT_SECRET="GOCSPX-..."
```

For packaged builds, put the same values in the gitignored
`electron/google-auth.config.json`:

```json
{ "clientId": "123-...apps.googleusercontent.com", "clientSecret": "GOCSPX-..." }
```

A Desktop client secret is not a confidentiality boundary—the installed app
is a public client—but Google's token exchange for the configured client must
receive the matching value. PKCE is the code-substitution defense.

Machine-local overrides are also read from:

- Linux: `~/.config/yayra/google-auth.config.json`
- Windows: `%APPDATA%\yayra\google-auth.config.json`
- macOS: `~/Library/Application Support/yayra/google-auth.config.json`

CI release builds use the repository secrets `YAYRA_GOOGLE_CLIENT_ID` and
`YAYRA_GOOGLE_CLIENT_SECRET`. Never commit either config file.

## Web / PWA

Web/PWA app identity uses a full-page redirect rather than a popup:

1. `src/services/googleAuthWeb.js` generates PKCE/state and stores the pending
   verifier, exact return path, and start time in per-tab `sessionStorage`.
2. Google redirects only to the exact same-origin `/auth/callback` route.
3. The callback consumes the pending transaction once, checks route, origin,
   age, state, code bounds, and PKCE verifier shape.
4. The browser sends the one-time code and verifier to the exact HTTPS Worker
   route `/auth/google/exchange`.
5. The Worker performs the token exchange and userinfo request, discards the
   tokens, and returns only a bounded, sanitized profile.
6. Only that display profile is stored in `localStorage`; no access or refresh
   token reaches browser JavaScript.

A Worker-side `/auth/google` kickoff is intentionally unnecessary: PKCE and
state are generated in the initiating tab, where `sessionStorage` preserves
standalone-PWA compatibility without a cross-site cookie dependency.

### Web Google Cloud setup

Create a **Web application** OAuth client with exact values:

- Authorized JavaScript origins:
  - `https://yayra.pages.dev`
  - `http://localhost:4173`
- Authorized redirect URIs:
  - `https://yayra.pages.dev/auth/callback`
  - `http://localhost:4173/auth/callback`

Put the confidential Web client values only on the Worker:

```bash
npx wrangler secret put GOOGLE_WEB_CLIENT_ID --config wrangler.worker.toml
npx wrangler secret put GOOGLE_WEB_CLIENT_SECRET --config wrangler.worker.toml
```

Inject the public client ID into the web build:

```bash
export YAYRA_GOOGLE_WEB_CLIENT_ID="123-web.apps.googleusercontent.com"
npm run build:web
```

`YAYRA_GOOGLE_AUTH_EXCHANGE_URL` may override the exchange endpoint, but the
client accepts only HTTPS (or loopback HTTP in development) and the exact
`/auth/google/exchange` path.

## Android / iOS (Capacitor)

Mobile app identity follows RFC 8252's external-user-agent/custom-scheme
pattern:

1. `@capacitor/browser` opens Chrome Custom Tabs or the iOS secure browser
   surface; the app WebView is never used for Google consent.
2. Google returns a one-time code and state to the exact reverse-DNS callback
   `com.yayra.app:/oauth2redirect`.
3. `@capacitor/app` emits the deep link. Yayra rejects prefix lookalikes,
   alternate authorities/paths, fragments, duplicate parameters, oversized
   input, state mismatch, and every token-bearing callback.
4. The code and PKCE verifier go to the Worker with an exact `android` or
   `ios` platform value. The Worker returns only the profile.
5. The pending flow times out, dismissing the browser reports cancellation,
   and unrelated app deep links are ignored.

`scripts/ensure-capacitor-platform.mjs` injects the Android intent filter and
iOS `CFBundleURLTypes` registration into generated projects.

Create Google OAuth clients with these identities:

- Android client: package `com.yayra.app` plus every applicable signing SHA-1
  (debug, release/upload, and Play App Signing).
- iOS client: bundle ID `com.yayra.app`.

Configure public client IDs at build time and matching Worker bindings:

```bash
export YAYRA_GOOGLE_ANDROID_CLIENT_ID="123-android.apps.googleusercontent.com"
export YAYRA_GOOGLE_IOS_CLIENT_ID="123-ios.apps.googleusercontent.com"
npx wrangler secret put GOOGLE_ANDROID_CLIENT_ID --config wrangler.worker.toml
npx wrangler secret put GOOGLE_IOS_CLIENT_ID --config wrangler.worker.toml
```

Native client types have no confidential client secret.

## Cloudflare Worker controls

`worker/update-worker.mjs` exposes only `POST/OPTIONS
/auth/google/exchange` for this flow. It enforces:

- HTTPS Worker requests;
- exact web and Capacitor CORS origin allowlists (never `*` on auth);
- web Origin-to-redirect-origin binding;
- exact callback routes and platform/client mapping;
- JSON content type, a 16 KiB request cap, bounded code/redirect/verifier
  fields, and rejection of unknown/token-shaped fields;
- RFC 7636 verifier syntax and provider-enforced one-time code use;
- global and auth-specific per-IP rate limits;
- `no-store`, `no-referrer`, `nosniff`, and `Vary: Origin` responses;
- profile schema/length validation and HTTPS-only profile pictures;
- no token fields in any client response or log.

The non-secret origin variables in `wrangler.worker.toml` are:

```toml
GOOGLE_WEB_ALLOWED_ORIGINS = "https://yayra.pages.dev,http://localhost:4173"
GOOGLE_NATIVE_ALLOWED_ORIGINS = "https://localhost,http://localhost,capacitor://localhost"
```

Add a custom deployment only as an exact origin and register its exact
`/auth/callback` URI with the same Google Web client.

## Threat model summary

| Threat | Control |
| --- | --- |
| Embedded-browser rejection / credential phishing surface | Interactive Google auth uses the OS external user-agent. |
| Login CSRF / callback injection | Random state, exact callback route/origin, duplicate rejection, single-use pending state. |
| Authorization-code interception | PKCE S256; mobile uses a reverse-DNS app callback and platform-bound client. |
| Deep-link credential leakage | Only code/state/error accepted; token parameters are rejected; no tokens in custom URLs. |
| Open redirect / host confusion | Exact hosts/routes, URL credential rejection, bounded HTTPS continuation repair. |
| Renderer token theft | Electron sends profile-only IPC; Web/Capacitor never receive raw tokens. |
| Token theft at rest | Electron `safeStorage`; no plaintext fallback. Web/mobile persist profile only. |
| Worker cross-origin abuse | Exact CORS allowlist, Origin/redirect binding, PKCE, one-time code, rate limit. |
| XSS through profile fields | Profile schema/length validation plus HTML/attribute escaping at render time. |
| Replay | Google code is one-time; pending client transaction is consumed and expires after 10 minutes. |

## Manual verification

Live Google consent cannot be completed in headless CI. Before release, verify:

### Desktop

1. Configure the Desktop client and launch a packaged build on a real desktop.
2. Settings → Account → Sign in with Google must open the OS default browser,
   not an Electron window.
3. Complete consent. The browser callback page should say to return to Yayra,
   its address should become `/complete`, and Yayra should show the profile.
4. Cancel, alter state, wait past timeout, and launch with no default browser;
   each path must fail clearly without creating a session.
5. Type `accounts.google.com` in a normal Yayra tab. Confirm no native
   `ERR_FAILED` page appears: the system browser performs Yayra OAuth once,
   returns through loopback, focuses Yayra, updates the account avatar, and
   changes the tab card to “Google is connected to Yayra”.
6. From a signed-out Gmail tab, trigger its `/ServiceLogin` redirect. Confirm
   the source product URL/history stays unchanged, the raw ServiceLogin URL is
   not reopened, and successful Yayra OAuth offers a credential-free Gmail
   continuation.
7. Trigger a third-party Google OAuth URL with its own `client_id`. Confirm it
   still opens unchanged in the system browser and is not replaced by Yayra's
   first-party callback.
8. Open a captured `/v3/signin/rejected?...continue=...` URL. Confirm it enters
   the Yayra connection surface and retains only a safe Google-product origin
   for continuation, never the rejected page or its opaque path/query.

### Web / PWA

1. Test both `http://localhost:4173` and `https://yayra.pages.dev`, including
   an installed standalone PWA.
2. Confirm callback state is single-use, stale transactions expire, Back does
   not replay exchange, and cancellation shows a clear message.
3. Confirm an unlisted Origin gets no auth CORS permission.

### Android / iOS

1. Build with the matching platform client ID and signing identity.
2. Confirm app identity opens Custom Tabs/iOS browser and returns via
   `com.yayra.app:/oauth2redirect`.
3. Test wrong-state, prefix-confusable, duplicate, token-bearing, unrelated,
   canceled, and timed-out callbacks.
4. Navigate to Gmail/Google Account sign-in from a native website tab. Confirm
   the WebView cancels the interactive route, the platform OAuth adapter
   returns the verified profile by deep link, the Yayra avatar/card updates,
   and the original product URL/history stays unchanged.

Automated coverage is in `tests/google-oauth.test.mjs`,
`tests/google-auth-bridge.test.mjs`, `tests/google-auth-web.test.mjs`,
`tests/google-auth-capacitor.test.mjs`, `tests/electron-webview-bridge.test.mjs`,
`tests/browser-shell-capacitor-handoff.test.mjs`,
`tests/android-inapp-google.test.mjs`, and `tests/worker.test.mjs`.
