// iOS Simulator through `xcrun simctl`. Every call has a timeout: simctl can hang when
// CoreSimulator is stuck, and doctor must say so instead of hanging too.
import { firstLine, run, start, type Exec, type Start } from '../exec.ts';
import type { DeviceProvider } from '../types.ts';

const LIST_TIMEOUT_MS = 15_000;
const RECORD_LIMIT_MS = 15 * 60_000;

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

export function parseSimctlDevices(json: string): SimDevice[] {
  const data = JSON.parse(json) as { devices: Record<string, SimDevice[]> };
  return Object.entries(data.devices)
    .filter(([runtime]) => runtime.includes('iOS'))
    .flatMap(([, list]) => list)
    .filter((d) => d.isAvailable !== false);
}

export function iosSimulator(opts: { device?: string; exec?: Exec; start?: Start } = {}): DeviceProvider {
  const exec = opts.exec ?? run;
  const startProc = opts.start ?? start;

  async function list(): Promise<SimDevice[]> {
    const r = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: LIST_TIMEOUT_MS });
    if (r.code === 127) throw new Error('xcrun not found. Install Xcode, then run `sudo xcode-select -s /Applications/Xcode.app`.');
    if (r.timedOut) {
      throw new Error(
        `\`xcrun simctl\` did not answer within ${LIST_TIMEOUT_MS / 1000} seconds, so CoreSimulator is probably stuck. ` +
          'Quit Simulator and Xcode, run `killall -9 com.apple.CoreSimulator.CoreSimulatorService`, then try again (a restart also fixes it).',
      );
    }
    if (r.code !== 0) throw new Error(`\`xcrun simctl list\` failed: ${firstLine(r.stderr)}`);
    return parseSimctlDevices(r.stdout);
  }

  function pick(devices: SimDevice[]): SimDevice | undefined {
    if (opts.device) return devices.find((d) => d.udid === opts.device || d.name === opts.device);
    return devices.find((d) => d.state === 'Booted') ?? devices.find((d) => d.name.startsWith('iPhone'));
  }

  async function simctl(args: string[], timeoutMs: number): Promise<void> {
    const r = await exec('xcrun', ['simctl', ...args], { timeoutMs });
    if (r.code !== 0) throw new Error(`\`xcrun simctl ${args[0]}\` failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr)}`);
  }

  return {
    platform: 'ios',
    name: 'iOS Simulator',

    async check() {
      try {
        const devices = await list();
        if (!devices.length) return ['No iOS simulators are installed. Add one in Xcode > Settings > Components.'];
        if (!pick(devices)) return [`No simulator named "${opts.device}". Run \`xcrun simctl list devices\` to see the names.`];
        return [];
      } catch (err) {
        return [(err as Error).message];
      }
    },

    async prepare() {
      const device = pick(await list());
      if (!device) throw new Error(opts.device ? `No simulator named "${opts.device}"` : 'No iPhone simulator is installed');
      if (device.state !== 'Booted') {
        await simctl(['boot', device.udid], 120_000);
        await simctl(['bootstatus', device.udid, '-b'], 300_000);
      }
      return device.udid;
    },

    async openUrl(deviceId, url) {
      await simctl(['openurl', deviceId, url], 30_000);
    },

    async record(deviceId, file) {
      const proc = startProc('xcrun', ['simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', file], { timeoutMs: RECORD_LIMIT_MS });
      // simctl prints "Recording started" once frames are being written.
      for (let waited = 0; waited < 10_000 && !/Recording started/i.test(proc.output()); waited += 250) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return {
        async stop() {
          const r = await proc.stop('SIGINT');
          if (r.code !== 0 && !/Wrote video/i.test(r.stderr + r.stdout)) {
            throw new Error(`iOS recording failed: ${firstLine(r.stderr) || `exit code ${r.code}`}`);
          }
        },
      };
    },
  };
}
