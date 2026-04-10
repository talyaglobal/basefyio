'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Paperclip, X, Camera } from 'lucide-react';

type FeedbackType = 'BUG' | 'FEATURE' | 'GENERAL';

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TYPE_OPTIONS: { value: FeedbackType; label: string; icon: string }[] = [
  { value: 'BUG', label: 'Bug', icon: '🐛' },
  { value: 'FEATURE', label: 'Feature', icon: '💡' },
  { value: 'GENERAL', label: 'General', icon: '💬' },
];

const MAX_FILES = 5;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime';

export function FeedbackModal({ open, onOpenChange }: FeedbackModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FeedbackType>('GENERAL');
  const [loading, setLoading] = useState(false);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  useEffect(() => {
    if (!open) {
      setFiles([]);
      setPreviewIndex(null);
    }
  }, [open]);

  const previewFile = previewIndex !== null ? files[previewIndex] : null;
  const previewUrl = useMemo(() => {
    if (!previewFile) return null;
    return URL.createObjectURL(previewFile);
  }, [previewFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function addFilesFromList(list: FileList | null) {
    if (!list?.length) return;
    setFiles((prev) => {
      const next = [...prev];
      for (let i = 0; i < list.length; i++) {
        if (next.length >= MAX_FILES) break;
        const f = list[i];
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
          toast.error(`${f.name}: only images or videos`);
          continue;
        }
        next.push(f);
      }
      if (prev.length + list.length > MAX_FILES && next.length >= MAX_FILES) {
        toast.message(`At most ${MAX_FILES} files`);
      }
      return next;
    });
  }

  function addFilesFromArray(items: File[]) {
    if (!items.length) return false;
    let added = 0;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of items) {
        if (next.length >= MAX_FILES) break;
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue;
        next.push(f);
        added += 1;
      }
      return next;
    });
    if (added > 0) {
      toast.success(`${added} media pasted`);
      return true;
    }
    return false;
  }

  function handlePaste(e: React.ClipboardEvent) {
    const clipboardItems = Array.from(e.clipboardData?.items || []);
    if (!clipboardItems.length) return;
    const files = clipboardItems
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    const added = addFilesFromArray(files);
    if (added) {
      e.preventDefault();
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function takeScreenshot() {
    if (files.length >= MAX_FILES) {
      toast.error(`Maximum ${MAX_FILES} files allowed`);
      return;
    }

    setTakingScreenshot(true);
    
    // Temporarily close dialog to capture the page underneath
    onOpenChange(false);
    
    // Wait for dialog to close completely
    await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
        scale: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      });

      // Convert canvas to blob then to File
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png', 0.95);
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const file = new File([blob], `screenshot-${timestamp}.png`, { type: 'image/png' });

      setFiles((prev) => [...prev, file]);
      toast.success('Screenshot captured successfully!');
    } catch (err: any) {
      console.error('Screenshot error:', err);
      toast.error('Failed to capture screenshot');
    } finally {
      // Reopen dialog
      onOpenChange(true);
      setTakingScreenshot(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    try {
      const attachments: { url: string; mimeType: string; kind: 'image' | 'video' }[] = [];
      for (const f of files) {
        attachments.push(await api.feedback.uploadAttachment(f));
      }

      await api.feedback.create({
        url: currentUrl,
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        attachments: attachments.length ? attachments : undefined,
      });
      toast.success('Feedback sent successfully!');
      setTitle('');
      setDescription('');
      setType('GENERAL');
      setFiles([]);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send feedback');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[min(90dvh,720px)] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            Report a bug, request a feature, or share your thoughts. You can attach up to{' '}
            {MAX_FILES} images or short videos (images max 5 MB, videos max 20 MB each).
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2 shrink-0">
            <Label className="text-xs text-muted-foreground">Page</Label>
            <Input value={currentUrl} disabled className="text-xs opacity-70" />
          </div>

          <div className="space-y-2 shrink-0">
            <Label>Type</Label>
            <div className="flex flex-wrap gap-2">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setType(opt.value)}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    type === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input bg-background hover:bg-accent'
                  }`}
                >
                  <span>{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2 shrink-0">
            <Label htmlFor="fb-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="fb-title"
              placeholder="Brief summary of your feedback"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-2 shrink-0">
            <Label htmlFor="fb-desc">Description</Label>
            <Textarea
              id="fb-desc"
              placeholder="Add more details (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="resize-none min-h-[72px]"
            />
          </div>

          <div className="space-y-2 shrink-0">
            <Label>Attachments</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                addFilesFromList(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || files.length >= MAX_FILES || takingScreenshot}
              >
                <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                Add image or video
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={takeScreenshot}
                disabled={loading || files.length >= MAX_FILES || takingScreenshot}
              >
                {takingScreenshot ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Capturing...
                  </>
                ) : (
                  <>
                    <Camera className="mr-1.5 h-3.5 w-3.5" />
                    Take Screenshot
                  </>
                )}
              </Button>
              <span className="text-xs text-muted-foreground">
                {files.length}/{MAX_FILES}
              </span>
              <span className="text-xs text-muted-foreground">Tip: paste with Ctrl+V</span>
            </div>
            {files.length > 0 && (
              <ul className="flex flex-col gap-2 max-h-[140px] overflow-y-auto rounded-md border p-2">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setPreviewIndex(i)}
                      className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline"
                      title="Preview attachment"
                    >
                      {f.name}
                    </button>
                    <span className="shrink-0 text-muted-foreground">
                      {(f.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="shrink-0 rounded p-0.5 hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      aria-label="Remove file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>

          <DialogFooter className="shrink-0 border-t pt-3 mt-3 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !title.trim()}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                'Send Feedback'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <Dialog
        open={previewIndex !== null}
        onOpenChange={(next) => {
          if (!next) setPreviewIndex(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate">{previewFile?.name || 'Attachment preview'}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto rounded-md border bg-black/5 p-2">
            {previewFile && previewUrl && previewFile.type.startsWith('image/') ? (
              <img
                src={previewUrl}
                alt={previewFile.name}
                className="mx-auto h-auto max-h-[66vh] w-auto rounded"
              />
            ) : previewFile && previewUrl && previewFile.type.startsWith('video/') ? (
              <video
                src={previewUrl}
                controls
                className="mx-auto h-auto max-h-[66vh] w-full rounded bg-black"
              />
            ) : (
              <p className="text-sm text-muted-foreground">Preview is not available for this file type.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
