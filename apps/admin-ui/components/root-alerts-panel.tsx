'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { RootAlert } from '@/lib/types';
import { Button } from './ui/button';
import { toast } from 'sonner';

function severityClass(severity: string) {
  const v = severity.toUpperCase();
  if (v === 'CRITICAL') return 'bg-red-100 text-red-700';
  if (v === 'HIGH') return 'bg-orange-100 text-orange-700';
  if (v === 'MEDIUM') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-700';
}

export function RootAlertsPanel() {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<RootAlert[]>([]);

  async function load() {
    setLoading(true);
    try {
      const data = await api.observability.listRootAlerts(50);
      setAlerts(data);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load root alerts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!loading && alerts.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          ROOT Alerts
        </h2>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={a.id}
              className={`rounded-lg border p-3 ${a.isRead ? 'opacity-70' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="text-xs text-muted-foreground">{a.message}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${severityClass(a.severity)}`}>
                    {a.severity}
                  </span>
                  {!a.isRead && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await api.observability.markRootAlertRead(a.id);
                          setAlerts((prev) =>
                            prev.map((x) => (x.id === a.id ? { ...x, isRead: true } : x)),
                          );
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to mark alert as read');
                        }
                      }}
                    >
                      Mark Read
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

