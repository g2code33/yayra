# Yayra document workspace

Yayra opens local documents in first-class `yayra://doc/<id>` tabs without
uploading them to a converter or navigating the active website away. The
implementation adapts the proven offline viewer architecture from
`g2code33/pharmaTRACK_PERFECT_new` under its MIT license (see
`LICENSE.reference-pharmatrack`).

## Supported formats

| Kind | Extensions | Bundled engine | Main capabilities | Explicit limitations |
| --- | --- | --- | --- | --- |
| PDF | `.pdf` | PDF.js | Continuous pages, selectable text, progressive/windowed painting, page jump, find, thumbnails, outline, fit/zoom, rotation, night mode, print/download | Image-only scans have no searchable text without OCR |
| PowerPoint | `.pptx`, `.pptm` | Native OOXML slide renderer | Slide dimensions, master/layout/theme inheritance, backgrounds, text/runs, shapes, embedded and cropped images, playable embedded videos with poster frames and native controls, tables/merged cells, notes, thumbnails, navigation, find, fit/zoom | Does not execute macros, transitions, animations or OLE; linked-only videos stay offline and use their poster frame; unsupported video codecs use the browser’s native fallback; charts/SmartArt may use static or explanatory fallbacks |
| Word | `.docx` | `docx-preview` | Paged visual layout, styles, tables, headers/footers, notes, find, zoom | No macro execution, OLE, or tracked-change balloons |
| Spreadsheet | `.xlsx`, `.xlsm`, `.xls`, `.csv` | SheetJS Community Edition | Worksheet tabs, cells, formatted values, merged cells, dimensions, formula/result display, find, bounded row windows | Does not reproduce charts, conditional formatting or frozen panes |
| Image | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.avif`, `.svg` | Browser decoder | Internal display, zoom, rotation; animation where the browser supports it | SVG is sanitised before display |
| Text | `.txt`, `.md`, `.markdown`, `.log`, `.json`, `.xml`, `.yaml`, `.yml` | Safe text renderer | Bounded plain-text display, find, zoom, night mode | Markup is displayed literally and never executed |
| Legacy Office | `.doc`, `.ppt` | Honest fallback | Download unchanged original or open it with an installed desktop application | No safe bundled binary-Office renderer |

Unknown file types are refused with a clear notice. Recognized but corrupt or
password-protected documents transition to an actionable error state; they do
not remain on an endless loading indicator. The unchanged original remains
available through **Download** and, in Electron, **Desktop app**.

## Routing and trust model

Routing does not trust a URL suffix alone:

1. Known byte signatures win (`%PDF-`, PNG/JPEG/GIF/BMP/WebP/AVIF and SVG).
2. OOXML ZIP entry names distinguish `ppt/presentation.xml`,
   `word/document.xml`, and `xl/workbook.xml` using bounded prefix/tail scans.
3. A declared MIME type can identify extensionless browser-selected files.
4. The filename extension is the final fallback.

`DocumentStore` keeps the original `ArrayBuffer`/`Uint8Array` in renderer
memory. Document tabs are deliberately excluded from session persistence;
closing the final tab releases the bytes and viewer resources.

Electron's picker and OS **Open with Yayra** path read one explicitly selected
local file, enforce the shared 300 MB ceiling, and send only `{ name, size,
data }` over IPC. The source filesystem path never crosses into the renderer.
The desktop-original escape hatch receives the already-held bytes, writes a
sanitised temporary copy, and asks the OS to open that copy.

## Offline and packaging contract

All engines are local assets:

- `packages/shared-ui/src/vendor/pdfjs/`
- `packages/shared-ui/src/vendor/documents/`

`npm run build:document-vendors` deterministically bundles the attributed
sources in `scripts/vendor-src/` and writes a hash manifest plus license files.
`prebuild:web` runs this step automatically. The PWA precache and Electron
`app.asar` verification gates explicitly require every lazy engine, the PDF
worker, fonts/CMaps, and the generated manifest. Document bytes are never sent
to a third-party conversion service.

## PDF performance and lifecycle

The PDF controller creates lightweight page placeholders for continuous
scrolling but paints only the current page and two neighbours on each side.
Canvas pixels and text layers more than eight pages away are evicted. Page
sizes are measured after the first visible window has painted, and text/search
indexes are cached lazily. Zoom/rotation cancels obsolete render tasks. The
controller also cancels pending loads, removes scroll listeners, destroys the
PDF.js task/document, clears canvases/text layers, and releases references when
a tab closes or the shell is destroyed.

PPTX follows the same first-content-first rule: presentation structure opens
before media, and embedded pictures, video poster frames and clips are
materialised slide-by-slide. Video controls stay inside the slide, never load a
linked external file, and keep their own keyboard shortcuts while focused.
Search text is indexed lazily. Spreadsheet rendering limits each visible row
window to 300 rows.

## User entry points

- Drawer: **Open document**
- Desktop native picker (or standard web/Android file input)
- Drag and drop anywhere in Yayra
- Downloads context menu: **Open in Yayra** for registered formats
- Desktop OS file association / **Open with Yayra**

Every document receives its own ordinary Yayra tab and participates in normal
tab switching and closing, but never enters the web frame/native website
engine path.

## Validation

The automated suite covers byte/MIME/filename routing, the shared 300 MB guard,
a realistic PowerPoint fixture (master, layout, theme, background, image crop,
merged table and speaker notes), both `a:videoFile` and `p14:media` video forms,
lazy clip loading, poster thumbnails, linked-video offline fallback, native
video controls and keyboard ownership, real DOCX and spreadsheet rendering,
SVG sanitisation, safe text, continuous PDF windowing/text layers/thumbnails/
outline, corrupt-file errors, original-file fallback, byte-only IPC, file
associations, packaging, and lifecycle cleanup.
