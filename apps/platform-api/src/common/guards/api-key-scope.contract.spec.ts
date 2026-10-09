import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What a public key may reach, asserted on the controllers themselves.
 *
 * The anon key ships inside every customer's browser bundle, so a route it can
 * reach is a route the whole internet can reach. All of the controllers listed
 * below were reachable with it: the user directory and the identity-provider
 * configuration, DDL and owner-level row access with no RLS, and — worst — GET
 * /projects/:id/connect, which returned the database password together with
 * the project's own service key, turning the public key into owner credentials
 * in a single request.
 *
 * The guard that enforces these declarations is covered by unit tests in
 * api-key.guard.spec.ts. What this file guards is the declarations themselves:
 * deleting one reopens a hole, and because the hole is then the *absence* of a
 * line, no ordinary test would fail.
 *
 * It reads the sources as text rather than importing the controllers. That is
 * deliberate: importing all thirteen pulls in the whole dependency graph —
 * an ESM-only Keycloak client, a dockerode typing clash — and a tripwire that
 * breaks for reasons unrelated to what it checks gets deleted. Text is enough
 * to answer the one question asked here, which is whether the line is still
 * there.
 */
const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Controllers where the service key is the default for every route. */
const SERVICE_BY_DEFAULT: Array<[string, string]> = [
  ['the user directory and the IdP config', 'modules/projects/project-auth.controller.ts'],
  ['bucket administration', 'modules/storage/storage.controller.ts'],
  ['DDL, owner-level rows, and the connect credentials', 'modules/projects/project-data.controller.ts'],
  ['owner-level documents with no RLS', 'modules/projects/collection.controller.ts'],
  ['entity DDL and provisioning side effects', 'modules/data-engine/data-engine.controller.ts'],
  ['an arbitrary query DSL on the owner pool', 'modules/data-query/data-query.controller.ts'],
  ['automations that make outbound requests', 'modules/flows/flows.controller.ts'],
  ['billed embedding calls over the whole corpus', 'modules/rag/rag.controller.ts'],
  ['threads with no per-user ownership check', 'modules/agent/agent.controller.ts'],
  ['agent configuration and billed inference', 'modules/agent/agent-creation.controller.ts'],
  ['structure DDL', 'modules/data-structures/data-structures.controller.ts'],
  ['creating projects and touching credential storage', 'modules/provisioning/provisioning.controller.ts'],
];

describe('API key scope — controller contract', () => {
  describe.each(SERVICE_BY_DEFAULT)('%s', (_why, file) => {
    const src = read(file);

    it('declares the service key as its class-level default', () => {
      // Anywhere in the controller's own decorator block counts: decorator
      // order does not affect the metadata, and these files interleave
      // @UseGuards and @UseInterceptors differently.
      const at = src.search(/@Controller\(/);
      expect(at).toBeGreaterThan(-1);
      const decl = src.slice(at).search(/export class \w+Controller/);
      expect(decl).toBeGreaterThan(-1);
      expect(src.slice(at, at + decl)).toContain('@ServiceKeyOnly()');
    });

    it('imports the decorator it declares', () => {
      expect(src).toContain('api-key-scope.decorator');
    });
  });

  /**
   * The route that made the rest moot. It is covered by the class-level
   * default above, but it is named here so that a future carve-out on this
   * controller cannot quietly include it.
   */
  it('never carves the connection-string route out of the service-key default', () => {
    const src = read('modules/projects/project-data.controller.ts');
    const connect = src.slice(src.indexOf("@Get('connect')"));
    const handler = connect.slice(0, connect.indexOf('async getConnectionStrings'));
    expect(handler).not.toMatch(/@AnonKeyAllowed\(\)|@AuthenticatedKeyOnly\(\)/);
  });

  describe('storage carve-outs', () => {
    const src = read('modules/storage/storage.controller.ts');

    /**
     * The scope decorators belonging to one handler: those between its own
     * HTTP-method decorator and the handler itself. A plain lookback window
     * would reach past the route above and read its decorator as this one's.
     */
    const scopeOf = (handler: string): string[] => {
      const at = src.indexOf(`async ${handler}(`);
      expect(at).toBeGreaterThan(-1);
      const before = src.slice(0, at);
      const route = Math.max(
        ...['@Get(', '@Post(', '@Put(', '@Patch(', '@Delete('].map((d) => before.lastIndexOf(d)),
      );
      expect(route).toBeGreaterThan(-1);
      const own = src.slice(route, at);
      return (own.match(/@(ServiceKeyOnly|AuthenticatedKeyOnly|AnonKeyAllowed)\(\)/g) ?? []).map((m) =>
        m.replace(/@|\(\)/g, ''),
      );
    };

    it.each(['uploadObject', 'deleteObjects', 'moveObjects', 'listObjects', 'getPresignedUrl'])(
      '%s requires a signed-in end user, not a bare public key',
      (handler) => {
        expect(scopeOf(handler)).toContain('AuthenticatedKeyOnly');
      },
    );

    it.each(['getPublicUrl', 'downloadObject'])(
      '%s stays public, because an <img> tag cannot send an apikey header',
      (handler) => {
        expect(scopeOf(handler)).toContain('AnonKeyAllowed');
      },
    );

    it.each(['createBucket', 'deleteBucket', 'updateBucket'])(
      '%s is left on the service-key default',
      (handler) => {
        expect(scopeOf(handler)).toEqual([]);
      },
    );
  });

  describe('tenant embeddings', () => {
    const src = read('modules/tenant-embedding/tenant-embedding-public.controller.ts');
    const declared = (handler: string) => {
      const at = src.indexOf(`async ${handler}(`);
      expect(at).toBeGreaterThan(-1);
      const before = src.slice(0, at);
      const route = Math.max(
        ...['@Get(', '@Post(', '@Put(', '@Patch(', '@Delete('].map((d) => before.lastIndexOf(d)),
      );
      expect(route).toBeGreaterThan(-1);
      const m =
        src.slice(route, at).match(/@(ServiceKeyOnly|AuthenticatedKeyOnly|AnonKeyAllowed)\(\)/g) ?? [];
      return m.map((x) => x.replace(/@|\(\)/g, '')).pop();
    };

    it.each(['store', 'storeBatch', 'deleteByIds', 'deleteByNamespace'])(
      '%s is service-key only, since each call bills the embedding provider',
      (handler) => {
        expect(declared(handler)).toBe('ServiceKeyOnly');
      },
    );

    it('search requires a signed-in end user', () => {
      expect(declared('search')).toBe('AuthenticatedKeyOnly');
    });

    it('status stays public — counts and health only', () => {
      expect(declared('status')).toBe('AnonKeyAllowed');
    });
  });

  /**
   * The RLS-governed data plane is deliberately absent from the list above.
   * /rest/v1 runs under SET LOCAL ROLE as the caller's own Postgres role, so an
   * owner who writes a policy admitting anonymous reads gets them. Locking it
   * by scope would override the policy engine that is the whole point of it.
   */
  it.each([
    'modules/projects/public-api.controller.ts',
    'modules/projects/public-collection-api.controller.ts',
  ])('leaves %s to its policies', (file) => {
    expect(read(file)).not.toContain('@ServiceKeyOnly()');
  });
});
