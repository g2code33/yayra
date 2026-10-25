const MAX_TERM = 240;
const MAX_DEFINITION = 12_000;
const MAX_EXAMPLES = 40;

export function normalizeDictionaryTerm(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[_\u2010-\u2015]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en')
    .slice(0, MAX_TERM);
}

export function validateDictionaryEntry(input, { packId = '', category = '' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const term = String(input.term || input.word || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
  const normalizedTerm = normalizeDictionaryTerm(term);
  if (!normalizedTerm || !/[\p{L}\p{N}]/u.test(normalizedTerm)) return null;
  const rawDefinitions = Array.isArray(input.definitions) ? input.definitions : (input.definition ? [input.definition] : []);
  const definitions = rawDefinitions.slice(0, 30).map((definition) => {
    const source = typeof definition === 'string' ? { text: definition } : definition;
    const text = String(source?.text || source?.definition || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_DEFINITION);
    if (!text) return null;
    const examples = (Array.isArray(source.examples) ? source.examples : [])
      .slice(0, MAX_EXAMPLES)
      .map((example) => String(example || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1200))
      .filter(Boolean);
    return {
      text,
      partOfSpeech: String(source.partOfSpeech || source.pos || '').replace(/[^\p{L}\s-]/gu, '').trim().slice(0, 60),
      examples,
      synonyms: cleanTerms(source.synonyms),
      antonyms: cleanTerms(source.antonyms),
      etymology: String(source.etymology || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1500)
    };
  }).filter(Boolean);
  if (definitions.length === 0) return null;
  return {
    term,
    normalizedTerm,
    category: ['general', 'medical', 'pharmacy', 'business'].includes(input.category || category) ? (input.category || category) : category || 'general',
    packId: String(input.packId || packId).slice(0, 120),
    pronunciation: String(input.pronunciation || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120),
    phonetic: String(input.phonetic || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120),
    definitions,
    source: String(input.source || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240),
    sourceUrl: safeHttps(input.sourceUrl),
    attribution: String(input.attribution || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1200)
  };
}

function cleanTerms(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '')
    .normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM)).filter(Boolean))].slice(0, 80);
}

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 2000) : '';
  } catch { return ''; }
}

const inflectionCandidates = (term) => {
  const candidates = [];
  if (term.endsWith('ies') && term.length > 4) candidates.push(`${term.slice(0, -3)}y`);
  if (term.endsWith('ves') && term.length > 4) candidates.push(`${term.slice(0, -3)}f`, `${term.slice(0, -3)}fe`);
  if (term.endsWith('es') && term.length > 4) candidates.push(term.slice(0, -2));
  if (term.endsWith('s') && term.length > 3) candidates.push(term.slice(0, -1));
  if (term.endsWith('ied') && term.length > 4) candidates.push(`${term.slice(0, -3)}y`);
  if (term.endsWith('ed') && term.length > 4) {
    const stem = term.slice(0, -2);
    candidates.push(stem, `${stem}e`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1));
  }
  if (term.endsWith('ing') && term.length > 5) {
    const stem = term.slice(0, -3);
    candidates.push(stem, `${stem}e`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1));
  }
  return [...new Set(candidates)];
};

export async function searchDictionary(store, query, { packIds = null, categories = null, limit = 30 } = {}) {
  const term = normalizeDictionaryTerm(query);
  if (!term) return { query: '', results: [], suggestions: [] };
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const activePacks = await store.getActivePacks();
  const allowedPacks = new Set((packIds || activePacks.map((pack) => pack.id)).filter((id) => activePacks.some((pack) => pack.id === id)));
  const allowedCategories = categories ? new Set(categories) : null;
  // Categories are entry-level when supplied by a pack. Filtering only on
  // pack.category hid correctly tagged entries from mixed-category packs and
  // could show entries whose own category did not match the selected filter.
  const eligible = activePacks.filter((pack) => allowedPacks.has(pack.id));
  const resultMap = new Map();
  const queryTerms = [term, ...inflectionCandidates(term)];
  for (let rank = 0; rank < queryTerms.length; rank += 1) {
    const candidate = queryTerms[rank];
    for (const pack of eligible) {
      const entries = await store.findEntries(pack.id, pack.version, candidate, safeLimit);
      for (const entry of entries) {
        const entryCategory = entry.category || pack.category || 'general';
        if (allowedCategories && !allowedCategories.has(entryCategory)) continue;
        const normalized = normalizeDictionaryTerm(entry.normalizedTerm || entry.term);
        const matchRank = normalized === term ? 0 : normalized === candidate ? rank + 1 : 10 + rank;
        const key = `${pack.id}:${pack.version}:${normalized}`;
        const existing = resultMap.get(key);
        if (!existing || matchRank < existing.matchRank) resultMap.set(key, { ...entry, sourcePack: pack, matchRank });
      }
    }
  }
  // Phrase lookup: keep the complete multiword search first, then search its
  // component terms when the full phrase is not present in a source pack.
  if (term.includes(' ') && resultMap.size === 0) {
    for (const token of term.split(' ').filter((part) => part.length > 1).slice(0, 8)) {
      for (const pack of eligible) {
        for (const entry of await store.findEntries(pack.id, pack.version, token, Math.min(6, safeLimit))) {
          const entryCategory = entry.category || pack.category || 'general';
          if (allowedCategories && !allowedCategories.has(entryCategory)) continue;
          const normalized = normalizeDictionaryTerm(entry.normalizedTerm || entry.term);
          const key = `${pack.id}:${pack.version}:${normalized}`;
          if (!resultMap.has(key)) resultMap.set(key, { ...entry, sourcePack: pack, matchRank: 20 });
        }
      }
    }
  }
  const results = [...resultMap.values()].sort((a, b) => a.matchRank - b.matchRank
    || a.sourcePack.title.localeCompare(b.sourcePack.title)
    || a.term.localeCompare(b.term)).slice(0, safeLimit);
  const grouped = groupRelatedDefinitions(results);
  const suggestions = results.length ? [] : await collectSuggestions(store, term, eligible, 8, allowedCategories);
  return { query: String(query).slice(0, MAX_TERM), normalizedQuery: term, results, groups: grouped, suggestions };
}

function groupRelatedDefinitions(results) {
  const groups = new Map();
  for (const result of results) {
    const key = normalizeDictionaryTerm(result.term);
    if (!groups.has(key)) groups.set(key, { term: result.term, entries: [] });
    groups.get(key).entries.push(result);
  }
  return [...groups.values()];
}

async function collectSuggestions(store, term, packs, limit, categories = null) {
  const matches = [];
  const prefix = term.split(' ').at(-1) || term;
  for (const pack of packs) {
    for (const entry of await store.findEntries(pack.id, pack.version, prefix.slice(0, Math.max(2, Math.min(5, prefix.length))), limit)) {
      const category = entry.category || pack.category || 'general';
      if (categories && !categories.has(category)) continue;
      const normalizedTerm = normalizeDictionaryTerm(entry.term);
      if (normalizedTerm !== term && !matches.some((item) => item.normalizedTerm === normalizedTerm)) matches.push({ term: entry.term, normalizedTerm, packId: pack.id, category: pack.category });
    }
  }
  return matches.sort((a, b) => editDistance(term, a.normalizedTerm) - editDistance(term, b.normalizedTerm)).slice(0, limit);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 6) return 100;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return row[b.length];
}

export function compareDictionaryEntries(entries) {
  const selected = Array.isArray(entries) ? entries.filter(Boolean).slice(0, 2) : [];
  return selected.map((entry) => ({
    term: entry.term,
    source: entry.sourcePack?.title || entry.source || 'Local dictionary',
    category: entry.category || entry.sourcePack?.category || 'general',
    definitions: Array.isArray(entry.definitions) ? entry.definitions : []
  }));
}

export function groupDuplicateResults(entries) {
  return groupRelatedDefinitions(entries || []).map((group) => ({
    ...group,
    definitions: group.entries.flatMap((entry) => entry.definitions.map((definition) => ({
      ...definition,
      source: entry.sourcePack?.title || entry.source,
      packId: entry.packId,
      category: entry.category
    })))
  }));
}

export function extractSingleSelectedTerm(text) {
  const clean = String(text || '').normalize('NFKC').trim();
  if (!clean || clean.length > MAX_TERM || /\s/u.test(clean)) return null;
  return /[\p{L}\p{N}]/u.test(clean) ? clean : null;
}
