// `profile.visual` validation and the device guard (spec R1, R2).
// Pure: no I/O. Used by profile.mjs (validate time) and the visual commands
// (run time: deviceGuardProblems before anything is spawned).
//
// Commands (`build.cmd`, `build.serve`, `teardown[]`, `screens[].flow`) use
// the recipe cmd grammar (parseRecipeCmd: argv, never a shell) with only the
// placeholders {device}, {out} and {screen}. On top of the recipe grammar,
// every literal non-option argv word is checked for shells and command
// runners by stem — with or without placeholders — because wrappers such as
// `caffeinate`, `arch` or `xcrun` forward their args (lesson L3).

import { parseRecipeCmd, SHELL_RE, RUNNERS } from './recipe-safety.mjs';
import { unknownCheckKeys } from './visual-checks.mjs';

/** iOS simulator UDID: 8-4-4-4-12 hex. Physical devices use other forms. */
export const SIM_UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Android emulator serial. A physical device serial never matches. */
export const EMULATOR_RE = /^emulator-\d+$/;
/** Screen id. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Android AVD name (never starts with `-`, so it is never read as an option). */
export const AVD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const AC_ID_RE = /^AC\d+$/;
export const CHECK_TYPES = Object.freeze(['support', 'scale', 'overlap', 'tap', 'colors']);
export const VISUAL_PLACEHOLDERS = Object.freeze(['device', 'out', 'screen']);

const VISUAL_KEYS = Object.freeze([
  'device', 'tolerance_pct', 'screen_timeout_s', 'budget_s', 'avd', 'boot_timeout_s', 'build',
  'teardown', 'tap_min_pt', 'forbidden_colors', 'color_delta_e', 'color_min_pct', 'screens',
]);
const POSITIVE_KEYS = Object.freeze([
  'tolerance_pct', 'screen_timeout_s', 'budget_s', 'boot_timeout_s', 'tap_min_pt', 'color_delta_e', 'color_min_pct',
]);
const BUILD_KEYS = Object.freeze(['cmd', 'inputs', 'serve']);
const SCREEN_KEYS = Object.freeze([
  'id', 'title', 'flow', 'route', 'screenshot', 'reference', 'touches', 'acs', 'timeout_s', 'elements', 'checks',
]);
const ELEMENT_KEYS = Object.freeze(['id', 'foot_offset_pct', 'support_offset_pct']);
/** Element-name fields each check type requires (`elements` is a list). */
const CHECK_FIELDS = Object.freeze({
  support: ['element', 'on'],
  scale: ['a', 'b'],
  overlap: ['a', 'b'],
  tap: [],
  colors: [],
});
/** Runner names that only matter as argv[0] (`git add . x` is fine). */
const ARGV0_ONLY_RUNNERS = new Set(['.', 'source', 'exec', 'eval', 'builtin']);
/**
 * Device-sensitive tools (R2) and how each one selects its device. Any argv
 * with one of these words (matched by normalised stem, see toolOf) targets a
 * device whatever its subcommand, and must select `visual.device`:
 *   flags      `{device}` must be the value right after one of these flags
 *              (or `--flag={device}`); a hard-coded value is refused;
 *   global     the flag is a global option: it counts only BEFORE the tool's
 *              subcommand (adb reads `-s` only there; after it, the flag goes
 *              to the subcommand and adb uses its default device) — lesson L8;
 *   valueFlags global options that take a value (skipped when looking for
 *              the subcommand);
 *   banned     global flags that select a device by kind, not by id;
 *   positional `simctl <sub> {device}`;
 *   androidEnv no selector: pinned by ANDROID_SERIAL=<visual.device>, which
 *              every visual spawn gets, so visual.device must be emulator-<n>;
 *   subs       only these subcommands are device-sensitive (`cap run`).
 */
const DEVICE_TOOLS = Object.freeze({
  adb: { flags: ['-s'], global: true, valueFlags: ['-H', '-P', '-L'], banned: ['-d', '-e', '-t', '--one-device'] },
  maestro: { flags: ['--device', '--udid'], global: true, valueFlags: ['--platform', '--host', '--port'] },
  idb: { flags: ['--udid'] },
  flutter: { flags: ['-d', '--device-id'] },
  fastlane: { flags: ['--device', '--udid'] },
  simctl: { positional: true },
  xcodebuild: { flags: ['-destination'] },
  detox: { flags: ['--device-name'] },
  cap: { flags: ['--target'], subs: ['run'] },
  cordova: { flags: ['--target'], subs: ['run', 'emulate'] },
  gradle: { androidEnv: true },
  gradlew: { androidEnv: true },
  'run:ios': { flags: ['--device', '--udid', '-d'] },
  'run-ios': { flags: ['--device', '--udid'] },
  'run:android': { flags: ['--device', '--deviceId', '-d'] },
  'run-android': { flags: ['--device', '--deviceId'] },
});
/** Tools that can only reach physical devices: refused outright (plus every idevice* tool). */
const PHONE_ONLY = Object.freeze([
  'devicectl', 'ios-deploy', 'ideviceinstaller', 'pymobiledevice3', 'tidevice', 'go-ios', 'ios', 'cfgutil', 'fastboot',
]);
const SCRIPT_PHONE_ONLY = Object.freeze(['fastboot', 'pymobiledevice3', 'tidevice', 'cfgutil', 'ios', 'go-ios']);
/** Script-file words never name a tool (`node scripts/adb.js`, `./maestro.sh`). */
const SCRIPT_FILE_RE = /\.(?:js|mjs|cjs|ts|sh|py)$/i;
/** Data-file words never name a tool (`flows/maestro-login.yaml`). */
const DATA_FILE_RE = /\.(?:ya?ml|json|apk|aab|ipa|app|png|jpe?g|txt|md|xml|zip|log)$/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Normalised basename and its stem without version suffix (`/bin/Bash5.exe` → bash5 / bash). */
function names(word) {
  const base = word.split('/').pop().toLowerCase().replace(/\.exe$/, '');
  return { base, stem: base.replace(/[-.\d]+$/, '') };
}

/** True when `id` is an iOS simulator UDID or an Android emulator serial. */
export function isValidDevice(id) {
  return typeof id === 'string' && (SIM_UDID_RE.test(id) || EMULATOR_RE.test(id));
}

/**
 * The tool a literal word names, by normalised stem (lesson L3): the
 * basename, lower-cased, without `.exe`; `adb`, `adb35`, `adb-wrapper`,
 * `/opt/sdk/ADB.EXE` all name adb. Returns null for data files and options.
 * @returns {{tool: string, phoneOnly?: true} | null}
 */
function toolOf(lit, index = 0) {
  if (lit.startsWith('-') || lit.includes('=') || DATA_FILE_RE.test(lit)) return null;
  // Script rule: project scripts may carry a tool-like name (`./adb.js`, `./maestro.sh`), so
  // they are allowed, EXCEPT when the basename minus extension is exactly a phone-only tool
  // (`./fastboot.sh`, `scripts/ios.js`): those are refused.
  if (SCRIPT_FILE_RE.test(lit)) {
    const stem = names(lit.replace(SCRIPT_FILE_RE, '')).base;
    const exact = SCRIPT_PHONE_ONLY.includes(stem) && (stem !== 'ios' || index === 0 || lit.includes('/'));
    return exact ? { tool: stem, phoneOnly: true } : null;
  }
  const lower = lit.toLowerCase();
  if (/^run[:-](?:ios|android)$/.test(lower)) return { tool: lower };
  const { base } = names(lit);
  // `ios` is the go-ios binary, but also a common platform word (`--platform ios`,
  // `flutter build ios`): it names the tool only as argv[0] or as a path.
  const named = (t) => (t === 'ios'
    ? base === 'ios' && (index === 0 || lit.includes('/'))
    : base === t || (base.startsWith(t) && /[-.\d]/.test(base[t.length])));
  if (base.startsWith('idevice') || PHONE_ONLY.some(named)) return { tool: base, phoneOnly: true };
  // longest name first: gradlew before gradle
  const tool = Object.keys(DEVICE_TOOLS).filter((t) => !t.startsWith('run')).sort((x, y) => y.length - x.length).find(named);
  return tool ? { tool } : null;
}

/** The device-sensitive tools named in `words`: [{tool, index, phoneOnly?}]. */
function deviceTools(words) {
  const found = [];
  words.forEach((w, index) => {
    if (!isObj(w) || typeof w.lit !== 'string') return;
    const t = toolOf(w.lit, index);
    if (!t) return;
    const subs = DEVICE_TOOLS[t.tool]?.subs;
    if (subs && !words.slice(index + 1).some((x) => isObj(x) && typeof x.lit === 'string' && subs.includes(x.lit.toLowerCase()))) return;
    found.push({ ...t, index });
  });
  return found;
}

/** Parsed words of a cmd string or a word list (string argv words become literals). */
function toWords(argv) {
  if (typeof argv === 'string') return parseRecipeCmd(argv).words;
  if (!Array.isArray(argv)) return [];
  return argv.map((w) => (typeof w === 'string' ? { lit: w } : w)).filter(isObj);
}

const isDevicePh = (w) => isObj(w) && w.ph === 'device' && w.prefix === '';
const describe = (w) => (w === undefined ? 'nothing' : ('lit' in w ? `'${w.lit}'` : `{${w.ph}}`));
const flagOfPh = (w) => (typeof w.prefix === 'string' && w.prefix.startsWith('-') ? w.prefix.slice(0, -1) : '');

/**
 * True when argv uses a device-sensitive or phone-only tool (R2), with any
 * subcommand. Every literal word is checked (wrappers forward their args).
 * @param {string | Array<string | {lit: string} | {ph: string}>} argv
 */
export function isDeviceSensitive(argv) {
  return deviceTools(toWords(argv)).length > 0;
}

/** Selector problems of one tool occurrence whose flag is a global option (adb, maestro). */
function globalToolProblems(words, at, spec) {
  const flags = new Set(spec.flags);
  const banned = new Set(spec.banned ?? []);
  const valueFlags = new Set(spec.valueFlags ?? []);
  const problems = [];
  let selected = 0;
  let sub = null; // the subcommand word, once seen
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (sub === null) {
      if (!('lit' in w)) {
        const flag = flagOfPh(w);
        if (flag && flags.has(flag)) {
          if (w.ph === 'device') selected++;
          else problems.push(`${flag}= must be {device}, not {${w.ph}}`);
          continue;
        }
        sub = `{${w.ph}}`;
        continue;
      }
      const lit = w.lit;
      if (banned.has(lit)) { problems.push(`'${lit}' selects a device by kind, not by id: select it with ${spec.flags[0]} {device}`); continue; }
      if (flags.has(lit)) {
        const next = words[i + 1];
        if (isDevicePh(next)) selected++;
        else problems.push(`${lit} must be followed by {device}, not ${describe(next)} (a hard-coded device could be a physical one)`);
        i++;
        continue;
      }
      const eq = lit.indexOf('=');
      if (eq > 0 && flags.has(lit.slice(0, eq))) { problems.push(`'${lit}' hard-codes the device: use ${lit.slice(0, eq)}={device}`); continue; }
      const glued = spec.flags.find((f) => /^-[A-Za-z]$/.test(f) && lit.startsWith(f) && lit.length > 2 && !lit.startsWith('--'));
      if (glued) { problems.push(`'${lit}' hard-codes the device: use ${glued} {device}`); continue; }
      if (valueFlags.has(lit)) { i++; continue; }
      if (lit.startsWith('-')) continue;
      sub = lit;
      continue;
    }
    // After the subcommand the tool no longer reads its device flag (L8).
    const lit = 'lit' in w ? w.lit : null;
    const flag = lit === null ? flagOfPh(w) : (lit.includes('=') ? lit.slice(0, lit.indexOf('=')) : lit);
    if (flags.has(flag)) {
      problems.push(`${flag} after the subcommand '${sub}' is not read by ${names(words[at].lit).base} (it would use its default device): put ${spec.flags[0]} {device} before '${sub}'`);
    }
  }
  return { selected, problems };
}

/** Selector problems of one tool occurrence whose flag may appear anywhere after it. */
function anywhereToolProblems(words, at, spec) {
  const flags = new Set(spec.flags);
  const shortFlags = spec.flags.filter((f) => /^-[A-Za-z]$/.test(f));
  const problems = [];
  let selected = 0;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (!('lit' in w)) {
      const flag = flagOfPh(w);
      if (flag && flags.has(flag)) {
        if (w.ph === 'device') selected++;
        else problems.push(`${flag}= must be {device}, not {${w.ph}}`);
      }
      continue;
    }
    const lit = w.lit;
    if (flags.has(lit)) {
      const next = words[i + 1];
      if (isDevicePh(next)) selected++;
      else problems.push(`${lit} must be followed by {device}, not ${describe(next)} (a hard-coded device could be a physical one)`);
      i++;
      continue;
    }
    const eq = lit.indexOf('=');
    if (eq > 0 && flags.has(lit.slice(0, eq))) { problems.push(`'${lit}' hard-codes the device: use ${lit.slice(0, eq)}={device}`); continue; }
    const glued = shortFlags.find((f) => lit.startsWith(f) && lit.length > 2 && !lit.startsWith('--'));
    if (glued) problems.push(`'${lit}' hard-codes the device: use ${glued} {device}`);
  }
  return { selected, problems };
}

/**
 * Why `cmd` may not run under `visual` (R2), or [] when it is not
 * device-sensitive or is pinned to the simulator/emulator in visual.device.
 * Every device-sensitive tool in argv must select `{device}` itself:
 *   adb -s {device} <sub> …            (global option, before the subcommand)
 *   maestro --device {device} <sub> …  (global option; --udid too)
 *   flutter … -d {device} | --device-id {device}; idb … --udid {device};
 *   fastlane … --device|--udid {device}; detox … --device-name {device};
 *   cap|cordova run … --target {device}; expo/react-native run:ios|run:android
 *   … --device {device}; xcrun simctl <sub> {device}; `--flag={device}` works
 *   for long flags; gradle/gradlew are pinned by ANDROID_SERIAL and need an
 *   emulator-<n> visual.device. Phone-only tools (devicectl, ios-deploy,
 *   idevice*) are refused outright.
 * @param {string} cmd
 * @param {object} [visual] the profile.visual block
 * @returns {string[]}
 */
export function deviceGuardProblems(cmd, visual) {
  const words = toWords(cmd);
  const tools = deviceTools(words);
  if (tools.length === 0) return [];
  const problems = [];
  const device = isObj(visual) ? visual.device : undefined;
  for (const t of tools) {
    if (t.phoneOnly) {
      problems.push(`'${t.tool}' only reaches physical devices: it can never run under visual (simulators and emulators only)`);
      continue;
    }
    const spec = DEVICE_TOOLS[t.tool];
    if (spec.androidEnv) {
      if (typeof device !== 'string' || !EMULATOR_RE.test(device)) {
        problems.push(`'${t.tool}' is pinned only by ANDROID_SERIAL, so visual.device must be an emulator-<n> (got ${JSON.stringify(device)})`);
      }
      continue;
    }
    if (spec.positional) {
      const sub = words[t.index + 1];
      const dev = words[t.index + 2];
      if (!isDevicePh(dev)) {
        problems.push(`simctl ${sub && 'lit' in sub ? sub.lit : '<subcommand>'} must take {device} as its device argument, not ${describe(dev)}`);
      }
      continue;
    }
    const r = spec.global ? globalToolProblems(words, t.index, spec) : anywhereToolProblems(words, t.index, spec);
    problems.push(...r.problems);
    if (r.selected === 0) {
      const how = spec.global ? `${t.tool} ${spec.flags[0]} {device} <subcommand>` : `${spec.flags.join('|')} {device}`;
      problems.push(`is device-sensitive but has no {device} placeholder as the device selector of '${t.tool}' (${how}); it could target a physical device`);
    }
  }
  if (device === undefined || device === null || device === '') {
    problems.push('is device-sensitive but visual.device is not set');
  } else if (!isValidDevice(device)) {
    problems.push(`is device-sensitive but visual.device ${JSON.stringify(device)} is not a simulator UDID (8-4-4-4-12 hex) or emulator-<n>`);
  }
  return [...new Set(problems)];
}

/** Grammar problems of a visual command (recipe grammar + placeholders + every-word shell scan). */
export function visualCmdProblems(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return ['must be a non-empty string'];
  const { words, problems } = parseRecipeCmd(cmd);
  const out = [...problems];
  for (const w of words) {
    if ('ph' in w && !VISUAL_PLACEHOLDERS.includes(w.ph)) {
      out.push(`placeholder {${w.ph}} is not allowed (only ${VISUAL_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`);
    }
  }
  // ANDROID_SERIAL is set by the CLI from visual.device; a command must not override it.
  if (cmd.trim().split(/[ \t]+/).some((w) => w.startsWith('ANDROID_SERIAL='))) {
    out.push('ANDROID_SERIAL= is set by the CLI from visual.device: remove it from the command');
  }
  // Every literal non-option word after argv[0] (argv[0] is covered by parseRecipeCmd).
  for (const w of words.slice(1)) {
    if (!('lit' in w) || w.lit.startsWith('-')) continue;
    const { base, stem } = names(w.lit);
    const shell = SHELL_RE.test(base) || SHELL_RE.test(stem);
    const runner = !ARGV0_ONLY_RUNNERS.has(base) && (RUNNERS.includes(base) || RUNNERS.includes(stem));
    if (shell || runner) out.push(`'${base}' is a shell or runs its arguments as a command: visual commands run without a shell`);
  }
  return [...new Set(out)];
}

/** Why `ref` is not a safe repo-relative path, or null. */
export function referenceProblem(ref) {
  if (typeof ref !== 'string' || ref === '') return 'must be a non-empty string';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return 'must not have a URL scheme or drive letter (repo-relative path)';
  if (ref.startsWith('/') || ref.startsWith('\\')) return 'must not be absolute (repo-relative path)';
  if (ref.split(/[\\/]/).includes('..')) return "must not contain '..'";
  return null;
}

function checkCmd(cmd, at, visual, errors) {
  for (const p of visualCmdProblems(cmd)) errors.push(`${at} ${p}`);
  if (typeof cmd === 'string' && cmd.trim() !== '') {
    for (const p of deviceGuardProblems(cmd, visual)) errors.push(`${at} ${p}`);
  }
}

function unknownKeys(obj, allowed, at, warnings) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) warnings.push(`${at}: unknown key '${k}'`);
}

function checkStrArr(v, at, errors, re, what) {
  if (!Array.isArray(v)) { errors.push(`${at} must be an array of strings`); return; }
  v.forEach((s, i) => {
    if (typeof s !== 'string' || s === '') errors.push(`${at}[${i}] must be a non-empty string`);
    else if (re && !re.test(s)) errors.push(`${at}[${i}] ${JSON.stringify(s)} must be ${what}`);
  });
}

function checkElements(elements, at, errors, warnings) {
  if (!isObj(elements)) { errors.push(`${at} must be an object`); return; }
  for (const [name, e] of Object.entries(elements)) {
    const ea = `${at}.${name}`;
    if (typeof e === 'string') { if (e === '') errors.push(`${ea} must be a non-empty id`); continue; }
    if (!isObj(e)) { errors.push(`${ea} must be an id string or {id, foot_offset_pct, support_offset_pct}`); continue; }
    unknownKeys(e, ELEMENT_KEYS, ea, warnings);
    if (typeof e.id !== 'string' || e.id === '') errors.push(`${ea}.id must be a non-empty string`);
    for (const k of ['foot_offset_pct', 'support_offset_pct']) {
      if (k in e && !isFiniteNum(e[k])) errors.push(`${ea}.${k} must be a number`);
    }
  }
}

function checkChecks(checks, elements, at, errors) {
  if (!Array.isArray(checks)) { errors.push(`${at} must be an array`); return; }
  const declared = isObj(elements) ? elements : {};
  const named = (name, field) => {
    if (typeof name !== 'string' || name === '') errors.push(`${field} must be an element name`);
    else if (!Object.hasOwn(declared, name)) errors.push(`${field} names '${name}', which is not declared in elements`);
  };
  checks.forEach((c, i) => {
    const ca = `${at}[${i}]`;
    if (!isObj(c)) { errors.push(`${ca} must be an object`); return; }
    if (!CHECK_TYPES.includes(c.type)) {
      errors.push(`${ca}.type ${JSON.stringify(c.type)} is not a check type (${CHECK_TYPES.join('|')})`);
      return;
    }
    for (const k of unknownCheckKeys(c)) errors.push(`${ca}: unknown key '${k}' (not a ${c.type} check key)`);
    for (const f of CHECK_FIELDS[c.type]) named(c[f], `${ca}.${f}`);
    if (c.type === 'scale' && !isPositive(c.expect)) errors.push(`${ca}.expect must be a positive number`);
    if (c.type === 'tap') {
      if (!Array.isArray(c.elements) || c.elements.length === 0) errors.push(`${ca}.elements must be a non-empty array of element names`);
      else c.elements.forEach((n, j) => named(n, `${ca}.elements[${j}]`));
    }
  });
}

function checkScreen(s, at, visual, seen, errors, warnings) {
  if (!isObj(s)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(s, SCREEN_KEYS, at, warnings);
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
    errors.push(`${at}.id must match ${ID_RE.source} (got ${JSON.stringify(s.id)})`);
  } else if (seen.has(s.id)) {
    errors.push(`${at}.id duplicate screen id '${s.id}'`);
  } else seen.add(s.id);
  if ('title' in s && typeof s.title !== 'string') errors.push(`${at}.title must be a string`);
  const hasFlow = 'flow' in s;
  const hasRoute = 'route' in s;
  if (hasFlow && hasRoute) errors.push(`${at} has both flow and route (exactly one is allowed)`);
  else if (!hasFlow && !hasRoute) errors.push(`${at} needs exactly one of flow or route`);
  if (hasFlow) checkCmd(s.flow, `${at}.flow`, visual, errors);
  if (hasRoute && (typeof s.route !== 'string' || !s.route.startsWith('/') || s.route.startsWith('//'))) {
    errors.push(`${at}.route must be a path starting with '/'`);
  }
  if ('screenshot' in s) {
    const f = s.screenshot;
    if (typeof f !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(f)) {
      errors.push(`${at}.screenshot must be a plain file name (no directories)`);
    }
  }
  if ('reference' in s) {
    const p = referenceProblem(s.reference);
    if (p) errors.push(`${at}.reference ${p}`);
  }
  if ('touches' in s) checkStrArr(s.touches, `${at}.touches`, errors);
  if ('acs' in s) checkStrArr(s.acs, `${at}.acs`, errors, AC_ID_RE, 'an AC id like AC3');
  if ('timeout_s' in s && !isPositive(s.timeout_s)) errors.push(`${at}.timeout_s must be a positive number`);
  if ('elements' in s) checkElements(s.elements, `${at}.elements`, errors, warnings);
  if ('checks' in s) checkChecks(s.checks, s.elements, `${at}.checks`, errors);
}

/**
 * Validate a `profile.visual` block (R1, R2).
 * @param {unknown} visual
 * @returns {{errors: string[], warnings: string[]}} messages start with the JSON path
 */
export function validateVisual(visual) {
  const errors = [];
  const warnings = [];
  if (!isObj(visual)) return { errors: ['visual must be an object'], warnings };
  unknownKeys(visual, VISUAL_KEYS, 'visual', warnings);

  if ('device' in visual && !isValidDevice(visual.device)) {
    errors.push(`visual.device ${JSON.stringify(visual.device)} must be an iOS simulator UDID (8-4-4-4-12 hex) or emulator-<n>`);
  }
  for (const k of POSITIVE_KEYS) {
    if (k in visual && !isPositive(visual[k])) errors.push(`visual.${k} must be a positive number`);
  }
  if ('avd' in visual && (typeof visual.avd !== 'string' || !AVD_RE.test(visual.avd))) {
    errors.push(`visual.avd must match ${AVD_RE.source}`);
  }
  if ('build' in visual) {
    const b = visual.build;
    if (!isObj(b)) errors.push('visual.build must be an object');
    else {
      unknownKeys(b, BUILD_KEYS, 'visual.build', warnings);
      if ('cmd' in b) checkCmd(b.cmd, 'visual.build.cmd', visual, errors);
      if ('serve' in b) checkCmd(b.serve, 'visual.build.serve', visual, errors);
      if ('inputs' in b) checkStrArr(b.inputs, 'visual.build.inputs', errors);
    }
  }
  if ('teardown' in visual) {
    if (!Array.isArray(visual.teardown)) errors.push('visual.teardown must be an array of commands');
    else visual.teardown.forEach((c, i) => checkCmd(c, `visual.teardown[${i}]`, visual, errors));
  }
  if ('forbidden_colors' in visual) {
    checkStrArr(visual.forbidden_colors, 'visual.forbidden_colors', errors, HEX_COLOR_RE, 'a #RRGGBB colour');
  }
  if ('screens' in visual) {
    if (!Array.isArray(visual.screens)) errors.push('visual.screens must be an array');
    else {
      const seen = new Set();
      visual.screens.forEach((s, i) => checkScreen(s, `visual.screens[${i}]`, visual, seen, errors, warnings));
    }
  }
  return { errors, warnings };
}
