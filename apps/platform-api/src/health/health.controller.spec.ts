import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('reports ok status for the platform-api service', () => {
    const res = controller.check();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('platform-api');
  });

  it('includes a numeric uptime and ISO timestamp', () => {
    const res = controller.check();
    expect(typeof res.uptime).toBe('number');
    expect(res.uptime).toBeGreaterThanOrEqual(0);
    expect(() => new Date(res.timestamp).toISOString()).not.toThrow();
    expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp);
  });
});
