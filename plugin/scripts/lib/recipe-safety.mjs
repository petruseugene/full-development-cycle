// Static checks for recipe templates and param patterns (spec R25).
// Shared by profile.mjs (validate time) and recipe.mjs (run time). No I/O.
//
// Trust model. The recipe `cmd` is trusted, owner-authored code (a malicious
// change could equally edit the script it calls). What the CLI guarantees is
// about param VALUES: they are validated and passed verbatim, each as exactly
// one argv element, to a program spawned with shell: false — never parsed by
// the CLI or by a shell it starts. The grammar below is a best-effort lint
// against obvious footguns, not a sandbox: a program that interprets its own
// arguments as code or a program path (`git -c {p}`, `make --eval={p}`,
// `vim -c {p}`, `rsync -e {p}`, `tar --to-command={p}`, `npx tsx {p}`) or
// that installs/runs a value-chosen package is the recipe author's
// responsibility. (npm/pnpm/yarn are rejected with placeholders because
// `npm run x -- {p}` re-parses the value in a shell.)
//
// The grammar:
//   - words are separated by ASCII spaces or tabs; only printable ASCII is
//     allowed (no newline, control, non-ASCII or Unicode space/format chars);
//   - none of  ; | & $ ` < > ( ) { } ' " \ * ? [ ] ~ #  may appear anywhere,
//     except `{name}` placeholders (so a cmd never looks like it needs a shell);
//   - a placeholder is a whole word (`{p}`) or the value of a `--flag={p}`
//     word; nothing else may be glued to it (`x{p}`, `{a}{b}`, `-f{p}`);
//   - argv[0] is a literal (never a placeholder, an option or `NAME=value`)
//     and not a shell (SHELL_RE: sh, bash, rbash, bash5, zsh-5.9, fish, …), a
//     command runner (RUNNERS: env, xargs, sudo, time, timeout, find, …) or a
//     shell builtin name (BUILTINS: read, export, printf, test, cd, …; macOS
//     ships some as `#!/bin/sh` wrappers) — call a script with a shebang
//     instead (`./scripts/gen.sh {p}`);
//   - when the cmd has placeholders and argv[0] is a plain program, its
//     literal non-option words are also checked for shells and runners
//     (wrappers such as `caffeinate`, `arch`, `xcrun` forward their args;
//     `.`/source/exec/eval/builtin count only as argv[0], so `git add . {p}`
//     is fine) up to the first interpreter word (INTERPRETERS: node, python3,
//     ruby, perl, npx, uv, sed, awk, expect, …). From an interpreter word to
//     its script word (first literal non-option word): no code/module flag
//     (EVAL_FLAG_RE: a single-dash option containing e, c, p or r in either
//     case, --eval, --print, --require, --import, …) and no placeholder; the
//     script word is not a code/package subcommand (eval, exec, x, dlx,
//     install, i, add, ci, tool, task), a shell or a runner; for uv, uvx,
//     pipx, bun and deno, `run` must be followed by a literal path-like script
//     (`uv run scripts/gen.py {p}`); a script word that is itself an
//     interpreter (`npx tsx x.ts`, `python3 -m pip …`) is checked again. Words
//     after the script word are the script's own args and are not checked
//     (`python3 tools/gen.py -p {k}` is fine). npm/pnpm/yarn take no
//     placeholders at all (script args go through a shell).
// Names are compared by basename, case-insensitively, without `.exe` and
// version suffixes (`/usr/bin/Python3.11` → python).

export const MAX_VALUE_LEN = 1024;
export const MAX_PATTERN_LEN = 256;

const PH_WORD_RE = /^\{([A-Za-z0-9_-]+)\}$/;
const FLAG_PH_WORD_RE = /^(--[A-Za-z0-9][A-Za-z0-9_.-]*=)\{([A-Za-z0-9_-]+)\}$/;
/** `NAME={p}` env assignment, allowed only as the word right after a literal `-e` / `--env`. */
const ENV_PH_WORD_RE = /^([A-Z_][A-Z0-9_]*=)\{([A-Za-z0-9_-]+)\}$/;
const ENV_FLAGS = new Set(['-e', '--env']);
const PH_ANY_RE = /\{[A-Za-z0-9_-]+\}/g;
/** Characters a shell would treat specially; never allowed in a recipe cmd. */
export const FORBIDDEN_CHARS = ';|&$`<>(){}\'"\\*?[]~#';
const FORBIDDEN_RE = /[;|&$`<>(){}'"\\*?[\]~#]/;
/** Anything but tab and printable ASCII: newlines, controls, non-ASCII, Unicode spaces/format chars. */
const NON_PRINTABLE_RE = /[^\t\x20-\x7e]/;

/** Shell names by stem: sh, bash, rbash, bash5, zsh-5.9, dash, ksh, mksh, ash, fish, csh, tcsh, yash, posh, oksh, … */
export const SHELL_RE = /^(?:r?(?:ba|z|da|k|mk|a|fi|c|tc|ya|po|ok|lok)?sh|elvish|nu|xonsh|busybox|toybox)$/;
/** Commands that run their arguments as a command. */
/** Runner names that are shell builtins: rejected as argv[0] only (`git add . {p}` stays valid). */
const ARGV0_ONLY_RUNNERS = new Set(['.', 'source', 'exec', 'eval', 'builtin']);
export const RUNNERS = Object.freeze([
  'env', 'command', 'builtin', 'exec', 'eval', 'source', '.', 'xargs', 'sudo', 'doas', 'su', 'runuser',
  'nohup', 'time', 'nice', 'ionice', 'timeout', 'watch', 'find', 'chroot', 'setsid', 'stdbuf',
  'unbuffer', 'script', 'ssh', 'parallel', 'flock', 'cmd', 'strace', 'ltrace', 'gdb',
  'cross-env', 'dotenv', 'env-cmd', 'direnv',
]);
/**
 * Shell builtin names, rejected as argv[0] only (so `npm run test` stays
 * valid). Some systems ship them as `#!/bin/sh` wrappers: macOS
 * /usr/bin/read runs `builtin read "$@"`, so `read 'a[$(cmd)]'` runs cmd.
 */
export const BUILTINS = Object.freeze([
  'alias', 'unalias', 'bg', 'fg', 'jobs', 'wait', 'cd', 'fc', 'getopts', 'hash', 'read', 'type',
  'ulimit', 'umask', 'export', 'local', 'readonly', 'set', 'unset', 'shift', 'mapfile', 'readarray',
  'let', 'declare', 'typeset', 'trap', 'printf', 'test',
]);
/** Programs that run code given on their command line (see EVAL_FLAG_RE / script position). */
export const INTERPRETERS = Object.freeze([
  'node', 'nodejs', 'deno', 'bun', 'bunx', 'tsx', 'ts-node', 'npx', 'pnpx', 'npm', 'pnpm', 'yarn',
  'python', 'pypy', 'pip', 'uv', 'uvx', 'pipx', 'ruby', 'irb', 'perl', 'php', 'lua', 'luajit', 'rscript',
  'julia', 'awk', 'gawk', 'mawk', 'nawk', 'sed', 'groovy', 'jshell', 'expect', 'tclsh', 'wish',
  'swift', 'dc', 'bc', 'osascript', 'pwsh', 'powershell',
]);
/** Literal words that make an interpreter evaluate or load code. */
export const EVAL_FLAG_RE = /^(?:-[A-Za-z]*[ecprECPR][A-Za-z]*|--(?:eval|print|command|exec|require|import|loader|experimental-loader|input-type)(?:=.*)?)$/;
/** Script-position words that run code, a program or a package chosen by the next word. */
const EVAL_SUBCOMMANDS = new Set(['eval', 'exec', 'x', 'dlx', 'install', 'i', 'add', 'ci', 'tool', 'task']);
/** For these, `run` must be followed by a literal path-like script (`uv run scripts/gen.py {p}`). */
const RUN_FILE_RUNNERS = new Set(['uv', 'uvx', 'pipx', 'bun', 'bunx', 'deno']);
/** A script operand that is clearly a file path, not a program/package name. */
const SCRIPT_PATH_RE = /\/|\.(?:py|pyw|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
/** Package managers hand extra args to a package script through a shell: no placeholders at all. */
const SCRIPT_SHELL_RUNNERS = new Set(['npm', 'pnpm', 'yarn']);

/** Normalised basename and its stem without version suffix: `/usr/bin/Python3.11.exe` → python3.11 / python. */
function names(word) {
  const base = word.split('/').pop().toLowerCase().replace(/\.exe$/, '');
  const stem = base.replace(/[-.\d]+$/, '');
  return { base, stem };
}

/** Classify a literal word: 'shell' | 'runner' | 'builtin' | 'interpreter' | 'plain'. */
function commandKind(word) {
  const { base, stem } = names(word);
  if (SHELL_RE.test(base) || SHELL_RE.test(stem)) return { base, stem, kind: 'shell' };
  if (RUNNERS.includes(base) || RUNNERS.includes(stem)) return { base, stem, kind: 'runner' };
  if (BUILTINS.includes(base)) return { base, stem, kind: 'builtin' };
  if (INTERPRETERS.includes(base) || INTERPRETERS.includes(stem)) return { base, stem, kind: 'interpreter' };
  return { base, stem, kind: 'plain' };
}

/** Index of the first literal non-option word after `from`, or -1. */
function nextOperand(words, from) {
  for (let i = from + 1; i < words.length; i++) if ('lit' in words[i] && !words[i].lit.startsWith('-')) return i;
  return -1;
}

/** Code-flag and placeholder checks for the option words between `from` and `to` (exclusive). */
function optionProblems(words, from, to, base, scriptWhat) {
  const problems = [];
  for (let i = from + 1; i < to; i++) {
    const w = words[i];
    const word = 'lit' in w ? w.lit : w.prefix.slice(0, -1);
    if (EVAL_FLAG_RE.test(word)) problems.push(`'${base}' evaluates code with '${word}': placeholders are not allowed in such a cmd`);
    if ('ph' in w) problems.push(`placeholder {${w.ph}} comes before the ${scriptWhat} of '${base}': name it as a literal word first`);
  }
  return problems;
}

/**
 * Interpreter rules from words[at] (an interpreter) up to its script word.
 * Words after the script word are the script's own args and are not checked;
 * when the script word is itself an interpreter or runner (`npx tsx x.ts`,
 * `python3 -m pip install`), the rules apply again from there.
 */
function interpreterProblems(words, at) {
  const { base, stem } = names(words[at].lit);
  if (SCRIPT_SHELL_RUNNERS.has(stem)) {
    return [`'${base}' passes extra args to package scripts through a shell: placeholders are not allowed; call the script's program directly (node scripts/x.mjs {p})`];
  }
  const script = nextOperand(words, at);
  const problems = optionProblems(words, at, script === -1 ? words.length : script, base, 'script argument');
  if (script === -1) return problems;
  const sw = words[script].lit;
  const sub = sw.toLowerCase();
  if (EVAL_SUBCOMMANDS.has(sub)) {
    problems.push(`'${base} ${sw}' runs code, a program or a package: placeholders are not allowed in such a cmd`);
    return problems;
  }
  if (sub === 'run' && RUN_FILE_RUNNERS.has(stem)) {
    const file = nextOperand(words, script);
    problems.push(...optionProblems(words, script, file === -1 ? words.length : file, `${base} run`, 'script path'));
    if (file === -1 || !SCRIPT_PATH_RE.test(words[file].lit)) {
      problems.push(`'${base} run' must be followed by a literal script path (contains / or ends in .py/.ts/.js/.mjs/…) when the cmd has placeholders`);
    }
    return problems;
  }
  const k = commandKind(sw);
  if (k.kind === 'shell' || k.kind === 'runner') {
    problems.push(`'${base}' runs '${k.base}', a shell or command runner: placeholders are not allowed in such a cmd`);
  } else if (k.kind === 'interpreter') {
    problems.push(...interpreterProblems(words, script));
  }
  return problems;
}

/**
 * Parse a recipe cmd into argv template words (see the grammar above).
 * Word shapes: `{lit}` for a literal, `{ph, prefix}` for a placeholder (prefix
 * is `''` for a bare `{p}`, `--flag=` for `--flag={p}`, `NAME=` for the env
 * assignment `-e NAME={p}` / `--env NAME={p}`, which is allowed only right
 * after a literal `-e` or `--env`; the value stays one argv element and an
 * interpreter's `-e` is still refused by the interpreter rules).
 * @param {string} cmd
 * @returns {{words: Array<{lit: string}|{ph: string, prefix: string}>, problems: string[]}}
 */
export function parseRecipeCmd(cmd) {
  const problems = [];
  if (typeof cmd !== 'string' || cmd.trim() === '') return { words: [], problems: ['cmd must be a non-empty string'] };
  if (NON_PRINTABLE_RE.test(cmd)) {
    problems.push('contains a newline, control, non-ASCII or Unicode space/format character (one command per recipe; printable ASCII words separated by spaces)');
  }
  const bare = cmd.replace(PH_ANY_RE, '');
  const bad = [...new Set([...bare].filter((c) => FORBIDDEN_RE.test(c)))];
  if (bad.length) {
    problems.push(`contains shell syntax ${bad.map((c) => `'${c}'`).join(' ')}: recipes run without a shell, as plain space-separated argv words (only {param} placeholders are special)`);
  }
  const words = [];
  for (const w of cmd.trim().split(/[ \t]+/)) {
    let m = PH_WORD_RE.exec(w);
    if (m) { words.push({ ph: m[1], prefix: '' }); continue; }
    m = FLAG_PH_WORD_RE.exec(w);
    if (m) { words.push({ ph: m[2], prefix: m[1] }); continue; }
    const prev = words[words.length - 1];
    m = ENV_PH_WORD_RE.exec(w);
    if (m && prev && 'lit' in prev && ENV_FLAGS.has(prev.lit)) { words.push({ ph: m[2], prefix: m[1] }); continue; }
    const glued = w.match(PH_ANY_RE);
    if (glued) {
      problems.push(`placeholder ${glued[0]} is glued into the word '${w}': a placeholder must be a whole word {p} or the value of --flag={p}`);
      continue;
    }
    words.push({ lit: w });
  }
  if (problems.length) return { words, problems };

  const [first] = words;
  if (!('lit' in first)) return { words, problems: [`the command (argv[0]) must be a literal program, not the placeholder {${first.ph}}`] };
  if (first.lit.startsWith('-') || first.lit.includes('=')) {
    return { words, problems: [`the command (argv[0]) '${first.lit}' must be a program path (no options or NAME=value assignments)`] };
  }
  const head = commandKind(first.lit);
  if (head.kind === 'shell' || head.kind === 'runner' || head.kind === 'builtin') {
    return { words, problems: [`the command '${head.base}' is a shell, a shell builtin or runs its arguments as a command; call the program (or a script with a shebang) directly`] };
  }
  if (!words.some((w) => 'ph' in w)) return { words, problems };

  // With placeholders: scan the literal non-option words after a plain argv[0]
  // (wrappers such as caffeinate forward their args) up to the first
  // interpreter word; from there the interpreter rules take over, and they
  // stop at its script word (later words are the script's own args).
  if (head.kind === 'interpreter') {
    problems.push(...interpreterProblems(words, 0));
    return { words, problems };
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!('lit' in w) || w.lit.startsWith('-')) continue;
    const k = commandKind(w.lit);
    if (k.kind === 'shell' || (k.kind === 'runner' && !ARGV0_ONLY_RUNNERS.has(k.stem) && !ARGV0_ONLY_RUNNERS.has(k.base))) {
      problems.push(`'${k.base}' is a shell or runs its arguments as a command, and '${first.lit}' may forward to it: placeholders are not allowed in such a cmd`);
    } else if (k.kind === 'interpreter') {
      problems.push(...interpreterProblems(words, i));
      break;
    }
  }
  return { words, problems };
}

/** Every grammar problem of a recipe cmd (empty when it is valid). */
export function cmdProblems(cmd) {
  return parseRecipeCmd(cmd).problems;
}

/** First atom of a regex alternative: one char, or an escape pair. */
function firstAtom(alt) {
  return alt[0] === '\\' ? alt.slice(0, 2) : alt[0];
}

/**
 * Alternatives of a group body (top-level `|` only) that may overlap: two
 * alternatives start with the same atom, or one is empty or starts with
 * something whose overlap we cannot judge cheaply (`.`, `[`, `(`, a class
 * escape such as `\w`). `a|b` is fine; `a|aa`, `a|a`, `.|x`, `\w|_` are not.
 */
function alternativesOverlap(body) {
  const alts = [];
  let depth = 0; let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { cur += body.slice(i, i + 2); i++; continue; }
    if (c === '[') {
      let j = i + 1;
      if (body[j] === '^') j++;
      if (body[j] === ']') j++;
      while (j < body.length && body[j] !== ']') { if (body[j] === '\\') j++; j++; }
      cur += body.slice(i, j + 1); i = j; continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  alts.push(cur);
  if (alts.length < 2) return false;
  const seen = new Set();
  for (const a of alts) {
    if (a === '') return true;
    const atom = firstAtom(a);
    if (/^(?:[.[(]|\\[dDwWsSbBpPu])/.test(atom)) return true;
    if (seen.has(atom)) return true;
    seen.add(atom);
  }
  return false;
}

/**
 * Heuristic catastrophic-backtracking check. Returns a reason or null when a
 * group followed by a repeating quantifier (`*`, `+`, `{n,…}`):
 *   - itself contains a quantifier — nested quantifiers: `(a+)+`,
 *     `(?:a|b*)*`, `((ab)*c)+`;
 *   - or contains `|` alternatives that may overlap — `(a|aa)+`, `(a|a)*`.
 * Character classes and escapes are skipped.
 */
export function redosRisk(pattern) {
  const stack = []; // each: {start, quant, overlap}
  let last = null; // the group that just closed: {quant, overlap}
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; last = null; continue; }
    if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') { if (pattern[i] === '\\') i++; i++; }
      last = null;
      continue;
    }
    const isQuant = c === '*' || c === '+' || (c === '{' && /^\{\d*,?\d*\}/.test(pattern.slice(i)));
    if (isQuant) {
      const repeats = c !== '{' || !/^\{(?:0|1|0,1)\}/.test(pattern.slice(i));
      if (last && repeats) {
        if (last.quant) return 'has a nested quantifier such as (a+)+ (catastrophic backtracking)';
        if (last.overlap) return 'has overlapping alternatives under a quantifier such as (a|aa)+ (catastrophic backtracking)';
      }
      if (stack.length) stack[stack.length - 1].quant = true;
      last = null;
      continue;
    }
    if (c === '(') { stack.push({ start: i, quant: false, overlap: false }); last = null; continue; }
    if (c === ')') {
      const g = stack.pop();
      if (!g) { last = null; continue; }
      const body = pattern.slice(g.start + 1, i).replace(/^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/, '');
      g.overlap = g.overlap || alternativesOverlap(body);
      last = { quant: g.quant, overlap: g.overlap };
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.quant = parent.quant || g.quant;
        parent.overlap = parent.overlap || g.overlap;
      }
      continue;
    }
    if (c !== '?') last = null;
  }
  return null;
}

/** True when `redosRisk` finds a nested quantifier (kept for callers/tests). */
export function hasNestedQuantifier(pattern) {
  return /nested quantifier/.test(redosRisk(pattern) ?? '');
}

/** Why `pattern` is not an acceptable param pattern, or null. */
export function patternProblem(pattern) {
  if (typeof pattern !== 'string') return 'must be a string';
  if (pattern === '') return 'must not be empty';
  if (pattern.length > MAX_PATTERN_LEN) return `is ${pattern.length} chars (max ${MAX_PATTERN_LEN})`;
  try { new RegExp(`^(?:${pattern})$`); } catch { return 'is not a valid regex'; }
  const risk = redosRisk(pattern);
  if (risk) return risk;
  return null;
}
