'use client';

import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTour } from '@/components/tour/tour-provider';

/** Header button that replays the tour of the current page. Renders nothing where no tour applies. */
export function TourButton() {
  const { target, start } = useTour();
  if (!target) return null;
  const label = target === 'page' ? 'Tour of this page' : 'Tour of the navigation';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      data-tour="shell-tour-button"
      onClick={start}
    >
      <Compass className="h-4 w-4" />
    </Button>
  );
}

/** Mobile-menu twin of the Tour button. `onSelect` closes the menu first. */
export function TourMenuItem({ onSelect, className }: { onSelect: () => void; className?: string }) {
  const { target, start } = useTour();
  if (!target) return null;
  const label = target === 'page' ? 'Tour of this page' : 'Tour of the navigation';
  return (
    <button
      type="button"
      onClick={() => {
        onSelect();
        start();
      }}
      className={className}
    >
      <Compass className="h-4 w-4" />
      {label}
    </button>
  );
}
