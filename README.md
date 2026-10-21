# Yayra — Modern Cross-Platform Floating Browser

**Yayra** is a local-first, privacy-respecting cross-platform floating browser supporting **Android**, **Windows (64-bit)**, and **Debian-based Linux (64-bit)**.

Yayra provides a floating glassmorphism bubble and a draggable, resizable browser window with native hardware-accelerated web engines per platform, zero mandatory cloud accounts, and dual desktop floating behavior.

---

## 1. Key Features

* **Three-Platform Support**:
  * **Android**: Standalone APK and Google Play Android App Bundle (AAB).
  * **Windows**: 64-bit NSIS Setup EXE, Portable EXE, and 64-bit MSI.
  * **Linux**: Native 64-bit Debian DEB package (`.deb`) and AppImage (no mandatory Snap requirement).
* **System-Wide Floating Bubble**:
  * Persistent glassmorphism circle with edge-docking physics and notification badges.
  * System-wide overlay on Android via `SYSTEM_ALERT_WINDOW` & Foreground Service.
  * Top-most borderless transparent layered windows on Windows and Linux.
* **Draggable & Resizable Browser Window**:
  * Fluid expansion from and minimization into the floating circle.
  * Glassmorphism acrylic design tokens, custom window controls, and corner resize grips.
* **Dual Desktop Floating Modes (Windows & Linux)**:
  * **Circle-First Mode**: Floating circle resides on desktop; clicking expands the browser window; closing browser returns focus to circle.
  * **Browser-First Mode**: Floating browser window resides on desktop; minimizing docks it into the floating circle; clicking circle restores the window.
  * Configurable by the user in Settings and saved to local persistence.
* **Native Platform Browser Engines**:
  * **Android**: `android.webkit.WebView` (Chromium Blink) with GeckoView alternative abstraction.
  * **Windows**: Microsoft Edge WebView2 Evergreen runtime.
  * **Linux**: WebKitGTK 4.1 / 6.0 (`libwebkit2gtk-4.1-0`).
* **Standards-Based Website Passkeys (Electron desktop)**:
  * Recognizes real WebAuthn create/sign-in requests at document start and keeps Chromium, the OS authenticator, or the user's FIDO security key in control.
  * On supported Linux sessions, an encrypted, profile-scoped CTAP2 platform authenticator releases the site's native request only after a one-shot verification by the configured Yayra passkey (PIN/Touch ID/system lock), with PolicyKit as an explicit fallback.
  * RP-aware credential checks, native discoverable-account selection, active cancellation, a terminal completion timeout, live status, and an honest system-browser fallback prevent silent or indefinite waits.
  * Ceremony secrets never enter Yayra's renderer. The Yayra vault passkey authorizes one exact request but is never substituted for the site's separate origin/RP-bound credential.
* **Local-First & Privacy First**:
  * 100% offline functionality. Zero mandatory cloud backend, user account, or subscription fees.
  * Encrypted/indexed history, bookmark trees, session recovery, and user settings stored locally.

---

## 2. Project Architecture

The codebase follows a decoupled modular architecture:

```
yayra/
├── packages/
│   ├── shared-core/          # State machine, event bus, tab/window coordination, lifecycle
│   ├── shared-ui/            # Glassmorphism design system, floating circle & window components
│   ├── browser-contract/     # IBrowserEngine, IBrowserSession, ISecurityPolicy contracts
│   ├── browser-android/      # Native Android WebView bridge & memory leak protection
│   ├── browser-windows/      # Windows WebView2 Win32 bridge & direct composition
│   ├── browser-linux/        # Linux WebKitGTK bridge & process sandbox
│   ├── floating-android/     # Android WindowManager overlay & Foreground Service specs
│   ├── floating-windows/     # Windows DWM Acrylic/Mica & Win32 floating controllers
│   ├── floating-linux/       # Linux GTK RGBA visual & X11/Wayland layer controllers
│   ├── persistence/          # Local-first storage adapters, history, bookmarks, settings
│   └── platform-packaging/   # Android (APK/AAB), Windows (EXE/MSI), Linux (DEB) configs
├── src/                      # Web/Electron renderer integration
├── scripts/                  # CI, branding generator, packaging & verification scripts
├── docs/                     # Architecture Decision Records (ADRs) & documentation
└── tests/                    # Automated quality gates and contract unit tests
```

---

## 3. Architecture Documentation

Detailed architectural blueprints and decision records are available in `docs/`:
* [ADR 0001: Cross-Platform Architecture & Browser Engine Strategy](docs/adr/0001-cross-platform-architecture-and-browser-engine-strategy.md)
* [ADR 0002: Native Floating Window & Glassmorphism Overlay Strategy](docs/adr/0002-native-floating-window-and-glassmorphism-overlay-strategy.md)
* [ADR 0003: Local-First Persistence & Privacy Architecture](docs/adr/0003-local-first-persistence-and-privacy-architecture.md)
* [ADR 0004: Desktop Dual Floating Modes & Lifecycle Ownership](docs/adr/0004-desktop-dual-floating-modes-and-lifecycle-ownership.md)
* [ADR 0005: Platform Packaging & Distribution Matrix](docs/adr/0005-platform-packaging-and-distribution-matrix.md)
* [Platform Capability Matrix](docs/PLATFORM_CAPABILITY_MATRIX.md)
* [Dependency Inventory](docs/DEPENDENCY_INVENTORY.md)
* [Build Instructions](docs/BUILD_INSTRUCTIONS.md)
* [Development Roadmap](docs/ROADMAP.md)
* [Architecture Validation Checklist](docs/ARCHITECTURE_VALIDATION.md)

Production deployment (deploying your own instance requires your own
Cloudflare worker, Google OAuth client IDs, and signing keys):
* [Production Configuration — every env var, secret, and binding](docs/PRODUCTION_CONFIG.md)
* [Google Sign-In — per-platform architecture & console setup](docs/GOOGLE_SIGNIN.md)
* [Release Pipeline — CI/CD, artifacts, update manifest](docs/RELEASE-PIPELINE.md)
* [Code-Signing Requirements — certs/keys a human must obtain](docs/SIGNING_REQUIREMENTS.md)
* [App-Store Readiness Checklist](docs/STORE_READINESS.md)
* [Manual QA Checklist — what automation cannot verify](docs/MANUAL_QA_CHECKLIST.md)
* [Monitoring & Crash Reporting — current state and opt-in proposal](docs/MONITORING_AND_CRASH_REPORTING.md)
* [Production Readiness Plan — executed audit, item-by-item status](docs/PRODUCTION_READINESS_PLAN.md)

---

## 4. Local Quality Gates & Verification

Run the full automated CI gate suite:

```bash
npm ci
npm run ci:gates
```

Run unit tests directly:
```bash
npm test
```

Build native Linux DEB package:
```bash
./packages/platform-packaging/scripts/build-deb.sh
```

---

## 5. License
Local-first, free and open-source software.
