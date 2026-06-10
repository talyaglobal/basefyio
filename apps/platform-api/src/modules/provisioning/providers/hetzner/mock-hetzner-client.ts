import { Injectable } from '@nestjs/common';
import { IHetznerClient } from './hetzner-client.interface';
import {
  HetznerCreateServerParams,
  HetznerCreatedServer,
} from './hetzner.types';

/**
 * Mock Hetzner client for integration tests and local development.
 * Returns synthetic responses without making any HTTP calls.
 *
 * Deterministic: same params always produce the same response.
 * ID generation uses a simple counter reset per instance — tests that need
 * stable IDs should create one MockHetznerClient per test.
 */
@Injectable()
export class MockHetznerClient implements IHetznerClient {
  private idCounter = 1000;

  async createServer(
    params: HetznerCreateServerParams,
    _apiToken: string,
  ): Promise<HetznerCreatedServer> {
    const id = ++this.idCounter;
    return {
      id,
      name: params.name,
      status: 'running',
      serverType: params.server_type,
      publicIpv4: `10.0.0.${id % 256}`,
      locationName: params.location,
      datacenterName: `${params.location}-dc1`,
    };
  }

  async deleteServer(_serverId: number, _apiToken: string): Promise<void> {
    // no-op
  }

  async rebuildServer(
    _serverId: number,
    _imageSlug: string,
    _apiToken: string,
  ): Promise<void> {
    // no-op
  }

  async resizeServer(
    _serverId: number,
    _serverType: string,
    _apiToken: string,
  ): Promise<void> {
    // no-op
  }
}
