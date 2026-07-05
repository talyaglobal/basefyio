// Stub heavy product services (transitively import ESM-only keycloak client).
jest.mock('../modules/projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../modules/projects/collection.service', () => ({ CollectionService: class {} }));
jest.mock('../modules/sql/sql.service', () => ({ SqlService: class {} }));

import { CodefyioController } from './codefyio.controller';
import { ADAPTER_VERSION } from './codefyio.constants';

const config = { get: (k: string) => (k === 'codefyio.origin' ? 'https://ide.codefyio.com' : undefined) } as any;

function makeRes() {
  return { header: jest.fn(), json: jest.fn(), write: jest.fn(), flushHeaders: jest.fn() } as any;
}

describe('CodefyioController', () => {
  it('GET /health returns ok + version with no auth and CORS locked to the Codefyio origin', () => {
    const controller = new CodefyioController({} as any, {} as any, config);
    const res = makeRes();
    controller.health({ headers: {} } as any, res);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', version: ADAPTER_VERSION });
    expect(res.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://ide.codefyio.com');
  });

  it('GET /manifest advertises the id, endpoints and action allow-list', () => {
    const controller = new CodefyioController({} as any, {} as any, config);
    const res = makeRes();
    controller.manifest({ headers: {} } as any, res);
    const manifest = res.json.mock.calls[0][0];
    expect(manifest.id).toBe('basefyio');
    expect(manifest.endpoints.health).toBe('/_codefyio/health');
    expect(manifest.actions.map((a: any) => a.action)).toContain('sql.run');
  });
});
