import { demoBuildPackage } from '../../lib/build-package';
import { ListTable } from '../../components/list-table';
import Link from 'next/link';

export default function TableListPage({ params }: { params: { table: string } }) {
  const bp = demoBuildPackage();
  const table = bp.dataModel.tables.find((t) => t.name === params.table);

  if (!table) {
    return <div style={{ color: '#ef4444' }}>Table &quot;{params.table}&quot; not found in build package</div>;
  }

  const page = bp.uiModel.pages.find((p) => p.type === 'list' && p.table === params.table);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{page?.label ?? table.displayName}</h1>
        <Link
          href={`/${params.table}/new`}
          style={{
            padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff',
            borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: '0.875rem',
          }}
        >
          + New
        </Link>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        <ListTable table={table} rows={[]} />
      </div>
    </div>
  );
}
