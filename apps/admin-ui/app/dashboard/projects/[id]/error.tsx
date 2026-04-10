'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error('[ProjectError]', error);
  }, [error]);

  return (
    <div className="flex h-64 flex-col items-center justify-center gap-4">
      <AlertTriangle className="h-10 w-10 text-amber-500" />
      <p className="text-sm text-muted-foreground">
        Something went wrong loading this project.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => router.push('/dashboard/projects')}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back to Projects
        </Button>
        <Button size="sm" onClick={reset}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    </div>
  );
}
