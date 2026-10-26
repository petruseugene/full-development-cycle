// dev-cycle tokens agent <id> [--session s] | tokens orchestrator [--session s]

import { UsageError, FailedError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { readFeatureJson, updateFeatureJson } from './feature-json.mjs';
import { ModelTotals, agentUsage, configRoot, findSessionFiles, sumUsageFile, usageNum, validateAgentId, validateSessionId } from './tokens.mjs';
import { estimateUsd, formatUsd } from './prices.mjs';

const USAGE = 'tokens agent <id> [--session s] | tokens orchestrator [--session s]';
const round1 = (x) => Math.round(x * 10) / 10;

function simple(u) {
  return { input: u.input, output: u.output, cache_read: u.cache_read, cache_write: u.cache_write };
}

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    positionals: ['verb', 'id?'],
    options: { session: { type: 'string' } },
  });
  const sid = values.session ?? ctx.env?.CLAUDE_CODE_SESSION_ID;
  const root = configRoot(ctx.env);

  if (args.verb === 'agent') {
    if (!args.id) throw new UsageError(`missing agent id (usage: dev-cycle ${USAGE})`);
    validateAgentId(args.id);
    if (!sid) throw new UsageError('no session id (use --session or CLAUDE_CODE_SESSION_ID)');
    validateSessionId(sid);
    const u = await agentUsage(root, sid, args.id);
    if (!u) throw new FailedError(`transcript for agent '${args.id}' not found`);
    const { usd_est, usd_unpriced } = estimateUsd(u.by_model);
    const tokens_k = round1((u.input + u.output + u.cache_write) / 1000);
    output(ctx, values, {
      text: `agent ${args.id}: input ${u.input}, output ${u.output}, cache_read ${u.cache_read}, cache_write ${u.cache_write} (${tokens_k}k) ${formatUsd(usd_est)}`,
      data: { agent_id: args.id, tokens: { ...simple(u), by_model: u.by_model, nested: u.nested }, usd_est, usd_unpriced, tokens_k },
    });
    return;
  }

  if (args.verb === 'orchestrator') {
    if (args.id) throw new UsageError(`unexpected argument '${args.id}' (usage: dev-cycle ${USAGE})`);
    if (sid) validateSessionId(sid);
    const dir = resolveFeatureDir(ctx, values);
    const fj = readFeatureJson(dir);
    const sessions = Array.isArray(fj.sessions) ? [...fj.sessions] : [];
    if (sid && !sessions.includes(sid)) sessions.push(sid);
    const from = fj.started_at || fj.history?.[0]?.ts;
    const to = new Date().toISOString();
    const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
    const models = new ModelTotals();
    for (const s of sessions) {
      let files;
      try { files = findSessionFiles(root, validateSessionId(s)).main; } catch { continue; }
      for (const f of files) {
        const r = await sumUsageFile(f, { filter: { sidechain: false, window: from ? [from, to] : [undefined, to] } });
        for (const k of Object.keys(total)) total[k] += usageNum(r[k]);
        models.addAll(r.by_model);
      }
    }
    const by_model = models.toObject();
    const { usd_est, usd_unpriced } = estimateUsd(by_model);
    const tokens_k = round1((total.input + total.output + total.cache_write) / 1000);
    const entry = {
      ts: to, phase: 'orchestrator', subagent: 'orchestrator', status: 'DONE', model: 'inherit', executor: 'cli',
      tokens: { ...simple(total), by_model }, estimated: false, usd_est, tokens_k,
    };
    if (usd_unpriced.length) entry.usd_unpriced = usd_unpriced;
    updateFeatureJson(dir, (f) => {
      f.sessions = sessions;
      const h = Array.isArray(f.history) ? f.history : [];
      const i = h.findIndex((e) => e.phase === 'orchestrator');
      if (i >= 0) h[i] = entry; else h.push(entry);
      f.history = h;
    });
    output(ctx, values, {
      text: `orchestrator: ${tokens_k}k tokens ${formatUsd(usd_est)}`,
      data: { added: entry },
    });
    return;
  }
  throw new UsageError(`unknown tokens verb '${args.verb}' (usage: dev-cycle ${USAGE})`);
}
