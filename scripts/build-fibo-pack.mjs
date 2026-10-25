#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { gzipSync } from 'node:zlib';

const inputDir = process.argv[2] ? path.resolve(process.argv[2]) : process.env.FIBO_2026Q2_SOURCE_DIR;
if (!inputDir) {
  console.error('Usage: node scripts/build-fibo-pack.mjs <extracted-fibo-2026Q2-source-dir>');
  process.exit(2);
}

const sourceCommit = 'f59157fe156e3d91b1c045222d0a7dc06b7d78a2';
const sourceArchiveSha256 = '8099df46163681614bf53adb64eaefe729c19a49353c5ee01925c9cef3ca6f13';
const sourceContentSha256 = 'bcb1fdcdc9730ef2f8d5934830b0991c3568a4e2bf1566c6b464f356e79c0496';
const sourceArchiveIntegrity = `sha256-${Buffer.from(sourceArchiveSha256, 'hex').toString('base64')}`;
const sourceUrl = `https://codeload.github.com/edmcouncil/fibo/zip/${sourceCommit}`;
const sourceRoot = path.basename(inputDir);
if (!sourceRoot.endsWith(sourceCommit)) throw new Error(`Expected the pinned FIBO Q2 2026 source directory ending in ${sourceCommit}.`);
const licenseText = await readFile(path.join(inputDir, 'LICENSE'), 'utf8');
const readme = await readFile(path.join(inputDir, 'README.md'), 'utf8');
if (!licenseText.includes('Copyright (c) 2020 Enterprise Data Management Council')
  || !licenseText.includes('THE SOFTWARE IS PROVIDED "AS IS"')
  || !readme.includes('FIBO')) {
  throw new Error('The pinned FIBO source or its MIT notice did not match the reviewed release.');
}

const namespaces = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  owl: 'http://www.w3.org/2002/07/owl#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  xml: 'http://www.w3.org/XML/1998/namespace'
};
const localNames = new Map();
const classRows = [];
const parser = new DOMParser({
  onError: (level, message) => {
    if (level === 'error' || level === 'fatalError') throw new Error(`FIBO RDF parse error: ${message}`);
  }
});
const rdfFiles = (await walkFiles(inputDir))
  .filter((file) => file.endsWith('.rdf'))
  .sort();
if (rdfFiles.length !== 295) throw new Error(`Expected 295 pinned FIBO RDF files, found ${rdfFiles.length}.`);
const sourceFiles = ['LICENSE', 'README.md', ...rdfFiles].sort();
const sourceTreeDigest = createHash('sha256');
for (const relativeFile of sourceFiles) {
  sourceTreeDigest.update(relativeFile).update(String.fromCharCode(0)).update(await readFile(path.join(inputDir, relativeFile))).update(String.fromCharCode(0));
}
if (sourceTreeDigest.digest('hex') !== sourceContentSha256) throw new Error('FIBO input files do not match the pinned Q2 2026 source content digest.');
for (const relativeFile of rdfFiles) {
  const rdfSource = await readFile(path.join(inputDir, relativeFile), 'utf8');
  const document = parser.parseFromString(expandInternalEntities(rdfSource), 'application/xml');
  const root = document.documentElement;
  for (const classNode of Array.from(root.childNodes || []).filter((node) => node.nodeType === 1 && node.namespaceURI === namespaces.owl && node.localName === 'Class')) {
    const about = classNode.getAttributeNS(namespaces.rdf, 'about') || '';
    if (!about) continue;
    const directChildren = Array.from(classNode.childNodes || []).filter((node) => node.nodeType === 1);
    const labels = directChildren.filter((node) => node.namespaceURI === namespaces.rdfs && node.localName === 'label');
    const definitions = directChildren.filter((node) => node.namespaceURI === namespaces.skos && node.localName === 'definition');
    const label = chooseEnglish(labels);
    const definition = chooseEnglish(definitions);
    if (!label || !definition) continue;
    const term = cleanText(label.textContent);
    const text = cleanText(definition.textContent);
    if (!term || !text || !/[\p{L}\p{N}]/u.test(term)) continue;
    const normalized = term.normalize('NFKC').toLocaleLowerCase('en');
    if (!localNames.has(normalized)) localNames.set(normalized, { term, definitions: [], seen: new Set() });
    const entry = localNames.get(normalized);
    if (!entry.seen.has(text) && entry.definitions.length < 30) {
      entry.seen.add(text);
      entry.definitions.push({ text, partOfSpeech: 'term' });
    }
    classRows.push(about);
  }
}
const entries = [...localNames.values()]
  .filter((entry) => entry.definitions.length)
  .map(({ term, definitions }) => ({ term, definitions }))
  .sort((a, b) => {
    const left = a.term.toLocaleLowerCase('en');
    const right = b.term.toLocaleLowerCase('en');
    return left < right ? -1 : left > right ? 1 : a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });
if (entries.length < 2_000 || entries.length > 200_000) throw new Error(`Unexpected FIBO indexed term count: ${entries.length}`);
if (new Set(classRows).size !== 2_671) throw new Error(`Expected 2,671 uniquely defined FIBO classes, found ${new Set(classRows).size}.`);

const metadata = {
  id: 'fibo-business-2026q2',
  title: 'Finance & Business — FIBO Q2 2026',
  category: 'business',
  version: '2026.2.0',
  datasetVersion: 'Q2 2026',
  packVersion: '1.0.0',
  source: `Financial Industry Business Ontology (FIBO) Q2 2026 release at the pinned EDM Council commit ${sourceCommit}; only locally defined OWL class labels and definitions are indexed.`,
  sourceUrl,
  sourceIntegrity: sourceArchiveIntegrity,
  license: 'MIT License; Copyright (c) 2020 Enterprise Data Management Council.',
  licenseText: licenseText.trim(),
  attribution: 'Financial Industry Business Ontology (FIBO), Enterprise Data Management Council (EDM Council), Q2 2026. FIBO is an EDM Council trademark; this independent dictionary pack does not imply endorsement.',
  buildDate: '2026-10-25',
  updatedAt: '2026-10-25',
  description: `${entries.length.toLocaleString('en')} finance and business ontology terms with definitions, extracted from locally defined FIBO classes. This is a terminology pack, not current market data or legal advice; no external imported vocabularies are bundled.`
};
const source = JSON.stringify({ format: 'yayra-dictionary-pack', formatVersion: 1, metadata, entries });
const sourceBytes = Buffer.from(source, 'utf8');
const compressed = gzipSync(sourceBytes, { level: 9, mtime: 0 });
const outputDir = path.resolve('public/dictionary-packs');
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'fibo-business-2026q2-v1.yayrapack');
await writeFile(outputPath, compressed);
const licenseCopy = [
  'Financial Industry Business Ontology (FIBO) Q2 2026 MIT license notice',
  '',
  `Pinned source commit: ${sourceCommit}`,
  `Source archive SHA-256: ${sourceArchiveSha256}`,
  '',
  licenseText.trim(),
  '',
  'FIBO is a trademark of the Enterprise Data Management Council. This pack is an independent terminology extraction and is not endorsed by EDM Council.'
].join('\n');
await writeFile(path.join(outputDir, 'FIBO-LICENSE-Q2-2026.txt'), `${licenseCopy}\n`);
const checksum = createHash('sha512').update(compressed).digest('base64');
console.log(JSON.stringify({
  output: outputPath,
  sourceCommit,
  sourceArchiveIntegrity,
  rdfFiles: rdfFiles.length,
  uniqueDefinedClasses: new Set(classRows).size,
  terms: entries.length,
  jsonBytes: sourceBytes.length,
  gzipBytes: compressed.length,
  integrity: `sha512-${checksum}`
}, null, 2));

function expandInternalEntities(source) {
  const doctype = source.match(/<!DOCTYPE[^\[]*\[[\s\S]*?\]\s*>/i);
  if (!doctype) return source;
  let content = doctype[0];
  const declarations = [...content.matchAll(/<!ENTITY\s+([A-Za-z_][\w.:-]*)\s+["']([^"']*)["']\s*>/g)]
    .map((match) => [match[1], match[2]]);
  let expanded = source.slice(0, doctype.index) + source.slice(doctype.index + doctype[0].length);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, value] of declarations) expanded = expanded.replaceAll(`&${name};`, value);
  }
  return expanded;
}

function chooseEnglish(nodes) {
  return nodes.find((node) => ['en', 'en-us', 'en-gb'].includes(String(node.getAttributeNS(namespaces.xml, 'lang') || '').toLowerCase()))
    || nodes.find((node) => !node.getAttributeNS(namespaces.xml, 'lang'))
    || nodes[0]
    || null;
}

function cleanText(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12_000);
}

async function walkFiles(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await walkFiles(path.join(directory, item.name), relative));
    else if (item.isFile()) result.push(relative);
  }
  return result;
}
