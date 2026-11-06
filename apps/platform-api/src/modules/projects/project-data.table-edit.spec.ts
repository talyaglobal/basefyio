import { BadRequestException } from '@nestjs/common';
import { ProjectDataService } from './project-data.service';

/**
 * Renaming a table and flipping a column's UNIQUE constraint, against a fake
 * client that records the SQL it was sent.
 */

function service(handler: (sql: string, params?: unknown[]) => unknown) {
  const sent: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      sent.push(text.trim().replace(/\s+/g, ' '));
      const out = handler(text, params);
      if (out instanceof Error) throw out;
      return (out as any) ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const svc: any = Object.create(ProjectDataService.prototype);
  svc.getProjectPool = async () => ({ pool: { connect: async () => client, end: async () => {} } });
  return { svc: svc as ProjectDataService, sent };
}

describe('ProjectDataService.renameTable', () => {
  it('renames with a quoted identifier', async () => {
    const { svc, sent } = service(() => undefined);
    await svc.renameTable('p1', 'u1', 'old_name', 'new_name');
    expect(sent).toEqual(['ALTER TABLE "old_name" RENAME TO "new_name"']);
  });

  it('refuses a name that is not a plain identifier, before touching the database', async () => {
    const { svc, sent } = service(() => undefined);
    await expect(svc.renameTable('p1', 'u1', 'old_name', 'x"; DROP TABLE y; --')).rejects.toBeInstanceOf(BadRequestException);
    expect(sent).toEqual([]);
  });

  it('refuses a name longer than 63 characters', async () => {
    const { svc } = service(() => undefined);
    await expect(svc.renameTable('p1', 'u1', 'old_name', 'a'.repeat(64))).rejects.toThrow(/63/);
  });

  it('says so when the new name is taken', async () => {
    const taken = Object.assign(new Error('relation already exists'), { code: '42P07' });
    const { svc } = service(() => taken);
    await expect(svc.renameTable('p1', 'u1', 'old_name', 'taken')).rejects.toThrow(/already exists/);
  });
});

describe('ProjectDataService.editColumn unique flag', () => {
  it('adds a unique constraint', async () => {
    const { svc, sent } = service(() => undefined);
    await svc.editColumn('p1', 'u1', 't', 'email', { isUnique: true });
    expect(sent).toEqual(['ALTER TABLE "t" ADD UNIQUE ("email")']);
  });

  it('drops the unique constraint it finds', async () => {
    const { svc, sent } = service((sql) => (sql.includes('pg_constraint') ? { rows: [{ conname: 't_email_key' }] } : undefined));
    await svc.editColumn('p1', 'u1', 't', 'email', { isUnique: false });
    expect(sent[sent.length - 1]).toBe('ALTER TABLE "t" DROP CONSTRAINT "t_email_key"');
  });

  it('explains when uniqueness comes from a plain index', async () => {
    const { svc } = service((sql) => (sql.includes('pg_constraint') ? { rows: [] } : undefined));
    await expect(svc.editColumn('p1', 'u1', 't', 'email', { isUnique: false })).rejects.toThrow(/plain index/);
  });
});
