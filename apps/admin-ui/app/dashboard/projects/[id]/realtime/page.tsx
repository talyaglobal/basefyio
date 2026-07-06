'use client';

import { useParams } from 'next/navigation';
import { RealtimeSettingsCard } from '@/components/realtime-settings-card';

export default function RealtimePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-4xl p-6">
      <RealtimeSettingsCard projectId={id} />
    </div>
  );
}
