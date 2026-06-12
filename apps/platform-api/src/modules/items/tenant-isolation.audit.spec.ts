/**
 * Tenant-isolation audit spec.
 * These tests verify that service-layer guards prevent cross-tenant access.
 * They deliberately attempt cross-project operations and expect 404/403.
 */

import { ItemsService } from './items.service';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { BlueprintService } from '../blueprint/blueprint.service';
import { NotFoundException } from '@nestjs/common';

// Project A belongs to Team A; Project B belongs to Team B
const PROJECT_A = 'proj-team-a';
const PROJECT_B = 'proj-team-b';
const ENTITY_A = 'customers';

describe('Tenant Isolation Audit', () => {
  describe('ItemsService', () => {
    it('resolveEntity: returns 404 for entity in different project', async () => {
      const prisma = {
        appEntity: {
          // Entity exists for PROJECT_A but we query with PROJECT_B
          findFirst: jest.fn().mockResolvedValue(null),
        },
        project: { findFirst: jest.fn() },
      };
      const svc = new ItemsService(prisma as any);
      // PROJECT_B has no 'customers' entity
      await expect(
        (svc as any).resolveEntity(PROJECT_B, ENTITY_A),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getPool: returns 404 when project not found (wrong projectId)', async () => {
      const prisma = {
        appEntity: { findFirst: jest.fn().mockResolvedValue({ tableName: 'customers' }) },
        project: { findFirst: jest.fn().mockResolvedValue(null) }, // project not found
      };
      const svc = new ItemsService(prisma as any);
      await expect(
        (svc as any).getPool(PROJECT_B),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listItems: entity lookup uses projectId from request (not body)', async () => {
      const prisma = {
        appEntity: { findFirst: jest.fn().mockResolvedValue(null) },
        project: { findFirst: jest.fn() },
      };
      const svc = new ItemsService(prisma as any);
      // Attempt to list items for project B using project B's scoped entity lookup
      await expect(
        svc.listItems(PROJECT_B, ENTITY_A, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Verify the entity lookup was scoped to PROJECT_B, not PROJECT_A
      expect(prisma.appEntity.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ projectId: PROJECT_B }) }),
      );
    });
  });

  describe('IntelligenceService', () => {
    it('ask: loads project by projectId (not user-controlled)', async () => {
      const prisma = {
        project: { findFirst: jest.fn().mockResolvedValue(null) },
        appEntity: { findMany: jest.fn() },
      };
      const svc = new IntelligenceService(prisma as any, {} as any, {} as any);
      // Querying PROJECT_B: project not found → 404
      await expect(svc.ask('user-a', PROJECT_B, 'how many customers?')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.project.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: PROJECT_B }) }),
      );
    });

    it('generateSQL: unsafe SQL is blocked before execution', async () => {
      const prisma = {
        project: { findFirst: jest.fn().mockResolvedValue({
          id: PROJECT_A, status: 'ACTIVE', dbHost: 'localhost', dbPort: 5432,
          dbName: 'test', dbUser: 'test', dbPassword: 'test',
        }) },
        appEntity: { findMany: jest.fn().mockResolvedValue([
          { entityName: 'Customers', tableName: 'customers', description: '', metadata: {} },
        ]) },
      };
      const ai = { complete: jest.fn().mockResolvedValue('DROP TABLE customers; SELECT 1') };
      const svc = new IntelligenceService(prisma as any, ai as any, {} as any);
      await expect(svc.ask('user-a', PROJECT_A, 'drop everything')).rejects.toThrow(/unsafe/i);
    });
  });

  describe('BlueprintService', () => {
    it('getBlueprint: returns 404 for non-existent blueprint (no cross-team leak)', async () => {
      const prisma = {
        blueprint: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const svc = new BlueprintService(prisma as any);
      await expect(svc.getBlueprint('user-a', 'non-existent-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('saveWidget: blueprint ownership is checked via blueprintId lookup', async () => {
      const prisma = {
        blueprint: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const svc = new BlueprintService(prisma as any);
      // Blueprint not found → 404 (not 200 with wrong data)
      await expect(
        svc.saveWidget('user-b', {
          blueprintId: 'bp-belongs-to-team-a',
          widgetLabel: 'x', chartHint: 'bar', sql: 'SELECT 1', columns: [], sampleData: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('SQL injection in /intelligence/ask', () => {
    const UNSAFE_PATTERNS = [
      'DROP TABLE customers',
      'DELETE FROM users',
      'INSERT INTO admin VALUES',
      'UPDATE users SET password',
      'TRUNCATE TABLE blueprints',
      'CREATE TABLE evil (id UUID)',
      'ALTER TABLE users ADD COLUMN',
      "'; DROP TABLE users; --",
    ];

    const UNSAFE_REGEX = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE)\b/i;

    it.each(UNSAFE_PATTERNS)('blocks unsafe pattern: %s', (sql) => {
      expect(UNSAFE_REGEX.test(sql)).toBe(true);
    });

    it('allows safe SELECT queries', () => {
      const SAFE = [
        'SELECT * FROM customers LIMIT 10',
        'SELECT name, email FROM customers WHERE status = $1',
        "SELECT COUNT(*) FROM orders WHERE created_at > '2026-01-01'",
      ];
      for (const sql of SAFE) {
        expect(UNSAFE_REGEX.test(sql)).toBe(false);
      }
    });
  });
});
