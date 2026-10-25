import { ProjectDataService } from './project-data.service';

/**
 * The read elevation on its own.
 *
 * A dashboard read borrows service_role so row-level security does not hide
 * rows. On a database imported from Supabase that role owns nothing in the
 * `auth` schema, so borrowing it turned opening a table into "permission
 * denied" — which the dashboard showed as an internal server error. Worse, the
 * refused statement aborted the transaction, so the enquiry had to be able to
 * fail without taking the read with it.
 */

type Handler = (sql: string, params?: unknown[]) => unknown;

function fakeClient(handler: Handler) {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string | { text: string }, params?: unknown[]) => {
      const statement = typeof text === 'string' ? text : text.text;
      sql.push(statement.trim().replace(/\s+/g, ' '));
      const out = handler(statement, params);
      if (out instanceof Error) throw out;
      return (out as any) ?? { rows: [], rowCount: 0 };
    },
  };
}

/** The service's own elevation, reached without its constructor. */
function elevate(client: unknown, target?: string): Promise<boolean> {
  const svc: any = Object.create(ProjectDataService.prototype);
  svc.logger = { debug: () => {}, warn: () => {}, error: () => {} };
  return svc.elevateForRead(client, target);
}

const privilege = (allowed: boolean) => ({ rows: [{ allowed }], rowCount: 1 });

describe('ProjectDataService read elevation', () => {
  it('keeps the borrowed role when it can read the table', async () => {
    const client = fakeClient((sql) => (sql.includes('has_table_privilege') ? privilege(true) : undefined));
    await expect(elevate(client, '"public"."users"')).resolves.toBe(true);
    expect(client.sql).toContain('SET LOCAL ROLE service_role');
    expect(client.sql).not.toContain('SET LOCAL ROLE NONE');
    expect(client.sql.some((s) => s.startsWith('RELEASE SAVEPOINT'))).toBe(true);
  });

  it('drops back to the project owner when the borrowed role may not read it', async () => {
    const client = fakeClient((sql) => (sql.includes('has_table_privilege') ? privilege(false) : undefined));
    await expect(elevate(client, '"auth"."audit_log_entries"')).resolves.toBe(false);
    expect(client.sql).toContain('SET LOCAL ROLE NONE');
  });

  it('drops back, and leaves the transaction usable, when the enquiry itself fails', async () => {
    // Resolving a name needs USAGE on its schema: asking about
    // supabase_migrations raises "permission denied for schema" before the
    // privilege is considered, and that would abort the whole read.
    const client = fakeClient((sql) => {
      if (sql.includes('has_table_privilege')) return new Error('permission denied for schema supabase_migrations');
      return undefined;
    });
    await expect(elevate(client, '"supabase_migrations"."schema_migrations"')).resolves.toBe(false);
    expect(client.sql.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(client.sql).toContain('SET LOCAL ROLE NONE');
  });

  it('survives a database where service_role does not exist at all', async () => {
    const client = fakeClient((sql) =>
      sql.includes('SET LOCAL ROLE service_role') ? new Error('role "service_role" does not exist') : undefined,
    );
    await expect(elevate(client, '"public"."users"')).resolves.toBe(false);
    // The failed SET aborted the transaction; the savepoint is what lets the
    // read carry on as the owner instead of failing with 25P02.
    expect(client.sql.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  it('asks nothing about privileges when no table is named', async () => {
    const client = fakeClient(() => undefined);
    await expect(elevate(client)).resolves.toBe(true);
    expect(client.sql.some((s) => s.includes('has_table_privilege'))).toBe(false);
    expect(client.sql.some((s) => s.startsWith('RELEASE SAVEPOINT'))).toBe(true);
  });

  it('opens a savepoint before touching the role, every time', async () => {
    const client = fakeClient((sql) => (sql.includes('has_table_privilege') ? privilege(true) : undefined));
    await elevate(client, '"public"."users"');
    expect(client.sql[0]).toBe('SAVEPOINT elevate_for_read');
  });
});
