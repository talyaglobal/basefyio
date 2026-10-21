import {
  extractDocumentedRoutes,
  extractRoutes,
  normalizePath,
  routeKey,
} from './route-inventory';

describe('extractRoutes', () => {
  it('joins the global prefix, the controller prefix and the method path', () => {
    const src = `
      @Controller('rest/v1/auth')
      export class A {
        @Post('signin') signin() {}
      }`;
    expect(extractRoutes(src)).toEqual([{ method: 'POST', path: '/api/rest/v1/auth/signin' }]);
  });

  it('handles an empty method decorator and a decorator split across lines', () => {
    const src = `
      @Controller('projects/:projectId/realtime-bindings')
      export class B {
        @Get()
        list() {}
        @Put(
          'x/:id/',
        )
        put() {}
      }`;
    expect(extractRoutes(src)).toEqual([
      { method: 'GET', path: '/api/projects/:projectId/realtime-bindings' },
      { method: 'PUT', path: '/api/projects/:projectId/realtime-bindings/x/:id' },
    ]);
  });

  it('separates several controllers in one file', () => {
    const src = `
      @Controller('realtime/v1')
      export class S { @Get('stream') s() {} }
      @Controller('rest/v1/realtime/bindings')
      export class K { @Get() l() {} }`;
    expect(extractRoutes(src).map(routeKey)).toEqual([
      'GET /api/realtime/v1/stream',
      'GET /api/rest/v1/realtime/bindings',
    ]);
  });

  it('supports @Controller() without a prefix and the Codefyio exclusion', () => {
    expect(extractRoutes(`@Controller() class M { @Get('migrations/:runId') g() {} }`)).toEqual([
      { method: 'GET', path: '/api/migrations/:runId' },
    ]);
    expect(extractRoutes(`@Controller('_codefyio') class C { @Post('auth/exchange') e() {} }`)).toEqual([
      { method: 'POST', path: '/_codefyio/auth/exchange' },
    ]);
  });

  it('ignores commented-out decorators and non-route decorators', () => {
    const src = `
      @Controller('sql')
      export class Q {
        // @Get('old')
        /* @Delete('gone') */
        @UseGuards(X) @HttpCode(200)
        @Post('execute') run() {}
      }`;
    expect(extractRoutes(src).map(routeKey)).toEqual(['POST /api/sql/execute']);
  });
});

describe('normalizePath', () => {
  it('reduces every parameter form to ":" and drops query and trailing slash', () => {
    expect(normalizePath('/api/projects/:id/export/')).toBe('/api/projects/:/export');
    expect(normalizePath('/api/projects/<PROJECT_ID>/connect?x=1')).toBe('/api/projects/:/connect');
    expect(normalizePath('/api/projects/{id}/connect')).toBe('/api/projects/:/connect');
  });
});

describe('extractDocumentedRoutes', () => {
  it('reads inline code, table rows (with several methods) and request lines', () => {
    const md = [
      'Call `POST /api/sql/execute` with a body.',
      '| GET / HEAD | `/api/projects/:projectId/storage/buckets/:b/upload-sessions/:sid` | x |',
      '```',
      'GET /api/realtime/v1/stream',
      '```',
      'Not a route: `GET` alone, or /api/foo in prose.',
    ].join('\n');
    expect(extractDocumentedRoutes(md).map(routeKey)).toEqual([
      'POST /api/sql/execute',
      'GET /api/realtime/v1/stream',
      'GET /api/projects/:/storage/buckets/:/upload-sessions/:',
      'HEAD /api/projects/:/storage/buckets/:/upload-sessions/:',
    ]);
  });
});
