'use client';
import { demoBuildPackage } from '../../../lib/build-package';
import { RecordForm } from '../../../components/record-form';
import { useRouter } from 'next/navigation';

export default function NewRecordPage({ params }: { params: { table: string } }) {
  const bp = demoBuildPackage();
  const table = bp.dataModel.tables.find((t) => t.name === params.table);
  const router = useRouter();

  if (!table) {
    return <div style={{ color: '#ef4444' }}>Table not found</div>;
  }

  const handleSubmit = async (data: Record<string, string>) => {
    // In V1: stub — just navigate back
    console.log('Submit:', data);
    router.push(`/${params.table}`);
  };

  return (
    <div>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        New {table.displayName}
      </h1>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '1.5rem' }}>
        <RecordForm tableName={table.name} fields={table.fields} onSubmit={handleSubmit} />
      </div>
    </div>
  );
}
