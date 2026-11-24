import type { TourRoute } from '../types';
import { ROUTES as CHROME } from './chrome';
import { ROUTES as WORKSPACE } from './workspace';
import { ROUTES as PROJECT_DATA } from './project-data';
import { ROUTES as PROJECT_SERVICES } from './project-services';

/** Every tour's routes (eager: small, no copy). Add tours in the area files, never here. */
export const TOUR_ROUTES: TourRoute[] = [...CHROME, ...WORKSPACE, ...PROJECT_DATA, ...PROJECT_SERVICES];
