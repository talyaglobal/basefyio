'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onEscape` when Escape is pressed while `active` is true.
 *
 * Dialogs built on Radix handle Escape themselves and mark the event as
 * handled, so a menu or panel underneath an open dialog is not closed by the
 * same key press.
 */
export function useEscapeKey(active: boolean, onEscape: (event: KeyboardEvent) => void) {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      handler.current(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);
}

/**
 * Arrow-key navigation for a menu rendered as a list of buttons.
 *
 * Items carry `data-menu-item`; an optional search field carries
 * `data-menu-search`. ArrowDown / ArrowUp move focus between them (ArrowUp on
 * the first item returns to the search field), Home / End jump to the ends.
 * Enter on a focused item is the button's own click.
 *
 * Returns true when the key was handled.
 */
export function handleMenuArrowKeys(
  event: { key: string; preventDefault(): void },
  container: HTMLElement | null,
): boolean {
  if (!container) return false;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])'),
  );
  if (items.length === 0) return false;
  const search = container.querySelector<HTMLElement>('[data-menu-search]');
  const active = document.activeElement as HTMLElement | null;
  const index = active ? items.indexOf(active) : -1;

  let next: HTMLElement | null = null;
  if (event.key === 'Home') next = items[0];
  else if (event.key === 'End') next = items[items.length - 1];
  else if (event.key === 'ArrowDown') next = index < 0 ? items[0] : items[Math.min(index + 1, items.length - 1)];
  else if (event.key === 'ArrowUp') {
    if (index <= 0) next = search ?? items[items.length - 1];
    else next = items[index - 1];
  }
  if (!next) return false;
  event.preventDefault();
  next.focus();
  next.scrollIntoView?.({ block: 'nearest' });
  return true;
}
