import { ProvisioningResourceProjectionService, ProjectionParams } from './provisioning-resource-projection.service';
import { ProvisioningResourceResult } from './interfaces/provisioning-provider.interface';

// ── Mock factories ───────────────────────────────────────────

function makePrisma(overrides: Record<string, any> = {}) {
  const defaults = {
    provisioningResource: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    provisioningAuditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return { ...defaults, ...overrides } as any;
}

function makeSvc(prisma = makePrisma()) {
  return new ProvisioningResourceProjectionService(prisma);
}

// ── Fixture constants ────────────────────────────────────────

const PP_ID = 'pp-1';
const OP_ID = 'op-1';
const USER_ID = 'user-1';
const EXT_ID = 'provider-server-42';

function stubResource(overrides: Partial<ProvisioningResourceResult> = {}): ProvisioningResourceResult {
  return {
    externalId: EXT_ID,
    type: 'SERVER',
    name: 'web-01',
    desiredSpec: { size: 'cx11', image: 'ubuntu-22.04' },
    actualSpec: { size: 'cx11', image: 'ubuntu-22.04', ipv4: '1.2.3.4' },
    status: 'ACTIVE',
    ...overrides,
  };
}

function baseParams(resources: ProvisioningResourceResult[]): ProjectionParams {
  return {
    operationId: OP_ID,
    provisioningProjectId: PP_ID,
    region: 'eu-central',
    datacenter: null,
    resources,
    actorUserId: USER_ID,
  };
}

function stubExistingResource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'res-1',
    provisioningProjectId: PP_ID,
    kind: 'SERVER',
    name: 'web-01',
    status: 'CREATING',
    externalId: null,
    desiredSpec: { size: 'cx11' },
    actualSpec: null,
    rollbackSpec: null,
    ...overrides,
  };
}

// ── noop (empty resources) ───────────────────────────────────

describe('ProvisioningResourceProjectionService — noop result', () => {
  it('makes no DB calls when resources array is empty', async () => {
    const prisma = makePrisma();
    await makeSvc(prisma).project(baseParams([]));
    expect(prisma.provisioningResource.findFirst).not.toHaveBeenCalled();
    expect(prisma.provisioningResource.create).not.toHaveBeenCalled();
    expect(prisma.provisioningResource.update).not.toHaveBeenCalled();
    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
  });
});

// ── create resource ──────────────────────────────────────────

describe('ProvisioningResourceProjectionService — create resource', () => {
  it('creates a new ProvisioningResource row when none exists', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(null);
    prisma.provisioningResource.create.mockResolvedValue({ id: 'res-new', provisioningProjectId: PP_ID });

    await makeSvc(prisma).project(baseParams([stubResource()]));

    expect(prisma.provisioningResource.create).toHaveBeenCalledTimes(1);
    const createCall = prisma.provisioningResource.create.mock.calls[0][0].data;
    expect(createCall.provisioningProjectId).toBe(PP_ID);
    expect(createCall.kind).toBe('SERVER');
    expect(createCall.name).toBe('web-01');
    expect(createCall.status).toBe('ACTIVE');
    expect(createCall.externalId).toBe(EXT_ID);
    expect(createCall.region).toBe('eu-central');
  });

  it('sets desiredSpec and actualSpec on create', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(null);
    prisma.provisioningResource.create.mockResolvedValue({ id: 'res-new', provisioningProjectId: PP_ID });

    const resource = stubResource();
    await makeSvc(prisma).project(baseParams([resource]));

    const createCall = prisma.provisioningResource.create.mock.calls[0][0].data;
    expect(createCall.desiredSpec).toEqual(resource.desiredSpec);
    expect(createCall.actualSpec).toEqual(resource.actualSpec);
  });

  it('sets rollbackSpec to null on create (nothing to roll back to)', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(null);
    prisma.provisioningResource.create.mockResolvedValue({ id: 'res-new', provisioningProjectId: PP_ID });

    await makeSvc(prisma).project(baseParams([stubResource()]));

    const createCall = prisma.provisioningResource.create.mock.calls[0][0].data;
    expect(createCall).not.toHaveProperty('rollbackSpec');
  });

  it('emits RESOURCE_CREATED audit event with fromStatus: null, toStatus: ACTIVE', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(null);
    prisma.provisioningResource.create.mockResolvedValue({ id: 'res-new', provisioningProjectId: PP_ID });

    await makeSvc(prisma).project(baseParams([stubResource()]));

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0].data;
    expect(auditCall.kind).toBe('RESOURCE_CREATED');
    expect(auditCall.fromStatus).toBeUndefined();
    expect(auditCall.toStatus).toBe('ACTIVE');
    expect(auditCall.operationId).toBe(OP_ID);
  });
});

// ── update resource ──────────────────────────────────────────

describe('ProvisioningResourceProjectionService — update resource', () => {
  it('updates the existing resource when matched by externalId', async () => {
    const prisma = makePrisma();
    const existing = stubExistingResource({ externalId: EXT_ID });
    prisma.provisioningResource.findFirst.mockResolvedValueOnce(existing);

    await makeSvc(prisma).project(baseParams([stubResource()]));

    expect(prisma.provisioningResource.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.provisioningResource.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe('res-1');
    expect(updateCall.data.status).toBe('ACTIVE');
    expect(updateCall.data.externalId).toBe(EXT_ID);
  });

  it('falls back to kind+name match when externalId not found', async () => {
    const prisma = makePrisma();
    const existingWithoutExtId = stubExistingResource({ externalId: null });
    // First findFirst (by externalId) → null; second (by kind+name) → match
    prisma.provisioningResource.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingWithoutExtId);

    await makeSvc(prisma).project(baseParams([stubResource()]));

    expect(prisma.provisioningResource.update).toHaveBeenCalledTimes(1);
  });

  it('snapshots rollbackSpec from previous desiredSpec on update', async () => {
    const prisma = makePrisma();
    const previousDesiredSpec = { size: 'cx11' };
    const existing = stubExistingResource({ desiredSpec: previousDesiredSpec });
    prisma.provisioningResource.findFirst.mockResolvedValueOnce(existing);

    await makeSvc(prisma).project(baseParams([stubResource()]));

    const updateData = prisma.provisioningResource.update.mock.calls[0][0].data;
    expect(updateData.rollbackSpec).toEqual(previousDesiredSpec);
    // New desiredSpec overwrites old
    expect(updateData.desiredSpec).toEqual(stubResource().desiredSpec);
  });

  it('emits RESOURCE_UPDATED audit event with fromStatus from existing row', async () => {
    const prisma = makePrisma();
    const existing = stubExistingResource({ status: 'CREATING' });
    prisma.provisioningResource.findFirst.mockResolvedValueOnce(existing);

    await makeSvc(prisma).project(baseParams([stubResource()]));

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0].data;
    expect(auditCall.kind).toBe('RESOURCE_UPDATED');
    expect(auditCall.fromStatus).toBe('CREATING');
    expect(auditCall.toStatus).toBe('ACTIVE');
  });
});

// ── multiple resources ────────────────────────────────────────

describe('ProvisioningResourceProjectionService — multiple resources', () => {
  it('projects each resource independently (one create, one update)', async () => {
    const prisma = makePrisma();
    const existing = stubExistingResource({ name: 'vol-01', kind: 'VOLUME' });
    // First resource (server): no match → create
    // Second resource (volume): match → update
    prisma.provisioningResource.findFirst
      .mockResolvedValueOnce(null)  // server externalId lookup
      .mockResolvedValueOnce(null)  // server kind+name fallback
      .mockResolvedValueOnce(null)  // volume externalId lookup
      .mockResolvedValueOnce(existing); // volume kind+name fallback
    prisma.provisioningResource.create.mockResolvedValue({ id: 'res-new', provisioningProjectId: PP_ID });

    await makeSvc(prisma).project(baseParams([
      stubResource({ type: 'SERVER', name: 'web-01' }),
      stubResource({ type: 'VOLUME', name: 'vol-01', externalId: 'vol-ext-1' }),
    ]));

    expect(prisma.provisioningResource.create).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningResource.update).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
  });
});

// ── DELETE path (destroyResources) ───────────────────────────

describe('ProvisioningResourceProjectionService — DELETE path', () => {
  function deletedParams(externalIds: string[]): ProjectionParams {
    return { ...baseParams([]), deletedExternalIds: externalIds };
  }

  function activeResource(externalId: string) {
    return { id: 'res-del-1', provisioningProjectId: PP_ID, status: 'ACTIVE', externalId };
  }

  it('marks a tracked resource as DESTROYED and writes RESOURCE_DESTROYED audit', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(activeResource('ext-99'));
    prisma.provisioningResource.update.mockResolvedValue({});

    await makeSvc(prisma).project(deletedParams(['ext-99']));

    const updateCall = prisma.provisioningResource.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('DESTROYED');
    expect(updateCall.data.destroyedAt).toBeInstanceOf(Date);

    const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0].data;
    expect(auditCall.kind).toBe('RESOURCE_DESTROYED');
    expect(auditCall.fromStatus).toBe('ACTIVE');
    expect(auditCall.toStatus).toBe('DESTROYED');
  });

  it('is idempotent — skips resources not found or already destroyed', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst.mockResolvedValue(null);

    await makeSvc(prisma).project(deletedParams(['unknown-ext']));

    expect(prisma.provisioningResource.update).not.toHaveBeenCalled();
    expect(prisma.provisioningAuditEvent.create).not.toHaveBeenCalled();
  });

  it('destroys multiple resources independently', async () => {
    const prisma = makePrisma();
    prisma.provisioningResource.findFirst
      .mockResolvedValueOnce(activeResource('ext-1'))
      .mockResolvedValueOnce(activeResource('ext-2'));
    prisma.provisioningResource.update.mockResolvedValue({});

    await makeSvc(prisma).project(deletedParams(['ext-1', 'ext-2']));

    expect(prisma.provisioningResource.update).toHaveBeenCalledTimes(2);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
  });

  it('processes creates and deletes in the same project() call', async () => {
    const prisma = makePrisma();
    // upsert path: no existing → create
    prisma.provisioningResource.findFirst
      .mockResolvedValueOnce(null)   // externalId lookup for the new resource
      .mockResolvedValueOnce(null)   // kind+name fallback for the new resource
      .mockResolvedValueOnce(activeResource('old-ext')); // delete lookup
    prisma.provisioningResource.create.mockResolvedValue({ id: 'new-res', provisioningProjectId: PP_ID });
    prisma.provisioningResource.update.mockResolvedValue({});

    await makeSvc(prisma).project({
      ...baseParams([stubResource({ externalId: 'new-ext', name: 'web-new' })]),
      deletedExternalIds: ['old-ext'],
    });

    expect(prisma.provisioningResource.create).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningResource.update).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningAuditEvent.create).toHaveBeenCalledTimes(2);
  });
});
