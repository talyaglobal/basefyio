import { ItemFilesService } from './item-files.service';
import { NotFoundException } from '@nestjs/common';

function makeConfig() {
  const values: Record<string, unknown> = {
    'minio.endpoint': 'localhost',
    'minio.port': 9000,
    'minio.useSsl': false,
    'minio.accessKey': 'test',
    'minio.secretKey': 'test',
  };
  return { get: jest.fn((key: string) => values[key] ?? 'localhost') };
}

function makePrisma(project?: any) {
  return {
    project: {
      findFirst: jest.fn().mockResolvedValue(
        project ?? {
          id: 'p-1',
          status: 'ACTIVE',
          dbHost: 'localhost',
          dbPort: 5432,
          dbName: 'test',
          dbUser: 'test',
          dbPassword: 'test',
        },
      ),
    },
  };
}

describe('ItemFilesService', () => {
  it('throws NotFoundException when project not found', async () => {
    const prisma = { project: { findFirst: jest.fn().mockResolvedValue(null) } };
    const svc = new ItemFilesService(prisma as any, makeConfig() as any);
    await expect(svc.listFiles('p-x', 'customers', 'item-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ensureBucket: does not throw when minio unavailable', async () => {
    const svc = new ItemFilesService(makePrisma() as any, makeConfig() as any);
    // Override minio client
    (svc as any).minio = {
      bucketExists: jest.fn().mockRejectedValue(new Error('connection refused')),
      makeBucket: jest.fn(),
    };
    await expect((svc as any).ensureBucket()).resolves.toBeUndefined();
  });

  it('deleteFile: throws 404 when file not found', async () => {
    const mockPool = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined) // ensureFilesTable
        .mockResolvedValueOnce({ rows: [] }), // DELETE returning nothing
      end: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ItemFilesService(makePrisma() as any, makeConfig() as any);
    (svc as any).getProjectPool = jest.fn().mockResolvedValue(mockPool);
    await expect(svc.deleteFile('p-1', 'file-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});
