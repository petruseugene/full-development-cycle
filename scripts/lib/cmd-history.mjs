// dev-cycle history add --phase --subagent --status [--model] [--duration] [--tokens] [--summary] [--concerns]

import { UsageError, output, parseCommandArgs, resolveFeatureDir, warn } from './core.mjs';
import { agentTimeRange, agentUsage, configRoot, normIso, validateAgentId, validateSessionId } from './tokens.mjs';
import { estimateUsd } from './prices.mjs';
import { loadProfile } from './profile.mjs';
import { NO_AGENT_ID_MESSAGE, isDispatchedEntry } from './token-coverage.mjs';
import { sanitizeItemText } from './polish.mjs';
import { gateState, isImplementGate } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { appendHistory, isValidPhase, parseDuration, parseTokens } from './history.mjs';

const USAGE = 'history resolve --phase <implement gate> --by review|owner|fix --note <text>\n  history add --phase <p> --subagent <s> --status <st> [--model m] [--duration d] [--tokens t] [--summary s] [--concerns c] [--agent-id id] [--session id]';

function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

const BY = ['review', 'owner', 'fix'];
const NOTE_MAX = 300;

function resolve(values, ctx) {
  const { phase } = values;
  if (!isImplementGate(phase)) throw new UsageError(`history resolve: --phase must be an implement gate (implement, implement.task=<n>, implement.area=<name>), got '${phase}'`);
  if (!BY.includes(values.by)) throw new UsageError(`history resolve: --by must be one of ${BY.join('|')}`);
  const note = sanitizeItemText(values.note ?? '', NOTE_MAX);
  if (note === '') throw new UsageError('history resolve: --note is required (non-empty after sanitizing)');
  const dir = resolveFeatureDir(ctx, values);
  const st = gateState(readFeatureJson(dir).history, phase);
  if (st.status !== 'DONE_WITH_CONCERNS') {
    throw new UsageError(`history resolve: ${phase} last status is ${st.status}; only DONE_WITH_CONCERNS can be resolved`);
  }
  // executor 'cli' keeps it out of totals (calls, time, tokens): not an implementer run.
  const added = appendHistory(dir, { phase, subagent: 'orchestrator', status: 'RESOLVED', executor: 'cli', summary: note, resolved_by: values.by });
  output(ctx, values, { text: `history: ${added.phase} orchestrator RESOLVED (by ${values.by})`, data: { added } });
}

export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    positionals: ['verb'],
    options: {
      phase: { type: 'string', required: true },
      subagent: { type: 'string' },
      status: { type: 'string' },
      by: { type: 'string' },
      note: { type: 'string' },
      model: { type: 'string' },
      duration: { type: 'string' },
      tokens: { type: 'string' },
      summary: { type: 'string' },
      concerns: { type: 'string' },
      'agent-id': { type: 'string' },
      session: { type: 'string' },
    },
  });
  if (args.verb === 'resolve') return resolve(values, ctx);
  if (args.verb !== 'add') throw new UsageError(`unknown history verb '${args.verb}' (usage: dev-cycle ${USAGE})`);
  if (!isValidPhase(values.phase)) throw new UsageError(`invalid --phase '${values.phase}'`);
  for (const k of ['subagent', 'status']) if (values[k] === undefined) throw new UsageError(`history add: --${k} is required (usage: dev-cycle ${USAGE})`);

  const entry = { phase: values.phase, subagent: values.subagent, status: values.status };
  if (values.model) entry.model = values.model;
  if (values.duration !== undefined) entry.duration_s = parseDuration(values.duration);
  if (values.tokens !== undefined) entry.tokens_k = parseTokens(values.tokens);
  if (values.summary !== undefined) entry.summary = values.summary;
  if (values.concerns !== undefined) entry.concerns = values.concerns;

  const agentId = values['agent-id'];
  const missingAgentId = agentId === undefined && isDispatchedEntry(entry);
  if (missingAgentId) {
    let strict = false;
    try { strict = loadProfile(ctx, { quiet: true }).profile?.strict_tokens === true; } catch (e) {
      if (!(e instanceof UsageError)) throw e; // a broken profile means strict_tokens = false
    }
    if (strict) {
      throw new UsageError(`${NO_AGENT_ID_MESSAGE} (strict_tokens)`);
    }
    warn(ctx, NO_AGENT_ID_MESSAGE);
  }
  if (agentId !== undefined) {
    validateAgentId(agentId);
    const sid = values.session ?? ctx.env?.CLAUDE_CODE_SESSION_ID;
    if (values.session !== undefined) validateSessionId(values.session);
    let usage = null;
    let range = null;
    if (sid) {
      validateSessionId(sid);
      usage = await agentUsage(configRoot(ctx.env), sid, agentId);
      range = await agentTimeRange(configRoot(ctx.env), sid, agentId);
    }
    if (range) {
      // Store only canonical ISO strings; drop anything that does not normalise (security W6).
      const a = normIso(range.started_at);
      const b = normIso(range.ended_at);
      if (a && b) { entry.started_at = a; entry.ended_at = b; }
    }
    if (usage) {
      const keys = ['input', 'output', 'cache_read', 'cache_write'];
      // fromEntries defines own keys, so a `__proto__` model id stays data (security S6).
      const by_model = Object.fromEntries(Object.entries(usage.by_model).map(([m, u]) => [m, pick(u, [...keys, 'cache_write_1h'])]));
      const tokens = { ...pick(usage, keys), by_model };
      if (usage.nested?.length) tokens.nested = usage.nested;
      const { usd_est, usd_unpriced } = estimateUsd(usage.by_model);
      entry.agent_id = agentId;
      entry.tokens = tokens;
      entry.estimated = false;
      const top = Object.entries(usage.by_model).sort((a, b) => b[1].output - a[1].output)[0];
      if (top) entry.model_id = top[0];
      entry.usd_est = usd_est;
      if (usd_unpriced.length) entry.usd_unpriced = usd_unpriced;
      entry.tokens_k = Math.round(((usage.input + usage.output + usage.cache_write) / 1000) * 10) / 10;
    } else {
      warn(ctx, `transcript for agent '${agentId}' not found; using --tokens estimate`);
      entry.agent_id = agentId;
      if (entry.tokens_k !== undefined) entry.estimated = true;
    }
  }

  const dir = resolveFeatureDir(ctx, values);
  const added = appendHistory(dir, entry);
  output(ctx, values, {
    text: `history: ${added.phase} ${added.subagent} ${added.status}`,
    data: { added },
  });
}
