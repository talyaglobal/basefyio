'use client';

import { useParams } from 'next/navigation';
import { DataBrowser } from '@/components/data-browser';

export default function DataPage() {
  const { id } = useParams<{ id: string }>();
  return <DataBrowser projectId={id} />;
}
