import { uploadInputFrom } from './storage-upload';

const req = (extra: Record<string, unknown>) =>
  ({ headers: { 'content-type': 'text/plain', 'content-length': '5' }, ...extra }) as any;

describe('uploadInputFrom (raw body)', () => {
  it('streams a small body that has fully arrived but is not yet read', () => {
    const r = req({ complete: true });
    expect(uploadInputFrom(r, undefined).input.body).toBe(r);
  });

  it('recovers a body a parser already consumed from rawBody', () => {
    const raw = Buffer.from('hello');
    const r = req({ readableEnded: true, rawBody: raw });
    expect(uploadInputFrom(r, undefined).input.body).toBe(raw);
  });

  it('refuses a consumed body it cannot recover', () => {
    expect(() => uploadInputFrom(req({ readableEnded: true }), undefined)).toThrow(/consumed by a body parser/);
  });
});
