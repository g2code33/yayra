#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const projectName = process.env.CLOUDFLARE_PROJECT_NAME || 'yayra';
if (!apiToken) {
  console.error('CLOUDFLARE_API_TOKEN is required. Set it in this terminal only; do not commit or paste it into chat.');
  process.exit(1);
}

const configuredAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
if (configuredAccountId && !/^[a-f0-9]{32}$/i.test(configuredAccountId)) {
  console.warn('Ignoring the placeholder/invalid CLOUDFLARE_ACCOUNT_ID and discovering the account from Cloudflare.');
}
const accountId = /^[a-f0-9]{32}$/i.test(configuredAccountId)
  ? configuredAccountId
  : await discoverAccountId();
if (!accountId) process.exit(1);
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
process.env.CLOUDFLARE_PROJECT_NAME = projectName;

const projects = await cloudflare(`/accounts/${accountId}/pages/projects`);
const exists = projects.result.some((project) => project.name === projectName);
if (!exists) {
  console.log(`Creating Cloudflare Pages project ${projectName} with production branch main...`);
  await cloudflare(`/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: projectName, production_branch: 'main' })
  });
} else {
  console.log(`Cloudflare Pages project ${projectName} already exists; keeping it.`);
}

run('npm', ['run', 'build:web']);
run(process.execPath, ['scripts/deploy-cloudflare-pages.mjs', 'dist']);
run(process.execPath, ['scripts/deploy-cloudflare-worker.mjs']);

const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { capture: true }).trim();
run('gh', ['auth', 'status']);
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PROJECT_NAME']) {
  setGitHubSecret(repo, key, process.env[key]);
}
console.log(`Cloudflare Pages setup complete: https://${projectName}.pages.dev`);
console.log(`GitHub Actions secrets configured for ${repo}.`);

async function discoverAccountId() {
  const accounts = await cloudflare('/accounts?per_page=50');
  if (accounts.result.length === 1) {
    console.log(`Using the only Cloudflare account: ${accounts.result[0].name} (${accounts.result[0].id})`);
    return accounts.result[0].id;
  }
  console.error('CLOUDFLARE_ACCOUNT_ID is not set and the API returned multiple or no accounts.');
  for (const account of accounts.result) console.error(` - ${account.name}: ${account.id}`);
  console.error('Export CLOUDFLARE_ACCOUNT_ID in this terminal and run the setup command again.');
  return null;
}

async function cloudflare(endpoint, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: options.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const errors = (payload.errors || []).map((error) => error.message || JSON.stringify(error)).join('; ');
    throw new Error(`Cloudflare API ${options.method || 'GET'} ${endpoint} failed (${response.status}): ${errors || response.statusText}`);
  }
  return payload;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    input: options.input,
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return options.capture ? result.stdout : '';
}

function setGitHubSecret(repo, name, value) {
  if (!value) throw new Error(`Cannot set empty GitHub secret ${name}`);
  console.log(`Setting GitHub Actions secret ${name}...`);
  run('gh', ['secret', 'set', name, '--repo', repo], { input: `${value}\n` });
}
