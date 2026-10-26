import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDilution,
  computeInfusionRate,
  computeMolarity,
  computePH,
  computeWeightBasedAmount,
  calculateMolarMass,
  convertUnit,
  evaluateExpression,
  findFunctionExtrema,
  findFunctionIntersections,
  findFunctionRoots,
  formatFraction,
  formatNumber,
  integrateFunction,
  sampleFunction,
  sampleSurface,
  solveLinearEquation,
  solveQuadratic,
  validateCalculatorVariableName
} from '../packages/shared-ui/src/services/scientificCalculator.js';
import {
  createScientificCalculatorRepo,
  defaultScientificCalculatorData,
  SCIENTIFIC_CALCULATOR_KEY,
  SCIENTIFIC_CALCULATOR_SCHEMA,
  sanitizeScientificCalculatorData
} from '../packages/shared-ui/src/services/scientificCalculatorStorage.js';

const closeTo = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('safe expression parser implements arithmetic precedence and common scientific syntax', () => {
  assert.equal(evaluateExpression('-2^2').value, -4);
  assert.equal(evaluateExpression('2^3^2').value, 512);
  assert.equal(evaluateExpression('2(3 + 4) + 2pi').value, 14 + 2 * Math.PI);
  assert.equal(evaluateExpression('1.2e3 / 4').value, 300);
  assert.equal(evaluateExpression('50% + 10%').value, 0.6);
  assert.equal(evaluateExpression('10 % 3').value, 1);
  assert.equal(evaluateExpression('5!').value, 120);
  assert.equal(evaluateExpression('log(1000) + ln(e)').value, 4);
  assert.equal(evaluateExpression('hypot(3, 4)').value, 5);
  assert.equal(evaluateExpression('min(2, 7, 4) + max(1, 5)').value, 7);
  assert.equal(evaluateExpression('log(8, 2)').value, 3);
  assert.equal(evaluateExpression('root(27, 3)').value, 3);
  assert.equal(evaluateExpression('sign(-4) + trunc(2.8)').value, 1);
  closeTo(evaluateExpression('sec(60)').value, 2);
  closeTo(evaluateExpression('sin(50)', { angleMode: 'GRAD' }).value, Math.SQRT1_2);
});

test('expression parser never evaluates arbitrary JavaScript or traverses object properties', () => {
  for (const expression of [
    'globalThis.process', 'window.alert(1)', 'constructor(1)', 'import(1)',
    '2 ** 3', '(()=>{})()', '1;2', 'document.cookie'
  ]) assert.throws(() => evaluateExpression(expression), Error, expression);
  assert.throws(() => evaluateExpression('unknown(2)'), /Unknown function/);
  assert.throws(() => evaluateExpression('mystery + 2'), /not defined/);
  assert.throws(() => evaluateExpression('1 +'), /incomplete/);
  assert.throws(() => evaluateExpression('(1 + 2'), /closing parenthesis/);
});

test('calculator functions, angle modes, variables, and numeric bounds are explicit', () => {
  closeTo(evaluateExpression('sin(30)').value, 0.5);
  closeTo(evaluateExpression('sin(pi / 6)', { angleMode: 'RAD' }).value, 0.5);
  closeTo(evaluateExpression('asin(0.5)').value, 30);
  assert.equal(evaluateExpression('ans * radius', { variables: { ans: 2, radius: 3 } }).value, 6);
  assert.throws(() => evaluateExpression('radius + 1', { variables: { radius: 'NaN' } }), /not defined/);
  assert.throws(() => evaluateExpression('1 / 0'), /Division by zero/);
  assert.throws(() => evaluateExpression('sqrt(-1)'), /non-negative/);
  assert.throws(() => evaluateExpression('ln(0)'), /positive/);
  assert.throws(() => evaluateExpression('171!'), /0 to 170/);
  assert.throws(() => evaluateExpression('1e999'), /supported range/);
  assert.equal(validateCalculatorVariableName('radius'), 'radius');
  assert.throws(() => validateCalculatorVariableName('pi'), /reserved/);
  assert.throws(() => validateCalculatorVariableName('x y'), /beginning/);
});

test('calculator keypad scientific functions cover DMS, combinations and descriptive statistics', () => {
  assert.equal(evaluateExpression('dms(30, 15, 30)').value, 30.258333333333333);
  assert.equal(evaluateExpression('npr(5, 2)').value, 20);
  assert.equal(evaluateExpression('ncr(5, 2)').value, 10);
  assert.equal(evaluateExpression('mean(2, 4, 6)').value, 4);
  assert.equal(evaluateExpression('median(8, 2, 5, 3)').value, 4);
  assert.equal(evaluateExpression('variance(2, 4, 6)').value, 8 / 3);
  assert.equal(evaluateExpression('stdev(2, 4, 6)').value, Math.sqrt(8 / 3));
  assert.throws(() => evaluateExpression('dms(12, 60, 0)'), /minutes and seconds/);
  assert.throws(() => evaluateExpression('ncr(4, 5)'), /0 ≤ r ≤ n/);
});

test('result formatting is bounded and normalizes floating-point display noise', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(Number.NaN), '—');
  assert.match(formatNumber(1e-12), /e-12/);
  assert.match(formatNumber(12000, { notation: 'engineering' }), /e\+3/);
  assert.deepEqual(formatFraction(0.5), { numerator: 1, denominator: 2, text: '1/2', exact: true, error: 0 });
  assert.equal(formatFraction(1 / 3).text, '1/3');
  assert.equal(formatFraction(Math.PI).exact, false);
});

test('unit converter is dimension-aware and handles temperature offsets', () => {
  assert.equal(convertUnit(1000, 'mg', 'g'), 1);
  closeTo(convertUnit(1, 'L', 'mL'), 1000);
  assert.equal(convertUnit(1, 'atm', 'Pa'), 101325);
  assert.equal(convertUnit(1, 'km', 'm'), 1000);
  assert.equal(convertUnit(1, 'ha', 'm2'), 10000);
  assert.equal(convertUnit(1, 'kWh', 'J'), 3600000);
  assert.equal(convertUnit(1, 'MHz', 'Hz'), 1000000);
  assert.equal(convertUnit(1, 'mol/m3', 'mmol/L'), 1);
  closeTo(convertUnit(0, 'C', 'F'), 32);
  closeTo(convertUnit(32, 'F', 'C'), 0);
  assert.throws(() => convertUnit(1, 'kg', 'L'), /dimensions do not match/);
  assert.throws(() => convertUnit(Infinity, 'm', 'cm'), /finite/);
});

test('formula tools return their arithmetic, units, and safety assumptions', () => {
  const dilution = computeDilution({ c1: 10, v1: 2, c2: 2 });
  assert.equal(dilution.value, 10);
  assert.match(dilution.assumptions, /solute amount is conserved/);
  assert.throws(() => computeDilution({ c1: 2, v1: 10, c2: 5 }), /exceeds/);
  const weight = computeWeightBasedAmount({ rate: 5, weight: 20, rateUnit: 'mg/kg', weightUnit: 'kg' });
  assert.equal(weight.value, 100);
  assert.match(weight.assumptions, /not a clinical dosing recommendation/);
  assert.equal(computeWeightBasedAmount({ rate: 5, weight: 20000, weightUnit: 'g' }).value, 100);
  assert.throws(() => computeWeightBasedAmount({ rate: 5, weight: 2, rateUnit: 'mg/hour' }), /supported/);
  assert.equal(computeInfusionRate({ volume: 100, hours: 2 }).value, 50);
  assert.equal(computeMolarity({ amount: 500, amountUnit: 'mmol', volume: 500, volumeUnit: 'mL' }).value, 1);
  assert.equal(computePH({ concentration: 0.001 }).value, 3);
  assert.throws(() => computePH({ concentration: 0 }), /must be positive/);
});

test('linear and quadratic solvers cover unique, repeated, complex and degenerate cases', () => {
  assert.equal(solveLinearEquation({ a: 2, b: 3, c: 11 }).value, 4);
  assert.throws(() => solveLinearEquation({ a: 0, b: 1, c: 2 }), /no solution/);
  assert.throws(() => solveLinearEquation({ a: 0, b: 2, c: 2 }), /Every value/);
  assert.deepEqual(solveQuadratic({ a: 1, b: -3, c: 2 }).roots, [1, 2]);
  assert.deepEqual(solveQuadratic({ a: 1, b: 2, c: 1 }).roots, [-1]);
  assert.deepEqual(solveQuadratic({ a: 1, b: 0, c: 1 }).roots, []);
  assert.equal(solveQuadratic({ a: 0, b: 2, c: -6 }).roots[0], 3);
});

test('function sampler returns bounded points and marks invalid domains as gaps', () => {
  const points = sampleFunction('1 / x', { min: -1, max: 1, count: 5, angleMode: 'RAD' });
  assert.equal(points.length, 5);
  assert.equal(points[2].y, null);
  assert.equal(points[0].y, -1);
  assert.throws(() => sampleFunction('x', { min: 2, max: 2 }), /range/);
  assert.equal(sampleFunction('x', { count: 50000 }).length, 2000);
});

test('numerical integration checks convergence and reports error and evaluation count', () => {
  const simpson = integrateFunction('x^2', { min: 0, max: 3, method: 'adaptive-simpson', tolerance: 1e-10 });
  closeTo(simpson.value, 9, 1e-9);
  assert.equal(simpson.converged, true);
  assert.ok(simpson.evaluations > 0);
  assert.ok(simpson.errorEstimate <= 1e-8);
  const reversed = integrateFunction('x', { min: 1, max: 0 });
  closeTo(reversed.value, -0.5, 1e-8);
  const trapezoid = integrateFunction('x^2', { min: 0, max: 3, method: 'trapezoid', tolerance: 1e-6 });
  closeTo(trapezoid.value, 9, 2e-5);
  assert.throws(() => integrateFunction('1/x', { min: -1, max: 1 }), /Division by zero|not finite/);
  assert.throws(() => integrateFunction('x', { min: 0, max: 1, tolerance: 0 }), /Tolerance/);
});

test('graph analysis uses numerical brackets, residual filtering and local extrema', () => {
  const roots = findFunctionRoots('x^2 - 4', { min: -5, max: 5 });
  assert.equal(roots.roots.length, 2);
  closeTo(roots.roots[0], -2, 1e-6);
  closeTo(roots.roots[1], 2, 1e-6);
  assert.match(roots.method, /bisection/);
  assert.equal(findFunctionRoots('tan(x)', { min: 1.4, max: 1.8, angleMode: 'RAD' }).roots.length, 0, 'a sign change across a pole is not reported as a root');
  const intersections = findFunctionIntersections('x^2', '1', { min: -2, max: 2 });
  assert.equal(intersections.intersections.length, 2);
  const extrema = findFunctionExtrema('(x - 1)^2', { min: -2, max: 3 });
  assert.ok(extrema.extrema.some((point) => point.kind === 'minimum' && Math.abs(point.x - 1) < 1e-4));
});

test('bounded 3D surface sampler evaluates z=f(x,y) locally and leaves domain gaps', () => {
  const surface = sampleSurface('x*y', { xMin: -1, xMax: 1, yMin: -1, yMax: 1, count: 5 });
  assert.equal(surface.rows.length, 5);
  assert.equal(surface.rows[0][0].z, 1);
  assert.equal(surface.rows[2][2].z, 0);
  assert.equal(sampleSurface('sqrt(x)', { xMin: -1, xMax: 1, yMin: -1, yMax: 1, count: 5 }).rows[0][0], null);
  assert.throws(() => sampleSurface('x*y', { xMin: 2, xMax: 1 }), /bounds/);
});

test('chemical formula parser calculates common nested molar masses and rejects unsupported symbols', () => {
  closeTo(calculateMolarMass('H2O').value, 18.015, 1e-9);
  closeTo(calculateMolarMass('Ca(OH)2').value, 74.092, .002);
  closeTo(calculateMolarMass('Al2(SO4)3').value, 342.131, .001);
  assert.throws(() => calculateMolarMass('Xx2'), /not in the built-in offline table/);
  assert.throws(() => calculateMolarMass('Ca(OH2'), /not closed/);
});

test('profile-scoped calculator repository persists bounded, sanitized local data', async () => {
  const backing = new Map();
  const storage = { async get(key) { return backing.get(key) ?? null; }, async set(key, value) { backing.set(key, value); } };
  const repo = createScientificCalculatorRepo(storage);
  const first = await repo.load();
  assert.equal(first.schemaVersion, SCIENTIFIC_CALCULATOR_SCHEMA);
  assert.equal(first.settings.fractionDisplay, false);
  assert.equal(first.memory, null);
  assert.equal(first.notebooks[0].id, 'notebook-general');
  const { entry, data } = await repo.addHistory({ expression: '2 + 2', value: 4, formatted: '4' }, first);
  assert.equal(entry.formatted, '4');
  assert.equal(data.history[0].result, 4);
  assert.equal((await repo.load()).history[0].expression, '2 + 2');
  assert.equal((await repo.load()).history[0].result, 4);
  const saved = sanitizeScientificCalculatorData({
    schemaVersion: 1,
    settings: { angleMode: 'NOPE', precision: 99, historyLimit: -2, fractionDisplay: 'false' },
    history: Array.from({ length: 550 }, (_, i) => ({ id: `id-${i}`, expression: `x + ${i}`, value: i, notebookId: 'missing' })),
    variables: { radius: 2, pi: 99, __proto__: 4, bad: 'NaN' },
    notebooks: [{ id: 'n1', name: '<script>test</script>', notes: '<img>', calculations: [] }]
  });
  assert.equal(saved.settings.angleMode, 'DEG');
  assert.equal(saved.settings.precision, 15);
  assert.equal(saved.settings.historyLimit, 50);
  assert.equal(saved.settings.fractionDisplay, false);
  assert.equal(saved.history.length, 500);
  assert.equal(saved.history[0].notebookId, 'n1');
  assert.equal(saved.variables.radius.value, 2);
  assert.equal(Object.hasOwn(saved.variables, 'pi'), false);
  assert.equal(backing.has(SCIENTIFIC_CALCULATOR_KEY), true);
});

test('backup import validates its envelope, merges local history, and round-trips data', async () => {
  const backing = new Map();
  const repo = createScientificCalculatorRepo({ async get(key) { return backing.get(key) ?? null; }, async set(key, value) { backing.set(key, value); } });
  let data = defaultScientificCalculatorData();
  ({ data } = await repo.addHistory({ expression: 'local + 1', value: 2, formatted: '2' }, data));
  const backup = await repo.exportData(data);
  const parsed = JSON.parse(backup);
  assert.equal(parsed.app, 'yayra-scientific-calculator');
  const remoteOnly = { ...parsed, data: { ...parsed.data, history: [{ id: 'remote-1', expression: 'saved + 2', value: 8, formatted: '8', createdAt: Date.now() }] } };
  const merged = await repo.importData(JSON.stringify(remoteOnly), { merge: true, current: data });
  assert.equal(merged.history.length, 2);
  assert.deepEqual(new Set(merged.history.map((entry) => entry.id)), new Set(['remote-1', data.history[0].id]));
  await assert.rejects(repo.importData('{bad json'), /valid JSON/);
  await assert.rejects(repo.importData(JSON.stringify({ app: 'other', formatVersion: 1, data: {} })), /supported/);
  await assert.rejects(repo.importData('x'.repeat(5 * 1024 * 1024 + 1)), /5 MB/);
});

test('future schema is not overwritten by an older calculator version', async () => {
  const backing = new Map([[SCIENTIFIC_CALCULATOR_KEY, { schemaVersion: SCIENTIFIC_CALCULATOR_SCHEMA + 1, secure: 'future' }]]);
  const repo = createScientificCalculatorRepo({ async get(key) { return backing.get(key); }, async set(key, value) { backing.set(key, value); } });
  const data = await repo.load();
  assert.equal(data.readOnlyFutureVersion, true);
  assert.equal(backing.get(SCIENTIFIC_CALCULATOR_KEY).secure, 'future');
});
