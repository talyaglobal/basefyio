'use client';

import { useActiveTeam } from '../layout';
import { Blueprints } from '@/components/blueprints';

export default function BlueprintsPage() {
  const { activeTeamId } = useActiveTeam();
  return <Blueprints teamId={activeTeamId} />;
}
