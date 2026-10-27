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

test('desktop pins the calculator and result area while the right-side science workspace scrolls', () => {
  const desktop = css.slice(css.lastIndexOf('@media (min-width:1051px)'));
  assert.notEqual(desktop, css, 'desktop viewport rules are present');
  assert.match(desktop, /fb-internal-page\.fb-scientific-calculator-page \{ overflow:hidden; \}/);
  assert.match(desktop, /\.sc-workspace-column \{[^}]*overflow:hidden/);
  assert.match(desktop, /\.sc-workspace-scroll \{[^}]*overflow-y:auto/,
    'the right-side work area has its own vertical scrollbar');
  assert.match(desktop, /\.sc-workspace-fixed \{[^}]*flex:none/,
    'the header, tabs and result occupy permanent space beside the calculator');
  assert.match(desktop, /\.sc-calculator-column \{[^}]*position:sticky[^}]*height:100%; max-height:100%; overflow-y:auto/,
    'the calculator remains pinned and its lower controls can scroll into view if needed');
  assert.match(desktop, /\.sc-workspace-fixed > \.sc-answer-card \{[^}]*padding:6px 9px/,
    'the answer card stays compact in its own permanent area');
  assert.match(desktop, /grid-auto-rows:minmax\(clamp\(31px,calc\(13px \+ 3vh\),40px\),auto\)/,
    'calculator key size scales with viewport height to use available space');
  assert.match(css, /grid-template-columns:minmax\(340px,min\(34vw,440px\)\)/,
    'the calculator column is wider on desktop');
  const calculatorColumn = calculator.slice(calculator.indexOf('<main class="sc-calculator-column">'), calculator.indexOf('</main>'));
  assert.match(calculatorColumn, /sc-calculator-device/);
  assert.doesNotMatch(calculatorColumn, /sc-answer-card/, 'the answer is no longer hidden below the fixed calculator');
  const workspaceStart = calculator.indexOf('<section class="sc-workspace-column"');
  assert.ok(calculator.indexOf('<div class="sc-workspace-fixed">') > workspaceStart,
    'the heading, notice, tabs and result are grouped into the permanent right-side area');
  assert.ok(calculator.indexOf('<div class="sc-workspace-scroll">') > workspaceStart,
    'the remaining science tools live in a separate right-side scroll area');
  assert.ok(calculator.indexOf('<header class="sc-header">') > workspaceStart);
  assert.ok(calculator.indexOf('<nav class="sc-workspace-nav"') > workspaceStart);
  assert.ok(calculator.indexOf('sc-answer-card') > workspaceStart);
  const mobileReflow = desktop.slice(desktop.indexOf('@media (max-width:1050px)'));
  assert.match(mobileReflow, /overflow-y:auto/);
  assert.match(mobileReflow, /\.sc-workspace-column,\.sc-workspace-fixed,\.sc-workspace-scroll \{ display:contents/,
    'mobile reflow preserves heading and navigation above the calculator');
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
