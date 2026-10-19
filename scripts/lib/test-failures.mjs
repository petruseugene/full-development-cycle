// Extract failing-test blocks from test runner output (TAP `not ok`, `✖`, `FAIL`)
// and split them into failures in touched files vs elsewhere.

const DEFAULT_TAIL = 30;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** Lines after `i` that belong to a block started at indent `base`. */
function takeIndented(lines, i, base, cap) {
  const out = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') {
      // a blank line ends the block unless more indented lines follow
      if (j + 1 < lines.length && lines[j + 1].trim() !== '' && indentOf(lines[j + 1]) > base) continue;
      break;
    }
    if (indentOf(l) <= base) break;
    out.push(l);
  }
  return { body: out.slice(0, cap), end: j };
}

/**
 * @param {string} text  runner output
 * @param {{tail?: number}} [opts]  tail = max lines kept per block
 * @returns {Array<{kind: 'tap'|'cross'|'fail', title: string, text: string}>}
 */
export function extractFailures(text, { tail = DEFAULT_TAIL } = {}) {
  const cap = Math.max(1, tail || DEFAULT_TAIL);
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks = [];
  const seen = new Set();
  const push = (kind, title, head, body) => {
    const t = [head, ...body].join('\n');
    if (kind === 'tap' && /failureType:\s*'?subtestsFailed'?/.test(t)) return; // parent of failing subtests
    // parent of failing subtests in the spec/dot reporter: `✖ suite` whose only body is '<n> subtest(s) failed'
    if (kind === 'cross' && body.length > 0 && body.every((l) => /^\s*'?\d+ subtests? failed'?\s*$/.test(l))) return;
    if (seen.has(t)) return;
    seen.add(t);
    blocks.push({ kind, title, text: t });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^(\s*)not ok\b(.*)$/.exec(line))) {
      const base = m[1].length;
      const { body, end } = takeIndented(lines, i, base, cap);
      if (!/#\s*(SKIP|TODO)\b/i.test(line)) push('tap', m[2].trim(), line, body);
      i = Math.max(i, end - 1);
    } else if ((m = /^(\s*)✖\s+(.*)$/.exec(line))) {
      if (/^failing tests:?\s*$/.test(m[2])) continue;
      const base = m[1].length;
      const { body, end } = takeIndented(lines, i, base, cap);
      const prev = i > 0 && /^\s*test at\s/.test(lines[i - 1]) ? [lines[i - 1]] : [];
      push('cross', m[2].trim(), [...prev, line].join('\n'), body);
      i = Math.max(i, end - 1);
    } else if ((m = /^(\s*)FAIL\b\s*(.*)$/.exec(line))) {
      const base = m[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length && body.length < cap; j++) {
        const l = lines[j];
        if (/^\s*(PASS|FAIL)\b/.test(l) && indentOf(l) <= base) break;
        if (/^\s*(Test Suites|Tests|Snapshots|Time):/.test(l)) break;
        body.push(l);
      }
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      push('fail', m[2].trim(), line, body);
      i = Math.max(i, j - 1);
    }
  }
  return blocks;
}

function normPath(p) {
  return String(p).replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '');
}

function globToRe(glob) {
  const re = normPath(glob)
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`(?:^|/)${re}$`);
}

function stemOf(file) {
  const base = normPath(file).split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '');
}

function isTestName(file) {
  return /(^|[._-])(test|spec)([._-]|$)|^test_|_test\./i.test(normPath(file).split('/').pop() ?? '');
}

function pathTokens(text) {
  return (String(text).match(/[\w@.~/\\:-]*[\w@-]\.[A-Za-z0-9]{1,6}(?::\d+){0,2}/g) ?? []).map(normPath);
}

/** True when a block names a touched path, or a test file of a touched source file. */
function isTouched(block, touched) {
  const tokens = pathTokens(block.text);
  return touched.some((raw) => {
    const f = normPath(raw);
    const isGlob = /[*?]/.test(f);
    const re = isGlob ? globToRe(f) : null;
    const stem = isGlob ? null : stemOf(f);
    return tokens.some((t) => {
      if (isGlob) return re.test(t);
      if (t === f || t.endsWith(`/${f}`)) return true;
      return stem !== '' && isTestName(t) && stemOf(t) === stem;
    });
  });
}

/**
 * Split blocks into failures in touched files and failures elsewhere.
 * @returns {{touched: object[], elsewhere: object[]}}
 */
export function classify(blocks, touchedFiles) {
  const touched = [];
  const elsewhere = [];
  for (const b of blocks) (isTouched(b, touchedFiles ?? []) ? touched : elsewhere).push(b);
  return { touched, elsewhere };
}
