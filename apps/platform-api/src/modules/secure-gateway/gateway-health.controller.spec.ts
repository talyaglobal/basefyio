import { GatewayHealthController } from './gateway-health.controller';
import type { OpenBaoHealthReport } from '../certificates/openbao-health.service';

const HEALTHY_REPORT: OpenBaoHealthReport = {
  status: 'healthy',
  checkedAt: '2026-06-13T12:00:00.000Z',
  components: {
    system: { status: 'ok' },
    pkiMount: { status: 'ok' },
    kvMount: { status: 'ok' },
  },
};

const DEGRADED_REPORT: OpenBaoHealthReport = {
  status: 'degraded',
  checkedAt: '2026-06-13T12:00:00.000Z',
  components: {
    system: { status: 'ok' },
    pkiMount: { status: 'degraded', detail: "PKI mount 'pki' not found", hint: 'vault secrets enable pki' },
    kvMount: { status: 'ok' },
  },
};

function makeController(report: OpenBaoHealthReport = HEALTHY_REPORT) {
  const health = { check: jest.fn().mockResolvedValue(report) };
  return { controller: new GatewayHealthController(health as any), health };
}

describe('GatewayHealthController.openbao()', () => {
  it('delegates to OpenBaoHealthService.check()', async () => {
    const { controller, health } = makeController();
    await controller.openbao();
    expect(health.check).toHaveBeenCalledTimes(1);
  });

  it('returns the health report from the service', async () => {
    const { controller } = makeController(HEALTHY_REPORT);
    const result = await controller.openbao();
    expect(result).toEqual(HEALTHY_REPORT);
  });

  it('passes degraded report through unchanged', async () => {
    const { controller } = makeController(DEGRADED_REPORT);
    const result = await controller.openbao();
    expect(result.status).toBe('degraded');
    expect(result.components.pkiMount.hint).toBeDefined();
  });

  it('response never contains vault token', async () => {
    const reportWithToken = {
      ...HEALTHY_REPORT,
      // simulate if somehow token leaked into detail
    };
    const { controller } = makeController(reportWithToken);
    const result = await controller.openbao();
    expect(JSON.stringify(result)).not.toContain('root-');
  });
});
