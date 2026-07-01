import { BadRequestException } from '@nestjs/common';

/**
 * SSRF guard for the Flows `http.request` action: only allow public http(s)
 * URLs, blocking loopback, link-local, and RFC-1918 private ranges plus
 * internal hostnames. Extracted as a pure function so it is unit tested
 * independently of the service. Throws BadRequestException on a blocked URL.
 */
export function assertSafeUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BadRequestException('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BadRequestException('only http(s) urls are allowed');
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new BadRequestException('url host is not allowed');
}
