'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { AuditLogEntry, RootAlert } from '@/lib/types';
import { Button } from './ui/button';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

function severityClass(severity: string) {
  const v = severity.toUpperCase();
  if (v === 'CRITICAL') return 'bg-red-100 text-red-700';
  if (v === 'HIGH') return 'bg-orange-100 text-orange-700';
  if (v === 'MEDIUM') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-700';
}

export function RootAlertsPanel({
  showRead = true,
  title = 'ROOT Alerts',
}: {
  showRead?: boolean;
  title?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<RootAlert[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<RootAlert | null>(null);
  const [selectedAudit, setSelectedAudit] = useState<AuditLogEntry | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

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

  async function openDetails(alert: RootAlert) {
    setSelectedAlert(alert);
    setSelectedAudit(null);
    setDetailsOpen(true);

    if (!alert.relatedAuditLogId) return;

    setDetailsLoading(true);
    try {
      const row = await api.observability.getAuditLog(alert.relatedAuditLogId);
      setSelectedAudit(row);
    } catch (err: any) {
      if (err?.status === 404) {
        setSelectedAudit(null);
      } else {
        toast.error(err.message || 'Failed to load alert details');
      }
    } finally {
      setDetailsLoading(false);
    }
  }

  function renderJson(value: unknown) {
    if (value === null || value === undefined) {
      return '(none — legacy row or field not stored)';
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  const visibleAlerts = showRead ? alerts : alerts.filter((a) => !a.isRead);

  if (!loading && visibleAlerts.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          {title}
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
          {visibleAlerts.map((a) => (
            <div
              key={a.id}
              className={`rounded-lg border p-3 ${a.isRead ? 'opacity-70' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="text-xs text-muted-foreground">{a.message}</p>
                  {(a.relatedActorDisplay || a.relatedTargetDisplay) && (
                    <div className="mt-2 space-y-0.5 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-foreground/90">
                      {a.relatedActorDisplay && (
                        <p>
                          <span className="text-muted-foreground">Actor:</span> {a.relatedActorDisplay}
                        </p>
                      )}
                      {a.relatedTargetDisplay && (
                        <p>
                          <span className="text-muted-foreground">Target:</span> {a.relatedTargetDisplay}
                        </p>
                      )}
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${severityClass(a.severity)}`}>
                    {a.severity}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void openDetails(a)}>
                    Details
                  </Button>
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

      <Dialog
        open={detailsOpen}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open) {
            setSelectedAlert(null);
            setSelectedAudit(null);
            setDetailsLoading(false);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>ROOT Alert Details</DialogTitle>
            <DialogDescription>
              Full warning/error context including related audit trail.
            </DialogDescription>
          </DialogHeader>

          {selectedAlert && (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Alert</p>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div><span className="text-muted-foreground">ID:</span> <span className="ml-1 font-mono text-xs">{selectedAlert.id}</span></div>
                  <div><span className="text-muted-foreground">Kind:</span> <span className="ml-1">{selectedAlert.kind}</span></div>
                  <div><span className="text-muted-foreground">Severity:</span> <span className="ml-1">{selectedAlert.severity}</span></div>
                  <div><span className="text-muted-foreground">Read:</span> <span className="ml-1">{selectedAlert.isRead ? 'Yes' : 'No'}</span></div>
                  <div><span className="text-muted-foreground">Created:</span> <span className="ml-1">{new Date(selectedAlert.createdAt).toLocaleString()}</span></div>
                  <div>
                    <span className="text-muted-foreground">Related Audit ID:</span>{' '}
                    <span className="ml-1 font-mono text-xs">
                      {selectedAlert.relatedAuditLogId || '(none)'}
                    </span>
                  </div>
                </div>
                {(selectedAlert.relatedActorDisplay || selectedAlert.relatedTargetDisplay) && (
                  <div className="mt-3 rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-xs">
                    {selectedAlert.relatedActorDisplay && (
                      <p>
                        <span className="font-medium text-muted-foreground">Who acted:</span>{' '}
                        {selectedAlert.relatedActorDisplay}
                      </p>
                    )}
                    {selectedAlert.relatedTargetDisplay && (
                      <p className="mt-1">
                        <span className="font-medium text-muted-foreground">Who / what was affected:</span>{' '}
                        {selectedAlert.relatedTargetDisplay}
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-3">
                  <p className="font-medium">{selectedAlert.title}</p>
                  <p className="mt-1 text-muted-foreground">{selectedAlert.message}</p>
                </div>
              </div>

              {detailsLoading ? (
                <div className="flex h-20 items-center justify-center rounded-lg border">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : selectedAlert.relatedAuditLogId ? (
                selectedAudit ? (
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Related Audit</p>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div><span className="text-muted-foreground">Trace ID:</span> <span className="ml-1 font-mono text-xs">{selectedAudit.traceId}</span></div>
                      <div><span className="text-muted-foreground">Action:</span> <span className="ml-1">{selectedAudit.action}</span></div>
                      <div className="md:col-span-2">
                        <span className="text-muted-foreground">Actor:</span>
                        {selectedAudit.actorDisplayName ? (
                          <div className="mt-0.5 text-foreground">
                            <span className="text-sm">{selectedAudit.actorDisplayName}</span>
                          </div>
                        ) : (
                          <span className="ml-1 font-mono text-xs">{selectedAudit.actorUserId}</span>
                        )}
                      </div>
                      <div><span className="text-muted-foreground">Role:</span> <span className="ml-1">{selectedAudit.actorRole}</span></div>
                      <div className="md:col-span-2">
                        <span className="text-muted-foreground">Resource:</span>
                        {selectedAudit.resourceDisplayName ? (
                          <div className="mt-0.5">
                            <span className="text-sm text-foreground">{selectedAudit.resourceDisplayName}</span>
                            <span className="ml-2 text-muted-foreground">
                              ({selectedAudit.resourceType}
                              {selectedAudit.resourceId ? ` · ${selectedAudit.resourceId}` : ''})
                            </span>
                          </div>
                        ) : (
                          <span className="ml-1">
                            {selectedAudit.resourceType}
                            {selectedAudit.resourceId ? ` / ${selectedAudit.resourceId}` : ''}
                          </span>
                        )}
                      </div>
                      <div><span className="text-muted-foreground">Result:</span> <span className="ml-1">{selectedAudit.success ? 'SUCCESS' : 'FAIL'}</span></div>
                      <div><span className="text-muted-foreground">Severity:</span> <span className="ml-1">{selectedAudit.severity}</span></div>
                      <div><span className="text-muted-foreground">Time:</span> <span className="ml-1">{new Date(selectedAudit.createdAt).toLocaleString()}</span></div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">Before</p>
                        <pre className="max-h-52 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">{renderJson(selectedAudit.beforeJson)}</pre>
                      </div>
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">After</p>
                        <pre className="max-h-52 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">{renderJson(selectedAudit.afterJson)}</pre>
                      </div>
                    </div>

                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Metadata</p>
                      <pre className="max-h-56 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">{renderJson(selectedAudit.metadataJson)}</pre>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    Related audit log could not be found in the recent records window.
                  </div>
                )
              ) : (
                <div className="rounded-lg border p-3 text-xs text-muted-foreground">
                  This alert has no related audit log.
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

