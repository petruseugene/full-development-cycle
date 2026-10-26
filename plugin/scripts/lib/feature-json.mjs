// feature.json access. Every write goes through here so that:
//   - the file is re-read immediately before it is changed,
//   - `totals` is recomputed from `history` (spec R10),
//   - unknown keys are preserved (JSON round-trip keeps them deep-equal),
//   - the write is atomic, 2-space indented, with a trailing newline.

import path from 'node:path';
import { UsageError, atomicWrite, readText } from './core.mjs';
import { computeTotals } from './totals.mjs';

export const FEATURE_JSON = 'feature.json';

/** Absolute path of `<dir>/feature.json`. */
export function featureJsonPath(dir) {
  return path.join(dir, FEATURE_JSON);
}

function parse(text, file) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new UsageError(`${file} must contain a JSON object`);
  }
  return obj;
}

/** Serialise exactly as the CLI writes feature.json. */
export function serializeFeatureJson(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Read and parse `<dir>/feature.json`. Missing or invalid → UsageError.
 * @param {string} dir feature folder
 * @returns {Record<string, any>}
 */
export function readFeatureJson(dir) {
  const file = featureJsonPath(dir);
  return parse(readText(file), file);
}

function withTotals(obj) {
  // Assigning to an existing key keeps its position; a new key goes last.
  obj.totals = computeTotals(obj.history);
  return obj;
}

/**
 * Re-read feature.json, apply `mutator`, recompute totals, write atomically.
 * The mutator may change the object in place or return a replacement object.
 * Returns the written object.
 * @param {string} dir feature folder
 * @param {(fj: Record<string, any>) => (Record<string, any>|void)} mutator
 */
export function updateFeatureJson(dir, mutator) {
  const file = featureJsonPath(dir);
  const before = readText(file);
  const obj = parse(before, file);
  const result = mutator(obj);
  const next = withTotals(result && typeof result === 'object' ? result : obj);
  atomicWrite(file, serializeFeatureJson(next), { expected: before });
  return next;
}

/**
 * Create (or overwrite) feature.json from a full object, e.g. `feature init`.
 * Totals are recomputed. The folder must already exist.
 * @param {string} dir
 * @param {Record<string, any>} obj
 */
export function writeFeatureJson(dir, obj) {
  const next = withTotals(obj);
  atomicWrite(featureJsonPath(dir), serializeFeatureJson(next));
  return next;
}
