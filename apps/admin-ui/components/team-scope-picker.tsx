'use client';

import { useState } from 'react';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { ArrowRight, Loader2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import type { Team } from '@/lib/types';
import { useDashboard } from '@/app/dashboard/layout';

const ROLE_LABEL: Record<Team['role'], string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

/**
 * Shown by pages whose content belongs to exactly one team (team settings,
 * billing) while the switcher is on "All Teams". Instead of quietly showing
 * whichever team happened to be active, the page says so and lets the user
 * choose; choosing makes that team the active one, exactly like the switcher.
 */
export function TeamScopePicker({
  title,
  description,
  teams,
}: {
  title: string;
  description: string;
  teams: Team[];
}) {
  const { activeTeamId, setActiveTeamId, setViewTeamId } = useDashboard();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));

  async function pick(teamId: string) {
    setPendingId(teamId);
    try {
      await api.teams.setActive(teamId);
      Cookies.set('basefyio_active_team', teamId, { expires: 365, path: '/' });
      setViewTeamId(teamId);
      setActiveTeamId(teamId);
    } catch (err: any) {
      toast.error(err?.message || 'Could not switch to that team');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Users className="h-4 w-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading teams…
        </div>
      ) : (
        <ul className="divide-y">
          {sorted.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                onClick={() => void pick(team.id)}
                disabled={pendingId !== null}
                className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-xs font-bold text-white shadow-sm">
                  {team.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{team.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                      {ROLE_LABEL[team.role] ?? team.role}
                    </span>
                    {team.id === activeTeamId && (
                      <span className="shrink-0 text-[10px] font-medium text-primary">Last used</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {team.memberCount} member{team.memberCount !== 1 ? 's' : ''} · {team.projectCount} project
                    {team.projectCount !== 1 ? 's' : ''}
                  </p>
                </div>
                {pendingId === team.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                ) : (
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="sr-only">Open {team.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
