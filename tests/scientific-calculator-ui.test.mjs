import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { ScientificCalculator } from '../packages/shared-ui/src/components/ScientificCalculator.js';
import { defaultScientificCalculatorData } from '../packages/shared-ui/src/services/scientificCalculatorStorage.js';

function enableSelectValues(window) {
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.getAttribute('value') || this.querySelector('option[selected]')?.getAttribute('value') || this.querySelector('option')?.getAttribute('value') || ''; },
    set(value) { this.setAttribute('value', value); this.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === String(value))); }
  });
}

function newDOM() {
  const dom = parseHTML('<html><body></body></html>');
  enableSelectValues(dom.window);
  globalThis.document = dom.document;
  return dom;
}

test('interactive calculator evaluates locally, presents steps, records history and marks saved results', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const writes = [];
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData(), onDataChange: async (data) => writes.push(data) });
  const expression = container.querySelector('.sc-expression');
  expression.value = '2 * sin(30) + sqrt(16)';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  assert.equal(container.querySelector('.sc-answer-value').textContent, '5');
  assert.equal(container.querySelector('.sc-answer-steps').hidden, false);
  assert.equal(view.data.history[0].expression, '2 * sin(30) + sqrt(16)');
  assert.equal(view.data.history[0].result, 5);
  assert.equal(writes.length > 0, true);
  container.querySelector('[data-memory="add"]').click();
  assert.equal(view.data.memory, 5, 'memory adds the last numeric result and persists it');
  container.querySelector('.sc-save-result').click();
  assert.equal(view.data.saved.length, 1);
  assert.equal(view.data.favorites.includes(view.lastEntryId), true);
  container.querySelector('.sc-side-tabs [data-panel="favorites"]').click();
  assert.equal(container.querySelector('.sc-entry-card .sc-entry-result').textContent, '5');
  expression.value = '1 / 0';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  assert.equal(container.querySelector('.sc-answer-value').textContent, 'No result');
  assert.equal(container.querySelector('.sc-copy-result').disabled, true, 'a previous result is not left actionable after an error');
  assert.equal(view.data.history.length, 1, 'failed expressions do not enter calculation history');
});

test('calculator angle preference persists and old history is loaded without automatic evaluation', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const data = defaultScientificCalculatorData();
  data.history.unshift({ id: 'prior', expression: '9 * 9', value: 81, formatted: '81', createdAt: Date.now() });
  const view = new ScientificCalculator({ container, data });
  assert.equal(container.querySelector('.sc-answer-value').textContent, 'Ready');
  container.querySelector('.sc-angle-mode').value = 'DEG';
  container.querySelector('.sc-angle-mode').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(view.data.settings.angleMode, 'DEG');
  container.querySelector('.sc-entry-expression').click();
  assert.equal(container.querySelector('.sc-expression').value, '9 * 9');
  assert.equal(container.querySelector('.sc-answer-value').textContent, 'Ready');
});

test('hardware-style keypad supports fraction templates, SHIFT/ALPHA layers, fraction display and Ans transfer', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const expression = container.querySelector('.sc-expression');
  const keyAt = (key) => container.querySelector(`.sc-key[data-key="${key}"]`).getAttribute('style');
  assert.match(keyAt('SHIFT'), /grid-column:1;grid-row:1/);
  assert.match(keyAt('ALPHA'), /grid-column:2;grid-row:1/);
  assert.match(keyAt('MODE'), /grid-column:5;grid-row:1/);
  assert.match(keyAt('CALC'), /grid-column:1;grid-row:2/);
  assert.match(keyAt('a\/b'), /grid-column:1;grid-row:3/);
  assert.match(keyAt('RCL'), /grid-column:1;grid-row:5/);
  assert.match(keyAt('7'), /grid-column:1;grid-row:6/);
  assert.match(keyAt('4'), /grid-column:1;grid-row:7/);
  assert.match(keyAt('1'), /grid-column:1;grid-row:8/);
  assert.match(keyAt('0'), /grid-column:1;grid-row:9/);
  assert.match(keyAt('='), /grid-column:5;grid-row:9/);
  assert.ok(container.querySelector('.sc-navigation-pad'), 'a physical-style directional pad fills the empty space across the top two rows');
  container.querySelector('.sc-key[data-action="fraction"]').click();
  const fractionForm = container.querySelector('.sc-fraction-dialog');
  assert.ok(fractionForm, 'a/b opens a vertically stacked numerator/denominator entry template');
  assert.equal(fractionForm.querySelectorAll('.sc-fraction-template input').length, 2);
  fractionForm.querySelector('[name="numerator"]').value = '2';
  fractionForm.querySelector('[name="denominator"]').value = '8';
  fractionForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(expression.value, '((2)/(8))');
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  assert.equal(view.lastResult, 0.25);
  expression.value = '1/2';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  container.querySelector('.sc-frac-key').click();
  assert.equal(container.querySelector('.sc-answer-value .sc-fraction-numerator').textContent, '1');
  assert.equal(container.querySelector('.sc-answer-value .sc-fraction-denominator').textContent, '2');
  assert.equal(container.querySelector('.sc-answer-value').getAttribute('aria-label'), '1 over 2');
  container.querySelector('.sc-send-fraction').click();
  assert.equal(expression.value, '(1/2)');
  container.querySelector('.sc-key[data-action="shift"]').click();
  container.querySelector('.sc-key[data-key="sin"]').click();
  assert.equal(expression.value, '(1/2)asin()');
  container.querySelector('.sc-key[data-action="alpha"]').click();
  container.querySelector('.sc-key[data-key="sin"]').click();
  assert.equal(expression.value, '(1/2)asin()sec()');
  container.querySelector('.sc-drg-key').click();
  assert.equal(view.data.settings.angleMode, 'RAD');
  assert.equal(view.data.settings.fractionDisplay, true);
});

test('calculator exposes working graph, 3D, integral, units and personal-tool workspaces', () => {
  const { document } = newDOM();
  const container = document.createElement('div');
  new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  assert.equal(container.querySelector('.sc-graph-svg'), null, 'the calculator screen shows library and notes, not the graph');
  assert.ok(container.querySelector('.sc-side-column'), 'local library and notes stay beside the calculator workspace');
  container.querySelector('.sc-mode-button[data-mode="graph"]').click();
  assert.match(container.querySelector('.sc-graph-svg').getAttribute('aria-label'), /graph/);
  assert.equal(container.querySelectorAll('.sc-graph-function-row').length, 2);
  container.querySelector('.sc-mode-button[data-mode="3d"]').click();
  assert.ok(container.querySelector('.sc-surface-canvas'));
  assert.match(container.querySelector('.sc-surface-canvas').getAttribute('aria-label'), /Drag to rotate/);
  container.querySelector('.sc-mode-button[data-mode="integrals"]').click();
  assert.ok(container.querySelector('.sc-integral-form'));
  container.querySelector('.sc-mode-button[data-mode="units"]').click();
  assert.ok(container.querySelectorAll('.sc-units-form optgroup').length >= 15);
  container.querySelector('.sc-mode-button[data-mode="all-tools"]').click();
  assert.ok(container.querySelector('[data-open-mode="chemistry"]'));
  assert.ok(container.querySelector('[data-open-mode="pharmacy"]'));
  container.querySelector('.sc-side-tabs [data-panel="formulas"]').click();
  assert.ok(container.querySelector('.sc-custom-formula-form'));
});

test('private calculator clearly states that history is memory-only for the private session', () => {
  const { document } = newDOM();
  const container = document.createElement('div');
  new ScientificCalculator({ container, data: defaultScientificCalculatorData(), privateMode: true });
  assert.match(container.querySelector('.sc-subtitle').textContent, /not saved to your profile|Nothing here is saved to your profile/);
  assert.match(container.querySelector('.sc-local-note').textContent, /remain in memory/);
});
