#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';

const inputDir = process.argv[2] ? path.resolve(process.argv[2]) : process.env.OEWN_2025_SOURCE_DIR;
if (!inputDir) {
  console.error('Usage: node scripts/build-oewn-pack.mjs <extracted-english-wordnet-2025-source-dir>');
  process.exit(2);
}

const sourceCommit = 'dc343f2683279ecbb13fab4e2fd778d7b162d287';
const sourceArchiveIntegrity = 'sha256-xQaENM9YXo14mcoJCNssAMtR7fAV6dCEZITQ9WgEldI=';
const sourceContentSha256 = '3da494282ea713ae27f29bcb1dde3ede9e2359aadfd13122009fb98776a776d4';
const sourceUrl = `https://codeload.github.com/globalwordnet/english-wordnet/zip/${sourceCommit}`;
const sourceRoot = path.basename(inputDir);
if (!sourceRoot.endsWith(sourceCommit)) throw new Error(`Expected the pinned OEWN source directory ending in ${sourceCommit}.`);
const sourceReadme = await readFile(path.join(inputDir, 'README.md'), 'utf8');
const licenseMarkdown = await readFile(path.join(inputDir, 'LICENSE.md'), 'utf8');
const wordnetNotice = await readFile(path.join(inputDir, 'WNDB_License.txt'), 'utf8');
if (!sourceReadme.includes('2025 Edition') || !sourceReadme.includes('107,519')
  || !licenseMarkdown.includes('derived from Princeton WordNet under the WordNet License')
  || !licenseMarkdown.includes('Creative Commons Attribution 4.0')
  || !wordnetNotice.includes('WordNet 3.1 Copyright 2011 by Princeton University')) {
  throw new Error('The source edition or its two required license notices did not match the reviewed OEWN 2025 source.');
}

const yamlRoot = path.join(inputDir, 'src', 'yaml');
const sourceFiles = [
  'README.md', 'LICENSE.md', 'WNDB_License.txt',
  ...(await walkFiles(yamlRoot)).map((file) => `src/yaml/${file}`)
].sort();
const sourceTreeDigest = createHash('sha256');
for (const relativeFile of sourceFiles) {
  sourceTreeDigest.update(relativeFile).update('\0').update(await readFile(path.join(inputDir, relativeFile))).update('\0');
}
if (sourceTreeDigest.digest('hex') !== sourceContentSha256) throw new Error('OEWN source files do not match the pinned 2025 content digest.');
const yamlFiles = sourceFiles
  .filter((file) => file.startsWith('src/yaml/'))
  .map((file) => file.slice('src/yaml/'.length))
  .filter((file) => file.endsWith('.yaml') && !/(^|\/)entries-[^/]+\.yaml$/.test(file) && !/(^|\/)frames\.yaml$/.test(file))
  .sort();
const partsOfSpeech = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };
const terms = new Map();
let synsetCount = 0;
let exampleCount = 0;

for (const relativeFile of yamlFiles) {
  const synsets = parse(await readFile(path.join(yamlRoot, relativeFile), 'utf8')) || {};
  for (const synset of Object.values(synsets)) {
    if (!synset || !Array.isArray(synset.members) || !Array.isArray(synset.definition)) continue;
    const partOfSpeech = partsOfSpeech[synset.partOfSpeech];
    if (!partOfSpeech) continue;
    synsetCount += 1;
    const examples = (Array.isArray(synset.example) ? synset.example : [])
      .map((example) => (typeof example === 'string' ? example : example?.text))
      .filter((example) => typeof example === 'string' && example.trim())
      .map((example) => example.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
      .slice(0, 40);
    exampleCount += examples.length;
    for (const member of synset.members) {
      const term = String(member).replace(/_/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (!term || !/[\p{L}\p{N}]/u.test(term)) continue;
      const normalized = term.toLocaleLowerCase('en');
      let entry = terms.get(normalized);
      if (!entry) {
        entry = { term, definitions: [], seen: new Set() };
        terms.set(normalized, entry);
      }
      for (const rawDefinition of synset.definition) {
        const text = String(rawDefinition || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || entry.definitions.length >= 30) continue;
        const key = `${partOfSpeech}\u0000${text}`;
        if (entry.seen.has(key)) continue;
        entry.seen.add(key);
        entry.definitions.push({ text, partOfSpeech, ...(examples.length ? { examples } : {}) });
      }
    }
  }
}

if (synsetCount !== 107_519) throw new Error(`Expected 107,519 OEWN 2025 core synsets, found ${synsetCount}.`);
if (terms.size < 100_000 || terms.size > 200_000) throw new Error(`Unexpected OEWN indexed term count: ${terms.size}`);
const entries = [...terms.values()]
  .filter(({ definitions }) => definitions.length > 0)
  .map(({ term, definitions }) => ({ term, definitions }))
  .sort((a, b) => {
    const left = a.term.toLocaleLowerCase('en');
    const right = b.term.toLocaleLowerCase('en');
    return left < right ? -1 : left > right ? 1 : a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });

const licenseText = `${licenseMarkdown.trim()}\n\n---\n\nOpen English WordNet WNDB distribution notice (included with the source release):\n\n${wordnetNotice.trim()}`;
const metadata = {
  id: 'oewn-2025',
  title: 'General English — Open English WordNet 2025',
  category: 'general',
  version: '2025.0.0',
  datasetVersion: '2025',
  packVersion: '1.0.0',
  source: `Open English WordNet 2025 core YAML source at commit ${sourceCommit}; source archive SHA-256 is recorded below.`,
  sourceUrl,
  sourceIntegrity: sourceArchiveIntegrity,
  license: 'Open English WordNet: CC BY 4.0; derived Princeton WordNet 3.1 data: retain the included WordNet license notice.',
  licenseText,
  attribution: 'Open English WordNet Team, Open English WordNet 2025; underlying WordNet 3.1 Copyright 2011 by Princeton University. All required notices are included in this pack.',
  buildDate: '2026-10-25',
  updatedAt: '2026-10-25',
  description: `Community-maintained English word senses with ${synsetCount.toLocaleString('en')} synsets, indexed here as ${entries.length.toLocaleString('en')} terms. This 2025 core edition excludes proper names; lookups work offline after download.`
};
const source = JSON.stringify({ format: 'yayra-dictionary-pack', formatVersion: 1, metadata, entries });
const sourceBytes = Buffer.from(source, 'utf8');
const compressed = gzipSync(sourceBytes, { level: 9, mtime: 0 });
const outputDir = path.resolve('public/dictionary-packs');
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'oewn-2025-v1.yayrapack');
await writeFile(outputPath, compressed);
// Trim only end-of-line formatting spaces in the public copy; the pack retains
// the source notices as imported, while this avoids Markdown hard-break noise.
const publicLicenseText = licenseText.replace(/[ \t]+$/gm, '');
await writeFile(path.join(outputDir, 'OPEN-ENGLISH-WORDNET-LICENSE-2025.md'), `${publicLicenseText}\n`);
const checksum = createHash('sha512').update(compressed).digest('base64');
console.log(JSON.stringify({
  output: outputPath,
  sourceCommit,
  sourceArchiveIntegrity,
  synsets: synsetCount,
  terms: entries.length,
  examples: exampleCount,
  licenseTextCharacters: licenseText.length,
  jsonBytes: sourceBytes.length,
  gzipBytes: compressed.length,
  integrity: `sha512-${checksum}`
}, null, 2));

async function walkFiles(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await walkFiles(path.join(directory, item.name), relative));
    else if (item.isFile()) result.push(relative);
  }
  return result;
}
