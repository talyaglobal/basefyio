import { createPlatformClient, type PlatformClient } from '@basefyio/sdk';

/** Real PlatformClient factory. Injected into commands so tests can stub it. */
export function makeClient(opts: { url: string; token?: string }): PlatformClient {
  return createPlatformClient({ url: opts.url, initialToken: opts.token });
}
