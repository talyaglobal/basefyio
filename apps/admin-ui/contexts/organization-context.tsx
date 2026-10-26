'use client';

import { createContext, useContext } from 'react';
import type { OrganizationOverview } from '@/lib/types';

export interface OrganizationContextValue {
  /** The organization the URL names; null while loading or when it does not exist. */
  organization: OrganizationOverview | null;
  loading: boolean;
  refresh: () => void;
}

export const OrganizationContext = createContext<OrganizationContextValue>({
  organization: null,
  loading: true,
  refresh: () => {},
});

export function useOrganization() {
  return useContext(OrganizationContext);
}
