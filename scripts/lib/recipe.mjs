// Pure helpers for `recipe run` (spec R25): param validation and argv
// building. No I/O.
//
// Security: recipes run without a shell (see recipe-safety.mjs for the cmd
// grammar). `buildArgv` turns the cmd into argv words and each param value
// becomes exactly one argv element, verbatim, so no quoting is needed and no
// value is ever parsed by a shell. Values are length-capped, NUL-free, must
// not start with `-` unless the param sets `allow_dash: true`, and are matched
// only against patterns that pass `patternProblem` (no nested quantifiers or
// overlapping alternatives under a quantifier).

import { MAX_VALUE_LEN, parseRecipeCmd, patternProblem } from './recipe-safety.mjs';

export const INT_RE = /^-?\d+$/;

/**
 * Parse raw `--param k=v` strings into a Map. Returns {params} or {error}.
 * A missing `=`, an empty key or a repeated key is an error.
 * @param {string[]} raw
 */
export function parseParamArgs(raw = []) {
  const params = new Map();
  for (const entry of raw) {
    const s = String(entry);
    const eq = s.indexOf('=');
    if (eq <= 0) return { error: `--param must be k=v (got '${s}')` };
    const k = s.slice(0, eq);
    if (params.has(k)) return { error: `param '${k}' is given more than once` };
    params.set(k, s.slice(eq + 1));
  }
  return { params };
}

/**
 * Validate given params against a recipe's `params` spec.
 * @param {Record<string, {type?: 'string'|'int', required?: boolean, pattern?: string, min?: number, max?: number, allow_dash?: boolean}>} spec
 * @param {Map<string,string>} given
 * @returns {{errors: string[], values: Record<string,string>}}
 *   `values` holds every declared param; absent optional ones are ''.
 */
export function validateParams(spec = {}, given = new Map()) {
  const errors = [];
  const values = {};
  const declared = spec && typeof spec === 'object' ? spec : {};
  for (const k of given.keys()) {
    if (!Object.hasOwn(declared, k)) errors.push(`unknown param '${k}'`);
  }
  for (const [name, p] of Object.entries(declared)) {
    const has = given.has(name);
    if (!has) {
      if (p?.required === true) errors.push(`missing required param '${name}'`);
      values[name] = '';
      continue;
    }
    const v = given.get(name);
    if (/[\0]/.test(v)) { errors.push(`param '${name}' must not contain NUL`); continue; }
    if (v.length > MAX_VALUE_LEN) { errors.push(`param '${name}' is ${v.length} chars (max ${MAX_VALUE_LEN})`); continue; }
    if (v.startsWith('-') && p?.allow_dash !== true) {
      errors.push(`param '${name}' must not start with '-' (the param does not set allow_dash: true)`);
      continue;
    }
    if (p?.type === 'int') {
      if (!INT_RE.test(v) || !Number.isSafeInteger(Number(v))) {
        errors.push(`param '${name}' must be an integer (got '${v}')`);
        continue;
      }
      const n = Number(v);
      if (Number.isInteger(p.min) && n < p.min) errors.push(`param '${name}' must be >= ${p.min} (got ${n})`);
      if (Number.isInteger(p.max) && n > p.max) errors.push(`param '${name}' must be <= ${p.max} (got ${n})`);
    }
    if (p && typeof p === 'object' && 'pattern' in p) {
      const problem = patternProblem(p.pattern);
      if (problem) { errors.push(`param '${name}' has an unusable pattern (${problem})`); continue; }
      const re = new RegExp(`^(?:${p.pattern})$`);
      if (!re.test(v)) errors.push(`param '${name}' does not match pattern ${p.pattern} (got '${v}')`);
    }
    values[name] = v;
  }
  return { errors, values };
}

/**
 * Build the argv for a recipe: each literal word as-is, each `{p}` (or the
 * value part of `--flag={p}`) replaced by the param value verbatim (absent → '').
 * Throws Error for a cmd outside the grammar or an undeclared placeholder.
 * @param {string} cmd
 * @param {Record<string,string>} values  every declared param
 * @returns {string[]}
 */
export function buildArgv(cmd, values) {
  const { words, problems } = parseRecipeCmd(cmd);
  if (problems.length) throw new Error(`invalid recipe cmd (${problems[0]})`);
  for (const w of words) {
    if ('ph' in w && !Object.hasOwn(values, w.ph)) throw new Error(`placeholder {${w.ph}} is not declared in params`);
  }
  return words.map((w) => ('lit' in w ? w.lit : `${w.prefix}${values[w.ph] ?? ''}`));
}

/** One-line description of a recipe's params for `recipe list`. */
export function describeParams(params = {}) {
  const parts = Object.entries(params ?? {}).map(([name, p]) => {
    const attrs = [p?.type === 'int' ? 'int' : 'string'];
    if (p?.required === true) attrs.push('required');
    if (Number.isInteger(p?.min)) attrs.push(`min=${p.min}`);
    if (Number.isInteger(p?.max)) attrs.push(`max=${p.max}`);
    if (typeof p?.pattern === 'string') attrs.push(`pattern=${p.pattern}`);
    if (p?.allow_dash === true) attrs.push('allow_dash');
    return `${name} (${attrs.join(', ')})`;
  });
  return parts.length ? parts.join('; ') : '(no params)';
}
