// dev-cycle profile validate | profile show [--json]   (spec R15)

import { UsageError, output, parseCommandArgs, warn } from './core.mjs';
import { loadProfile, validateProfile } from './profile.mjs';

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'profile validate | profile show [--json]',
    positionals: ['verb'],
  });
  const verb = args.verb;
  if (verb !== 'validate' && verb !== 'show') {
    throw new UsageError(`unknown profile subcommand '${verb}' (usage: dev-cycle profile validate | profile show [--json])`);
  }
  const { exists, path: file, profile } = loadProfile(ctx);
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
