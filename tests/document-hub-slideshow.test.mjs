import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setupDomShim } from './dom-shim.mjs';
import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import {
  resolveDocumentSlideshowShortcut,
  resolveDocumentSlideshowClick,
  resolvePptxSlideshowShortcut
} from '../packages/shared-ui/src/services/documentViewers.js';

setupDomShim();

const require = createRequire(import.meta.url);
const {
  createDocumentLibrary,
  categoryForExtension
} = require('../electron/documentLibrary.cjs');

function key(key, extra = {}) {
  return { key, target: { tagName: 'DIV' }, ...extra };
}

test('DOCUMENT CATALOG: opaque metadata persists while renderer records never expose source paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yayra-doc-library-'));
  const source = join(root, 'Quarterly plan.pptx');
  writeFileSync(source, Buffer.from([1, 2, 3, 4]));
  const opened = [];
  const shown = [];
  let clock = 1_700_000_000_000;
  try {
    const library = createDocumentLibrary({
      fs: require('node:fs'),
      userDataDir: join(root, 'profile'),
      shell: {
        openPath: async (value) => { opened.push(value); return ''; },
        showItemInFolder: (value) => shown.push(value)
      },
      now: () => clock
    });
    const first = library.recordPathSync(source);
    assert.match(first.id, /^local-/);
    assert.equal(first.name, 'Quarterly plan.pptx');
    assert.equal(first.category, 'presentation');
    assert.equal(first.canOpenInYayra, true);
    assert.equal(Object.hasOwn(first, 'path'), false, 'safe record has no path key');
    assert.equal(JSON.stringify(first).includes(root), false, 'safe record cannot leak the source location in serialized form');

    clock += 5000;
    const repeated = library.recordPathSync(source);
    assert.equal(repeated.id, first.id, 'the same source keeps one opaque capability id');
    assert.equal(repeated.openedCount, 2);

    const listed = await library.list();
    assert.equal(listed.length, 1);
    assert.equal(Object.hasOwn(listed[0], 'path'), false);
    const persisted = JSON.parse(readFileSync(library.storePath, 'utf8'));
    assert.equal(persisted.entries[0].path, source, 'only the main-process store retains the trusted path');

    const result = await library.open(first.id);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'yayra');
    assert.deepEqual([...result.data], [1, 2, 3, 4]);
    assert.equal(result.libraryId, first.id);
    assert.equal(Object.hasOwn(result.entry, 'path'), false);

    assert.deepEqual(await library.showInFolder(first.id), { ok: true });
    assert.deepEqual(shown, [source]);
    assert.deepEqual(opened, [], 'supported files stay in Yayra unless the user explicitly asks for desktop app');

    const external = await library.open(first.id, { external: true });
    assert.equal(external.action, 'system');
    assert.deepEqual(opened, [source]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DOCUMENT CATALOG: every file type is remembered; unknown types use system app and missing files can be relinked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yayra-doc-all-types-'));
  const unknown = join(root, 'model.blend');
  const replacement = join(root, 'moved-model.blend');
  writeFileSync(unknown, Buffer.from('blend'));
  writeFileSync(replacement, Buffer.from('replacement'));
  const opened = [];
  try {
    const library = createDocumentLibrary({
      fs: require('node:fs'),
      userDataDir: join(root, 'profile'),
      shell: { openPath: async (value) => { opened.push(value); return ''; }, showItemInFolder() {} }
    });
    const entry = await library.recordPath(unknown);
    assert.equal(entry.category, 'other');
    assert.equal(entry.canOpenInYayra, false);
    assert.equal(entry.preferredAction, 'system');
    const system = await library.open(entry.id);
    assert.equal(system.ok, true);
    assert.equal(system.action, 'system');
    assert.deepEqual(opened, [unknown]);

    rmSync(unknown);
    const missing = await library.list();
    assert.equal(missing[0].available, false, 'availability is rechecked rather than guessed from stale metadata');
    const unavailable = await library.open(entry.id);
    assert.equal(unavailable.reason, 'unavailable');

    const relinked = await library.relink(entry.id, replacement);
    assert.equal(relinked.ok, true);
    assert.equal(relinked.entry.id, entry.id, 'Locate repairs the existing history row');
    assert.equal(relinked.entry.name, 'moved-model.blend');
    assert.equal((await library.list())[0].available, true);

    const cleared = library.clear();
    assert.equal(cleared.removed, 1);
    assert.equal(existsSync(replacement), true, 'clearing history never deletes the original');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DOCUMENT CATALOG: size ceiling applies only to internal bytes and retention removes metadata only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yayra-doc-retention-'));
  const source = join(root, 'large.pdf');
  writeFileSync(source, Buffer.alloc(8));
  let clock = 10 * 24 * 60 * 60 * 1000;
  try {
    const library = createDocumentLibrary({
      fs: require('node:fs'),
      userDataDir: join(root, 'profile'),
      shell: { openPath: async () => '', showItemInFolder() {} },
      maxViewBytes: 4,
      now: () => clock
    });
    const entry = library.recordPathSync(source);
    const tooLarge = await library.open(entry.id);
    assert.equal(tooLarge.reason, 'file-too-large');
    assert.equal(tooLarge.entry.available, true);
    clock += 31 * 24 * 60 * 60 * 1000;
    assert.deepEqual(library.prune({ olderThanDays: 30 }), { ok: true, removed: 1 });
    assert.equal(existsSync(source), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DOCUMENT CATALOG: useful extension families are classified consistently', () => {
  assert.equal(categoryForExtension('PDF'), 'pdf');
  assert.equal(categoryForExtension('pptx'), 'presentation');
  assert.equal(categoryForExtension('docx'), 'document');
  assert.equal(categoryForExtension('xlsx'), 'spreadsheet');
  assert.equal(categoryForExtension('heic'), 'image');
  assert.equal(categoryForExtension('toml'), 'text');
  assert.equal(categoryForExtension('zip'), 'archive');
  assert.equal(categoryForExtension('blend'), 'other');
});

test('DOCUMENT SLIDESHOW SHORTCUTS: PDF and PowerPoint navigation, jumping, blanking and presenter tools resolve comprehensively', () => {
  assert.equal(resolveDocumentSlideshowShortcut, resolvePptxSlideshowShortcut,
    'the format-neutral resolver preserves the original PPTX API');
  for (const input of ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'h']) {
    assert.equal(resolvePptxSlideshowShortcut(key(input)).action, 'next', `${input} advances`);
  }
  for (const input of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p']) {
    assert.equal(resolvePptxSlideshowShortcut(key(input)).action, 'previous', `${input} goes back`);
  }
  assert.equal(resolvePptxSlideshowShortcut(key('Home')).action, 'first');
  assert.equal(resolvePptxSlideshowShortcut(key('End')).action, 'last');
  assert.equal(resolvePptxSlideshowShortcut(key('F5')).action, 'first');
  assert.equal(resolvePptxSlideshowShortcut(key('F5', { shiftKey: true })).action, 'current');
  assert.equal(resolvePptxSlideshowShortcut(key('Escape')).action, 'exit');
  assert.equal(resolvePptxSlideshowShortcut(key('F1')).action, 'help');

  let result = resolvePptxSlideshowShortcut(key('1'));
  result = resolvePptxSlideshowShortcut(key('2'), result);
  result = resolvePptxSlideshowShortcut(key('Enter'), result);
  assert.deepEqual(result, { action: 'jump', slide: 12, digitBuffer: '' });

  assert.equal(resolvePptxSlideshowShortcut(key('b')).action, 'black');
  assert.equal(resolvePptxSlideshowShortcut(key('.')).action, 'black');
  assert.equal(resolvePptxSlideshowShortcut(key('w')).action, 'white');
  assert.equal(resolvePptxSlideshowShortcut(key(',')).action, 'white');
  assert.equal(resolvePptxSlideshowShortcut(key('l', { ctrlKey: true })).action, 'laser');
  assert.equal(resolvePptxSlideshowShortcut(key('p', { ctrlKey: true })).action, 'pen');
  assert.equal(resolvePptxSlideshowShortcut(key('a', { ctrlKey: true })).action, 'pointer');
  assert.equal(resolvePptxSlideshowShortcut(key('h', { ctrlKey: true })).action, 'hide-pointer');
  assert.equal(resolvePptxSlideshowShortcut(key('e')).action, 'erase');
  assert.equal(resolvePptxSlideshowShortcut(key('s')).action, 'notes');
  assert.equal(resolvePptxSlideshowShortcut(key('F5', { altKey: true })).action, 'notes');
  assert.equal(resolvePptxSlideshowShortcut(key('g')).action, 'navigator');
  assert.equal(resolvePptxSlideshowShortcut(key('-')).action, 'navigator');
  assert.equal(resolvePptxSlideshowShortcut({ key: ' ', target: { tagName: 'VIDEO' } }), null,
    'embedded media owns its playback keys');
  assert.equal(resolveDocumentSlideshowShortcut({ key: 'ArrowRight', target: { tagName: 'BUTTON' } }).action, 'next',
    'navigation keeps working after a presenter toolbar button receives focus');
  assert.equal(resolveDocumentSlideshowShortcut({ key: ' ', target: { tagName: 'BUTTON' } }), null,
    'Space still activates a focused accessible button instead of advancing');
});

test('DOCUMENT SLIDESHOW CLICKS: left half navigates backward and right half forward', () => {
  const bounds = { left: 100, width: 800 };
  assert.equal(resolveDocumentSlideshowClick(250, bounds), 'previous');
  assert.equal(resolveDocumentSlideshowClick(650, bounds), 'next');
  assert.equal(resolveDocumentSlideshowClick(500, bounds), 'next', 'the center split favors advancing');
});

test('DOCUMENT HUB UI: safe rows, filters, unavailable state and direct reopen work together', async () => {
  const previousYayra = window.yayra;
  const calls = [];
  window.yayra = {
    system: {
      documents: {
        list: async () => ({
          ok: true,
          entries: [
            {
              id: 'local-presentation-safe', name: 'Board deck.pptx', extension: 'pptx', category: 'presentation',
              size: 4 * 1024 ** 2, firstOpenedAt: Date.now() - 5000, lastOpenedAt: Date.now() - 1000,
              openedCount: 3, modifiedAt: Date.now(), available: true, canOpenInYayra: true, preferredAction: 'yayra'
            },
            {
              id: 'local-other-safe', name: 'Design.blend', extension: 'blend', category: 'other',
              size: 20 * 1024 ** 2, firstOpenedAt: Date.now() - 10000, lastOpenedAt: Date.now() - 8000,
              openedCount: 1, modifiedAt: Date.now(), available: true, canOpenInYayra: false, preferredAction: 'system'
            },
            {
              id: 'local-missing-safe', name: 'Moved.pdf', extension: 'pdf', category: 'pdf',
              size: 350 * 1024 ** 2, firstOpenedAt: Date.now() - 10000, lastOpenedAt: Date.now() - 9000,
              openedCount: 1, modifiedAt: Date.now(), available: false, canOpenInYayra: true, preferredAction: 'yayra'
            }
          ]
        }),
        reopen: async (id) => { calls.push(['reopen', id]); return { ok: false, reason: 'unavailable' }; },
        openLibraryExternal: async (id) => { calls.push(['external', id]); return { ok: true, action: 'system', entry: { name: 'Design.blend' } }; },
        showInFolder: async (id) => { calls.push(['show', id]); return { ok: true }; },
        locate: async (id) => { calls.push(['locate', id]); return { ok: true }; },
        remove: async (id) => { calls.push(['remove', id]); return { ok: true }; },
        clear: async () => ({ ok: true }),
        clearMissing: async () => ({ ok: true }),
        prune: async () => ({ ok: true })
      }
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, initialUrl: 'yayra://documents', platform: 'linux', isMobile: false });
  try {
    await shell.initialize();
    await shell.refreshDocumentLibrary({ render: false });
    shell.render(container);
    const initialRows = shell.viewportElement.querySelectorAll('.fb-document-row');
    assert.equal(initialRows.length, 3);
    assert.equal(initialRows.filter((row) => row.classList.contains('is-missing')).length, 1);
    assert.equal(shell.viewportElement.querySelectorAll('.fb-document-card-open').length, 2,
      'every available file card has one full-card primary action');
    const presentationRow = initialRows.find((row) => row.dataset.documentId === 'local-presentation-safe');
    const missingRow = initialRows.find((row) => row.dataset.documentId === 'local-missing-safe');
    const presentationCard = presentationRow.querySelector('.fb-document-card-open');
    assert.match(presentationCard.getAttribute('aria-label'), /Open Board deck\.pptx in Yayra/);
    assert.equal(missingRow.querySelector('.fb-document-card-open'), null,
      'an unavailable card cannot advertise an open action that will fail');
    presentationCard.click();
    presentationCard.click();
    await new Promise((resolve) => setImmediate(resolve));
    const refreshedPresentationCard = shell.viewportElement.querySelectorAll('.fb-document-row')
      .find((row) => row.dataset.documentId === 'local-presentation-safe')
      ?.querySelector('.fb-document-card-open');
    refreshedPresentationCard?.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter(([action, id]) => action === 'reopen' && id === 'local-presentation-safe').length, 1,
      'clicking anywhere on a supported card opens it directly in Yayra and suppresses accidental double-open across a rerender');
    assert.match(shell.viewportElement.textContent, /File moved or unavailable/);
    assert.match(shell.viewportElement.textContent, /Locate…/);
    assert.equal(JSON.stringify(shell.state.documentsItems).includes('/home/'), false, 'renderer state contains no source path');

    shell.state.documentsTypeFilter = 'presentation';
    shell.render(container);
    assert.equal(shell.viewportElement.querySelectorAll('.fb-document-row').length, 1, 'type filter narrows the live library');
    assert.match(shell.viewportElement.textContent, /Board deck\.pptx/);

    shell.state.documentsTypeFilter = 'all';
    shell.state.documentsSizeFilter = '1mb-10mb';
    assert.deepEqual(shell.filteredDocumentLibraryEntries().map((entry) => entry.name), ['Board deck.pptx'],
      'practical size ranges filter catalog metadata without reading originals');
    shell.state.documentsSizeFilter = 'all';
    shell.state.documentsSort = 'size';
    shell.state.documentsSortDirection = 'asc';
    assert.deepEqual(shell.filteredDocumentLibraryEntries().map((entry) => entry.name),
      ['Board deck.pptx', 'Design.blend', 'Moved.pdf']);
    shell.state.documentsSortDirection = 'desc';
    assert.deepEqual(shell.filteredDocumentLibraryEntries().map((entry) => entry.name),
      ['Moved.pdf', 'Design.blend', 'Board deck.pptx'],
      'every sort field supports an independent direction');

    await shell.openDocumentLibraryEntry('local-other-safe');
    assert.deepEqual(calls.at(-1), ['external', 'local-other-safe'], 'unknown formats route straight to the system app');
  } finally {
    shell.destroy();
    if (previousYayra === undefined) delete window.yayra;
    else window.yayra = previousYayra;
  }
});

test('DOCUMENT HUB + SLIDESHOW SOURCE CONTRACT: toolbar placement, IPC privacy, settings and true fullscreen stay wired', () => {
  const shell = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');

  const quickActions = shell.indexOf('for (const actionId of this.getToolbarQuickActions())');
  const quickActionFactory = shell.indexOf('createToolbarQuickAction(actionId, { mini: false })', quickActions);
  assert.ok(quickActions > -1 && quickActionFactory > quickActions,
    'Downloads and Tools are always separate quick actions, followed by two profile-customizable slots');
  assert.match(shell, /return \['downloads', 'tools', \.\.\.extras\]/);
  assert.match(shell, /id: 'documents',[\s\S]*?route: 'yayra:\/\/documents'/);
  assert.match(shell, /id: 'extensions',[\s\S]*?route: 'yayra:\/\/extensions'/);
  assert.match(shell, /yayra:\/\/documents/);
  assert.match(shell, /data-cat="documents"/);
  assert.match(shell, /documentsDefaultSort/);
  assert.match(shell, /documentsDefaultSortDirection/);
  assert.match(shell, /documentsDefaultSize/);
  assert.match(shell, /documentsRetentionDays/);
  assert.match(shell, /documentsShowMissing/);
  assert.match(shell, /fb-document-card-open/);
  assert.match(shell, /Open \$\{fileName\} \$\{destination\}/,
    'the entire available file card exposes an accessible primary open action');
  assert.match(css, /\.fb-document-card-open\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;/,
    'the primary button stretches across the full file card');
  assert.match(css, /\.fb-document-actions\s*\{[\s\S]*?z-index:\s*3;/,
    'explicit card actions remain above the full-card open target');

  for (const channel of [
    'yayra:doc-library-list', 'yayra:doc-library-open', 'yayra:doc-library-show',
    'yayra:doc-library-locate', 'yayra:doc-library-remove', 'yayra:doc-library-clear',
    'yayra:doc-library-clear-missing', 'yayra:doc-library-prune'
  ]) assert.match(preload, new RegExp(channel.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')), `${channel} is exposed narrowly`);
  assert.match(main, /createDocumentLibrary/);
  assert.match(main, /Source paths never cross IPC/);

  assert.match(shell, /fb-doc-overflow-menu/);
  assert.match(shell, /Start slideshow from slide 1 \(F5\)/);
  assert.match(shell, /From current slide/);
  assert.match(shell, /startPptxSlideshow/);
  assert.match(shell, /startPdfSlideshow/);
  assert.match(shell, /startDocumentSlideshow/);
  assert.match(shell, /requestFullscreen\(\{ navigationUI: 'hide' \}\)/);
  assert.match(shell, /fb-in-pptx-projector-display/);
  assert.match(shell, /resolveDocumentSlideshowClick\(event\.clientX, bounds\) === 'previous'\) void viewer\.prevPage/);
  assert.match(shell, /else void viewer\.nextPage/,
    'left-side clicks go backward and right-side clicks go forward');
  assert.match(preload, /projector-list-displays/);
  assert.match(preload, /projector-move-to-display/);
  assert.match(preload, /projector-restore-display/);
  assert.match(main, /screen\.getAllDisplays\(\)/);
  assert.match(main, /projector-restore-display/);
  assert.match(shell, /exitPptxSlideshow/);
  assert.match(shell, /exitDocumentSlideshow/);
  assert.match(shell, /fb-pptx-slideshow-ink/);
  assert.match(shell, /toggleNotes/);
  assert.match(css, /\.fb-pptx-slideshow\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*100vh;/);
  assert.match(css, /\.fb-pptx-slideshow-host \.fb-pptx-notes/);
  assert.match(css, /\.fb-document-slideshow-host \.fb-pdf-continuous-pages/,
    'PDF presentations move the live PDF.js page surface into the projector');
});
