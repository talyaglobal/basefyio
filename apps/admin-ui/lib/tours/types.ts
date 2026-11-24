/**
 * Shapes of the guided-tour engine. Route files (eager) and definition files (lazy) may only
 * `import type` from anywhere: scripts/check-tours.js evaluates them on their own at build time.
 */
import type { FeatureFlags } from '@/lib/types';

/**
 * A tour id is the key saved in the user's "seen" list on the server. Never rename one after it
 * has shipped (users would see that tour again). Must match TOUR_ID_PATTERN (the API checks it).
 */
export type TourId = string;
/** The value of a `data-tour="..."` attribute. Starts with the id of the tour it belongs to. */
export type AnchorId = string;

/** The four areas; each owns one routes file and one definitions file. */
export type TourArea = 'chrome' | 'workspace' | 'project-data' | 'project-services';

/** Declarative variant selection by runtime flag. Data-dependent variants use the visibility filter. */
export interface TourWhen {
  flagOn?: keyof FeatureFlags;
  flagOff?: keyof FeatureFlags;
}

/** Eager part of a tour: which pages it belongs to. No copy here. */
export interface TourRoute {
  id: TourId;
  /** `chrome` explains the frame around the pages (header, sidebars); `page` explains one page. */
  kind: 'chrome' | 'page';
  /**
   * Next-style patterns matched against the whole pathname, e.g. `/dashboard/projects/[id]/sql`.
   * A trailing `/**` also matches every path below it (chrome tours only).
   */
  routes: string[];
  /** Patterns (same syntax) that must not match. */
  except?: string[];
  when?: TourWhen;
}

export interface TourStep {
  /** `data-tour` value of the element to highlight. */
  anchor: AnchorId;
  /** At most 40 characters: the control's visible label, or 1 to 3 words. */
  title: string;
  /** One plain-text sentence, at most 16 words and 140 characters, saying what the control does. */
  text: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  when?: TourWhen;
}

/** Lazy part of a tour: its steps and copy. */
export interface TourDef {
  id: TourId;
  /** Anchor that exists only once the page shows real content (not a spinner, skeleton or error). */
  ready: AnchorId;
  /** 2 to 12 steps. Variants that are never visible together may all be listed; at most 9 are shown. */
  steps: TourStep[];
}

export const TOUR_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
export const ANCHOR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
export const MAX_TOUR_ID_LENGTH = 64;
/** Most ids the API accepts in one `markSeen` request. */
export const MAX_IDS_PER_REQUEST = 20;
/** Most steps shown in one run; the rest of a long definition is cut. */
export const MAX_SHOWN_STEPS = 9;
