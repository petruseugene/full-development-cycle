// dev-cycle profile validate | profile show [--json] | profile snapshot --feature <f>   (spec R15)

import { UsageError, output, parseCommandArgs, resolveFeatureDir, warn } from './core.mjs';
import { profileSnapshot } from './cmd-feature.mjs';
import { updateFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import { loadProfile, validateProfile } from './profile.mjs';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'profile validate | profile show [--json] | profile snapshot --feature <f>',
    positionals: ['verb'],
  });
  const verb = args.verb;
  if (verb !== 'validate' && verb !== 'show' && verb !== 'snapshot') {
    throw new UsageError(`unknown profile subcommand '${verb}' (usage: dev-cycle profile validate | profile show [--json] | profile snapshot --feature <f>)`);
  }
  const { exists, path: file, profile } = loadProfile(ctx);
  if (verb === 'snapshot') {
    if (!exists) throw new UsageError(`no project profile at ${file}`);
    const dir = resolveFeatureDir(ctx, values);
    const next = profileSnapshot(profile);
    let changed = [];
    updateFeatureJson(dir, (fj) => {
      const prev = fj.profile && typeof fj.profile === 'object' ? fj.profile : {};
      changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])]
        .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
      fj.profile = next;
    });
    const label = changed.length ? changed.join(', ') : 'no changes';
    appendHistory(dir, {
      phase: 'profile', subagent: 'cli', executor: 'cli', status: 'DONE',
      summary: `profile snapshot: ${label}`,
    });
    output(ctx, values, { text: `profile: snapshot refreshed (${label})`, data: { path: dir, changed } });
    return 0;
  }
  if (verb === 'validate') {
    const { warnings } = validateProfile(profile);
    for (const w of warnings.filter((m) => m.startsWith('protected skill'))) warn(ctx, w);
    output(ctx, values, {
      text: exists ? `profile OK: ${file}` : 'profile OK (no .dev-cycle/project.json; empty profile)',
      data: { valid: true, exists, path: file },
    });
    return 0;
  }
  output(ctx, values, {
    text: exists ? JSON.stringify(profile, null, 2) : '(no project profile)',
    data: { exists, path: file, profile },
  });
  return 0;
}
