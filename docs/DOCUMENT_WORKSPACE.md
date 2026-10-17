# Yayra Document Workspace — Phase 1 (PDF)

> Status: **Phase 1 implemented and tested** (local PDF viewing integrated into
> the existing browser shell). This document is the audit, the engine
> evaluation, the architecture, and the roadmap for Word / Excel / PowerPoint.

## 1. Architecture audit (what exists, what was reused)

Verified against the actual code, not just docs:

| Area | Reality found | Reused for the workspace |
| --- | --- | --- |
| Renderer entry | `public/index.html` → `src/browser/main.js`; the shell boots `BrowserShell` (`packages/shared-ui/src/components/BrowserShell.js`) into `#app`; `?shell=mini` boots the floating mini window with the SAME bundle | Yes — documents work in the main window and the mini window for free |
| Tab system | `state.tabs` (`{id,url,title,…}`) + `createNewTab/selectTab/closeTab`; tab strip, tab context menu, session restore | Yes — a document IS a tab (`yayra://doc/<id>`), closed via the normal `closeTab` |
| Navigation / omnibox | `navigateActiveTab` → `interpretUrl`; `yayra://` internal pages are DOM-rendered | Yes — the internal-page routing gained one branch (`yayra://doc/`) that renders the document viewer; web/native paths are untouched |
| Browser engines | Desktop: native `WebContentsView` per tab (`electron/webviewBridge.cjs`); web/PWA/Android: pooled sandboxed iframes | Not used for documents — the viewer is pure DOM/canvas, isolated from both |
| Downloads | `electron/downloadsBridge.cjs` (list/open/show) + in-shell dropdown | Phase 6 integration point (open a downloaded PDF) |
| IPC + security | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (verified in `electron/main.cjs`); preload exposes namespaced bridges; `ipcMain.handle` registry in `registerIpcBridges()` | Yes — same model: one new namespaced bridge, arguments validated, bytes-only responses |
| Android | Capacitor WebView + first-party plugins (`packages/floating-android`); `input[type=file]` maps to the system picker | Yes — the web file-input path IS the Android path |
| Persistence | `packages/persistence` (history/bookmarks/settings); rolling last-session snapshot already filters to `https?://` tabs | Yes — document tabs are automatically excluded (bytes are in-memory only) |
| Tests | `node --test` suites (~760), dom-shim, per-feature contract suites | Yes — new `tests/document-workspace.test.mjs` (12 tests) |
| Existing PDF/doc support | **None** (no pdfjs, no document UI, no local-file opening; `file://` never resolved) | This phase adds it |

**Deliberate non-duplications:** no new tab manager, no new persistence layer, no
parallel engine abstraction — the workspace plugs into the existing systems.

## 2. Engine evaluation and comparison matrix

Licensing verified from authoritative sources (npm/GitHub/official docs), Oct 2026:

- **PDF.js** — Apache-2.0 (npm `pdfjs-dist`; current line 6.4.299). We vendor
  the battle-tested **4.10.38** build (identical display API; upgrade is a
  drop-in — see §7).
- **ONLYOFFICE** — **AGPL-3.0** with additional Section-7 conditions; Community
  Document Server capped at ~20 concurrent users; Enterprise/Developer are
  paid. Embedding it would make Yayra subject to AGPL copyleft or a commercial
  license. Not selected.
- **Collabora Online** — **MPL-2.0** (file-level copyleft, fully open).
  Architecturally a separate service/process (LibreOffice core); heavyweight
  for an offline-first browser.
- **Univer** (`dream-num/univer`) — **Apache-2.0**, actively maintained
  (sheets core + UI). The leading candidate for Phase 4 (Excel).
- **SheetJS Community Edition** — **Apache-2.0**, but styling/charts are NOT
  in the CE — data round-trip only (confirmed by CE license page + community
  reports). Candidate for XLSX data import alongside Univer.
- **docx-preview / mammoth** — DOCX→HTML renderers (layout-ish / semantic).
  License labels to be re-verified from their repositories at adoption time
  (Phase 3) before any dependency is added — no claim is made now.

| Format | Candidate | View | Edit | Offline | Win | Linux | Android | License | Runtime deps | Packaging/maintenance | Known limits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | **PDF.js (selected)** | ✅ canvas render, zoom, text search | ➖ (annotation = Phase 2) | ✅ vendored | ✅ | ✅ | ✅ | Apache-2.0 | none (ESM + worker) | low (2 vendored files) | non-embedded fonts degrade without `standardFontDataUrl`; encrypted PDFs = honest error in Phase 1 |
| DOC/DOCX | docx-preview / mammoth (view) | partial (no full fidelity) | ❌ | ✅ | ✅ | ✅ | ✅ | TBD (verify at adoption) | none | medium | layout fidelity is inherently approximate |
| DOC/DOCX | ONLYOFFICE | ✅ | ✅ | server/DS based | ✅ | ✅ | ➖ | **AGPL-3.0 / paid** | Document Server | high + legal review | 20-user cap; copyleft |
| XLS/XLSX | Univer | ✅ | ✅ (formulas) | ✅ | ✅ | ✅ | ✅ | Apache-2.0 | bundle (large) | medium | young ecosystem; chart support maturing |
| XLS/XLSX | SheetJS CE | data only | data only | ✅ | ✅ | ✅ | ✅ | Apache-2.0 | none | low | no styling/charts in CE |
| PPT/PPTX | (no credible OSS browser editor today) | via conversion only | ❌ | n/a | n/a | n/a | n/a | n/a | n/a | high | see Phase 5 plan |
| Any | Collabora Online / LibreOfficeKit | ✅ high fidelity | ✅ | process-local or local service | ✅ | ✅ | ❌ (practical) | MPL-2.0 | LibreOffice runtime (~hundreds of MB) | high | separate process; heavy packaging |

**Conclusion for Phase 1:** PDF.js is the only engine that is permissive
(Apache-2.0), offline, dependency-free, and cross-platform (Windows x64,
Debian x64, Android) in one shot. Office formats get the phased plan in §7 —
with licensing verified BEFORE any dependency lands.

## 3. Workspace architecture (as implemented)

```
Browser tab (existing system)
  └── url = yayra://doc/<docId>          ← a first-class internal page
        └── renderDocumentViewer()       ← toolbar + canvas host + status
              └── createPdfViewer({ pdfjs, state })   ← engine INJECTED
                    └── vendor/pdfjs/pdf.mjs (+ pdf.worker.mjs)  ← Apache-2.0

DocumentStore (renderer, in-memory)      ← bytes only; no paths, no disk
  └── addDocumentTab({ name, bytes })    ← new tab; browsing tabs untouched

Electron main: yayra:doc-open            ← native picker; validates .pdf,
  caps 150 MB; returns { name, size, data }   ← the PATH NEVER crosses IPC
Web/PWA/Android: <input type="file">     ← FileReader → same DocumentStore
```

Key decisions:

- **Documents are tabs** (`yayra://doc/<id>`), so the entire existing tab UX
  (switch, close, context menu, title, favicon glyph) works unchanged. The
  routing branch runs BEFORE any web-frame/native-engine path — a document can
  never navigate a browsing tab away from its site.
- **Capability registry, honestly reported** (`DOCUMENT_ENGINES.pdf.capabilities`):
  view/search/zoom/pageNavigation = true; annotate/edit/save/export/print =
  false in Phase 1. The UI renders NO placeholder buttons for unsupported ops.
- **Security:** renderer gets bytes, never paths; the file is the one the user
  picked in the native dialog (or the file input); `contextIsolation`,
  `nodeIntegration: false`, `sandbox: true` unchanged; document rendering is
  DOM/canvas — separate from untrusted remote webpage execution; the session
  snapshot excludes document tabs.
- **Engine injection:** `createPdfViewer` takes the pdfjs module as a
  parameter (vendored build in production, deterministic fake in tests).
- **Local-first:** no account, no backend, no cloud, works fully offline.

## 4. Files changed (Phase 1)

| File | Why |
| --- | --- |
| `packages/shared-ui/src/vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}` | Vendored PDF.js 4.10.38 (Apache-2.0) — offline rendering on all platforms |
| `packages/shared-ui/src/services/documentWorkspace.js` | NEW: capability registry, `classifyDocument`, `DocumentStore`, `createPdfViewer` (engine-injected) |
| `packages/shared-ui/src/components/BrowserShell.js` | Document tabs: routing branch, `openDocument`/`_openDocumentFileInput`/`addDocumentTab`/`renderDocumentViewer`/`_pdfjsModule`, drawer entry, doc favicon |
| `packages/shared-ui/src/icons/icons.js` | `document` glyph |
| `electron/main.cjs` | `yayra:doc-open` handler (native picker, validated, size-capped, bytes-only) |
| `electron/preload.cjs` | `window.yayra.documents.openPdf` bridge |
| `tests/document-workspace.test.mjs` | NEW: 12 tests (registry honesty, store, viewer nav/zoom/search/errors, tab integration, close, session exclusion, security pins) |
| `docs/DOCUMENT_WORKSPACE.md` | This document |
| (+ P68 batch, separate concern) offline prompting + install-as-app name editing / site-logo work | See commit messages |

## 5. Tests and results (executed, not assumed)

- `node --test tests/document-workspace.test.mjs` → **12/12 pass**
  (registry honesty; store semantics; viewer load/page-clamp/zoom-clamp/search
  with match-jump; damaged-file vs password error states; own-tab integration
  with NO iframe/native-slot; close returns to browsing; session snapshot
  exclusion; drawer entry; IPC bytes-only security pins; https-only session
  pin).
- Full gate `npm test`, `npm run lint`, `npm run typecheck`, `npm run build:web`
  — results reported in the session summary that accompanies this phase; the
  known sandbox-only `.deb` packaging test failure is an environment limitation
  (no native packaging tool in the sandbox; passes in real CI).

## 6. Known limitations (Phase 1, stated honestly)

- PDFs only; Word/Excel/PowerPoint are roadmap (§7) — the UI says so. Thumbnails are capped at the first 60 pages (large documents stay fast).
- Encrypted PDFs show an honest "password-protected" state (unlocking = Phase 2).
- Non-embedded fonts render with fallbacks (bundling `standardFontDataUrl` +
  cmaps is vendored and wired - DONE).
- Document bytes live in memory for the tab's lifetime; closing the tab (or
  restarting) drops them — reopening is one menu click. No annotations, no
  printing, no export yet — no buttons pretend otherwise.
- All PDF entry paths enforce a 150 MB limit before reading/copying when the source exposes its size (native picker, browser file input, drag-and-drop), with a final in-memory store guard. Closed PDF bytes are not kept for Ctrl+Shift+T; reopen the original file from the menu.
- Text search is exact-string, case-insensitive; no regex/diacritics folding.

## 7. Phased plan (roadmap, not implemented)

- **Phase 2 — DELIVERED viewer upgrade:** rotation, night reading mode, outline/TOC sidebar, page thumbnails, fit-width/fit-page, direct page jumps, search match list, full keyboard control (←/→, +/−, 0, R, N, F, Home/End, Ctrl+F), standard font + CJK cmap packaging, open-from-downloads (right-click "Open in Yayra"), OS "Open with > yayra" registration, drag & drop, and the "Desktop app" escape hatch. **Remaining Phase 2:** annotation layer (PDF.js annotation editor /
  `saveDocument`), printing (Electron `webContents.print`), font/cmap data
  packaging, virtualized page rendering for very large files, recent-documents
  list (in `packages/persistence`), open-from-downloads.
- **Phase 3 — Word:** DOCX **viewing** via a verified-license renderer
  (docx-preview or mammoth; license re-verified from the repository before
  adoption); honest "formatting may differ" notice; editing only after the
  engine decision below.
- **Phase 4 — Excel:** Univer (Apache-2.0) for viewing + editing with
  formulas; SheetJS CE for robust XLSX/XLS data import; explicit limits
  documented (no CE styling/charts round-trip).
- **Phase 5 — PowerPoint:** no credible OSS browser editor exists today;
  evaluate (a) LibreOfficeKit/Collabora (MPL-2.0) headless conversion to PDF
  for high-fidelity viewing on desktop, and (b) Univer Slides as it matures.
  Fidelity vs packaging cost must be measured before committing.
- **Phase 6 — Unified workspace:** cross-navigation (browser ↔ documents),
  recent documents + file management, cross-platform polish, OPTIONAL sync
  (never mandatory).
- **Editing engines (Word/PPT):** before any ONLYOFFICE adoption, the AGPL-3.0
  obligations (source disclosure / commercial license cost) must be accepted
  explicitly by the project owner — documented, not assumed.

## 8. Licensing and redistribution

- PDF.js is Apache-2.0; its license file ships beside the vendored build
  (`packages/shared-ui/src/vendor/pdfjs/LICENSE`). Apache-2.0 permits
  redistribution in Yayra's commercial packages with attribution retained.
- No other document dependency was added in this phase. Every future engine
  must pass the §2 matrix (license verified from the primary source, offline
  capability, platform coverage, packaging cost) before adoption.

## 9. Testing the feature (per platform)

**Windows (x64):** install the app → open any website (verify it stays put) →
menu (⋮) → **Open document... (PDF)** → pick a PDF → it opens in its own tab
with page arrows, zoom −/+, and "Find in document" (try a word you can see;
matches jump pages). Close via the ✕ button — you are back on your site,
still loaded. Try a corrupted file (rename a .txt to .pdf) → honest error
card, no crash.

**Debian/Linux (x64):** same flow in the .deb or AppImage. Also verify the
document tab never triggers the native page surface (no flicker of a site
behind the document) and that the mini window (bubble → yayra mini) can open
documents too.

**Android:** build the APK (`npm run build:android`) → menu → Open document →
the system file picker appears → PDF renders in the viewer; search + zoom work
offline (airplane mode). Also verify the file input path never exposes a path
in any UI.

**All platforms:** with the internet disconnected, documents still open and
search (local-first); a PDF tab + a website tab coexist; switching between
them never reloads the site.
