import { assertSafeUrl } from './flow-url-guard';

/**
 * A flow's http.request runs from inside the platform network, so the guard's
 * job is to keep a customer-supplied URL pointed at the public internet. The
 * previous version compared the hostname against a list of strings, which let
 * through every service in our own compose file.
 */
describe('assertSafeUrl (Flows SSRF guard)', () => {
  const blocked = (url: string) => expect(assertSafeUrl(url)).rejects.toThrow();
  const allowed = (url: string) => expect(assertSafeUrl(url)).resolves.toBeUndefined();

  describe('protocol', () => {
    it.each(['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com'])(
      'refuses %s',
      (u) => blocked(u),
    );
  });

  /**
   * The case the string denylist missed entirely: a container name has no dot,
   * matches no private-range pattern, and Docker's DNS resolves it.
   */
  describe('our own container names', () => {
    it.each(['http://postgres:5432', 'http://keycloak:8080', 'http://minio:9000', 'http://redis:6379'])(
      'refuses %s',
      (u) => blocked(u),
    );
  });

  describe('loopback and private ranges, written plainly', () => {
    it.each([
      'http://127.0.0.1/',
      'http://localhost/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
    ])('refuses %s', (u) => blocked(u));
  });

  /** Same addresses, written so a textual check does not recognise them. */
  describe('loopback and private ranges, written another way', () => {
    it.each([
      'http://0.0.0.0/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://100.64.0.1/',
    ])('refuses %s', (u) => blocked(u));
  });

  describe('suffixes that only resolve internally', () => {
    it.each(['http://db.local/', 'http://api.internal/'])('refuses %s', (u) => blocked(u));
  });

  it('refuses a name that does not resolve, rather than letting it time out', () =>
    blocked('http://this-host-does-not-exist-basefyio-test.example/'));

  describe('public destinations still work', () => {
    it.each(['https://example.com/webhook', 'http://example.com/x'])('allows %s', (u) => allowed(u));
  });
});
