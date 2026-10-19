// dev-cycle feature init <slug> --flow F --track T [--answer k=v]...
// Precedence per interview key: --answer > profile interview_defaults /
// platform > track defaults (playbook §5).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, featuresRoot, output, parseCommandArgs, resolveFeatureDir, warn } from './core.mjs';
import { updateFeatureJson, writeFeatureJson } from './feature-json.mjs';
import { INTERVIEW_KEYS, PROTECTED_SKILLS, SKILL_ALIASES, aliasWarning, checkInterviewValue, isAlias, isKnownSkill, loadProfile, registrySkills } from './profile.mjs';

const FLOWS = ['feature', 'bugfix', 'hotfix'];
const TRACKS = ['full', 'lite', 'quick'];
const PROFILE_COPY = ['commands', 'extra_gates', 'post_merge', 'guards', 'rules', 'enabled_skills', 'recipes', 'visual'];
const SKILL_FORCED = Object.freeze({
  discovery: ['discovery', 'skip'],
  'auto-tester': ['auto_tests', false],
  'visual-tester': ['visual_tests', false],
  'a11y-auditor': ['a11y_audit', false],
  'dependency-auditor': ['dependency_audit', false],
  'security-reviewer': ['security_review', false],
  'release-manager': ['release_manage', false],
  'plan-writer': ['separate_plan', false],
});
const pad = (n) => String(n).padStart(2, '0');

function parseAnswer(raw) {
  const i = raw.indexOf('=');
  if (i < 1) throw new UsageError(`--answer expects key=value (got '${raw}')`);
  const key = raw.slice(0, i);
  const text = raw.slice(i + 1);
  if (!Object.hasOwn(INTERVIEW_KEYS, key)) {
    throw new UsageError(`--answer: unknown interview key '${key}' (allowed: ${Object.keys(INTERVIEW_KEYS).join(', ')})`);
  }
  let value = text;
  if (INTERVIEW_KEYS[key] === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new UsageError(`--answer ${key} must be true or false`);
    value = text === 'true';
  } else if (INTERVIEW_KEYS[key] === 'string|null' && (text === 'null' || text === '')) {
    value = null;
  }
  const err = checkInterviewValue(key, value);
  if (err) throw new UsageError(`--answer ${key} ${err}`);
  return [key, value];
}

async function init(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'feature init <slug> --flow <feature|bugfix|hotfix> [--track <full|lite|quick>] (default quick) [--answer k=v]...',
    options: {
      flow: { type: 'string', required: true },
      track: { type: 'string' },
      answer: { type: 'string', multiple: true },
    },
    positionals: ['slug'],
  });
  const { slug } = args;
  if (!/^[a-z0-9-]+$/.test(slug)) throw new UsageError(`slug must match [a-z0-9-]+ (got '${slug}')`);
  if (!FLOWS.includes(values.flow)) throw new UsageError(`--flow must be one of ${FLOWS.join('|')}`);
  const isFeature = values.flow === 'feature';
  if (values.track !== undefined && !TRACKS.includes(values.track)) throw new UsageError(`--track must be one of ${TRACKS.join('|')}`);
  if (!isFeature && values.track !== undefined) {
    ctx.stderr.write(`--track ignored for flow ${values.flow}\n`);
  }
  const track = isFeature ? (values.track ?? 'quick') : undefined;
  if (isFeature && values.track === undefined) ctx.stderr.write('track: quick (default)\n');

  const answers = Object.fromEntries((values.answer ?? []).map(parseAnswer));
  const { exists, profile } = loadProfile(ctx);

  // Lowest to highest precedence.
  const trackDefaults = {
    platform: 'web',
    has_ui: false,
    has_backend: false,
    auto_tests: true,
    visual_tests: false,
    design_source: null,
    discovery: exists && (track === 'full' || track === 'lite') ? 'internal' : (track === 'full' ? 'full' : 'skip'),
    ...(isFeature && track === 'full' ? { separate_plan: true } : {}),
  };
  const fromProfile = { ...(profile.platform ? { platform: profile.platform } : {}), ...(profile.interview_defaults ?? {}) };
  const merged = { ...trackDefaults, ...fromProfile, ...answers };
  if (!(isFeature && track === 'full')) delete merged.separate_plan;

  let skipped;
  if (Array.isArray(profile.enabled_skills)) {
    const owners = profile.enabled_skills.filter(isAlias).map((s) => SKILL_ALIASES[s]).filter(Boolean);
    const keep = new Set([...profile.enabled_skills, ...owners, ...PROTECTED_SKILLS]);
    skipped = registrySkills().filter((s) => !keep.has(s)).sort();
    for (const skill of Object.keys(SKILL_FORCED).sort()) {
      if (keep.has(skill)) continue;
      const forced = SKILL_FORCED[skill];
      const [key, value] = forced;
      if (key === 'separate_plan' && !('separate_plan' in merged)) continue;
      merged[key] = value;
      ctx.stderr.write(`! SKILL: ${key}=${value} forced \u2014 ${skill} not in enabled_skills\n`);
    }
  }

  const now = new Date();
  const folderName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}h-${pad(now.getMinutes())}m-${slug}`;
  const dir = path.join(featuresRoot(ctx), folderName);
  if (fs.existsSync(dir)) throw new UsageError(`feature folder already exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });

  const fj = {
    feature_slug: slug,
    created: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    flow: values.flow,
    ...(isFeature ? { track } : {}),
    started_at: now.toISOString(),
    sessions: ctx.env?.CLAUDE_CODE_SESSION_ID ? [ctx.env.CLAUDE_CODE_SESSION_ID] : [],
    ...merged,
    current_phase: !isFeature || track === 'quick'
      ? 'implement'
      : (merged.discovery !== 'skip' && track === 'full' ? 'discovery' : 'spec'),
    history: [],
    totals: { by_subagent: {}, by_model: {} },
  };
  if (skipped) fj.skipped_skills = skipped;
  if (exists) {
    const copy = {};
    for (const k of PROFILE_COPY) if (k in profile) copy[k] = profile[k];
    fj.profile = copy;
  }
  writeFeatureJson(dir, fj);
  output(ctx, values, { text: dir, data: { path: dir, feature: fj } });
  return 0;
}

const PHASES = ['discovery', 'spec', 'wireframe', 'plan', 'implement', 'review', 'test', 'git', 'done'];
const MODELS = ['haiku', 'sonnet', 'opus', 'inherit'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;

/** key → validator returning an error string or null. */
const SETTABLE = {
  current_phase: (v) => (PHASES.includes(v) ? null : `must be one of ${PHASES.join('|')}`),
  current_task_idx: (v) => (nonNegInt(v) ? null : 'must be a non-negative integer'),
  task_count: (v) => (nonNegInt(v) ? null : 'must be a non-negative integer'),
  branch: (v) => (typeof v === 'string' && v !== '' ? null : 'must be a non-empty string'),
  owner_blocking: (v) => (typeof v === 'boolean' ? null : 'must be a boolean'),
  status: (v) => (v === 'blocked' || v === 'active' ? null : 'must be "blocked" or "active"'),
  design_source: (v) => (v === null || typeof v === 'string' ? null : 'must be a string or null'),
  areas(v) {
    if (!Array.isArray(v)) return 'must be an array';
    const seen = new Set();
    for (const [i, a] of v.entries()) {
      if (!isObj(a)) return `[${i}] must be an object`;
      if (typeof a.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.name)) return `[${i}].name must be kebab-case`;
      if (seen.has(a.name)) return `duplicate area name '${a.name}'`;
      seen.add(a.name);
      if (!Array.isArray(a.touches) || a.touches.length === 0
        || !a.touches.every((t) => typeof t === 'string' && t !== '')) return `[${i}].touches must be a non-empty string[]`;
    }
    return null;
  },
  models(v) {
    if (!isObj(v)) return 'must be an object';
    const skills = registrySkills();
    for (const [k, m] of Object.entries(v)) {
      if (!isKnownSkill(k, skills)) return `unknown skill '${k}'`;
      if (!MODELS.includes(m)) return `${k} must be one of ${MODELS.join('|')}`;
    }
    return null;
  },
};

/**
 * Map old skill keys in a models object to their new owner (R22). When both
 * the old and the new key are present the new key wins. release-manager is
 * dropped. Returns the normalized object and one warning per old name.
 */
export function normalizeModels(models) {
  const out = {};
  const warnings = [];
  const olds = Object.keys(models).filter(isAlias);
  for (const [k, m] of Object.entries(models)) if (!isAlias(k)) out[k] = m;
  for (const old of olds) {
    const target = SKILL_ALIASES[old];
    if (target === null) warnings.push(`${aliasWarning(old)}; model override ignored`);
    else {
      warnings.push(aliasWarning(old));
      if (!Object.hasOwn(out, target)) out[target] = models[old];
    }
  }
  return { models: out, warnings };
}

async function set(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'feature set <key> <value>',
    positionals: ['key', 'value'],
  });
  const check = Object.hasOwn(SETTABLE, args.key) ? SETTABLE[args.key] : null;
  if (!check) throw new UsageError(`feature set: key '${args.key}' is not settable (allowed: ${Object.keys(SETTABLE).join(', ')})`);
  let value;
  try { value = JSON.parse(args.value); } catch { value = args.value; }
  const err = check(value);
  if (err) throw new UsageError(`feature set ${args.key}: ${err}`);
  if (args.key === 'models') {
    const norm = normalizeModels(value);
    value = norm.models;
    for (const w of norm.warnings) warn(ctx, w);
  }
  const dir = resolveFeatureDir(ctx, values);
  updateFeatureJson(dir, (fj) => { fj[args.key] = value; });
  output(ctx, values, {
    text: `feature.${args.key} = ${JSON.stringify(value)}`,
    data: { key: args.key, value },
  });
  return 0;
}

export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  if (sub === 'init') return init(rest, ctx);
  if (sub === 'set') return set(rest, ctx);
  throw new UsageError(`unknown feature subcommand '${sub ?? ''}' (usage: dev-cycle feature init|set ...)`);
}
