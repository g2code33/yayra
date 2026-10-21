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

- [ ] **Desktop (Linux + Windows):** Settings → Account opens the OS default
  browser, never an Electron window or embedded tab. Approve, verify the
  one-shot loopback page changes its address to `/complete`, return to Yayra,
  and confirm the profile appears, survives relaunch, and sign-out clears it.
- [ ] **Web (`yayra.pages.dev`):** deploy Worker secrets; test a normal tab and
  installed PWA. Cancellation must be clear, Back must not replay exchange,
  and a callback older than ten minutes must be rejected.
- [ ] **Android:** Custom Tab (not WebView) opens and the exact
  `com.yayra.app:/oauth2redirect` code/state callback returns to the app. Test
  debug, release/upload, and Play App Signing SHA-1 identities.
- [ ] **iOS:** secure browser surface opens and the same exact callback checks
  pass for the `com.yayra.app` bundle.
- [ ] Negative paths: wrong state, duplicate parameters, path/scheme
  lookalikes, token-bearing custom URLs, wrong redirect, no browser handler,
  timeout, cancellation, and airplane mode all fail without creating a
  session or leaving a spinner.

## 1a. Google Account, Gmail, and product browsing (separate from app OAuth)

- [ ] **Electron priority return loop:** type `accounts.google.com`. No native
  `ERR_FAILED` page may appear. The OS browser must run Yayra OAuth once; after
  loopback, Yayra comes to the front, its avatar/profile updates, and the tab
  says “Google is connected to Yayra”. Re-renders/Retry must not reopen OAuth.
- [ ] **Gmail/product redirect:** from signed-out Gmail, let Google request
  `/ServiceLogin`. The raw login URL must not be opened with no return channel.
  Yayra OAuth returns the profile while preserving the Gmail tab URL/history;
  its connected card continues only to `https://mail.google.com/`.
- [ ] **Android/iOS:** repeat from Gmail and Google Account in the native
  website engine. WebView cancels interactive sign-in, the platform OAuth
  adapter returns by exact app deep link, and the Yayra avatar/card updates.
- [ ] Open a captured `https://accounts.google.com/v3/signin/rejected?...`
  URL. It must enter Yayra's connection surface, not reopen the rejection or a
  callback-less ServiceLogin. Only a safe Google-product origin may survive.
- [ ] Trigger **Continue with Google** on a third-party website. Its original
  client ID/callback must remain external and must not be replaced with Yayra
  OAuth. Do not expect or fake cookie transfer into the untouched embedded tab.
- [ ] Confirm no auth event/renderer log contains authorization URL state, an
  access token, refresh token, ID token, or PKCE verifier.
- [ ] **Electron live-surface regression:** on an already-open website, focus
  the address bar, type a Google query, wait until suggestions are visible,
  then press Enter. Results must remain live and scroll/click immediately;
  never accept a static image or Refresh workaround.
- [ ] **Web/PWA:** verify Google pages that refuse framing open in a real tab;
  a PWA cannot override the remote site's frame policy.
- [ ] Never “fix” provider rejection by copying browser cookies, stripping
  security checks, spoofing browser identity, or putting bearer tokens in a
  custom-scheme URL.

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

## 1c. Offline and failed-site recovery

- [ ] **Electron desktop:** open a new site, disconnect Wi-Fi while it is
  loading, and confirm Yayra replaces the native surface with its own **No
  internet** page—not white/blank content. The address bar must retain the
  complete requested URL and Back must remain available.
- [ ] Confirm the page includes practical network checks,
  `ERR_INTERNET_DISCONNECTED`, **Try again**, and automatic-retry status. Leave
  the machine offline through several attempts; there must be no overlapping
  loads, stuck X/loading icon, or progressively faster retry loop.
- [ ] Reconnect without clicking anything. The active failed URL must reload
  immediately in the same tab/profile and the recovery page must remain until
  the real main frame finishes. Cookies/login/history and sibling tabs must
  remain intact.
- [ ] Repeat with two failed tabs. Connectivity restoration may retry only the
  active failed tab; a failed background tab must not churn invisibly. Switch
  to it and confirm its retained URL recovers. Also keep a healthy loaded page
  open while toggling the connection; that page must never be refreshed or
  replaced by the offline UI.
- [ ] Test DNS failure, connection refusal, and timeout while the device itself
  remains online. The generic **This site can’t be reached** surface must stay
  readable and continue capped retries until success or explicit navigation.
- [ ] Repeat on a physical Android device (native in-app WebView) and in the
  installed PWA/web build. On Android, include a URL that redirects after the
  connection returns: the final redirected page must replace recovery UI. On
  Electron, confirm Chromium's own completed network-error document does not
  dismiss Yayra's recovery page. Close a failed tab and navigate a failed tab
  to a new URL; no old retry may fire afterward.

## 1d. Third-party gradient-text compatibility

- [ ] Open a site that uses `.gradient-text` or
  `bg-clip-text text-transparent` on a heading. Confirm the gradient is clipped
  to the glyphs and never paints the heading's full rectangular box.
- [ ] Repeat in an engine/device without unprefixed `background-clip: text`
  support. The WebKit-prefixed form should be used when available; otherwise
  the gradient must disappear and the words must remain readable in a solid,
  contrast-safe colour.
- [ ] Trigger a client-side route or toggle classes/styles after load. The same
  correction must happen live without refresh. Verify nearby opaque gradient
  panels, transparent decorative layers, icons, masks, and hidden accessibility
  content are unchanged. Repeat in Electron and an Android native website tab.

## 1e. PowerPoint compact toolbar and overflow

- [ ] Open a PPTX in dark and light themes. The first identity row must stay
  approximately 36 px high, the controls row must stay compact, and the slide
  must receive the reclaimed vertical space without clipped controls.
- [ ] Open the three-dot presentation menu. All actions must remain bright and
  readable on its dark surface. Hover/focus **Desktop app** and neighboring
  actions: no large native tooltip may cover another row. Screen-reader output
  must still announce each action and its longer explanation.
- [ ] Hover, keyboard-focus, and press **Download**, both **Present** controls,
  and **Print** in both themes. Every label must stay fully opaque and readable;
  no accent/selected state may become dark-on-dark or washed out.
- [ ] Compare a light-background slide containing an uncoloured table in normal
  view and slideshow view. Every table heading/cell must remain equally visible.
  Repeat with a dark slide and light/dark filled cells to confirm automatic text
  receives a readable fallback without changing explicitly authored colours.
- [ ] Exercise Present from beginning, visible Download and Print, Desktop app,
  Close presentation, notes colour, slide navigation, search, zoom, thumbnails,
  notes, and projector mode to confirm the density/contrast change did not
  alter behavior.

## 1f. Document download, print, and presentation actions

- [ ] Open representative PPTX, DOCX, PDF, and PNG files. Each integrated
  viewer must keep rendering inside Yayra and show direct **Download** and
  **Print** actions without opening its three-dot menu.
- [ ] Download each file and compare it byte-for-byte (for example with
  `sha256sum`) to the source. Repeat with `Ctrl+S`. On desktop, cancel the Save
  dialog and verify no file or misleading success notice appears. **Desktop
  app** must still open the OS handler and remain distinct from Download.
- [ ] Print a multi-page PDF after scrolling far enough to evict early canvases;
  the print preview must contain every page in order. Cancel, then confirm
  scrolling/search still work and no print-only content remains onscreen.
- [ ] Print a multi-slide PPTX before visiting every thumbnail. The print
  preview must contain every slide once, in deck order and landscape
  proportions. Cancel/finish, then confirm the viewer returns to its previous
  selected slide with media, thumbnails, notes, search, zoom and navigation
  intact.
- [ ] Print DOCX and PNG samples and confirm the rendered document/image—not
  browser chrome—is in preview. Exercise `Ctrl+P` as well as the button.
- [ ] Select a middle PowerPoint slide: the top **Present** and `F5` must start
  at slide 1; lower **From current slide** and `Shift+F5` must start at the
  selected slide. Repeat the equivalent first/current-page checks for PDF.

## 1g. Tab reorder and downward tear-off

- [ ] With at least five website tabs, drag tabs repeatedly left and right,
  including across several neighbors and to both ends. Order, active tab,
  live page state, close buttons, horizontal scrolling, and ordinary click/
  middle-click/context-menu behavior must remain correct.
- [ ] Drag an HTTP(S) tab deliberately below the tab strip. A new Yayra window
  must open at the exact current URL; only after that succeeds may the source
  tab close. The gesture hint must clear on release/cancel and a normal small
  downward movement must not detach anything.
- [ ] Repeat from a named profile and confirm its destination keeps that
  profile’s login state without leaking it to another profile. Repeat from a
  private tab and confirm the destination remains private and excluded from
  history/session restore. Exercise **Move Tab to New Window** in the tab
  context menu for keyboard/accessibility coverage.
- [ ] Attempt the downward gesture on a new-tab page, Documents hub, and active
  local document. None may be silently detached or lose its in-memory state.
  Horizontal reordering must still work for those tabs.
- [ ] Close the destination window, keep interacting with both source and
  sibling tabs, and repeat detachment several times. Verify no duplicate/lost
  tabs, frozen titlebar, stuck pointer capture, hidden native surface, or
  orphan process remains.

## 1h. Text pointer, highlighting, and contextual actions

- [ ] With **Yayra** and **High visibility** pointer themes, hover readable
  text, blank space, a link, a button label, and text fields. Expect the OS
  I-beam, arrow, hand, hand, and I-beam respectively at every configured size.
- [ ] Drag-highlight text in Settings, History, DOCX/PPTX content, and several
  Electron websites (including text in a child frame). The selection must stay
  visible and a compact **Copy / Search / Ask Yayra AI** bar must appear beside
  it; editable selections also show **Cut / Paste**.
- [ ] Exercise every action, including clipboard permission denial. Search and
  Ask AI must open a fresh tab and preserve private mode; Cut/Paste must replace
  exactly the editable range. No password-field content may enter the bar.
- [ ] Ignore the bar and click elsewhere. It must close without consuming that
  click. Repeat with Escape, scrolling, tab navigation, window blur, touch
  long-press, and shell close; no stale toolbar or blocked page may remain.
- [ ] On Android, verify touch selection handles and the native WebView action
  mode still appear after long-press. With a mouse/stylus, normal text uses the
  I-beam rather than Yayra's hand cursor.

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
