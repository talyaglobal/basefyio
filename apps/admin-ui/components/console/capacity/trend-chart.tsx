'use client';

import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CapacityHistoryPoint } from '@/lib/capacity-types';
import { Panel, th, td } from '@/components/console/ui';
import { formatDate } from '@/components/console/format';

/**
 * Runway: the projects the platform can hold against the projects it holds.
 * One axis, two series — the actual count is the point (accent), the capacity
 * the context (grey) — with a legend and a table twin.
 */
export function TrendChart({ history }: { history: CapacityHistoryPoint[] }) {
  const [table, setTable] = useState(false);
  const data = history.map((h) => ({
    ts: h.ts,
    label: new Date(h.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    capacity: h.maxProjects,
    capacityAllAwake: h.maxProjectsAllAwake,
    projects: h.currentProjects,
  }));

  return (
    <Panel
      title="Runway"
      description="Capacity at today's awake share against the projects served. The gap is the runway; the line drops when a resource's ceiling or the per-project cost changes."
      actions={
        <button type="button" onClick={() => setTable((t) => !t)} className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
          {table ? 'Chart' : 'Table'}
        </button>
      }
    >
      {data.length < 2 ? (
        <p className="text-sm text-muted-foreground">The model is stored hourly; the trend appears after a few hours of sampling.</p>
      ) : table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className={th}>When</th>
                <th className={th}>Projects</th>
                <th className={th}>Capacity</th>
                <th className={th}>Capacity, everyone awake</th>
              </tr>
            </thead>
            <tbody>
              {data
                .slice()
                .reverse()
                .map((d) => (
                  <tr key={d.ts} className="border-b last:border-0">
                    <td className={td}>{formatDate(d.ts)}</td>
                    <td className={td}>{d.projects}</td>
                    <td className={td}>{d.capacity ?? '—'}</td>
                    <td className={td}>{d.capacityAllAwake ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} strokeWidth={1} className="stroke-border" strokeDasharray="0" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={32} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} />
                <Tooltip
                  cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  labelFormatter={(_, payload) => (payload?.[0]?.payload?.ts ? formatDate(payload[0].payload.ts) : '')}
                />
                <Line type="monotone" dataKey="capacity" name="Capacity" stroke="hsl(var(--muted-foreground))" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="projects" name="Projects" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 flex gap-4 text-xs text-muted-foreground" aria-label="Legend">
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-primary" /> Projects
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-muted-foreground" /> Capacity at today&apos;s awake share
            </li>
          </ul>
        </>
      )}
    </Panel>
  );
}
