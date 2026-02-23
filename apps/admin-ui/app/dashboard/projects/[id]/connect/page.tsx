'use client';

import { useParams } from 'next/navigation';
import { ConnectionStringsView } from '@/components/connection-strings';

export default function ConnectPage() {
  const { id } = useParams<{ id: string }>();
  return <ConnectionStringsView projectId={id} />;
}
