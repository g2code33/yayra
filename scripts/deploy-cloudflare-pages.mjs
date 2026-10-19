#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCommandWithRetry } from './lib/retry-command.mjs';

const root = process.cwd();
const directory = path.resolve(root, process.argv[2] || 'dist');
const project = process.env.CLOUDFLARE_PROJECT_NAME;
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!project || !token || !accountId) {
  console.error('CLOUDFLARE_PROJECT_NAME, CLOUDFLARE_API_TOKEN, and CLOUDFLARE_ACCOUNT_ID are required.');
  process.exit(1);
}
if (!existsSync(directory)) {
  console.error(`Cloudflare Pages directory does not exist: ${directory}`);
  process.exit(1);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = await runCommandWithRetry(npx, [
  '--yes', 'wrangler@4', 'pages', 'deploy', directory,
  '--project-name', project,
  '--branch', process.env.CLOUDFLARE_PAGES_BRANCH || 'main',
  '--commit-dirty=true'
], {
  cwd: root,
  env: process.env,
  label: 'Cloudflare Pages deployment',
  maxAttempts: Number(process.env.CLOUDFLARE_DEPLOY_ATTEMPTS || 5)
});

if (result.status !== 0) {
  console.error(`Cloudflare Pages deployment failed after ${result.attempts} attempt(s).`);
  process.exit(result.status || 1);
}
console.log(`Cloudflare Pages deployment completed after ${result.attempts} attempt(s).`);
