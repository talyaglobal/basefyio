import { cn } from '@/lib/utils';
import { isBeta, RELEASE_LABEL } from '@/lib/release-stage';

/**
 * The small "beta" pill that sits next to every mark while the product is
 * in beta. One switch removes every one of them: NEXT_PUBLIC_RELEASE_STAGE=ga
 * at build time. Lowercase, never wraps, and announced to screen readers as
 * a release note rather than read out as part of the name.
 */
export function BetaBadge({ className, tone = 'brand' }: { className?: string; tone?: 'brand' | 'dark' }) {
  if (!isBeta()) return null;
  return (
    <span
      aria-label="beta release"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide whitespace-nowrap align-middle',
        tone === 'brand'
          ? 'bg-brand-gradient/15 text-blue-700 ring-1 ring-blue-500/30 dark:text-blue-300'
          : 'bg-white/10 text-zinc-200 ring-1 ring-white/20',
        className,
      )}
    >
      {RELEASE_LABEL}
    </span>
  );
}
