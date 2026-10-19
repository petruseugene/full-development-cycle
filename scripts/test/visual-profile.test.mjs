import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, runCli } from './helpers.mjs';
import {
  SIM_UDID_RE, EMULATOR_RE, ID_RE, CHECK_TYPES, isValidDevice, isDeviceSensitive,
  deviceGuardProblems, validateVisual, visualCmdProblems, referenceProblem,
} from '../lib/visual-profile.mjs';
import { validateProfile } from '../lib/profile.mjs';

const FX_DIR = fileURLToPath(new URL('./fixtures/visual-profile/', import.meta.url));
const loadFx = (name) => JSON.parse(fs.readFileSync(path.join(FX_DIR, `${name}.json`), 'utf8'));
const SIM = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB';
const PHYSICAL = '00008030-001A2B3C4D5E6F70';

function validateFile(name) {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify(loadFx(name)));
  const r = runCli(['profile', 'validate'], { cwd: fx.root });
  fx.cleanup();
  return r;
}

test('AC1: valid visual fixture passes profile validate (exit 0)', () => {
  const r = validateFile('valid');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(validateVisual(loadFx('valid').visual), { errors: [], warnings: [] });
});

const NEGATIVE = {
  'unknown-check-type': /visual\.screens\[0\]\.checks\[0\]\.type/,
  'undeclared-element': /visual\.screens\[0\]\.checks\[2\]\.b names 'ghost'/,
  'flow-and-route': /visual\.screens\[0\] has both flow and route/,
  'duplicate-screen-id': /visual\.screens\[1\]\.id duplicate screen id 'home'/,
  'reference-dotdot': /visual\.screens\[1\]\.reference must not contain '\.\.'/,
  'reference-url': /visual\.screens\[1\]\.reference must not have a URL scheme/,
  'forbidden-color-name': /visual\.forbidden_colors\[0\]/,
  'build-sh-c': /visual\.build\.cmd /,
  'build-caffeinate-bash': /visual\.build\.cmd 'bash' is a shell/,
  'device-no-placeholder': /visual\.build\.cmd is device-sensitive but has no \{device\}/,
  'device-physical-udid': /visual\.device "00008030-001A2B3C4D5E6F70"/,
  'maestro-no-device': /visual\.screens\[0\]\.flow is device-sensitive but has no \{device\}/,
};

for (const [name, re] of Object.entries(NEGATIVE)) {
  test(`AC1/AC2: fixture ${name} fails with a JSON-path error`, () => {
    const r = validateFile(name);
    assert.equal(r.status, 2, `${name}: ${r.stdout}`);
    assert.match(r.stderr, re);
    const { errors } = validateVisual(loadFx(name).visual);
    assert.ok(errors.some((e) => re.test(e)), `${name}: ${errors.join(' | ')}`);
  });
}

test('device patterns: simulator and emulator pass, physical forms fail', () => {
  assert.ok(SIM_UDID_RE.test(SIM));
  assert.ok(isValidDevice(SIM));
  assert.ok(isValidDevice('emulator-5554'));
  assert.ok(EMULATOR_RE.test('emulator-5554'));
  for (const bad of [PHYSICAL, 'R58M123ABC', 'emulator-', '-emulator-5554', '', null, undefined, 42, `${SIM}\n`]) {
    assert.equal(isValidDevice(bad), false, String(bad));
  }
});

test('ID_RE and CHECK_TYPES', () => {
  assert.ok(ID_RE.test('home-2'));
  assert.equal(ID_RE.test('-home'), false);
  assert.equal(ID_RE.test('Home'), false);
  assert.deepEqual([...CHECK_TYPES], ['support', 'scale', 'overlap', 'tap', 'colors']);
});

test('R2: isDeviceSensitive: any subcommand of a device tool, every literal word, by basename', () => {
  const yes = [
    'npx expo run:ios', 'npx react-native run-android', 'xcodebuild -scheme App', '/usr/bin/xcodebuild build',
    'xcrun devicectl device install app', 'ios-deploy --bundle x.app', 'adb install app.apk',
    'adb -s {device} install app.apk', 'maestro test flow.yaml', 'maestro --device {device} test f.yaml',
    'caffeinate npx expo run:android', 'adb uninstall com.x', 'adb shell pm clear com.x', 'adb reboot', 'adb devices',
    'maestro studio', 'xcrun simctl boot {device}', 'flutter run', 'idb ui tap 1 2', 'fastlane ios beta',
    '/opt/sdk/platform-tools/adb.exe reboot',
  ];
  const no = ['npx expo start', 'node scripts/test.mjs install', 'npm run dev', 'xcrun --find clang'];
  for (const c of yes) assert.equal(isDeviceSensitive(c), true, c);
  for (const c of no) assert.equal(isDeviceSensitive(c), false, c);
  assert.equal(isDeviceSensitive(['npx', 'expo', 'run:ios']), true);
  assert.equal(isDeviceSensitive([{ lit: 'maestro' }, { ph: 'device', prefix: '' }, { lit: 'test' }]), true);
});

test('AC2: deviceGuardProblems', () => {
  assert.deepEqual(deviceGuardProblems('npx expo start', {}), []);
  assert.match(deviceGuardProblems('npx expo run:ios', { device: SIM }).join(), /no \{device\} placeholder/);
  assert.deepEqual(deviceGuardProblems('npx expo run:ios --device {device}', { device: SIM }), []);
  assert.match(deviceGuardProblems('npx expo run:ios --device {device}', { device: PHYSICAL }).join(), /not a simulator UDID/);
  assert.match(deviceGuardProblems('npx expo run:ios --device {device}', {}).join(), /visual\.device is not set/);
  assert.match(deviceGuardProblems('npx expo run:ios --device {device}', undefined).join(), /not set/);
  assert.match(deviceGuardProblems('maestro test flow.yaml', { device: SIM }).join(), /no \{device\}/);
  assert.deepEqual(deviceGuardProblems('maestro --device {device} test flow.yaml', { device: SIM }), []);
  assert.deepEqual(deviceGuardProblems('maestro --device {device} test flow.yaml', { device: 'emulator-5554' }), []);
});

test('R2 (security): the device guard requires {device} right after the device-selecting flag', () => {
  const EMU = { device: 'emulator-5554' };
  const refused = {
    'adb uninstall x': /no \{device\} placeholder/,
    'adb shell pm clear x': /no \{device\} placeholder/,
    'adb reboot': /no \{device\} placeholder/,
    'adb -s R58M123ABC install app.apk {device}': /-s must be followed by \{device\}, not 'R58M123ABC'/,
    'maestro --device X test f {device}': /--device must be followed by \{device\}, not 'X'/,
    'flutter run': /no \{device\} placeholder/,
    'adb -d install app.apk {device}': /'-d' selects a device by kind/,
    'adb -e -s {device} reboot': /'-e' selects a device by kind/,
    'adb --one-device X reboot': /'--one-device' selects a device by kind/,
    'adb -s {device} -s R58M123ABC reboot': /-s must be followed by \{device\}, not 'R58M123ABC'/,
    'adb -sR58M123ABC reboot': /hard-codes the device/,
    'maestro --device=00008110-001A test f.yaml': /hard-codes the device/,
    'maestro --udid {screen} test f.yaml': /--udid must be followed by \{device\}, not \{screen\}/,
    'flutter run -d R58M123ABC {device}': /-d must be followed by \{device\}/,
    'idb ui tap 1 2': /no \{device\} placeholder/,
    'xcrun simctl shutdown booted': /simctl shutdown must take \{device\}/,
    'xcrun simctl list': /simctl list must take \{device\}/,
    'fastlane ios beta': /no \{device\} placeholder/,
    'caffeinate adb reboot': /no \{device\} placeholder/,
    // L8: a global selector counts only before the subcommand
    'adb uninstall com.x -s {device}': /-s after the subcommand 'uninstall' is not read/,
    'adb shell -s {device} ls': /-s after the subcommand 'shell' is not read/,
    'adb install a.apk -s {device}': /-s after the subcommand 'install' is not read/,
    'maestro test --device {device} flows/a.yaml': /--device after the subcommand 'test' is not read/,
    'maestro test --udid={device} flows/a.yaml': /--udid after the subcommand 'test'/,
    'adb -s {device} reboot adb reboot': /no \{device\} placeholder as the device selector of 'adb'/,
    // phone-only tools
    'xcrun devicectl device install app --device {device}': /only reaches physical devices/,
    'xcrun devicectl device uninstall app --device {device} com.x': /only reaches physical devices/,
    'ios-deploy --id {device} --bundle x.app': /only reaches physical devices/,
    'ideviceinstaller -i app.ipa': /only reaches physical devices/,
    'idevicescreenshot x.png': /only reaches physical devices/,
    // more runners (security cycle 2)
    'npx cap run android': /no \{device\} placeholder/,
    'npx cordova run android': /no \{device\} placeholder/,
    'detox test -c android': /no \{device\} placeholder/,
    // L3: stems and wrapper suffixes name the tool
    'adb35 uninstall x': /no \{device\} placeholder/,
    'adb-wrapper uninstall x': /no \{device\} placeholder/,
    '/opt/sdk/ADB.EXE reboot': /no \{device\} placeholder/,
    'maestro-cli test f.yaml': /no \{device\} placeholder/,
  };
  for (const [cmd, re] of Object.entries(refused)) {
    const problems = deviceGuardProblems(cmd, EMU);
    assert.ok(problems.some((p) => re.test(p)), `${cmd}: ${problems.join(' | ')}`);
    assert.ok(validateVisual({ ...EMU, teardown: [cmd] }).errors.length > 0, cmd);
  }
  // gradle is pinned by ANDROID_SERIAL: needs an emulator visual.device
  for (const cmd of ['./gradlew installDebug', './gradlew connectedAndroidTest', 'gradle installDebug', 'gradle-8.5 iD']) {
    assert.match(deviceGuardProblems(cmd, { device: SIM }).join(), /pinned only by ANDROID_SERIAL/, cmd);
    assert.deepEqual(deviceGuardProblems(cmd, EMU), [], cmd);
  }
  const ok = [
    'adb -s {device} uninstall com.x', 'adb -s {device} shell pm clear com.x', 'adb -s {device} reboot',
    'adb -H localhost -P 5037 -s {device} install app.apk', 'adb -s {device} install -d -t app.apk',
    'maestro --device {device} test flows/a.yaml', 'maestro --udid={device} test flows/a.yaml',
    'maestro --device {device} test -e OUT={out} flows/maestro-login.yaml',
    'flutter run -d {device}', 'flutter run --device-id {device}', 'idb ui tap 1 2 --udid {device}',
    'xcrun simctl shutdown {device}', 'xcrun simctl io {device} screenshot {out}', 'fastlane ios snap --device {device}',
    'npx cap run android --target {device}', 'npx cordova run android --target={device}', 'detox test -c android --device-name {device}',
    'npx cap sync', 'npx expo run:android --device {device}',
  ];
  for (const cmd of ok) assert.deepEqual(deviceGuardProblems(cmd, EMU), [], cmd);
});

test('L9: the README-style mobile profile.visual example validates (maestro -e OUT={out})', () => {
  const visual = {
    device: SIM,
    build: { cmd: 'npx expo run:ios --device {device}', serve: 'npx expo start' },
    screens: [
      { id: 'login', title: 'Login', flow: 'maestro --device {device} test -e OUT={out} flows/login.yaml', screenshot: 'login.png' },
      { id: 'home', title: 'Home', flow: 'maestro --udid {device} test --env OUT={out} flows/home.yaml' },
    ],
  };
  assert.deepEqual(validateVisual(visual), { errors: [], warnings: [] });
  assert.match(validateVisual({ ...visual, screens: [{ id: 'x', flow: 'maestro --device {device} test OUT={out} f.yaml' }] }).errors.join(), /glued/);
});

test('F9: unknown check keys are validation errors', () => {
  const { errors } = validateVisual({
    screens: [{ id: 'a', route: '/', elements: { h: 'h' }, checks: [{ type: 'tap', elements: ['h'], tap_min_pt: 1 }, { type: 'colors', tolerance_pct: 3 }] }],
  });
  assert.ok(errors.some((e) => /checks\[0\]: unknown key 'tap_min_pt'/.test(e)), errors.join(' | '));
  assert.ok(errors.some((e) => /checks\[1\]: unknown key 'tolerance_pct'/.test(e)), errors.join(' | '));
});

test('AC2: run:ios with {device} and a simulator UDID passes validation; physical fails', () => {
  const vis = (device) => ({ device, build: { cmd: 'npx expo run:ios --device {device}' } });
  assert.deepEqual(validateVisual(vis(SIM)).errors, []);
  assert.ok(validateVisual(vis(PHYSICAL)).errors.length >= 2);
});

test('visual commands: placeholders and shell words', () => {
  assert.deepEqual(visualCmdProblems('maestro --device {device} test --output {out} flows/{screen}.yaml').length, 1); // glued
  assert.deepEqual(visualCmdProblems('maestro --device {device} test --output={out} flows/home.yaml'), []);
  assert.match(visualCmdProblems('npx expo run:ios --device {udid}').join(), /placeholder \{udid\} is not allowed/);
  for (const c of ["sh -c 'x'", 'caffeinate bash -c x', 'arch -arm64 zsh-5.9 x', 'xcrun env x', 'caffeinate Bash5 x']) {
    assert.ok(visualCmdProblems(c).length > 0, c);
  }
  assert.deepEqual(visualCmdProblems('git add . x'), []);
  assert.deepEqual(visualCmdProblems(''), ['must be a non-empty string']);
  assert.deepEqual(visualCmdProblems(42), ['must be a non-empty string']);
});

test('referenceProblem', () => {
  assert.equal(referenceProblem('design/a.png'), null);
  for (const bad of ['/abs/a.png', '\\\\host\\a.png', 'C:\\a.png', 'file:x.png', 'a/../b.png', '..', '', 3]) {
    assert.ok(referenceProblem(bad), String(bad));
  }
});

test('R1: other shape rules', () => {
  const errs = (v) => validateVisual(v).errors.join('\n');
  assert.match(errs([]), /visual must be an object/);
  assert.match(errs({ tolerance_pct: 0 }), /visual\.tolerance_pct must be a positive number/);
  assert.match(errs({ color_min_pct: -1 }), /visual\.color_min_pct/);
  assert.match(errs({ budget_s: '900' }), /visual\.budget_s/);
  assert.match(errs({ avd: '-bad' }), /visual\.avd must match/);
  assert.match(errs({ build: [] }), /visual\.build must be an object/);
  assert.match(errs({ build: { inputs: 'src' } }), /visual\.build\.inputs must be an array/);
  assert.match(errs({ teardown: 'x' }), /visual\.teardown must be an array/);
  assert.match(errs({ teardown: ['ok', 'sh x'] }), /visual\.teardown\[1\]/);
  assert.match(errs({ screens: {} }), /visual\.screens must be an array/);
  assert.match(errs({ screens: [{ id: 'a' }] }), /visual\.screens\[0\] needs exactly one of flow or route/);
  assert.match(errs({ screens: [{ id: 'Bad', route: '/' }] }), /visual\.screens\[0\]\.id must match/);
  assert.match(errs({ screens: [{ id: 'a', route: 'x' }] }), /visual\.screens\[0\]\.route/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', screenshot: '../a.png' }] }), /\.screenshot must be a plain file name/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', timeout_s: 0 }] }), /\.timeout_s must be a positive number/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', acs: ['3'] }] }), /\.acs\[0\]/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', elements: { e: { id: 'x', foot_offset_pct: 'a' } } }] }), /elements\.e\.foot_offset_pct/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', elements: { e: 'x' }, checks: [{ type: 'scale', a: 'e', b: 'e', expect: 0 }] }] }), /checks\[0\]\.expect/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', elements: { e: 'x' }, checks: [{ type: 'tap', elements: [] }] }] }), /checks\[0\]\.elements must be a non-empty/);
  assert.match(errs({ screens: [{ id: 'a', route: '/', checks: [{ type: 'support', element: 'e', on: 'f' }] }] }), /checks\[0\]\.element names 'e'/);
  assert.match(errs({ screens: [{ id: 'a', flow: 'node scripts/x.mjs {foo}' }] }), /\.flow placeholder \{foo\} is not allowed/);
  assert.match(validateVisual({ zzz: 1 }).warnings.join(), /visual: unknown key 'zzz'/);
});

test('validateProfile wires visual and leaves no-visual profiles unchanged', () => {
  const base = { platform: 'web', guards: ['g'] };
  assert.deepEqual(validateProfile(base, { skills: [] }), { errors: [], warnings: [] });
  const r = validateProfile({ ...base, visual: { tolerance_pct: -1 } }, { skills: [] });
  assert.deepEqual(r.errors, ['visual.tolerance_pct must be a positive number']);
  assert.deepEqual(validateProfile({ ...base, visual: loadFx('valid').visual }, { skills: [] }), { errors: [], warnings: [] });
});

test('AC3: feature init snapshots profile.visual deep-equal', () => {
  const fx = mkFixture();
  const profile = loadFx('valid');
  fx.write('.dev-cycle/project.json', JSON.stringify(profile));
  const r = runCli(['feature', 'init', 'vis', '--flow', 'feature', '--track', 'full'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  const fj = JSON.parse(fs.readFileSync(path.join(r.stdout.trim(), 'feature.json'), 'utf8'));
  assert.deepEqual(fj.profile.visual, profile.visual);
  fx.cleanup();
});

test('AC32: feature init without visual has no profile.visual', () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ guards: ['g'] }));
  const r = runCli(['feature', 'init', 'novis', '--flow', 'feature', '--track', 'full'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  const fj = JSON.parse(fs.readFileSync(path.join(r.stdout.trim(), 'feature.json'), 'utf8'));
  assert.deepEqual(fj.profile, { guards: ['g'] });
  fx.cleanup();
});

test('AC34: device guard — env wrappers, phone-only tools, script words', () => {
  const EMU = { device: 'emulator-5554' };
  assert.match(visualCmdProblems('ANDROID_SERIAL=x npx expo run:android --device {device}').join(), /ANDROID_SERIAL/);
  for (const cmd of ['cross-env A=1 adb install app.apk', 'dotenv -- adb devices', 'env-cmd adb devices', 'direnv exec . adb devices']) {
    assert.ok(visualCmdProblems(cmd).length > 0, cmd);
  }
  for (const tool of ['pymobiledevice3', 'tidevice', 'go-ios', 'ios', 'cfgutil', 'fastboot']) {
    assert.match(deviceGuardProblems(`${tool} list`, EMU).join(), /only reaches physical devices/, tool);
  }
  // scripts: allowed unless the basename minus extension is exactly a phone-only tool
  for (const cmd of ['./fastboot.sh flash', 'node scripts/ios.js', 'python tools/pymobiledevice3.py']) {
    assert.match(deviceGuardProblems(cmd, EMU).join(), /only reaches physical devices/, cmd);
  }
  assert.deepEqual(deviceGuardProblems('./fastboot-wrapper.sh flash', EMU), []);
  assert.equal(isDeviceSensitive('node scripts/adb.js'), false);
  assert.equal(isDeviceSensitive('./maestro.sh'), false);
  assert.equal(isDeviceSensitive('/opt/sdk/ADB.EXE devices'), true);
  assert.match(deviceGuardProblems('npx expo run:ios', { device: SIM }).join(), /no \{device\} placeholder/);
  // `ios` as a platform word is not the go-ios tool
  assert.deepEqual(deviceGuardProblems('node scripts/build.mjs --platform ios', EMU), []);
});
