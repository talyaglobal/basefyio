'use client';

import { useDashboard } from '@/app/dashboard/layout';

/**
 * Team-scoped pages (members, billing) always show one team. Name it, and when
 * the header says "All Teams" explain why a single team is shown.
 */
export function ActiveTeamNote({ noun = 'Team' }: { noun?: string }) {
  const { activeTeamId, viewTeamId, teams } = useDashboard();
  const team = teams.find((t) => t.id === activeTeamId);
  if (!team) return null;
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      {noun}: <span className="font-medium text-foreground">{team.name}</span>
      {viewTeamId === 'all' && (
        <> — this page shows one {noun.toLowerCase()} at a time. Pick another from the {noun.toLowerCase()} menu in the header.</>
      )}
    </p>
  );
}
