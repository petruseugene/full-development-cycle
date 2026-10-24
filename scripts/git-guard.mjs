#!/usr/bin/env node
// PreToolUse hook (matcher: Bash). Denies state-changing git commands issued
// by subagents (stdin has a non-empty `agent_id`), so parallel implementers do
// not clobber each other's working tree. This is a best-effort guard against
// accidents, not a security boundary: it is a hand-written tokenizer and can
// be bypassed by anyone determined. It fails open on any error or unknown input.
// Escape hatch: a simple command prefixed with `DEV_CYCLE_GIT_FALLBACK=1 ` is allowed
// (only that command, not later ones in a chain).
import fs from 'node:fs';

const DENY_VERBS = new Set([
  'checkout', 'switch', 'reset', 'restore', 'commit', 'rebase', 'merge', 'clean',
  'cherry-pick', 'revert', 'am', 'pull', 'push', 'update-ref', 'add', 'stage',
  'mv', 'update-index',
]);
// Long options of `git apply` / `git rm`: git accepts any unique prefix, so a prefix of a
// target option that is not a prefix of another option is treated as that option.
const APPLY_OPTS = ['stat', 'numstat', 'summary', 'check', 'index', 'cached', 'intent-to-add', '3way', 'apply', 'no-add',
  'build-fake-ancestor', 'reverse', 'allow-binary-replacement', 'binary', 'reject', 'inaccurate-eof', 'recount', 'directory',
  'unsafe-paths', 'exclude', 'include', 'ignore-space-change', 'ignore-whitespace', 'whitespace', 'verbose', 'quiet',
  'unidiff-zero', 'allow-overlap'];
const RM_OPTS = ['dry-run', 'quiet', 'cached', 'force', 'ignore-unmatch', 'sparse', 'pathspec-from-file', 'pathspec-file-nul'];

function hasLongOpt(args, all, targets) {
  for (const x of args) {
    if (x === '--') return false;
    if (!x.startsWith('--')) continue;
    const name = x.slice(2).split('=')[0];
    if (!name) continue;
    for (const t of targets) {
      if (name === t) return true;
      if (t.startsWith(name) && !all.some((o) => o !== t && o.startsWith(name))) return true;
    }
  }
  return false;
}

// Short-option clusters (`-3v`): scan flags until one that takes a value (-p, -C).
function hasShortFlag(args, flags) {
  for (const x of args) {
    if (x === '--') return false;
    if (!/^-[^-]/.test(x)) continue;
    for (const ch of x.slice(1)) {
      if (ch === 'p' || ch === 'C') break;
      if (flags.includes(ch)) return true;
    }
  }
  return false;
}

const GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const MAX_DEPTH = 4;

// Split a shell string into simple commands (arrays of unquoted words).
function parse(str, depth = 0) {
  const cmds = [];
  let words = [];
  let buf = '';
  let has = false; // a word (possibly empty, quoted) is in progress
  let redir = false; // the next word is a redirect target: not an argument
  const endWord = () => {
    if (has) { if (redir) redir = false; else words.push(buf); }
    buf = ''; has = false;
  };
  const endCmd = () => { endWord(); redir = false; if (words.length) cmds.push(words); words = []; };
  const n = str.length;
  let i = 0;
  while (i < n) {
    const c = str[i];
    if (c === '\\') { if (i + 1 < n) { buf += str[i + 1]; has = true; } i += 2; continue; }
    if (c === "'") {
      const j = str.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      buf += str.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++; has = true;
      while (i < n && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < n) { buf += str[i + 1]; i += 2; continue; }
        if ((str[i] === '$' && str[i + 1] === '(') || str[i] === '`') {
          const open = str[i] === '`' ? '`' : '(';
          const start = i + (open === '`' ? 1 : 2);
          let j = start; let lvl = 1;
          while (j < n) {
            if (open === '`') { if (str[j] === '`') break; }
            else if (str[j] === '(') lvl++;
            else if (str[j] === ')' && --lvl === 0) break;
            j++;
          }
          if (depth < MAX_DEPTH) cmds.push(...parse(str.slice(start, j), depth + 1));
          i = j + 1; continue;
        }
        buf += str[i]; i++;
      }
      i++; continue;
    }
    if (c === '#' && !has && (i === 0 || /\s|[;&|(]/.test(str[i - 1]))) {
      while (i < n && str[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') { endCmd(); i++; continue; }
    if (c === '$' && str[i + 1] === '(') { endCmd(); i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '>' || c === '<') {
      // Redirect glued to a word (`git stash>/dev/null`, `git checkout 2>&1`): split it off.
      if (has && /^\d+$/.test(buf) && !redir) { buf = ''; has = false; } // fd number (`2>`)
      else endWord();
      while (i < n && (str[i] === '>' || str[i] === '<')) i++;
      if (str[i] === '&') i++;
      redir = true;
      continue;
    }
    buf += c; has = true; i++;
  }
  endCmd();
  return cmds;
}

const base = (w) => w.slice(w.lastIndexOf('/') + 1);
const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

// Return a blocked label for one simple command, or null.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'exec', 'command', 'builtin', 'nohup', 'sudo', 'nice', 'xargs', 'timeout', 'env']);
const OPT_ARG = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};

function check(words, depth, first = false) {
  let k = 0;
  for (;;) {
    while (k < words.length && isAssign(words[k])) {
      if (first && words[k] === 'DEV_CYCLE_GIT_FALLBACK=1') return null; // exempts only the leading simple command
      k++;
    }
    if (k >= words.length) return null;
    const w = base(words[k]);
    if (!KEYWORDS.has(w)) break;
    k++;
    const optArg = OPT_ARG[w];
    if (optArg) {
      while (k < words.length && (words[k].startsWith('-') || (w === 'env' && isAssign(words[k])))) {
        k += optArg.has(words[k]) ? 2 : 1;
      }
      if (w === 'timeout') k++; // duration
    }
  }
  if (k >= words.length) return null;
  const head = base(words[k]);
  const rest = words.slice(k + 1);

  if (head === 'eval') return depth < MAX_DEPTH ? scan(rest.join(' '), depth + 1) : null;
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(head)) {
    if (depth >= MAX_DEPTH) return null;
    for (let j = 0; j < rest.length; j++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(rest[j]) && rest[j + 1] !== undefined) return scan(rest[j + 1], depth + 1);
    }
    return null;
  }
  if (head === 'node') {
    const j = rest.findIndex((x) => base(x) === 'dev-cycle.mjs');
    if (j >= 0 && ['git', 'ship'].includes(rest[j + 1])) return `dev-cycle ${rest[j + 1]}`;
    return null;
  }
  if (head !== 'git') return null;

  let a = 0;
  while (a < rest.length && rest[a].startsWith('-')) {
    a += GLOBAL_WITH_ARG.has(rest[a]) ? 2 : 1;
  }
  const verb = rest[a];
  if (!verb) return null;
  const args = rest.slice(a + 1);
  if (DENY_VERBS.has(verb)) return verb;
  switch (verb) {
    case 'apply':
      return hasLongOpt(args, APPLY_OPTS, ['cached', 'index', '3way', 'intent-to-add']) || hasShortFlag(args, ['3', 'N']) ? 'apply --cached' : null;
    case 'rm': return hasLongOpt(args, RM_OPTS, ['cached']) ? 'rm --cached' : null;
    case 'stash': return ['list', 'show'].includes(args[0]) ? null : 'stash';
    case 'worktree': return args[0] === 'list' ? null : 'worktree';
    case 'tag': {
      const readOnly = args.length === 0 || args.some((x) => /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|-v|--verify)/.test(x));
      return readOnly && !args.some((x) => /^(-d|--delete|-f|--force|-a|-s|-m)/.test(x)) ? null : 'tag';
    }
    case 'branch': {
      if (args.some((x) => /^(-[dDmMcCfu]+|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--edit-description)/.test(x))) return 'branch';
      const listing = args.some((x) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)/.test(x));
      return !listing && args.some((x) => !x.startsWith('-')) ? 'branch' : null;
    }
    default: return null;
  }
}

function scan(str, depth = 0) {
  const cmds = parse(str);
  for (let i = 0; i < cmds.length; i++) {
    const hit = check(cmds[i], depth, depth === 0 && i === 0);
    if (hit) return hit;
  }
  return null;
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') return;
  if (typeof input.agent_id !== 'string' || !input.agent_id) return;
  if (input.tool_name !== 'Bash') return;
  const cmd = input.tool_input && input.tool_input.command;
  if (typeof cmd !== 'string' || !cmd) return;
  const verb = scan(cmd);
  if (!verb) return;
  const reason = `Blocked: "git ${verb}" is orchestrator-only. Subagents must not change git state; do not retry. `
    + 'Report it to the orchestrator instead: put the need under `concerns:` (or `blocker:`) in your YAML report and continue with read-only git.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

try { main(); } catch { /* fail open */ }
