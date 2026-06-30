'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { TableEditor } from '@/components/table-editor';

function TablesPageInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  return (
    <TableEditor
      projectId={id}
      initialOpen={searchParams.get('open')}
      initialFilter={searchParams.get('filter')}
    />
  );
}

export default function TablesPage() {
  return (
    <Suspense fallback={null}>
      <TablesPageInner />
    </Suspense>
  );
}
