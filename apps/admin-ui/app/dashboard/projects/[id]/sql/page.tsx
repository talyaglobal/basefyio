'use client';

import { useParams } from 'next/navigation';
import { SqlEditor } from '@/components/sql-editor';

export default function SqlPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="shrink-0 text-2xl font-bold tracking-tight">SQL Editor</h1>
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card p-3">
        <SqlEditor projectId={id} />
      </div>
    </div>
  );
}
