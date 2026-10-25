import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function makeShell() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const shell = new BrowserShell({ container, isMobile: false });
  shell.showTransientNotice = () => {};
  return { shell, container };
}

function labels(toolbar) {
  return Array.from(toolbar.querySelectorAll('button')).map((button) => button.textContent);
}

test('Yayra text uses the native I-beam and remains selectable under custom pointer themes', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-fb-pointer\] \[data-yayra-selectable-text='true'\][\s\S]{0,220}cursor: text !important;/);
  assert.match(css, /\[data-yayra-selectable-text='true'\][\s\S]{0,260}user-select: text !important;/);
  assert.match(css, /\.fb-selection-actions \{[\s\S]{0,500}position: fixed;[\s\S]{0,500}user-select: none;/);
  assert.match(css, /\.fb-selection-action \{[\s\S]{0,500}cursor: pointer;/, 'only the action buttons use a hand');
});

test('highlighted read-only text offers Copy, Search and Ask Yayra AI, then dismisses cleanly', () => {
  const { shell, container } = makeShell();
  try {
    const anchor = document.createElement('p');
    container.appendChild(anchor);
    const snapshot = {
      kind: 'range',
      text: 'selected page text',
      editable: false,
      anchorNode: anchor,
      anchorOffset: 0,
      focusNode: anchor,
      focusOffset: 18,
      rect: { left: 100, right: 240, top: 120, bottom: 140, width: 140, height: 20 }
    };
    const toolbar = shell.showSelectionToolbar(snapshot);
    assert.ok(toolbar);
    assert.deepEqual(labels(toolbar), ['Copy', 'Search', 'Ask Yayra AI', 'Ask Yayra Dictionary', 'Save selection', 'Highlight']);
    assert.equal(toolbar.getAttribute('role'), 'toolbar');
    assert.equal(document.body.querySelector('.fb-selection-actions'), toolbar);

    shell.dismissSelectionToolbar({ rememberSelection: true });
    assert.equal(document.body.querySelector('.fb-selection-actions'), null);
    assert.equal(shell._sameSelectionSnapshot(snapshot, shell._dismissedSelectionSignature), true,
      'an ignored highlight stays dismissed until the selection changes');
  } finally {
    shell.destroy();
    container.remove();
  }
});

test('editable highlights add Cut and remove exactly the selected field range', async () => {
  const { shell, container } = makeShell();
  try {
    const field = document.createElement('input');
    field.value = 'alpha beta gamma';
    field.selectionStart = 6;
    field.selectionEnd = 10;
    container.appendChild(field);
    const snapshot = {
      kind: 'field',
      text: 'beta',
      editable: true,
      field,
      start: 6,
      end: 10,
      rect: { left: 20, right: 220, top: 40, bottom: 70, width: 200, height: 30 }
    };
    const toolbar = shell.showSelectionToolbar(snapshot);
    assert.deepEqual(labels(toolbar), ['Copy', 'Cut', 'Paste', 'Search', 'Ask Yayra AI', 'Ask Yayra Dictionary', 'Save selection', 'Highlight']);

    shell._writeSelectionText = async (text) => text === 'beta';
    await shell.cutSelectionSnapshot(snapshot);
    assert.equal(field.value, 'alpha  gamma');
  } finally {
    shell.destroy();
    container.remove();
  }
});

test('selection actions preserve private mode and open bounded searches in a fresh tab', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.tabs[0].isPrivate = true;
    let createdPrivate = null;
    let navigated = null;
    shell.createNewTab = (isPrivate, options) => {
      createdPrivate = { isPrivate, options };
      return {};
    };
    shell.navigateActiveTab = (url) => { navigated = url; };
    assert.equal(shell.openSelectionSearch('  Ghana medicines  '), true);
    assert.deepEqual(createdPrivate, { isPrivate: true, options: { render: false } });
    assert.equal(navigated, 'https://www.google.com/search?q=Ghana%20medicines');

    shell.openSelectionInYayraAi('explain this');
    assert.equal(navigated, 'yayra://ai?q=explain%20this');
  } finally {
    shell.destroy();
    container.remove();
  }
});
