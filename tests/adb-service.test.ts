import { describe, expect, it } from 'vitest';
import {
  AdbService,
  parseAdbDevices,
  parseAdbProxyValue,
  parseAdbReverseListHas,
  pickActiveSerial,
  type AdbRunner,
} from '../src/main/adb/adb-service';

const DEVICES_OUTPUT = [
  'List of devices attached',
  '* daemon not running; starting now at tcp:5037',
  'ABC123\tdevice',
  'DEF456\tunauthorized',
  '',
].join('\n');

describe('parseAdbDevices', () => {
  it('parses serial/state lines and skips header and daemon noise', () => {
    expect(parseAdbDevices(DEVICES_OUTPUT)).toEqual([
      { serial: 'ABC123', state: 'device' },
      { serial: 'DEF456', state: 'unauthorized' },
    ]);
  });
  it('returns empty for no devices', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual([]);
  });
});

describe('pickActiveSerial', () => {
  it('picks first authorized device', () => {
    expect(pickActiveSerial(parseAdbDevices(DEVICES_OUTPUT))).toBe('ABC123');
  });
  it('returns undefined when none authorized', () => {
    expect(pickActiveSerial([{ serial: 'X', state: 'unauthorized' }])).toBeUndefined();
  });
});

describe('parseAdbReverseListHas', () => {
  it('detects port in reverse list', () => {
    expect(parseAdbReverseListHas('ABC123 tcp:8888 tcp:8888\n', 8888)).toBe(true);
  });
  it('misses when port absent or empty', () => {
    expect(parseAdbReverseListHas('', 8888)).toBe(false);
    expect(parseAdbReverseListHas('ABC123 tcp:9999 tcp:9998\n', 8888)).toBe(false);
  });
});

describe('parseAdbProxyValue', () => {
  it('treats null/empty as not set', () => {
    expect(parseAdbProxyValue('null\n')).toBe(false);
    expect(parseAdbProxyValue('\n')).toBe(false);
  });
  it('treats any value as set', () => {
    expect(parseAdbProxyValue('127.0.0.1:8888\n')).toBe(true);
    expect(parseAdbProxyValue(':0\n')).toBe(true);
  });
});

describe('AdbService', () => {
  function service(script: (args: string[]) => string | Error, calls?: string[][]) {
    const runner: AdbRunner = (file, args) => {
      calls?.push([file, ...args]);
      const out = script(args);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out);
    };
    return new AdbService(runner);
  }
  const enoent = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });

  it('status reports adb unavailable with install hint on ENOENT', async () => {
    const st = await service(() => enoent).status(8888);
    expect(st.adbAvailable).toBe(false);
    expect(st.installHint).toContain('adb');
  });

  it('status aggregates devices/tunnel/phone proxy', async () => {
    const st = await service((args) => {
      if (args[0] === 'version') return 'Android Debug Bridge version 1.0.41';
      if (args[0] === 'devices') return DEVICES_OUTPUT;
      if (args[0] === 'reverse') return 'ABC123 tcp:8888 tcp:8888\n';
      if (args[0] === 'shell') return '127.0.0.1:8888\n';
      return '';
    }).status(8888);
    expect(st.adbAvailable).toBe(true);
    expect(st.activeSerial).toBe('ABC123');
    expect(st.tunnelActive).toBe(true);
    expect(st.phoneProxySet).toBe(true);
  });

  it('ops refuse without an authorized device', async () => {
    const calls: string[][] = [];
    const svc = service((args) => (args[0] === 'devices' ? 'List of devices attached\nDEF\toffline\n' : ''), calls);
    expect((await svc.setupTunnel(8888)).ok).toBe(false);
    expect((await svc.setPhoneProxy(8888)).ok).toBe(false);
    expect((await svc.clearPhoneProxy()).ok).toBe(false);
    expect(calls.some((c) => c.includes('reverse'))).toBe(false);
  });

  it('setupTunnel uses -s serial and correct args', async () => {
    const calls: string[][] = [];
    const svc = service((args) => (args[0] === 'devices' ? DEVICES_OUTPUT : ''), calls);
    const res = await svc.setupTunnel(8888);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.join(' ') === ['adb', '-s', 'ABC123', 'reverse', 'tcp:8888', 'tcp:8888'].join(' '))).toBe(true);
  });

  it('setPhoneProxy and clearPhoneProxy build expected commands', async () => {
    const calls: string[][] = [];
    const svc = service((args) => (args[0] === 'devices' ? DEVICES_OUTPUT : ''), calls);
    await svc.setPhoneProxy(8888);
    await svc.clearPhoneProxy();
    expect(calls.some((c) => c.join(' ') === 'adb -s ABC123 shell settings put global http_proxy 127.0.0.1:8888')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'adb -s ABC123 shell settings put global http_proxy :0')).toBe(true);
  });

  it('op failure carries stderr message', async () => {
    const svc = service((args) => {
      if (args[0] === 'devices') return DEVICES_OUTPUT;
      return new Error('command failed: device unauthorized');
    });
    const res = await svc.setupTunnel(8888);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('device unauthorized');
  });
});
