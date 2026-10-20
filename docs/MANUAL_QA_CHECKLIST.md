# Manual QA checklist — what this sandbox could NOT verify

Everything in this list requires a real machine/device/account. Items are
ordered so earlier failures invalidate later sections. The automated suite
(`npm test`) covers the logic behind all of this with mocks;
this list is the reality check.

## 0. Build sanity (any dev machine)

- [ ] `npm ci && npm test` — expect exactly one failure ONLY if the
  machine lacks `dpkg-deb` (the Linux packaging test); zero otherwise.
- [ ] `npm run ci:gates` passes end-to-end.
- [ ] **Electron 44 runtime smoke** (the 31→44 major upgrade was
  test-verified but never launched in the sandbox):
  `npm run build:web && npm run smoke:desktop` on Linux AND Windows.
  Then by hand: window chrome/controls, tab create/close, downloads
  panel, floating overlay bubble, settings persistence across relaunch,
  right-click context menu (incl. Back/Forward which now use
  `navigationHistory`).
- [ ] **Capacitor 8 native builds** (6→8 major upgrade): `npm run
  build:android` with Android Studio/SDK 35+ installed; `npm run
  build:ios` on macOS/Xcode 16+. Both were only `cap add`/`cap sync`
  verified in-sandbox.

## 1. Google sign-in — live round trips (per docs/GOOGLE_SIGNIN.md)

- [ ] **Desktop (Linux + Windows):** sign in via system browser, profile
  appears, survives relaunch, sign-out clears, "switch account" shows
  the Google account chooser.
- [ ] **Web (`yayra.pages.dev`):** worker secrets deployed; sign-in in a
  normal tab AND as installed PWA; cancel-on-consent shows a clear
  message; Back after sign-in does not re-run the callback; private
  window behaves (session gone on close).
- [ ] **Android (real device):** Custom Tab (not webview!) opens; app
  returns to foreground signed in; dismissal → clean "cancelled";
  works with the debug-keystore SHA-1 client AND the Play-signing
  SHA-1 client on a Play-internal-testing build.
- [ ] **iOS (real device):** SFSafariViewController flow, same checks.
- [ ] Negative: wrong/unregistered redirect URI shows Google's error (not
  a hang); airplane-mode sign-in fails with a readable error.

## 1a. Google account browsing inside Yayra (separate from app-level OAuth)

- [ ] **Electron desktop:** enter `https://accounts.google.com/`, an account-
  management URL, and `https://accounts.google.com/signin/v2/identifier` in
  the address bar. Confirm each remains in the same Yayra tab and renders in
  the native `WebContentsView` rather than being auto-sent to Chrome.
- [ ] If Google starts an OAuth authorization flow from one of those pages,
  confirm that the explicit OAuth request opens in the system browser. A
  canceled top-level redirect must leave the source tab URL/history intact,
  clear the loading indicator, and show the non-blocking handoff notice.
  Returning from the system browser must not reset the Yayra tab or leave a
  permanent spinner; do not assume its cookies/session transfer to Yayra.
- [ ] **Android:** repeat account-home, management, and basic sign-in
  navigation in the native in-app tab WebView. Confirm explicit OAuth routes
  use the system browser and the source tab remains selected.
- [ ] **Web/PWA:** verify the current open-in-new-tab fallback for Google
  account pages that refuse iframe embedding; a web page cannot override the
  remote site's frame policy.
- [ ] Record the exact URL and Google response if interactive sign-in is
  rejected inside the embedded view. Rendering an account page is not proof
  that Google permits OAuth sign-in there; do not work around a provider
  restriction by copying cookies or spoofing browser identity.

## 1b. Website passkeys / WebAuthn on physical authenticators

- [ ] On an HTTPS WebAuthn test site, start both registration
  (`navigator.credentials.create`) and authentication
  (`navigator.credentials.get`). Confirm the omnibox passkey indicator appears
  as soon as each call begins, the site's genuine Chromium/OS ceremony remains
  in control, success clears the indicator, and cancel/navigation clears it
  without a stale spinner.
- [ ] **Windows 10/11:** create and use a credential with Windows Hello; then
  repeat with a USB/NFC FIDO2 key. Verify discoverable credentials show the
  native account chooser and selecting or canceling completes exactly once.
- [ ] **macOS with a signed desktop build:** verify `codesign -d
  --entitlements :- <app>` contains a dedicated group ending in `.webauthn`.
  Confirm startup logs say Touch ID website passkeys are enabled, then create
  and use a device-bound Touch ID credential. An unsigned/unentitled build must
  report Touch ID unavailable rather than claiming support.
- [ ] **Linux local provider:** with a supported KWallet/libsecret keyring,
  keep DevTools closed and register a platform passkey on GitHub. Before the
  address-bar action, confirm the site's native WebAuthn call has not entered
  CTAP. Configure a 6-digit Yayra PIN under Passwords & Keys, authenticate on
  GitHub, click **Use Yayra passkey**, enter that PIN, and verify GitHub signs
  in without a Linux system-password prompt. Restart Yayra and repeat; the
  encrypted RP credential must persist in the same profile.
- [ ] Repeat with Yayra's Touch ID/system-lock verification method and with the
  explicit PolicyKit fallback. Cancel/wrong-PIN/lockout paths must never release
  presence. A verified request must move live from **Verify with Yayra** to
  **Completing with Yayra**, then success, cancellation, or an actionable
  timeout—never an indefinite state.
- [ ] **Linux fallback:** use a profile that has no local credential for the RP,
  open DevTools (which displaces the provider's single CDP session), use a
  security key that needs unsupported Electron PIN UI, or test without a strong
  keyring. Confirm no verification prompt is shown for a missing RP credential,
  the held call is canceled, and **Use system browser** opens the exact HTTPS
  page. A
  `collector.github.com/github/collect` refusal is GitHub telemetry and must
  not be reported as the WebAuthn failure.
- [ ] Start a conditional-mediation request and leave it idle. Confirm no
  unsolicited stuck-request banner appears. Test one and multiple discoverable
  accounts: selection must complete its Electron callback exactly once, reuse
  an already-finished Yayra verification for explicit requests, and remain
  deferred until verification for conditional discovery.
- [ ] Force Chromium/the test page not to settle after release. Confirm the
  main-process watchdog actively aborts the native request, clears UP/UV and
  changes the live UI to a timeout with retry/system-browser recovery.
- [ ] Inspect Electron renderer/main IPC while testing. Only lifecycle metadata
  and a short-lived opaque authorization token may cross Yayra chrome—never
  PINs beyond their dedicated verification IPC, challenge bytes, user handles,
  credential IDs, attestation, authenticator data, private keys, or signatures.
- [ ] Enable Yayra's separate vault-unlock passkey from the Passwords page.
  Confirm it may authorize one exact website ceremony, but is never offered or
  substituted as the website's origin/RP-bound WebAuthn credential.

## 2. Update pipeline — live (per docs/RELEASE-PIPELINE.md)

- [ ] Publish a real tagged release end-to-end (`release.yml`):
  artifacts + SHA256SUMS + `.sig` files + manifest reach GitHub/worker.
- [ ] Install version N on a machine, publish N+1, confirm: in-app
  update notice → download → sha256 verified → (with pinned key
  configured) signature verified → install path works.
- [ ] Tamper test: corrupt one byte of a staged artifact copy and
  confirm the client refuses it (`checksum:` / `signature:` error, old
  version keeps running).
- [ ] Staged rollout: set `rollout.percent: 1` in the worker manifest
  binding; confirm most devices report up-to-date and an allowlisted
  deviceId still updates.
- [ ] Rollback drill: publish a bad N+1, then N+2 with `minSupported`
  bumped; confirm N+1 devices get a forced update. (Remember: clients
  never downgrade — "rollback" always means shipping a higher version.)
- [ ] PWA: service-worker update prompt appears on next open after a
  Pages deploy; "reload" applies it.

## 3. Signed-artifact UX (per docs/SIGNING_REQUIREMENTS.md)

- [ ] Windows: signed installer on a clean VM — SmartScreen behavior
  acceptable; `signtool verify /pa` passes.
- [ ] Linux: `.deb` installs on clean Ubuntu/Debian; `.sig` verifies with
  the published public key; AppImage runs on a non-dev distro.
- [ ] Android: Play-internal-testing install (signed by Play) runs; APK
  sideload warns only about "unknown sources", nothing else.
- [ ] macOS/iOS: once those release jobs exist — Gatekeeper/TestFlight
  acceptance.

## 4. Store submissions (per docs/STORE_READINESS.md)

- [ ] Privacy policy URL live; consent screen brand verification done.
- [ ] Play data-safety + IARC forms submitted truthfully; AAB uploaded.
- [ ] App Store privacy labels; review notes explaining the browser UX.

## 5. Cross-cutting

- [ ] Fresh-profile first-run on every platform (no stale state from dev
  profiles).
- [ ] Non-English OS locale spot check (UI is EN, but OS dialogs/paths
  with spaces+unicode must not break downloads/updates).
- [ ] Corporate-proxy machine: desktop sign-in + update check still work
  (Electron `net.fetch` path — see GOOGLE_SIGNIN troubleshooting).
- [ ] Low-disk device: update download fails gracefully, old install
  intact.
