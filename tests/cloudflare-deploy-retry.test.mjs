import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cloudflareFailureIsRetryable,
  retryDelayMs,
  runCommandWithRetry
} from '../scripts/lib/retry-command.mjs';

test('Cloudflare code 971 and Retry-After responses are classified as transient', () => {
  const exactFailure = `ERROR A request to the Cloudflare API (/pages/assets/check-missing) failed.
Please wait and consider throttling your request speed [code: 971]
The API responded with a "Retry-After" header indicating you should wait 10 second(s) before retrying.`;
  assert.equal(cloudflareFailureIsRetryable(exactFailure), true);
  assert.equal(retryDelayMs(exactFailure, 1), 12_000, 'the Retry-After minimum receives a safety cushion');
  assert.equal(retryDelayMs('rate limit', 2), 24_000, 'subsequent retries back off exponentially');
  assert.equal(cloudflareFailureIsRetryable('Authentication error [code: 10000]'), false,
    'permanent credential failures are not retried');
});

test('retry runner recovers from throttling but immediately returns deterministic failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yayra-cloudflare-retry-'));
  const counter = join(directory, 'counter');
  const transientProgram = `
const fs = require('node:fs');
const file = process.argv[1];
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(count));
if (count < 3) { console.error('Please wait 10 seconds [code: 971] Retry-After'); process.exit(1); }
console.log('deployment complete');`;
  try {
    const waits = [];
    const recovered = await runCommandWithRetry(process.execPath, ['-e', transientProgram, counter], {
      label: 'test deployment',
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleep: async (ms) => { waits.push(ms); }
    });
    assert.equal(recovered.status, 0);
    assert.equal(recovered.attempts, 3);
    assert.deepEqual(waits, [2, 2]);

    const permanent = await runCommandWithRetry(process.execPath, ['-e', "console.error('bad credentials');process.exit(7)"], {
      maxAttempts: 5,
      sleep: async () => assert.fail('a permanent failure must not sleep/retry')
    });
    assert.equal(permanent.status, 7);
    assert.equal(permanent.attempts, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release workflow performs one final deployment and routes Wrangler through the retry wrapper', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const pagesScript = readFileSync(new URL('../scripts/deploy-cloudflare-pages.mjs', import.meta.url), 'utf8');
  const workerScript = readFileSync(new URL('../scripts/deploy-cloudflare-worker.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(workflow, /npx --yes wrangler@4 pages deploy/);
  assert.equal((workflow.match(/node scripts\/deploy-cloudflare-pages\.mjs dist/g) || []).length, 2,
    'preview and final jobs share the same retrying entry point');
  assert.match(workflow, /Cloudflare deployment deferred until the final release manifest is ready/,
    'publishing runs avoid the duplicate pre-manifest deployment that triggered code 971');
  assert.match(pagesScript, /runCommandWithRetry/);
  assert.match(pagesScript, /maxAttempts: Number\(process\.env\.CLOUDFLARE_DEPLOY_ATTEMPTS \|\| 5\)/);
  assert.match(workerScript, /runCommandWithRetry/);
});
