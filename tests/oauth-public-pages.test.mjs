import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = async (name) => readFile(new URL(`../public/${name}/index.html`, import.meta.url), 'utf8');

test('OAuth public information pages are present, linked, and disclose Google data use', async () => {
  const [about, privacy, terms] = await Promise.all([
    page('about'), page('privacy'), page('terms')
  ]);

  assert.match(about, /href="\/privacy\/"/);
  assert.match(about, /href="\/terms\/"/);
  assert.match(about, /Google account integrations/i);
  assert.match(privacy, /Google API Services User Data Policy/);
  assert.match(privacy, /gmail\.readonly/i);
  assert.match(privacy, /30 days/);
  assert.match(privacy, /support@yayra\.app/);
  assert.match(privacy, /NVIDIA/);
  assert.match(privacy, /not automatically send Google API responses to the AI feature/i);
  assert.match(terms, /href="\/privacy\/"/);
  assert.match(terms, /support@yayra\.app/);
  assert.match(terms, /read-only/);
});

test('production web OAuth origin is explicitly allowed, never wildcarded', async () => {
  const workerConfig = await readFile(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  const signInGuide = await readFile(new URL('../docs/GOOGLE_SIGNIN.md', import.meta.url), 'utf8');

  assert.match(workerConfig, /GOOGLE_WEB_ALLOWED_ORIGINS\s*=\s*"https:\/\/yayra\.app,/);
  assert.doesNotMatch(workerConfig, /GOOGLE_WEB_ALLOWED_ORIGINS\s*=\s*"\*"/);
  assert.match(signInGuide, /https:\/\/yayra\.app\/auth\/callback/);
  assert.match(signInGuide, /https:\/\/yayra\.app\/privacy\//);
  assert.match(signInGuide, /https:\/\/yayra\.app\/terms\//);
});
