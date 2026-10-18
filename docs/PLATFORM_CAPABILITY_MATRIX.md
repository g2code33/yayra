# Yayra Platform Capability Matrix

| Feature / Capability | Android (API 24+ / Android 10–14) | Windows (10 / 11 64-bit) | Linux (Debian 11/12, Ubuntu 20.04–24.04) |
|---|---|---|---|
| **System-wide Floating Circle** | ✅ Supported (`TYPE_APPLICATION_OVERLAY`) | ✅ Supported (`WS_EX_LAYERED \| WS_EX_TOPMOST`) | ✅ Supported (`_NET_WM_STATE_ABOVE` / `wlr-layer-shell`) |
| **Draggable & Resizable Window** | ✅ Supported (Touch drag & corner resize) | ✅ Supported (`WM_NCHITTEST` & direct resize) | ✅ Supported (GTK motion events & resize grips) |
| **Glassmorphism Blur & Acrylic** | ✅ Supported (Hardware render layer + CSS backdrop filter) | ✅ Supported (DWM Acrylic / Mica system backdrop) | ✅ Supported (RGBA visual compositing + CSS filter) |
| **Edge Snapping Physics** | ✅ Supported (Spring physics to left/right edge) | ✅ Supported (Configurable docking margins) | ✅ Supported (Configurable docking margins) |
| **Dual Desktop Modes** | ⚡ Mobile-optimized Circle/Window toggle | ✅ Supported (Circle-First & Browser-First) | ✅ Supported (Circle-First & Browser-First) |
| **Native Browser Engine** | `android.webkit.WebView` (Chromium Blink) / GeckoView | Microsoft Edge WebView2 (Chromium) | WebKitGTK 4.1 / 6.0 |
| **Hardware Acceleration** | ✅ Enabled (`android:hardwareAccelerated="true"`) | ✅ Enabled (DirectComposition / Direct3D 11) | ✅ Enabled (DMABuf / EGL / OpenGL) |
| **Local-First Persistence** | ✅ IndexedDB / SQLite / SharedPreferences | ✅ IndexedDB / SQLite / Win32 AppData | ✅ IndexedDB / SQLite / XDG Data Directory |
| **Multi-tab Management** | ✅ Supported via `@yayra/shared-core` | ✅ Supported via `@yayra/shared-core` | ✅ Supported via `@yayra/shared-core` |
| **Incognito / Ephemeral Mode** | ✅ Supported (In-memory WebView partition) | ✅ Supported (In-memory WebView2 user data) | ✅ Supported (`webkit_website_data_manager_new_ephemeral`) |
| **Ad & Content Blocker** | ✅ Supported (URL filter contract) | ✅ Supported (URL filter contract) | ✅ Supported (URL filter contract) |
| **Required Permissions** | `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `INTERNET` | None (Standard user privileges `asInvoker`) | None (Standard user privileges) |
| **Packaging Formats** | **APK** (`.apk`) & **AAB** (`.aab`) | **64-bit EXE** (NSIS + Portable) & **64-bit MSI** | **64-bit DEB** (`.deb`) & **AppImage** |
| **Distribution Requirements** | Sideload APK / Google Play AAB | Standalone installer / Enterprise MSI | Debian APT repository / Standalone DEB / AppImage (No mandatory Snap) |

## Website passkeys in the Electron desktop shell

Website passkeys use Chromium's standards-based WebAuthn implementation. They are not implemented by Yayra's vault-unlock passkey and Yayra never substitutes its own credential into a website ceremony.

| WebAuthn path | Windows | macOS | Linux |
|---|---|---|---|
| Request recognition | ✅ At document start for genuine `navigator.credentials.create/get({ publicKey })` calls | ✅ Same | ✅ Same |
| Built-in platform authenticator | ✅ Windows Hello, when available to Chromium | ✅ Touch ID / Secure Enclave only when the signed app contains a dedicated `keychain-access-groups` entitlement; Yayra discovers that exact group and configures Electron after readiness | ➖ No Electron platform authenticator is advertised |
| USB/NFC roaming security key | ✅ Chromium WebAuthn path | ⚠️ Supported when the key can complete without Electron-supplied PIN UI | ⚠️ Supported when the key can complete without Electron-supplied PIN UI |
| Discoverable account selection | ✅ Native Yayra account chooser; callback completes exactly once | ✅ Same | ✅ Same |
| Conditional mediation | ✅ Remains passive and does not show a false stuck-request warning | ✅ Same | ✅ Same |
| Phone / synced / browser-owned hybrid flow | ↗ Open the exact HTTPS page in the system browser | ↗ Same | ↗ Same |

The shell receives only bounded lifecycle metadata: request ID, create/get action, relying-party ID, mediation/attachment type, success, and error name. Challenges, user handles, account names, credential IDs, attestation, authenticator data, and signatures are not sent to Yayra's renderer. Website and relying-party validation is performed in both the isolated page preload and the Electron main process.
