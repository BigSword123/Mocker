import { describe, expect, it } from 'vitest';
import { parseDefaultInterface, parseServiceOrder } from '../src/main/system-proxy/macos';

describe('parseServiceOrder', () => {
  const sample = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)
(2) Thunderbolt 桥接
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
`;

  it('extracts service name and device', () => {
    expect(parseServiceOrder(sample)).toEqual([
      { service: 'Wi-Fi', device: 'en0' },
      { service: 'Thunderbolt 桥接', device: 'bridge0' },
    ]);
  });
});

describe('parseDefaultInterface', () => {
  it('extracts interface from route output', () => {
    const sample = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UGSc>
`;
    expect(parseDefaultInterface(sample)).toBe('en0');
  });

  it('returns undefined when missing', () => {
    expect(parseDefaultInterface('no route')).toBeUndefined();
  });
});
