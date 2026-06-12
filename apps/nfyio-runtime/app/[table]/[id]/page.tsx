import { demoBuildPackage, fetchTableRow } from '../../../lib/build-package';
import Link from 'next/link';

export default async function RecordDetailPage({ params }: { params: { table: string; id: string } }) {
  const bp = demoBuildPackage();
  const table = bp.dataModel.tables.find((t) => t.name === params.table);
  if (!table) return <div style={{ color: '#ef4444' }}>Table not found</div>;

  // Try to load real data; gracefully show placeholder if API unavailable
  const projectId = bp.projectId;
  const row = await fetchTableRow(projectId, params.table, params.id);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <Link href={`/${params.table}`} style={{ color: '#64748b', textDecoration: 'none', fontSize: '0.875rem' }}>
          ← {table.displayName}
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{table.displayName} Detail</h1>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '1.5rem' }}>
        {row ? (
          <dl style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '0.75rem 1rem' }}>
            {table.fields.map((field) => (
              <div key={field.name} style={{ display: 'contents' }}>
                <dt style={{ fontWeight: 600, color: '#374151', fontSize: '0.875rem' }}>
                  {field.description || field.name}
                </dt>
                <dd style={{ margin: 0, color: '#1e293b', fontSize: '0.875rem', wordBreak: 'break-word' }}>
                  {String(row[field.name] ?? '—')}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: '2rem' }}>
            Record not found or API unavailable
          </div>
        )}
      </div>
    </div>
  );
}
