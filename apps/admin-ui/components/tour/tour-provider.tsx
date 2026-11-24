'use client';

/**
 * Guided-tour controller for the dashboard. Decides when a tour starts by itself, runs the
 * header Tour button, and tells layouts which tour is on screen (useTourActive).
 *
 * Eager and small: driver.js, its stylesheet, the theme and all copy live in lib/tours/runner.ts,
 * which is imported only when a tour is about to run.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import type { FeatureFlags } from '@/lib/types';
import { useTourPrefs } from '@/lib/tour-prefs';
import { TOUR_ROUTES } from '@/lib/tours/routes';
import { matchTours } from '@/lib/tours/match';
import type { TourDef, TourRoute, TourStep } from '@/lib/tours/types';
import {
  HOLD_SETTLE_MS,
  MANUAL_READY_TIMEOUT_MS,
  MD_QUERY,
  MIN_AUTO_STEPS,
  MIN_MANUAL_STEPS,
  READY_TIMEOUT_MS,
  SETTLE_MS,
  cleanupDriverDom,
  domQuiet,
  focusInEditable,
  hasBlockingParam,
  isBlocked,
  killSwitchOff,
  resolveAnchor,
  sleep,
  waitUntil,
} from '@/lib/tours/dom';
import type { TourOutcome, TourRun } from '@/lib/tours/runner';

type RunnerModule = typeof import('@/lib/tours/runner');

interface TourContextValue {
  /** What the Tour button replays here: the page tour, the chrome tour, or nothing. */
  target: 'page' | 'chrome' | null;
  start: () => void;
  /** Id of the tour on screen (or being prepared), else null. */
  activeTourId: string | null;
}

const TourContext = createContext<TourContextValue>({ target: null, start: () => {}, activeTourId: null });

export function useTour(): TourContextValue {
  return useContext(TourContext);
}

/** True while tour `id` is on screen; layouts use it to hold themselves still (project sidebar). */
export function useTourActive(id: string): boolean {
  return useContext(TourContext).activeTourId === id;
}

let runnerPromise: Promise<RunnerModule> | null = null;
function loadRunner(): Promise<RunnerModule> {
  if (!runnerPromise) {
    runnerPromise = import('@/lib/tours/runner').catch((err) => {
      runnerPromise = null; // allow a later retry
      throw err;
    });
  }
  return runnerPromise;
}

interface ViewState {
  path: string;
  /** An automatic tour ran, or the Tour button was used, in this view. */
  consumed: boolean;
  /** The automatic start has been decided (shown or skipped) for this view. */
  decided: boolean;
  /** The user pressed a key or a pointer button in this view. */
  interacted: boolean;
}

function setAutoMarker(value: 'shown' | 'skipped' | null) {
  try {
    if (value) document.body.dataset.tourAuto = value;
    else delete document.body.dataset.tourAuto;
  } catch {
    // ignore
  }
}

function wideEnough(): boolean {
  try {
    return window.matchMedia(MD_QUERY).matches;
  } catch {
    return false;
  }
}

export function TourProvider({
  features,
  featuresLoaded,
  autoBlocked = false,
  children,
}: {
  features: FeatureFlags;
  featuresLoaded: boolean;
  /** Something on the page outranks a tour (a suspended account). Automatic starts only. */
  autoBlocked?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const prefs = useTourPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const autoBlockedRef = useRef(autoBlocked);
  autoBlockedRef.current = autoBlocked;

  const [activeTourId, setActiveTourId] = useState<string | null>(null);
  const runRef = useRef<(TourRun & { path: string }) | null>(null);
  const viewRef = useRef<ViewState>({ path: pathname, consumed: false, decided: false, interacted: false });
  const autoAbortRef = useRef<AbortController | null>(null);
  const manualTokenRef = useRef(0);
  /** Tours interrupted in this tab: not saved, not offered again automatically until a reload. */
  const suppressedRef = useRef<Set<string>>(new Set());

  const decide = useCallback((value: 'shown' | 'skipped') => {
    const view = viewRef.current;
    if (view.decided) return;
    view.decided = true;
    setAutoMarker(value);
  }, []);

  // Record the first real key or pointer press of each view: an automatic tour never steals it.
  useEffect(() => {
    const onInput = (e: Event) => {
      if (e.isTrusted) viewRef.current.interacted = true;
    };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    return () => {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
    };
  }, []);

  const stopRun = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.stop(); // onEnd clears runRef
  }, []);

  const startRun = useCallback(
    (mod: RunnerModule, def: TourDef, steps: TourStep[]) => {
      stopRun();
      const path = viewRef.current.path;
      let run: (TourRun & { path: string }) | null = null;
      const onEnd = (outcome: TourOutcome) => {
        const mine = run !== null && runRef.current === run;
        if (mine) {
          runRef.current = null;
          setActiveTourId(null);
        }
        if (outcome === 'finished' || outcome === 'closed') prefsRef.current.markSeen(def.id);
        else suppressedRef.current.add(def.id);
      };
      const created = mod.runTour({
        def,
        steps,
        getAutoEnabled: () => prefsRef.current.autoEnabled,
        setAutoEnabled: (on) => void prefsRef.current.setAutoEnabled(on),
        canCleanDom: () => runRef.current === null || runRef.current === run,
        onEnd,
      });
      run = Object.assign(created, { path });
      if (run.isEnded()) {
        setActiveTourId(null);
        return;
      }
      runRef.current = run;
      setActiveTourId(def.id);
    },
    [stopRun],
  );

  // A new pathname is a new view: stop a tour of the old page, forget the decision marker.
  useEffect(() => {
    if (viewRef.current.path !== pathname) {
      viewRef.current = { path: pathname, consumed: false, decided: false, interacted: false };
      setAutoMarker(null);
    }
    const run = runRef.current;
    if (run && run.path !== pathname) {
      run.stop();
      if (runRef.current === null) cleanupDriverDom();
    }
  }, [pathname]);

  // Unmount (sign-out, leaving the dashboard): no tour, no overlay left behind.
  useEffect(
    () => () => {
      autoAbortRef.current?.abort();
      const run = runRef.current;
      if (run) {
        run.stop();
        cleanupDriverDom();
      }
      setAutoMarker(null);
    },
    [],
  );

  const matched = useMemo(() => matchTours(TOUR_ROUTES, pathname, features), [pathname, features]);

  // Automatic start: evaluated on pathname change and when prefs/flags first load, never on a save.
  useEffect(() => {
    const p = prefsRef.current;
    if (!p.available) return; // flag off: no change at all
    if (!p.loaded || !featuresLoaded) return; // not decided yet
    const view = viewRef.current;
    if (view.path !== pathname || view.decided || view.consumed) return;

    if (!p.autoEnabled || !wideEnough() || hasBlockingParam() || killSwitchOff() || autoBlockedRef.current) {
      decide('skipped');
      return;
    }
    const seen = new Set(p.seen);
    const { chrome, page } = matchTours(TOUR_ROUTES, pathname, featuresRef.current);
    const queue = [chrome, page].filter(
      (r): r is TourRoute => !!r && !seen.has(r.id) && !suppressedRef.current.has(r.id),
    );
    if (queue.length === 0) {
      decide('skipped');
      return;
    }

    const ac = new AbortController();
    autoAbortRef.current = ac;
    const { signal } = ac;
    const stillHere = () => !signal.aborted && viewRef.current === view && !view.consumed && runRef.current === null;

    void (async () => {
      let mod: RunnerModule;
      try {
        mod = await loadRunner();
      } catch {
        if (!signal.aborted) decide('skipped');
        return;
      }
      for (const route of queue) {
        if (!stillHere()) return;
        const def = mod.getTourDef(route.id);
        if (!def) continue;
        const ready = await waitUntil(
          () => document.visibilityState === 'visible' && resolveAnchor(def.ready) !== null && !isBlocked(),
          READY_TIMEOUT_MS,
          signal,
        );
        if (!stillHere()) return;
        if (!ready) continue;
        await domQuiet(document.getElementById('main-content'), signal);
        await sleep(SETTLE_MS, signal);
        if (!stillHere()) return;
        if (isBlocked()) continue;
        // Never steal a click or a keystroke: give up for this view, try again on a later one.
        if (view.interacted || focusInEditable()) {
          decide('skipped');
          return;
        }
        // Let layouts hold still for this tour (project sidebar expands) before measuring.
        setActiveTourId(route.id);
        await sleep(HOLD_SETTLE_MS, signal);
        const steps = mod.visibleSteps(def, featuresRef.current);
        if (!stillHere() || view.interacted || focusInEditable() || isBlocked() || steps.length < MIN_AUTO_STEPS) {
          if (runRef.current === null) setActiveTourId(null);
          if (!stillHere()) return;
          if (view.interacted || focusInEditable()) {
            decide('skipped');
            return;
          }
          continue;
        }
        view.consumed = true;
        decide('shown');
        startRun(mod, def, steps);
        return;
      }
      if (!signal.aborted && viewRef.current === view) decide('skipped');
    })();

    return () => {
      ac.abort();
      if (autoAbortRef.current === ac) autoAbortRef.current = null;
    };
  }, [pathname, prefs.available, prefs.loaded, featuresLoaded, decide, startRun]);

  const target: TourContextValue['target'] =
    prefs.available && prefs.loaded ? (matched.page ? 'page' : matched.chrome ? 'chrome' : null) : null;

  const start = useCallback(() => {
    const route = matched.page ?? matched.chrome;
    if (!route) return;
    // A manual start wins over a pending automatic one, and uses up this view.
    autoAbortRef.current?.abort();
    autoAbortRef.current = null;
    const view = viewRef.current;
    view.consumed = true;
    decide('skipped');
    stopRun();
    const token = ++manualTokenRef.current;
    const current = () => manualTokenRef.current === token && viewRef.current === view;

    void (async () => {
      let mod: RunnerModule;
      try {
        mod = await loadRunner();
      } catch {
        if (current()) toast.error('Could not load the tour. Try again.');
        return;
      }
      if (!current()) return;
      const def = mod.getTourDef(route.id);
      if (!def) return;
      const ready = await waitUntil(
        () => resolveAnchor(def.ready) !== null && !isBlocked(),
        MANUAL_READY_TIMEOUT_MS,
      );
      if (!current()) return;
      if (!ready) {
        toast.info('This page is still loading. Try again in a moment.');
        return;
      }
      setActiveTourId(def.id);
      await sleep(HOLD_SETTLE_MS);
      if (!current()) {
        if (runRef.current === null) setActiveTourId(null);
        return;
      }
      const steps = mod.visibleSteps(def, featuresRef.current);
      if (steps.length < MIN_MANUAL_STEPS) {
        if (runRef.current === null) setActiveTourId(null);
        toast.info('There is nothing to show on this page yet.');
        return;
      }
      startRun(mod, def, steps);
    })();
  }, [matched, decide, stopRun, startRun]);

  const value = useMemo<TourContextValue>(() => ({ target, start, activeTourId }), [target, start, activeTourId]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}
