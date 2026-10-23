# Google sign-in and Google website sessions

## Security contract

Yayra supports three related Google experiences. They must not be conflated:

1. **Yayra app identity** — Settings → Account → **Sign in with Google** gives
   Yayra a basic profile (`sub`, name, email, picture) using OAuth 2.0
   Authorization Code + PKCE.
2. **Delegated Drive reads** — when a Drive download cannot complete through
   the browser-owned website session, Yayra can ask separately for the narrow
   `drive.readonly` scope and retrieve that selected file through Google's API.
3. **Google website sessions** — Gmail, Google Account, Search, YouTube, and a
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
- Basic identity requests only `openid email profile`. Drive recovery is a
  separate, explicit consent for exactly
  `https://www.googleapis.com/auth/drive.readonly`; Yayra never requests Gmail,
  Calendar, write access, or broad catch-all Google scopes.
- A custom-scheme callback may contain only a one-time authorization code,
  state, or provider error. Access, refresh, and ID tokens in a callback URL
  are rejected. No token is ever put in a `yayra://` or
  `com.yayra.app:` URL.
- Redirect origins and paths are exact, callback and request inputs are
  bounded, duplicate security parameters are rejected, pending transactions
  expire, and auth responses are `no-store`.
- Browser/WebView code receives only the display profile and, after explicit
  Drive consent, an opaque 256-bit, origin-bound Yayra capability. Raw Google
  access/refresh tokens never enter Web/PWA or Capacitor renderer JavaScript.
- Web/mobile delegated credentials are AES-GCM-encrypted in Worker KV, expire
  after 30 days, are refreshed only server-side, and are deleted on logout
  before best-effort Google revocation. Electron keeps scoped credentials only
  in its encrypted main-process auth store and revokes them on logout.

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

## Google Drive download recovery

A `drive.google.com/uc?export=download&id=...` link first uses the normal
browser/native download path, preserving the user agent, cookies owned by that
engine, confirmation-token redirects, and native download tracking. Yayra does
not classify ordinary Google pages or arbitrary query strings as files.

If Google returns a correlated failure for a trusted Drive file ID, the
recovery card offers **Download through Drive API**:

- Desktop runs a second system-browser consent for `drive.readonly`, stores the
  scoped credentials through Electron `safeStorage`, fetches metadata and file
  bytes in the main process, and sends only the bounded bytes/metadata over
  IPC.
- Web/PWA and Capacitor return from the same verified OAuth callback/deep link,
  persist only an opaque Worker session, and call `/api/drive/download` with
  that capability. Google Workspace documents are exported to DOCX, XLSX,
  PPTX, or PDF; uploaded files retain their available MIME type.
- Completed supported files open through Yayra's document registry and enter
  the same Documents/download system as local and native downloads.
- The API path is bounded, origin-bound, rate-limited, `no-store`, and never
  returns a bearer or refresh token. A 401 removes the stale local capability
  and asks the user to reconnect; no false success page is shown.

This API fallback authorizes file reads; it still does not—and cannot—copy the
Chrome cookie session into an Electron surface, Android WebView, or PWA frame.

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
8. Drive recovery starts a distinct consent with `drive.readonly`; Drive
   metadata, refresh, download/export, and revocation stay in the main process.
   Only bounded file bytes and safe metadata cross IPC.
9. Token material is encrypted at rest with Electron `safeStorage`
   (Keychain/libsecret/DPAPI). If OS-backed encryption is unavailable, tokens
   are not written in plaintext.
10. App identity and Drive credentials are scoped to the browsing profile
    bound to the initiating `BrowserWindow`. The main process pins that
    binding before navigation, routes events only to windows for the same
    profile, and stores non-default sessions in separate hashed filenames.
    The default profile keeps using the legacy `google-session.json`, so an
    existing encrypted session survives upgrade without token migration or a
    forced sign-in.

There is no desktop `yayra://oauth-callback` handler and no bearer token in a
URL. Loopback is the registered return channel for the Desktop OAuth client.

Relevant files:

- `electron/googleAuth.cjs` — PKCE, state, bounded loopback callback, token
  exchange, and profile validation.
- `electron/authBridge.cjs` — system-browser launch, renderer-safe identity
  IPC, encrypted scoped Drive refresh/download, and credential revocation.
- `electron/authStore.cjs` — per-profile, OS-keychain-backed encrypted token
  persistence with legacy-default migration.
- `electron/googleAuthConfig.cjs` — desktop client configuration.
- `tests/google-oauth.test.mjs`, `tests/google-auth-bridge.test.mjs`, and
  `tests/google-auth-store.test.mjs` — automated coverage.

### Desktop Google Cloud setup

1. Create/select a Google Cloud project.
2. Configure the OAuth consent screen for `openid`, `email`, `profile`, and
   the separately requested Google Drive read-only scope. Add test users while
   the app remains in Testing mode and complete Google's verification process
   before broad production use.
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
5. For basic identity, the Worker performs token exchange/userinfo, discards
   the tokens, and returns only a bounded, sanitized profile.
6. For the separate Drive-readonly capability, the Worker encrypts scoped
   Google credentials into `GOOGLE_DRIVE_SESSIONS` KV and returns the profile
   plus only an opaque origin-bound session ID.
7. The display profile and opaque Drive capability survive app/browser
   restarts in `localStorage`; no Google access or refresh token reaches
   browser JavaScript. Keys are namespaced by browsing profile, and the
   profile id is carried inside the validated one-use redirect transaction.
   Logout removes only that profile's local capability and calls the Worker's
   revocation endpoint.

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
   `ios` platform value. Basic identity returns only the profile; separate
   Drive consent returns that profile plus an opaque scoped Worker session.
5. The verified profile and opaque Drive capability persist across app
   restarts. Raw Google credentials never enter the Capacitor WebView.
6. The pending flow times out, dismissing the browser reports cancellation,
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

`worker/update-worker.mjs` exposes `POST/OPTIONS /auth/google/exchange`,
`GET/OPTIONS /api/drive/download`, and `POST/OPTIONS
/api/drive/session/revoke` for these flows. It enforces:

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
- AES-GCM-encrypted, random 256-bit delegated records with KV TTL, exact
  request-origin binding, narrow Drive scope checks, bounded metadata/download
  handling, and Workspace export allowlisting;
- delete-before-provider-revoke logout semantics, so an unavailable Google
  revocation endpoint cannot leave a Yayra capability active;
- no token fields in any client response or log.

The non-secret origin variables in `wrangler.worker.toml` are:

```toml
GOOGLE_WEB_ALLOWED_ORIGINS = "https://yayra.pages.dev,http://localhost:4173"
GOOGLE_NATIVE_ALLOWED_ORIGINS = "https://localhost,http://localhost,capacitor://localhost"
```

Add a custom deployment only as an exact origin and register its exact
`/auth/callback` URI with the same Google Web client.

Drive fallback additionally requires a KV namespace and an independent
high-entropy encryption secret. Create them once (production and local preview
may use separate namespaces):

```bash
npx --yes wrangler@4 kv namespace create GOOGLE_DRIVE_SESSIONS --config wrangler.worker.toml
npx --yes wrangler@4 kv namespace create GOOGLE_DRIVE_SESSIONS --preview --config wrangler.worker.toml
```

Add the IDs printed by Wrangler to `wrangler.worker.toml`—IDs are deployment
identifiers, not credentials:

```toml
[[kv_namespaces]]
binding = "GOOGLE_DRIVE_SESSIONS"
id = "<production namespace id>"
preview_id = "<preview namespace id>"
```

Then bind the encryption key as a Worker **secret**, never a `[vars]` value:

```bash
openssl rand -base64 48 | npx --yes wrangler@4 secret put GOOGLE_DRIVE_SESSION_SECRET --config wrangler.worker.toml
```

`GOOGLE_DRIVE_SESSION_SECRET` must be at least 32 characters and should be an
independent random value. Rotating it immediately invalidates all existing
Drive capabilities; users reconnect on demand. Deleting the KV namespace has
the same session-invalidating effect. Do not reuse a Google client secret,
Cloudflare token, NVIDIA key, or application signing key.

Verify bindings without printing secret values:

```bash
npx --yes wrangler@4 kv namespace list
npx --yes wrangler@4 secret list --config wrangler.worker.toml
```

The Worker returns `501 drive_session_not_configured` until KV supports
`get`/`put`/`delete` and the encryption secret is present, rather than silently
falling back to insecure storage. See `docs/CLOUDFLARE.md` for deploy order.

## Threat model summary

| Threat | Control |
| --- | --- |
| Embedded-browser rejection / credential phishing surface | Interactive Google auth uses the OS external user-agent. |
| Login CSRF / callback injection | Random state, exact callback route/origin, duplicate rejection, single-use pending state. |
| Authorization-code interception | PKCE S256; mobile uses a reverse-DNS app callback and platform-bound client. |
| Deep-link credential leakage | Only code/state/error accepted; token parameters are rejected; no tokens in custom URLs. |
| Open redirect / host confusion | Exact hosts/routes, URL credential rejection, bounded HTTPS continuation repair. |
| Renderer token theft | Electron keeps Google tokens in main; Web/Capacitor receive only profile plus an opaque capability, never raw tokens. |
| Token theft at rest | Electron `safeStorage`; Worker AES-GCM + KV TTL; no plaintext fallback. Web/mobile persist only profile and opaque capability. |
| Worker cross-origin abuse | Exact CORS allowlist, Origin/redirect/session binding, custom authorization header, PKCE, one-time code, rate limit. |
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
9. Open a permitted `drive.google.com/uc?export=download&id=...` file. Confirm
   native cookie/redirect download is attempted first; if recovery is needed,
   grant Drive-readonly, download through the API, and verify the file opens in
   Yayra/Documents without a false site-failure page.
10. Restart Yayra and repeat a Drive action without reconnecting. Then sign
    out and confirm another Drive action requires consent; inspect renderer IPC
    to confirm no token-shaped value crossed it.

### Web / PWA

1. Test both `http://localhost:4173` and `https://yayra.pages.dev`, including
   an installed standalone PWA.
2. Confirm callback state is single-use, stale transactions expire, Back does
   not replay exchange, and cancellation shows a clear message.
3. Confirm an unlisted Origin gets no auth CORS permission.
4. Complete the separate Drive-readonly consent, reload and restart the
   installed PWA, and confirm a trusted Drive file can still be downloaded and
   opened while local storage contains only the opaque 43-character session.
5. Sign out, verify `/api/drive/session/revoke` deletes the KV record, and
   confirm replaying the former capability returns 401. Also test a different
   allowed Origin and confirm origin mismatch returns 403 without deletion.

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
5. Exercise a Drive `uc` link with and without a browser-owned cookie. Confirm
   the native download preserves cookies/user agent and tracks completion; on
   correlated failure, grant Drive-readonly, return by deep link, and confirm
   delegated bytes open internally. Restart the app, retry, then sign out and
   verify the opaque session is revoked.

Automated coverage is in `tests/google-oauth.test.mjs`,
`tests/google-auth-bridge.test.mjs`, `tests/google-auth-web.test.mjs`,
`tests/google-auth-capacitor.test.mjs`, `tests/electron-webview-bridge.test.mjs`,
`tests/browser-shell-capacitor-handoff.test.mjs`,
`tests/android-inapp-google.test.mjs`, and `tests/worker.test.mjs`.
