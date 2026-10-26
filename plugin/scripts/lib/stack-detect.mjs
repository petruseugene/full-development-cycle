// Pure stack detection: map project manifests to read-only check commands.
// No spawning; callers inject `exists(relPath)` and `read(relPath)` (string|null).
import fs from 'node:fs';
import path from 'node:path';

const PRETTIER_FILES = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
];

// Commands for which any stdout means failure (gofmt -l lists unformatted files).
export function failsOnOutput(cmd) {
  return typeof cmd === 'string' && /^gofmt\s+-l\b/.test(cmd);
}

function safeRead(read, p) {
  try { const t = read(p); return typeof t === 'string' ? t : null; } catch { return null; }
}

function detectNode({ exists, read }) {
  if (!exists('package.json')) return {};
  let pkg = {};
  try { pkg = JSON.parse(safeRead(read, 'package.json') || '{}') || {}; } catch { pkg = {}; }
  const scripts = pkg.scripts || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let pm = 'npm';
  if (exists('pnpm-lock.yaml') || exists('pnpm-workspace.yaml')) pm = 'pnpm';
  else if (exists('yarn.lock')) pm = 'yarn';
  const run = (name) => (pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`);
  const out = {};
  if (scripts['lint:ci']) out.lint = run('lint:ci');
  else if (scripts.lint) out.lint = run('lint');
  // --no-install: never fetch a missing binary from the registry (security S3;
  // the unrelated `tsc` package would be downloaded instead of TypeScript).
  if (exists('tsconfig.json')) out.typecheck = 'npx --no-install tsc --noEmit';
  if (pkg.prettier || deps.prettier || PRETTIER_FILES.some(exists)) out.format = 'npx --no-install prettier --check .';
  if (scripts.test) {
    out.test = `${pm} test`;
    // Quiet output: a plain `node --test` script gets the dot reporter.
    if (/^node\s+(?:\S+\s+)*--test\b/.test(scripts.test) && !/--test-reporter/.test(scripts.test)) {
      out.test += pm === 'yarn' ? ' --test-reporter=dot' : ' -- --test-reporter=dot';
    }
  }
  return out;
}

function detectPython({ exists, read }) {
  const files = ['pyproject.toml', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt', 'ruff.toml', '.ruff.toml', 'mypy.ini', '.flake8', 'pytest.ini', 'tox.ini'];
  if (!files.some(exists)) return {};
  const text = files.map((f) => (exists(f) ? safeRead(read, f) || '' : '')).join('\n');
  const mentions = (re) => re.test(text);
  const out = {};
  const ruff = exists('ruff.toml') || exists('.ruff.toml') || mentions(/\[tool\.ruff|^\s*ruff\b/m);
  if (ruff) out.lint = 'ruff check .';
  else if (exists('.flake8') || mentions(/\bflake8\b/)) out.lint = 'flake8';
  if (exists('mypy.ini') || mentions(/\[tool\.mypy\]|\[mypy\]|^\s*mypy\b/m)) out.typecheck = 'mypy .';
  if (mentions(/\[tool\.black\]|^\s*black\b/m)) out.format = 'black --check .';
  if (exists('pytest.ini') || mentions(/\[tool\.pytest|\[tool:pytest\]|^\s*pytest\b/m)) out.test = 'pytest';
  return out;
}

function detectGo({ exists }) {
  if (!exists('go.mod')) return {};
  return { lint: 'go vet ./...', format: 'gofmt -l .', test: 'go test ./...' };
}

function detectRust({ exists }) {
  if (!exists('Cargo.toml')) return {};
  return { lint: 'cargo clippy -- -D warnings', format: 'cargo fmt --check', test: 'cargo test' };
}

export function detectCommands({ exists, read }) {
  const io = { exists: (p) => !!exists(p), read };
  const out = {};
  for (const part of [detectNode(io), detectPython(io), detectGo(io), detectRust(io)]) {
    for (const [k, v] of Object.entries(part)) if (!(k in out)) out[k] = v;
  }
  return out;
}

export function detectFromDir(root) {
  return detectCommands({
    exists: (p) => fs.existsSync(path.join(root, p)),
    read: (p) => fs.readFileSync(path.join(root, p), 'utf8'),
  });
}
