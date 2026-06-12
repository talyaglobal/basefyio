import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ItemsService } from './items.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ENTITY = {
  id: 'e-1',
  projectId: 'p-1',
  entityName: 'Customers',
  tableName: 'customers',
};
const PROJECT = {
  id: 'p-1',
  status: 'ACTIVE',
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'test',
  dbUser: 'test',
  dbPassword: 'test',
};

function makePool(rows: Record<string, unknown>[] = [], rowCount = 0) {
  const query = jest
    .fn()
    // count call
    .mockResolvedValueOnce({ rows: [{ total: rows.length }], rowCount: 1 })
    // data call
    .mockResolvedValueOnce({ rows, rowCount: rows.length });
  const end = jest.fn().mockResolvedValue(undefined);
  return { query, end };
}

function makePrisma(
  entity: typeof ENTITY | null = ENTITY,
  project: typeof PROJECT | null = PROJECT,
) {
  return {
    appEntity: { findFirst: jest.fn().mockResolvedValue(entity) },
    project: { findFirst: jest.fn().mockResolvedValue(project) },
  };
}

// Build a service whose private getPool() returns a mock pool
function makeService(
  prisma: ReturnType<typeof makePrisma>,
  mockPool?: ReturnType<typeof makePool>,
) {
  const svc = new ItemsService(prisma as any);
  if (mockPool) {
    // Override the private method directly to avoid real pg connections
    (svc as any).getPool = jest.fn().mockResolvedValue({ pool: mockPool, project: PROJECT });
  }
  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ItemsService', () => {
  // -------------------------------------------------------------------------
  describe('resolveEntity', () => {
    it('returns entity when found by entityName', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      const result = await (svc as any).resolveEntity('p-1', 'Customers');
      expect(result).toEqual(ENTITY);
    });

    it('falls back to tableName match when entityName not found', async () => {
      const prisma = {
        appEntity: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null) // entityName miss
            .mockResolvedValueOnce(ENTITY), // tableName hit
        },
        project: { findFirst: jest.fn() },
      };
      const svc = makeService(prisma);
      const result = await (svc as any).resolveEntity('p-1', 'customers');
      expect(result).toEqual(ENTITY);
    });

    it('throws NotFoundException when neither entityName nor tableName matches', async () => {
      const prisma = {
        appEntity: { findFirst: jest.fn().mockResolvedValue(null) },
        project: { findFirst: jest.fn() },
      };
      const svc = makeService(prisma);
      await expect((svc as any).resolveEntity('p-1', 'Unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('listItems', () => {
    it('returns empty page when no rows', async () => {
      const prisma = makePrisma();
      const pool = makePool([]);
      const svc = makeService(prisma, pool);

      const result = await svc.listItems('p-1', 'Customers', {
        filters: { status: 'active' },
        sort: 'created_at',
        order: 'desc',
        limit: 10,
      });

      expect(result.data).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.total).toBe(0);
    });

    it('returns rows and null nextCursor when results < limit', async () => {
      const rows = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }];
      const prisma = makePrisma();
      const pool = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ total: 2 }] })
          .mockResolvedValueOnce({ rows }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);

      const result = await svc.listItems('p-1', 'Customers', { limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('sets nextCursor when results exceed limit', async () => {
      // limit=2, return 3 rows — service pops last and encodes cursor
      const rows = [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
        { id: '3', name: 'Carol' }, // the extra one
      ];
      const prisma = makePrisma();
      const pool = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ total: 10 }] })
          .mockResolvedValueOnce({ rows: [...rows] }), // slice happens in service
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);

      const result = await svc.listItems('p-1', 'Customers', { limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
      // cursor decodes back to the id of the last returned row
      const decoded = Buffer.from(result.nextCursor!, 'base64url').toString('utf8');
      expect(decoded).toBe('2');
    });

    it('throws BadRequestException for unsafe sort column', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await expect(
        svc.listItems('p-1', 'Customers', { sort: 'DROP TABLE--' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips unsafe filter keys silently and still returns data', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ total: 1 }] })
          .mockResolvedValueOnce({ rows: [{ id: '1', name: 'Alice' }] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);

      // 'DROP TABLE' is unsafe, 'status' is safe
      const result = await svc.listItems('p-1', 'Customers', {
        filters: { 'DROP TABLE': 'evil', status: 'active' },
      });
      expect(result.data).toHaveLength(1);
    });

    it('throws NotFoundException when project not found', async () => {
      const prisma = makePrisma(ENTITY, null);
      const svc = new ItemsService(prisma as any);
      await expect(
        svc.listItems('p-bad', 'Customers', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  describe('getItem', () => {
    it('returns row when found', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 'x', name: 'Alice' }] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      const result = await svc.getItem('p-1', 'Customers', 'x');
      expect(result).toEqual({ id: 'x', name: 'Alice' });
    });

    it('throws NotFoundException when item not found', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      await expect(svc.getItem('p-1', 'Customers', 'id-missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('createItem', () => {
    it('throws BadRequestException when body is empty', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await expect(svc.createItem('p-1', 'Customers', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequestException when all fields are reserved (id/created_at/updated_at)', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await expect(
        svc.createItem('p-1', 'Customers', { id: '1', created_at: 'now', updated_at: 'now' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inserts and returns created row', async () => {
      const created = { id: 'new-1', name: 'Alice', email: 'alice@example.com' };
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [created] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      const result = await svc.createItem('p-1', 'Customers', {
        name: 'Alice',
        email: 'alice@example.com',
      });
      expect(result).toEqual(created);
    });
  });

  // -------------------------------------------------------------------------
  describe('updateItem', () => {
    it('throws BadRequestException when no valid fields to update', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await expect(
        svc.updateItem('p-1', 'Customers', 'x', { id: '1', updated_at: 'now' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when item does not exist', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      await expect(
        svc.updateItem('p-1', 'Customers', 'missing', { name: 'Bob' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns updated row', async () => {
      const updated = { id: '1', name: 'Bob' };
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [updated] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      const result = await svc.updateItem('p-1', 'Customers', '1', { name: 'Bob' });
      expect(result).toEqual(updated);
    });
  });

  // -------------------------------------------------------------------------
  describe('deleteItem', () => {
    it('throws NotFoundException when item does not exist', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      await expect(
        svc.deleteItem('p-1', 'Customers', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns deleted: true on success', async () => {
      const prisma = makePrisma();
      const pool = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(prisma, pool);
      const result = await svc.deleteItem('p-1', 'Customers', 'x');
      expect(result).toEqual({ deleted: true, id: 'x' });
    });
  });
});
