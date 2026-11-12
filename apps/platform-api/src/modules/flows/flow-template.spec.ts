import { placeholderError, renderString, renderValue, resolvePath, TemplateContext } from './flow-template';

const ctx: TemplateContext = {
  input: { x: 'hello world', n: 42, user: { email: 'a@b.co', tags: ['x', 'y'] }, url: 'https://example.com/a?b=1' },
  steps: { 0: { status: 201, body: { id: 'abc' } }, fetchUser: { body: { id: 7 } } },
  trigger: { headers: { 'x-github-event': 'push' } },
  run: { id: 'run-1' },
  flow: { id: 'flow-1', name: 'demo' },
  now: '2026-10-22T10:00:00.000Z',
};

describe('flow templates', () => {
  it('resolves input, steps by index and name, trigger headers, run and flow', () => {
    expect(renderString('{{input.x}}', ctx).value).toBe('hello world');
    expect(renderString('{{ steps.0.status }}', ctx).value).toBe('201');
    expect(renderString('{{steps.fetchUser.body.id}}', ctx).value).toBe('7');
    expect(renderString('{{trigger.headers.x-github-event}}', ctx).value).toBe('push');
    expect(renderString('{{run.id}}/{{flow.name}}/{{now}}', ctx).value).toBe('run-1/demo/2026-10-22T10:00:00.000Z');
    expect(renderString('{{input.user.tags[1]}} {{input.user.tags.0}}', ctx).value).toBe('y x');
  });

  it('reports placeholders that resolve to nothing instead of sending them literally', () => {
    const r = renderString('id={{input.missing}}', ctx);
    expect(r.value).toBe('id=');
    expect(r.missing).toEqual(['input.missing']);
  });

  it('URL-encodes inserted values but takes a whole-URL placeholder as given', () => {
    expect(renderString('https://api.example.com/q?s={{input.x}}', ctx, 'url').value).toBe(
      'https://api.example.com/q?s=hello%20world',
    );
    expect(renderString('{{input.url}}', ctx, 'url').value).toBe('https://example.com/a?b=1');
  });

  it('strips line breaks from header values', () => {
    const c: TemplateContext = { input: { v: 'a\r\nX-Evil: 1' } };
    expect(renderString('Bearer {{input.v}}', c, 'header').value).toBe('Bearer a X-Evil: 1');
  });

  it('keeps the type of a value that is exactly one placeholder', () => {
    const r = renderValue({ total: '{{input.n}}', user: '{{input.user}}', note: 'n={{input.n}}', list: ['{{steps.0.body.id}}'] }, ctx);
    expect(r.value).toEqual({
      total: 42,
      user: { email: 'a@b.co', tags: ['x', 'y'] },
      note: 'n=42',
      list: ['abc'],
    });
  });

  it('cannot walk into prototypes or outside the context', () => {
    expect(resolvePath(ctx, 'input.__proto__')).toBeUndefined();
    expect(resolvePath(ctx, 'input.constructor')).toBeUndefined();
    expect(resolvePath(ctx, 'input.x.length')).toBeUndefined();
    expect(resolvePath(ctx, 'process.env')).toBeUndefined();
    expect(renderString('{{process.env.SECRET}}', ctx).value).toBe('');
  });

  it('validates placeholders at save time', () => {
    expect(placeholderError('input.a.b')).toBeNull();
    expect(placeholderError('steps.0.body')).toBeNull();
    expect(placeholderError('env.SECRET')).toEqual(expect.stringContaining('must start with'));
    expect(placeholderError('input.a + 1')).toEqual(expect.stringContaining('not a valid placeholder'));
  });
});
