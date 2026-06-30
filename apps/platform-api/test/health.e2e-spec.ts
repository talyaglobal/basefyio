import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from '../src/modules/health/health.controller';

/**
 * Integration smoke test: boots the real HealthController through a Nest HTTP
 * server (with the production global prefix) and asserts the liveness route.
 *
 * Scope note: this intentionally mounts only HealthController, not AppModule —
 * a fast, portable contract check. (Boot resilience to a missing Keycloak is a
 * separate concern, now handled by KeycloakAdminService's non-fatal init, so a
 * full-app boot smoke against the CI Postgres+Redis services is also possible.)
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // Bind to loopback explicitly: supertest(app.getHttpServer()) otherwise
    // ephemeral-listens on 0.0.0.0, which is denied (EPERM) in hardened CI
    // sandboxes. Loopback keeps this smoke portable across runners.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns 200 with ok status', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
