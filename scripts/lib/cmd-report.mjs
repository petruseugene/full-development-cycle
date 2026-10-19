// dev-cycle report [--feature <dir> | --all] [--out <dir>] [--json] [--no-network]
//
// Builds the report model (report-model.mjs), renders the index and one page
// per feature (report-html.mjs) into `<root>/.dev-cycle/report/` (self-ignored
// with `.gitignore` = `*`) and prints the index path. `--json` prints the model
// and also writes `report.json`. `--no-network` skips the `gh pr view` lookups.
// `--out` may not be the project root or an ancestor; an existing out dir
// outside `.dev-cycle/` keeps its `.gitignore` untouched (see outDirPolicy).

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, atomicWrite, featuresRoot, output, parseCommandArgs, resolveFeatureDir, resolveProjectRoot } from './core.mjs';
import { loadProfile } from './profile.mjs';
import { buildReportModel, listFeatureFolders } from './report-model.mjs';
import { renderFeature, renderIndex } from './report-html.mjs';
import { ensureSelfIgnore } from './visual-core.mjs';

const USAGE = 'report [--feature <dir> | --all] [--out <dir>] [--json] [--no-network]';
export const REPORT_REL = path.join('.dev-cycle', 'report');

/** Real path of `p`, resolving the deepest existing ancestor (p may not exist yet). */
function realish(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest.reverse());
    rest.push(path.basename(cur));
    cur = up;
  }
}

const isInside = (base, p) => {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

/**
 * Where the report may be written, and whether it may self-ignore (security W7).
 * - `--out` at the project root or any ancestor of it: UsageError.
 * - Under `<root>/.dev-cycle/`: self-ignore (`.gitignore` = `*`).
 * - A directory that does not exist yet: we create it, so we self-ignore it.
 * - An existing directory elsewhere: written to, its `.gitignore` is never touched.
 * @returns {{selfIgnore: boolean}}
 */
export function outDirPolicy(root, outDir) {
  const r = realish(root);
  const o = realish(outDir);
  if (isInside(o, r)) throw new UsageError(`--out ${outDir} is the project root or one of its ancestors; choose a dedicated directory`);
  if (isInside(path.join(r, '.dev-cycle'), o)) return { selfIgnore: true };
  return { selfIgnore: !fs.existsSync(outDir) };
}

export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: { all: { type: 'boolean' }, out: { type: 'string' }, 'no-network': { type: 'boolean' } },
  });
  if (values.all && values.feature) throw new UsageError(`--all and --feature are mutually exclusive (usage: dev-cycle ${USAGE})`);

  const root = resolveProjectRoot(ctx);
  const fRoot = featuresRoot(ctx);
  let only = null;
  if (values.feature) {
    const dir = resolveFeatureDir(ctx, values);
    only = path.basename(dir);
    if (!fs.existsSync(path.join(dir, 'feature.json'))) throw new UsageError(`no feature.json in ${dir}`);
  }
  const outDir = values.out ? path.resolve(ctx.cwd, values.out) : path.join(root, REPORT_REL);
  const { selfIgnore } = outDirPolicy(root, outDir);

  const { profile } = loadProfile(ctx, { quiet: true });
  const model = await buildReportModel({
    featuresRoot: fRoot,
    folders: listFeatureFolders(fRoot),
    projectRoot: root,
    profile,
    now: new Date(),
    noNetwork: Boolean(values['no-network']),
  });

  if (selfIgnore) ensureSelfIgnore(outDir);
  else fs.mkdirSync(outDir, { recursive: true });
  const pages = model.features.filter((f) => !only || f.folder === only);
  for (const f of pages) {
    atomicWrite(path.join(outDir, `${f.folder}.html`), renderFeature(f, { generated_at: model.generated_at }));
  }
  const indexPath = path.join(outDir, 'index.html');
  atomicWrite(indexPath, renderIndex(model));
  if (values.json) atomicWrite(path.join(outDir, 'report.json'), JSON.stringify(model, null, 2) + '\n');

  output(ctx, values, {
    text: `report: ${indexPath} (${pages.length} feature page${pages.length === 1 ? '' : 's'})`,
    data: model,
  });
}
