import { PaymentProbeService } from './payment-probe.service';

function setup(results: Array<{ check: string; problem?: string }>[]) {
  const raised: any[] = [];
  let i = 0;
  const stripe = {
    isEnabled: () => true,
    probeChannels: async () => results[Math.min(i++, results.length - 1)],
  };
  const config = { get: () => 'pk_live_x' };
  const alerts = { raise: async (a: any) => void raised.push(a) };
  return { svc: new PaymentProbeService(stripe as any, config as any, alerts as any), raised };
}

const bad = [{ check: 'card-form', problem: 'HTTP 401' }];
const good = [{ check: 'card-form' }];

describe('PaymentProbeService', () => {
  it('stays quiet while everything passes', async () => {
    const { svc, raised } = setup([good]);
    await svc.run();
    await svc.run();
    expect(raised).toHaveLength(0);
  });

  it('does not alert on a single failing run', async () => {
    const { svc, raised } = setup([bad, good, bad]);
    await svc.run();
    await svc.run();
    await svc.run();
    expect(raised).toHaveLength(0);
  });

  it('raises a critical alert on two failing runs in a row', async () => {
    const { svc, raised } = setup([bad]);
    await svc.run();
    await svc.run();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'payment_probe_failed', severity: 'critical' });
  });
});
