import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildGoogleSearchThinkingWatchdogScript } from '../electron/webviewBridge.cjs';

function runWatchdog({
  host = 'www.google.com',
  pathname = '/search',
  search = '?q=watchdog-test',
  text = 'Search results\nThinking\n',
  visibilityState = 'visible',
  timeoutMs = 25,
  pollIntervalMs = 5,
  reloadCooldownMs = 250,
  storage = new Map()
} = {}) {
  const intervals = [];
  let reloadCount = 0;
  const location = {
    hostname: host,
    pathname,
    search,
    href: `https://${host}${pathname}${search}`,
    reload: () => { reloadCount += 1; }
  };
  const sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  const windowObj = {
    location,
    sessionStorage,
    setInterval: (fn, delay) => {
      const timer = setInterval(fn, delay);
      intervals.push(timer);
      return timer;
    }
  };
  const documentObj = { body: { innerText: text }, visibilityState };
  const sandbox = { window: windowObj, document: documentObj, Date, Math };
  vm.createContext(sandbox);
  vm.runInContext(buildGoogleSearchThinkingWatchdogScript({ timeoutMs, pollIntervalMs, reloadCooldownMs }), sandbox);
  return {
    location,
    document: documentObj,
    intervals,
    reloadCount: () => reloadCount,
    dispose: () => intervals.forEach(clearInterval)
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Google AI "Thinking" that persists triggers one normal reload, then the per-query cooldown prevents a loop', async () => {
  const harness = runWatchdog();
  try {
    await wait(70);
    assert.equal(harness.reloadCount(), 1, 'continuous standalone Thinking status triggers a reload');
    await wait(80);
    assert.equal(harness.reloadCount(), 1, 'the same query is not continuously reloaded');
  } finally {
    harness.dispose();
  }
});

test('watchdog ignores ordinary text, non-search pages, unrelated hosts, and background tabs', async (t) => {
  const cases = [
    { name: 'the word Thinking inside a sentence', text: 'Thinking about this result is useful.' },
    { name: 'a Google page outside Search results', pathname: '/' },
    { name: 'a lookalike non-Google host', host: 'google.com.attacker.example' },
    { name: 'a hidden tab', visibilityState: 'hidden' }
  ];
  for (const options of cases) {
    await t.test(options.name, async () => {
      const harness = runWatchdog(options);
      try {
        await wait(70);
        assert.equal(harness.reloadCount(), 0);
      } finally {
        harness.dispose();
      }
    });
  }
});

test('watchdog opts out if sessionStorage is unavailable, avoiding an unbounded reload loop', async () => {
  const throwingStorage = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
    removeItem() { throw new Error('storage blocked'); }
  };
  const harness = runWatchdog({ storage: throwingStorage });
  try {
    await wait(70);
    assert.equal(harness.reloadCount(), 0);
    assert.equal(harness.intervals.length, 0, 'no polling timer is left behind when safely opting out');
  } finally {
    harness.dispose();
  }
});
