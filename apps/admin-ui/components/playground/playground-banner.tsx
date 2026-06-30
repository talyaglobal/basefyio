'use client';

import { Info, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlayground } from './playground-provider';

export function PlaygroundBanner() {
  const { reset, resetting, status } = usePlayground();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm">
      <div className="flex items-center gap-2 text-amber-200">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          This is a public sandbox running entirely in your browser. Data resets automatically — nothing is saved.
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 border-amber-500/30"
        onClick={() => void reset()}
        disabled={resetting || status !== 'ready'}
      >
        {resetting ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
        )}
        Reset data
      </Button>
    </div>
  );
}
