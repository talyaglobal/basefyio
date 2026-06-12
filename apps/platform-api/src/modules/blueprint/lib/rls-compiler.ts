interface RolePermissions {
  [tableName: string]: string[]; // e.g. ['read', 'write', 'delete']
}

interface RoleDefinition {
  name: string;
  permissions: RolePermissions;
}

/**
 * Compile ApplicationModel roles into Postgres RLS policies.
 * Returns SQL statements to:
 * 1. Enable RLS on each table
 * 2. Create policies per role per table
 *
 * Policy naming convention: <table>_<role>_<action>
 * Uses JWT claim 'app_role' (set by the tenant auth layer).
 */
export function compileRLS(tables: string[], roles: RoleDefinition[]): string[] {
  const statements: string[] = [];

  // Enable RLS on every table
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue; // skip unsafe names
    statements.push(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    statements.push(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
  }

  // Create policies per role per table
  for (const role of roles) {
    for (const [table, perms] of Object.entries(role.permissions)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
      const safeRole = role.name.replace(/[^a-zA-Z0-9_]/g, '_');
      const safeTable = table;

      if (perms.includes('read')) {
        statements.push(
          `CREATE POLICY "${safeTable}_${safeRole}_select" ON "${safeTable}" AS PERMISSIVE FOR SELECT TO authenticated ` +
          `USING ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_role') = '${safeRole}');`,
        );
      }

      if (perms.includes('write')) {
        statements.push(
          `CREATE POLICY "${safeTable}_${safeRole}_insert" ON "${safeTable}" AS PERMISSIVE FOR INSERT TO authenticated ` +
          `WITH CHECK ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_role') = '${safeRole}');`,
        );
        statements.push(
          `CREATE POLICY "${safeTable}_${safeRole}_update" ON "${safeTable}" AS PERMISSIVE FOR UPDATE TO authenticated ` +
          `USING ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_role') = '${safeRole}') ` +
          `WITH CHECK ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_role') = '${safeRole}');`,
        );
      }

      if (perms.includes('delete')) {
        statements.push(
          `CREATE POLICY "${safeTable}_${safeRole}_delete" ON "${safeTable}" AS PERMISSIVE FOR DELETE TO authenticated ` +
          `USING ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_role') = '${safeRole}');`,
        );
      }
    }
  }

  return statements;
}
