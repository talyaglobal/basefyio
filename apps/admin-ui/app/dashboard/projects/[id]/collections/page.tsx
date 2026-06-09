'use client';

import { useParams } from 'next/navigation';
import { CollectionsEditor } from '@/components/collections-editor';

export default function CollectionsPage() {
  const { id } = useParams<{ id: string }>();
  return <CollectionsEditor projectId={id} />;
}
