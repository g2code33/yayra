# Yayra Security Center

Yayra v1.0.84 adds a Chrome-style, fully wired **Privacy and security** center
under `yayra://settings` → **Privacy & Security**. The screenshot-equivalent
pages and controls are implemented in the shared browser shell and, on desktop,
enforced by Chromium `Session` / `WebRequest` policy in the trusted main
process.

## Pages and working controls

| Destination | What it does |
| --- | --- |
| Overview | Safety Check, Privacy Guide, Delete browsing data, Third-party cookies, Ad privacy, Site settings, Security, core protection toggles, Maximum protection |
| Privacy Guide | Six guided steps: welcome, browsing quality, threat protection, cookie choice, privacy signals, review complete; Back/Next/Done and every step control works |
| Delete browsing data | Last 15 min, hour, 24 hours, 7 days, All time; history, cookies/site data, cached files, autofill; real bounded clearing |
| Third-party cookies | Block/allow policy, DNT, GPC, trusted site exceptions, link to stored site data |
| Site settings | Recent activity, permissions, data stored across sites, JavaScript, images, pop-ups, automatic permission cleanup |
| See all site data | Desktop Chromium cookie inventory, per-site search/delete, delete displayed data, refresh |
| Security | Enhanced/standard/off threat protection, HTTPS-First, secure DNS provider, local weak/reused password checkup, JavaScript gate, vault and certificate guidance |
| Ad privacy | Ad topics, site-suggested ads, ad measurement, DNT and GPC |
| Ad topics / Site-suggested ads / Ad measurement | Individual toggles and blocked-site management |
| Permissions | Ask/allow/block defaults for location, camera, microphone, notifications, clipboard, MIDI, USB, serial, Bluetooth, HID, pointer lock and idle detection; saved per-site decisions |

Every choice is normalized, profile-scoped, persisted immediately, and applied
without requiring a Save button. Destructive actions use explicit user
confirmation. A non-desktop build does not fake native site-data or DNS
operations; it reports the honest fallback.

## Main-process enforcement

`electron/privacyShield.cjs` owns policy normalization and pure decision
functions. `electron/webviewBridge.cjs` composes those decisions into one
`WebRequest` listener per Electron `Session` (Electron would otherwise let a
later listener replace an earlier one). The same module handles native
permission prompts.

Enforced features:

- **HTTPS-First:** top-level `http://` navigations are upgraded before request,
  except loopback/local hosts.
- **Threat protection:** enhanced mode blocks malformed destinations,
  credential-in-URL traps, impossible hostnames, suspicious IDN/login patterns,
  oversized URLs and speculative preload requests locally. Standard mode keeps
  tracker blocking and HTTPS checks. No visited URL is sent to a reputation
  service by Yayra.
- **Tracker/ad shield:** a local host allow-list plus user-blocked sites cancels
  known advertising, analytics and telemetry endpoints.
- **Third-party cookies:** cross-site `Cookie` request headers and `Set-Cookie`
  response headers are stripped. Exceptions are exact host suffixes and are
  sanitized. First-party cookies remain intact.
- **Privacy signals:** `DNT: 1` and `Sec-GPC: 1` are attached when enabled; ad
  topics, ad auction, and attribution-reporting headers are removed when the
  corresponding privacy APIs are off.
- **Secure DNS:** `app.configureHostResolver()` takes only one of the built-in
  audited providers (automatic, Cloudflare, Google, Quad9) or off. Renderer
  code cannot supply an arbitrary resolver URL.
- **JavaScript/images/popups:** native views receive the JavaScript policy,
  image requests can be canceled, and non-tab popup dispositions are blocked
  unless explicitly allowed.
- **Permissions:** sensitive capabilities fail closed for unknown origins and
  show a trusted native Yayra prompt. “Always allow” / “Block” decisions are
  profile-scoped; automatic cleanup clears runtime decisions.
- **Safety Check:** reports the active policy plus real session counters for
  blocked trackers, cross-site cookies and unsafe requests. Password Checkup
  scans decrypted local vault entries in memory for weak/common/reused
  passwords and never uploads them.

## Clear browsing data

Desktop clearing covers the shell session, every live profile/incognito
partition, and the legacy auth partition. All-time deletion clears cache,
cookies, local storage, IndexedDB, service workers, WebSQL, history and
selected autofill. Time-limited deletion removes matching cookies and history;
Electron cannot age-filter IndexedDB, so Yayra intentionally preserves it
instead of over-deleting. Web/PWA uses its local privacy manager and states
that limitation truthfully.

## Design boundaries

- Profile settings are local user data: every field is normalized before it can
  affect Chromium. Malformed permission choices fail closed.
- Cookies, site storage, capabilities, permissions and browsing-history actions
  are scoped to the trusted Yayra profile/window. A renderer-supplied profile
  cannot read another partition's cookies.
- Native page enhancement uses only verified account email/name. Google tokens
  never enter the page injection script, and the injected account marker is
  explicitly branded as a Yayra connection.
- Yayra's threat protection is on-device hardening, not a claim that Google's
  proprietary cloud Safe Browsing database is embedded in Electron.
- All existing browser/document/recovery/privacy features remain available;
  these controls extend rather than replace the existing `PrivacyManager`.

Automated coverage lives in `tests/security-privacy-center.test.mjs`,
`tests/worker.test.mjs`, `tests/electron-webview-bridge.test.mjs`, and the
broader regression suite.

## Google sign-in (v1.0.85)

The Security Center gained a **Google sign-in** page for real Google website
sessions. It has two independent, clearly separated mechanisms:

1. **Dedicated real Chrome profile (guaranteed, desktop only).** Yayra launches
   a real Chrome/Chromium/Edge process with its own `--user-data-dir` per Yayra
   profile. Google's real website cookies live there and survive restarts. No
   cookies are read, decrypted or copied; only exact HTTPS Google-owned
   destinations can be opened; launch arguments reject automation and debugging
   flags. The OAuth loopback callback still returns the verified app identity to
   Yayra's main process, so one sign-in produces both results. Yayra's own
   account sign-in is unchanged.
2. **Standalone-browser parity (best effort, opt-in per profile, off by
   default).** On `accounts.google.com`, `consent.google.com` and
   `myaccount.google.com`: honest `Sec-CH-UA` client hints from the real
   Chromium version (never a spoofed Google Chrome brand), no page-script
   injection (the whole autofill preload is gated), no request/response header
   rewriting (tracker/cookie/DNT/GPC/cache rules bypassed), and no injected
   WebAuthn shim. The virtual passkey provider is detached; Electron's
   app-mediated passkey-account chooser is not shown on Google's auth page, so
   that case hands off to the dedicated real Chrome profile. A main-process-
   reported origin badge appears in browser chrome. If Google responds with
   `/signin/rejected` or `disallowed_useragent`, Yayra opens a fresh
   `ServiceLogin` in the dedicated Chrome profile and tells the user honestly.

Third-party OAuth authorization requests always stay in the external browser.
Privacy Shield, permission policy, site-data controls and every other setting
remain fully active on all other origins. Google does not publish a browser
allowlist, so parity cannot guarantee acceptance; the dedicated Chrome profile
is the reliable path.

Both settings (`googleAuthParity`, `googleOpenInChromeProfile`) are normalized,
profile-scoped and persisted with the rest of the Security Center settings.
Coverage lives in `tests/google-chrome-profile.test.mjs`.
