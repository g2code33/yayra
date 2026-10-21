# Yayra document workspace

Yayra opens local files in first-class `yayra://doc/<id>` tabs without
uploading them to a converter or navigating the active website away. The
implementation adapts the proven offline viewer architecture from
`g2code33/pharmaTRACK_PERFECT_new` under its MIT license (see
`LICENSE.reference-pharmatrack`).

The toolbar **Documents** button opens `yayra://documents`, an indexed library
of every local file explicitly opened through Yayra. It sits directly beside
**Downloads**.

## Supported formats and honest all-file routing

| Kind | Extensions | Bundled engine | Main capabilities | Explicit limitations |
| --- | --- | --- | --- | --- |
| PDF | `.pdf` | PDF.js | Continuous pages, selectable text, progressive/windowed painting, page jump, find, thumbnails, outline, fit/zoom, rotation, night mode, print/download, and a dedicated full-screen page show | Image-only scans have no searchable text without OCR |
| PowerPoint | `.pptx`, `.pptm` | Native OOXML slide renderer | Slide dimensions, full master→layout→slide placeholder geometry, backgrounds/themes, text/runs/bullets, Office Math equations, compatibility-wrapped shapes, embedded and cropped images, playable embedded videos with poster frames and native controls, tables/merged cells, speaker notes with a native text-colour picker, thumbnails, navigation, find, fit/zoom, unchanged download, full-deck print and dedicated slideshow | Does not execute macros, transitions, animations or OLE; linked-only videos stay offline and use their poster frame; unsupported codecs use the browser fallback; charts/SmartArt may use static or explanatory fallbacks |
| Word | `.docx` | `docx-preview` | Paged visual layout, styles, tables, headers/footers, notes, find, zoom, download and print | No macro execution, OLE, or tracked-change balloons |
| Spreadsheet | `.xlsx`, `.xlsm`, `.xls`, `.csv` | SheetJS Community Edition | Worksheet tabs, cells, formatted values, merged cells, dimensions, formula/result display, find, bounded row windows, download and current-sheet print | Does not reproduce charts, conditional formatting or frozen panes |
| Image | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.avif`, `.svg` | Browser decoder | Internal display, zoom, rotation, unchanged download and print; animation where the browser supports it | SVG is sanitised before display |
| Text | `.txt`, `.md`, `.markdown`, `.log`, `.json`, `.xml`, `.yaml`, `.yml` | Safe text renderer | Bounded plain-text display, find, zoom, night mode, download and print | Markup is displayed literally and never executed |
| Legacy Office | `.doc`, `.ppt` | Honest fallback | Open/download the unchanged original through an installed desktop application | No safe bundled binary-Office renderer |
| Every other file | Any extension | System application / unchanged-file fallback | Remembered in Documents; reopened with the operating-system handler on desktop | Unknown bytes are never interpreted as trusted display content |

Recognized but corrupt or password-protected documents transition to an
actionable error state; they do not remain on an endless loading indicator.
The unchanged original always remains available. Selecting or dropping an
unknown format creates an honest fallback instead of silently excluding it.

## Documents hub

`yayra://documents` provides:

- search by filename, extension, or family;
- opening-date filters for today, 7 days, 30 days, one year, or any time;
- type filters for PDF, presentation, document, spreadsheet, image, text,
  archive, and other files;
- file-size filters for under 1 MB, 1–10 MB, 10–100 MB, 100–300 MB, and
  files over the internal-viewer limit;
- independent ascending/descending sorting by opening date, name, type, size,
  or opening frequency;
- direct **Open**, **Desktop app**, and **Show in folder** actions;
- explicit missing/moved-file state plus **Locate…** relinking;
- removal of one row, all unavailable rows, or all history without deleting
  original files; and
- truthful browser/PWA session-only behavior where durable filesystem access
  is unavailable.

**Settings > Documents** controls the default sort field/direction plus type,
date, and size filters, history retention, missing-file visibility, presentation
fullscreen, presentation-control auto-hide, and history management. Retention and Clear delete catalog metadata
only. They never delete, move, rename, rewrite, or upload source files.

## Trusted catalog and path isolation

`electron/documentLibrary.cjs` owns the persistent desktop catalog in
Electron's trusted main process. Each source gets a random opaque `local-*` id.
The on-disk main-process record includes the canonical source path and safe
metadata. Renderer-facing records contain only:

- opaque id;
- basename, extension, and file family;
- size and modified/opened timestamps;
- opening count and current availability; and
- whether the bundled viewer can handle it.

No source path crosses IPC or enters ordinary renderer tab/localStorage state.
Every reopen resolves the opaque id in the main process, stats the source again,
rechecks permissions and the 300 MB internal-viewer ceiling, and then does one
of two things:

1. transfers the explicitly requested supported file's bytes to the bundled
   viewer; or
2. asks the OS to open the original path for an unsupported format or explicit
   **Desktop app** action.

The picker records a file before routing it, including supported files over the
internal-viewer ceiling. OS **Open with Yayra** and Downloads **Open in Yayra**
also record their source. Web/Android picker and drag-and-drop entries appear in
a session catalog; if the browser can no longer access the bytes, the row says
so and asks the user to choose the source again rather than pretending durable
access exists.

`DocumentStore` still keeps active original `ArrayBuffer`/`Uint8Array` values in
renderer memory. It stores only an optional opaque catalog id, never a path.
Document tabs remain excluded from browser-session persistence; closing the
final session-only tab releases its bytes and marks that session row unavailable.

## Routing and trust model

Internal rendering does not trust a filename suffix alone:

1. Known byte signatures win (`%PDF-`, PNG/JPEG/GIF/BMP/WebP/AVIF and SVG).
2. OOXML ZIP entry names distinguish `ppt/presentation.xml`,
   `word/document.xml`, and `xl/workbook.xml` using bounded prefix/tail scans.
3. A declared MIME type can identify extensionless browser-selected files.
4. The filename extension is the final fallback.
5. If none match, the route is `unsupported`; bytes are not rendered as HTML,
   script, media, or another trusted document family.

## Download and print

Every bundled viewer has a visible **Download** button that writes the exact
source bytes—never a screenshot, conversion, or reconstructed copy. Electron
uses a native Save dialog with the shared 300 MB IPC guard; web/PWA uses a local
Blob download. `Ctrl+S` invokes the same document path. **Desktop app** remains
a separate action because opening a temporary/original file is not downloading
it.

Every viewable format also has a visible **Print** button and `Ctrl+P` support.
PDF materialises every evicted page for the print snapshot. PowerPoint lazily
materialises every slide into a temporary print-only deck, reports progress,
then releases that DOM immediately after the print dialog. DOCX prints its
paged layout; images, text and spreadsheets print their current rendered view.

## PDF and PowerPoint presentation mode

PPTX/PPTM tabs expose a top-row **Present** action that always starts at slide
1, while the lower controls expose **From current slide** beside the selected
slide number. PDF similarly exposes **From current page**. `F5` starts from page
or slide 1 and `Shift+F5` starts from the current page or slide. For PowerPoint,
**Desktop app** and **Close presentation** remain in the accessible three-dot
menu; Download and Print are visible direct actions rather than hidden menu
items.

Presentation mode is a dedicated full-window black projector surface, not CSS
enlargement or a screenshot of the ordinary viewer. It:

- requests true browser/Electron fullscreen with hidden navigation UI and
  remains usable as a full-window show if permission is denied;
- moves the existing live viewer controller into the projector, avoiding a
  reload or lossy conversion;
- switches PDF.js from continuous reading to exactly one proportionally fitted
  page, re-fits pages whose proportions differ, and keeps its selectable text
  layer/live canvas;
- keeps the existing PowerPoint slide DOM, embedded video controls, and lazy
  media alive;
- restores the prior viewer mount, current page/slide, zoom mode, reading
  position, focus, and PowerPoint notes state on exit;
- has auto-hiding previous/next, number jump, black screen, laser, pen,
  page/slide navigator, help, fullscreen, and exit controls;
- supports swipe, click, and throttled wheel navigation while leaving keyboard
  and pointer events on embedded PowerPoint video/audio controls alone;
- provides black (`B` or `.`) and white (`W` or `,`) screens;
- supports laser (`Ctrl+L`), pen (`Ctrl+P`), arrow (`Ctrl+A`), hidden pointer
  (`Ctrl+H`), and clear ink (`E`);
- supports page/slide overview (`G` or `-`) and in-show shortcut help (`F1`);
  and
- owns the comprehensive presentation navigation set: `F5`, `Shift+F5`,
  arrows, `N`, `P`, `H`, Space, Enter, Backspace, Page Up/Down, Home/End,
  number+Enter, and Escape.

PowerPoint shows start with speaker notes hidden and allow Notes to be toggled
with the control, `S`, `Alt+F5`, or `Ctrl+Shift+N`; PDF shows do not invent a
notes feature. The pen layer is separate from document content, clears on
page/slide changes, and never alters the original. A show never executes macros,
transitions, scripts, OLE objects, or linked media.

## Offline and packaging contract

All document engines are local assets:

- `packages/shared-ui/src/vendor/pdfjs/`
- `packages/shared-ui/src/vendor/documents/`

`npm run build:document-vendors` deterministically bundles attributed sources
from `scripts/vendor-src/` and writes a hash manifest plus license files.
`prebuild:web` runs it automatically. PWA precache and Electron `app.asar`
verification require every lazy engine, the PDF worker, fonts/CMaps, and the
generated manifest. Document bytes are never sent to a conversion service.

## Performance and lifecycle

The PDF controller creates lightweight page placeholders for continuous
scrolling but paints only the current page and two neighbours on each side.
Canvas pixels and text layers more than eight pages away are evicted. Page
sizes are measured after the first visible window has painted, and text/search
indexes are cached lazily. In presentation mode, non-current page shells are
hidden and a page is re-fitted only when its dimensions require it.
Zoom/rotation cancels obsolete tasks. Closing a tab
cancels loads/listeners, destroys PDF.js resources, clears canvases/text layers,
and releases references.

PPTX follows the same first-content-first rule: presentation structure opens
before media, and pictures, video posters, and clips are materialised
slide-by-slide. Markup-compatibility (`mc:AlternateContent`) branches are
resolved once at both shape and text-run level; identity groups remain
traversable; and native Office Math (OMML) is converted locally into semantic
MathML with a plain-text search/copy equivalent. Placeholder position, size,
anchor, and text style flow through master → layout → slide, including footer
slide numbers that carry no transform of their own. Video controls stay inside
the slide, never load a linked external file, and own their keyboard shortcuts
while focused. Search indexes lazily. The validated six-digit notes colour
updates only note text, defaults to black on a fixed cream card, and persists
per profile without rebuilding slide media. Spreadsheet rendering limits each
visible row window to 300 rows.

## User entry points

- Toolbar: **Documents**
- Drawer: **Open document**
- Desktop native all-file picker (or standard web/Android file input)
- Drag and drop anywhere in Yayra
- Downloads context menu: **Open in Yayra** for internally viewable formats
- Desktop OS file association / **Open with Yayra**

Every internally handled file receives its own ordinary Yayra tab and
participates in normal tab switching and closing, but never enters the web
frame/native website engine path.

## Validation

The automated suite covers catalog persistence, opaque-id/path isolation,
all-file routing, availability checks, relinking, retention, non-destructive
clear, filtering/sorting source contracts, the shared 300 MB guard, byte/MIME/
filename routing, realistic PowerPoint fixtures, compatibility-wrapped body
content, OMML fractions/scripts, master-inherited lower-right slide numbers,
embedded-video fidelity and keyboard ownership, notes colour, complete shared
presentation shortcuts,
true-fullscreen/overflow wiring, live PDF projector mounting and restoration,
variable-proportion PDF page fitting, DOCX/spreadsheet rendering, SVG
sanitisation, safe text, continuous PDF windowing/search/thumbnails/outline, corrupt-file
errors, original-file fallback, IPC, associations, packaging, and lifecycle
cleanup.
