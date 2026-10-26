// dev-cycle map [--check] [--force] [--json] — generate/refresh .dev-cycle/map.md (spec R11).

import { parseCommandArgs, resolveProjectRoot } from './core.mjs';
import { MAP_REL, checkMap, refreshMap } from './map.mjs';

const USAGE = 'map [--check] [--force] [--json]';

function emit(ctx, values, text, data) {
  ctx.stdout.write(values.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
}

function fail2(ctx, values, text, data) {
  if (values.json) ctx.stdout.write(`${JSON.stringify(data)}\n`);
  ctx.stderr.write(`${text}\n`);
  return 2;
}

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: { check: { type: 'boolean' }, force: { type: 'boolean' } },
  });
  const root = resolveProjectRoot(ctx);

  if (values.check) {
    const res = await checkMap(root, { env: ctx.env });
    if (res.fresh) { emit(ctx, values, 'map: fresh', res); return 0; }
    const text = `map: stale — ${res.reason}`;
    if (res.reason === 'not a git repository') return fail2(ctx, values, text, res);
    emit(ctx, values, text, res);
    return 1;
  }

  const res = await refreshMap(root, { env: ctx.env, force: Boolean(values.force) });
  switch (res.status) {
    case 'invalid':
      emit(ctx, values, `map: FAILED ${MAP_REL} has no dev-cycle map header; fix or move it`, res);
      return 1;
    case 'too-large':
      emit(ctx, values, 'map: FAILED repository too large for map (git ls-files output over 4 MiB)', res);
      return 1;
    case 'skipped':
      return fail2(ctx, values, 'map: not a git repository with commits', res);
    default:
      emit(ctx, values, `map: ${res.status} ${MAP_REL}`, res);
      return 0;
  }
}
