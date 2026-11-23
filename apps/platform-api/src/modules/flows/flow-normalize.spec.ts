jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
import { normalizeFlowDefinition } from './flows.service';

/** #23: each action keeps only its own fields; an http.request without a method is a POST. */
describe('normalizeFlowDefinition', () => {
  it('drops a log message left on an action switched to http.request, and defaults the method', () => {
    const out = normalizeFlowDefinition({
      name: ' Notify ',
      trigger: { type: 'manual', cron: '* * * * *' } as any,
      actions: [{ type: 'http.request', url: ' https://example.com/hook ', message: 'Hello from flow' } as any],
    });
    expect(out.name).toBe('Notify');
    expect(out.trigger).toEqual({ type: 'manual' });
    expect(out.actions).toEqual([{ type: 'http.request', method: 'POST', url: 'https://example.com/hook' }]);
  });

  it('keeps a chosen method, headers, body and continueOnError; a log keeps only its message', () => {
    const out = normalizeFlowDefinition({
      name: 'x',
      trigger: { type: 'schedule', cron: ' */5 * * * * ' },
      actions: [
        { type: 'http.request', method: 'put' as any, url: 'https://e.x', headers: { a: '1' }, body: { b: 2 }, continueOnError: true },
        { type: 'log', message: ' done ', url: 'https://left.over' } as any,
      ],
    });
    expect(out.trigger).toEqual({ type: 'schedule', cron: '*/5 * * * *' });
    expect(out.actions).toEqual([
      { type: 'http.request', method: 'PUT', url: 'https://e.x', headers: { a: '1' }, body: { b: 2 }, continueOnError: true },
      { type: 'log', message: 'done' },
    ]);
  });
});
