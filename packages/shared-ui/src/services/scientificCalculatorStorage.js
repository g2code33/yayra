export const SCIENTIFIC_CALCULATOR_SCHEMA = 2;
export const SCIENTIFIC_CALCULATOR_KEY = 'scientific-calculator';
export const SCIENTIFIC_CALCULATOR_HISTORY_LIMIT = 500;
const MAX_IMPORT_CHARS = 5 * 1024 * 1024;

const now = () => Date.now();
const text = (value, limit = 2000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export function defaultScientificCalculatorData() {
  return {
    schemaVersion: SCIENTIFIC_CALCULATOR_SCHEMA,
    settings: { angleMode: 'DEG', precision: 12, notation: 'auto', fixedDigits: 2, calculationMode: 'COMP', fractionDisplay: false, defaultMode: 'calculator', historyLimit: SCIENTIFIC_CALCULATOR_HISTORY_LIMIT },
    graphFunctions: [
      { id: 'graph-sin', expression: 'sin(x)', color: '#2563eb', visible: true },
      { id: 'graph-parabola', expression: 'x^2/4', color: '#dc2626', visible: true }
    ],
    graphRange: { xMin: -10, xMax: 10, yMin: -5, yMax: 5 },
    surfaceExpression: 'sin(x)*cos(y)',
    customFormulas: [],
    history: [],
    saved: [],
    favorites: [],
    variables: {},
    memory: null,
    activeNotebookId: 'notebook-general',
    notebooks: [{ id: 'notebook-general', name: 'General', notes: '', calculations: [], updatedAt: now() }]
  };
}

function sanitizeEntry(entry, kind = 'history') {
  const source = object(entry);
  const value = Number(source.result ?? source.value);
  const result = {
    id: /^[A-Za-z0-9_-]{1,100}$/.test(String(source.id || '')) ? String(source.id) : id(kind),
    expression: text(source.expression, 2000),
    result: Number.isFinite(value) ? value : null,
    formatted: text(source.formatted || (Number.isFinite(value) ? String(value) : ''), 100),
    mode: ['calculator', 'pharmacy', 'chemistry', 'units', 'solve', 'graph'].includes(source.mode) ? source.mode : 'calculator',
    angleMode: source.angleMode === 'RAD' ? 'RAD' : 'DEG',
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now(),
    favorite: Boolean(source.favorite),
    notebookId: text(source.notebookId || 'notebook-general', 100),
    note: text(source.note || '', 2000),
    ...(source.unit ? { unit: text(source.unit, 40) } : {}),
    ...(source.formulaId ? { formulaId: text(source.formulaId, 100) } : {}),
    ...(Array.isArray(source.steps) ? { steps: source.steps.slice(0, 40).map((step) => text(step, 500)) } : {})
  };
  if (!result.expression && kind !== 'notebook-calculation') return null;
  return result;
}

function sanitizeGraphFunction(input, index = 0) {
  const source = object(input);
  const palette = ['#2563eb', '#dc2626', '#059669', '#9333ea', '#ea580c', '#0891b2'];
  const color = /^#[0-9a-f]{6}$/i.test(String(source.color || '')) ? String(source.color) : palette[index % palette.length];
  return { id: /^[A-Za-z0-9_-]{1,100}$/.test(String(source.id || '')) ? String(source.id) : id('graph'), expression: text(source.expression || '', 180).trim(), color, visible: source.visible !== false };
}

function sanitizeCustomFormula(input) {
  const source = object(input);
  return {
    id: /^[A-Za-z0-9_-]{1,100}$/.test(String(source.id || '')) ? String(source.id) : id('formula'),
    name: text(source.name || 'Custom formula', 80).trim() || 'Custom formula',
    expression: text(source.expression || '', 300).trim(),
    variables: text(source.variables || '', 500),
    assumptions: text(source.assumptions || '', 1000),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now()
  };
}

function sanitizeNotebook(input) {
  const source = object(input);
  const notebookId = /^[A-Za-z0-9_-]{1,100}$/.test(String(source.id || '')) ? String(source.id) : id('notebook');
  const calculations = Array.isArray(source.calculations)
    ? source.calculations.slice(0, 500).map((entry) => sanitizeEntry(entry, 'notebook-calculation')).filter(Boolean)
    : [];
  return {
    id: notebookId,
    name: text(source.name || 'Notebook', 80) || 'Notebook',
    notes: text(source.notes || '', 10000),
    calculations,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now()
  };
}

export function sanitizeScientificCalculatorData(input) {
  const source = object(input);
  const defaults = defaultScientificCalculatorData();
  const rawSettings = object(source.settings);
  const historyLimit = Number(rawSettings.historyLimit);
  const precision = Number(rawSettings.precision);
  const variables = {};
  for (const [name, value] of Object.entries(object(source.variables)).slice(0, 100)) {
    const key = String(name).toLowerCase();
    const numeric = Number(value?.value ?? value);
    if (/^[a-z_][a-z0-9_]*$/.test(key) && Number.isFinite(numeric) && !['pi', 'e', 'tau', 'phi', 'ans', 'constructor', 'prototype', '__proto__', 'tostring', 'valueof', 'hasownproperty'].includes(key)) {
      variables[key] = { value: numeric, unit: text(value?.unit || '', 40), updatedAt: Number(value?.updatedAt) || now() };
    }
  }
  const notebooks = Array.isArray(source.notebooks) ? source.notebooks.slice(0, 100).map(sanitizeNotebook) : defaults.notebooks;
  const normalizedNotebooks = notebooks.length ? notebooks : defaults.notebooks;
  const validNotebookIds = new Set(normalizedNotebooks.map((notebook) => notebook.id));
  const history = Array.isArray(source.history) ? source.history.slice(0, SCIENTIFIC_CALCULATOR_HISTORY_LIMIT).map((entry) => sanitizeEntry(entry)).filter(Boolean) : [];
  const saved = Array.isArray(source.saved) ? source.saved.slice(0, 500).map((entry) => sanitizeEntry(entry, 'saved')).filter(Boolean) : [];
  const favorites = Array.isArray(source.favorites) ? [...new Set(source.favorites.map((value) => text(value, 100)).filter(Boolean))].slice(0, 500) : [];
  const graphFunctions = Array.isArray(source.graphFunctions) ? source.graphFunctions.slice(0, 6).map(sanitizeGraphFunction).filter((item) => item.expression) : defaults.graphFunctions;
  const rawRange = object(source.graphRange);
  const boundedRange = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(-1e6, Math.min(1e6, Number(value))) : fallback;
  let graphRange = { xMin: boundedRange(rawRange.xMin, -10), xMax: boundedRange.xMax === undefined ? 10 : boundedRange(rawRange.xMax, 10), yMin: boundedRange(rawRange.yMin, -5), yMax: rawRange.yMax === undefined ? 5 : boundedRange(rawRange.yMax, 5) };
  if (graphRange.xMin >= graphRange.xMax || graphRange.yMin >= graphRange.yMax) graphRange = defaults.graphRange;
  const customFormulas = Array.isArray(source.customFormulas) ? source.customFormulas.slice(0, 200).map(sanitizeCustomFormula).filter((formula) => formula.expression) : [];
  for (const item of [...history, ...saved]) if (!validNotebookIds.has(item.notebookId)) item.notebookId = normalizedNotebooks[0].id;
  return {
    schemaVersion: SCIENTIFIC_CALCULATOR_SCHEMA,
    settings: {
      angleMode: ['DEG', 'RAD', 'GRAD'].includes(rawSettings.angleMode) ? rawSettings.angleMode : 'DEG',
      precision: Number.isInteger(precision) ? Math.max(3, Math.min(15, precision)) : defaults.settings.precision,
      notation: ['auto', 'scientific', 'engineering', 'norm1', 'norm2', 'fixed'].includes(rawSettings.notation) ? rawSettings.notation : 'auto',
      fixedDigits: Number.isInteger(Number(rawSettings.fixedDigits)) ? Math.max(0, Math.min(9, Number(rawSettings.fixedDigits))) : defaults.settings.fixedDigits,
      calculationMode: ['COMP', 'CMPLX', 'STAT', 'BASE-N', 'EQN', 'MATRIX', 'TABLE', 'VECTOR'].includes(rawSettings.calculationMode) ? rawSettings.calculationMode : 'COMP',
      fractionDisplay: rawSettings.fractionDisplay === true,
      defaultMode: ['calculator', 'pharmacy', 'chemistry', 'units', 'solve', 'graph', '3d', 'integrals', 'history', 'all-tools'].includes(rawSettings.defaultMode) ? rawSettings.defaultMode : 'calculator',
      historyLimit: Number.isInteger(historyLimit) ? Math.max(50, Math.min(SCIENTIFIC_CALCULATOR_HISTORY_LIMIT, historyLimit)) : defaults.settings.historyLimit
    },
    graphFunctions: graphFunctions.length ? graphFunctions : defaults.graphFunctions,
    graphRange,
    surfaceExpression: text(source.surfaceExpression || defaults.surfaceExpression, 180).trim() || defaults.surfaceExpression,
    customFormulas,
    history,
    saved,
    favorites,
    variables,
    memory: source.memory !== null && source.memory !== undefined && Number.isFinite(Number(source.memory)) ? Number(source.memory) : null,
    activeNotebookId: validNotebookIds.has(String(source.activeNotebookId || '')) ? String(source.activeNotebookId) : normalizedNotebooks[0].id,
    notebooks: normalizedNotebooks
  };
}

export function createScientificCalculatorRepo(storage) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError('Calculator storage requires async get and set methods.');
  }
  const load = async () => {
    const stored = await storage.get(SCIENTIFIC_CALCULATOR_KEY);
    const source = object(stored);
    // Future-version data is left untouched. The caller receives safe defaults
    // but cannot overwrite the newer format without explicitly importing.
    if (Number(source.schemaVersion) > SCIENTIFIC_CALCULATOR_SCHEMA) {
      return { ...defaultScientificCalculatorData(), readOnlyFutureVersion: true };
    }
    const migrated = sanitizeScientificCalculatorData(source);
    if (Number(source.schemaVersion) !== SCIENTIFIC_CALCULATOR_SCHEMA) await storage.set(SCIENTIFIC_CALCULATOR_KEY, migrated);
    return migrated;
  };
  const save = async (data) => {
    const sanitized = sanitizeScientificCalculatorData(data);
    await storage.set(SCIENTIFIC_CALCULATOR_KEY, sanitized);
    return sanitized;
  };
  return {
    load,
    save,
    async addHistory(entry, current = null) {
      const data = sanitizeScientificCalculatorData(current || await load());
      const clean = sanitizeEntry({ ...entry, id: entry?.id || id('calc'), createdAt: entry?.createdAt || now() });
      if (!clean) throw new Error('A calculation expression is required.');
      data.history.unshift(clean);
      data.history = data.history.slice(0, data.settings.historyLimit);
      await save(data);
      return { data, entry: clean };
    },
    async removeHistory(entryId, current = null) {
      const data = sanitizeScientificCalculatorData(current || await load());
      data.history = data.history.filter((entry) => entry.id !== entryId);
      data.saved = data.saved.filter((entry) => entry.id !== entryId);
      data.favorites = data.favorites.filter((value) => value !== entryId);
      return save(data);
    },
    async upsertNotebook(notebook, current = null) {
      const data = sanitizeScientificCalculatorData(current || await load());
      const clean = sanitizeNotebook(notebook);
      const index = data.notebooks.findIndex((item) => item.id === clean.id);
      if (index >= 0) data.notebooks[index] = clean;
      else data.notebooks.push(clean);
      data.notebooks = data.notebooks.slice(0, 100);
      return { data: await save(data), notebook: clean };
    },
    async exportData(current = null) {
      const data = sanitizeScientificCalculatorData(current || await load());
      return JSON.stringify({ app: 'yayra-scientific-calculator', formatVersion: SCIENTIFIC_CALCULATOR_SCHEMA, exportedAt: new Date().toISOString(), data }, null, 2);
    },
    async importData(raw, { merge = true, current = null } = {}) {
      const content = typeof raw === 'string' ? raw : '';
      if (!content || content.length > MAX_IMPORT_CHARS) throw new Error('Backup file is empty or exceeds the 5 MB limit.');
      let backup;
      try { backup = JSON.parse(content); } catch { throw new Error('Backup is not valid JSON.'); }
      if (backup?.app !== 'yayra-scientific-calculator' || !Number.isInteger(backup.formatVersion) || backup.formatVersion > SCIENTIFIC_CALCULATOR_SCHEMA || backup.formatVersion < 1) {
        throw new Error('This is not a supported calculator backup.');
      }
      const imported = sanitizeScientificCalculatorData(backup.data);
      if (!merge) return save(imported);
      const base = sanitizeScientificCalculatorData(current || await load());
      const historyById = new Map([...imported.history, ...base.history].map((entry) => [entry.id, entry]));
      const savedById = new Map([...imported.saved, ...base.saved].map((entry) => [entry.id, entry]));
      const notebookById = new Map([...imported.notebooks, ...base.notebooks].map((entry) => [entry.id, entry]));
      const merged = sanitizeScientificCalculatorData({
        ...base,
        settings: base.settings,
        history: [...historyById.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, base.settings.historyLimit),
        saved: [...savedById.values()],
        favorites: [...new Set([...base.favorites, ...imported.favorites])],
        variables: { ...imported.variables, ...base.variables },
        notebooks: [...notebookById.values()]
      });
      return save(merged);
    }
  };
}
