'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { CollectionsEditor } from '@/components/collections-editor';

function CollectionsPageInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  return <CollectionsEditor projectId={id} initialCollection={searchParams.get('open')} />;
}

export default function CollectionsPage() {
  return (
    <Suspense fallback={null}>
      <CollectionsPageInner />
    </Suspense>
  );
}
