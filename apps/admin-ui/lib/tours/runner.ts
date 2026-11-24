/**
 * The lazy half of the tour engine: driver.js, its stylesheet, the theme and all tour copy.
 * Only `import('@/lib/tours/runner')` in the tour provider loads this module.
 */
import { driver, type DestroyReason, type DriveStep, type PopoverDOM } from 'driver.js';
import 'driver.js/dist/driver.css';
import './tour.css';
import type { FeatureFlags } from '@/lib/types';
import { getTourDef } from './definitions';
import { whenPasses } from './match';
import { cleanupDriverDom, isBlocked, resolveAnchor } from './dom';
import { MAX_SHOWN_STEPS, type TourDef, type TourStep } from './types';

export { getTourDef };

/** How a run ended: finished (Done), closed (X or Escape) or interrupted (anything else). */
export type TourOutcome = 'finished' | 'closed' | 'interrupted';

export interface TourRun {
  readonly id: string;
  /** Ends the run as interrupted. Safe to call more than once. */
  stop(): void;
  isEnded(): boolean;
}

export interface RunOptions {
  def: TourDef;
  steps: TourStep[];
  /** Live read of the preference; the checkbox shows its opposite on every step. */
  getAutoEnabled: () => boolean;
  setAutoEnabled: (on: boolean) => void;
  /** True when no other run is live, so leftover driver nodes may be removed. */
  canCleanDom: () => boolean;
  onEnd: (outcome: TourOutcome) => void;
}

const OPT_OUT_HINT = 'Turns off automatic tours on every page. You can turn them back on in Account settings.';
let renderCount = 0;

/** Steps whose anchor is visible right now, in order, at most MAX_SHOWN_STEPS. */
export function visibleSteps(def: TourDef, features: Partial<FeatureFlags>): TourStep[] {
  return def.steps
    .filter((s) => whenPasses(s.when, features) && resolveAnchor(s.anchor) !== null)
    .slice(0, MAX_SHOWN_STEPS);
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function addOptOut(popover: PopoverDOM, opts: Pick<RunOptions, 'getAutoEnabled' | 'setAutoEnabled'>) {
  renderCount += 1;
  const inputId = `basefyio-tour-optout-${renderCount}`;
  const hintId = `${inputId}-hint`;

  const label = document.createElement('label');
  label.className = 'basefyio-tour-optout';
  label.htmlFor = inputId;
  label.title = OPT_OUT_HINT;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = inputId;
  input.setAttribute('aria-describedby', hintId);
  // Read the live preference every time: a value cached at mount would be stale.
  input.checked = !opts.getAutoEnabled();
  input.addEventListener('change', () => opts.setAutoEnabled(!input.checked));

  const text = document.createElement('span');
  text.textContent = "Don't show again";

  const hint = document.createElement('span');
  hint.id = hintId;
  hint.className = 'basefyio-tour-sr-only';
  hint.textContent = OPT_OUT_HINT;

  label.append(input, text, hint);
  popover.wrapper.appendChild(label);
}

export function runTour(opts: RunOptions): TourRun {
  const { def, steps } = opts;
  let ended = false;
  let interrupted = false;
  let misses = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const dark = document.documentElement.classList.contains('dark');

  const finish = (outcome: TourOutcome) => {
    if (ended) return;
    ended = true;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    try {
      opts.onEnd(outcome);
    } catch {
      // the provider's handler never throws on purpose; never let it break cleanup
    }
  };

  const outcomeOf = (reason: DestroyReason | undefined): TourOutcome => {
    if (interrupted) return 'interrupted';
    if (reason === 'done') return 'finished';
    if (reason === 'close' || reason === 'escape' || reason === 'overlay') return 'closed';
    return 'interrupted'; // 'replaced', 'api'
  };

  const driveSteps: DriveStep[] = steps.map((s) => ({
    element: (() => resolveAnchor(s.anchor) ?? undefined) as unknown as () => Element,
    popover: { title: s.title, description: s.text, side: s.side ?? 'bottom', align: s.align ?? 'start' },
    data: { anchor: s.anchor },
  }));

  const d = driver({
    steps: driveSteps,
    animate: !reducedMotion(),
    smoothScroll: false,
    allowClose: true,
    allowKeyboardControl: true,
    overlayClickBehavior: 'none',
    overlayColor: '#000',
    overlayOpacity: dark ? 0.65 : 0.5,
    stagePadding: 6,
    stageRadius: 8,
    popoverOffset: 10,
    disableActiveInteraction: true,
    showButtons: ['next', 'previous', 'close'],
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    closeBtnLabel: 'Close tour',
    popoverClass: 'basefyio-tour',
    onPopoverRender: (popover) => {
      try {
        addOptOut(popover, opts);
      } catch {
        // the tour still works without the checkbox
      }
    },
    onDestroyed: (_el, _step, hook) => finish(outcomeOf(hook.reason)),
  });

  const run: TourRun = {
    id: def.id,
    isEnded: () => ended,
    stop: () => {
      if (ended) return;
      interrupted = true;
      try {
        d.destroy();
      } catch {
        // fall through to the hard cleanup
      }
      // destroy() fires onDestroyed only when a step was active; end the run either way.
      finish('interrupted');
      if (opts.canCleanDom()) cleanupDriverDom();
    },
  };

  // Stop when the highlighted control disappears (two ticks in a row) or a dialog or menu opens.
  watchdog = setInterval(() => {
    if (ended) return;
    if (!d.isActive()) {
      run.stop();
      return;
    }
    if (isBlocked()) {
      run.stop();
      return;
    }
    const anchor = d.getActiveStep()?.data?.anchor as string | undefined;
    if (anchor && !resolveAnchor(anchor)) {
      misses += 1;
      if (misses >= 2) run.stop();
    } else {
      misses = 0;
    }
  }, 1000);

  try {
    d.drive(0);
  } catch {
    run.stop();
  }
  return run;
}
