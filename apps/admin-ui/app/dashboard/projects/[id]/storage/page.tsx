'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { StorageBrowser } from '@/components/storage-browser';

export default function StoragePage() {
  const { id } = useParams<{ id: string }>();
  // The browser keeps the open bucket and folder in the address (?bucket=…&prefix=…).
  return (
    <Suspense fallback={null}>
      <StorageBrowser projectId={id} />
    </Suspense>
  );
}
