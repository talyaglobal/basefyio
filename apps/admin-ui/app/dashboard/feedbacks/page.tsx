'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDashboard } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Bug,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  Lightbulb,
  Loader2,
  MessageSquare,
  RefreshCw,
  XCircle,
} from 'lucide-react';

type FeedbackItem = Awaited<ReturnType<typeof api.feedback.list>>[number];

type FeedbackAttachment = { url: string; mimeType?: string; kind?: string };

function parseAttachments(raw: unknown): FeedbackAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is FeedbackAttachment =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as FeedbackAttachment).url === 'string',
  );
}

const STATUS_OPTIONS = ['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED'] as const;

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  OPEN: { label: 'Open', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: <Circle className="h-3 w-3" /> },
  IN_PROGRESS: { label: 'In Progress', color: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: <Clock className="h-3 w-3" /> },
  DONE: { label: 'Done', color: 'bg-green-100 text-green-700 border-green-200', icon: <CheckCircle2 className="h-3 w-3" /> },
  CLOSED: { label: 'Closed', color: 'bg-gray-100 text-gray-500 border-gray-200', icon: <XCircle className="h-3 w-3" /> },
};

const TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode }> = {
  BUG: { label: 'Bug', icon: <Bug className="h-3.5 w-3.5 text-red-500" /> },
  FEATURE: { label: 'Feature', icon: <Lightbulb className="h-3.5 w-3.5 text-purple-500" /> },
  GENERAL: { label: 'General', icon: <MessageSquare className="h-3.5 w-3.5 text-blue-500" /> },
};

export default function FeedbacksPage() {
  const router = useRouter();
  const { profile } = useDashboard();
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);

  useEffect(() => {
    if (profile === null) return;
    if (profile.role !== 'ROOT') {
      toast.error('You do not have access to this page');
      router.replace('/dashboard');
    }
  }, [profile, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.feedback.list();
      setFeedbacks(data);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load feedbacks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile?.role !== 'ROOT') return;
    load();
  }, [profile?.role, load]);

  async function handleStatusChange(id: string, status: string) {
    setUpdatingId(id);
    try {
      await api.feedback.updateStatus(id, status);
      setFeedbacks((prev) =>
        prev.map((f) => (f.id === id ? { ...f, status } : f)),
      );
      toast.success('Status updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    } finally {
      setUpdatingId(null);
    }
  }

  const filtered = filterStatus
    ? feedbacks.filter((f) => f.status === filterStatus)
    : feedbacks;

  const counts = feedbacks.reduce<Record<string, number>>((acc, f) => {
    acc[f.status] = (acc[f.status] || 0) + 1;
    return acc;
  }, {});

  if (profile === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile.role !== 'ROOT') {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Feedbacks</h1>
          <p className="text-sm text-muted-foreground">
            {feedbacks.length} total feedback{feedbacks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilterStatus(null)}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
            !filterStatus ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent'
          }`}
        >
          All ({feedbacks.length})
        </button>
        {STATUS_OPTIONS.map((s) => {
          const cfg = STATUS_CONFIG[s];
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(filterStatus === s ? null : s)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                filterStatus === s ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent'
              }`}
            >
              {cfg.icon}
              {cfg.label} ({counts[s] || 0})
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-muted-foreground">
          No feedbacks found.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((fb) => {
            const typeCfg = TYPE_CONFIG[fb.type] || TYPE_CONFIG.GENERAL;
            const statusCfg = STATUS_CONFIG[fb.status] || STATUS_CONFIG.OPEN;
            const attachments = parseAttachments(fb.attachments);

            return (
              <div
                key={fb.id}
                className="rounded-lg border bg-card p-4 transition-colors hover:bg-accent/30"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      {typeCfg.icon}
                      <h3 className="font-semibold">{fb.title}</h3>
                      <Badge
                        variant="outline"
                        className={`${statusCfg.color} flex items-center gap-1 border text-[11px]`}
                      >
                        {statusCfg.icon}
                        {statusCfg.label}
                      </Badge>
                    </div>

                    {fb.description && (
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                        {fb.description}
                      </p>
                    )}

                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {attachments.map((a, i) =>
                          a.kind === 'video' || a.mimeType?.startsWith('video/') ? (
                            <video
                              key={`${fb.id}-v-${i}`}
                              src={a.url}
                              controls
                              className="max-h-40 max-w-full rounded-md border bg-black/5"
                            />
                          ) : (
                            <a
                              key={`${fb.id}-i-${i}`}
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- MinIO public URLs */}
                              <img
                                src={a.url}
                                alt=""
                                className="max-h-40 max-w-[200px] rounded-md border object-cover"
                              />
                            </a>
                          ),
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        <strong>{fb.username}</strong> ({fb.email})
                      </span>
                      <span>·</span>
                      <span>{new Date(fb.createdAt).toLocaleString()}</span>
                      <span>·</span>
                      <a
                        href={fb.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 hover:text-primary"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Page
                      </a>
                    </div>
                  </div>

                  <div className="flex-shrink-0">
                    <select
                      value={fb.status}
                      onChange={(e) => handleStatusChange(fb.id, e.target.value)}
                      disabled={updatingId === fb.id}
                      className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_CONFIG[s].label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
