import type { TourDef } from '../types';
import { DEFINITIONS as CHROME } from './chrome';
import { DEFINITIONS as WORKSPACE } from './workspace';
import { DEFINITIONS as PROJECT_DATA } from './project-data';
import { DEFINITIONS as PROJECT_SERVICES } from './project-services';

/** Every tour's steps and copy (lazy: only the runner imports this). Add tours in the area files. */
export const TOUR_DEFINITIONS: TourDef[] = [...CHROME, ...WORKSPACE, ...PROJECT_DATA, ...PROJECT_SERVICES];

export function getTourDef(id: string): TourDef | null {
  return TOUR_DEFINITIONS.find((d) => d.id === id) ?? null;
}
