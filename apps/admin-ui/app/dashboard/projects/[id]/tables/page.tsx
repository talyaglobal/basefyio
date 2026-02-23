'use client';

import { useParams } from 'next/navigation';
import { TableViewer } from '@/components/table-viewer';

export default function TablesPage() {
  const { id } = useParams<{ id: string }>();
  return <TableViewer projectId={id} />;
}
