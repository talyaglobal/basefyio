/** DOM helpers for the tour engine (eager, small, no dependencies). */

export const POLL_MS = 200;
/** How long an automatic start waits for the page to be ready. */
export const READY_TIMEOUT_MS = 10_000;
/** How long the Tour button waits for the page to be ready. */
export const MANUAL_READY_TIMEOUT_MS = 3_000;
export const QUIET_WINDOW_MS = 400;
export const QUIET_MAX_MS = 3_000;
export const SETTLE_MS = 300;
/** Time for a layout held open by a tour (project sidebar) to finish its width transition. */
export const HOLD_SETTLE_MS = 260;
export const MIN_AUTO_STEPS = 2;
export const MIN_MANUAL_STEPS = 1;
export const MD_QUERY = '(min-width: 768px)';
/** `localStorage[KILL_KEY] === 'off'` turns automatic tours off in this browser (tests, support). */
export const KILL_KEY = 'basefyio_tours_auto';
/** Query parameters that mean the page is busy with something else on arrival. */
export const BLOCKING_PARAMS = [
  'feedback',
  'addCard',
  'forcePasswordChange',
  'success',
  'canceled',
  'paypal',
  'token',
  'github_connected',
  'github_error',
  'vercel_connected',
  'vercel_error',
];

const BLOCKER_SELECTOR =
  '[data-tour-block], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function insideTour(el: Element): boolean {
  return !!el.closest('.driver-popover');
}

export function isVisible(el: Element | null | undefined): el is Element {
  if (!el || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof check === 'function') {
    try {
      if (!check.call(el, { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {
      // older engines: fall through to the rect checks above
    }
  }
  return true;
}

/** First visible element carrying `data-tour="<anchor>"`. */
export function resolveAnchor(anchor: string): Element | null {
  try {
    const all = document.querySelectorAll(`[data-tour="${anchor}"]`);
    for (const el of Array.from(all)) {
      if (isVisible(el)) return el;
    }
  } catch {
    // invalid selector: treat as missing
  }
  return null;
}

/** A dialog, menu, listbox, scroll lock or `data-tour-block` element is on screen. */
export function isBlocked(): boolean {
  try {
    if (document.body.hasAttribute('data-scroll-locked')) return true;
    const all = document.querySelectorAll(BLOCKER_SELECTOR);
    for (const el of Array.from(all)) {
      if (!insideTour(el) && isVisible(el)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Focus is somewhere the user types. */
export function focusInEditable(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  if (insideTour(el)) return false;
  // Fields the app focuses by itself (the AI panel input). A user who clicks or types there is
  // caught by the provider's pointer and key listeners instead.
  if (el.hasAttribute('data-tour-autofocus')) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function hasBlockingParam(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return BLOCKING_PARAMS.some((p) => params.has(p));
  } catch {
    return false;
  }
}

export function killSwitchOff(): boolean {
  try {
    return window.localStorage.getItem(KILL_KEY) === 'off';
  } catch {
    return false;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** Polls `test` until it is true (resolves true), the timeout passes or the signal aborts (false). */
export async function waitUntil(test: () => boolean, timeoutMs: number, signal?: AbortSignal, intervalMs = POLL_MS): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return false;
    try {
      if (test()) return true;
    } catch {
      // keep polling
    }
    if (Date.now() >= end) return false;
    await sleep(intervalMs, signal);
  }
}

/** Resolves once `root` has had no DOM mutations for QUIET_WINDOW_MS, or after QUIET_MAX_MS. */
export function domQuiet(root: Element | null, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!root || signal?.aborted || typeof MutationObserver === 'undefined') return resolve();
    let quietTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, QUIET_WINDOW_MS);
    });
    const maxTimer = setTimeout(done, QUIET_MAX_MS);
    quietTimer = setTimeout(done, QUIET_WINDOW_MS);
    observer.observe(root, { childList: true, subtree: true });
    signal?.addEventListener('abort', done, { once: true });
  });
}

const BODY_CLASSES = ['driver-active', 'driver-fade', 'driver-simple', 'driver-no-scroll', 'driver-page-interactive'];
const ELEMENT_CLASSES = [
  'driver-active-element',
  'driver-active-element-raised',
  'driver-active-element-parent',
  'driver-active-element-parent-no-scroll',
  'driver-no-interaction',
  'driver-allowed-element',
];

/**
 * Removes whatever driver.js may have left behind. A stuck `driver-active` on body would make the
 * whole app unclickable, so this runs after every interrupted tour when no other tour is live.
 */
export function cleanupDriverDom(): void {
  try {
    document.body.classList.remove(...BODY_CLASSES);
    document.body.style.removeProperty('--driver-animation-duration');
    document
      .querySelectorAll('.driver-overlay, .driver-popover, .driver-dummy-element, .driver-layer, .driver-live-region')
      .forEach((n) => n.remove());
    for (const cls of ELEMENT_CLASSES) {
      document.querySelectorAll(`.${cls}`).forEach((n) => n.classList.remove(cls));
    }
  } catch {
    // nothing else to do
  }
}
