const FUNCTION_NAMES = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'sec', 'csc', 'cot', 'asec', 'acsc', 'acot',
  'sqrt', 'cbrt', 'abs', 'ln', 'log', 'log10', 'exp', 'floor', 'ceil', 'round', 'min', 'max', 'pow', 'hypot', 'sign', 'trunc', 'root',
  'dms', 'npr', 'ncr', 'mean', 'median', 'variance', 'stdev', 'sum', 'product', 'rand', 'randint'
]);
const CONSTANTS = Object.freeze({
  pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2,
  mp: 1.672621898e-27, mn: 1.674927471e-27, me: 9.10938356e-31, mmu: 1.883531594e-28,
  a0: 5.2917721067e-11, h: 6.62607004e-34, mun: 5.050783699e-27, mub: 9.274009994e-24,
  hbar: 1.054571817e-34, alpha: 0.0072973525693, re: 2.8179403227e-15, lambdac: 2.42631023867e-12,
  gammap: 267522187.44, lambdacp: 1.32140985396e-15, lambdacn: 1.31959090481e-15, rinf: 10973731.568508,
  u: 1.6605390666e-27, mup: 1.4106067873e-26, mue: -9.2847644825e-24, mun0: -9.6623651e-27,
  mumu: -4.4904483e-26, faraday: 96485.33212, kb: 1.380649e-23, vm: 0.02271095464,
  r: 8.31446261815324, c: 299792458, c1: 3.741771852e-16, c2: 0.01438776877,
  sigma: 5.670374419e-8, epsilon0: 8.8541878128e-12, mu0: 1.2566370612e-6, phi0: 2.067833848e-15,
  g: 9.80665, g0: 0.00007748091729, z0: 376.730313668, t0: 273.15, grav: 6.6743e-11, atm: 101325,
  na: 6.02214076e23
});
export const SCIENTIFIC_CONSTANTS = Object.freeze([
  ['pi', 'Pi', Math.PI, ''], ['e', 'Euler’s number', Math.E, ''], ['tau', 'Tau', Math.PI * 2, ''], ['phi', 'Golden ratio', (1 + Math.sqrt(5)) / 2, ''],
  ['mp', 'Proton mass', 1.672621898e-27, 'kg'], ['mn', 'Neutron mass', 1.674927471e-27, 'kg'], ['me', 'Electron mass', 9.10938356e-31, 'kg'],
  ['mmu', 'Muon mass', 1.883531594e-28, 'kg'], ['a0', 'Bohr radius', 5.2917721067e-11, 'm'], ['h', 'Planck constant', 6.62607004e-34, 'J·s'],
  ['mun', 'Nuclear magneton', 5.050783699e-27, 'J/T'], ['mub', 'Bohr magneton', 9.274009994e-24, 'J/T'], ['hbar', 'Reduced Planck constant', 1.054571817e-34, 'J·s'],
  ['alpha', 'Fine-structure constant', 7.2973525693e-3, ''], ['re', 'Classical electron radius', 2.8179403227e-15, 'm'], ['lambdac', 'Compton wavelength', 2.42631023867e-12, 'm'],
  ['gammap', 'Proton gyromagnetic ratio', 267522187.44, 'rad·s⁻¹·T⁻¹'], ['lambdacp', 'Proton Compton wavelength', 1.32140985396e-15, 'm'], ['lambdacn', 'Neutron Compton wavelength', 1.31959090481e-15, 'm'],
  ['rinf', 'Rydberg constant', 10973731.568508, 'm⁻¹'], ['u', 'Atomic mass constant', 1.6605390666e-27, 'kg'], ['mup', 'Proton magnetic moment', 1.4106067873e-26, 'J/T'],
  ['mue', 'Electron magnetic moment', -9.2847644825e-24, 'J/T'], ['mun0', 'Neutron magnetic moment', -9.6623651e-27, 'J/T'], ['mumu', 'Muon magnetic moment', -4.4904483e-26, 'J/T'],
  ['faraday', 'Faraday constant', 96485.33212, 'C/mol'], ['kb', 'Boltzmann constant', 1.380649e-23, 'J/K'], ['vm', 'Molar volume of ideal gas', 0.02271095464, 'm³/mol'],
  ['r', 'Molar gas constant', 8.31446261815324, 'J/(mol·K)'], ['c', 'Speed of light in vacuum', 299792458, 'm/s'], ['c1', 'First radiation constant', 3.741771852e-16, 'W·m²'],
  ['c2', 'Second radiation constant', 0.01438776877, 'm·K'], ['sigma', 'Stefan–Boltzmann constant', 5.670374419e-8, 'W/(m²·K⁴)'], ['epsilon0', 'Vacuum electric permittivity', 8.8541878128e-12, 'F/m'],
  ['mu0', 'Vacuum magnetic permeability', 1.2566370612e-6, 'N/A²'], ['phi0', 'Magnetic flux quantum', 2.067833848e-15, 'Wb'], ['g', 'Standard acceleration of gravity', 9.80665, 'm/s²'],
  ['g0', 'Conductance quantum', 7.748091729e-5, 'S'], ['z0', 'Characteristic impedance of vacuum', 376.730313668, 'Ω'], ['t0', 'Celsius zero point', 273.15, 'K'],
  ['grav', 'Newtonian constant of gravitation', 6.6743e-11, 'm³/(kg·s²)'], ['atm', 'Standard atmosphere', 101325, 'Pa'], ['na', 'Avogadro constant', 6.02214076e23, 'mol⁻¹']
].map(([name, label, value, unit]) => Object.freeze({ name, label, value, unit })));
const RESERVED = new Set([...FUNCTION_NAMES, ...Object.keys(CONSTANTS), 'ans', 'constructor', 'prototype', '__proto__', 'tostring', 'valueof', 'hasownproperty']);
const MAX_TOKENS = 512;
const MAX_FACTORIAL = 170;

function tokenize(source) {
  const text = String(source ?? '').replace(/[π]/g, 'pi').replace(/[×]/g, '*').replace(/[÷]/g, '/').replace(/[−–]/g, '-');
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i += 1; continue; }
    const rest = text.slice(i);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error('Number is outside the supported range.');
      tokens.push({ type: 'number', value, raw: number[0] });
      i += number[0].length;
    } else {
      const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (identifier) {
        tokens.push({ type: 'identifier', value: identifier[0].toLowerCase(), raw: identifier[0] });
        i += identifier[0].length;
      } else if ('+-*/^()%!,'.includes(text[i])) {
        tokens.push({ type: 'operator', value: text[i], raw: text[i] });
        i += 1;
      } else {
        throw new Error(`Unrecognized character “${text[i]}”.`);
      }
    }
    if (tokens.length > MAX_TOKENS) throw new Error('Expression is too long.');
  }
  if (!tokens.length) throw new Error('Enter an expression to calculate.');
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

const startsValue = (token) => token?.type === 'number' || token?.type === 'identifier' || token?.value === '(';

function parse(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (value) => {
    if (peek().value !== value) throw new Error(value === ')' ? 'A closing parenthesis is missing.' : `Expected “${value}”.`);
    return take();
  };
  const precedence = (operator) => ({ '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, implicit: 20, '^': 30 }[operator] || 0);

  function expression(minimum = 0) {
    let left;
    const token = take();
    if (token.type === 'number') left = { type: 'number', value: token.value, raw: token.raw };
    else if (token.value === '+' || token.value === '-') left = { type: 'unary', op: token.value, value: expression(25) };
    else if (token.value === '(') {
      left = expression(0);
      expect(')');
    } else if (token.type === 'identifier') {
      const name = token.value;
      if (peek().value === '(') {
        if (!FUNCTION_NAMES.has(name)) throw new Error(`Unknown function “${token.raw}”.`);
        take();
        const args = [];
        if (peek().value !== ')') {
          do {
            args.push(expression(0));
            if (peek().value !== ',') break;
            take();
          } while (true);
        }
        expect(')');
        left = { type: 'call', name, args };
      } else {
        left = { type: 'variable', name };
      }
    } else if (token.type === 'eof') throw new Error('Expression is incomplete.');
    else throw new Error(`Unexpected token “${token.raw || token.value}”.`);

    while (true) {
      const next = peek();
      if (next.value === '!' || next.value === '%' && !startsValue(tokens[position + 1])) {
        if (40 < minimum) break;
        take();
        left = { type: 'postfix', op: next.value, value: left };
        continue;
      }
      let operator = next.value;
      if (operator === '(' || next.type === 'number' || next.type === 'identifier') {
        if (!startsValue(next)) break;
        operator = 'implicit';
      }
      const priority = precedence(operator);
      if (!priority || priority < minimum) break;
      if (operator !== 'implicit') take();
      const right = expression(priority + (operator === '^' ? 0 : 1));
      left = { type: 'binary', op: operator, left, right };
    }
    return left;
  }

  const ast = expression();
  if (peek().type !== 'eof') {
    if (peek().value === ')') throw new Error('There is an unmatched closing parenthesis.');
    throw new Error(`Unexpected token “${peek().raw || peek().value}”.`);
  }
  return ast;
}

function cleanNumber(value) {
  if (!Number.isFinite(value)) throw new Error('The result is outside the supported numeric range.');
  return Object.is(value, -0) ? 0 : value;
}

function factorial(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_FACTORIAL) throw new Error(`Factorial requires a whole number from 0 to ${MAX_FACTORIAL}.`);
  let result = 1;
  for (let i = 2; i <= value; i += 1) result *= i;
  return result;
}

function normalizeVariables(variables = {}) {
  const normalized = Object.create(null);
  for (const [rawName, value] of Object.entries(variables || {})) {
    const name = String(rawName).toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || RESERVED.has(name)) continue;
    const numeric = Number(value?.value ?? value);
    if (Number.isFinite(numeric)) normalized[name] = numeric;
  }
  return normalized;
}

function callFunction(name, args, angleMode) {
  const one = (fn) => { if (args.length !== 1) throw new Error(`${name} expects one argument.`); return fn(args[0]); };
  const two = (fn) => { if (args.length !== 2) throw new Error(`${name} expects two arguments.`); return fn(args[0], args[1]); };
  const toRadians = (value) => angleMode === 'DEG' ? value * Math.PI / 180 : angleMode === 'GRAD' ? value * Math.PI / 200 : value;
  const fromRadians = (value) => angleMode === 'DEG' ? value * 180 / Math.PI : angleMode === 'GRAD' ? value * 200 / Math.PI : value;
  switch (name) {
    case 'sin': return one((x) => Math.sin(toRadians(x)));
    case 'cos': return one((x) => Math.cos(toRadians(x)));
    case 'tan': return one((x) => Math.tan(toRadians(x)));
    case 'sec': return one((x) => 1 / Math.cos(toRadians(x)));
    case 'csc': return one((x) => 1 / Math.sin(toRadians(x)));
    case 'cot': return one((x) => 1 / Math.tan(toRadians(x)));
    case 'asin': return one((x) => fromRadians(Math.asin(x)));
    case 'acos': return one((x) => fromRadians(Math.acos(x)));
    case 'atan': return one((x) => fromRadians(Math.atan(x)));
    case 'atan2': return two((y, x) => fromRadians(Math.atan2(y, x)));
    case 'asec': return one((x) => fromRadians(Math.acos(1 / x)));
    case 'acsc': return one((x) => fromRadians(Math.asin(1 / x)));
    case 'acot': return one((x) => fromRadians(Math.atan2(1, x)));
    case 'sinh': return one(Math.sinh);
    case 'cosh': return one(Math.cosh);
    case 'tanh': return one(Math.tanh);
    case 'asinh': return one(Math.asinh);
    case 'acosh': return one(Math.acosh);
    case 'atanh': return one(Math.atanh);
    case 'sqrt': return one((x) => { if (x < 0) throw new Error('Square root requires a non-negative value.'); return Math.sqrt(x); });
    case 'root': return two((x, n) => { if (!Number.isInteger(n) || n === 0) throw new Error('root(value, degree) requires a non-zero integer degree.'); if (x < 0 && Math.abs(n) % 2 === 0) throw new Error('An even root of a negative number is not real.'); return Math.sign(x) * Math.abs(x) ** (1 / n); });
    case 'cbrt': return one(Math.cbrt);
    case 'abs': return one(Math.abs);
    case 'ln': return one((x) => { if (x <= 0) throw new Error('Natural logarithm requires a positive value.'); return Math.log(x); });
    case 'log10': return one((x) => { if (x <= 0) throw new Error('Logarithm requires a positive value.'); return Math.log10(x); });
    case 'log': if (args.length === 1) return callFunction('log10', args, angleMode); if (args.length === 2) { if (args[0] <= 0 || args[1] <= 0 || args[1] === 1) throw new Error('Logarithm requires a positive value and a positive base other than one.'); return Math.log(args[0]) / Math.log(args[1]); } throw new Error('log expects one value, or a value and base.');
    case 'exp': return one(Math.exp);
    case 'floor': return one(Math.floor);
    case 'ceil': return one(Math.ceil);
    case 'round': return one(Math.round);
    case 'trunc': return one(Math.trunc);
    case 'sign': return one(Math.sign);
    case 'min': if (!args.length) throw new Error('min expects at least one argument.'); return Math.min(...args);
    case 'max': if (!args.length) throw new Error('max expects at least one argument.'); return Math.max(...args);
    case 'pow': return two(Math.pow);
    case 'hypot': if (args.length < 2) throw new Error('hypot expects at least two arguments.'); return Math.hypot(...args);
    case 'rand': if (args.length !== 0) throw new Error('rand expects no arguments.'); return Math.random();
    case 'randint': {
      if (args.length !== 2 || args.some((value) => !Number.isSafeInteger(value)) || args[0] > args[1] || args[1] - args[0] > 1e9) throw new Error('randint expects safe integer bounds a,b with a ≤ b and a range no larger than 1,000,000,000.');
      return args[0] + Math.floor(Math.random() * (args[1] - args[0] + 1));
    }
    case 'dms': {
      if (args.length !== 3) throw new Error('dms expects degrees, minutes and seconds.');
      const [degrees, minutes, seconds] = args;
      if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) throw new Error('DMS minutes and seconds must be from 0 up to (but not including) 60.');
      const sign = degrees < 0 ? -1 : 1;
      return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
    }
    case 'npr':
    case 'ncr': {
      if (args.length !== 2 || args.some((value) => !Number.isInteger(value)) || args[0] < 0 || args[1] < 0 || args[1] > args[0] || args[0] > MAX_FACTORIAL) throw new Error(`${name} expects whole numbers n and r with 0 ≤ r ≤ n ≤ ${MAX_FACTORIAL}.`);
      const n = args[0]; const r = args[1];
      if (name === 'npr') { let result = 1; for (let value = n - r + 1; value <= n; value += 1) result *= value; return result; }
      let result = 1; const choose = Math.min(r, n - r);
      for (let index = 1; index <= choose; index += 1) result = result * (n - choose + index) / index;
      return result;
    }
    case 'sum': if (!args.length) throw new Error('sum expects at least one value.'); return args.reduce((total, value) => total + value, 0);
    case 'product': if (!args.length) throw new Error('product expects at least one value.'); return args.reduce((total, value) => total * value, 1);
    case 'mean': if (!args.length) throw new Error('mean expects at least one value.'); return args.reduce((total, value) => total + value, 0) / args.length;
    case 'median': {
      if (!args.length) throw new Error('median expects at least one value.');
      const sorted = [...args].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case 'variance':
    case 'stdev': {
      if (!args.length) throw new Error(`${name} expects at least one value.`);
      const mean = args.reduce((total, value) => total + value, 0) / args.length;
      const variance = args.reduce((total, value) => total + (value - mean) ** 2, 0) / args.length;
      return name === 'stdev' ? Math.sqrt(variance) : variance;
    }
    default: throw new Error(`Unsupported function “${name}”.`);
  }
}

function evaluateNode(node, variables, angleMode, steps) {
  if (node.type === 'number') return node.value;
  if (node.type === 'variable') {
    if (Object.hasOwn(CONSTANTS, node.name)) return CONSTANTS[node.name];
    if (node.name === 'ans' && Number.isFinite(Number(variables.ans))) return Number(variables.ans);
    if (Object.hasOwn(variables, node.name)) return variables[node.name];
    throw new Error(`“${node.name}” is not defined. Add it as a variable first.`);
  }
  if (node.type === 'unary') {
    const value = evaluateNode(node.value, variables, angleMode, steps);
    return cleanNumber(node.op === '-' ? -value : value);
  }
  if (node.type === 'postfix') {
    const value = evaluateNode(node.value, variables, angleMode, steps);
    const result = node.op === '!' ? factorial(value) : value / 100;
    steps.push(`${node.op === '!' ? `${formatNumber(value)}!` : `${formatNumber(value)}%`} = ${formatNumber(result)}`);
    return cleanNumber(result);
  }
  if (node.type === 'call') {
    const args = node.args.map((arg) => evaluateNode(arg, variables, angleMode, steps));
    const value = cleanNumber(callFunction(node.name, args, angleMode));
    steps.push(`${node.name}(${args.map(formatNumber).join(', ')}) = ${formatNumber(value)}`);
    return value;
  }
  if (node.type === 'binary') {
    const left = evaluateNode(node.left, variables, angleMode, steps);
    const right = evaluateNode(node.right, variables, angleMode, steps);
    let value;
    switch (node.op) {
      case '+': value = left + right; break;
      case '-': value = left - right; break;
      case '*': case 'implicit': value = left * right; break;
      case '/': if (right === 0) throw new Error('Division by zero is undefined.'); value = left / right; break;
      case '%': if (right === 0) throw new Error('Remainder by zero is undefined.'); value = left % right; break;
      case '^': value = left ** right; break;
      default: throw new Error('Unsupported operator.');
    }
    value = cleanNumber(value);
    steps.push(`${formatNumber(left)} ${node.op === 'implicit' ? '×' : node.op} ${formatNumber(right)} = ${formatNumber(value)}`);
    return value;
  }
  throw new Error('Invalid expression structure.');
}

export function evaluateExpression(expression, { variables = {}, angleMode = 'DEG' } = {}) {
  const ast = parse(expression);
  const steps = [];
  const normalized = normalizeVariables(variables);
  if (variables && variables.ans !== null && variables.ans !== undefined && Number.isFinite(Number(variables.ans))) {
    normalized.ans = Number(variables.ans);
  }
  const mode = ['DEG', 'RAD', 'GRAD'].includes(angleMode) ? angleMode : 'DEG';
  const value = cleanNumber(evaluateNode(ast, normalized, mode, steps));
  return { value, formatted: formatNumber(value), steps, ast };
}

export function formatNumber(value, { precision = 12, notation = 'auto', fixedDigits = 2 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Object.is(number, -0) || number === 0) return notation === 'fixed' ? (0).toFixed(Math.max(0, Math.min(9, Math.trunc(Number(fixedDigits) || 0)))) : '0';
  const significant = Math.max(1, Math.min(15, Math.trunc(Number(precision) || 12)));
  const abs = Math.abs(number);
  if (notation === 'fixed') return number.toFixed(Math.max(0, Math.min(9, Math.trunc(Number(fixedDigits) || 0))));
  const scientificRequested = notation === 'scientific' || notation === 'engineering'
    || (notation === 'norm1' && (abs >= 1e10 || abs < 1e-2))
    || (notation === 'norm2' && (abs >= 1e10 || abs < 1e-9))
    || (notation === 'auto' && (abs >= 1e10 || abs < 1e-2));
  if (scientificRequested) {
    if (notation === 'engineering') {
      const exponent = Math.floor(Math.log10(abs) / 3) * 3;
      const mantissa = number / (10 ** exponent);
      return `${Number(mantissa.toPrecision(significant))}e${exponent >= 0 ? '+' : ''}${exponent}`;
    }
    return Number(number.toPrecision(significant)).toExponential(significant - 1).replace(/\.0+e/, 'e').replace(/(\.\d*?)0+e/, '$1e').replace('e+', 'e');
  }
  // Formatting, not calculation, removes binary floating-point display noise.
  return Number(number.toPrecision(significant)).toLocaleString('en-US', {
    useGrouping: false,
    maximumSignificantDigits: significant
  });
}

export function formatFraction(value, { maxDenominator = 1000000, tolerance = 1e-10 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number === 0) return { numerator: 0, denominator: 1, text: '0', exact: true, error: 0 };
  const sign = number < 0 ? -1 : 1;
  const target = Math.abs(number);
  let remainder = target;
  let p0 = 0; let q0 = 1; let p1 = 1; let q1 = 0;
  for (let index = 0; index < 64; index += 1) {
    const coefficient = Math.floor(remainder);
    const p2 = coefficient * p1 + p0;
    const q2 = coefficient * q1 + q0;
    if (!Number.isFinite(p2) || q2 > Math.max(1, Math.trunc(maxDenominator))) break;
    p0 = p1; q0 = q1; p1 = p2; q1 = q2;
    const approximation = p1 / q1;
    if (Math.abs(approximation - target) <= tolerance * Math.max(1, target)) break;
    const fractional = remainder - coefficient;
    if (fractional < Number.EPSILON) break;
    remainder = 1 / fractional;
  }
  const numerator = sign * p1;
  const error = Math.abs(numerator / q1 - number);
  const exact = error <= Number.EPSILON * 4 * Math.max(1, Math.abs(number));
  return { numerator, denominator: q1, text: q1 === 1 ? String(numerator) : `${numerator}/${q1}`, exact, error };
}

const UNIT_GROUPS = Object.freeze({
  Length: {
    m: ['meter', 1], km: ['kilometer', 1e3], cm: ['centimeter', 1e-2], mm: ['millimeter', 1e-3], um: ['micrometer', 1e-6], nm: ['nanometer', 1e-9], mi: ['mile', 1609.344], yd: ['yard', 0.9144], ft: ['foot', 0.3048], in: ['inch', 0.0254]
  },
  Area: { 'm2': ['square meter', 1], 'km2': ['square kilometer', 1e6], 'cm2': ['square centimeter', 1e-4], ha: ['hectare', 1e4], acre: ['acre', 4046.8564224] },
  Volume: { 'm3': ['cubic meter', 1], L: ['liter', 1e-3], mL: ['milliliter', 1e-6], uL: ['microliter', 1e-9], nL: ['nanoliter', 1e-12], gal: ['US gallon', 0.003785411784], qt: ['US quart', 0.000946352946], cup: ['US cup', 0.0002365882365], floz: ['US fluid ounce', 0.0000295735295625] },
  Mass: { kg: ['kilogram', 1], g: ['gram', 1e-3], mg: ['milligram', 1e-6], ug: ['microgram', 1e-9], ng: ['nanogram', 1e-12], tonne: ['metric tonne', 1e3], lb: ['pound', 0.45359237], oz: ['ounce', 0.028349523125] },
  Time: { s: ['second', 1], ms: ['millisecond', 1e-3], min: ['minute', 60], h: ['hour', 3600], day: ['day', 86400], week: ['week', 604800] },
  Speed: { 'm/s': ['meter per second', 1], 'km/h': ['kilometer per hour', 1 / 3.6], mph: ['mile per hour', 0.44704], 'ft/s': ['foot per second', 0.3048] },
  Acceleration: { 'm/s2': ['meter per second squared', 1], 'g0': ['standard gravity', 9.80665] },
  Force: { N: ['newton', 1], kN: ['kilonewton', 1e3], lbf: ['pound-force', 4.4482216152605] },
  Pressure: { Pa: ['pascal', 1], kPa: ['kilopascal', 1e3], MPa: ['megapascal', 1e6], bar: ['bar', 1e5], atm: ['standard atmosphere', 101325], mmHg: ['millimeter of mercury', 133.322387415], psi: ['pound per square inch', 6894.757293168] },
  Energy: { J: ['joule', 1], kJ: ['kilojoule', 1e3], cal: ['thermochemical calorie', 4.184], kcal: ['kilocalorie', 4184], Wh: ['watt-hour', 3600], kWh: ['kilowatt-hour', 3.6e6], eV: ['electronvolt', 1.602176634e-19] },
  Power: { W: ['watt', 1], kW: ['kilowatt', 1e3], MW: ['megawatt', 1e6], hp: ['mechanical horsepower', 745.699871582] },
  Frequency: { Hz: ['hertz', 1], kHz: ['kilohertz', 1e3], MHz: ['megahertz', 1e6], GHz: ['gigahertz', 1e9] },
  Current: { A: ['ampere', 1], mA: ['milliampere', 1e-3], uA: ['microampere', 1e-6] },
  Voltage: { V: ['volt', 1], mV: ['millivolt', 1e-3], kV: ['kilovolt', 1e3] },
  Resistance: { ohm: ['ohm', 1], kohm: ['kilohm', 1e3], Mohm: ['megohm', 1e6] },
  Charge: { Cb: ['coulomb', 1], mCb: ['millicoulomb', 1e-3] },
  Amount: { mol: ['mole', 1], mmol: ['millimole', 1e-3], umol: ['micromole', 1e-6], nmol: ['nanomole', 1e-9] },
  'Mass concentration': { 'g/L': ['gram per liter', 1], 'mg/mL': ['milligram per milliliter', 1], 'mg/L': ['milligram per liter', 1e-3], 'ug/mL': ['microgram per milliliter', 1e-3], 'ug/L': ['microgram per liter', 1e-6] },
  'Amount concentration': { 'mol/L': ['mole per liter', 1], 'mmol/L': ['millimole per liter', 1e-3], 'umol/L': ['micromole per liter', 1e-6], 'mol/m3': ['mole per cubic meter', 1e-3] },
  Temperature: { C: ['degree Celsius', 1, 273.15], F: ['degree Fahrenheit', 5 / 9, 255.3722222222222], K: ['kelvin', 1, 0] }
});
const UNIT_DIMENSIONS = Object.freeze({ Length: 'length', Area: 'area', Volume: 'volume', Mass: 'mass', Time: 'time', Speed: 'speed', Acceleration: 'acceleration', Force: 'force', Pressure: 'pressure', Energy: 'energy', Power: 'power', Frequency: 'frequency', Current: 'current', Voltage: 'voltage', Resistance: 'resistance', Charge: 'charge', Amount: 'amount', 'Mass concentration': 'mass-concentration', 'Amount concentration': 'molar-concentration', Temperature: 'temperature' });
const UNIT_TABLE = Object.freeze(Object.fromEntries(Object.entries(UNIT_GROUPS).flatMap(([group, units]) => Object.entries(units).map(([id, [name, factor, offset = 0]]) => [id, { group, name, dimension: UNIT_DIMENSIONS[group], factor, offset }]))));

export const SCIENTIFIC_UNIT_GROUPS = UNIT_GROUPS;
export const SCIENTIFIC_UNITS = Object.freeze(Object.keys(UNIT_TABLE));
export function getUnitMetadata(unit) { return UNIT_TABLE[unit] ? { ...UNIT_TABLE[unit] } : null; }
export function convertUnit(value, from, to) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) throw new Error('Enter a finite numeric value.');
  const amount = Number(value);
  const source = UNIT_TABLE[from];
  const target = UNIT_TABLE[to];
  if (!Number.isFinite(amount)) throw new Error('Enter a finite numeric value.');
  if (!source || !target) throw new Error('Select a supported unit.');
  if (source.dimension !== target.dimension) throw new Error(`Cannot convert ${from} to ${to}: the dimensions do not match.`);
  const base = amount * source.factor + source.offset;
  return cleanNumber((base - target.offset) / target.factor);
}

export const SCIENTIFIC_FORMULAS = Object.freeze([
  { id: 'dilution', name: 'Dilution', expression: 'C₁V₁ = C₂V₂', variables: 'C₁: starting concentration; V₁: starting volume; C₂: target concentration; V₂: final volume.', assumptions: 'The concentration basis and units must be compatible. Assumes the solute amount is conserved.' },
  { id: 'molarity', name: 'Molarity', expression: 'M = n / V', variables: 'M: amount concentration in mol/L; n: amount in mol; V: solution volume in L.', assumptions: 'Use final solution volume, not solvent volume.' },
  { id: 'mass-moles', name: 'Mass and amount', expression: 'n = m / M', variables: 'n: amount in mol; m: mass in g; M: molar mass in g/mol.', assumptions: 'Use a compatible molar mass and stated sample composition.' },
  { id: 'ph', name: 'Ideal concentration pH', expression: 'pH = −log₁₀([H⁺])', variables: '[H⁺]: hydrogen-ion concentration in mol/L.', assumptions: 'Ideal concentration approximation; activity and equilibria are omitted.' },
  { id: 'buffer-ph', name: 'Buffer pH estimate', expression: 'pH = pKa + log₁₀([A⁻]/[HA])', variables: 'Conjugate base and acid concentrations must use consistent units.', assumptions: 'Henderson–Hasselbalch approximation; confirm the buffer assumptions.' },
  { id: 'weight-dose', name: 'Weight-based arithmetic', expression: 'amount = supplied rate × supplied mass', variables: 'Rate and mass are user-supplied values with compatible units.', assumptions: 'Arithmetic only; this does not determine clinical suitability or authorize administration.' },
  { id: 'infusion-rate', name: 'Volumetric rate', expression: 'rate = volume / time', variables: 'Volume in mL; time in hours; output in mL/h.', assumptions: 'Does not determine a medication concentration, dose or clinically appropriate rate.' },
  { id: 'drop-rate', name: 'Gravity flow arithmetic', expression: 'gtt/min = volume × drop factor / time', variables: 'Volume in mL; drop factor in gtt/mL; time in minutes.', assumptions: 'Arithmetic only. No device setting or administration recommendation.' }
]);

export function computeDilution({ c1, v1, c2, unit = 'mL' }) {
  const values = [c1, v1, c2].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Enter positive values for C₁, V₁ and C₂.');
  if (values[2] > values[0]) throw new Error('The target concentration exceeds the starting concentration; this is not a dilution.');
  const v2 = (values[0] * values[1]) / values[2];
  return { value: cleanNumber(v2), unit, formula: 'C₁V₁ = C₂V₂', steps: [`V₂ = (C₁ × V₁) / C₂`, `V₂ = (${values[0]} × ${values[1]} ) / ${values[2]}`, `V₂ = ${formatNumber(v2)} ${unit}`], assumptions: SCIENTIFIC_FORMULAS[0].assumptions };
}

export function computeWeightBasedAmount({ rate, weight, rateUnit = 'mg/kg', weightUnit = 'kg' }) {
  let massKg = Number(weight);
  let perKg = Number(rate);
  if (!Number.isFinite(massKg) || massKg <= 0 || !Number.isFinite(perKg) || perKg <= 0) throw new Error('Enter positive rate and mass values.');
  if (weightUnit === 'g') massKg /= 1000;
  else if (weightUnit !== 'kg') throw new Error('Mass must be entered in kilograms or grams.');
  const outputUnit = rateUnit.split('/')[0] || 'mg';
  if (!['mg', 'g', 'ug', 'mcg'].includes(outputUnit) || !rateUnit.endsWith('/kg')) throw new Error('Select a supported amount-per-kilogram unit.');
  const value = cleanNumber(perKg * massKg);
  return { value, unit: outputUnit, steps: [`${formatNumber(perKg)} ${rateUnit} × ${formatNumber(Number(weight))} ${weightUnit}`, `Calculated amount = ${formatNumber(value)} ${outputUnit}`], assumptions: 'Mathematical calculation from user-supplied values only; not a clinical dosing recommendation.' };
}

export function computeInfusionRate({ volume, hours }) {
  const v = Number(volume); const t = Number(hours);
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(t) || t <= 0) throw new Error('Enter positive volume and time values.');
  const rate = v / t;
  return { value: cleanNumber(rate), unit: 'mL/h', formula: 'rate = volume / time', steps: [`${formatNumber(v)} mL / ${formatNumber(t)} h`, `Rate = ${formatNumber(rate)} mL/h`], assumptions: 'Volumetric arithmetic only; verify the concentration and clinical instructions separately.' };
}

export function computeMolarity({ amount, volume, amountUnit = 'mol', volumeUnit = 'L' }) {
  const n = convertUnit(amount, amountUnit, 'mol');
  const v = convertUnit(volume, volumeUnit, 'L');
  if (n <= 0 || v <= 0) throw new Error('Amount and final solution volume must be positive.');
  const value = n / v;
  return { value: cleanNumber(value), unit: 'mol/L', formula: 'M = n / V', steps: [`n = ${formatNumber(n)} mol`, `V = ${formatNumber(v)} L`, `M = n / V = ${formatNumber(value)} mol/L`] };
}

export function computePH({ concentration }) {
  const value = Number(concentration);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Hydrogen-ion concentration must be positive.');
  const pH = -Math.log10(value);
  return { value: cleanNumber(pH), unit: 'pH', formula: 'pH = −log₁₀([H⁺])', steps: [`[H⁺] = ${formatNumber(value)} mol/L`, `pH = −log₁₀(${formatNumber(value)}) = ${formatNumber(pH)}`], assumptions: 'Ideal concentration-based approximation; activity effects and solution chemistry are not included.' };
}

export function solveLinearEquation({ a, b, c }) {
  const values = [a, b, c].map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Enter finite coefficients.');
  if (values[0] === 0) throw new Error(values[1] === values[2] ? 'Every value satisfies this identity.' : 'This equation has no solution.');
  const value = (values[2] - values[1]) / values[0];
  return { value: cleanNumber(value), unit: 'x', steps: [`${values[0]}x + ${values[1]} = ${values[2]}`, `x = (${values[2]} − ${values[1]}) / ${values[0]}`, `x = ${formatNumber(value)}`], residual: values[0] * value + values[1] - values[2] };
}

export function solveQuadratic({ a, b, c }) {
  const [A, B, C] = [a, b, c].map(Number);
  if (![A, B, C].every(Number.isFinite)) throw new Error('Enter finite coefficients.');
  if (A === 0) return { roots: [solveLinearEquation({ a: B, b: C, c: 0 }).value], steps: ['The quadratic coefficient is zero; solved as a linear equation.'] };
  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return { roots: [], discriminant, steps: [`Discriminant Δ = ${formatNumber(discriminant)} < 0; there are no real roots.`] };
  const root = Math.sqrt(discriminant);
  const roots = discriminant === 0 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)];
  return { roots: roots.map(cleanNumber), discriminant, steps: [`Δ = b² − 4ac = ${formatNumber(discriminant)}`, ...roots.map((x, i) => `x${roots.length > 1 ? i + 1 : ''} = ${formatNumber(x)}`)] };
}

export function sampleFunction(expression, { min = -10, max = 10, count = 201, angleMode = 'RAD', variables = {} } = {}) {
  const start = Number(min); const end = Number(max);
  const samples = Math.max(2, Math.min(2000, Math.trunc(Number(count) || 201)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isFinite(end - start)) throw new Error('Graph range must have a finite minimum below its maximum and a finite span.');
  const points = [];
  for (let i = 0; i < samples; i += 1) {
    const x = start + ((end - start) * i) / (samples - 1);
    try { points.push({ x, y: evaluateExpression(expression, { variables: { ...variables, x }, angleMode }).value }); }
    catch { points.push({ x, y: null }); }
  }
  return points;
}

export function integrateFunction(expression, { min = 0, max = 1, angleMode = 'RAD', variables = {}, method = 'adaptive-simpson', tolerance = 1e-8, maxEvaluations = 100000 } = {}) {
  const a = Number(min); const b = Number(max); const tol = Number(tolerance);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || !Number.isFinite(b - a)) throw new Error('Integration bounds must be finite and different.');
  if (!Number.isFinite(tol) || tol <= 0 || tol > 0.1) throw new Error('Tolerance must be greater than zero and no more than 0.1.');
  const low = Math.min(a, b); const high = Math.max(a, b); const direction = a <= b ? 1 : -1;
  let evaluations = 0;
  const fn = (x) => {
    evaluations += 1;
    if (evaluations > Math.max(1000, Math.min(200000, Number(maxEvaluations) || 100000))) throw new Error('Integration stopped at its evaluation limit before convergence.');
    const y = evaluateExpression(expression, { variables: { ...variables, x }, angleMode }).value;
    if (!Number.isFinite(y)) throw new Error(`The integrand is not finite near x = ${formatNumber(x)}.`);
    return y;
  };
  let integral; let errorEstimate; let converged = false;
  if (method === 'trapezoid') {
    let intervals = 8; let previous = null;
    while (intervals <= 32768) {
      const step = (high - low) / intervals;
      let sum = (fn(low) + fn(high)) / 2;
      for (let i = 1; i < intervals; i += 1) sum += fn(low + i * step);
      integral = sum * step;
      errorEstimate = previous === null ? Infinity : Math.abs(integral - previous) / 3;
      if (previous !== null && errorEstimate <= tol * Math.max(1, Math.abs(integral))) { converged = true; break; }
      previous = integral;
      intervals *= 2;
    }
  } else if (method === 'adaptive-simpson') {
    const middle = (low + high) / 2;
    const fa = fn(low); const fm = fn(middle); const fb = fn(high);
    const simpson = (left, right, fLeft, fMiddle, fRight) => (right - left) * (fLeft + 4 * fMiddle + fRight) / 6;
    const whole = simpson(low, high, fa, fm, fb);
    const stack = [{ left: low, right: high, fLeft: fa, fMiddle: fm, fRight: fb, estimate: whole, tolerance: tol, depth: 0 }];
    integral = 0; errorEstimate = 0;
    while (stack.length) {
      const part = stack.pop(); const middleX = (part.left + part.right) / 2;
      const leftMiddle = (part.left + middleX) / 2; const rightMiddle = (middleX + part.right) / 2;
      const fLeftMiddle = fn(leftMiddle); const fRightMiddle = fn(rightMiddle);
      const leftEstimate = simpson(part.left, middleX, part.fLeft, fLeftMiddle, part.fMiddle);
      const rightEstimate = simpson(middleX, part.right, part.fMiddle, fRightMiddle, part.fRight);
      const delta = leftEstimate + rightEstimate - part.estimate;
      const localError = Math.abs(delta) / 15;
      if (localError <= part.tolerance * Math.max(1, Math.abs(leftEstimate + rightEstimate))) {
        integral += leftEstimate + rightEstimate + delta / 15;
        errorEstimate += localError;
      } else if (part.depth >= 24) {
        throw new Error('Adaptive Simpson integration reached its subdivision limit before the requested tolerance.');
      } else {
        const halfTolerance = part.tolerance / 2;
        stack.push({ left: middleX, right: part.right, fLeft: part.fMiddle, fMiddle: fRightMiddle, fRight: part.fRight, estimate: rightEstimate, tolerance: halfTolerance, depth: part.depth + 1 });
        stack.push({ left: part.left, right: middleX, fLeft: part.fLeft, fMiddle: fLeftMiddle, fRight: part.fMiddle, estimate: leftEstimate, tolerance: halfTolerance, depth: part.depth + 1 });
      }
    }
    converged = true;
  } else throw new Error('Choose adaptive Simpson or composite trapezoid integration.');
  if (!converged || !Number.isFinite(integral)) throw new Error('Integration did not converge at the selected tolerance. Try a looser tolerance or inspect the function for discontinuities.');
  return { value: cleanNumber(direction * integral), errorEstimate, tolerance: tol, evaluations, method, converged: true, steps: [`${method === 'adaptive-simpson' ? 'Adaptive Simpson' : 'Composite trapezoid'} estimate = ${formatNumber(direction * integral)}`, `Estimated absolute error ≤ ${formatNumber(errorEstimate)}`, `Evaluations: ${evaluations}; requested relative/absolute tolerance: ${formatNumber(tol)}`] };
}

function functionValue(expression, x, angleMode, variables = {}) {
  return evaluateExpression(expression, { variables: { ...variables, x }, angleMode }).value;
}

function refineBracket(fn, left, right, fLeft, fRight, tolerance = 1e-9) {
  if (fLeft === 0) return left;
  if (fRight === 0) return right;
  if (Math.sign(fLeft) === Math.sign(fRight)) return null;
  for (let i = 0; i < 80 && right - left > tolerance * Math.max(1, Math.abs(left), Math.abs(right)); i += 1) {
    const middle = (left + right) / 2; const fMiddle = fn(middle);
    if (fMiddle === 0) return middle;
    if (Math.sign(fMiddle) === Math.sign(fLeft)) { left = middle; fLeft = fMiddle; } else { right = middle; fRight = fMiddle; }
  }
  return (left + right) / 2;
}

function bracketedRoots(fn, { min = -10, max = 10, count = 1000, tolerance = 1e-8 } = {}) {
  const points = []; const n = Math.max(16, Math.min(10000, Math.trunc(count)));
  let previous = null;
  for (let i = 0; i <= n; i += 1) {
    const x = min + (max - min) * i / n;
    let y;
    try { y = fn(x); } catch { previous = null; continue; }
    if (!Number.isFinite(y) || Math.abs(y) > 1e12) { previous = null; continue; }
    if (y === 0) points.push(x);
    else if (previous && Math.sign(previous.y) !== Math.sign(y)) {
      try { const root = refineBracket(fn, previous.x, x, previous.y, y, tolerance); if (root !== null) points.push(root); } catch { /* skip a singular bracket */ }
    }
    previous = { x, y };
  }
  return [...new Set(points.map((x) => Number(x.toPrecision(12))))].sort((x, y) => x - y);
}

export function findFunctionRoots(expression, { min = -10, max = 10, angleMode = 'RAD', variables = {}, count = 1000, tolerance = 1e-8 } = {}) {
  const a = Number(min); const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new Error('Analysis range must have a finite minimum below its maximum.');
  const fn = (x) => functionValue(expression, x, angleMode, variables);
  const candidates = bracketedRoots(fn, { min: a, max: b, count, tolerance });
  const roots = candidates.filter((x) => { try { return Math.abs(fn(x)) <= Math.max(1e-7, Math.sqrt(Number(tolerance) || 1e-8)); } catch { return false; } });
  return { roots, method: 'sampled sign-change bracketing with bisection and residual filtering', approximate: true, steps: roots.map((x) => `x ≈ ${formatNumber(x)}; residual ${formatNumber(fn(x))}`) };
}

export function findFunctionIntersections(firstExpression, secondExpression, options = {}) {
  const angleMode = options.angleMode || 'RAD'; const variables = options.variables || {};
  const difference = (x) => functionValue(firstExpression, x, angleMode, variables) - functionValue(secondExpression, x, angleMode, variables);
  const candidates = bracketedRoots(difference, options);
  const roots = candidates.filter((x) => { try { return Math.abs(difference(x)) <= 1e-5; } catch { return false; } });
  return { intersections: roots.map((x) => ({ x, y: (functionValue(firstExpression, x, angleMode, variables) + functionValue(secondExpression, x, angleMode, variables)) / 2 })), method: 'sampled sign-change bracketing with bisection and residual filtering', approximate: true };
}

export function findFunctionExtrema(expression, { min = -10, max = 10, angleMode = 'RAD', variables = {}, count = 500 } = {}) {
  const a = Number(min); const b = Number(max); const n = Math.max(20, Math.min(5000, Math.trunc(count)));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new Error('Analysis range must have a finite minimum below its maximum.');
  const values = [];
  for (let i = 0; i <= n; i += 1) {
    const x = a + (b - a) * i / n;
    try { const y = functionValue(expression, x, angleMode, variables); values.push({ x, y: Number.isFinite(y) ? y : null }); } catch { values.push({ x, y: null }); }
  }
  const extrema = [];
  for (let i = 1; i < values.length - 1; i += 1) {
    const p = values[i - 1]; const c = values[i]; const q = values[i + 1];
    if (p.y === null || c.y === null || q.y === null) continue;
    const kind = c.y < p.y && c.y < q.y ? 'minimum' : c.y > p.y && c.y > q.y ? 'maximum' : null;
    if (!kind) continue;
    try {
      let left = p.x; let right = q.x; const phi = (Math.sqrt(5) - 1) / 2;
      let x1 = right - phi * (right - left); let x2 = left + phi * (right - left);
      const objective = (x) => { const y = functionValue(expression, x, angleMode, variables); return kind === 'minimum' ? y : -y; };
      let f1 = objective(x1); let f2 = objective(x2);
      for (let k = 0; k < 48; k += 1) {
        if (f1 <= f2) { right = x2; x2 = x1; f2 = f1; x1 = right - phi * (right - left); f1 = objective(x1); }
        else { left = x1; x1 = x2; f1 = f2; x2 = left + phi * (right - left); f2 = objective(x2); }
      }
      const x = (left + right) / 2; const y = functionValue(expression, x, angleMode, variables);
      extrema.push({ x, y, kind, approximate: true });
    } catch { /* a singular local bracket is not reported as an extremum */ }
  }
  return { extrema, method: 'sampled local brackets refined by golden-section search', approximate: true };
}

export function sampleSurface(expression, { xMin = -5, xMax = 5, yMin = -5, yMax = 5, count = 27, angleMode = 'RAD', variables = {} } = {}) {
  const bounds = [xMin, xMax, yMin, yMax].map(Number);
  if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[1] || bounds[2] >= bounds[3] || !Number.isFinite(bounds[1] - bounds[0]) || !Number.isFinite(bounds[3] - bounds[2])) throw new Error('3D plot bounds must be finite increasing ranges.');
  const size = Math.max(5, Math.min(51, Math.trunc(Number(count) || 27)));
  const rows = [];
  for (let j = 0; j < size; j += 1) {
    const y = bounds[2] + (bounds[3] - bounds[2]) * j / (size - 1); const row = [];
    for (let i = 0; i < size; i += 1) {
      const x = bounds[0] + (bounds[1] - bounds[0]) * i / (size - 1);
      try { const z = evaluateExpression(expression, { variables: { ...variables, ...{ x, y } }, angleMode }).value; row.push(Number.isFinite(z) && Math.abs(z) <= 1e6 ? { x, y, z } : null); } catch { row.push(null); }
    }
    rows.push(row);
  }
  return { rows, xMin: bounds[0], xMax: bounds[1], yMin: bounds[2], yMax: bounds[3], count: size, expression, method: 'local sampled z = f(x,y) surface' };
}

export function calculateMolarMass(formula) {
  const atomicMass = { H: 1.008, He: 4.002602, Li: 6.94, Be: 9.0121831, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998403, Ne: 20.1797, Na: 22.989769, Mg: 24.305, Al: 26.981538, Si: 28.085, P: 30.973762, S: 32.06, Cl: 35.45, Ar: 39.948, K: 39.0983, Ca: 40.078, Cr: 51.9961, Mn: 54.938044, Fe: 55.845, Co: 58.933194, Ni: 58.6934, Cu: 63.546, Zn: 65.38, Br: 79.904, Ag: 107.8682, I: 126.90447, Ba: 137.327, Pt: 195.084, Au: 196.96657, Hg: 200.592, Pb: 207.2 };
  const text = String(formula || '').replace(/\s+/g, '');
  if (!text || text.length > 80 || !/^[A-Za-z0-9()[\]]+$/.test(text)) throw new Error('Enter a chemical formula using element symbols, numbers and parentheses.');
  let position = 0;
  function readCount() {
    const match = /^\d+/.exec(text.slice(position));
    if (!match) return 1;
    position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error('Element counts must be from 1 to 10,000.');
    return value;
  }
  function parseGroup(close = '') {
    let mass = 0; let elements = 0;
    while (position < text.length && text[position] !== close) {
      if (text[position] === '(' || text[position] === '[') {
        const bracket = text[position++]; const closing = bracket === '(' ? ')' : ']'; const child = parseGroup(closing);
        if (text[position] !== closing) throw new Error('A chemical formula group is not closed.');
        position += 1; const multiplier = readCount(); mass += child.mass * multiplier; elements += child.elements * multiplier;
      } else {
        const match = /^[A-Z][a-z]?/.exec(text.slice(position));
        if (!match) throw new Error(`Invalid element symbol near “${text.slice(position)}”.`);
        const symbol = match[0];
        if (!Object.hasOwn(atomicMass, symbol)) throw new Error(`Atomic mass for ${symbol} is not in the built-in offline table.`);
        position += symbol.length; const count = readCount(); mass += atomicMass[symbol] * count; elements += count;
      }
      if (elements > 100000) throw new Error('Formula count is too large.');
    }
    return { mass, elements };
  }
  const result = parseGroup();
  if (position !== text.length || result.elements === 0) throw new Error('The chemical formula has an unexpected closing group or is empty.');
  return { value: cleanNumber(result.mass), unit: 'g/mol', formula: `M(${text})`, steps: [`Sum of standard atomic weights in ${text}`, `Molar mass ≈ ${formatNumber(result.mass)} g/mol`], assumptions: 'Uses a built-in table of common standard atomic weights and the formula exactly as entered. Isotopic composition and uncertainty are not modeled.' };
}

export function validateCalculatorVariableName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Use a variable name beginning with a letter or underscore.');
  if (RESERVED.has(name)) throw new Error('That name is reserved for a calculator function or constant.');
  return name;
}

export const CALCULATOR_CONSTANTS = CONSTANTS;
