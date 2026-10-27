# Google sign-in and Google website sessions

## Security contract

Yayra supports five related Google experiences. They must not be conflated:

1. **Yayra app identity** — Settings → Account → **Sign in with Google** gives
   Yayra a basic profile (`sub`, name, email, picture) using OAuth 2.0
   Authorization Code + PKCE.
2. **Gmail in Yayra** — a Gmail-initiated connection asks separately for
   `gmail.readonly`, resumes the exact initiating Gmail tab, and provides a
   read-only inbox/search/message surface through the Gmail API.
3. **Delegated Drive reads** — when a Drive download cannot complete through
   the browser-owned website session, Yayra can ask separately for the narrow
   `drive.readonly` scope and retrieve that selected file through Google's API.
4. **Google services in Yayra** — `yayra://google-services` uses a broader,
   explicit consent to reflect the exact selected Google account across Google
   pages inside Yayra and to provide API-backed previews for Gmail, Drive,
   Calendar, Contacts, Tasks, Classroom, Photos, and YouTube.
5. **Google website sessions** — Google Account, Search, YouTube, and a
   third-party website's **Continue with Google** flow still use browser cookies
   owned by the browser surface that created them.

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
- Basic identity requests only `openid email profile`. Drive recovery and
  Gmail are separate, explicit consents for exactly
  `https://www.googleapis.com/auth/drive.readonly` and
  `https://www.googleapis.com/auth/gmail.readonly`. The new Google services hub
  uses its own explicit, enumerated read-only scope set (Gmail, Drive,
  Calendar, YouTube, Contacts, Photos Library, Tasks, and Classroom courses).
  Yayra never requests Gmail write/send, Drive write, broad
  `https://www.googleapis.com/auth/cloud-platform`, or a catch-all Google
  scope. Every requested scope is visible on the Google consent screen.
- A custom-scheme callback may contain only a one-time authorization code,
  state, or provider error. Access, refresh, and ID tokens in a callback URL
  are rejected. No token is ever put in a `yayra://` or
  `com.yayra.app:` URL.
- Redirect origins and paths are exact, callback and request inputs are
  bounded, duplicate security parameters are rejected, pending transactions
  expire, and auth responses are `no-store`.
- Browser/WebView code receives only the display profile and, after explicit
  Drive or Gmail consent, a capability-specific opaque 256-bit, origin-bound
  Yayra session. Raw Google access/refresh tokens never enter Web/PWA or
  Capacitor renderer JavaScript.
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
  canceled before it loads. Yayra keeps the bounded product destination—path,
  query, and fragment included—and runs its callback-returning account flow.
  On success the exact initiating tab resumes automatically inside Yayra.
- Gmail initiation requests `gmail.readonly` during that same trip. The returned
  account appears by exact email in Yayra's Gmail header and the tab opens a
  read-only API-backed inbox/search/message surface, without attempting to
  reuse Chrome cookies. Other Google pages resume in Yayra's site engine with
  a persistent “Connected to Yayra” account strip naming the selected account.
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

The Google website remains signed in only in the browser surface that created
its cookie. There is no provider-supported way to import that cookie into an
Electron/Android embedded page. Yayra therefore transfers the **verified
Google identity/profile**, not a browser cookie. Google pages resumed in the
site engine may still render Google's own cookie-dependent “Sign in” control;
the separate Yayra account strip truthfully names the verified app account.
Gmail avoids that contradiction by using its explicitly consented read-only API
surface inside Yayra. A third-party website OAuth flow may still finish in the
external browser because its callback belongs to the relying website, not to
Yayra.

## Gmail inside Yayra

A Gmail destination is never sent back to Chrome after the OAuth callback.
Yayra resumes the exact `mail.google.com` URL in the initiating tab and renders
an API-backed mailbox for the selected account:

- OAuth requests only `gmail.readonly`; the current surface can list/search
  mail and open bounded plain-text message bodies. It cannot compose, send,
  delete, archive, modify labels, load remote HTML, or fetch attachments.
- Desktop stores the scoped token only in the profile's encrypted main-process
  store. Inbox/message calls run in `electron/authBridge.cjs`; only normalized
  headers, snippets, labels, dates, and plain text cross IPC.
- Web/PWA and Capacitor store only an opaque `YayraGmail` capability. The Worker
  keeps AES-GCM-encrypted credentials in KV, checks exact origin and scope,
  refreshes server-side, proxies bounded Gmail API responses, and returns no
  Google token.
- Message content is rendered with `textContent`, never injected as email HTML.
  Script/style markup is stripped from HTML-only fallbacks before it leaves the
  privileged bridge/Worker. API responses and UI state are `no-store` and are
  not written to Yayra history or the document catalog.
- A missing, denied, expired, revoked, or unconfigured Gmail grant produces an
  explicit reconnect/error state; it never falls back to a fake web-cookie
  session.

The Gmail API must be enabled in the Google Cloud project. `gmail.readonly` is a
sensitive/restricted Gmail scope under Google's current policy; production use
may require OAuth verification, a privacy policy, and any security assessment
Google requires. Keep the OAuth app in Testing with explicit test users until
those requirements are complete.

## Google services session and visible account reflection

The new **Google services in Yayra** page (`yayra://google-services`) is a
Google-account connection for using Google products, not merely a Yayra
personalization identity. It starts from **Continue with Google**, uses Yayra's
per-profile real Chrome as the external user-agent when available (otherwise
the OS default browser), and returns through the same verified PKCE callback.
On return:

- the exact account chosen in Chrome/Safari is persisted per Yayra browsing
  profile and survives restart;
- Google product pages opened in Yayra receive a Yayra-owned connected-account
  strip with the exact email. It never rewrites Google's own Sign in button,
  avatar, or account menu; the strip reports only Yayra's OAuth identity and
  does not claim that this WebContentsView has Google's website cookies;
- on desktop, Google product tiles open in that same real Chrome profile by
  default; Web/PWA/mobile keep their existing in-Yayra/API or external-browser
  behavior. Gmail's explicit **Open Gmail in Yayra** action uses the bounded
  read-only mailbox. The hub includes the app-launcher products visible in the
  Google apps menu (including Blogger, Saved, Arts & Culture and Merchant
  Center) so they share this same signed-in Chrome profile; only products with
  an explicitly supported read-only Google API expose an in-Yayra data preview;
- API-backed services expose real, normalized account data through the
  privileged main process or Worker. No Google page cookie is copied and no
  Google token is exposed to page JavaScript;
- if Google redirects a product back to `ServiceLogin`, Yayra returns to the
  services hub with the connected account instead of starting a second consent
  loop or masquerading an unauthenticated page as cookie-authenticated.

The reflection is deliberately truthful: it identifies itself as a Yayra
connection and never creates a fake Google avatar menu or claims Google web
cookies were imported. Google pages that require their own cookie session may
still show Google-controlled account UI; Yayra's connected strip and services
hub remain visible and use OAuth/API-backed data where Google provides it.

The broad consent currently requests these read-only scopes in addition to
`openid email profile`:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/contacts.readonly
https://www.googleapis.com/auth/photoslibrary.readonly
https://www.googleapis.com/auth/tasks.readonly
https://www.googleapis.com/auth/classroom.courses.readonly
```

Google may require API enablement, consent-screen verification, test users,
privacy-policy review, and a security assessment for restricted scopes.
Deployments that cannot obtain approval can keep the hub connection enabled
but should document that some API previews will return `service_scope_required`
until the corresponding scope is granted. Product links, the exact account
indicator, Gmail's read-only view, Drive download fallback, and ordinary
Google browsing do not depend on every optional preview scope.

Desktop stores these credentials in the same encrypted per-profile auth store.
Web/PWA and mobile receive only a random 43-character `YayraServices`
capability; the Worker stores AES-GCM-encrypted, origin-bound Google tokens
under `google-services-session:` keys and exposes only normalized service items
through `/api/google/services`. `/api/google/services/session/revoke` deletes
the local capability before best-effort provider revocation.

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
8. Gmail initiation starts a distinct `gmail.readonly` consent. Inbox and
   message requests stay in the main process; only normalized, bounded message
   data crosses IPC into the read-only Gmail surface.
9. Drive recovery starts a distinct consent with `drive.readonly`; Drive
   metadata, refresh, download/export, and revocation stay in the main process.
   Only bounded file bytes and safe metadata cross IPC.
10. Token material is encrypted at rest with Electron `safeStorage`
   (Keychain/libsecret/DPAPI). If OS-backed encryption is unavailable, tokens
   are not written in plaintext.
11. App identity, Gmail, and Drive credentials are scoped to the browsing profile
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
  IPC, encrypted scoped Gmail/Drive refresh and API operations, and credential
  revocation.
- `src/services/googleServiceCatalog.js` — exact allow-list of Google product
  destinations, read-only API URLs, scopes, and normalized display fields.
- `electron/webviewBridge.cjs` — profile-bound connected-account reflection in
  native Google pages and the new privacy/security network policy.
- `electron/authStore.cjs` — per-profile, OS-keychain-backed encrypted token
  persistence with legacy-default migration.
- `electron/googleAuthConfig.cjs` — desktop client configuration.
- `tests/google-oauth.test.mjs`, `tests/google-auth-bridge.test.mjs`, and
  `tests/google-auth-store.test.mjs` — automated coverage.

### Desktop Google Cloud setup

1. Create/select a Google Cloud project.
2. Enable the Gmail, Drive, Calendar, YouTube Data, People, Photos Library,
   Tasks, and Classroom APIs for Google services previews (or only the APIs
   your deployment will use). Configure the OAuth consent screen for
   `openid`, `email`, `profile`, and the enumerated read-only scopes shown
   above. Add test users while the app remains in Testing
   mode and complete Google's verification/security requirements before broad
   production use.
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
6. For separate Gmail/Drive read-only capabilities, the Worker encrypts scoped
   Google credentials into the delegated-session KV and returns the profile
   plus only a capability-specific opaque origin-bound session ID.
7. The display profile and opaque Gmail/Drive capabilities survive app/browser
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
  - `https://yayra.app` (production custom domain)
  - `https://yayra.pages.dev` (Cloudflare Pages deployment URL)
  - `http://localhost:4173` (local development only)
- Authorized redirect URIs:
  - `https://yayra.app/auth/callback`
  - `https://yayra.pages.dev/auth/callback`
  - `http://localhost:4173/auth/callback` (local development only)

In Google Auth Platform → Branding, use the deployed product information pages:

- Application home page: `https://yayra.app/about/`
- Privacy policy: `https://yayra.app/privacy/`
- Terms of Service: `https://yayra.app/terms/`
- Authorized domain: `yayra.app` (verify domain ownership in Search Console first)
- Developer contact: `support@yayra.app`

The static policy pages are part of `public/` and are included in the web build.
Deploy the Pages site before submitting these links to Google, and verify each
URL opens publicly over HTTPS without a sign-in. Add `https://yayra.app` to the
Worker's exact `GOOGLE_WEB_ALLOWED_ORIGINS` list and deploy the Worker too; do
not use a wildcard origin.

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
   Gmail or Drive consent returns that profile plus an opaque scoped Worker
   session.
5. The verified profile and opaque Gmail/Drive capabilities persist across app
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

`worker/update-worker.mjs` exposes `POST/OPTIONS /auth/google/exchange`, the
Drive download/revoke routes, and `GET/OPTIONS /api/gmail/messages`,
`GET/OPTIONS /api/gmail/message`, plus `POST/OPTIONS
/api/gmail/session/revoke`. It enforces:

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
  request-origin binding, capability-specific Gmail/Drive scope and
  authorization-scheme checks, bounded Gmail/message and Drive/download
  handling, and Workspace export allowlisting;
- delete-before-provider-revoke logout semantics, so an unavailable Google
  revocation endpoint cannot leave a Yayra capability active;
- no token fields in any client response or log.

The non-secret origin variables in `wrangler.worker.toml` are:

```toml
GOOGLE_WEB_ALLOWED_ORIGINS = "https://yayra.app,https://yayra.pages.dev,http://localhost:4173"
GOOGLE_NATIVE_ALLOWED_ORIGINS = "https://localhost,http://localhost,capacitor://localhost"
```

Add a custom deployment only as an exact origin and register its exact
`/auth/callback` URI with the same Google Web client.

Delegated Gmail and Drive sessions require a KV namespace and an independent
high-entropy encryption secret. The existing binding names retain
`GOOGLE_DRIVE_` for deployment compatibility, but the namespace stores
capability-prefixed (`gmail-session:` / `drive-session:`) encrypted records.
Create it once (production and local preview may use separate namespaces):

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
Gmail and Drive capabilities; users reconnect on demand. Deleting the KV namespace has
the same session-invalidating effect. Do not reuse a Google client secret,
Cloudflare token, NVIDIA key, or application signing key.

Verify bindings without printing secret values:

```bash
npx --yes wrangler@4 kv namespace list
npx --yes wrangler@4 secret list --config wrangler.worker.toml
```

The Worker returns `501 drive_session_not_configured` or
`gmail_session_not_configured` until KV supports `get`/`put`/`delete` and the
encryption secret is present, rather than silently falling back to insecure
storage. See `docs/CLOUDFLARE.md` for deploy order.

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
| XSS through profile/email fields | Profile and Gmail schema/length validation; profile escaping; email HTML is never mounted and message text uses `textContent`. |
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
6. From a signed-out Gmail tab, trigger its `/ServiceLogin` redirect. Select a
   Chrome account and grant `gmail.readonly`. Confirm the raw ServiceLogin URL
   is not reopened, the exact source Gmail URL/history stays in the initiating
   Yayra tab, the selected email appears in the Gmail header, and inbox/message
   reading resumes automatically inside Yayra.
7. Trigger a third-party Google OAuth URL with its own `client_id`. Confirm it
   still opens unchanged in the system browser and is not replaced by Yayra's
   first-party callback.
8. Open a captured `/v3/signin/rejected?...continue=...` URL. Confirm it enters
   the Yayra connection surface, validates a bounded Google-owned continuation,
   and restores that destination's exact safe path/query/fragment inside Yayra
   without reopening the rejected page.
9. Open a permitted `drive.google.com/uc?export=download&id=...` file. Confirm
   native cookie/redirect download is attempted first; if recovery is needed,
   grant Drive-readonly, download through the API, and verify the file opens in
   Yayra/Documents without a false site-failure page.
10. Restart Yayra and reopen Gmail plus a Drive action without reconnecting.
    Confirm each stays in the initiating browsing profile. Then sign out and
    confirm both capabilities require consent; inspect renderer IPC to confirm
    no token-shaped value crossed it.

### Web / PWA

1. Test both `http://localhost:4173` and `https://yayra.pages.dev`, including
   an installed standalone PWA.
2. Confirm callback state is single-use, stale transactions expire, Back does
   not replay exchange, and cancellation shows a clear message.
3. Confirm an unlisted Origin gets no auth CORS permission.
4. Complete separate Gmail/Drive read-only consents, reload and restart the
   installed PWA, and confirm Gmail reopens inside Yayra and a trusted Drive
   file still downloads while local storage contains only opaque 43-character
   sessions.
5. Sign out, verify both delegated revoke routes delete their KV records, and
   confirm replaying either former capability returns 401. Also test a
   different allowed Origin and confirm origin mismatch returns 403 without
   deletion.

### Android / iOS

1. Build with the matching platform client ID and signing identity.
2. Confirm app identity opens Custom Tabs/iOS browser and returns via
   `com.yayra.app:/oauth2redirect`.
3. Test wrong-state, prefix-confusable, duplicate, token-bearing, unrelated,
   canceled, and timed-out callbacks.
4. Navigate to Gmail/Google Account sign-in from a native website tab. Confirm
   the WebView cancels the interactive route, the platform OAuth adapter
   returns the verified profile by deep link, the exact selected email appears,
   and Gmail resumes through the in-Yayra API surface at the original product
   URL/history.
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

## Real Google website sign-in (v1.0.85)

Yayra's OAuth app identity is not a Google website cookie session. To make
Gmail, Drive and `myaccount.google.com` genuinely signed in, desktop Yayra now
launches a **dedicated real Chrome profile** (`--user-data-dir` per Yayra
browsing profile). Google website cookies — including 2026 DBSC-bound sessions —
are created and kept by that real Chrome, never copied into Electron. The
dedicated Chrome is also used as the RFC 8252 external user-agent for the Google
services consent, so the loopback callback still returns only the code/state
and the verified identity behaves exactly as before. Use **Connect & open Google
Account** / **Continue with Google** when you want both the real website session
and the exact verified email reflected in Yayra. Opening `myaccount.google.com`
directly creates/reuses the website session but cannot report the selected
email back into the app.

Only exact HTTPS Google-owned destinations can be launched; automation, remote
debugging, headless, custom-UA and extension-loading flags are rejected in
`unsafeChromeFlag()`. Binary discovery is an allowlist of per-OS install paths.
If no Chrome/Edge/Chromium is installed, Yayra reports
`chrome_binary_not_found` and falls back to the OS browser.

An opt-in, per-profile **standalone-browser parity** mode additionally removes
the embedded-browser signals Google documents (script injection, header
rewriting, inconsistent client hints, non-native WebAuthn) from first-party
Google sign-in pages, shows a main-process-verified origin badge, and falls back
to the dedicated Chrome profile if Google rejects the attempt with
`/signin/rejected`. Google does not publish an allowlist, so this cannot be
guaranteed. Third-party OAuth remains in the external browser; the existing
Yayra account sign-in, Gmail/Drive API surfaces, Worker and mobile adapters are
unchanged. Web/PWA/mobile cannot launch a separate Chrome process and report
that honestly.

Manual QA still required on a packaged desktop build: install Chrome, open
`yayra://settings` → Privacy & Security → Google sign-in, enable parity, click
Google's blue **Sign in**, and confirm either a successful in-Yayra sign-in or
an automatic handoff to the dedicated Chrome profile. Then restart Yayra and
confirm Google Account/Gmail/Drive remain signed in the Chrome profile and that
the exact email is still shown in Yayra. Coverage:
`tests/google-chrome-profile.test.mjs`.
