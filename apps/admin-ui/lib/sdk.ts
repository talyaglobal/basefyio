'use client';

import { createPlatformClient, type PlatformClient } from '@basefyio/sdk';
import { getToken } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

let _client: PlatformClient | null = null;

export function getSdk(): PlatformClient {
  if (!_client) {
    _client = createPlatformClient({
      url: API_URL,
      initialToken: getToken() ?? undefined,
    });
  }
  return _client;
}

export function resetSdk(): void {
  _client = null;
}
