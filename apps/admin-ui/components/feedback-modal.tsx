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
import { AlertTriangle, ArrowLeft, Lightbulb, Loader2, Paperclip, X, Camera } from 'lucide-react';

type ModalStep = 'choose' | 'issue' | 'idea';

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_FILES = 5;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime';

export function FeedbackModal({ open, onOpenChange }: FeedbackModalProps) {
  const [step, setStep] = useState<ModalStep>('choose');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  useEffect(() => {
    fetch('/api/changelog/latest')
      .then((r) => r.json())
      .then((d) => { if (d.version) setAppVersion(d.version); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) {
      setStep('choose');
      setFiles([]);
      setPreviewIndex(null);
      setDescription('');
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
    const pastedFiles = clipboardItems
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (!pastedFiles.length) return;
    const added = addFilesFromArray(pastedFiles);
    if (added) e.preventDefault();
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

    // Hide the dialog overlay + content via CSS so html2canvas captures the
    // page behind it, but keep the Dialog *open* so React state is preserved.
    const portalEls = document.querySelectorAll<HTMLElement>('[data-radix-portal]');
    portalEls.forEach((el) => { el.style.visibility = 'hidden'; });

    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(document.documentElement, {
        useCORS: true, allowTaint: true, backgroundColor: null,
        scale: window.devicePixelRatio || 1,
        scrollX: window.scrollX, scrollY: window.scrollY,
        x: window.scrollX, y: window.scrollY,
        width: window.innerWidth, height: window.innerHeight,
        windowWidth: window.innerWidth, windowHeight: window.innerHeight,
      });
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png', 0.95);
      });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const file = new File([blob], `screenshot-${timestamp}.png`, { type: 'image/png' });
      setFiles((prev) => [...prev, file]);
      toast.success('Screenshot captured!');
    } catch {
      toast.error('Failed to capture screenshot');
    } finally {
      portalEls.forEach((el) => { el.style.visibility = ''; });
      setTakingScreenshot(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;

    setLoading(true);
    try {
      const attachments: { url: string; mimeType: string; kind: 'image' | 'video' }[] = [];
      for (const f of files) {
        attachments.push(await api.feedback.uploadAttachment(f));
      }

      const feedbackType = step === 'idea' ? 'FEATURE' : 'BUG';
      const titleLine = description.trim().split('\n')[0].slice(0, 120);

      await api.feedback.create({
        url: currentUrl,
        title: titleLine,
        description: description.trim(),
        type: feedbackType,
        attachments: attachments.length ? attachments : undefined,
        appVersion: appVersion || undefined,
      });
      toast.success(step === 'idea' ? 'Idea submitted — thank you!' : 'Issue reported — thank you!');
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send feedback');
    } finally {
      setLoading(false);
    }
  }

  const isIssue = step === 'issue';
  const formTitle = isIssue ? 'Report an Issue' : 'Share an Idea';
  const formDescription = isIssue
    ? `Describe the problem you encountered. You can attach up to ${MAX_FILES} images or short videos.`
    : `Suggest a feature or improvement for Kolaybase. You can attach up to ${MAX_FILES} images or short videos.`;
  const placeholder = isIssue
    ? 'Describe the issue you encountered...'
    : 'My idea for improving Kolaybase is...';
  const submitLabel = isIssue ? 'Send Report' : 'Send Idea';

  // ── Shared form for both Issue and Idea ──
  function renderForm() {
    return (
      <DialogContent className="sm:max-w-2xl max-h-[min(90dvh,720px)] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <button onClick={() => setStep('choose')} className="rounded p-1 hover:bg-accent">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <DialogTitle>{formTitle}</DialogTitle>
          </div>
          <DialogDescription>{formDescription}</DialogDescription>
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
              <Label htmlFor="fb-desc">
                Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="fb-desc"
                placeholder={placeholder}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                className="resize-y min-h-[120px]"
                required
                autoFocus
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
                    <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Capturing...</>
                  ) : (
                    <><Camera className="mr-1.5 h-3.5 w-3.5" />Take Screenshot</>
                  )}
                </Button>
                <span className="text-xs text-muted-foreground">{files.length}/{MAX_FILES}</span>
                <span className="text-xs text-muted-foreground">Tip: paste with Ctrl+V</span>
              </div>
              {files.length > 0 && (
                <ul className="flex flex-col gap-2 max-h-[140px] overflow-y-auto rounded-md border p-2">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setPreviewIndex(i)}
                        className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline"
                      >
                        {f.name}
                      </button>
                      <span className="shrink-0 text-muted-foreground">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        className="shrink-0 rounded p-0.5 hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !description.trim()}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {step === 'choose' && (
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>What would you like to share?</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <button
              onClick={() => setStep('issue')}
              className="flex flex-col items-center gap-2 rounded-xl border p-6 transition-colors hover:bg-accent hover:border-primary/30"
            >
              <AlertTriangle className="h-8 w-8 text-orange-500" />
              <span className="text-sm font-semibold">Issue</span>
              <span className="text-xs text-muted-foreground">with my project</span>
            </button>
            <button
              onClick={() => setStep('idea')}
              className="flex flex-col items-center gap-2 rounded-xl border p-6 transition-colors hover:bg-accent hover:border-primary/30"
            >
              <Lightbulb className="h-8 w-8 text-amber-400" />
              <span className="text-sm font-semibold">Idea</span>
              <span className="text-xs text-muted-foreground">to improve Kolaybase</span>
            </button>
          </div>
        </DialogContent>
      )}

      {(step === 'issue' || step === 'idea') && renderForm()}

      {/* Attachment preview */}
      <Dialog open={previewIndex !== null} onOpenChange={(next) => { if (!next) setPreviewIndex(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate">{previewFile?.name || 'Attachment preview'}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto rounded-md border bg-black/5 p-2">
            {previewFile && previewUrl && previewFile.type.startsWith('image/') ? (
              <img src={previewUrl} alt={previewFile.name} className="mx-auto h-auto max-h-[66vh] w-auto rounded" />
            ) : previewFile && previewUrl && previewFile.type.startsWith('video/') ? (
              <video src={previewUrl} controls className="mx-auto h-auto max-h-[66vh] w-full rounded bg-black" />
            ) : (
              <p className="text-sm text-muted-foreground">Preview is not available for this file type.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
