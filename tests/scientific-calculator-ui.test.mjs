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

test('the answer, heading and workspace tabs scroll alongside the science tools, not below the static calculator', () => {
  const { document } = newDOM();
  const container = document.createElement('div');
  new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const calculatorColumn = container.querySelector('.sc-calculator-column');
  const workspaceColumn = container.querySelector('.sc-workspace-column');
  assert.ok(calculatorColumn.querySelector('.sc-calculator-device'));
  assert.equal(calculatorColumn.querySelector('.sc-answer-card'), null,
    'the result is no longer clipped below the left-side calculator');
  assert.equal(workspaceColumn.querySelector('.sc-answer-card').parentElement, workspaceColumn,
    'the result is in the scrollable right side');
  assert.ok(workspaceColumn.querySelector('.sc-header'));
  assert.ok(workspaceColumn.querySelector('.sc-workspace-nav'));
});

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

test('Ans recalls the last numeric answer immediately, including after AC, and feeds later expressions', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const expression = container.querySelector('.sc-expression');
  expression.value = '6 * 7';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  assert.equal(view.lastAnswer, 42);

  const historyLength = view.data.history.length;
  container.querySelector('.sc-key[data-action="clear"]').click();
  assert.equal(view.lastResult, null, 'AC clears the current display result');
  assert.equal(view.lastAnswer, 42, 'AC keeps the answer memory');
  assert.equal(container.querySelector('.sc-screen-result').textContent, '0');

  container.querySelector('.sc-key[data-action="answer"]').click();
  assert.equal(expression.value, '42', 'Ans on a blank expression recalls the numeric answer directly');
  assert.equal(container.querySelector('.sc-screen-result').textContent, '42');
  assert.equal(container.querySelector('.sc-answer-value').textContent, '42');
  assert.equal(view.data.history.length, historyLength, 'recalling Ans does not create a duplicate calculation');

  expression.value = 'ans + 1';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  assert.equal(container.querySelector('.sc-answer-value').textContent, '43');
  assert.equal(view.lastAnswer, 43, 'each new calculation immediately becomes the next Ans value');
});

test('settings control is visibly labeled and opens calculator settings', () => {
  const { document } = newDOM();
  const container = document.createElement('div');
  let opened = 0;
  new ScientificCalculator({ container, data: defaultScientificCalculatorData(), onOpenSettings: () => { opened += 1; } });
  const button = container.querySelector('.sc-open-settings');
  assert.equal(button.querySelector('.sc-settings-label').textContent, 'Settings');
  assert.equal(button.getAttribute('aria-label'), 'Calculator settings');
  button.click();
  assert.equal(opened, 1);
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
  assert.match(keyAt('SHIFT'), /grid-column:1 \/ span 5;grid-row:1/);
  assert.match(keyAt('ALPHA'), /grid-column:6 \/ span 5;grid-row:1/);
  assert.match(keyAt('MODE'), /grid-column:21 \/ span 5;grid-row:1/);
  assert.match(keyAt('CALC'), /grid-column:1 \/ span 5;grid-row:2/);
  assert.match(keyAt('a\/b'), /grid-column:1 \/ span 5;grid-row:3/);
  assert.match(keyAt('RCL'), /grid-column:1 \/ span 5;grid-row:5/);
  assert.match(keyAt('7'), /grid-column:1 \/ span 6;grid-row:6/);
  assert.match(keyAt('4'), /grid-column:1 \/ span 6;grid-row:7/);
  assert.match(keyAt('1'), /grid-column:1 \/ span 6;grid-row:8/);
  assert.match(keyAt('0'), /grid-column:1 \/ span 6;grid-row:9/);
  assert.match(keyAt('='), /grid-column:25 \/ span 6;grid-row:9/);
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

test('MODE, SHIFT setup, CLR, constants and ON work as a local scientific calculator', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const key = (name) => container.querySelector(`.sc-key[data-key="${name}"]`);
  key('MODE').click();
  assert.deepEqual([...container.querySelectorAll('[data-mode-choice]')].map((button) => button.dataset.modeChoice), ['COMP','CMPLX','STAT','BASE-N','EQN','MATRIX','TABLE','VECTOR']);
  container.querySelector('[data-mode-choice="CMPLX"]').click();
  assert.equal(view.calculationMode, 'CMPLX');
  const complexForm = container.querySelector('[data-calc-mode="CMPLX"]');
  complexForm.querySelector('[name="op"]').value = 'multiply';
  complexForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-calc-mode-result').textContent, /-5 \+ 10i/);

  key('SHIFT').click(); key('MODE').click();
  assert.ok(container.querySelector('[data-setup-angle="DEG"]'));
  assert.ok(container.querySelector('[data-setup-angle="RAD"]'));
  assert.ok(container.querySelector('[data-setup-angle="GRAD"]'));
  container.querySelector('[data-setup-format="FIX"]').click();
  const digits = container.querySelector('[data-fixed-digits]'); digits.value = '4'; digits.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(view.data.settings.notation, 'fixed');
  assert.equal(view.data.settings.fixedDigits, 4);
  assert.equal(container.querySelector('.sc-display-format').textContent, 'FIX4');
  container.querySelector('.sc-dialog-close').click();

  view.data.memory = 15; view.data.variables.x = { value: 2, unit: '', updatedAt: Date.now() };
  key('SHIFT').click(); key('9').click();
  assert.ok(container.querySelector('[data-clear-choice="all"]'));
  container.querySelector('[data-clear-choice="memory"]').click();
  assert.equal(view.data.memory, null);
  assert.equal(view.data.variables.x, undefined);

  key('SHIFT').click(); key('7').click();
  const constants = container.querySelectorAll('.sc-constant-item');
  assert.ok(constants.length >= 40);
  const speedOfLight = [...constants].find((button) => button.querySelector('strong').textContent === 'Speed of light in vacuum');
  assert.ok(speedOfLight);
  speedOfLight.click();
  assert.equal(container.querySelector('.sc-expression').value, '299792458');

  view.data.memory = 8;
  key('ON').click();
  assert.equal(container.querySelector('.sc-expression').value, '');
  assert.equal(view.lastResult, null);
  assert.equal(view.data.memory, 8, 'ON clears the expression/result but not stored calculator memory');
});

test('calculation mode workspaces compute statistics, base conversions, tables and vectors', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const choose = (mode) => { view.setCalculationMode(mode); return container.querySelector('[data-calc-mode]'); };
  let form = choose('STAT');
  form.querySelector('[name="values"]').value = '2, 4, 6';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-calc-mode-result').textContent, /Mean = 4/);
  form = choose('BASE-N'); form.querySelector('[name="value"]').value = '101101'; form.querySelector('[name="base"]').value = '2';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-calc-mode-result').textContent, /Decimal: 45/);
  form = choose('TABLE'); form.querySelector('[name="expression"]').value = 'x^2'; form.querySelector('[name="start"]').value = '0'; form.querySelector('[name="end"]').value = '2'; form.querySelector('[name="step"]').value = '1';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-calc-mode-result').textContent, /x = 2\s+→\s+4/);
  form = choose('VECTOR'); form.querySelector('[name="u"]').value = '1,2,3'; form.querySelector('[name="v"]').value = '4,5,6'; form.querySelector('[name="op"]').value = 'cross';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-calc-mode-result').textContent, /-3, 6, -3/);
});

test('SHIFT plus/minus convert between rectangular and polar coordinates', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  const view = new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const input = container.querySelector('.sc-expression');
  container.querySelector('.sc-key[data-key="SHIFT"]').click();
  container.querySelector('.sc-key[data-key="+"]').click();
  let form = container.querySelector('.sc-coordinate-form');
  form.querySelector('[name="first"]').value = '3'; form.querySelector('[name="second"]').value = '4';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-coordinate-result').textContent, /r = 5/);
  container.querySelector('.sc-coordinate-result button').click();
  assert.equal(input.value, '5');

  container.querySelector('.sc-key[data-key="SHIFT"]').click();
  container.querySelector('.sc-key[data-key="−"]').click();
  form = container.querySelector('.sc-coordinate-form');
  form.querySelector('[name="first"]').value = '2'; form.querySelector('[name="second"]').value = '90';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(container.querySelector('.sc-coordinate-result').textContent, /y = 2/);
  assert.equal(view.data.settings.angleMode, 'DEG');
});

test('Setup formatting immediately refreshes the displayed numeric answer', () => {
  const { document, window } = newDOM();
  const container = document.createElement('div');
  new ScientificCalculator({ container, data: defaultScientificCalculatorData() });
  const expression = container.querySelector('.sc-expression'); expression.value = '4/3';
  container.querySelector('.sc-key[data-action="evaluate"]').click();
  container.querySelector('.sc-key[data-key="SHIFT"]').click();
  container.querySelector('.sc-key[data-key="MODE"]').click();
  container.querySelector('[data-setup-format="FIX"]').click();
  const digits = container.querySelector('[data-fixed-digits]'); digits.value = '2'; digits.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(container.querySelector('.sc-screen-result').textContent, '1.33');
  assert.equal(container.querySelector('.sc-answer-value').textContent, '1.33');
});
