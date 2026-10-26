import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
const calculator = readFileSync(new URL('../packages/shared-ui/src/components/ScientificCalculator.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../packages/shared-ui/src/services/scientificCalculator.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../packages/shared-ui/src/theme/scientific-calculator.css', import.meta.url), 'utf8');
const designCss = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');

test('calculator routes through main and mini browser with private in-memory storage', () => {
  assert.match(shell, /url === 'yayra:\/\/calculator'.*renderInternalScientificCalculatorPage\(viewport, activeTab\)/s);
  assert.match(shell, /url === 'yayra:\/\/calculator'.*renderInternalScientificCalculatorPage\(miniViewport, activeTab\)/s);
  assert.match(shell, /createScientificCalculatorRepo\(calculatorStorage\)/);
  assert.match(shell, /const calculatorRepo = privateMode \? this\.privateScientificCalculatorRepo : this\.scientificCalculatorRepo/);
  assert.match(shell, /this\.profileStorage \|\| this\.storageAdapter/);
  assert.match(shell, /tab\.url === 'yayra:\/\/calculator'\) return 'Scientific Calculator'/);
  assert.match(shell, /url\.startsWith\('yayra:\/\/calculator'\)\) return Icons\.calculator/);
  assert.match(shell, /createNewTab\(Boolean\(activeTab\?\.isPrivate\)\)/, 'opening a calculator from private browsing stays private');
});

test('four compact quick-action slots keep Downloads and Tools, with two profile-customizable actions', () => {
  const mainActions = shell.slice(shell.indexOf('// 4. Action Buttons'), shell.indexOf('// NOTE: the old "floating mode"'));
  assert.match(mainActions, /getToolbarQuickActions\(\)/);
  assert.match(mainActions, /createToolbarQuickAction\(actionId/);
  assert.match(shell, /return \['downloads', 'tools', \.\.\.extras\]/);
  assert.match(shell, /toolbarQuickActions: \['downloads', 'tools', 'documents', 'dictionary'\]/);
  assert.match(shell, /id="sec-toolbar-actions"/);
  assert.match(shell, /fb-in-toolbar-action-1/);
  assert.match(shell, /fb-in-toolbar-action-2/);
  assert.match(shell, /toolbarQuickActionMarkup\(action\)/);
  assert.match(shell, /handleToolbarQuickAction\(button\.dataset\.quickAction, \{ mini: true \}\)/);
  assert.match(shell, /fb-toolbar-downloads-btn/);
  assert.match(shell, /fb-toolbar-tools-btn/);
});

test('Settings exposes Calculator and keeps Downloads as a distinct category', () => {
  assert.match(shell, /data-cat="calculator" data-category="calculator"/);
  assert.match(shell, /id="sec-calculator"/);
  assert.match(shell, /fb-in-open-calculator/);
  assert.match(shell, /calculatorOpenDestination/);
  assert.match(shell, /fb-in-calculator-open-mini/);
  assert.match(shell, /openCalculatorFromPreference\(\)/);
  assert.match(shell, /Ctrl\+Alt\+Shift\+C/);
  assert.match(shell, /openCalculatorFromPreference\(\);/);
  assert.match(shell, /isSafeInternalSessionUrl\(url\)/, 'safe internal calculator, dictionary and tool pages are included in restore snapshots');
  assert.match(shell, /id="sec-downloads"/);
});

test('calculator workspace includes numerical graph analysis, local calculus and scientific limits', () => {
  assert.match(calculator, /work stays in this Yayra profile/);
  assert.match(calculator, /never executes JavaScript/);
  assert.match(engine, /not a clinical dosing recommendation/);
  assert.match(calculator, /not a recommended medication dose or infusion rate/);
  assert.match(calculator, /not symbolic proofs/);
  assert.match(calculator, /Export backup/);
  assert.match(calculator, /Import backup/);
  assert.match(calculator, /No account, network, cloud service or AI is needed/);
  assert.match(engine, /export function integrateFunction/);
  assert.match(engine, /export function sampleSurface/);
  assert.match(engine, /export function findFunctionRoots/);
});

test('calculator styles use the design system and responsive graph/canvas presentation', () => {
  assert.match(designCss, /scientific-calculator\.css/);
  assert.match(css, /@media \(max-width:700px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /sc-surface-canvas/);
  assert.match(css, /grid-template-columns:repeat\(30,minmax\(0,1fr\)\)/);
  assert.match(css, /grid-column:11 \/ span 10/);
  assert.match(calculator, /rowNumber >= 6 && row\.filter\(Boolean\)\.length === 5 \? 6 : 5/, 'five-key rows expand to fill the final track span');
  assert.match(css, /sc-fraction-template/);
  assert.match(css, /sc-graph-curve/);
  assert.match(css, /@media print/);
});
