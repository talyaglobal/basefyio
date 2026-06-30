'use client';

import { Suspense, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

/**
 * Collections merged into the unified Data editor (/tables). This route
 * remains only so old links and bookmarks keep working.
 */
function CollectionsRedirectInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const open = searchParams.get('open');
    router.replace(
      `/dashboard/projects/${id}/tables${
        open ? `?open=${encodeURIComponent(`nosql:${open}`)}` : '?filter=nosql'
      }`,
    );
  }, [id, searchParams, router]);

  return null;
}

export default function CollectionsPage() {
  return (
    <Suspense fallback={null}>
      <CollectionsRedirectInner />
    </Suspense>
  );
}
