// dev-cycle init [--preset web|expo] [--force]   (spec R30)
// Writes .dev-cycle/project.json from detected stack commands. Never runs scripts.

import fs from 'node:fs';
import path from 'node:path';
import { FailedError, UsageError, atomicWrite, output, parseCommandArgs, resolveProjectRoot } from './core.mjs';
import { PROFILE_REL, validateProfile } from './profile.mjs';
import { detectFromDir } from './stack-detect.mjs';

const PRESETS = Object.freeze(['web', 'expo']);

/** Profile for a preset; the expo `visual` block is an empty skeleton to fill in. */
function presetFields(preset) {
  if (preset === 'web') return { interview_defaults: { platform: 'web' } };
  if (preset === 'expo') {
    return {
      interview_defaults: { platform: 'mobile' },
      visual: { build: {}, forbidden_colors: [], screens: [] },
    };
  }
  return {};
}

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: `init [--preset ${PRESETS.join('|')}] [--force]`,
    options: { preset: { type: 'string' }, force: { type: 'boolean' } },
  });
  if (values.preset !== undefined && !PRESETS.includes(values.preset)) {
    throw new UsageError(`unknown preset '${values.preset}' (allowed: ${PRESETS.join(', ')})`);
  }
  const root = resolveProjectRoot(ctx);
  const file = path.join(root, PROFILE_REL);
  const rel = PROFILE_REL.split(path.sep).join('/');
  if (fs.existsSync(file) && !values.force) {
    throw new FailedError(`init: ${rel} exists (use --force)`);
  }

  const profile = {};
  const commands = detectFromDir(root);
  if (Object.keys(commands).length) profile.commands = commands;
  Object.assign(profile, presetFields(values.preset));

  const { errors } = validateProfile(profile);
  if (errors.length) throw new UsageError(`generated profile is invalid:\n  - ${errors.join('\n  - ')}`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(profile, null, 2) + '\n');
  output(ctx, values, {
    text: [`init: wrote ${rel}`, ...Object.entries(commands).map(([k, v]) => `${k}=${v}`)].join('\n'),
    data: { path: file, profile },
  });
  return 0;
}
