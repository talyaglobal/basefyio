import { assertSafeUrl } from './flow-url-guard';

describe('assertSafeUrl (Flows SSRF guard)', () => {
  it('allows public http(s) URLs', () => {
    expect(() => assertSafeUrl('https://example.com/webhook')).not.toThrow();
    expect(() => assertSafeUrl('http://api.github.com/x')).not.toThrow();
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => assertSafeUrl('ftp://example.com')).toThrow();
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
  });

  it('rejects loopback / localhost', () => {
    expect(() => assertSafeUrl('http://localhost/x')).toThrow();
    expect(() => assertSafeUrl('http://127.0.0.1/x')).toThrow();
    expect(() => assertSafeUrl('http://0.0.0.0/x')).toThrow();
  });

  it('rejects RFC-1918 private and link-local ranges', () => {
    for (const h of [
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://172.31.255.1/x',
      'http://169.254.169.254/latest/meta-data', // cloud metadata endpoint
    ]) {
      expect(() => assertSafeUrl(h)).toThrow();
    }
  });

  it('allows a public 172.x address outside the private block', () => {
    expect(() => assertSafeUrl('http://172.15.0.1/x')).not.toThrow();
    expect(() => assertSafeUrl('http://172.32.0.1/x')).not.toThrow();
  });

  it('rejects internal hostnames and malformed URLs', () => {
    expect(() => assertSafeUrl('http://db.internal/x')).toThrow();
    expect(() => assertSafeUrl('http://svc.local/x')).toThrow();
    expect(() => assertSafeUrl('not a url')).toThrow();
  });
});
