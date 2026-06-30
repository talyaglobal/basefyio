import { describe, expect, it } from 'vitest';
import { allPassed, checkNodeVersion, runDoctor } from './doctor';

describe('checkNodeVersion', () => {
  it('passes for Node 20+', () => {
    expect(checkNodeVersion('v20.11.0').ok).toBe(true);
    expect(checkNodeVersion('v22.0.0').ok).toBe(true);
  });

  it('fails for Node < 20', () => {
    const c = checkNodeVersion('v18.19.0');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('need >= 20');
  });
});

describe('runDoctor', () => {
  it('flags missing docker', () => {
    const checks = runDoctor({ nodeVersion: 'v20.11.0', hasDocker: false });
    const docker = checks.find((c) => c.name === 'Docker available');
    expect(docker?.ok).toBe(false);
  });

  it('omits the API check when no url is given', () => {
    const checks = runDoctor({ nodeVersion: 'v20.11.0', hasDocker: true });
    expect(checks.some((c) => c.name.startsWith('Platform API'))).toBe(false);
    expect(allPassed(checks)).toBe(true);
  });

  it('includes the API check when a url is probed', () => {
    const checks = runDoctor({
      nodeVersion: 'v20.11.0',
      hasDocker: true,
      apiUrl: 'http://localhost:4000',
      apiReachable: true,
    });
    const api = checks.find((c) => c.name.startsWith('Platform API'));
    expect(api?.ok).toBe(true);
  });
});
