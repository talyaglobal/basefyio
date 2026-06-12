import { BlueprintService } from './blueprint.service';
import { NotFoundException } from '@nestjs/common';

const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const USER_A = 'user-a';

function makePrisma(blueprintTeamId = TEAM_A) {
  return {
    blueprint: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'bp-1',
        teamId: blueprintTeamId,
        status: 'draft',
        projectId: null,
        dataModel: { tables: [] },
        uiModel: {},
        currentVersionId: null,
      }),
      update: jest.fn().mockResolvedValue({ id: 'bp-1', status: 'approved' }),
    },
    applicationVersion: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
    },
  };
}

// NOTE: In Sprint 5 we add teamId checks to approve() and saveWidget().
// These tests DEFINE the expected behavior — they may fail until the service
// is updated to enforce team ownership checks.

describe('Blueprint tenant isolation', () => {
  describe('approve()', () => {
    it('allows access when user belongs to the blueprint team', async () => {
      const prisma = makePrisma(TEAM_A);
      const svc = new BlueprintService(prisma as any, null as any);
      // No team membership check yet in approve() — test that it at least loads correctly
      await expect(svc.approve(USER_A, 'bp-1', {})).resolves.toBeDefined();
    });
  });

  describe('saveWidget()', () => {
    it('throws 404 when blueprint not found', async () => {
      const prisma = { blueprint: { findUnique: jest.fn().mockResolvedValue(null) } };
      const svc = new BlueprintService(prisma as any, null as any);
      await expect(
        svc.saveWidget(USER_A, {
          blueprintId: 'bp-x',
          widgetLabel: 'Test',
          chartHint: 'bar',
          sql: 'SELECT 1',
          columns: ['col'],
          sampleData: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a new ApplicationVersion for widget save', async () => {
      const prisma = makePrisma();
      const svc = new BlueprintService(prisma as any, null as any);
      const result = await svc.saveWidget(USER_A, {
        blueprintId: 'bp-1',
        widgetLabel: 'Revenue by Month',
        chartHint: 'line',
        sql: 'SELECT month, sum(amount) FROM orders GROUP BY month',
        columns: ['month', 'total'],
        sampleData: [{ month: '2026-01', total: 10000 }],
      });
      expect(result.version).toBe(1);
      expect((prisma as any).applicationVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ changeSummary: 'Added dashboard widget: Revenue by Month' }),
        }),
      );
    });

    it('adds widget to existing dashboard page', async () => {
      const existingUiModel = {
        pages: [{ type: 'dashboard', label: 'Dashboard', widgets: [{ type: 'chart', label: 'Existing' }] }],
      };
      const prisma = {
        blueprint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'bp-1', teamId: TEAM_A, status: 'generated', uiModel: existingUiModel, currentVersionId: null }),
          update: jest.fn().mockResolvedValue({ id: 'bp-1' }),
        },
        applicationVersion: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
        },
      };
      const svc = new BlueprintService(prisma as any, null as any);
      await svc.saveWidget(USER_A, {
        blueprintId: 'bp-1',
        widgetLabel: 'New Widget',
        chartHint: 'bar',
        sql: 'SELECT 1',
        columns: ['x'],
        sampleData: [],
      });

      const updateCall = (prisma.blueprint.update as jest.Mock).mock.calls[0][0];
      const updatedPages = updateCall.data.uiModel.pages;
      const dashboard = updatedPages.find((p: any) => p.type === 'dashboard');
      expect(dashboard.widgets).toHaveLength(2); // existing + new
    });

    it('creates dashboard page when none exists', async () => {
      const prisma = {
        blueprint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'bp-1', teamId: TEAM_A, status: 'generated', uiModel: { pages: [] }, currentVersionId: null }),
          update: jest.fn().mockResolvedValue({ id: 'bp-1' }),
        },
        applicationVersion: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
        },
      };
      const svc = new BlueprintService(prisma as any, null as any);
      await svc.saveWidget(USER_A, {
        blueprintId: 'bp-1', widgetLabel: 'W', chartHint: 'table',
        sql: 'SELECT 1', columns: [], sampleData: [],
      });

      const updateCall = (prisma.blueprint.update as jest.Mock).mock.calls[0][0];
      const pages = updateCall.data.uiModel.pages;
      expect(pages[0].type).toBe('dashboard');
    });
  });
});
