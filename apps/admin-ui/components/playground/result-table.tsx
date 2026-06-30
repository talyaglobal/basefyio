'use client';

import type { PlaygroundField } from '@/lib/playground/engine';

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ResultTable({
  fields,
  rows,
}: {
  fields: PlaygroundField[];
  rows: Record<string, unknown>[];
}) {
  if (!fields.length) {
    return (
      <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        Statement executed successfully — no columns returned.
      </div>
    );
  }
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0">
          <tr className="border-b bg-muted">
            {fields.map((f) => (
              <th key={f.name} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
              {fields.map((f) => {
                const value = row[f.name];
                return (
                  <td key={f.name} className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                    {value === null || value === undefined ? (
                      <span className="text-muted-foreground/60">NULL</span>
                    ) : (
                      formatValue(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={fields.length} className="px-3 py-6 text-center text-muted-foreground">
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
