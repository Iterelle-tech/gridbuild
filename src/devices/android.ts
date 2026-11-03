// Android Emulator through `adb` and `emulator` from the Android SDK. Every call has a timeout.
import { join } from 'node:path';
import { firstLine, run, start, type Exec, type Start } from '../exec.ts';
import type { DeviceProvider } from '../types.ts';

const RECORD_LIMIT_SECONDS = 180; // screenrecord's own maximum

/** Serials of running emulators that are ready, from `adb devices`. */
export function parseAdbDevices(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith('emulator-') && state === 'device')
    .map(([serial]) => serial);
}

export function androidEmulator(opts: { avd?: string; sdkDir?: string; exec?: Exec; start?: Start } = {}): DeviceProvider {
  const exec = opts.exec ?? run;
  const startProc = opts.start ?? start;
  const sdk = opts.sdkDir ?? process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const adb = sdk ? join(sdk, 'platform-tools', 'adb') : 'adb';
  const emulator = sdk ? join(sdk, 'emulator', 'emulator') : 'emulator';

  async function adbRun(args: string[], timeoutMs = 30_000): Promise<string> {
    const r = await exec(adb, args, { timeoutMs });
    if (r.code !== 0) throw new Error(`\`adb ${args.join(' ')}\` failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr || r.stdout)}`);
    return r.stdout;
  }

  async function avds(): Promise<string[]> {
    const r = await exec(emulator, ['-list-avds'], { timeoutMs: 15_000 });
    if (r.code === 127) {
      throw new Error('The Android emulator is not installed. Install it in Android Studio > SDK Manager > SDK Tools, then set ANDROID_HOME.');
    }
    if (r.code !== 0) throw new Error(`\`emulator -list-avds\` failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr)}`);
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('INFO'));
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The AVD name of a running emulator, from its console. */
  async function avdName(serial: string): Promise<string | undefined> {
    const r = await exec(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 15_000 });
    return r.code === 0 ? firstLine(r.stdout) || undefined : undefined;
  }

  /** A running emulator for `avd`, or with no AVD configured, any running emulator. */
  async function running(avd: string | undefined): Promise<string | undefined> {
    for (const serial of parseAdbDevices(await adbRun(['devices'], 15_000))) {
      if (!avd || (await avdName(serial)) === avd) return serial;
    }
    return undefined;
  }

  return {
    platform: 'android',
    name: 'Android Emulator',

    async check() {
      const problems: string[] = [];
      const version = await exec(adb, ['version'], { timeoutMs: 10_000 });
      if (version.code === 127) {
        problems.push('adb is not installed. Install Android Studio (or the SDK platform-tools), then set ANDROID_HOME or add platform-tools to your PATH.');
      } else if (version.code !== 0) {
        problems.push(`\`adb version\` failed${version.timedOut ? ' (timed out)' : ''}: ${firstLine(version.stderr)}`);
      }
      try {
        const names = await avds();
        if (!names.length) problems.push('No Android virtual devices. Create one in Android Studio > Device Manager.');
        else if (opts.avd && !names.includes(opts.avd)) problems.push(`No Android virtual device named "${opts.avd}". You have: ${names.join(', ')}.`);
      } catch (err) {
        problems.push((err as Error).message);
      }
      return problems;
    },

    async prepare() {
      const found = await running(opts.avd);
      if (found) return found;
      const avd = opts.avd ?? (await avds())[0];
      if (!avd) throw new Error('No Android virtual device to start');
      // Left running for the next task; killed with Gridbuild.
      startProc(emulator, ['-avd', avd, '-no-snapshot-save', '-no-boot-anim'], { timeoutMs: 24 * 3600_000 });
      for (let waited = 0; waited < 300_000; waited += 5000) {
        await sleep(5000);
        const serial = await running(avd);
        if (!serial) continue;
        const booted = await exec(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 15_000 });
        if (booted.stdout.trim() === '1') return serial;
      }
      throw new Error(`The Android emulator "${avd}" did not finish booting within 5 minutes`);
    },

    async openUrl(deviceId, url) {
      await adbRun(['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
    },

    async record(deviceId, file) {
      const remote = `/sdcard/gridbuild-${Date.now()}.mp4`;
      // The shell prints its PID, then becomes screenrecord, so stop() ends only this recording.
      const proc = startProc(adb, ['-s', deviceId, 'shell', `echo $$; exec screenrecord --time-limit ${RECORD_LIMIT_SECONDS} ${remote}`], {
        timeoutMs: (RECORD_LIMIT_SECONDS + 30) * 1000,
      });
      let pid: string | undefined;
      for (let waited = 0; waited < 5000 && !pid; waited += 250) {
        pid = /^\s*(\d+)\s*$/m.exec(proc.output())?.[1];
        if (!pid) await sleep(250);
      }
      await sleep(1000);
      return {
        async stop() {
          if (pid) await exec(adb, ['-s', deviceId, 'shell', 'kill', '-INT', pid], { timeoutMs: 10_000 });
          await Promise.race([proc.done, sleep(10_000)]);
          await proc.stop('SIGINT', 5000);
          await sleep(1000); // let the device finish writing the file
          await adbRun(['-s', deviceId, 'pull', remote, file], 120_000);
          await exec(adb, ['-s', deviceId, 'shell', 'rm', '-f', remote], { timeoutMs: 10_000 });
        },
      };
    },
  };
}
