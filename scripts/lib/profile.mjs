// Project profile: <root>/.dev-cycle/project.json (spec R15).
// loadProfile() never throws for a missing file (valid, empty profile);
// invalid content throws UsageError (exit 2).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, readText, resolveProjectRoot, warn } from './core.mjs';
import { cmdProblems, patternProblem } from './recipe-safety.mjs';
import { validateVisual } from './visual-profile.mjs';

export const PROFILE_REL = path.join('.dev-cycle', 'project.json');
export const PLATFORMS = Object.freeze(['web', 'mobile']);
export const COMMAND_KEYS = Object.freeze(['lint', 'typecheck', 'test', 'format']);
/** Interview keys a profile may default (playbook §4/§5). */
export const INTERVIEW_KEYS = Object.freeze({
  has_ui: 'boolean',
  platform: 'platform',
  has_backend: 'boolean',
  architecturally_significant: 'boolean',
  design_source: 'string|null',
  auto_tests: 'boolean',
  visual_tests: 'boolean',
  a11y_audit: 'boolean',
  dependency_audit: 'boolean',
  security_review: 'boolean',
  release_manage: 'boolean',
  static_check: 'boolean',
  discovery: 'discovery',
  separate_plan: 'boolean',
  owner_blocking: 'boolean',
  tdd: 'boolean',
});
/** Skills that are always enabled regardless of profile.enabled_skills (R34). */
export const PROTECTED_SKILLS = Object.freeze([
  'playbook', 'orchestrator', 'using-dev-cycle', 'spec-writer', 'frontend-dev',
  'backend-dev', 'code-reviewer', 'cli-fallback',
]);
/** Old skill name -> new owner (R22). `null` = no skill (release-manager -> `ship --release`). */
export const SKILL_ALIASES = Object.freeze({
  'static-checker': 'cli-fallback',
  'git-agent': 'cli-fallback',
  'dependency-auditor': 'security-reviewer',
  'a11y-auditor': 'visual-tester',
  'db-migrator': 'backend-dev',
  'release-manager': null,
});
/** Display name of an alias target (`null` target is the `ship --release` command). */
export const aliasTarget = (old) => SKILL_ALIASES[old] ?? 'ship --release';
export const isAlias = (name) => Object.hasOwn(SKILL_ALIASES, name);
/** The one warning line (without the `warning: ` prefix) for an old skill name. */
export const aliasWarning = (old) => `skill '${old}' was merged into '${aliasTarget(old)}'`;
/** True when `name` is a registry skill, an old alias, or a new alias target. */
export function isKnownSkill(name, skills = registrySkills()) {
  return skills.includes(name) || isAlias(name) || Object.values(SKILL_ALIASES).includes(name);
}
const PROTECTED_WARNING_RE = /^protected skill '/;
export const DISCOVERY_VALUES = Object.freeze(['full', 'internal', 'skip']);
export const PROFILE_KEYS = Object.freeze([
  'platform', 'interview_defaults', 'commands', 'extra_gates', 'post_merge',
  'enabled_skills', 'guards', 'rules', 'recipes', 'visual', 'worktrees',
]);
export const MAX_TIMEOUT_S = 86400;
const NAME_RE = /^[a-z0-9-]+$/;

export const WORKTREE_MODES = Object.freeze(['off', 'audit', 'auto']);
export const WORKTREE_DEFAULTS = Object.freeze({
  mode: 'off',
  min_group: 3,
  dir: '.dev-cycle/worktrees',
  link: Object.freeze(['**/node_modules']),
  copy: Object.freeze(['.env', '.env.*']),
  setup: undefined,
});

/** True when a repo-relative path is absolute or has a `..` segment. */
function unsafeRelPath(p) {
  return path.isAbsolute(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]+/).includes('..');
}

function validateWorktrees(w, errors) {
  if (!isObj(w)) { errors.push('worktrees must be an object'); return; }
  for (const k of Object.keys(w)) {
    if (!Object.hasOwn(WORKTREE_DEFAULTS, k)) errors.push(`worktrees: unknown key '${k}'`);
  }
  if ('mode' in w && !WORKTREE_MODES.includes(w.mode)) errors.push(`worktrees.mode must be one of ${WORKTREE_MODES.join('|')}`);
  if ('min_group' in w && !(Number.isInteger(w.min_group) && w.min_group >= 2)) errors.push('worktrees.min_group must be an integer >= 2');
  if ('dir' in w) {
    if (typeof w.dir !== 'string' || w.dir === '') errors.push('worktrees.dir must be a non-empty string');
    else if (unsafeRelPath(w.dir)) errors.push('worktrees.dir must be repo-relative (no absolute path, no ".." segment)');
  }
  for (const k of ['link', 'copy']) {
    if (!(k in w)) continue;
    if (!isStrArr(w[k])) { errors.push(`worktrees.${k} must be an array of strings`); continue; }
    w[k].forEach((g, i) => {
      if (g === '' || unsafeRelPath(g)) errors.push(`worktrees.${k}[${i}] must be a relative glob without ".." (got ${JSON.stringify(g)})`);
    });
  }
  if ('setup' in w && w.setup !== undefined && typeof w.setup !== 'string') errors.push('worktrees.setup must be a string');
}

/** Resolved `worktrees` config with defaults applied (profile assumed validated). */
export function worktreesConfig(profile) {
  const w = isObj(profile?.worktrees) ? profile.worktrees : {};
  const out = { ...WORKTREE_DEFAULTS };
  for (const k of Object.keys(WORKTREE_DEFAULTS)) if (k in w && w[k] !== undefined) out[k] = w[k];
  out.link = [...out.link];
  out.copy = [...out.copy];
  return out;
}

/** Distinct `{name}` placeholders in a recipe cmd, in first-use order. */
export function recipePlaceholders(cmd) {
  if (typeof cmd !== 'string') return [];
  return [...new Set([...cmd.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]))];
}

function checkRecipeParams(r, at, errors, warnings) {
  const params = 'params' in r ? r.params : {};
  const declared = isObj(params) ? params : null;
  if (!declared) errors.push(`${at}.params must be an object`);
  for (const [pn, spec] of Object.entries(declared ?? {})) {
    const pat = `${at}.params.${pn}`;
    if (!isObj(spec)) { errors.push(`${pat} must be an object`); continue; }
    if ('type' in spec && spec.type !== 'string' && spec.type !== 'int') errors.push(`${pat}.type must be string|int`);
    if ('required' in spec && typeof spec.required !== 'boolean') errors.push(`${pat}.required must be a boolean`);
    if ('pattern' in spec) {
      const problem = patternProblem(spec.pattern);
      if (problem) errors.push(`${pat}.pattern ${problem}`);
    }
    if ('allow_dash' in spec && typeof spec.allow_dash !== 'boolean') errors.push(`${pat}.allow_dash must be a boolean`);
    for (const b of ['min', 'max']) {
      if (!(b in spec)) continue;
      if (spec.type !== 'int') errors.push(`${pat}.${b} is only allowed on type int`);
      else if (!Number.isInteger(spec[b])) errors.push(`${pat}.${b} must be an integer`);
    }
  }
  if (typeof r.cmd === 'string') {
    const used = recipePlaceholders(r.cmd);
    for (const ph of used) if (!declared || !Object.hasOwn(declared, ph)) errors.push(`${at}.cmd placeholder {${ph}} is not declared in params`);
    for (const pn of Object.keys(declared ?? {})) if (!used.includes(pn)) warnings.push(`${at}.params.${pn} is declared but not used in cmd`);
    if (r.cmd.trim() !== '') {
      for (const problem of cmdProblems(r.cmd)) errors.push(`${at}.cmd ${problem} (recipes run without a shell; see \`dev-cycle recipe --help\`)`);
    }
  }
}

/** Skill names = directories under the plugin's skills/. */
export function registrySkills() {
  const dir = fileURLToPath(new URL('../../skills/', import.meta.url));
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Check one interview value; returns an error string or null. */
export function checkInterviewValue(key, value) {
  const kind = INTERVIEW_KEYS[key];
  if (kind === 'boolean') return typeof value === 'boolean' ? null : 'must be a boolean';
  if (kind === 'platform') return PLATFORMS.includes(value) ? null : `must be one of ${PLATFORMS.join('|')}`;
  if (kind === 'discovery') return DISCOVERY_VALUES.includes(value) ? null : `must be one of ${DISCOVERY_VALUES.join('|')}`;
  if (kind === 'string|null') return value === null || typeof value === 'string' ? null : 'must be a string or null';
  return 'unknown interview key';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

function checkNamed(list, label, errors, extra, strictTimeout = false) {
  if (!Array.isArray(list)) { errors.push(`${label} must be an array`); return; }
  const seen = new Set();
  list.forEach((e, i) => {
    const at = `${label}[${i}]`;
    if (!isObj(e)) { errors.push(`${at} must be an object`); return; }
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) {
      errors.push(`${at}.name must match [a-z0-9-]+ (got ${JSON.stringify(e.name)})`);
    } else if (seen.has(e.name)) {
      errors.push(`${label}: duplicate name '${e.name}'`);
    } else seen.add(e.name);
    if (typeof e.cmd !== 'string' || e.cmd === '') errors.push(`${at}.cmd must be a non-empty string`);
    if (strictTimeout && 'timeout_s' in e) {
      if (!(Number.isInteger(e.timeout_s) && e.timeout_s >= 1 && e.timeout_s <= MAX_TIMEOUT_S)) {
        errors.push(`${at}.timeout_s must be an integer in 1..${MAX_TIMEOUT_S}`);
      }
    } else if ('timeout_s' in e && !(typeof e.timeout_s === 'number' && e.timeout_s > 0 && e.timeout_s <= MAX_TIMEOUT_S)) {
      errors.push(`${at}.timeout_s must be a number in (0, ${MAX_TIMEOUT_S}]`);
    }
    extra(e, at);
  });
}

/**
 * Validate a parsed profile object.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateProfile(profile, { skills = registrySkills() } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObj(profile)) return { errors: ['profile must be a JSON object'], warnings };

  for (const k of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(k)) warnings.push(`unknown top-level key '${k}' in ${PROFILE_REL}`);
  }
  if ('platform' in profile && !PLATFORMS.includes(profile.platform)) {
    errors.push(`platform must be one of ${PLATFORMS.join('|')}`);
  }
  if ('interview_defaults' in profile) {
    const d = profile.interview_defaults;
    if (!isObj(d)) errors.push('interview_defaults must be an object');
    else for (const [k, v] of Object.entries(d)) {
      if (!Object.hasOwn(INTERVIEW_KEYS, k)) { errors.push(`interview_defaults: unknown interview key '${k}'`); continue; }
      const e = checkInterviewValue(k, v);
      if (e) errors.push(`interview_defaults.${k} ${e}`);
    }
  }
  if ('commands' in profile) {
    const c = profile.commands;
    if (!isObj(c)) errors.push('commands must be an object');
    else for (const [k, v] of Object.entries(c)) {
      if (!COMMAND_KEYS.includes(k)) errors.push(`commands: unknown key '${k}' (allowed: ${COMMAND_KEYS.join(', ')})`);
      else if (typeof v !== 'string') errors.push(`commands.${k} must be a string`);
    }
  }
  if ('extra_gates' in profile) {
    checkNamed(profile.extra_gates, 'extra_gates', errors, () => {});
  }
  if ('recipes' in profile) {
    checkNamed(profile.recipes, 'recipes', errors, (e, at) => {
      checkRecipeParams(e, at, errors, warnings);
      if ('guards' in e && !isStrArr(e.guards)) errors.push(`${at}.guards must be an array of strings`);
    }, true);
  }
  if ('post_merge' in profile) {
    checkNamed(profile.post_merge, 'post_merge', errors, (e, at) => {
      if ('confirm' in e && typeof e.confirm !== 'boolean') errors.push(`${at}.confirm must be a boolean`);
    });
  }
  if ('enabled_skills' in profile) {
    if (!isStrArr(profile.enabled_skills)) errors.push('enabled_skills must be an array of strings');
    else for (const s of profile.enabled_skills) {
      if (!isKnownSkill(s, skills)) errors.push(`enabled_skills: unknown skill '${s}'`);
    }
    if (isStrArr(profile.enabled_skills)) {
      for (const s of new Set(profile.enabled_skills)) if (isAlias(s)) warnings.push(aliasWarning(s));
      const listed = new Set(profile.enabled_skills.map((s) => (isAlias(s) ? SKILL_ALIASES[s] : s)));
      for (const s of PROTECTED_SKILLS) {
        if (!listed.has(s)) warnings.push(`protected skill '${s}' is always enabled`);
      }
    }
  }
  if ('guards' in profile && !isStrArr(profile.guards)) errors.push('guards must be an array of strings');
  if ('rules' in profile) {
    if (!Array.isArray(profile.rules)) errors.push('rules must be an array');
    else profile.rules.forEach((r, i) => {
      if (!isObj(r) || !isStrArr(r.globs) || typeof r.text !== 'string') {
        errors.push(`rules[${i}] must be {globs: string[], text: string}`);
      }
    });
  }
  if ('worktrees' in profile) validateWorktrees(profile.worktrees, errors);
  if ('visual' in profile) {
    const v = validateVisual(profile.visual);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
  }
  return { errors, warnings };
}

/** Absolute profile path for the project containing ctx.cwd. */
export function profilePath(ctx) {
  return path.join(resolveProjectRoot(ctx), PROFILE_REL);
}

/**
 * Load and validate the profile. Missing file => {exists:false, profile:{}}.
 * Unknown top-level keys are warned about on ctx.stderr (once per load).
 * Invalid JSON / validation errors => UsageError listing every problem.
 * @returns {{exists: boolean, path: string, profile: Record<string, any>}}
 */
export function loadProfile(ctx, { quiet = false } = {}) {
  const file = profilePath(ctx);
  const text = readText(file, { optional: true });
  if (text === null) return { exists: false, path: file, profile: {} };
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
  const { errors, warnings } = validateProfile(profile);
  if (errors.length) throw new UsageError(`invalid profile ${file}:\n  - ${errors.join('\n  - ')}`);
  // Protected-skill warnings are surfaced by `profile validate` only.
  if (!quiet) for (const w of warnings) if (!PROTECTED_WARNING_RE.test(w)) warn(ctx, w);
  return { exists: true, path: file, profile };
}
