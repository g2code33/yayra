# Yayra dictionary and vocabulary system

## Source and licence review

- General English is based on the WordNet 3.0 database files included in npm archive `wordnet@2.0.0`: `https://registry.npmjs.org/wordnet/-/wordnet-2.0.0.tgz`. Registry SHA-512 integrity: `sha512-VQOEUBHU6drwXGQx37bVaRqi042IZ8NwJiT9qLtM2x1QzqgIJIRoyZa++rWrUvICK+tYz9ttfYFk1c8IiN6DVQ==`.
- The npm package itself declares MIT for its Node wrapper; that label is **not** used for the data. The database files carry the Princeton notice `WordNet 3.0 Copyright 2006 by Princeton University` and the `WordNet Release 3.0` permission/disclaimer. The generated pack retains the full license text in metadata and ships it as `public/dictionary-packs/WORDNET-LICENSE-3.0.txt`. The required copyright and disclaimer attribution is shown in the pack catalog and on results.
- `scripts/build-wordnet-pack.mjs` deterministically transforms those four source files into 147,806 normalized dictionary terms. The compressed app asset is `public/dictionary-packs/wordnet-3.0-v1.yayrapack` (6,922,545 bytes); its pinned SHA-512 is `sha512-VYO6M4h9frFzSXs7viXurFdv/jR2hksMOFjuWWM3NJaf7DNjOYzHUPg5iwRZFioEMEXYStpLJxEIdNgHu4YHeA==`. This dataset is general English, not a clinical, legal, or financial authority.
- No medical, pharmacy, or business definition corpus is being redistributed. Candidate terminology lists found in package registries are not equivalent to licensed definition databases. Those catalog categories remain unavailable until exact source, version, rights and attribution are verified.

## Architecture and data boundaries

- Internal pages, Settings navigation, document hub and floating-mini internal-page dispatcher are in `packages/shared-ui/src/components/BrowserShell.js`. The native text-selection toolbar and local dictionary context-menu action are injected by `electron/webviewBridge.cjs`.
- Local search and entry validation are in `dictionaryEngine.js`; IndexedDB pack entries, metadata, and download checkpoints are in `dictionaryStore.js`; pack verification/download/import is in `dictionaryPackManager.js`; profile-owned saved vocabulary is in `dictionaryLibrary.js`.
- Personal vocabulary is kept in a separate IndexedDB store from dictionary packs. Disabling, removing, re-downloading, or replacing a pack does not enumerate or delete saved words, stars, highlights, notes, tags, collections, or history.
- Search runs only against enabled local packs. Installing the bundled WordNet pack is an explicit same-origin file download; its SHA-512 is checked before decompression and installation. The 6.6 MB pack is excluded from PWA precache so it is not fetched until requested. Once imported, the IndexedDB copy works offline. Range requests persist partial-download checkpoints and resume where the serving platform supports HTTP Range; unsupported servers safely restart the download.
- Untrusted imported text is validated and rendered through `textContent`; local lookup itself does not send queries to a server. User-supplied JSON pack metadata is validated but is not represented as a Yayra-vouched source.

## Search and interface

- A coloured Dictionary logo button sits beside Documents in the browser toolbar and is also available in the mobile tool row and Settings. The dictionary page has one compact Search / Packs / My vocabulary navigation strip; category, pack and display-mode filters are in a collapsed-by-default disclosure to reduce clutter.
- Press Enter or select Search to run the lookup. Before a pack is installed, the search page clearly offers the General English pack download; an empty result offers a path to pack management. The available dataset contains WordNet senses/definitions and can return multiple senses for a term.
- `Ctrl/Command + Alt + Shift + D` looks up selected text directly inside Yayra pages/documents without reading the clipboard. The optional desktop-wide shortcut in Settings works outside Yayra only after the user selects and copies text, then presses the enabled global accelerator. Yayra does not synthesize Copy, overwrite/restore the clipboard, or read it in the background. OS registration may be unavailable or conflict (notably on some Wayland sessions). Browser/PWA and Android builds do not get an OS-global shortcut.
- Selection toolbar Copy/Search/Ask AI/Cut/Paste behaviors remain in place. Desktop mini-window lookup preserves its existing tabs; private-source lookups do not hand off into the persistent mini.

## Pack import format

A UTF-8 JSON file has `format: "yayra-dictionary-pack"`, `formatVersion: 1`, a `metadata` object with `id`, `title`, `category` (`general`, `medical`, `pharmacy`, `business`), `version`, `datasetVersion`, `packVersion`, `source`, optional HTTPS `sourceUrl`, exact `license`, `attribution`, `buildDate`, `updatedAt`, and `description`, plus an `entries` array. Optional `licenseText` and `sourceIntegrity` fields preserve the exact licence and source archive fingerprint. Each entry has a `term` and one or more definitions; definitions can include `partOfSpeech`, `examples`, `synonyms`, `antonyms` and `etymology`.

## Remaining limits

- The bundled downloadable source covers General English only. Medical, Pharmacy and Business sources remain unavailable; the interface does not fabricate placeholder definitions or present WordNet as medical advice.
- A web/PWA user needs access to the app origin to fetch the pack the first time. After installation, the dictionary database and lookup function are local/offline. If an HTTP host does not support Range, a broken download restarts rather than resuming.
- Selection inside Yayra can be looked up directly with the app shortcut. Automatic access to selected text in other applications is not claimed: those apps are outside Yayra’s process and require a user-mediated copy before the separately opted-in desktop shortcut.

## Verification

- Focused dictionary, selection, shortcut, UI, and native webview tests pass. A local end-to-end smoke installed the 147,806-entry pack through the running same-origin server, searched `bank`, and found the Princeton definition for a financial institution.
- `npm run lint`, `npm run typecheck`, `npm run build:web --ignore-scripts` and `node scripts/verify-pwa.mjs` pass. The `.yayrapack` is intentionally excluded from the service-worker precache and verified at install time; its small licence text remains precached.
- The full Node suite reports 1,227 passing / 1,229 total. Two unrelated Linux packaging tests still fail: `electron-builder` cannot complete in this environment, and `tests/pdf-everywhere.test.mjs` expects PPTX MIME handling in the pre-existing local `build/linux/yayra.desktop`. That user-modified desktop file remains untouched.
