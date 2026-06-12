import { demoBuildPackage, fetchTableRows } from '../../lib/build-package';
import { ListTable } from '../../components/list-table';
import { DashboardGrid } from '../../components/dashboard-widget';
import { KPIWidget } from '../../lib/types';

export default async function DashboardPage() {
  const bp = demoBuildPackage();
  const projectId = bp.projectId;

  // Build KPI widgets from navigation (count per table)
  const kpis: KPIWidget[] = bp.applicationModel.navigation.slice(0, 4).map((nav) => ({
    label: nav.label,
    table: nav.table,
    aggregate: 'count' as const,
    value: '...',  // would be populated from real API in Sprint 6
  }));

  // Load recent rows for first 2 tables
  const previewTables = bp.dataModel.tables.slice(0, 2);
  const previews = await Promise.all(
    previewTables.map((t) =>
      fetchTableRows(projectId, t.name, 5).then((rows) => ({ table: t, rows })),
    ),
  );

  return (
    <div>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        Dashboard
      </h1>
      <DashboardGrid widgets={kpis} />
      {previews.map(({ table, rows }) => (
        <div key={table.name} style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#374151' }}>
            Recent {table.displayName}
          </h2>
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
            <ListTable table={table} rows={rows} />
          </div>
        </div>
      ))}
    </div>
  );
}
