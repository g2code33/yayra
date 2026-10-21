import { spawn } from 'node:child_process';

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const MAX_CAPTURE_BYTES = 512 * 1024;

export function cloudflareFailureIsRetryable(output = '') {
  const text = String(output).replace(ANSI_ESCAPE, ' ');
  return /\bcode:\s*971\b|retry-after|rate[ -]?limit|throttl|too many requests|\b429\b|\b(?:500|502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error/i.test(text);
}

export function retryDelayMs(output = '', attempt = 1, { baseDelayMs = 12_000, maxDelayMs = 60_000 } = {}) {
  const text = String(output).replace(ANSI_ESCAPE, ' ');
  const explicit = text.match(/(?:retry-after[^\d]{0,40}|wait\s+)(\d+)\s*(?:second|sec|s\b)/i);
  const requestedMs = explicit ? Number(explicit[1]) * 1000 : 0;
  const backoffMs = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  // Cloudflare's header is a minimum. A two-second cushion prevents the next
  // check-missing request from arriving on the same rate-limit boundary.
  return Math.min(maxDelayMs, Math.max(baseDelayMs, backoffMs, requestedMs ? requestedMs + 2_000 : 0));
}

export async function runCommandWithRetry(command, args = [], {
  label = command,
  cwd = process.cwd(),
  env = process.env,
  maxAttempts = 5,
  baseDelayMs = 12_000,
  maxDelayMs = 60_000,
  retryWhen = cloudflareFailureIsRetryable,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const attemptLimit = Math.max(1, Math.min(10, Math.floor(Number(maxAttempts) || 1)));
  let final = { status: 1, output: '', error: null };
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    final = await runOnce(command, args, { cwd, env });
    if (final.status === 0) return { ...final, attempts: attempt };

    const retryable = attempt < attemptLimit && retryWhen(final.output, final);
    if (!retryable) return { ...final, attempts: attempt };

    const waitMs = retryDelayMs(final.output, attempt, { baseDelayMs, maxDelayMs });
    const seconds = Math.ceil(waitMs / 1000);
    const message = `${label} was throttled or hit a transient Cloudflare error; retrying in ${seconds}s (${attempt + 1}/${attemptLimit}).`;
    if (process.env.GITHUB_ACTIONS === 'true') console.warn(`::warning title=Cloudflare deployment retry::${message}`);
    else console.warn(message);
    await sleep(waitMs);
  }
  return { ...final, attempts: attemptLimit };
}

function runOnce(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true
    });
    const capture = (chunk, target) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      target.write(value);
      if (output.length < MAX_CAPTURE_BYTES) output += value.toString('utf8').slice(0, MAX_CAPTURE_BYTES - output.length);
    };
    child.stdout?.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr?.on('data', (chunk) => capture(chunk, process.stderr));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      const message = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
      output += `\n${message}`;
      resolve({ status: 1, output, error });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ status: Number.isInteger(code) ? code : 1, signal, output, error: null });
    });
  });
}
