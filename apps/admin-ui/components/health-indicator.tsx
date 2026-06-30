'use client';

import { useEffect, useState } from 'react';
import { getSdk } from '@/lib/sdk';

export function HealthIndicator() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'error'>('checking');

  useEffect(() => {
    getSdk()
      .health()
      .then(() => setStatus('ok'))
      .catch(() => setStatus('error'));
  }, []);

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={`h-2 w-2 rounded-full ${
          status === 'ok' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/50'
        }`}
      />
      {status === 'ok' ? 'API healthy' : status === 'error' ? 'API unreachable' : 'Checking...'}
    </div>
  );
}
