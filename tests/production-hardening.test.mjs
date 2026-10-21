import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * PRODUCTION HARDENING ("prevent all lagging and all sorts of freezing"):
 *  1. Global error shield - a stray exception in any handler never looks
 *     like a dead app; it is logged (rate-limited) and the UI keeps
 *     running. Cleaned up on destroy.
 *  2. Render coalescing - bursts of renders within one animation frame
 *     collapse into ONE rebuild (startup/session-restore/navigation
 *     storms); synchronous fallback where rAF doesn't exist and a deadline
 *     fallback where a scheduled rAF is lost.
 *  3. Electron freeze guards - renderer crashes and a genuinely stuck shell
 *     auto-reload the chrome (rate-limited, no recovery loop).
 *  4. No full-viewport backdrop blur behind modals (the most expensive
 *     paint on low-end Android).
 */

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

async function makeShell({ storage } = {}) {
  if (storage) globalThis.localStorage = storage;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('ERROR SHIELD: installed once, survives stray errors, rate-limits notices, cleaned up on destroy', async () => {
  const { shell } = await makeShell({ storage: makeStorage() });
  try {
    assert.ok(shell._errorShieldOnWindowError, 'shield handler installed');
    assert.ok(shell._errorShieldOnRejection, 'rejection handler installed');

    let notices = 0;
    shell.showTransientNotice = () => { notices += 1; };
    const logs = [];
    shell.logger = (m) => logs.push(m);

    // A burst of stray errors: never throws, ONE notice per rate window.
    for (let i = 0; i < 20; i += 1) {
      shell._errorShieldOnWindowError({ message: `boom ${i}` });
      shell._errorShieldOnRejection(new Error(`reject ${i}`));
    }
    assert.equal(notices, 1, 'notices are rate-limited to one per 15s');
    assert.equal(logs.length, 40, 'every error is still logged for diagnosis');
    assert.ok(logs.some((l) => l.includes('boom 3')));
    assert.ok(logs.some((l) => l.includes('reject 7')));

    // A shield whose notice path itself is broken must still never throw.
    shell.showTransientNotice = () => { throw new Error('notice renderer broken'); };
    shell._errorShieldOnWindowError({ message: 'boom' });
    assert.ok(true, 'shield never propagates');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('RENDER COALESCING: without rAF it renders synchronously (identical behaviour everywhere)', async () => {
  const { shell, container } = await makeShell({ storage: makeStorage() });
  try {
    assert.equal(typeof globalThis.window.requestAnimationFrame, 'undefined', 'shim has no rAF');
    let renders = 0;
    const original = shell.render.bind(shell);
    shell.render = (...a) => { renders += 1; return original(...a); };
    shell.requestRender();
    shell.requestRender();
    assert.equal(renders, 2, 'no rAF -> every requestRender renders immediately');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('RENDER COALESCING: a throwing rAF falls back immediately and never latches', async () => {
  const { shell } = await makeShell({ storage: makeStorage() });
  globalThis.window.requestAnimationFrame = () => { throw new Error('frame scheduler unavailable'); };
  try {
    let renders = 0;
    const original = shell.render.bind(shell);
    shell.render = (...args) => { renders += 1; return original(...args); };
    assert.doesNotThrow(() => shell.requestRender());
    assert.equal(renders, 1);
    assert.equal(shell._renderFramePending, false);
  } finally {
    delete globalThis.window.requestAnimationFrame;
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('RENDER COALESCING: with rAF, a burst of requests collapses into ONE rebuild', async () => {
  const { shell, container } = await makeShell({ storage: makeStorage() });
  const frames = [];
  globalThis.window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try {
    let renders = 0;
    const original = shell.render.bind(shell);
    shell.render = (...a) => { renders += 1; return original(...a); };

    shell.requestRender();
    shell.requestRender();
    shell.requestRender();
    shell.requestRender();
    shell.requestRender();
    assert.equal(renders, 0, 'nothing rendered yet - one frame is pending');
    assert.equal(frames.length, 1, 'exactly ONE rAF was scheduled');
    frames[0](); // the frame fires
    assert.equal(renders, 1, 'the whole burst collapsed into ONE render');
    shell.requestRender(); // after the frame, the next request schedules anew
    assert.equal(frames.length, 2, 'scheduler re-arms after each frame');
  } finally {
    delete globalThis.window.requestAnimationFrame;
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('RENDER COALESCING: a lost rAF cannot permanently latch the chrome scheduler', async () => {
  const { shell } = await makeShell({ storage: makeStorage() });
  const frames = [];
  globalThis.window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try {
    let renders = 0;
    const original = shell.render.bind(shell);
    shell.render = (...args) => { renders += 1; return original(...args); };

    shell.requestRender();
    assert.equal(shell._renderFramePending, true);
    assert.equal(frames.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(renders, 1, 'deadline renders even though the browser never delivered its frame');
    assert.equal(shell._renderFramePending, false, 'future native navigation updates are no longer suppressed');

    frames[0]();
    assert.equal(renders, 1, 'a late stale frame cannot render twice');
    shell.requestRender();
    assert.equal(frames.length, 2, 'scheduler re-arms after deadline recovery');
  } finally {
    delete globalThis.window.requestAnimationFrame;
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('ELECTRON GUARDS (source pin): crashed or genuinely stuck shell auto-recovers safely', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /contents\.on\('render-process-gone'/, 'renderer-crash handler registered');
  assert.match(src, /contents\.on\('unresponsive'/, 'unresponsive handler registered');
  assert.match(src, /crashReloads > 5/, 'crash auto-reload is rate-limited');
  assert.match(src, /recoveryReloads > 3/, 'unresponsive recovery is independently rate-limited');
  assert.match(src, /unresponsiveTimer = setTimeout[\s\S]{0,900}win\.webContents\.reload\(\)/, 'a shell that stays stuck past its grace period reloads');
  assert.match(src, /installShellFreezeRecovery\(win, 'profile shell'\)/, 'profile shells get the same recovery guard');
  assert.match(src, /installShellFreezeRecovery\(win, 'main shell'\)/, 'the main shell gets the recovery guard');
  assert.match(src, /backgroundThrottling:\s*false/, 'shell renderers are not timer/rAF-throttled behind native views');
  assert.match(src, /process\.on\('uncaughtException'/, 'main-process exception handler stays');
});

test('CSS PERF (source pin): the full-viewport modal backdrop carries NO backdrop blur', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const block = /\.fb-modal-backdrop\s*\{/.exec(css);
  assert.ok(block, 'modal backdrop rule exists');
  const body = css.slice(block.index, css.indexOf('}', block.index))
    .replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments first
  assert.equal(/backdrop-filter/.test(body), false, 'no blur over the whole live viewport');
});

test('AI + suggestions are ON by default for production (nothing dormant)', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const svc = rf(new URL('../packages/shared-ui/src/services/aiService.js', import.meta.url), 'utf8');
  assert.match(svc, /enabled:\s*true/, 'AI enabled by default');
  assert.match(svc, /suggestInOmnibox:\s*true/, 'omnibox AI suggestions on by default');
});

test('PHONE-APPROVAL POLL HARDENING (source pin): error-guarded ticks + hard failsafe + unref - no leaked intervals', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const start = src.indexOf('phoneApprovalStatus');
  assert.ok(start > 0, 'phone approval poll exists');
  const block = src.slice(start - 1200, start + 900);
  assert.match(block, /catch \{\s*\n\s*finish\(false, 'The phone approval connection dropped - try again\.'\)/, 'a failing status call ends the wait cleanly');
  assert.match(block, /150000/, 'hard 2.5-minute failsafe stops the poll');
  assert.match(block, /typeof timer\.unref === 'function'/, 'timer unref\'d so it can never hold a process');
});

test('PWA PROMPT CAPTURE (source pin): the beforeinstallprompt listener installs exactly once', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const start = src.indexOf('_capturePwaInstallPrompt() {');
  const block = src.slice(start, src.indexOf('}', src.indexOf('}', start + 10) + 1) + 60);
  assert.match(block, /_pwaPromptCaptured\)/, 'double-install guard present');
});
