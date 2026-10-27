import {
  SCIENTIFIC_CONSTANTS,
  SCIENTIFIC_FORMULAS,
  SCIENTIFIC_UNIT_GROUPS,
  computeDilution,
  computeInfusionRate,
  computeMolarity,
  computePH,
  computeWeightBasedAmount,
  calculateMolarMass,
  convertUnit,
  evaluateExpression,
  findFunctionExtrema,
  findFunctionIntersections,
  findFunctionRoots,
  formatFraction,
  formatNumber,
  getUnitMetadata,
  integrateFunction,
  sampleFunction,
  sampleSurface,
  solveLinearEquation,
  solveQuadratic,
  validateCalculatorVariableName
} from '../services/scientificCalculator.js';
import { SCIENTIFIC_CALCULATOR_SCHEMA, defaultScientificCalculatorData, sanitizeScientificCalculatorData } from '../services/scientificCalculatorStorage.js';
import { Icons } from '../icons/icons.js';

const NAV_ITEMS = [
  ['calculator', 'Calculator', '▦'], ['history', 'History', '◷'], ['graph', 'Graph', '⌁'],
  ['3d', '3D', '◇'], ['integrals', 'Integrals', '∫'], ['units', 'Units', '⚯'], ['all-tools', 'All tools', '•••']
];
const TOOL_ITEMS = [
  ['solve', 'Equation solver', 'Linear and quadratic equations with transparent working.'],
  ['chemistry', 'Chemistry', 'Molar mass, stoichiometry arithmetic and solution chemistry.'],
  ['pharmacy', 'Pharmacy calculations', 'Explicit arithmetic helpers with safety checks and no prescribing.'],
  ['units', 'Unit converter', 'Broad scientific and SI units with dimension checking.'],
  ['graph', '2D graphing', 'Plot multiple local functions and inspect numerical features.'],
  ['3d', '3D surface plot', 'Interactive sampled z = f(x,y) plots.'],
  ['integrals', 'Numerical integrals', 'Adaptive Simpson and composite trapezoid estimates.']
];
const ESCAPE = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const idFor = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const angleModeLabel = (value) => ({ DEG: 'Degrees', RAD: 'Radians', GRAD: 'Gradians' }[value] || 'Degrees');
const unitLabel = (unit) => { const metadata = getUnitMetadata(unit); return metadata ? `${metadata.name} (${unit})` : unit; };
const unitOptions = (selected = '') => Object.entries(SCIENTIFIC_UNIT_GROUPS).map(([group, units]) => `<optgroup label="${ESCAPE(group)}">${Object.entries(units).map(([unit, [name]]) => `<option value="${ESCAPE(unit)}" ${unit === selected ? 'selected' : ''}>${ESCAPE(name)} (${ESCAPE(unit)})</option>`).join('')}</optgroup>`).join('');

export class ScientificCalculator {
  constructor({ container, data, onDataChange = () => {}, onOpenSettings = () => {}, onPrompt = null, privateMode = false } = {}) {
    if (!container) throw new TypeError('ScientificCalculator requires a container element.');
    this.container = container;
    this.instanceId = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.data = sanitizeScientificCalculatorData(data || defaultScientificCalculatorData());
    this.onDataChange = onDataChange;
    this.onOpenSettings = onOpenSettings;
    this.onPrompt = onPrompt;
    this.privateMode = Boolean(privateMode);
    this.mode = 'calculator';
    this.calculationMode = this.data.settings.calculationMode || 'COMP';
    this.expression = '';
    this.expressionIsEditing = false;
    const latestNumericAnswer = this.data.history.find((entry) => entry.result !== null && entry.result !== undefined && Number.isFinite(Number(entry.result)));
    this.lastAnswer = latestNumericAnswer ? Number(latestNumericAnswer.result) : null;
    this.lastResult = this.lastAnswer;
    this.lastEntryId = null;
    this.sidePanel = 'history';
    this.calculationOutput = null;
    this.shiftActive = false;
    this.alphaActive = false;
    this.hyperbolicActive = false;
    this.displayOn = true;
    this.insertMode = true;
    this.historyCursor = -1;
    this.historyDraft = '';
    this.fractionDisplay = Boolean(this.data.settings.fractionDisplay);
    this.pointerDrag = null;
    this.surfaceRotation = { yaw: -0.62, pitch: 0.58, zoom: 1 };
    this.notesSaveTimer = null;
    this.destroyed = false;
    this.render();
  }

  destroy() {
    this.destroyed = true;
    if (this.notesSaveTimer) clearTimeout(this.notesSaveTimer);
    this.container.replaceChildren();
  }

  persist() {
    if (this.destroyed) return;
    this.data = sanitizeScientificCalculatorData(this.data);
    Promise.resolve(this.onDataChange(this.data)).catch((error) => this.showNotice(error?.message || 'Could not save calculator data on this device.', 'error'));
  }

  showNotice(message, kind = 'info') {
    const node = this.container.querySelector('.sc-notice');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.kind = kind;
    node.hidden = !message;
  }

  fractionPartsForExpression(expression) {
    const unwrap = (value) => {
      let source = String(value || '').trim();
      while (source.startsWith('(') && source.endsWith(')')) {
        let depth = 0;
        let closesAtEnd = true;
        for (let index = 0; index < source.length; index += 1) {
          if (source[index] === '(') depth += 1;
          else if (source[index] === ')') depth -= 1;
          if (depth === 0 && index < source.length - 1) { closesAtEnd = false; break; }
        }
        if (!closesAtEnd || depth !== 0) break;
        source = source.slice(1, -1).trim();
      }
      return source;
    };
    const source = unwrap(expression);
    let depth = 0;
    let slash = -1;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      else if (depth === 0 && character === '/') {
        if (slash >= 0) return null;
        slash = index;
      } else if (depth === 0 && '+−-*×÷^'.includes(character)
        && index !== 0 && source[index - 1] !== '/') return null;
    }
    if (slash <= 0 || slash >= source.length - 1 || depth !== 0) return null;
    const numerator = unwrap(source.slice(0, slash));
    const denominator = unwrap(source.slice(slash + 1));
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    if (!numeric.test(numerator) || !numeric.test(denominator)) return null;
    return { numerator, denominator };
  }

  refreshExpressionPreview() {
    const input = this.container.querySelector('.sc-expression');
    const stage = this.container.querySelector('.sc-expression-stage');
    const preview = this.container.querySelector('.sc-expression-preview');
    if (!input || !stage || !preview) return;
    const source = input.value.trim();
    preview.replaceChildren();
    if (!source) {
      stage.classList.remove('is-rendered');
      preview.removeAttribute('title');
      return;
    }
    const value = document.createElement('span');
    value.className = 'sc-expression-preview-value';
    const fraction = this.fractionPartsForExpression(source);
    if (fraction) this.renderStackedFraction(value, fraction);
    else value.textContent = input.value;
    const edit = document.createElement('span');
    edit.className = 'sc-expression-edit-icon';
    edit.setAttribute('aria-hidden', 'true');
    edit.textContent = '✎';
    preview.append(value, edit);
    preview.setAttribute('aria-label', `Edit expression: ${source}`);
    preview.title = `Click to edit expression: ${source.slice(0, 160)}`;
    stage.classList.toggle('is-rendered', !this.expressionIsEditing);
  }

  showCalculationError(error) {
    this.calculationOutput = null;
    this.lastEntryId = null;
    this.updateAnswer(null);
    const output = this.container.querySelector('.sc-answer-value');
    const screen = this.container.querySelector('.sc-screen-result');
    if (output) { output.textContent = 'No result'; output.classList.add('sc-answer-error'); }
    if (screen) screen.textContent = 'Error';
    this.showNotice(error?.message || 'Could not calculate these values.', 'error');
  }

  render() {
    this.container.innerHTML = `
      <section class="sc-workspace" data-mode="${this.mode}" aria-label="Scientific calculator and science workspace">
        <div class="sc-layout">
          <main class="sc-calculator-column">
            <div class="sc-calculator-device">
              <div class="sc-device-brand"><strong>YAYRA</strong><span>SCIENTIFIC · LOCAL ENGINE</span></div>
              <div class="sc-display">
                <div class="sc-display-status"><span class="sc-display-angle">DEG</span><span class="sc-display-format">NORM1</span><span class="sc-display-mode">COMP</span><span class="sc-display-memory">${this.data.memory === null ? '' : 'M'}</span></div>
                <label class="sc-visually-hidden" for="${this.instanceId}-expression">Calculator expression. Fractions can be typed as numerator/denominator.</label>
                <div class="sc-expression-stage">
                  <textarea id="${this.instanceId}-expression" class="sc-expression" rows="2" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type an expression or fraction, e.g. 3/4 + 1/2" aria-describedby="${this.instanceId}-expression-help"></textarea>
                  <button type="button" class="sc-expression-preview" aria-label="Edit expression" title="Click to edit expression"></button>
                </div>
                <output class="sc-screen-result" aria-live="polite">0</output>
              </div>
              <div class="sc-device-status" aria-label="Calculator display modes">
                <button class="sc-status-key sc-drg-key" type="button" title="Cycle Degrees, Radians and Gradians">DEG</button>
                <button class="sc-status-key sc-frac-key" type="button" aria-pressed="false" title="Toggle fractional answer display">FRAC</button>
                <button class="sc-status-key sc-norm-key" type="button" title="Cycle normal, scientific and engineering notation">NORM1</button>
                <span class="sc-device-status-spacer"></span><span class="sc-device-battery">ON</span>
              </div>
              <div class="sc-keypad" aria-label="Scientific calculator keypad">${this.keypadMarkup()}</div>
              <div class="sc-memory-keys" aria-label="Calculator memory"><button type="button" data-memory="clear" title="Memory clear">MC</button><button type="button" data-memory="recall" title="Recall memory">RCL</button><button type="button" data-memory="add" title="Add result to memory">M+</button><button type="button" data-memory="subtract" title="Subtract result from memory">M−</button><span class="sc-memory-status">${this.data.memory === null ? 'M —' : `M ${ESCAPE(formatNumber(this.data.memory))}`}</span></div>
              <p id="${this.instanceId}-expression-help" class="sc-shortcut-hint">Type fractions as <code>numerator/denominator</code>. Press Enter to calculate.</p>
            </div>
          </main>
          <section class="sc-workspace-column" aria-label="Science workspace">
            <header class="sc-header">
              <div class="sc-heading"><span class="sc-brand-icon">${Icons.calculator}</span><div><p class="sc-eyebrow">${this.privateMode ? 'PRIVATE SESSION · MEMORY ONLY' : 'OFFLINE-FIRST · ON THIS DEVICE'}</p><h1>Scientific calculator</h1><p class="sc-subtitle">${this.privateMode ? 'Nothing here is saved to your profile.' : 'A complete local science desk. Your work stays in this Yayra profile.'}</p></div></div>
              <div class="sc-header-actions">
                <label class="sc-angle-control"><span>Angle</span><select class="sc-angle-mode" aria-label="Angle unit"><option value="DEG">DEG</option><option value="RAD">RAD</option><option value="GRAD">GRAD</option></select></label>
                <label class="sc-angle-control"><span>Digits</span><select class="sc-precision-mode" aria-label="Significant digits"><option value="6">6</option><option value="9">9</option><option value="12">12</option><option value="15">15</option></select></label>
                <label class="sc-angle-control"><span>Format</span><select class="sc-notation-mode" aria-label="Number format"><option value="auto">NORM</option><option value="norm1">NORM1</option><option value="norm2">NORM2</option><option value="fixed">FIX</option><option value="scientific">SCI</option><option value="engineering">ENG</option></select></label>
                <button class="sc-icon-button sc-open-settings" type="button" title="Calculator settings" aria-label="Calculator settings">${Icons.settings}<span class="sc-settings-label">Settings</span></button>
              </div>
            </header>
            <div class="sc-notice" role="status" aria-live="polite" hidden></div>
            <nav class="sc-workspace-nav" aria-label="Scientific workspace">${NAV_ITEMS.map(([key, label, glyph]) => `<button type="button" class="sc-mode-button" data-mode="${key}" aria-pressed="false"><span aria-hidden="true">${glyph}</span><span>${label}</span></button>`).join('')}</nav>
            <section class="sc-answer-card" aria-live="polite" aria-label="Calculation result">
              <div class="sc-answer-heading"><span class="sc-answer-label">RESULT · ${this.privateMode ? 'PRIVATE MEMORY' : 'LOCAL'}</span><div class="sc-answer-actions"><button type="button" class="sc-copy-result" disabled>Copy</button><button type="button" class="sc-send-fraction" disabled title="Insert the result as a numerator/denominator expression">Send fraction</button><button type="button" class="sc-save-result" disabled>Save</button></div></div>
              <output class="sc-answer-value">Ready</output><div class="sc-answer-unit"></div><p class="sc-fraction-approximation" hidden></p><ol class="sc-answer-steps" hidden></ol><p class="sc-answer-disclosure" hidden></p>
            </section>
            <div class="sc-mode-content"></div>
            <aside class="sc-side-column" aria-label="History, saved work, formulas, variables and notes">
              <div class="sc-side-heading"><div><p class="sc-eyebrow">YOUR LOCAL WORK</p><h2>Library &amp; notes</h2></div><span class="sc-local-indicator" title="Stored locally">● LOCAL</span></div>
              <div class="sc-side-tabs" role="tablist" aria-label="Saved calculator data"><button type="button" data-panel="history" role="tab">History</button><button type="button" data-panel="favorites" role="tab">Saved</button><button type="button" data-panel="formulas" role="tab">Formulas</button><button type="button" data-panel="variables" role="tab">Variables</button><button type="button" data-panel="notebooks" role="tab">Notes</button></div>
              <div class="sc-side-content" role="tabpanel"></div>
              <div class="sc-data-actions"><button type="button" class="sc-export">Export backup</button><label class="sc-import-button">Import backup<input class="sc-import-file" type="file" accept="application/json,.json" hidden></label></div>
              <p class="sc-local-note">No account, network, cloud service or AI is needed. The expression parser never executes JavaScript. ${this.privateMode ? 'Private-session history, saved results, variables and notes remain in memory only.' : 'History, formulas, variables and notes are stored on this device in this profile.'}</p>
            </aside>
          </section>
        </div>
        <div class="sc-dialog-host"></div>
      </section>`;
    this.container.querySelector('.sc-angle-mode').value = this.data.settings.angleMode;
    this.container.querySelector('.sc-precision-mode').value = String(this.data.settings.precision);
    this.container.querySelector('.sc-notation-mode').value = this.data.settings.notation;
    this.container.querySelector('.sc-angle-mode').addEventListener('change', (event) => {
      this.data.settings.angleMode = ['DEG', 'RAD', 'GRAD'].includes(event.target.value) ? event.target.value : 'DEG';
      this.persist(); this.updateDeviceStatus(); this.showNotice(`Angle mode set to ${angleModeLabel(this.data.settings.angleMode)}.`);
    });
    this.container.querySelector('.sc-precision-mode').addEventListener('change', (event) => { this.data.settings.precision = Math.max(3, Math.min(15, Number(event.target.value) || 12)); this.persist(); this.showNotice(`Results use ${this.data.settings.precision} significant digits.`); });
    this.container.querySelector('.sc-notation-mode').addEventListener('change', (event) => { this.data.settings.notation = ['scientific', 'engineering', 'norm1', 'norm2', 'fixed'].includes(event.target.value) ? event.target.value : 'auto'; this.persist(); this.updateDeviceStatus(); this.refreshFormattedAnswer(); this.showNotice(`Number format set to ${this.data.settings.notation}.`); });
    this.container.querySelector('.sc-open-settings').addEventListener('click', () => this.onOpenSettings());
    const expressionInput = this.container.querySelector('.sc-expression');
    expressionInput.addEventListener('input', () => { this.expression = expressionInput.value; this.refreshExpressionPreview(); });
    expressionInput.addEventListener('focus', () => { this.expressionIsEditing = true; this.refreshExpressionPreview(); });
    expressionInput.addEventListener('blur', () => { this.expressionIsEditing = false; this.refreshExpressionPreview(); });
    const editExpression = () => {
      this.expressionIsEditing = true;
      this.container.querySelector('.sc-expression-stage')?.classList.remove('is-rendered');
      expressionInput.focus();
    };
    this.container.querySelector('.sc-expression-preview')?.addEventListener('click', editExpression);
    this.container.querySelector('.sc-expression-preview')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editExpression(); }
    });
    expressionInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.evaluateCurrent(); } });
    this.container.querySelectorAll('.sc-key').forEach((button) => button.addEventListener('click', () => this.handleKey(button.dataset.key, button.dataset.action, expressionInput, button)));
    this.container.querySelectorAll('.sc-navigation-pad [data-nav]').forEach((button) => button.addEventListener('click', () => this.moveNavigation(button.dataset.nav, expressionInput)));
    this.container.querySelectorAll('.sc-memory-keys [data-memory]').forEach((button) => button.addEventListener('click', () => this.handleMemory(button.dataset.memory, expressionInput)));
    this.container.querySelectorAll('.sc-mode-button').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.mode)));
    this.container.querySelectorAll('.sc-side-tabs [data-panel]').forEach((button) => button.addEventListener('click', () => this.setSidePanel(button.dataset.panel)));
    this.container.querySelector('.sc-copy-result').addEventListener('click', () => this.copyResult());
    this.container.querySelector('.sc-send-fraction').addEventListener('click', () => this.sendFractionToExpression());
    this.container.querySelector('.sc-save-result').addEventListener('click', () => this.saveResult());
    this.container.querySelector('.sc-export').addEventListener('click', () => this.exportBackup());
    this.container.querySelector('.sc-import-file').addEventListener('change', (event) => this.importBackup(event));
    this.container.querySelector('.sc-drg-key').addEventListener('click', () => this.cycleAngleMode());
    this.container.querySelector('.sc-frac-key').addEventListener('click', () => this.toggleFractionDisplay());
    this.container.querySelector('.sc-norm-key').addEventListener('click', () => this.cycleNotation());
    this.renderMode();
    this.container.querySelector('.sc-frac-key')?.setAttribute('aria-pressed', String(this.fractionDisplay));
    this.container.querySelector('.sc-frac-key')?.classList.toggle('is-active', this.fractionDisplay);
    this.updateDeviceStatus();
    this.container.querySelectorAll('.sc-mode-button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode)));
    this.renderSidePanel();
    this.updateAnswer(null);
  }

  keypadMarkup() {
    const rows = [
      [
        ['SHIFT', 'shift', '', '', ''], ['ALPHA', 'alpha', '', '', ''], null, null,
        ['MODE', 'mode', '', '', 'SETUP'], ['ON', 'on', '', '', '']
      ],
      [
        ['CALC', 'evaluate', '', '', 'SOLVE ='], ['∫dx', 'integral', '', '', '∫ f(x)'], null, null,
        ['x^□', 'power', '!', '', 'x!'], ['loga', 'logbase', 'log()', '', '']
      ],
      [
        ['a/b', 'fraction', '', '', ''], ['√', 'sqrt', 'cbrt(', '', '∛'], ['x²', 'square', 'sqrt(', '', '√x'],
        ['xʸ', 'power', 'root(,)', '', 'ʸ√x'], ['log', 'log', '10^(', '', '10ˣ'], ['ln', 'ln', 'exp()', '', 'eˣ']
      ],
      [
        ['(−)', 'negative', '', '', ''], ['° ′ ″', 'dms', '', '', ''], ['hyp', 'hyp', '', '', ''],
        ['sin', 'trig', 'asin', 'sec', 'sin⁻¹'], ['cos', 'trig', 'acos', 'csc', 'cos⁻¹'], ['tan', 'trig', 'atan', 'cot', 'tan⁻¹']
      ],
      [
        ['RCL', 'memory-recall', 'store', '', 'STO'], ['ENG', 'eng', 'scientific', '', 'SCI'], ['(', 'insert', '', 'a', ''],
        [')', 'insert', '', 'b', ''], ['S↔D', 'fraction-display', '', '', ''], ['M+', 'memory-add', 'memory-subtract', '', 'M−']
      ],
      [
        ['7', 'insert', 'constants', 'x', 'CONST'], ['8', 'insert', 'units', 'y', 'CONV'], ['9', 'insert', 'clear', 'z', 'CLR'],
        ['DEL', 'delete', 'insert-mode', '', 'INS'], ['AC', 'clear', 'off', '', 'OFF'], null
      ],
      [
        ['4', 'insert', 'npr(,)', 'm', 'max('], ['5', 'insert', 'ncr(,)', 'd', 'min('], ['6', 'insert', '!', 'f', 'FACT'],
        ['×', 'insert', 'npr(,)', '', 'nPr'], ['÷', 'insert', 'ncr(,)', '', 'nCr'], null
      ],
      [
        ['1', 'insert', 'mean()', 'p', 'STAT'], ['2', 'insert', 'median()', 'q', 'MED'], ['3', 'insert', 'stdev()', 'h', 'σ'],
        ['+', 'insert', '', '', ''], ['−', 'insert', '', '', ''], null
      ],
      [
        ['0', 'insert', 'cbrt()', 'i', 'cbrt'], ['.', 'insert', 'exp()', 'j', 'exp'], ['×10ˣ', 'insert', '*10^(', '', ''],
        ['Ans', 'answer', 'rand()', 'randint(,)', 'RAN#'], ['=', 'evaluate', '', '', 'EXE'], null
      ]
    ];
    const navPad = `<div class="sc-navigation-pad" role="group" aria-label="Expression cursor and history controls"><button type="button" data-nav="up" aria-label="Previous history item">▲</button><button type="button" data-nav="left" aria-label="Move cursor left">◀</button><button type="button" class="sc-navigation-center" data-nav="center" aria-label="Calculate">●</button><button type="button" data-nav="right" aria-label="Move cursor right">▶</button><button type="button" data-nav="down" aria-label="Next history item">▼</button></div>`;
    let markup = '';
    rows.forEach((row, rowIndex) => row.forEach((item, colIndex) => {
      if (!item) return;
      const rowNumber = rowIndex + 1; const columnNumber = colIndex + 1;
      if ((rowNumber === 1 || rowNumber === 2) && (columnNumber === 3 || columnNumber === 4)) return;
      const [label, action, shift, alpha, shiftCaption] = item;
      const trackSpan = rowNumber >= 6 && row.filter(Boolean).length === 5 ? 6 : 5;
      const gridColumn = ((columnNumber - 1) * trackSpan) + 1;
      const keyClass = ['=', 'evaluate'].includes(label) ? 'sc-key-equals' : ['×', '÷', '−', '+', 'x^□'].includes(label) ? 'sc-key-operator' : ['SHIFT', 'ALPHA', 'MODE', 'HYP'].includes(label) ? 'sc-key-function' : /^\d$/.test(label) || label === '.' ? 'sc-key-number' : '';
      const small = shiftCaption || shift;
      markup += `<button type="button" class="sc-key ${keyClass} sc-key-${action}" data-key="${ESCAPE(label)}" data-action="${action}" data-shift="${ESCAPE(shift)}" data-alpha="${ESCAPE(alpha)}" style="grid-column:${gridColumn} / span ${trackSpan};grid-row:${rowNumber}" aria-label="${ESCAPE(label === '=' ? 'Evaluate expression' : label === 'a/b' ? 'Insert a stacked fraction' : label)}"><small>${ESCAPE(small || '')}</small><strong>${ESCAPE(label)}</strong><small>${ESCAPE(alpha || '')}</small></button>`;
    }));
    return `${markup}${navPad}`;
  }

  setMode(mode) {
    const allowed = [...NAV_ITEMS.map(([key]) => key), 'solve', 'chemistry', 'pharmacy'];
    if (!allowed.includes(mode)) return;
    this.mode = mode;
    if (mode === 'history') this.sidePanel = 'history';
    this.data.settings.defaultMode = 'calculator';
    this.persist();
    this.container.querySelectorAll('.sc-mode-button').forEach((button) => button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false'));
    this.renderMode();
    this.updateAnswer(null);
  }

  setSidePanel(panel) {
    if (!['history', 'favorites', 'formulas', 'variables', 'notebooks'].includes(panel)) return;
    this.sidePanel = panel;
    this.container.querySelectorAll('.sc-side-tabs [data-panel]').forEach((button) => button.setAttribute('aria-selected', button.dataset.panel === panel ? 'true' : 'false'));
    this.renderSidePanel();
  }

  renderMode() {
    const target = this.container.querySelector('.sc-mode-content');
    if (!target) return;
    this.container.querySelector('.sc-workspace')?.setAttribute('data-mode', this.mode);
    this.container.querySelector('.sc-workspace-column')?.classList.toggle('sc-mode-library', ['history'].includes(this.mode));
    if (this.mode === 'calculator') { target.innerHTML = this.calculationMode === 'COMP' ? '' : this.calculationModeMarkup(); }
    else if (this.mode === 'graph') target.innerHTML = this.graphMarkup(false);
    else if (this.mode === '3d') target.innerHTML = this.surfaceMarkup();
    else if (this.mode === 'integrals') target.innerHTML = this.integralMarkup();
    else if (this.mode === 'units') target.innerHTML = this.unitsMarkup();
    else if (this.mode === 'solve') target.innerHTML = this.solveMarkup();
    else if (this.mode === 'chemistry') target.innerHTML = this.chemistryMarkup();
    else if (this.mode === 'pharmacy') target.innerHTML = this.pharmacyMarkup();
    else if (this.mode === 'history') target.innerHTML = '<div class="sc-history-prompt"><p class="sc-eyebrow">CALCULATION HISTORY</p><h2>Pick up where you left off</h2><p>Use the history cards below to restore an expression without calculating it again.</p></div>';
    else if (this.mode === 'all-tools') target.innerHTML = this.allToolsMarkup();
    this.bindModeEvents();
    if (this.mode === 'calculator' && this.calculationMode !== 'COMP') this.bindCalculationMode();
    this.container.querySelectorAll('[data-open-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.openMode)));
    if (this.mode === 'graph') this.drawGraph();
    if (this.mode === '3d') this.drawSurface();
  }

  calculationModeMarkup() {
    const common = '<div class="sc-calc-mode-result" aria-live="polite"></div>';
    const wrap = (eyebrow, title, form, note = '') => `<section class="sc-tool-card sc-calc-mode-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">${eyebrow}</p><h2>${title}</h2></div><button type="button" class="sc-mode-switch">MODE</button></div>${form}${common}${note ? `<p class="sc-field-help">${note}</p>` : ''}</section>`;
    if (this.calculationMode === 'CMPLX') return wrap('COMPLEX NUMBER WORKSPACE', 'Complex arithmetic', `<form class="sc-form sc-calc-mode-form" data-calc-mode="CMPLX"><div class="sc-form-grid sc-four-fields"><label>z₁ real<input name="a" type="number" step="any" value="1"></label><label>z₁ imag<input name="b" type="number" step="any" value="2"></label><label>z₂ real<input name="c" type="number" step="any" value="3"></label><label>z₂ imag<input name="d" type="number" step="any" value="4"></label></div><label>Operation<select name="op"><option value="add">z₁ + z₂</option><option value="subtract">z₁ − z₂</option><option value="multiply">z₁ × z₂</option><option value="divide">z₁ ÷ z₂</option></select></label><button class="sc-primary-button">Calculate</button></form>`, 'Complex arithmetic is handled locally for addition, subtraction, multiplication and division.');
    if (this.calculationMode === 'STAT') return wrap('STATISTICS WORKSPACE', 'One-variable statistics', `<form class="sc-form sc-calc-mode-form" data-calc-mode="STAT"><label>Data values, separated by commas or spaces<textarea name="values" rows="3" placeholder="2, 4, 6, 8">2, 4, 6, 8</textarea></label><label>Standard deviation<select name="sample"><option value="population">Population</option><option value="sample">Sample</option></select></label><button class="sc-primary-button">Calculate statistics</button></form>`, 'Reports count, sum, mean, median, range, variance and standard deviation.');
    if (this.calculationMode === 'BASE-N') return wrap('BASE-N WORKSPACE', 'Number base conversion', `<form class="sc-form sc-calc-mode-form" data-calc-mode="BASE-N"><label>Integer value<input name="value" value="101101" inputmode="text" required></label><label>Input base<select name="base"><option value="2">Binary</option><option value="8">Octal</option><option value="10">Decimal</option><option value="16">Hexadecimal</option></select></label><button class="sc-primary-button">Convert bases</button></form>`, 'Supports signed safe integers in binary, octal, decimal and hexadecimal.');
    if (this.calculationMode === 'EQN') return wrap('EQUATION WORKSPACE', 'Linear & quadratic equations', `<form class="sc-form sc-calc-mode-form" data-calc-mode="EQN"><label>Equation type<select name="kind"><option value="quadratic">ax² + bx + c = 0</option><option value="linear">ax + b = c</option></select></label><div class="sc-form-grid sc-three-fields"><label>a<input name="a" type="number" step="any" value="1"></label><label>b<input name="b" type="number" step="any" value="-3"></label><label>c<input name="c" type="number" step="any" value="2"></label></div><button class="sc-primary-button">Solve equation</button></form>`);
    if (this.calculationMode === 'MATRIX') return wrap('MATRIX WORKSPACE', '2 × 2 matrix', `<form class="sc-form sc-calc-mode-form" data-calc-mode="MATRIX"><div class="sc-form-grid sc-four-fields">${['a','b','c','d'].map((n, i) => `<label>${n.toUpperCase()}<input name="${n}" type="number" step="any" value="${[1,2,3,4][i]}"></label>`).join('')}</div><label>Operation<select name="op"><option value="det">Determinant</option><option value="inverse">Inverse</option></select></label><button class="sc-primary-button">Calculate matrix</button></form>`, 'For matrix [[a,b],[c,d]], calculate its determinant or inverse when nonsingular.');
    if (this.calculationMode === 'TABLE') return wrap('TABLE WORKSPACE', 'Function value table', `<form class="sc-form sc-calc-mode-form" data-calc-mode="TABLE"><label>f(x)<input name="expression" value="x^2" required></label><div class="sc-form-grid sc-three-fields"><label>Start<input name="start" type="number" step="any" value="-3"></label><label>End<input name="end" type="number" step="any" value="3"></label><label>Step<input name="step" type="number" step="any" value="1"></label></div><button class="sc-primary-button">Generate table</button></form>`, 'Evaluates a local expression at up to 101 evenly stepped x-values.');
    if (this.calculationMode === 'VECTOR') return wrap('VECTOR WORKSPACE', '2D & 3D vector operations', `<form class="sc-form sc-calc-mode-form" data-calc-mode="VECTOR"><label>Vector u (2 or 3 components)<input name="u" value="1, 2, 3" required></label><label>Vector v<input name="v" value="4, 5, 6" required></label><label>Operation<select name="op"><option value="dot">Dot product</option><option value="cross">Cross product (3D)</option><option value="add">u + v</option><option value="magnitude">Magnitude of u</option></select></label><button class="sc-primary-button">Calculate vectors</button></form>`, 'Vectors are comma-separated finite real components.');
    return '';
  }

  setCalculationMode(mode) {
    const choices = ['COMP', 'CMPLX', 'STAT', 'BASE-N', 'EQN', 'MATRIX', 'TABLE', 'VECTOR'];
    if (!choices.includes(mode)) return;
    this.calculationMode = mode;
    this.data.settings.calculationMode = mode;
    this.persist();
    const readout = this.container.querySelector('.sc-display-mode'); if (readout) readout.textContent = mode;
    this.renderMode();
    this.showNotice(`${mode} mode selected.`);
  }

  bindCalculationMode() {
    this.container.querySelector('.sc-mode-switch')?.addEventListener('click', () => this.openModeDialog());
    this.container.querySelector('.sc-calc-mode-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const field = (name) => form.querySelector(`[name="${name}"]`)?.value;
      const result = this.container.querySelector('.sc-calc-mode-result');
      try {
        let lines = [];
        if (this.calculationMode === 'CMPLX') {
          const a = Number(field('a')); const b = Number(field('b')); const c = Number(field('c')); const d = Number(field('d')); let re; let im;
          if (![a,b,c,d].every(Number.isFinite)) throw new Error('Enter finite real and imaginary parts.');
          const op = field('op');
          if (op === 'add') { re = a+c; im = b+d; } else if (op === 'subtract') { re = a-c; im = b-d; } else if (op === 'multiply') { re = a*c-b*d; im = a*d+b*c; }
          else { const denominator = c*c+d*d; if (!denominator) throw new Error('Cannot divide by zero complex number.'); re = (a*c+b*d)/denominator; im = (b*c-a*d)/denominator; }
          lines = [`Result: ${formatNumber(re)} ${im < 0 ? '−' : '+'} ${formatNumber(Math.abs(im))}i`, `Real part: ${formatNumber(re)} · Imaginary part: ${formatNumber(im)}`];
        } else if (this.calculationMode === 'STAT') {
          const values = field('values').trim().split(/[\s,;]+/).filter(Boolean).map(Number);
          if (!values.length || values.length > 1000 || values.some((x) => !Number.isFinite(x))) throw new Error('Enter 1–1000 finite numbers separated by commas or spaces.');
          const sorted = [...values].sort((a,b) => a-b); const mean = values.reduce((a,b) => a+b,0)/values.length; const denominator = field('sample') === 'sample' ? values.length-1 : values.length;
          if (denominator <= 0) throw new Error('Sample standard deviation needs at least two values.');
          const variance = values.reduce((sum,x) => sum+(x-mean)**2,0)/denominator; const median = sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
          lines = [`n = ${values.length} · Σx = ${formatNumber(values.reduce((a,b)=>a+b,0))}`, `Mean = ${formatNumber(mean)} · Median = ${formatNumber(median)}`, `Variance = ${formatNumber(variance)} · Standard deviation = ${formatNumber(Math.sqrt(variance))}`, `Minimum = ${formatNumber(sorted[0])} · Maximum = ${formatNumber(sorted.at(-1))} · Range = ${formatNumber(sorted.at(-1)-sorted[0])}`];
        } else if (this.calculationMode === 'BASE-N') {
          const base = Number(field('base')); const text = field('value').trim();
          if (!/^[+-]?(?:[0-9a-f]+)$/i.test(text)) throw new Error('Enter a signed integer using digits valid for the selected base.');
          const value = Number.parseInt(text, base); if (!Number.isSafeInteger(value)) throw new Error('Value is not a safe integer for this calculator.');
          const valid = base === 2 ? /^[+-]?[01]+$/ : base === 8 ? /^[+-]?[0-7]+$/ : base === 10 ? /^[+-]?\d+$/ : /^[+-]?[0-9a-f]+$/i;
          if (!valid.test(text)) throw new Error('The value contains a digit that is invalid for the selected base.');
          lines = [`Decimal: ${value}`, `Binary: ${value.toString(2)}`, `Octal: ${value.toString(8)}`, `Hexadecimal: ${value.toString(16).toUpperCase()}`];
        } else if (this.calculationMode === 'EQN') {
          const output = field('kind') === 'linear' ? solveLinearEquation({a:field('a'), b:field('b'), c:field('c')}) : solveQuadratic({a:field('a'), b:field('b'), c:field('c')});
          lines = output.roots ? (output.roots.length ? output.roots.map((x,i) => `x${output.roots.length > 1 ? i+1 : ''} = ${formatNumber(x)}`) : ['No real roots.']) : [`x = ${formatNumber(output.value)}`];
        } else if (this.calculationMode === 'MATRIX') {
          const [a,b,c,d] = ['a','b','c','d'].map((n) => Number(field(n))); if (![a,b,c,d].every(Number.isFinite)) throw new Error('Enter four finite matrix entries.'); const det = a*d-b*c;
          lines = field('op') === 'det' ? [`det(A) = ad − bc = ${formatNumber(det)}`] : Math.abs(det) < 1e-14 ? ['Matrix is singular; inverse does not exist.'] : [`A⁻¹ = [[${formatNumber(d/det)}, ${formatNumber(-b/det)}], [${formatNumber(-c/det)}, ${formatNumber(a/det)}]]`];
        } else if (this.calculationMode === 'TABLE') {
          const start = Number(field('start')); const end = Number(field('end')); const step = Number(field('step')); if (![start,end,step].every(Number.isFinite) || step <= 0 || end < start || (end-start)/step > 100) throw new Error('Choose a positive step and a range containing at most 101 values.');
          for (let x=start; x <= end+step*1e-9; x+=step) lines.push(`x = ${formatNumber(x)}  →  ${formatNumber(evaluateExpression(field('expression'), {variables:{...this.data.variables,x}, angleMode:this.data.settings.angleMode}).value)}`);
        } else if (this.calculationMode === 'VECTOR') {
          const parseVector = (text) => text.split(/[\s,;]+/).filter(Boolean).map(Number); const u=parseVector(field('u')); const v=parseVector(field('v'));
          if (![u,v].every((vec) => vec.length >= 2 && vec.length <= 3 && vec.every(Number.isFinite)) || (field('op') !== 'magnitude' && u.length !== v.length)) throw new Error('Vectors need two or three finite components; u and v must have equal lengths.');
          if (field('op') === 'magnitude') lines=[`|u| = ${formatNumber(Math.hypot(...u))}`];
          else if (field('op') === 'dot') lines=[`u · v = ${formatNumber(u.reduce((sum,x,i)=>sum+x*v[i],0))}`];
          else if (field('op') === 'add') lines=[`u + v = (${u.map((x,i)=>formatNumber(x+v[i])).join(', ')})`];
          else { if (u.length!==3) throw new Error('Cross product requires three-dimensional vectors.'); lines=[`u × v = (${formatNumber(u[1]*v[2]-u[2]*v[1])}, ${formatNumber(u[2]*v[0]-u[0]*v[2])}, ${formatNumber(u[0]*v[1]-u[1]*v[0])})`]; }
        }
        result.innerHTML = `<ul>${lines.map((line) => `<li>${ESCAPE(line)}</li>`).join('')}</ul>`;
      } catch (error) { result.textContent = error.message; }
    });
  }

  calculatorMarkup() { return ''; }

  graphMarkup(compact = false) {
    const range = this.data.graphRange;
    return `<section class="sc-tool-card sc-graph-card ${compact ? 'sc-graph-card-focus' : ''}">
      <div class="sc-tool-title"><div><p class="sc-eyebrow">OFFLINE PLOTTER · ${this.data.graphFunctions.filter((row) => row.visible).length} CURVES</p><h2>${compact ? 'Graph workspace' : '2D graphing calculator'}</h2></div><div class="sc-graph-actions"><button type="button" class="sc-export-graph">Export SVG</button><button type="button" class="sc-print-graph">Print graph</button></div></div>
      <div class="sc-graph-range-row"><label>x min<input name="xMin" class="sc-range-input" type="number" step="any" value="${range.xMin}"></label><label>x max<input name="xMax" class="sc-range-input" type="number" step="any" value="${range.xMax}"></label><label>y min<input name="yMin" class="sc-range-input" type="number" step="any" value="${range.yMin}"></label><label>y max<input name="yMax" class="sc-range-input" type="number" step="any" value="${range.yMax}"></label><button type="button" class="sc-apply-range">Apply range</button></div>
      <div class="sc-graph-toolbar"><button type="button" class="sc-graph-zoom-in" aria-label="Zoom in">＋</button><button type="button" class="sc-graph-zoom-out" aria-label="Zoom out">−</button><button type="button" class="sc-graph-home">Reset view</button><span>Drag to pan · use the controls to zoom</span></div>
      <div class="sc-graph-print-area"><div class="sc-graph-output" aria-label="Multiple function graph"></div></div>
      <form class="sc-form sc-graph-add-form"><label>New function of x<input name="expression" type="text" maxlength="180" placeholder="e.g. cos(x), x^2/4" autocomplete="off" spellcheck="false" required></label><button class="sc-primary-button" type="submit">＋ Add function</button></form>
      <div class="sc-graph-function-list" aria-label="Plotted functions"></div>
      <details class="sc-graph-analysis"><summary>Analyze roots, intersections &amp; extrema</summary><div class="sc-graph-analysis-grid"><label>Function<select class="sc-analysis-function"></select></label><button type="button" class="sc-find-roots">Find roots</button><button type="button" class="sc-find-extrema">Find extrema</button><label>Compare with<select class="sc-intersection-function"></select></label><button type="button" class="sc-find-intersections">Find intersections</button></div><p class="sc-field-help">These are numerical estimates from sampled sign changes or local brackets, not symbolic proofs. Tangential roots may be missed.</p><div class="sc-analysis-output" aria-live="polite"></div></details>
      <p class="sc-field-help">Curves are sampled locally. Analysis is numerical and approximate; gaps show points the safe evaluator cannot calculate.</p>
    </section>`;
  }

  unitsMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">SI &amp; SCIENTIFIC CONVERSIONS</p><h2>Unit converter</h2></div></div><form class="sc-form sc-units-form"><label>Value<input name="value" type="number" step="any" value="1" required></label><div class="sc-form-grid sc-unit-pair"><label>From<select name="from">${unitOptions('m')}</select></label><button class="sc-swap-units" type="button" aria-label="Swap units">⇄</button><label>To<select name="to">${unitOptions('km')}</select></label></div><p class="sc-field-help">Length, area, volume, mass, time, speed, acceleration, force, pressure, energy, power, frequency, current, voltage, resistance, charge, amount, concentrations and temperature. Conversions are dimension-checked.</p><button class="sc-primary-button" type="submit">Convert</button></form><div class="sc-unit-groups">${Object.entries(SCIENTIFIC_UNIT_GROUPS).map(([group, units]) => `<span><strong>${ESCAPE(group)}:</strong> ${Object.keys(units).join(' · ')}</span>`).join('')}</div></section>`;
  }

  solveMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">ALGEBRA · REAL VALUES</p><h2>Equation solver</h2></div></div><form class="sc-form sc-linear-form"><p class="sc-equation-preview">Solve <strong>ax + b = c</strong> for x</p><div class="sc-form-grid sc-three-fields"><label>a<input name="a" type="number" step="any" value="2" required></label><label>b<input name="b" type="number" step="any" value="3" required></label><label>c<input name="c" type="number" step="any" value="11" required></label></div><button class="sc-primary-button" type="submit">Solve linear equation</button></form><hr class="sc-divider"><form class="sc-form sc-quadratic-form"><p class="sc-equation-preview">Or solve <strong>ax² + bx + c = 0</strong></p><div class="sc-form-grid sc-three-fields"><label>a<input name="a" type="number" step="any" value="1" required></label><label>b<input name="b" type="number" step="any" value="-3" required></label><label>c<input name="c" type="number" step="any" value="2" required></label></div><button class="sc-secondary-button" type="submit">Solve quadratic</button></form></section>`;
  }

  integralMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">NUMERICAL CALCULUS · LOCAL</p><h2>Definite integral</h2></div></div><form class="sc-form sc-integral-form"><label>Function f(x)<input name="expression" type="text" value="x^2" maxlength="180" spellcheck="false" required></label><div class="sc-form-grid sc-three-fields"><label>From a<input name="min" type="number" step="any" value="0" required></label><label>To b<input name="max" type="number" step="any" value="3" required></label><label>Tolerance<input name="tolerance" type="number" step="any" min="0.000000000001" max="0.1" value="0.00000001" required></label></div><label>Numerical method<select name="method"><option value="adaptive-simpson">Adaptive Simpson (recommended)</option><option value="trapezoid">Composite trapezoid (convergence checked)</option></select></label><button class="sc-primary-button" type="submit">Integrate</button></form><div class="sc-integral-result" aria-live="polite"></div><p class="sc-field-help">The answer is a numerical estimate with an error estimate. Non-finite or non-convergent integrals are reported instead of presented as exact.</p></section>`;
  }

  surfaceMarkup() {
    const expression = ESCAPE(this.data.surfaceExpression || 'sin(x)*cos(y)');
    return `<section class="sc-tool-card sc-surface-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">LOCAL 3D SURFACE · z = f(x,y)</p><h2>Interactive surface plot</h2></div><button type="button" class="sc-reset-surface">Reset rotation</button></div><form class="sc-form sc-surface-form"><label>Surface expression z = f(x,y)<input name="expression" type="text" maxlength="180" value="${expression}" spellcheck="false" required></label><div class="sc-form-grid"><label>x and y range<select name="range"><option value="5">−5 to 5</option><option value="10">−10 to 10</option><option value="2">−2 to 2</option></select></label><button class="sc-primary-button" type="submit">Plot surface</button></div></form><div class="sc-surface-stage"><canvas class="sc-surface-canvas" width="900" height="560" role="img" aria-label="Interactive three-dimensional z equals f of x and y surface. Drag to rotate."></canvas><div class="sc-surface-buttons"><button type="button" data-rotate="left" aria-label="Rotate left">↶</button><button type="button" data-rotate="right" aria-label="Rotate right">↷</button><button type="button" data-rotate="up" aria-label="Rotate up">↑</button><button type="button" data-rotate="down" aria-label="Rotate down">↓</button><button type="button" data-rotate="zoom-in" aria-label="Zoom in">＋</button><button type="button" data-rotate="zoom-out" aria-label="Zoom out">−</button></div></div><p class="sc-field-help">The supported surface is explicit z = f(x,y), evaluated on a bounded local grid. Drag to rotate; invalid samples appear as gaps. No remote plotting engine is used.</p></section>`;
  }

  chemistryMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">CHEMISTRY · EXPLICIT ASSUMPTIONS</p><h2>Solution chemistry</h2></div></div>
      <form class="sc-form sc-molarity-form"><h3>Molarity from amount and final volume</h3><div class="sc-form-grid"><label>Amount<input name="amount" type="number" min="0" step="any" value="0.5" required></label><label>Amount unit<select name="amountUnit"><option>mol</option><option>mmol</option><option>umol</option></select></label><label>Final solution volume<input name="volume" type="number" min="0" step="any" value="1" required></label><label>Volume unit<select name="volumeUnit"><option>L</option><option>mL</option></select></label></div><button class="sc-primary-button" type="submit">Calculate molarity</button></form>
      <hr class="sc-divider"><form class="sc-form sc-molar-mass-form"><h3>Molar mass from a chemical formula</h3><p class="sc-field-help">Supports element symbols and nested parentheses for common formulas, e.g. Ca(OH)2, Al2(SO4)3. Atomic weights are an approximate fixed table; verify for precise laboratory work.</p><label>Formula<input name="formula" type="text" maxlength="80" value="H2O" spellcheck="false" required></label><button class="sc-secondary-button" type="submit">Calculate molar mass</button></form>
      <hr class="sc-divider"><form class="sc-form sc-mass-moles-form"><h3>Mass ↔ amount of substance</h3><div class="sc-form-grid"><label>Mass (g)<input name="mass" type="number" min="0" step="any" value="18.015" required></label><label>Molar mass (g/mol)<input name="molarMass" type="number" min="0" step="any" value="18.015" required></label></div><button class="sc-secondary-button" type="submit">Calculate amount (mol)</button></form>
      <hr class="sc-divider"><form class="sc-form sc-ph-form"><h3>Ideal concentration-based pH</h3><label>Hydrogen-ion concentration [H⁺], mol/L<input name="concentration" type="number" min="0" step="any" value="0.001" required></label><button class="sc-secondary-button" type="submit">Calculate pH</button></form>
      <hr class="sc-divider"><form class="sc-form sc-buffer-form"><h3>Henderson–Hasselbalch estimate</h3><div class="sc-form-grid"><label>pKa<input name="pka" type="number" step="any" value="4.76" required></label><label>[A⁻] concentration<input name="base" type="number" min="0" step="any" value="0.1" required></label><label>[HA] concentration<input name="acid" type="number" min="0" step="any" value="0.1" required></label></div><button class="sc-secondary-button" type="submit">Estimate buffer pH</button></form>
      <div class="sc-safety-note"><strong>Scientific limits</strong><p>These calculations do not balance reactions or model activities, equilibrium, titration curves, temperature dependence, uncertainty or non-ideal behavior. Check all assumptions and authoritative references.</p></div></section>`;
  }

  pharmacyMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">PHARMACY · USER-SUPPLIED ARITHMETIC ONLY</p><h2>Calculation helpers</h2></div></div>
      <form class="sc-form sc-dilution-form"><h3>Dilution · C₁V₁ = C₂V₂</h3><p class="sc-field-help">Starting and target concentration must share a unit. Volume uses mL. No product or route selection is provided.</p><div class="sc-form-grid sc-three-fields"><label>C₁<input name="c1" type="number" min="0" step="any" value="10" required></label><label>V₁ (mL)<input name="v1" type="number" min="0" step="any" value="2" required></label><label>C₂<input name="c2" type="number" min="0" step="any" value="2" required></label></div><label>Concentration unit<input name="unit" type="text" value="mg/mL" maxlength="20"></label><button class="sc-primary-button" type="submit">Calculate dilution volume</button></form>
      <hr class="sc-divider"><form class="sc-form sc-weight-form"><h3>Supplied mass-per-weight arithmetic</h3><p class="sc-field-help">Multiplies the rate entered by the mass entered; does not determine a suitable dose.</p><div class="sc-form-grid"><label>Rate<input name="rate" type="number" min="0" step="any" value="5" required></label><label>Rate unit<select name="rateUnit"><option>mg/kg</option><option>g/kg</option><option>ug/kg</option><option>mcg/kg</option></select></label><label>Mass<input name="weight" type="number" min="0" step="any" value="20" required></label><label>Mass unit<select name="weightUnit"><option>kg</option><option>g</option></select></label></div><button class="sc-secondary-button" type="submit">Calculate supplied arithmetic</button></form>
      <hr class="sc-divider"><form class="sc-form sc-infusion-form"><h3>Volumetric infusion arithmetic</h3><div class="sc-form-grid"><label>Volume (mL)<input name="volume" type="number" min="0" step="any" value="100" required></label><label>Time (hours)<input name="hours" type="number" min="0" step="any" value="2" required></label></div><button class="sc-secondary-button" type="submit">Calculate mL/h</button></form>
      <hr class="sc-divider"><form class="sc-form sc-drop-form"><h3>Gravity-flow arithmetic</h3><p class="sc-field-help">Computes drops/min from user-entered volume, time and drop factor. Not a recommended setting.</p><div class="sc-form-grid"><label>Volume (mL)<input name="volume" type="number" min="0" step="any" value="100" required></label><label>Time (minutes)<input name="minutes" type="number" min="0" step="any" value="60" required></label><label>Drop factor (gtt/mL)<input name="factor" type="number" min="0" step="any" value="20" required></label></div><button class="sc-secondary-button" type="submit">Calculate arithmetic gtt/min</button></form>
      <hr class="sc-divider"><form class="sc-form sc-mass-rate-form"><h3>Concentration × volumetric rate</h3><p class="sc-field-help">Unit-consistent arithmetic for the values entered, not a patient-specific instruction.</p><div class="sc-form-grid"><label>Concentration (mg/mL)<input name="concentration" type="number" min="0" step="any" value="1" required></label><label>Volumetric rate (mL/h)<input name="rate" type="number" min="0" step="any" value="2" required></label></div><button class="sc-secondary-button" type="submit">Calculate mg/h arithmetic</button></form>
      <div class="sc-safety-note sc-pharmacy-disclosure"><strong>Safety — arithmetic only, not clinical guidance</strong><p>No drug lookup, indication check, patient-specific recommendation, interaction analysis, route/frequency advice or administration instruction is provided. Never use this calculator alone to select, prescribe, prepare or administer a medicine. Independently verify inputs and results with an authorized clinician or pharmacist and official product information.</p></div></section>`;
  }

  allToolsMarkup() {
    return `<section class="sc-tool-card"><div class="sc-tool-title"><div><p class="sc-eyebrow">ALL OFFLINE TOOLS</p><h2>Choose a science workspace</h2></div></div><div class="sc-tool-launch-grid">${TOOL_ITEMS.map(([mode, title, description]) => `<button type="button" class="sc-tool-launch" data-open-mode="${mode}"><span>${ESCAPE(title)}</span><small>${ESCAPE(description)}</small><b aria-hidden="true">↗</b></button>`).join('')}<button type="button" class="sc-tool-launch" data-open-panel="formulas"><span>Formula library</span><small>Built-in references and your own locally saved formulas.</small><b aria-hidden="true">↗</b></button><button type="button" class="sc-tool-launch" data-open-panel="notebooks"><span>Notes &amp; notebooks</span><small>Keep personal working, assumptions and calculation records.</small><b aria-hidden="true">↗</b></button></div><p class="sc-local-note">Every tool uses the local evaluator; this page has no calculator network dependency.</p></section>`;
  }

  bindModeEvents() {
    const expression = this.container.querySelector('.sc-expression');
    expression.value = this.expression;
    this.container.querySelectorAll('[data-open-panel]').forEach((button) => button.addEventListener('click', () => this.setSidePanel(button.dataset.openPanel)));
    this.container.querySelector('.sc-units-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      try { const value = convertUnit(form.elements.value.value, form.elements.from.value, form.elements.to.value); this.showOutput({ value, unit: form.elements.to.value, expression: `${form.elements.value.value} ${form.elements.from.value} → ${form.elements.to.value}`, steps: [`${formatNumber(Number(form.elements.value.value))} ${unitLabel(form.elements.from.value)} = ${formatNumber(value)} ${unitLabel(form.elements.to.value)}`] }, 'units'); }
      catch (error) { this.showCalculationError(error); }
    });
    this.container.querySelector('.sc-swap-units')?.addEventListener('click', () => { const form = this.container.querySelector('.sc-units-form'); const from = form.elements.from.value; form.elements.from.value = form.elements.to.value; form.elements.to.value = from; });
    this.container.querySelector('.sc-linear-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = solveLinearEquation({ a: f.elements.a.value, b: f.elements.b.value, c: f.elements.c.value }); this.showOutput({ ...result, expression: `${f.elements.a.value}x + ${f.elements.b.value} = ${f.elements.c.value}` }, 'solve'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-quadratic-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = solveQuadratic({ a: f.elements.a.value, b: f.elements.b.value, c: f.elements.c.value }); const value = result.roots.length ? result.roots[0] : null; this.showOutput({ value, formatted: result.roots.length ? result.roots.map((root) => formatNumber(root)).join(', ') : 'No real roots', steps: result.steps, expression: `${f.elements.a.value}x² + ${f.elements.b.value}x + ${f.elements.c.value} = 0` }, 'solve'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-integral-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; const out = this.container.querySelector('.sc-integral-result'); out.textContent = 'Checking convergence locally…'; try { const result = integrateFunction(f.elements.expression.value, { min: f.elements.min.value, max: f.elements.max.value, tolerance: f.elements.tolerance.value, method: f.elements.method.value, angleMode: this.data.settings.angleMode, variables: this.variableValues() }); this.showOutput({ ...result, unit: 'area units', expression: `∫[${f.elements.min.value}, ${f.elements.max.value}] ${f.elements.expression.value} dx`, disclosure: `Numerical estimate using ${result.method}; estimated error ${formatNumber(result.errorEstimate)}.` }, 'integrals'); out.textContent = `Converged in ${result.evaluations} evaluations. Estimated error ≤ ${formatNumber(result.errorEstimate)}.`; } catch (error) { out.textContent = error.message; this.showCalculationError(error); } });
    this.container.querySelector('.sc-surface-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; this.data.surfaceExpression = f.elements.expression.value.trim(); this.surfaceRange = Number(f.elements.range.value) || 5; this.persist(); this.drawSurface(); });
    this.container.querySelector('.sc-reset-surface')?.addEventListener('click', () => { this.surfaceRotation = { yaw: -0.62, pitch: 0.58, zoom: 1 }; this.drawSurface(); });
    this.container.querySelectorAll('[data-rotate]').forEach((button) => button.addEventListener('click', () => { const action = button.dataset.rotate; if (action === 'left') this.surfaceRotation.yaw -= 0.15; else if (action === 'right') this.surfaceRotation.yaw += 0.15; else if (action === 'up') this.surfaceRotation.pitch = Math.min(1.35, this.surfaceRotation.pitch + 0.12); else if (action === 'down') this.surfaceRotation.pitch = Math.max(-1.2, this.surfaceRotation.pitch - 0.12); else if (action === 'zoom-in') this.surfaceRotation.zoom = Math.min(2.5, this.surfaceRotation.zoom * 1.12); else if (action === 'zoom-out') this.surfaceRotation.zoom = Math.max(.55, this.surfaceRotation.zoom / 1.12); this.drawSurface(); }));
    this.container.querySelector('.sc-graph-add-form')?.addEventListener('submit', (event) => { event.preventDefault(); const expressionValue = event.currentTarget.elements.expression.value.trim(); if (!expressionValue) return; if (this.data.graphFunctions.length >= 6) { this.showNotice('A plot can contain up to six independently configured functions.', 'error'); return; } const colors = ['#2563eb', '#dc2626', '#059669', '#9333ea', '#ea580c', '#0891b2']; this.data.graphFunctions.push({ id: idFor('graph'), expression: expressionValue, color: colors[this.data.graphFunctions.length % colors.length], visible: true }); this.persist(); this.renderMode(); });
    this.container.querySelectorAll('.sc-range-input').forEach((input) => input.addEventListener('change', () => this.updateGraphRange(false)));
    this.container.querySelector('.sc-apply-range')?.addEventListener('click', () => this.updateGraphRange(true));
    this.container.querySelector('.sc-graph-zoom-in')?.addEventListener('click', () => this.zoomGraph(.72));
    this.container.querySelector('.sc-graph-zoom-out')?.addEventListener('click', () => this.zoomGraph(1.38));
    this.container.querySelector('.sc-graph-home')?.addEventListener('click', () => { this.data.graphRange = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 }; this.persist(); this.renderMode(); });
    this.container.querySelector('.sc-export-graph')?.addEventListener('click', () => this.exportGraph());
    this.container.querySelector('.sc-print-graph')?.addEventListener('click', () => this.printGraph());
    this.container.querySelector('.sc-graph-function-list')?.addEventListener('click', (event) => { const button = event.target.closest('[data-graph-action]'); if (!button) return; const entry = this.data.graphFunctions.find((item) => item.id === button.dataset.id); if (!entry) return; if (button.dataset.graphAction === 'remove') this.data.graphFunctions = this.data.graphFunctions.filter((item) => item.id !== entry.id); else if (button.dataset.graphAction === 'toggle') entry.visible = !entry.visible; else if (button.dataset.graphAction === 'edit') { const input = [...this.container.querySelectorAll('[data-graph-input]')].find((field) => field.dataset.graphInput === entry.id); if (input) entry.expression = input.value.trim(); } this.persist(); this.renderMode(); });
    this.container.querySelectorAll('[data-graph-input]').forEach((input) => input.addEventListener('change', () => { const entry = this.data.graphFunctions.find((item) => item.id === input.dataset.graphInput); if (entry && input.value.trim()) { entry.expression = input.value.trim(); this.persist(); this.drawGraph(); } }));
    this.container.querySelector('.sc-find-roots')?.addEventListener('click', () => this.analyzeGraph('roots'));
    this.container.querySelector('.sc-find-extrema')?.addEventListener('click', () => this.analyzeGraph('extrema'));
    this.container.querySelector('.sc-find-intersections')?.addEventListener('click', () => this.analyzeGraph('intersections'));
    this.container.querySelector('.sc-graph-output')?.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; this.pointerDrag = { x: event.clientX, y: event.clientY, range: { ...this.data.graphRange } }; event.currentTarget.setPointerCapture?.(event.pointerId); });
    this.container.querySelector('.sc-graph-output')?.addEventListener('pointermove', (event) => { if (!this.pointerDrag) return; const svg = event.currentTarget.querySelector('svg'); if (!svg) return; const rect = svg.getBoundingClientRect(); const dx = (event.clientX - this.pointerDrag.x) / rect.width * (this.pointerDrag.range.xMax - this.pointerDrag.range.xMin); const dy = (event.clientY - this.pointerDrag.y) / rect.height * (this.pointerDrag.range.yMax - this.pointerDrag.range.yMin); this.data.graphRange = { xMin: this.pointerDrag.range.xMin - dx, xMax: this.pointerDrag.range.xMax - dx, yMin: this.pointerDrag.range.yMin + dy, yMax: this.pointerDrag.range.yMax + dy }; this.renderGraphPlot(); });
    this.container.querySelector('.sc-graph-output')?.addEventListener('pointerup', () => { if (this.pointerDrag) { this.pointerDrag = null; this.persist(); this.renderGraphControls(); } });
    this.container.querySelector('.sc-graph-output')?.addEventListener('pointercancel', () => { this.pointerDrag = null; });
    this.container.querySelector('.sc-graph-output')?.addEventListener('wheel', (event) => { event.preventDefault(); this.zoomGraph(event.deltaY < 0 ? .88 : 1.14); }, { passive: false });
    this.container.querySelector('.sc-molarity-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = computeMolarity({ amount: f.elements.amount.value, amountUnit: f.elements.amountUnit.value, volume: f.elements.volume.value, volumeUnit: f.elements.volumeUnit.value }); this.showOutput({ ...result, expression: `${f.elements.amount.value} ${f.elements.amountUnit.value} / ${f.elements.volume.value} ${f.elements.volumeUnit.value}` }, 'chemistry'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-molar-mass-form')?.addEventListener('submit', (event) => { event.preventDefault(); const formula = event.currentTarget.elements.formula.value.trim(); try { const result = calculateMolarMass(formula); this.showOutput({ ...result, expression: `M(${formula})`, unit: 'g/mol' }, 'chemistry'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-mass-moles-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const mass = Number(f.elements.mass.value); const molarMass = Number(f.elements.molarMass.value); if (!Number.isFinite(mass) || mass < 0 || !Number.isFinite(molarMass) || molarMass <= 0) throw new Error('Enter a non-negative mass and positive molar mass.'); const amount = mass / molarMass; this.showOutput({ value: amount, unit: 'mol', expression: `${mass} g / ${molarMass} g/mol`, steps: [`n = m / M`, `n = ${formatNumber(mass)} / ${formatNumber(molarMass)} = ${formatNumber(amount)} mol`] }, 'chemistry'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-ph-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = computePH({ concentration: f.elements.concentration.value }); this.showOutput({ ...result, expression: 'pH = −log₁₀([H⁺])' }, 'chemistry'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-buffer-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const pka = Number(f.elements.pka.value); const base = Number(f.elements.base.value); const acid = Number(f.elements.acid.value); if (![pka, base, acid].every(Number.isFinite) || base <= 0 || acid <= 0) throw new Error('Enter finite pKa and positive conjugate-base and acid concentrations.'); const value = pka + Math.log10(base / acid); this.showOutput({ value, unit: 'pH estimate', expression: `pH = pKa + log10([A−]/[HA])`, steps: [`pH = ${formatNumber(pka)} + log10(${formatNumber(base)}/${formatNumber(acid)})`, `Estimated pH = ${formatNumber(value)}`], disclosure: 'Henderson–Hasselbalch approximation; assumes a suitable buffer and activity/concentration simplifications.' }, 'chemistry'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-dilution-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = computeDilution({ c1: f.elements.c1.value, v1: f.elements.v1.value, c2: f.elements.c2.value, unit: 'mL' }); result.disclosure = 'Arithmetic only — not clinical guidance. Verify concentration units, preparation instructions and calculations with an authorized professional.'; this.showOutput({ ...result, unit: 'mL', expression: `C₁=${f.elements.c1.value} ${f.elements.unit.value} · V₁=${f.elements.v1.value} mL · C₂=${f.elements.c2.value} ${f.elements.unit.value}` }, 'pharmacy'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-weight-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = computeWeightBasedAmount({ rate: f.elements.rate.value, rateUnit: f.elements.rateUnit.value, weight: f.elements.weight.value, weightUnit: f.elements.weightUnit.value }); result.disclosure = 'Arithmetic only — not a clinical dose recommendation. Independently verify all supplied inputs and consult an authorized clinician/pharmacist.'; this.showOutput({ ...result, expression: `${f.elements.rate.value} ${f.elements.rateUnit.value} × ${f.elements.weight.value} ${f.elements.weightUnit.value}` }, 'pharmacy'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-infusion-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const result = computeInfusionRate({ volume: f.elements.volume.value, hours: f.elements.hours.value }); result.disclosure = 'Volumetric arithmetic only — not a medication dose or recommended infusion rate. Verify independently.'; this.showOutput({ ...result, expression: `${f.elements.volume.value} mL / ${f.elements.hours.value} h` }, 'pharmacy'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-drop-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const values = [f.elements.volume.value, f.elements.minutes.value, f.elements.factor.value].map(Number); if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Enter positive volume, time and drop factor values.'); const rate = values[0] * values[2] / values[1]; this.showOutput({ value: rate, unit: 'gtt/min', expression: `${values[0]} mL × ${values[2]} gtt/mL ÷ ${values[1]} min`, steps: [`drops/min = volume × drop factor ÷ time`, `= ${formatNumber(rate)} gtt/min`], disclosure: 'Arithmetic only; no drop factor or administration rate is recommended.' }, 'pharmacy'); } catch (error) { this.showCalculationError(error); } });
    this.container.querySelector('.sc-mass-rate-form')?.addEventListener('submit', (event) => { event.preventDefault(); const f = event.currentTarget; try { const concentration = Number(f.elements.concentration.value); const rate = Number(f.elements.rate.value); if (!Number.isFinite(concentration) || concentration < 0 || !Number.isFinite(rate) || rate < 0) throw new Error('Enter finite non-negative concentration and volumetric-rate values.'); this.showOutput({ value: concentration * rate, unit: 'mg/h', expression: `${concentration} mg/mL × ${rate} mL/h`, steps: [`mass rate = concentration × volumetric rate`, `= ${formatNumber(concentration * rate)} mg/h`], disclosure: 'Arithmetic from values supplied by the user; not a recommended medication dose or infusion rate.' }, 'pharmacy'); } catch (error) { this.showCalculationError(error); } });
  }

  handleKey(key, action, input, button) {
    if (!this.displayOn && action !== 'on') return;
    if (action === 'shift') { this.shiftActive = !this.shiftActive; this.alphaActive = false; this.updateKeyLayers(); return; }
    if (action === 'alpha') { this.alphaActive = !this.alphaActive; this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'hyp') { this.hyperbolicActive = !this.hyperbolicActive; this.showNotice(`Hyperbolic functions ${this.hyperbolicActive ? 'enabled' : 'disabled'}.`); return; }
    if (action === 'mode') { if (this.shiftActive) this.openSetupDialog(); else this.openModeDialog(); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'on') { this.displayOn = true; this.container.querySelector('.sc-display')?.classList.remove('sc-display-off'); this.expression = ''; input.value = ''; this.calculationOutput = null; this.lastEntryId = null; this.lastResult = null; this.updateAnswer(null); this.showNotice('Display cleared. Ans keeps the last calculated value.'); this.shiftActive = false; this.alphaActive = false; this.updateKeyLayers(); input.focus(); return; }
    if (action === 'drg') { this.cycleAngleMode(); return; }
    if (action === 'integral') { this.setMode('integrals'); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'fraction') { this.openFractionDialog(input); return; }
    if (action === 'insert' && this.shiftActive && button?.dataset.shift === 'constants') { this.openConstantsDialog(input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'insert' && this.shiftActive && button?.dataset.shift === 'clear') { this.openClearDialog(input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'insert' && this.shiftActive && ['+', '−'].includes(key)) { this.openCoordinateDialog(key === '+' ? 'polar' : 'rectangular', input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'delete') {
      if (this.shiftActive && button?.dataset.shift === 'insert-mode') {
        this.insertMode = !this.insertMode; this.showNotice(`${this.insertMode ? 'Insert' : 'Overwrite'} mode.`);
      } else this.deleteAtCursor(input);
      this.shiftActive = false; this.updateKeyLayers(); return;
    }
    if (action === 'evaluate') { if (this.shiftActive && button?.dataset.shift === 'SOLVE =') this.setCalculationMode('EQN'); else this.evaluateCurrent(); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'clear') {
      if (this.shiftActive && button?.dataset.shift === 'off') {
        this.displayOn = false; this.container.querySelector('.sc-display')?.classList.add('sc-display-off');
      } else { this.expression = ''; input.value = ''; this.calculationOutput = null; this.lastEntryId = null; this.lastResult = null; this.updateAnswer(null); this.showNotice('Expression and display cleared. Ans keeps the last calculated value.'); }
      this.shiftActive = false; this.updateKeyLayers(); return;
    }
    if (action === 'negative') { this.insertAtCursor('(-', input); return; }
    if (action === 'answer') {
      if (this.shiftActive || this.alphaActive) {
        const token = this.alphaActive ? 'randint(,)' : 'rand()';
        this.insertAtCursor(token, input, this.alphaActive ? 9 : token.length - 1);
        this.shiftActive = false; this.alphaActive = false; this.updateKeyLayers(); return;
      }
      if (this.lastAnswer === null) { this.showNotice('Calculate a result before using Ans.', 'error'); return; }
      if (!input.value.trim()) {
        const formatted = formatNumber(this.lastAnswer, { precision: this.data.settings.precision, notation: this.data.settings.notation, fixedDigits: this.data.settings.fixedDigits });
        this.expression = formatted; input.value = formatted; input.focus();
        this.lastResult = this.lastAnswer;
        this.calculationOutput = { value: this.lastAnswer, formatted, expression: 'Ans', unit: '', steps: [], mode: 'calculator', angleMode: this.data.settings.angleMode };
        this.updateAnswer(this.calculationOutput);
        return;
      }
      this.insertAtCursor('ans', input); return;
    }
    if (action === 'memory-recall') { this.handleMemory(this.shiftActive ? 'store' : 'recall', input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'memory-add') { this.handleMemory(this.shiftActive ? 'subtract' : 'add', input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'fraction-display') { this.toggleFractionDisplay(); return; }
    if (action === 'eng') {
      this.data.settings.notation = this.shiftActive ? 'scientific' : 'engineering';
      this.persist(); this.updateDeviceStatus(); this.refreshFormattedAnswer();
      this.showNotice(`Display format: ${this.data.settings.notation.toUpperCase()}.`); this.shiftActive = false; this.updateKeyLayers(); return;
    }
    if (action === 'logbase') { this.insertAtCursor(this.shiftActive ? 'log()' : 'log(,)', input, 4); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'dms') { if (this.shiftActive) this.cycleAngleMode(); else this.insertAtCursor('dms(,,)', input, 4); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'square') { this.insertAtCursor(this.shiftActive ? 'sqrt()' : '^2', input, this.shiftActive ? 5 : 2); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'power') {
      const shifted = button?.dataset.shift;
      this.insertAtCursor(this.shiftActive ? (shifted === '!' ? '!' : shifted || '!') : '^', input, this.shiftActive ? (shifted?.length || 1) : 1);
      this.shiftActive = false; this.updateKeyLayers(); return;
    }
    if (action === 'sqrt') { this.insertAtCursor(this.shiftActive ? 'cbrt()' : 'sqrt()', input, 5); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'log') { this.insertAtCursor(this.shiftActive ? '10^(' : 'log()', input, this.shiftActive ? 4 : 4); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'ln') { this.insertAtCursor(this.shiftActive ? 'exp()' : 'ln()', input, this.shiftActive ? 4 : 3); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (action === 'trig') {
      let name = this.alphaActive ? (key === 'sin' ? 'sec' : key === 'cos' ? 'csc' : 'cot') : this.shiftActive ? (key === 'sin' ? 'asin' : key === 'cos' ? 'acos' : 'atan') : key;
      if (this.hyperbolicActive) name = this.shiftActive ? (key === 'sin' ? 'asinh' : key === 'cos' ? 'acosh' : 'atanh') : (key === 'sin' ? 'sinh' : key === 'cos' ? 'cosh' : 'tanh');
      this.insertAtCursor(`${name}()`, input, name.length + 1); this.shiftActive = false; this.alphaActive = false; this.updateKeyLayers(); return;
    }
    const shifted = button?.dataset.shift;
    const alpha = button?.dataset.alpha;
    if (this.shiftActive && shifted === 'clear') { this.openClearDialog(input); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (this.shiftActive && shifted === 'units') { this.setMode('units'); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (this.shiftActive && shifted === 'STAT') { this.setCalculationMode('STAT'); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (this.shiftActive && shifted === 'MED') { this.insertAtCursor('median()', input, 7); this.shiftActive = false; this.updateKeyLayers(); return; }
    if (this.shiftActive && shifted === 'σ') { this.insertAtCursor('stdev()', input, 6); this.shiftActive = false; this.updateKeyLayers(); return; }
    let insertion = key;
    if (this.alphaActive && alpha) insertion = alpha;
    else if (this.shiftActive && shifted) insertion = shifted === 'FACT' ? '!' : shifted;
    const useOverwrite = !this.insertMode;
    const openParen = String(insertion).indexOf('(');
    const cursorOffset = this.shiftActive && openParen >= 0 ? openParen + 1 : String(insertion).length;
    this.insertAtCursor(insertion, input, cursorOffset, useOverwrite);
    if (this.shiftActive || this.alphaActive) { this.shiftActive = false; this.alphaActive = false; this.updateKeyLayers(); }
  }

  moveNavigation(direction, input) {
    if (direction === 'center') { this.evaluateCurrent(); return; }
    if (direction === 'left' || direction === 'right') {
      const position = input.selectionStart ?? input.value.length;
      const next = Math.max(0, Math.min(input.value.length, position + (direction === 'left' ? -1 : 1)));
      input.focus(); input.setSelectionRange?.(next, next); return;
    }
    const entries = this.data.history;
    if (!entries.length) { this.showNotice('No calculation history to browse.'); return; }
    if (this.historyCursor < 0) { this.historyDraft = input.value; this.historyCursor = 0; }
    else if (direction === 'up') this.historyCursor = Math.min(entries.length - 1, this.historyCursor + 1);
    else if (direction === 'down') this.historyCursor -= 1;
    if (this.historyCursor < 0) { input.value = this.historyDraft; this.expression = input.value; }
    else { input.value = entries[this.historyCursor].expression; this.expression = input.value; }
    input.focus(); input.setSelectionRange?.(input.value.length, input.value.length);
  }

  openFractionDialog(input) {
    const host = this.container.querySelector('.sc-dialog-host');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    host.innerHTML = `<div class="sc-mode-scrim sc-fraction-scrim"><form class="sc-fraction-dialog" role="dialog" aria-modal="true" aria-labelledby="${this.instanceId}-fraction-title"><div class="sc-dialog-header"><h2 id="${this.instanceId}-fraction-title">Enter a fraction</h2><button type="button" class="sc-dialog-close" data-fraction-cancel aria-label="Cancel">×</button></div><p>Enter the numerator above the fraction bar and the denominator below.</p><div class="sc-fraction-template"><input name="numerator" aria-label="Numerator" inputmode="decimal" autocomplete="off" required><span class="sc-fraction-rule" aria-hidden="true"></span><input name="denominator" aria-label="Denominator" inputmode="decimal" autocomplete="off" required></div><div class="sc-fraction-dialog-actions"><button type="button" class="sc-secondary-button" data-fraction-cancel>Cancel</button><button type="submit" class="sc-primary-button">Insert fraction</button></div></form></div>`;
    const form = host.querySelector('.sc-fraction-dialog');
    const close = () => {
      host.removeEventListener('keydown', onDialogKeydown);
      host.replaceChildren();
      input.focus();
    };
    const onDialogKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation?.();
      close();
    };
    host.addEventListener('keydown', onDialogKeydown);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const numeratorInput = form.querySelector('[name="numerator"]'); const denominatorInput = form.querySelector('[name="denominator"]');
      const numerator = numeratorInput.value.trim(); const denominator = denominatorInput.value.trim();
      if (!numerator || !denominator) return;
      const token = `((${numerator})/(${denominator}))`;
      this.expression = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
      input.value = this.expression; close();
      const cursor = start + token.length; input.setSelectionRange?.(cursor, cursor);
      input.blur?.();
      this.showNotice('Stacked fraction inserted into the expression.');
    });
    host.querySelectorAll('[data-fraction-cancel]').forEach((button) => button.addEventListener('click', close));
    form.querySelector('[name="numerator"]')?.focus();
  }

  updateKeyLayers() {
    this.container.querySelector('.sc-key-shift')?.classList.toggle('is-active', this.shiftActive);
    this.container.querySelector('.sc-key-alpha')?.classList.toggle('is-active', this.alphaActive);
    this.container.querySelector('.sc-key-hyp')?.classList.toggle('is-active', this.hyperbolicActive);
    this.container.querySelectorAll('.sc-key').forEach((button) => {
      const primary = button.querySelector('strong');
      if (!primary) return;
      button.classList.toggle('sc-key-layer-active', this.shiftActive && button.dataset.shift || this.alphaActive && button.dataset.alpha);
    });
  }

  insertAtCursor(text, input, offset = String(text).length, overwrite = false) {
    const start = input.selectionStart ?? input.value.length;
    const selectedEnd = input.selectionEnd ?? start;
    const end = overwrite && start === selectedEnd ? Math.min(input.value.length, start + String(text).length) : selectedEnd;
    this.expression = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    input.value = this.expression;
    const cursor = start + Math.min(String(text).length, Math.max(0, offset));
    input.setSelectionRange?.(cursor, cursor); input.focus();
  }

  deleteAtCursor(input) {
    const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start;
    const from = start === end ? Math.max(0, start - 1) : start;
    this.expression = `${input.value.slice(0, from)}${input.value.slice(end)}`; input.value = this.expression; input.setSelectionRange?.(from, from); input.focus();
  }

  cycleAngleMode() {
    const modes = ['DEG', 'RAD', 'GRAD']; const current = modes.indexOf(this.data.settings.angleMode); this.data.settings.angleMode = modes[(current + 1) % modes.length];
    this.persist(); this.updateDeviceStatus(); this.showNotice(`Angle mode: ${angleModeLabel(this.data.settings.angleMode)}.`);
  }

  cycleNotation() {
    const modes = ['auto', 'scientific', 'engineering']; const current = modes.indexOf(this.data.settings.notation); this.data.settings.notation = modes[(current + 1) % modes.length];
    this.persist(); this.updateDeviceStatus(); this.refreshFormattedAnswer(); this.showNotice(`Display format: ${this.data.settings.notation.toUpperCase()}.`);
  }

  toggleFractionDisplay() {
    this.fractionDisplay = !this.fractionDisplay;
    this.data.settings.fractionDisplay = this.fractionDisplay;
    this.persist();
    this.container.querySelector('.sc-frac-key')?.setAttribute('aria-pressed', String(this.fractionDisplay));
    this.container.querySelector('.sc-frac-key')?.classList.toggle('is-active', this.fractionDisplay);
    if (this.calculationOutput) this.updateAnswer(this.calculationOutput);
    this.showNotice(this.fractionDisplay ? 'Fraction display enabled. Irrational values use an approximate rational.' : 'Decimal display enabled.');
  }

  refreshFormattedAnswer() {
    if (!this.calculationOutput) return;
    if (Number.isFinite(this.calculationOutput.value)) {
      this.calculationOutput = {...this.calculationOutput, formatted:formatNumber(this.calculationOutput.value, {precision:this.data.settings.precision, notation:this.data.settings.notation, fixedDigits:this.data.settings.fixedDigits})};
    }
    this.updateAnswer(this.calculationOutput);
  }

  updateDeviceStatus() {
    const angle = this.data.settings.angleMode;
    const angleKey = this.container.querySelector('.sc-drg-key'); if (angleKey) angleKey.textContent = angle;
    const angleReadout = this.container.querySelector('.sc-display-angle'); if (angleReadout) angleReadout.textContent = angle;
    const angleSelect = this.container.querySelector('.sc-angle-mode'); if (angleSelect) angleSelect.value = angle;
    const notationSelect = this.container.querySelector('.sc-notation-mode'); if (notationSelect) notationSelect.value = this.data.settings.notation;
    const format = ({auto:'NORM1', norm1:'NORM1', norm2:'NORM2', fixed:`FIX${this.data.settings.fixedDigits}`, scientific:'SCI', engineering:'ENG'})[this.data.settings.notation] || 'NORM1';
    const norm = this.container.querySelector('.sc-norm-key'); if (norm) norm.textContent = format;
    const formatReadout = this.container.querySelector('.sc-display-format'); if (formatReadout) formatReadout.textContent = format;
    const calcMode = this.container.querySelector('.sc-display-mode'); if (calcMode) calcMode.textContent = this.calculationMode || 'COMP';
    const memory = this.container.querySelector('.sc-display-memory'); if (memory) memory.textContent = this.data.memory === null ? '' : 'M';
  }

  openDialog(content, titleId, onOpen = () => {}) {
    const host = this.container.querySelector('.sc-dialog-host');
    const returnFocus = host.ownerDocument?.activeElement || this.container.querySelector('.sc-key-mode');
    host.innerHTML = `<div class="sc-mode-scrim"><section class="sc-mode-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}">${content}</section></div>`;
    const close = () => {
      host.removeEventListener('keydown', onDialogKeydown);
      host.replaceChildren();
      if (returnFocus?.isConnected !== false) returnFocus?.focus?.();
    };
    const onDialogKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation?.();
      close();
    };
    host.addEventListener('keydown', onDialogKeydown);
    host.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', close));
    host.querySelector('.sc-mode-scrim')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) close(); });
    onOpen(host, close);
    host.querySelector('button, input, select')?.focus();
    return { host, close };
  }

  openSetupDialog() {
    const id = `${this.instanceId}-setup-title`;
    const choices = [['FIX','Fix'], ['scientific','Sci'], ['norm1','Norm 1'], ['norm2','Norm 2']];
    const currentFormat = this.data.settings.notation === 'auto' ? 'norm1' : this.data.settings.notation;
    const content = `<div class="sc-dialog-header"><h2 id="${id}">Setup</h2><button type="button" class="sc-dialog-close" data-dialog-close aria-label="Close">×</button></div><h3>Angle</h3><div class="sc-mode-angle">${[['DEG','Deg'],['RAD','Rad'],['GRAD','Gra']].map(([value,label]) => `<button type="button" data-setup-angle="${value}" aria-pressed="${this.data.settings.angleMode === value}">${label}</button>`).join('')}</div><h3>Display</h3><div class="sc-mode-angle">${choices.map(([value,label]) => `<button type="button" data-setup-format="${value}" aria-pressed="${currentFormat === value}">${label}</button>`).join('')}</div><label class="sc-setup-fix">Fix decimal places<select data-fixed-digits>${Array.from({length:10},(_,n)=>`<option value="${n}" ${n===this.data.settings.fixedDigits?'selected':''}>${n}</option>`).join('')}</select></label><p>Norm 1 uses scientific notation below 0.01; Norm 2 uses it below 10⁻⁹. Large values switch to scientific notation.</p>`;
    const {host} = this.openDialog(content, id);
    host.querySelectorAll('[data-setup-angle]').forEach((button) => button.addEventListener('click', () => { this.data.settings.angleMode = button.dataset.setupAngle; this.persist(); this.updateDeviceStatus(); host.querySelectorAll('[data-setup-angle]').forEach((node) => node.setAttribute('aria-pressed', String(node === button))); }));
    host.querySelectorAll('[data-setup-format]').forEach((button) => button.addEventListener('click', () => {
      const format = button.dataset.setupFormat; this.data.settings.notation = format === 'FIX' ? 'fixed' : format; this.persist(); this.updateDeviceStatus(); this.refreshFormattedAnswer();
      host.querySelectorAll('[data-setup-format]').forEach((node) => node.setAttribute('aria-pressed', String(node === button)));
      host.querySelector('.sc-setup-fix')?.classList.toggle('is-visible', format === 'FIX');
    }));
    host.querySelector('.sc-setup-fix')?.classList.toggle('is-visible', this.data.settings.notation === 'fixed');
    host.querySelector('[data-fixed-digits]')?.addEventListener('change', (event) => { this.data.settings.fixedDigits = Number(event.target.value); this.persist(); this.updateDeviceStatus(); this.refreshFormattedAnswer(); });
  }

  openClearDialog(input) {
    const id = `${this.instanceId}-clear-title`;
    const content = `<div class="sc-dialog-header"><h2 id="${id}">Clear</h2><button type="button" class="sc-dialog-close" data-dialog-close aria-label="Close">×</button></div><p>Choose what to reset. Calculation history, saved results, formulas and notes are kept.</p><button type="button" data-clear-choice="setup"><strong>1 · Setup</strong><small>Restore angle and display-format settings.</small></button><button type="button" data-clear-choice="memory"><strong>2 · Memory</strong><small>Clear calculator memory and user variables.</small></button><button type="button" data-clear-choice="all"><strong>3 · All</strong><small>Reset setup, memory and calculation mode.</small></button>`;
    const {host, close} = this.openDialog(content, id);
    host.querySelectorAll('[data-clear-choice]').forEach((button) => button.addEventListener('click', () => {
      const choice = button.dataset.clearChoice;
      if (choice === 'setup' || choice === 'all') {
        const defaults = defaultScientificCalculatorData().settings;
        this.data.settings = choice === 'all'
          ? {...defaults, historyLimit:this.data.settings.historyLimit}
          : {...this.data.settings, angleMode:defaults.angleMode, precision:defaults.precision, notation:defaults.notation, fixedDigits:defaults.fixedDigits, fractionDisplay:defaults.fractionDisplay};
        this.fractionDisplay = Boolean(this.data.settings.fractionDisplay);
      }
      if (choice === 'memory' || choice === 'all') { this.data.memory = null; this.data.variables = {}; if (choice === 'all') this.setCalculationMode('COMP'); }
      this.persist(); this.updateDeviceStatus(); this.container.querySelector('.sc-frac-key')?.setAttribute('aria-pressed', String(this.fractionDisplay)); this.container.querySelector('.sc-frac-key')?.classList.toggle('is-active', this.fractionDisplay); this.renderSidePanel(); close();
      this.refreshFormattedAnswer();
      this.showNotice(choice === 'setup' ? 'Setup reset.' : choice === 'memory' ? 'Calculator memory and variables cleared.' : 'Setup and memory reset. Your saved work and history were kept.');
      input.focus();
    }));
  }

  openConstantsDialog(input) {
    const id = `${this.instanceId}-constants-title`;
    const content = `<div class="sc-dialog-header"><h2 id="${id}">Scientific constants</h2><button type="button" class="sc-dialog-close" data-dialog-close aria-label="Close">×</button></div><p>Tap a value to insert it into the current expression. Values are local reference constants.</p><label class="sc-constant-search">Search constants<input type="search" placeholder="Name, symbol or unit" aria-label="Search scientific constants"></label><div class="sc-constant-list" role="list">${SCIENTIFIC_CONSTANTS.map(({name,label,value,unit})=>`<button type="button" class="sc-constant-item" data-constant="${ESCAPE(value)}" data-search="${ESCAPE(`${name} ${label} ${unit}`.toLowerCase())}"><span><strong>${ESCAPE(label)}</strong><small>${ESCAPE(name)}${unit ? ` · ${ESCAPE(unit)}` : ''}</small></span><code>${ESCAPE(value)}</code></button>`).join('')}</div>`;
    const {host, close} = this.openDialog(content, id);
    const search = host.querySelector('.sc-constant-search input');
    search.addEventListener('input', () => host.querySelectorAll('.sc-constant-item').forEach((row) => { row.hidden = !row.dataset.search.includes(search.value.toLowerCase()); }));
    host.querySelectorAll('.sc-constant-item').forEach((button) => button.addEventListener('click', () => { this.insertAtCursor(button.dataset.constant, input); close(); this.showNotice(`Inserted ${button.querySelector('strong').textContent}.`); }));
  }

  openCoordinateDialog(kind, input) {
    const id = `${this.instanceId}-coordinate-title`; const polar = kind === 'polar';
    const content = `<div class="sc-dialog-header"><h2 id="${id}">${polar ? 'Rectangular → polar' : 'Polar → rectangular'}</h2><button type="button" class="sc-dialog-close" data-dialog-close aria-label="Close">×</button></div><p>${polar ? 'Convert x and y to radius r and angle θ.' : 'Convert radius r and angle θ to x and y.'} Angle uses ${angleModeLabel(this.data.settings.angleMode)}.</p><form class="sc-form sc-coordinate-form"><div class="sc-form-grid sc-two-fields"><label>${polar ? 'x' : 'r'}<input name="first" type="number" step="any" required></label><label>${polar ? 'y' : 'θ'}${polar ? '' : ` (${this.data.settings.angleMode})`}<input name="second" type="number" step="any" required></label></div><button class="sc-primary-button">Convert</button></form><div class="sc-coordinate-result" aria-live="polite"></div>`;
    const {host, close} = this.openDialog(content, id);
    host.querySelector('.sc-coordinate-form').addEventListener('submit', (event) => {
      event.preventDefault(); const a = Number(event.currentTarget.querySelector('[name="first"]').value); const b = Number(event.currentTarget.querySelector('[name="second"]').value); if (![a,b].every(Number.isFinite)) return;
      let outputs;
      if (polar) { let angle = Math.atan2(b,a); if (this.data.settings.angleMode === 'DEG') angle *= 180/Math.PI; if (this.data.settings.angleMode === 'GRAD') angle *= 200/Math.PI; outputs = [['r',Math.hypot(a,b)],['θ',angle]]; }
      else { let angle=b; if (this.data.settings.angleMode === 'DEG') angle *= Math.PI/180; if (this.data.settings.angleMode === 'GRAD') angle *= Math.PI/200; outputs = [['x',a*Math.cos(angle)],['y',a*Math.sin(angle)]]; }
      host.querySelector('.sc-coordinate-result').innerHTML = outputs.map(([label,value])=>`<button type="button" data-coordinate-value="${ESCAPE(value)}">${label} = ${ESCAPE(formatNumber(value))} <small>Insert</small></button>`).join('');
      host.querySelectorAll('[data-coordinate-value]').forEach((button)=>button.addEventListener('click',()=>{this.insertAtCursor(button.dataset.coordinateValue,input);close();}));
    });
  }

  openModeDialog() {
    const id = `${this.instanceId}-mode-title`;
    const choices = [
      ['COMP','1 · COMP','General scientific calculations'], ['CMPLX','2 · CMPLX','Complex arithmetic'],
      ['STAT','3 · STAT','One-variable descriptive statistics'], ['BASE-N','4 · BASE-N','Binary, octal, decimal and hexadecimal'],
      ['EQN','5 · EQN','Linear and quadratic equations'], ['MATRIX','6 · MATRIX','2 × 2 determinants and inverses'],
      ['TABLE','7 · TABLE','Function value table'], ['VECTOR','8 · VECTOR','2D and 3D vector operations']
    ];
    const content = `<div class="sc-dialog-header"><h2 id="${id}">Calculation mode</h2><button type="button" class="sc-dialog-close" data-dialog-close aria-label="Close">×</button></div><p>Select one of the available local calculation workspaces.</p>${choices.map(([mode,label,description])=>`<button type="button" data-mode-choice="${mode}" aria-pressed="${this.calculationMode===mode}"><strong>${label}</strong><small>${description}</small></button>`).join('')}`;
    const {host, close} = this.openDialog(content, id);
    host.querySelectorAll('[data-mode-choice]').forEach((button) => button.addEventListener('click', () => { const mode = button.dataset.modeChoice; close(); this.setCalculationMode(mode); }));
  }

  handleMemory(action, input) {
    if (action === 'clear') this.data.memory = null;
    else if (action === 'store') {
      if (!Number.isFinite(this.lastResult)) { this.showNotice('Calculate a numeric result before storing it.', 'error'); return; }
      this.data.memory = this.lastResult;
    } else if (action === 'recall') {
      if (this.data.memory === null) { this.showNotice('Calculator memory is empty.'); return; }
      const insertion = formatNumber(this.data.memory, { precision: this.data.settings.precision, notation: this.data.settings.notation, fixedDigits: this.data.settings.fixedDigits }); this.insertAtCursor(insertion, input); return;
    } else if (!Number.isFinite(this.lastResult)) { this.showNotice('Calculate a numeric result before using M+ or M−.', 'error'); return; }
    else this.data.memory = (this.data.memory ?? 0) + (action === 'subtract' ? -1 : 1) * this.lastResult;
    this.persist(); const status = this.container.querySelector('.sc-memory-status'); if (status) status.textContent = this.data.memory === null ? 'M —' : `M ${formatNumber(this.data.memory)}`; this.updateDeviceStatus();
  }

  async evaluateCurrent() {
    const input = this.container.querySelector('.sc-expression'); if (!input) return;
    this.expression = input.value;
    try {
      const result = evaluateExpression(this.expression, { variables: { ...this.variableValues(), ans: this.lastAnswer }, angleMode: this.data.settings.angleMode });
      const output = { ...result, formatted: formatNumber(result.value, { precision: this.data.settings.precision, notation: this.data.settings.notation, fixedDigits: this.data.settings.fixedDigits }), expression: this.expression, unit: '', steps: result.steps, mode: 'calculator', angleMode: this.data.settings.angleMode };
      this.showOutput(output, 'calculator');
    } catch (error) { this.showCalculationError(error); }
    finally { input.blur?.(); this.refreshExpressionPreview(); }
  }

  showOutput(output, mode = this.mode) {
    if (!output || (!Number.isFinite(output.value) && typeof output.formatted !== 'string')) { this.showCalculationError(new Error('No finite result is available.')); return; }
    const value = Number.isFinite(output.value) ? output.value : null;
    const formatted = output.formatted ?? formatNumber(value, { precision: this.data.settings.precision, notation: this.data.settings.notation, fixedDigits: this.data.settings.fixedDigits });
    this.calculationOutput = { ...output, value, formatted, mode };
    if (Number.isFinite(value)) { this.lastResult = value; this.lastAnswer = value; }
    this.updateAnswer(this.calculationOutput);
    this.recordHistory(this.calculationOutput);
  }

  renderStackedFraction(node, fraction, approximate = false) {
    node.replaceChildren();
    node.setAttribute('aria-label', `${approximate ? 'Approximately ' : ''}${fraction.numerator} over ${fraction.denominator}`);
    if (approximate) {
      const marker = document.createElement('span'); marker.className = 'sc-fraction-approx-marker'; marker.textContent = '≈'; node.appendChild(marker);
    }
    const stack = document.createElement('span'); stack.className = 'sc-stacked-fraction';
    const numerator = document.createElement('span'); numerator.className = 'sc-fraction-numerator'; numerator.textContent = String(fraction.numerator);
    const bar = document.createElement('span'); bar.className = 'sc-fraction-bar'; bar.setAttribute('aria-hidden', 'true');
    const denominator = document.createElement('span'); denominator.className = 'sc-fraction-denominator'; denominator.textContent = String(fraction.denominator);
    stack.append(numerator, bar, denominator); node.appendChild(stack);
  }

  updateAnswer(output) {
    const resultNode = this.container.querySelector('.sc-answer-value'); const unitNode = this.container.querySelector('.sc-answer-unit');
    const screen = this.container.querySelector('.sc-screen-result'); const steps = this.container.querySelector('.sc-answer-steps'); const disclosure = this.container.querySelector('.sc-answer-disclosure');
    const copy = this.container.querySelector('.sc-copy-result'); const save = this.container.querySelector('.sc-save-result'); const sendFraction = this.container.querySelector('.sc-send-fraction');
    if (!output) { if (resultNode) { resultNode.textContent = 'Ready'; resultNode.removeAttribute('aria-label'); } if (unitNode) unitNode.textContent = ''; if (screen) { screen.textContent = this.lastResult === null ? '0' : formatNumber(this.lastResult, { precision: this.data.settings.precision, notation: this.data.settings.notation, fixedDigits: this.data.settings.fixedDigits }); screen.removeAttribute('aria-label'); } steps?.setAttribute('hidden', ''); disclosure?.setAttribute('hidden', ''); if (copy) copy.disabled = true; if (save) save.disabled = true; if (sendFraction) sendFraction.disabled = true; this.refreshExpressionPreview(); return; }
    const fraction = Number.isFinite(output.value) ? formatFraction(output.value) : null;
    const shown = this.fractionDisplay && fraction ? `${fraction.exact ? '' : '≈ '}${fraction.text}` : output.formatted;
    if (resultNode) {
      if (this.fractionDisplay && fraction && fraction.denominator !== 1) this.renderStackedFraction(resultNode, fraction, !fraction.exact);
      else { resultNode.textContent = shown; resultNode.removeAttribute('aria-label'); }
      resultNode.classList.remove('sc-answer-error');
    }
    if (screen) {
      if (this.fractionDisplay && fraction && fraction.denominator !== 1) this.renderStackedFraction(screen, fraction, !fraction.exact);
      else { screen.textContent = shown; screen.removeAttribute('aria-label'); }
    }
    if (unitNode) unitNode.textContent = output.unit || '';
    const fractionNote = this.container.querySelector('.sc-fraction-approximation');
    if (fractionNote && this.fractionDisplay && fraction && !fraction.exact) { fractionNote.textContent = `Best rational approximation (denominator ≤ 1,000,000); not an exact identity. Error ${formatNumber(fraction.error)}.`; fractionNote.hidden = false; }
    else if (fractionNote) fractionNote.hidden = true;
    if (steps) { steps.replaceChildren(...(output.steps || []).map((step) => { const item = document.createElement('li'); item.textContent = step; return item; })); steps.hidden = !(output.steps || []).length; }
    if (disclosure) { disclosure.textContent = output.disclosure || output.assumptions || ''; disclosure.hidden = !disclosure.textContent; }
    if (copy) copy.disabled = false; if (save) save.disabled = !this.lastEntryId; if (sendFraction) sendFraction.disabled = !fraction;
    const screenExpression = this.container.querySelector('.sc-expression'); if (screenExpression && output.expression && output.mode !== 'calculator') screenExpression.value = output.expression;
    this.refreshExpressionPreview();
    this.updateDeviceStatus();
  }

  async recordHistory(output) {
    const entry = { id: idFor('calc'), expression: String(output.expression || this.expression || 'result').slice(0, 2000), result: Number.isFinite(output.value) ? output.value : null, formatted: output.formatted, mode: output.mode || this.mode, angleMode: output.angleMode || this.data.settings.angleMode, createdAt: Date.now(), favorite: false, notebookId: this.data.activeNotebookId, steps: (output.steps || []).slice(0, 30), unit: output.unit || '', note: '' };
    this.data.history.unshift(entry); this.data.history = this.data.history.slice(0, this.data.settings.historyLimit); this.data.notebooks = this.data.notebooks.map((notebook) => notebook.id === entry.notebookId ? { ...notebook, calculations: [entry, ...(notebook.calculations || [])].slice(0, 500), updatedAt: Date.now() } : notebook);
    this.lastEntryId = entry.id; this.persist(); this.updateAnswer(this.calculationOutput); this.renderSidePanel();
  }

  sendFractionToExpression() {
    const fraction = this.calculationOutput && Number.isFinite(this.calculationOutput.value) ? formatFraction(this.calculationOutput.value) : null;
    if (!fraction) return;
    this.expression = fraction.denominator === 1 ? String(fraction.numerator) : `(${fraction.numerator}/${fraction.denominator})`;
    const input = this.container.querySelector('.sc-expression'); input.value = this.expression; input.focus(); input.setSelectionRange?.(this.expression.length, this.expression.length);
    this.setMode('calculator'); this.showNotice(fraction.exact ? `Sent exact fraction ${fraction.text} to the calculator.` : `Sent best rational approximation ${fraction.text}; verify before using it.`);
  }

  renderSidePanel() {
    const panel = this.container.querySelector('.sc-side-content'); if (!panel) return;
    this.container.querySelectorAll('.sc-side-tabs [data-panel]').forEach((button) => { button.setAttribute('aria-selected', button.dataset.panel === this.sidePanel ? 'true' : 'false'); });
    if (this.sidePanel === 'history') this.renderEntries(panel, this.data.history, true);
    else if (this.sidePanel === 'favorites') this.renderEntries(panel, this.data.saved, false);
    else if (this.sidePanel === 'formulas') this.renderFormulas(panel);
    else if (this.sidePanel === 'variables') this.renderVariables(panel);
    else if (this.sidePanel === 'notebooks') this.renderNotebooks(panel);
  }

  renderEntries(panel, entries, canDelete) {
    panel.replaceChildren();
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'sc-empty-state'; empty.textContent = this.sidePanel === 'history' ? 'No calculations yet. Try the keypad, graph analysis, integrals, units or science tools.' : 'No saved calculations yet. Save a result to keep it here.'; panel.appendChild(empty); return; }
    entries.slice(0, 100).forEach((entry) => {
      const card = document.createElement('article'); card.className = 'sc-entry-card';
      const expression = document.createElement('button'); expression.type = 'button'; expression.className = 'sc-entry-expression'; expression.textContent = entry.expression; expression.title = 'Load this expression without calculating'; expression.addEventListener('click', () => { this.expression = entry.expression; this.setMode('calculator'); const input = this.container.querySelector('.sc-expression'); input.value = this.expression; input.focus(); });
      const result = document.createElement('p'); result.className = 'sc-entry-result'; result.textContent = `${entry.formatted}${entry.unit ? ` ${entry.unit}` : ''}`;
      const timestamp = document.createElement('small'); timestamp.textContent = new Date(entry.createdAt).toLocaleString();
      const actions = document.createElement('div'); actions.className = 'sc-entry-actions';
      const favorite = document.createElement('button'); favorite.type = 'button'; favorite.textContent = entry.favorite ? 'Unsave' : 'Save'; favorite.addEventListener('click', () => this.toggleFavorite(entry)); actions.appendChild(favorite);
      if (canDelete) { const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => this.deleteEntry(entry.id)); actions.appendChild(remove); }
      card.append(expression, result, timestamp, actions); panel.appendChild(card);
    });
  }

  renderFormulas(panel) {
    panel.replaceChildren();
    const intro = document.createElement('p'); intro.className = 'sc-field-help'; intro.textContent = 'Transparent formula references. Use loads an expression; evaluate it only after entering any required variables. Add your own safe expression formula below.'; panel.appendChild(intro);
    const all = [...SCIENTIFIC_FORMULAS, ...this.data.customFormulas.map((formula) => ({ ...formula, custom: true }))];
    all.forEach((formula) => {
      const card = document.createElement('article'); card.className = 'sc-formula-card';
      const title = document.createElement('h3'); title.textContent = `${formula.name}${formula.custom ? ' · Your formula' : ''}`;
      const expression = document.createElement('p'); expression.className = 'sc-formula-expression'; expression.textContent = formula.expression;
      const variables = document.createElement('p'); variables.textContent = formula.variables || 'User-defined expression. Add its variables in Variables.';
      const assumptions = document.createElement('p'); assumptions.className = 'sc-field-help'; assumptions.textContent = formula.assumptions || 'Check units and assumptions before relying on a result.';
      const actions = document.createElement('div'); actions.className = 'sc-formula-actions';
      const use = document.createElement('button'); use.type = 'button'; use.textContent = 'Use expression'; use.addEventListener('click', () => { this.expression = formula.expression; this.setMode('calculator'); const input = this.container.querySelector('.sc-expression'); input.value = this.expression; input.focus(); }); actions.appendChild(use);
      if (formula.custom) { const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => { this.data.customFormulas = this.data.customFormulas.filter((item) => item.id !== formula.id); this.persist(); this.renderSidePanel(); }); actions.appendChild(remove); }
      card.append(title, expression, variables, assumptions, actions); panel.appendChild(card);
    });
    const form = document.createElement('form'); form.className = 'sc-custom-formula-form'; form.innerHTML = '<h3>Add a personal formula</h3><label>Name<input name="name" maxlength="80" required placeholder="e.g. My flow ratio"></label><label>Expression<input name="expression" maxlength="300" required placeholder="e.g. volume / time"></label><label>Variables and units<textarea name="variables" maxlength="500" placeholder="volume in mL; time in hours"></textarea></label><label>Assumptions<textarea name="assumptions" maxlength="1000" placeholder="State when this formula applies"></textarea></label><button type="submit">Save formula on this device</button>';
    form.addEventListener('submit', (event) => { event.preventDefault(); const values = new FormData(form); const formula = { id: idFor('formula'), name: String(values.get('name')).trim(), expression: String(values.get('expression')).trim(), variables: String(values.get('variables') || '').trim(), assumptions: String(values.get('assumptions') || '').trim(), createdAt: Date.now() }; if (!formula.name || !formula.expression) return; if (this.data.customFormulas.length >= 200) { this.showNotice('The local formula library is full (200 formulas).', 'error'); return; } this.data.customFormulas.unshift(formula); this.persist(); this.renderSidePanel(); this.showNotice('Personal formula saved locally.'); });
    panel.appendChild(form);
  }

  renderVariables(panel) {
    panel.replaceChildren();
    const form = document.createElement('form'); form.className = 'sc-variable-form'; form.innerHTML = '<label>Name<input name="name" maxlength="32" placeholder="e.g. radius" required></label><label>Value<input name="value" type="number" step="any" placeholder="0" required></label><label>Unit or meaning (optional)<input name="unit" maxlength="40" placeholder="e.g. meters"></label><button type="submit">Add variable</button>';
    form.addEventListener('submit', (event) => { event.preventDefault(); const nameInput = form.elements.name; const numeric = Number(form.elements.value.value); try { const name = validateCalculatorVariableName(nameInput.value); if (!Number.isFinite(numeric)) throw new Error('Enter a finite numeric value.'); this.data.variables[name] = { value: numeric, unit: form.elements.unit.value.trim(), updatedAt: Date.now() }; this.persist(); this.renderSidePanel(); this.showNotice(`Variable ${name} saved locally.`); } catch (error) { this.showNotice(error.message, 'error'); } });
    panel.appendChild(form);
    const entries = Object.entries(this.data.variables);
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'sc-empty-state'; empty.textContent = 'Add your own numbers for reuse in expressions. Variables are numeric; units are shown as notes and are not propagated through calculations.'; panel.appendChild(empty); }
    entries.forEach(([name, variable]) => { const row = document.createElement('div'); row.className = 'sc-variable-row'; const label = document.createElement('button'); label.type = 'button'; label.textContent = `${name} = ${formatNumber(variable.value ?? variable)}${variable.unit ? ` ${variable.unit}` : ''}`; label.addEventListener('click', () => { this.insertAtCursor(name, this.container.querySelector('.sc-expression')); this.setMode('calculator'); }); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => { delete this.data.variables[name]; this.persist(); this.renderSidePanel(); }); row.append(label, remove); panel.appendChild(row); });
  }

  renderNotebooks(panel) {
    panel.replaceChildren(); const toolbar = document.createElement('div'); toolbar.className = 'sc-notebook-toolbar'; const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose notebook');
    this.data.notebooks.forEach((notebook) => { const option = document.createElement('option'); option.value = notebook.id; option.textContent = notebook.name; select.appendChild(option); });
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'New'; toolbar.append(select, add); panel.appendChild(toolbar);
    const notebook = this.data.notebooks.find((item) => item.id === this.data.activeNotebookId) || this.data.notebooks[0]; select.value = notebook.id;
    const name = document.createElement('input'); name.className = 'sc-notebook-name'; name.value = notebook.name; name.maxLength = 80; name.setAttribute('aria-label', 'Notebook name');
    const notes = document.createElement('textarea'); notes.className = 'sc-notebook-notes'; notes.value = notebook.notes; notes.maxLength = 10000; notes.placeholder = 'Personal notes, working, assumptions, references…'; notes.setAttribute('aria-label', 'Notebook notes');
    const save = () => { notebook.name = name.value.trim() || 'Notebook'; notebook.notes = notes.value; notebook.updatedAt = Date.now(); this.persist(); };
    name.addEventListener('change', save); notes.addEventListener('input', () => { if (this.notesSaveTimer) clearTimeout(this.notesSaveTimer); this.notesSaveTimer = setTimeout(save, 300); });
    select.addEventListener('change', () => { this.data.activeNotebookId = select.value; this.persist(); this.renderSidePanel(); });
    add.addEventListener('click', async () => { let notebookName = ''; if (this.onPrompt) notebookName = await this.onPrompt('New calculator notebook', 'Notebook name'); else if (typeof window !== 'undefined' && typeof window.prompt === 'function') notebookName = window.prompt('Notebook name'); if (!notebookName?.trim()) return; if (this.data.notebooks.length >= 100) { this.showNotice('The local notebook limit is 100.', 'error'); return; } const next = { id: idFor('notebook'), name: notebookName.trim().slice(0, 80), notes: '', calculations: [], updatedAt: Date.now() }; this.data.notebooks.push(next); this.data.activeNotebookId = next.id; this.persist(); this.renderSidePanel(); });
    panel.append(name, notes);
    const entryList = document.createElement('div'); entryList.className = 'sc-notebook-calculations'; const entries = this.data.history.filter((entry) => entry.notebookId === notebook.id).slice(0, 30);
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'sc-empty-state'; empty.textContent = 'Calculations in this notebook will appear here automatically.'; entryList.appendChild(empty); }
    entries.forEach((entry) => { const item = document.createElement('p'); item.textContent = `${entry.expression} = ${entry.formatted}${entry.unit ? ` ${entry.unit}` : ''}`; entryList.appendChild(item); }); panel.appendChild(entryList);
  }

  toggleFavorite(entry) {
    const next = !entry.favorite; entry.favorite = next; this.data.history = this.data.history.map((item) => item.id === entry.id ? { ...item, favorite: next } : item);
    if (next) { const saved = this.data.history.find((item) => item.id === entry.id); if (saved && !this.data.saved.some((item) => item.id === entry.id)) this.data.saved.unshift({ ...saved }); this.data.favorites = [...new Set([...this.data.favorites, entry.id])]; }
    else { this.data.saved = this.data.saved.filter((item) => item.id !== entry.id); this.data.favorites = this.data.favorites.filter((id) => id !== entry.id); }
    this.persist(); this.renderSidePanel();
  }

  saveResult() { const entry = this.data.history.find((item) => item.id === this.lastEntryId); if (entry) { this.toggleFavorite(entry); this.showNotice('Saved to your local calculations.'); } }
  deleteEntry(id) { this.data.history = this.data.history.filter((entry) => entry.id !== id); this.data.saved = this.data.saved.filter((entry) => entry.id !== id); this.data.favorites = this.data.favorites.filter((value) => value !== id); this.persist(); this.renderSidePanel(); }

  async copyResult() {
    const text = this.calculationOutput ? `${this.calculationOutput.formatted}${this.calculationOutput.unit ? ` ${this.calculationOutput.unit}` : ''}` : '';
    try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); else { const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } this.showNotice('Result copied.'); }
    catch { this.showNotice('Clipboard access is not available in this window.', 'error'); }
  }

  async exportBackup() {
    try { const content = JSON.stringify({ app: 'yayra-scientific-calculator', formatVersion: SCIENTIFIC_CALCULATOR_SCHEMA, exportedAt: new Date().toISOString(), data: this.data }, null, 2); const blob = new Blob([content], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'yayra-calculator-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); this.showNotice('Local backup exported.'); }
    catch { this.showNotice('Could not export calculator backup.', 'error'); }
  }

  async importBackup(event) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 5 * 1024 * 1024) { this.showNotice('Backup file exceeds the 5 MB import limit.', 'error'); return; }
    try {
      const backup = JSON.parse(await file.text()); if (backup?.app !== 'yayra-scientific-calculator' || !Number.isInteger(backup.formatVersion) || backup.formatVersion < 1 || backup.formatVersion > SCIENTIFIC_CALCULATOR_SCHEMA) throw new Error('This is not a supported Yayra calculator backup.');
      const imported = sanitizeScientificCalculatorData(backup.data); const history = new Map([...imported.history, ...this.data.history].map((entry) => [entry.id, entry])); const saved = new Map([...imported.saved, ...this.data.saved].map((entry) => [entry.id, entry])); const notebooks = new Map([...imported.notebooks, ...this.data.notebooks].map((notebook) => [notebook.id, notebook])); const formulas = new Map([...imported.customFormulas, ...this.data.customFormulas].map((formula) => [formula.id, formula]));
      this.data = sanitizeScientificCalculatorData({ ...imported, settings: this.data.settings, history: [...history.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, this.data.settings.historyLimit), saved: [...saved.values()], favorites: [...new Set([...imported.favorites, ...this.data.favorites])], variables: { ...imported.variables, ...this.data.variables }, graphFunctions: this.data.graphFunctions, graphRange: this.data.graphRange, customFormulas: [...formulas.values()], activeNotebookId: this.data.activeNotebookId, notebooks: [...notebooks.values()] });
      this.persist(); this.renderSidePanel(); this.showNotice('Backup imported and merged locally.');
    } catch (error) { this.showNotice(error.message || 'Could not import this backup.', 'error'); }
  }

  variableValues() { return Object.fromEntries(Object.entries(this.data.variables).map(([name, value]) => [name, Number(value?.value ?? value)])); }

  renderGraphPlot() {
    const target = this.container.querySelector('.sc-graph-output'); if (!target) return;
    const range = this.data.graphRange; const width = 900; const height = 520; const margin = { left: 62, right: 20, top: 24, bottom: 46 }; const plotWidth = width - margin.left - margin.right; const plotHeight = height - margin.top - margin.bottom;
    const x = (value) => margin.left + (value - range.xMin) / (range.xMax - range.xMin) * plotWidth; const y = (value) => margin.top + (range.yMax - value) / (range.yMax - range.yMin) * plotHeight;
    const niceStep = (span) => { const raw = span / 10; const power = 10 ** Math.floor(Math.log10(raw || 1)); const normalized = raw / power; return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power; };
    const xStep = niceStep(range.xMax - range.xMin); const yStep = niceStep(range.yMax - range.yMin); const grid = [];
    for (let value = Math.ceil(range.xMin / xStep) * xStep, count = 0; value <= range.xMax && count++ < 80; value += xStep) { const px = x(value); grid.push(`<path class="sc-grid-line" d="M${px.toFixed(2)} ${margin.top}V${height - margin.bottom}"/><text x="${px.toFixed(2)}" y="${height - 14}" text-anchor="middle">${ESCAPE(formatNumber(value, { precision: 4 }))}</text>`); }
    for (let value = Math.ceil(range.yMin / yStep) * yStep, count = 0; value <= range.yMax && count++ < 80; value += yStep) { const py = y(value); grid.push(`<path class="sc-grid-line" d="M${margin.left} ${py.toFixed(2)}H${width - margin.right}"/><text x="${margin.left - 9}" y="${(py + 4).toFixed(2)}" text-anchor="end">${ESCAPE(formatNumber(value, { precision: 4 }))}</text>`); }
    const axes = [];
    if (range.yMin <= 0 && range.yMax >= 0) axes.push(`<path class="sc-axis-line" d="M${margin.left} ${y(0)}H${width - margin.right}"/>`);
    if (range.xMin <= 0 && range.xMax >= 0) axes.push(`<path class="sc-axis-line" d="M${x(0)} ${margin.top}V${height - margin.bottom}"/>`);
    const paths = this.data.graphFunctions.filter((entry) => entry.visible).map((entry) => {
      let points; try { points = sampleFunction(entry.expression, { min: range.xMin, max: range.xMax, count: 701, angleMode: this.data.settings.angleMode, variables: this.variableValues() }); } catch { return ''; }
      let segments = []; let current = [];
      for (const point of points) { if (!Number.isFinite(point.y) || point.y < range.yMin - (range.yMax - range.yMin) * 2 || point.y > range.yMax + (range.yMax - range.yMin) * 2) { if (current.length > 1) segments.push(current.join(' ')); current = []; continue; } current.push(`${current.length ? 'L' : 'M'}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`); }
      if (current.length > 1) segments.push(current.join(' ')); return `<path class="sc-graph-curve" stroke="${entry.color}" d="${segments.join(' ')}"/>`;
    }).join('');
    target.innerHTML = `<svg class="sc-graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Interactive graph of locally sampled functions"><defs><clipPath id="${this.instanceId}-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs><rect class="sc-graph-background" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" rx="2"/>${grid.join('')}${axes.join('')}<g clip-path="url(#${this.instanceId}-clip)">${paths}</g><text class="sc-axis-label" x="${width - 10}" y="${height - 13}" text-anchor="end">x</text><text class="sc-axis-label" x="${margin.left + 10}" y="${margin.top + 13}">y</text></svg>`;
    this.renderGraphControls();
  }

  drawGraph() {
    const target = this.container.querySelector('.sc-graph-output'); if (!target) return;
    this.renderGraphPlot();
    const list = this.container.querySelector('.sc-graph-function-list'); if (list) {
      list.replaceChildren(); this.data.graphFunctions.forEach((entry) => {
        const row = document.createElement('div'); row.className = 'sc-graph-function-row';
        const swatch = document.createElement('span'); swatch.className = 'sc-graph-swatch'; swatch.style.background = entry.color;
        const visible = document.createElement('button'); visible.type = 'button'; visible.className = 'sc-graph-visible'; visible.dataset.graphAction = 'toggle'; visible.dataset.id = entry.id; visible.setAttribute('aria-label', `${entry.visible ? 'Hide' : 'Show'} ${entry.expression}`); visible.textContent = entry.visible ? '●' : '○'; visible.style.color = entry.color;
        const input = document.createElement('input'); input.type = 'text'; input.value = entry.expression; input.maxLength = 180; input.dataset.graphInput = entry.id; input.setAttribute('aria-label', `Function ${entry.expression}`);
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.graphAction = 'remove'; remove.dataset.id = entry.id; remove.setAttribute('aria-label', `Remove ${entry.expression}`); remove.textContent = '×';
        row.append(swatch, visible, input, remove); list.appendChild(row);
      });
    }
    this.renderGraphControls();
  }

  renderGraphControls() {
    const range = this.data.graphRange;
    this.container.querySelectorAll('.sc-range-input').forEach((input) => { if (document.activeElement !== input) input.value = range[input.name]; });
    const functionSelect = this.container.querySelector('.sc-analysis-function'); const intersectionSelect = this.container.querySelector('.sc-intersection-function');
    for (const select of [functionSelect, intersectionSelect]) if (select) { const old = select.value; select.replaceChildren(...this.data.graphFunctions.map((entry) => { const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.expression; return option; })); if (this.data.graphFunctions.some((entry) => entry.id === old)) select.value = old; }
  }

  updateGraphRange(showNotice = true) {
    const controls = Object.fromEntries([...this.container.querySelectorAll('.sc-range-input')].map((input) => [input.name, Number(input.value)]));
    if (!Object.values(controls).every(Number.isFinite) || controls.xMin >= controls.xMax || controls.yMin >= controls.yMax || !Number.isFinite(controls.xMax - controls.xMin) || !Number.isFinite(controls.yMax - controls.yMin)) { if (showNotice) this.showNotice('Graph bounds must be finite and increasing.', 'error'); return; }
    this.data.graphRange = controls; this.persist(); this.drawGraph();
  }

  zoomGraph(factor) {
    const range = this.data.graphRange; const cx = (range.xMin + range.xMax) / 2; const cy = (range.yMin + range.yMax) / 2; const hx = (range.xMax - range.xMin) * factor / 2; const hy = (range.yMax - range.yMin) * factor / 2;
    this.data.graphRange = { xMin: cx - hx, xMax: cx + hx, yMin: cy - hy, yMax: cy + hy }; this.persist(); this.drawGraph();
  }

  analyzeGraph(kind) {
    const output = this.container.querySelector('.sc-analysis-output'); if (!output) return;
    const selected = this.data.graphFunctions.find((entry) => entry.id === this.container.querySelector('.sc-analysis-function')?.value) || this.data.graphFunctions[0];
    if (!selected) { output.textContent = 'Add a function before analysis.'; return; }
    const range = { min: this.data.graphRange.xMin, max: this.data.graphRange.xMax, angleMode: this.data.settings.angleMode, variables: this.variableValues() };
    try {
      let text = '';
      if (kind === 'roots') { const result = findFunctionRoots(selected.expression, range); text = result.roots.length ? `Approximate roots: ${result.roots.map((x) => `x ≈ ${formatNumber(x)}`).join(' · ')}` : 'No sign-change roots were detected in this range. Tangential roots may be missed.'; }
      else if (kind === 'extrema') { const result = findFunctionExtrema(selected.expression, range); text = result.extrema.length ? result.extrema.map((point) => `Local ${point.kind} near (${formatNumber(point.x)}, ${formatNumber(point.y)})`).join(' · ') : 'No local extrema were detected in this range.'; }
      else { const other = this.data.graphFunctions.find((entry) => entry.id === this.container.querySelector('.sc-intersection-function')?.value); if (!other || other.id === selected.id) throw new Error('Choose two different plotted functions.'); const result = findFunctionIntersections(selected.expression, other.expression, range); text = result.intersections.length ? result.intersections.map((point) => `Intersection ≈ (${formatNumber(point.x)}, ${formatNumber(point.y)})`).join(' · ') : 'No sign-change intersections were detected in this range.'; }
      output.textContent = `${text} Numerical approximation; check the graph and residuals.`;
    } catch (error) { output.textContent = error.message; }
  }

  exportGraph() {
    const svg = this.container.querySelector('.sc-graph-svg'); if (!svg) return;
    try { const copy = svg.cloneNode(true); copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'yayra-scientific-graph.svg'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); this.showNotice('Graph exported as a local SVG file.'); }
    catch (error) { this.showNotice(error.message || 'Could not export graph.', 'error'); }
  }

  printGraph() {
    const page = this.container.querySelector('.sc-graph-card'); if (!page) return;
    page.classList.add('sc-printing-graph');
    document.body.classList.add('sc-print-graph-mode');
    try { window.print(); } catch { this.showNotice('Printing is not available in this window.', 'error'); }
    setTimeout(() => { page.classList.remove('sc-printing-graph'); document.body.classList.remove('sc-print-graph-mode'); }, 700);
  }

  drawSurface() {
    const canvas = this.container.querySelector('.sc-surface-canvas'); if (!canvas) return;
    const range = Number(this.surfaceRange || this.container.querySelector('.sc-surface-form [name="range"]')?.value) || 5;
    const output = sampleSurface(this.data.surfaceExpression, { xMin: -range, xMax: range, yMin: -range, yMax: range, count: 29, angleMode: this.data.settings.angleMode, variables: this.variableValues() });
    const context = canvas.getContext('2d'); if (!context) return;
    const width = canvas.width; const height = canvas.height; context.clearRect(0, 0, width, height); context.fillStyle = '#f8fbff'; context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgba(71,85,105,.22)'; context.lineWidth = 1;
    for (let i = 0; i <= 10; i += 1) { context.beginPath(); context.moveTo(i * width / 10, 0); context.lineTo(i * width / 10, height); context.stroke(); context.beginPath(); context.moveTo(0, i * height / 10); context.lineTo(width, i * height / 10); context.stroke(); }
    const valid = output.rows.flat().filter(Boolean); const zMax = Math.max(1e-12, ...valid.map((point) => Math.abs(point.z)));
    const { yaw, pitch, zoom } = this.surfaceRotation;
    const project = ({ x, y, z }) => {
      const xn = x / range; const yn = y / range; const zn = Math.max(-1.5, Math.min(1.5, z / zMax));
      const rx = xn * Math.cos(yaw) - yn * Math.sin(yaw); const ry = xn * Math.sin(yaw) + yn * Math.cos(yaw);
      const px = width * .5 + (rx - ry) * width * .21 * zoom; const py = height * .53 + (rx + ry) * height * .12 * Math.sin(pitch) * zoom - zn * height * .23 * Math.cos(pitch) * zoom;
      return { x: px, y: py, depth: rx + ry + zn * .15, z: zn };
    };
    const faces = [];
    for (let j = 0; j < output.count - 1; j += 1) for (let i = 0; i < output.count - 1; i += 1) {
      const points = [output.rows[j][i], output.rows[j][i + 1], output.rows[j + 1][i + 1], output.rows[j + 1][i]];
      if (points.some((point) => !point)) continue;
      const projected = points.map(project); faces.push({ projected, depth: projected.reduce((sum, point) => sum + point.depth, 0) / 4, z: projected.reduce((sum, point) => sum + point.z, 0) / 4 });
    }
    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) {
      const hue = 215 - (face.z + 1) * 72; const lightness = 50 + face.z * 8;
      context.beginPath(); context.moveTo(face.projected[0].x, face.projected[0].y); face.projected.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.closePath(); context.fillStyle = `hsla(${hue}, 68%, ${lightness}%, .82)`; context.fill(); context.strokeStyle = 'rgba(15,23,42,.26)'; context.lineWidth = .7; context.stroke();
    }
    const drawAxis = (from, to, color, label) => { const a = project(from); const b = project(to); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.strokeStyle = color; context.lineWidth = 3; context.stroke(); context.fillStyle = color; context.font = 'bold 18px sans-serif'; context.fillText(label, b.x + 5, b.y - 5); };
    drawAxis({ x: -range, y: 0, z: 0 }, { x: range, y: 0, z: 0 }, '#dc2626', 'x'); drawAxis({ x: 0, y: -range, z: 0 }, { x: 0, y: range, z: 0 }, '#059669', 'y'); drawAxis({ x: 0, y: 0, z: -zMax }, { x: 0, y: 0, z: zMax }, '#2563eb', 'z');
    canvas.onpointerdown = (event) => { this.pointerDrag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture?.(event.pointerId); };
    canvas.onpointermove = (event) => { if (!this.pointerDrag) return; this.surfaceRotation.yaw += (event.clientX - this.pointerDrag.x) * .008; this.surfaceRotation.pitch = Math.max(-1.2, Math.min(1.35, this.surfaceRotation.pitch + (event.clientY - this.pointerDrag.y) * .006)); this.pointerDrag = { x: event.clientX, y: event.clientY }; this.drawSurface(); };
    canvas.onpointerup = () => { this.pointerDrag = null; }; canvas.onpointercancel = () => { this.pointerDrag = null; };
  }
}
