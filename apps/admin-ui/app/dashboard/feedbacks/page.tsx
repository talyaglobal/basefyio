'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDashboard } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
const MAX_COMMENT_FILES = 5;

export default function FeedbacksPage() {
  const { profile } = useDashboard();
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [commentByFeedback, setCommentByFeedback] = useState<Record<string, string>>({});
  const [commentFiles, setCommentFiles] = useState<Record<string, File[]>>({});
  const [commentLoadingId, setCommentLoadingId] = useState<string | null>(null);
  const [replyToByFeedback, setReplyToByFeedback] = useState<Record<string, { id: string; username: string } | null>>({});
  const [preview, setPreview] = useState<{ url: string; isVideo: boolean } | null>(null);
  const [selectedFilesOpenByFeedback, setSelectedFilesOpenByFeedback] = useState<Record<string, boolean>>({});
  const [historyFeedbackId, setHistoryFeedbackId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<
    { id: string; username: string; action: string; detail?: string | null; createdAt: string }[]
  >([]);

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

  function appendCommentFiles(feedbackId: string, incoming: File[]) {
    if (!incoming.length) return 0;
    let added = 0;
    setCommentFiles((prev) => {
      const existing = prev[feedbackId] || [];
      const next = [...existing];
      for (const f of incoming) {
        if (next.length >= MAX_COMMENT_FILES) break;
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue;
        next.push(f);
        added += 1;
      }
      return { ...prev, [feedbackId]: next };
    });
    return added;
  }

  function handleCommentPaste(feedbackId: string, e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items || []);
    const pastedFiles = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (!pastedFiles.length) return;
    const added = appendCommentFiles(feedbackId, pastedFiles);
    if (added > 0) {
      toast.success(`${added} media pasted`);
      e.preventDefault();
    }
  }

  function removeCommentFile(feedbackId: string, fileIndex: number) {
    setCommentFiles((prev) => {
      const current = prev[feedbackId] || [];
      return {
        ...prev,
        [feedbackId]: current.filter((_, idx) => idx !== fileIndex),
      };
    });
  }

  async function openHistory(feedbackId: string) {
    setHistoryFeedbackId(feedbackId);
    setHistoryLoading(true);
    try {
      const items = await api.feedback.history(feedbackId);
      setHistoryItems(items);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load activity history');
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filtered = feedbacks.filter((f) => {
    if (filterStatus && f.status !== filterStatus) return false;
    if (!normalizedSearch) return true;
    const haystack = [
      f.title,
      f.description || '',
      f.username,
      f.email,
      f.url,
      f.status,
      f.type,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedSearch);
  });

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

      <div className="max-w-md">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search feedback title, description, user, email..."
        />
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
            const isDeleted = !!fb.deletedAt;
            const canManage = (isRoot || isOwner) && !isDeleted;
            const canComment = (isRoot || isOwner) && !isDeleted;
            const rootComments = comments.filter((c) => !c.parentCommentId);
            const commentById = comments.reduce<Record<string, (typeof comments)[number]>>((acc, c) => {
              acc[c.id] = c;
              return acc;
            }, {});
            const repliesByParent = comments.reduce<Record<string, typeof comments>>((acc, c) => {
              if (!c.parentCommentId) return acc;
              if (!acc[c.parentCommentId]) acc[c.parentCommentId] = [];
              acc[c.parentCommentId].push(c);
              return acc;
            }, {});
            const renderCommentNode = (node: (typeof comments)[number], depth: number) => {
              const nodeAttachments = parseAttachments(node.attachments);
              const nodeReplies = (repliesByParent[node.id] || []).sort(
                (a, b) =>
                  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
              );
              const indentClass =
                depth === 0 ? '' : 'mt-2 border-l pl-3';
              return (
                <div key={node.id} className={indentClass}>
                  <div className="space-y-1 rounded border bg-background p-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span>
                        <strong>{node.username}</strong> · {new Date(node.createdAt).toLocaleString()}
                      </span>
                      {canComment && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => {
                            setReplyToByFeedback((prev) => ({
                              ...prev,
                              [fb.id]: { id: node.id, username: node.username },
                            }));
                          }}
                        >
                          Reply
                        </Button>
                      )}
                    </div>
                    {node.parentCommentId && commentById[node.parentCommentId] && (
                      <p className="text-[11px] text-muted-foreground">
                        Reply to <strong>{commentById[node.parentCommentId].username}</strong>
                      </p>
                    )}
                    <p className="text-sm">{node.comment}</p>
                    {nodeAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {nodeAttachments.map((a, i) =>
                          a.kind === 'video' || a.mimeType?.startsWith('video/') ? (
                            <video
                              key={`${node.id}-v-${i}`}
                              src={a.url}
                              controls
                              onClick={() => setPreview({ url: a.url, isVideo: true })}
                              className="max-h-32 cursor-zoom-in rounded-md border"
                            />
                          ) : (
                            <button
                              key={`${node.id}-i-${i}`}
                              type="button"
                              onClick={() => setPreview({ url: a.url, isVideo: false })}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={a.url}
                                alt=""
                                className="max-h-32 cursor-zoom-in rounded-md border object-cover"
                              />
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                  {nodeReplies.length > 0 && (
                    <div className="space-y-2">
                      {nodeReplies.map((reply) => renderCommentNode(reply, depth + 1))}
                    </div>
                  )}
                </div>
              );
            };

            return (
              <div
                key={fb.id}
                id={`feedback-${fb.id}`}
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
                      {isDeleted && (
                        <Badge variant="outline" className="border-red-300 bg-red-50 text-red-700 text-[11px]">
                          Deleted
                        </Badge>
                      )}
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
                              onClick={() => setPreview({ url: a.url, isVideo: true })}
                              className="max-h-40 max-w-full cursor-zoom-in rounded-md border bg-black/5"
                            />
                          ) : (
                            <button
                              type="button"
                              key={`${fb.id}-i-${i}`}
                              onClick={() => setPreview({ url: a.url, isVideo: false })}
                              className="block"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- MinIO public URLs */}
                              <img
                                src={a.url}
                                alt=""
                                className="max-h-40 max-w-[200px] cursor-zoom-in rounded-md border object-cover"
                              />
                            </button>
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
                    <button
                      type="button"
                      onClick={() => openHistory(fb.id)}
                      className="w-full rounded-md border bg-muted/30 px-3 py-2 text-left text-xs hover:bg-muted/50"
                    >
                      <span className="font-medium text-foreground">Developer action:</span>{' '}
                      {isDeleted
                        ? 'Deleted by user'
                        : fb.status === 'OPEN'
                          ? 'Waiting for review'
                          : fb.status === 'IN_PROGRESS'
                            ? 'Developer is working on it'
                            : fb.status === 'DONE'
                              ? 'Marked as completed'
                              : 'Closed by developer'}
                    </button>

                    {comments.length > 0 && (
                      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground">Comments</p>
                        {rootComments
                          .sort(
                            (a, b) =>
                              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
                          )
                          .map((c) => renderCommentNode(c, 0))}
                      </div>
                    )}

                    {canComment && (
                      <div className="space-y-2 rounded-md border p-3">
                        {replyToByFeedback[fb.id] && (
                          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1 text-xs">
                            <span>
                              Replying to <strong>{replyToByFeedback[fb.id]?.username}</strong>
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              onClick={() =>
                                setReplyToByFeedback((prev) => ({
                                  ...prev,
                                  [fb.id]: null,
                                }))
                              }
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                        <Textarea
                          value={commentByFeedback[fb.id] || ''}
                          onChange={(e) =>
                            setCommentByFeedback((prev) => ({ ...prev, [fb.id]: e.target.value }))
                          }
                          onPaste={(e) => handleCommentPaste(fb.id, e)}
                          rows={2}
                          placeholder="Write a comment for this task (you can paste screenshot with Ctrl+V)"
                        />
                        <div className="flex items-center gap-2">
                          <input
                            id={`comment-files-${fb.id}`}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              const list = Array.from(e.target.files || []);
                              appendCommentFiles(fb.id, list);
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
                                  parentCommentId: replyToByFeedback[fb.id]?.id || undefined,
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
                                setSelectedFilesOpenByFeedback((prev) => ({ ...prev, [fb.id]: false }));
                                setReplyToByFeedback((prev) => ({ ...prev, [fb.id]: null }));
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
                            <button
                              type="button"
                              className="text-xs text-primary underline-offset-2 hover:underline"
                              onClick={() =>
                                setSelectedFilesOpenByFeedback((prev) => ({
                                  ...prev,
                                  [fb.id]: !prev[fb.id],
                                }))
                              }
                            >
                              {(commentFiles[fb.id] || []).length} file(s) selected
                            </button>
                          )}
                        </div>
                        {selectedFilesOpenByFeedback[fb.id] && (commentFiles[fb.id] || []).length > 0 && (
                          <div className="space-y-1 rounded-md border bg-muted/20 p-2">
                            {(commentFiles[fb.id] || []).map((file, index) => (
                              <div
                                key={`${fb.id}-${file.name}-${index}`}
                                className="flex items-center gap-2 rounded bg-background px-2 py-1.5 text-xs"
                              >
                                <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
                                <span className="shrink-0 text-muted-foreground">
                                  {(file.size / 1024 / 1024).toFixed(1)} MB
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                                  onClick={() => removeCommentFile(fb.id, index)}
                                >
                                  Remove
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
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
                          disabled={updatingId === fb.id || fb.status === 'CLOSED' || !isOwner}
                          onClick={() =>
                            handleStatusChange(
                              fb.id,
                              fb.status === 'DONE' ? 'CLOSED' : 'DONE',
                            )
                          }
                        >
                          {fb.status === 'DONE' ? 'Close Ticket' : 'Mark done'}
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
                              if (!window.confirm('Are you sure you want to delete this feedback?')) {
                                return;
                              }
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

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[90vh] w-[95vw] max-w-5xl p-2 sm:p-3">
          <DialogTitle className="sr-only">Attachment preview</DialogTitle>
          {preview?.isVideo ? (
            <video
              src={preview.url}
              controls
              autoPlay
              className="mx-auto max-h-[82vh] w-full rounded-md bg-black"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview?.url}
              alt="Attachment preview"
              className="mx-auto max-h-[82vh] w-auto max-w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyFeedbackId} onOpenChange={(open) => !open && setHistoryFeedbackId(null)}>
        <DialogContent className="max-h-[85vh] w-[95vw] max-w-2xl">
          <DialogTitle>Feedback activity history</DialogTitle>
          {historyLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : historyItems.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No activity yet.</div>
          ) : (
            <div className="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
              {historyItems.map((item) => (
                <div key={item.id} className="rounded-md border bg-muted/20 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold">{item.username}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium">{item.action.replaceAll('_', ' ')}</p>
                  {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
