#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const inputDir = process.argv[2] ? path.resolve(process.argv[2]) : process.env.WORDNET_DB_DIR;
if (!inputDir) {
  console.error('Usage: node scripts/build-wordnet-pack.mjs <extracted-wordnet-package-db-dir>');
  process.exit(2);
}
const sourcePackageIntegrity = 'sha512-VQOEUBHU6drwXGQx37bVaRqi042IZ8NwJiT9qLtM2x1QzqgIJIRoyZa++rWrUvICK+tYz9ttfYFk1c8IiN6DVQ==';
const sourceFiles = [
  ['data.noun', 'noun'],
  ['data.verb', 'verb'],
  ['data.adj', 'adjective'],
  ['data.adv', 'adverb']
];
const posCode = { noun: 'n', verb: 'v', adjective: 'a', adverb: 'r' };
const terms = new Map();
let licenseText = '';

for (const [filename, partOfSpeech] of sourceFiles) {
  const content = await readFile(path.join(inputDir, filename), 'utf8');
  const lines = content.split(/\r?\n/);
  if (filename === 'data.noun') {
    const firstDataRow = lines.findIndex((line) => /^\d{8}\s/.test(line));
    if (firstDataRow < 1) throw new Error('WordNet noun data header was not found.');
    licenseText = lines.slice(0, firstDataRow)
      .map((line) => line.replace(/^\s*\d+\s?/, '').replace(/[\t ]+$/g, ''))
      .join('\n').trim();
    if (!licenseText.includes('WordNet 3.0 Copyright 2006 by Princeton University')
      || !licenseText.includes('Permission to use, copy, modify and distribute')) {
      throw new Error('The source files do not contain the expected Princeton WordNet 3.0 licence notice.');
    }
  }

  for (const line of lines) {
    if (!/^\d{8}\s/.test(line)) continue;
    const separator = line.indexOf('|');
    if (separator < 0) continue;
    const columns = line.slice(0, separator).trim().split(/\s+/);
    if (columns.length < 5) continue;
    const wordCount = Number.parseInt(columns[3], 16);
    if (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > 100) continue;
    const lemmas = [];
    for (let index = 0; index < wordCount; index += 1) {
      const lemma = columns[4 + (index * 2)]?.replace(/_/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (lemma && /[\p{L}\p{N}]/u.test(lemma)) lemmas.push(lemma);
    }
    const definition = line.slice(separator + 1).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!definition || !lemmas.length) continue;
    for (const lemma of lemmas) {
      const normalized = lemma.toLocaleLowerCase('en');
      let entry = terms.get(normalized);
      if (!entry) {
        entry = { term: lemma, definitions: [], seen: new Set() };
        terms.set(normalized, entry);
      }
      const key = `${posCode[partOfSpeech]}\u0000${definition}`;
      if (entry.seen.has(key) || entry.definitions.length >= 30) continue;
      entry.seen.add(key);
      entry.definitions.push({ text: definition, partOfSpeech });
    }
  }
}

if (terms.size < 100_000 || terms.size > 200_000) throw new Error(`Unexpected WordNet term count: ${terms.size}`);
const entries = [...terms.values()]
  .map(({ term, definitions }) => ({ term, definitions }))
  .sort((a, b) => a.term.localeCompare(b.term, 'en'));
const licenseId = 'Princeton University WordNet Release 3.0 License (full text included verbatim in licenseText).';
const metadata = {
  id: 'wordnet-30',
  title: 'General English — Princeton WordNet 3.0',
  category: 'general',
  version: '3.0.0',
  datasetVersion: '3.0',
  packVersion: '1.0.0',
  source: 'Princeton University WordNet 3.0 database files, packaged by wordnet@2.0.0; npm source archive integrity: ' + sourcePackageIntegrity,
  sourceUrl: 'https://registry.npmjs.org/wordnet/-/wordnet-2.0.0.tgz',
  sourceIntegrity: sourcePackageIntegrity,
  license: licenseId,
  licenseText,
  attribution: 'WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved. Definitions and examples originate in the Princeton WordNet 3.0 database.',
  buildDate: '2026-10-25',
  updatedAt: '2026-10-25',
  description: 'An offline general-English lexical database with definitions, parts of speech, examples and related senses from Princeton WordNet 3.0. It is not a medical, legal or financial authority.'
};
const source = JSON.stringify({ format: 'yayra-dictionary-pack', formatVersion: 1, metadata, entries });
const compressed = gzipSync(Buffer.from(source, 'utf8'), { level: 9, mtime: 0 });
const outputDir = path.resolve('public/dictionary-packs');
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'wordnet-3.0-v1.yayrapack');
await writeFile(outputPath, compressed);
await writeFile(path.join(outputDir, 'WORDNET-LICENSE-3.0.txt'), `${licenseText}\n`);
const checksum = createHash('sha512').update(compressed).digest('base64');
console.log(JSON.stringify({ output: outputPath, entries: entries.length, jsonBytes: Buffer.byteLength(source), gzipBytes: compressed.length, integrity: `sha512-${checksum}`, sourceIntegrity: sourcePackageIntegrity }, null, 2));
