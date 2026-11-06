import { useEffect } from 'react';

/** Calls `onEscape` when Escape is pressed while `active` (menus, panels, modals). */
export function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape, active]);
}

/** onKeyDown for a popup: ArrowUp/ArrowDown move focus between its inputs, buttons and links. */
export function menuArrowKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('input, button:not([disabled]), a[href]'),
  );
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  e.preventDefault();
  items[(i + step + items.length) % items.length].focus();
}
