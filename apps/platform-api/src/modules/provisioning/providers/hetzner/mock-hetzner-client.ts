import { Injectable } from '@nestjs/common';
import { IHetznerClient } from './hetzner-client.interface';
import {
  HetznerCreateServerParams,
  HetznerCreatedServer,
} from './hetzner.types';

interface MockServerRecord {
  id: number;
  name: string;
  serverType: string;
  publicIpv4: string;
  locationName: string;
  datacenterName: string;
}

/**
 * Mock Hetzner client for integration tests and local development.
 * Returns synthetic responses without making any HTTP calls.
 *
 * Stateful: createServer() stores a record; resizeServer() updates it;
 * getServer() reads it back. This lets tests verify read-after-write behaviour.
 * For servers not created in this instance (DB-tracked but not created here),
 * getServer() returns a deterministic synthetic snapshot.
 *
 * ID generation uses a simple counter reset per instance — tests that need
 * stable IDs should create one MockHetznerClient per test.
 */
@Injectable()
export class MockHetznerClient implements IHetznerClient {
  private idCounter = 1000;
  private servers = new Map<number, MockServerRecord>();

  async createServer(
    params: HetznerCreateServerParams,
    _apiToken: string,
  ): Promise<HetznerCreatedServer> {
    const id = ++this.idCounter;
    const record: MockServerRecord = {
      id,
      name: params.name,
      serverType: params.server_type,
      publicIpv4: `10.0.0.${id % 256}`,
      locationName: params.location,
      datacenterName: `${params.location}-dc1`,
    };
    this.servers.set(id, record);
    return { ...record, status: 'running' };
  }

  async getServer(serverId: number, _apiToken: string): Promise<HetznerCreatedServer> {
    const record = this.servers.get(serverId);
    if (record) {
      return { ...record, status: 'running' };
    }
    // Deterministic fallback for servers tracked in DB but not created in this instance.
    return {
      id: serverId,
      name: `server-${serverId}`,
      status: 'running',
      serverType: 'cx11',
      publicIpv4: `10.0.0.${serverId % 256}`,
      locationName: 'nbg1',
      datacenterName: 'nbg1-dc1',
    };
  }

  async deleteServer(serverId: number, _apiToken: string): Promise<void> {
    this.servers.delete(serverId);
  }

  async rebuildServer(
    _serverId: number,
    _imageSlug: string,
    _apiToken: string,
  ): Promise<void> {
    // image not tracked in MockServerRecord — getServer() reflects other fields correctly
  }

  async resizeServer(
    serverId: number,
    serverType: string,
    _apiToken: string,
  ): Promise<void> {
    const record = this.servers.get(serverId);
    if (record) {
      record.serverType = serverType;
    }
  }
}
