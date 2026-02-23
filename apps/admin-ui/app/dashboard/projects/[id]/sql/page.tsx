'use client';

import { useParams } from 'next/navigation';
import { SqlEditor } from '@/components/sql-editor';

export default function SqlPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">SQL Editor</h1>
      <SqlEditor projectId={id} />
    </div>
  );
}
