'use client';

import type { ElementType } from 'react';
import {
  Briefcase,
  Building2,
  Code2,
  GraduationCap,
  HeartHandshake,
  Rocket,
  Shapes,
  User,
} from 'lucide-react';
import type { OrganizationKind } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface OrganizationKindMeta {
  value: OrganizationKind;
  label: string;
  description: string;
  icon: ElementType;
}

/** The kinds a person can pick; PERSONAL is reserved for the organization made at sign-up. */
export const SELECTABLE_ORGANIZATION_KINDS: OrganizationKindMeta[] = [
  { value: 'COMPANY', label: 'Company', description: 'A business with a team and customers', icon: Building2 },
  { value: 'STARTUP', label: 'Startup', description: 'Early stage, moving fast', icon: Rocket },
  { value: 'AGENCY', label: 'Agency', description: 'Building for clients', icon: Briefcase },
  { value: 'EDUCATION', label: 'Education', description: 'A school, a course, a research group', icon: GraduationCap },
  { value: 'NONPROFIT', label: 'Non-profit', description: 'A cause rather than a product', icon: HeartHandshake },
  { value: 'OPEN_SOURCE', label: 'Open source', description: 'A public project and its contributors', icon: Code2 },
  { value: 'OTHER', label: 'Other', description: 'None of the above', icon: Shapes },
];

const PERSONAL: OrganizationKindMeta = {
  value: 'PERSONAL',
  label: 'Personal',
  description: 'Your own organization, made when you signed up',
  icon: User,
};

export function kindMeta(kind?: OrganizationKind | null): OrganizationKindMeta {
  if (kind === 'PERSONAL') return PERSONAL;
  return SELECTABLE_ORGANIZATION_KINDS.find((k) => k.value === kind) ?? SELECTABLE_ORGANIZATION_KINDS[0];
}

export function OrganizationKindIcon({ kind, className }: { kind?: OrganizationKind | null; className?: string }) {
  const Icon = kindMeta(kind).icon;
  return <Icon className={className} aria-hidden="true" />;
}

export function OrganizationKindBadge({ kind, className }: { kind?: OrganizationKind | null; className?: string }) {
  const meta = kindMeta(kind);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      <meta.icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
