'use client';

import { useParams } from 'next/navigation';
import { TableEditor } from '@/components/table-editor';

export default function TablesPage() {
  const { id } = useParams<{ id: string }>();
  return <TableEditor projectId={id} />;
}
