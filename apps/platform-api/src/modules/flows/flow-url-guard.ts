import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * SSRF guard for the Flows `http.request` action.
 *
 * A flow runs inside the platform network, so a URL a customer supplies is a
 * request we make on their behalf from a position they do not have. The whole
 * job of this guard is to keep that request pointed at the public internet.
 *
 * It used to compare the hostname against a list of strings. That missed three
 * things, each of which reaches the internal network on its own:
 *
 *  - a bare container name. `http://postgres:5432` has no dot, matches no
 *    pattern in a denylist, and Docker's DNS resolves it. Every service in our
 *    own compose file was reachable this way.
 *  - a public hostname that resolves to a private address. Nothing stops an
 *    attacker pointing their own domain at 10.0.0.1; the string looks fine.
 *  - an address written another way. 2130706433, 0x7f000001 and [::ffff:127.0.0.1]
 *    are all loopback, and none of them start with "127.".
 *
 * So the check is on the ADDRESS now, not the text: resolve the host and refuse
 * if any answer is loopback, link-local, private, unique-local or otherwise not
 * a public unicast address. A hostname with no dot is refused outright, since
 * that is what a container name looks like and a public host always has one.
 *
 * One honest limit: between this check and the request, DNS can answer
 * differently — the classic rebinding window. Closing it means pinning the
 * resolved address into the connection, which the HTTP client here does not
 * expose. This narrows the hole from "trivially open" to "needs a timing
 * attack against a per-action lookup", and the remaining gap is recorded here
 * rather than left to be rediscovered.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BadRequestException('invalid url');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BadRequestException('only http(s) urls are allowed');
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BadRequestException('url host is not allowed');
  }

  // A public host is always qualified. A single label is a container, a search
  // domain, or something else only reachable from inside.
  if (!isIP(host) && !host.includes('.')) {
    throw new BadRequestException('url host is not allowed');
  }

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolveAll(host);

  if (!addresses.length) {
    throw new BadRequestException('url host could not be resolved');
  }

  for (const a of addresses) {
    if (!isPublicAddress(a.address)) {
      throw new BadRequestException('url host is not allowed');
    }
  }
}

async function resolveAll(host: string): Promise<Array<{ address: string; family: number }>> {
  try {
    return await lookup(host, { all: true });
  } catch {
    // A name that does not resolve cannot be fetched either; refusing here
    // gives the caller a clearer error than a timeout would.
    throw new BadRequestException('url host could not be resolved');
  }
}

/** True only for addresses that route on the public internet. */
function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;

  if (a === 0) return false; // this network
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicIPv6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === '::' || a === '::1') return false;
  if (a.startsWith('fe80')) return false; // link-local
  if (/^f[cd]/.test(a)) return false; // unique local
  if (a.startsWith('ff')) return false; // multicast
  // An IPv4 address wearing an IPv6 coat is still that address. The URL
  // parser normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so both the dotted
  // and the hex form have to be recognised.
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPublicIPv4(dotted[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPublicIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return true;
}
