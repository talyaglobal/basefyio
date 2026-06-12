import { demoBuildPackage } from '../../../lib/build-package';

export default function RecordDetailPage({ params }: { params: { table: string; id: string } }) {
  const bp = demoBuildPackage();
  const table = bp.dataModel.tables.find((t) => t.name === params.table);

  return (
    <div>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem' }}>
        {table?.displayName ?? params.table} — {params.id}
      </h1>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '1.5rem', color: '#94a3b8' }}>
        Detail view — data loading not yet implemented (Sprint 5)
      </div>
    </div>
  );
}
