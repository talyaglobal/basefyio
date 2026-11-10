'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ORDER = ['light', 'dark', 'system'] as const;
const LABEL = { light: 'Light', dark: 'Dark', system: 'System' } as const;
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** Cycles Light, Dark, System; "System" follows the operating system setting. */
export function ThemeToggle({ withLabel = false, className }: { withLabel?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className={cn('h-9 shrink-0', withLabel ? 'w-full' : 'w-9', className)} aria-hidden />;
  }

  const current = (ORDER as readonly string[]).includes(theme ?? '') ? (theme as (typeof ORDER)[number]) : 'system';
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = ICON[current];

  return (
    <Button
      type="button"
      variant="ghost"
      size={withLabel ? 'default' : 'icon'}
      className={cn(
        'shrink-0 text-muted-foreground hover:text-foreground',
        withLabel ? 'h-9 w-full justify-start gap-2.5 px-2' : 'h-9 w-9',
        className,
      )}
      title={`Theme: ${LABEL[current]} (click for ${LABEL[next]})`}
      aria-label={`Theme: ${LABEL[current]}. Switch to ${LABEL[next]}`}
      onClick={() => setTheme(next)}
    >
      <Icon className="h-4 w-4" />
      {withLabel && <span>Theme: {LABEL[current]}</span>}
    </Button>
  );
}
