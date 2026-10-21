#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PROJECT_NAME'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing Cloudflare environment variables: ${missing.join(', ')}`);
  console.error('Set them in the terminal only. Never commit or paste API tokens into the repository.');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build:web'], { stdio: 'inherit', env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

const deploy = spawnSync(process.execPath, ['scripts/deploy-cloudflare-pages.mjs', 'dist'], {
  stdio: 'inherit',
  env: process.env
});
if (deploy.status !== 0) process.exit(deploy.status ?? 1);

const worker = spawnSync(process.execPath, ['scripts/deploy-cloudflare-worker.mjs'], {
  stdio: 'inherit',
  env: process.env
});
process.exit(worker.status ?? 1);
