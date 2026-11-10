'use client';

import { useParams, useRouter } from 'next/navigation';
import { useActiveTeam } from '../../layout';
import { BlueprintDetailView } from '@/components/blueprints';

export default function BlueprintPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { activeTeamId } = useActiveTeam();
  return <BlueprintDetailView id={id} teamId={activeTeamId} onBack={() => router.push('/dashboard/blueprints')} />;
}
