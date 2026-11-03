import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iosSimulator, parseSimctlDevices } from '../src/devices/ios.ts';
import { androidEmulator, parseAdbDevices } from '../src/devices/android.ts';
import type { Proc } from '../src/exec.ts';
import { fakeExec } from './fakes.ts';

const SIMS = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'AAA', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'BBB', name: 'iPad Pro', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'CCC', name: 'Watch', state: 'Booted', isAvailable: true }],
  },
});

function fakeStart(output = '') {
  const started: { cmd: string; args: string[] }[] = [];
  const stopped: string[] = [];
  const start = (cmd: string, args: string[]): Proc => {
    started.push({ cmd, args });
    const result = { code: 0, stdout: '', stderr: output, timedOut: false };
    return { output: () => output, done: Promise.resolve(result), stop: async (signal = 'SIGINT') => { stopped.push(signal); return result; } };
  };
  return { start, started, stopped };
}

test('ios: a hung simctl becomes a clear doctor problem, not a hang', async () => {
  const exec = fakeExec(() => ({ code: 124, timedOut: true }));
  const [problem] = await iosSimulator({ exec }).check();
  assert.match(problem, /did not answer within 15 seconds/);
  assert.match(problem, /CoreSimulatorService/);
  assert.equal(exec.calls[0].opts.timeoutMs, 15_000);
});

test('ios: reports missing Xcode and a missing named simulator', async () => {
  assert.match((await iosSimulator({ exec: fakeExec(() => ({ code: 127 })) }).check())[0], /Install Xcode/);
  const exec = fakeExec(() => ({ stdout: SIMS }));
  assert.match((await iosSimulator({ device: 'iPhone 99', exec }).check())[0], /No simulator named "iPhone 99"/);
  assert.deepEqual(await iosSimulator({ device: 'iPhone 17', exec }).check(), []);
});

test('ios: boots the chosen simulator, opens links and records with simctl', async () => {
  assert.deepEqual(parseSimctlDevices(SIMS).map((d) => d.udid), ['AAA', 'BBB']);
  const exec = fakeExec(() => ({ stdout: SIMS }));
  const { start, started, stopped } = fakeStart('Recording started');
  const ios = iosSimulator({ device: 'iPhone 17', exec, start });
  assert.equal(await ios.prepare(), 'AAA');
  assert.deepEqual(exec.calls.slice(1).map((c) => c.args.slice(0, 2)), [['simctl', 'boot'], ['simctl', 'bootstatus']]);
  await ios.openUrl('AAA', 'app://settings');
  assert.deepEqual(exec.calls.at(-1)?.args, ['simctl', 'openurl', 'AAA', 'app://settings']);
  const rec = await ios.record('AAA', '/tmp/ios-before.mp4');
  await rec.stop();
  assert.deepEqual(started[0].args, ['simctl', 'io', 'AAA', 'recordVideo', '--codec=h264', '--force', '/tmp/ios-before.mp4']);
  assert.deepEqual(stopped, ['SIGINT']);
  // With no device named, an already booted simulator is used without booting.
  const exec2 = fakeExec(() => ({ stdout: SIMS }));
  assert.equal(await iosSimulator({ exec: exec2 }).prepare(), 'BBB');
  assert.equal(exec2.calls.length, 1);
});

test('android: missing adb and emulator are reported clearly', async () => {
  const problems = await androidEmulator({ exec: fakeExec(() => ({ code: 127 })) }).check();
  assert.equal(problems.length, 2);
  assert.match(problems[0], /adb is not installed/);
  assert.match(problems[1], /emulator is not installed/);
});

test('android: uses ANDROID_HOME tools, finds a running emulator, and records with screenrecord', async () => {
  assert.deepEqual(parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n'), ['emulator-5554']);
  const exec = fakeExec((cmd, args) => {
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n' };
    if (args[0] === '-list-avds') return { stdout: 'Other_Phone\nPixel_9\n' };
    if (args.slice(2).join(' ') === 'emu avd name') return { stdout: `${args[1] === 'emulator-5556' ? 'Pixel_9' : 'Other_Phone'}\r\nOK\r\n` };
    return {};
  });
  const { start, started } = fakeStart('4242\n');
  const android = androidEmulator({ sdkDir: '/sdk', avd: 'Pixel_9', exec, start });
  assert.deepEqual(await android.check(), []);
  assert.equal(exec.calls[0].cmd, '/sdk/platform-tools/adb');
  assert.equal(exec.calls[1].cmd, '/sdk/emulator/emulator');
  assert.equal(await android.prepare(), 'emulator-5556', 'the configured AVD, not the first emulator running');
  assert.equal(await androidEmulator({ sdkDir: '/sdk', exec, start }).prepare(), 'emulator-5554', 'with no AVD set, any running emulator');
  const rec = await android.record('emulator-5556', '/tmp/android-after.mp4');
  await rec.stop();
  assert.deepEqual(started[0].args.slice(0, 3), ['-s', 'emulator-5556', 'shell']);
  assert.match(started[0].args[3], /^echo \$\$; exec screenrecord /);
  assert.ok(exec.calls.some((c) => c.args.slice(2).join(' ') === 'shell kill -INT 4242'), 'stops its own recorder by PID');
  assert.ok(!exec.calls.some((c) => c.args.includes('pkill')), 'never stops recordings it did not start');
  const pulled = exec.calls.find((c) => c.args[2] === 'pull');
  assert.equal(pulled?.args[4], '/tmp/android-after.mp4');
});
