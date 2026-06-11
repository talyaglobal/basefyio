'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * Data Engine entities merged into the unified Data editor (/tables). This
 * route remains only so old links and bookmarks keep working.
 */
export default function DataPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/dashboard/projects/${id}/tables?filter=entity`);
  }, [id, router]);

  return null;
}
