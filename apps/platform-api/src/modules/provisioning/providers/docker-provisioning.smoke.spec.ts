/**
 * Sprint 6b — Docker provider e2e smoke test.
 *
 * Skips the entire suite when Docker is unavailable (CI without daemon, devs
 * who haven't installed Docker). Detection is synchronous so the `describe.skip`
 * decision is made at collection time — no mysterious timeouts.
 *
 * When Docker IS available, the suite runs the full create → inspect → delete
 * lifecycle against nginx:alpine using only the real DockerCliClient.
 * No credentials required; no external services beyond local Docker.
 *
 * Cleanup is guaranteed in afterAll even when an earlier test fails.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DockerProvisioningProvider } from './docker-provisioning.provider';
import { DockerCliClient } from './docker-client';
import type { ProvisioningExecuteInput } from '../interfaces/provisioning-provider.interface';

const execAsync = promisify(execFile);

// ── Availability guard (synchronous) ─────────────────────────────────────────

let DOCKER_AVAILABLE = false;
try {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000 });
  DOCKER_AVAILABLE = true;
} catch {
  // Docker not installed or daemon not running
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function inspectContainer(id: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execAsync('docker', ['inspect', id]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

async function forceRemove(id: string): Promise<void> {
  try {
    await execAsync('docker', ['rm', '-f', id]);
  } catch {
    // already removed — fine
  }
}

// ── Smoke fixtures ────────────────────────────────────────────────────────────

const SMOKE_CONTAINER = 'basefyio-e2e-smoke';

const CREATE_INPUT: ProvisioningExecuteInput = {
  operationId: 'smoke-op-create',
  projectId: 'smoke-proj',
  providerType: 'docker',
  region: 'local',
  datacenter: null,
  credentialOpenbaoPath: '',
  dryRun: false,
  desiredSpec: {
    image: 'nginx:alpine',
    containerName: SMOKE_CONTAINER,
  },
  currentResources: [],
};

// ── Suite (skipped when Docker unavailable) ───────────────────────────────────

const describeSmoke = DOCKER_AVAILABLE ? describe : describe.skip;

describeSmoke('DockerProvisioningProvider — e2e smoke', () => {
  let provider: DockerProvisioningProvider;
  let createdId: string | undefined;

  beforeAll(async () => {
    // Remove any container left over from a previous failed run
    await forceRemove(SMOKE_CONTAINER);
    provider = new DockerProvisioningProvider(new DockerCliClient());
  }, 15_000);

  afterAll(async () => {
    // Guaranteed cleanup even if a test throws mid-suite
    if (createdId) {
      await forceRemove(createdId);
    }
  }, 15_000);

  // ── 1. healthCheck ──────────────────────────────────────────────────────────

  it('healthCheck() reports Docker daemon as healthy', async () => {
    const { healthy, latencyMs } = await provider.healthCheck();
    expect(healthy).toBe(true);
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  }, 10_000);

  // ── 2. Create ───────────────────────────────────────────────────────────────

  it('apply() creates nginx:alpine container and returns an ACTIVE resource', async () => {
    const result = await provider.apply(CREATE_INPUT);

    expect(result.success).toBe(true);
    expect(result.resources).toHaveLength(1);

    const resource = result.resources[0];
    expect(resource.status).toBe('ACTIVE');
    expect(resource.type).toBe('container');
    expect(typeof resource.externalId).toBe('string');
    expect(resource.externalId.length).toBeGreaterThan(0);

    createdId = resource.externalId; // captured for subsequent tests + afterAll
  }, 60_000);

  // ── 3. Inspect after create ─────────────────────────────────────────────────

  it('docker inspect finds the container after create', async () => {
    expect(createdId).toBeDefined();

    const data = await inspectContainer(createdId!);
    expect(data).not.toBeNull();

    const state = (data as any)?.State;
    expect(state).toBeDefined();
    // nginx:alpine default CMD keeps the container running
    expect(state.Running).toBe(true);
  }, 10_000);

  it('container name matches the requested name', async () => {
    expect(createdId).toBeDefined();
    const data = await inspectContainer(createdId!);
    const name: string = (data as any)?.Name ?? '';
    // Docker prefixes container names with '/'
    expect(name.replace(/^\//, '')).toBe(SMOKE_CONTAINER);
  }, 10_000);

  it('container image is nginx:alpine', async () => {
    expect(createdId).toBeDefined();
    const data = await inspectContainer(createdId!);
    const image: string = (data as any)?.Config?.Image ?? '';
    expect(image).toBe('nginx:alpine');
  }, 10_000);

  // ── 4. Delete ───────────────────────────────────────────────────────────────

  it('DockerCliClient.stopAndRemove() removes the container', async () => {
    expect(createdId).toBeDefined();
    const client = new DockerCliClient();
    await expect(client.stopAndRemove(createdId!)).resolves.toBeUndefined();
    // Signal to afterAll that cleanup already happened
  }, 15_000);

  // ── 5. Inspect after delete ─────────────────────────────────────────────────

  it('docker inspect returns null after delete', async () => {
    expect(createdId).toBeDefined();
    const data = await inspectContainer(createdId!);
    expect(data).toBeNull();
    createdId = undefined; // tell afterAll nothing to clean up
  }, 10_000);
});
