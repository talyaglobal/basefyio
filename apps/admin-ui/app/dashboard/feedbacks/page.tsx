'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDashboard } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  Trash2,
  Pencil,
  Send,
  Paperclip,
  Image as ImageIcon,
  Video,
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
  const { profile } = useDashboard();
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [commentByFeedback, setCommentByFeedback] = useState<Record<string, string>>({});
  const [commentFiles, setCommentFiles] = useState<Record<string, File[]>>({});
  const [commentLoadingId, setCommentLoadingId] = useState<string | null>(null);

  const isRoot = profile?.role === 'ROOT';

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
    if (!profile) return;
    load();
  }, [profile, load]);

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Feedbacks</h1>
          <p className="text-sm text-muted-foreground">
            {isRoot
              ? `${feedbacks.length} total feedback${feedbacks.length !== 1 ? 's' : ''}`
              : `Track all your feedbacks and developer actions (${feedbacks.length})`}
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
            const comments = Array.isArray(fb.comments) ? fb.comments : [];
            const isOwner = profile?.id === fb.userId;
            const canManage = isRoot || isOwner;

            return (
              <div
                key={fb.id}
                className="rounded-lg border bg-card p-4 transition-colors hover:bg-accent/30"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-3">
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

                    {editingId === fb.id ? (
                      <div className="space-y-2">
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          placeholder="Title"
                        />
                        <Textarea
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          rows={3}
                          placeholder="Description"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                const updated = await api.feedback.update(fb.id, {
                                  title: editTitle.trim(),
                                  description: editDescription,
                                });
                                setFeedbacks((prev) =>
                                  prev.map((x) =>
                                    x.id === fb.id ? { ...x, title: updated.title, description: updated.description } : x,
                                  ),
                                );
                                setEditingId(null);
                                toast.success('Task updated');
                              } catch (err: any) {
                                toast.error(err.message || 'Failed to update');
                              }
                            }}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : fb.description && (
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
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                      <span className="font-medium text-foreground">Developer action:</span>{' '}
                      {fb.status === 'OPEN' && 'Waiting for review'}
                      {fb.status === 'IN_PROGRESS' && 'Developer is working on it'}
                      {fb.status === 'DONE' && 'Marked as completed'}
                      {fb.status === 'CLOSED' && 'Closed by developer'}
                    </div>

                    {comments.length > 0 && (
                      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground">Comments</p>
                        {comments.map((c) => {
                          const cAttachments = parseAttachments(c.attachments);
                          return (
                            <div key={c.id} className="space-y-1 rounded border bg-background p-2">
                              <div className="text-xs">
                                <strong>{c.username}</strong> · {new Date(c.createdAt).toLocaleString()}
                              </div>
                              <p className="text-sm">{c.comment}</p>
                              {cAttachments.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-1">
                                  {cAttachments.map((a, i) =>
                                    a.kind === 'video' || a.mimeType?.startsWith('video/') ? (
                                      <video key={`${c.id}-v-${i}`} src={a.url} controls className="max-h-32 rounded-md border" />
                                    ) : (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img key={`${c.id}-i-${i}`} src={a.url} alt="" className="max-h-32 rounded-md border object-cover" />
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {isRoot && (
                      <div className="space-y-2 rounded-md border p-3">
                        <Textarea
                          value={commentByFeedback[fb.id] || ''}
                          onChange={(e) =>
                            setCommentByFeedback((prev) => ({ ...prev, [fb.id]: e.target.value }))
                          }
                          rows={2}
                          placeholder="Write a comment for this task"
                        />
                        <div className="flex items-center gap-2">
                          <input
                            id={`comment-files-${fb.id}`}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              const list = Array.from(e.target.files || []).slice(0, 5);
                              setCommentFiles((prev) => ({ ...prev, [fb.id]: list }));
                              e.currentTarget.value = '';
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => document.getElementById(`comment-files-${fb.id}`)?.click()}
                          >
                            <Paperclip className="mr-1 h-3.5 w-3.5" />
                            Add media
                          </Button>
                          <Button
                            size="sm"
                            disabled={commentLoadingId === fb.id || !(commentByFeedback[fb.id] || '').trim()}
                            onClick={async () => {
                              setCommentLoadingId(fb.id);
                              try {
                                const files = commentFiles[fb.id] || [];
                                const attachments: { url: string; mimeType: string; kind: 'image' | 'video' }[] = [];
                                for (const file of files) {
                                  attachments.push(await api.feedback.uploadAttachment(file));
                                }
                                const comment = await api.feedback.addComment(fb.id, {
                                  comment: (commentByFeedback[fb.id] || '').trim(),
                                  attachments: attachments.length ? attachments : undefined,
                                });
                                setFeedbacks((prev) =>
                                  prev.map((x) =>
                                    x.id === fb.id
                                      ? { ...x, comments: [...(Array.isArray(x.comments) ? x.comments : []), comment] }
                                      : x,
                                  ),
                                );
                                setCommentByFeedback((prev) => ({ ...prev, [fb.id]: '' }));
                                setCommentFiles((prev) => ({ ...prev, [fb.id]: [] }));
                              } catch (err: any) {
                                toast.error(err.message || 'Failed to comment');
                              } finally {
                                setCommentLoadingId(null);
                              }
                            }}
                          >
                            <Send className="mr-1 h-3.5 w-3.5" />
                            Comment
                          </Button>
                          {(commentFiles[fb.id]?.length || 0) > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {(commentFiles[fb.id] || []).length} file(s) selected
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex-shrink-0">
                    <div className="flex flex-col gap-2">
                      {isRoot ? (
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
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updatingId === fb.id || fb.status === 'DONE' || !isOwner}
                          onClick={() => handleStatusChange(fb.id, 'DONE')}
                        >
                          Mark done
                        </Button>
                      )}
                      {canManage && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingId(fb.id);
                              setEditTitle(fb.title);
                              setEditDescription(fb.description || '');
                            }}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={async () => {
                              try {
                                await api.feedback.remove(fb.id);
                                setFeedbacks((prev) => prev.filter((x) => x.id !== fb.id));
                                toast.success('Task deleted');
                              } catch (err: any) {
                                toast.error(err.message || 'Delete failed');
                              }
                            }}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
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
