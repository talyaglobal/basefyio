'use client';

import { useParams } from 'next/navigation';
import { StorageBrowser } from '@/components/storage-browser';

export default function StoragePage() {
  const { id } = useParams<{ id: string }>();
  return <StorageBrowser projectId={id} />;
}
