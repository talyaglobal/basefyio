// Mirrors the limits of POST /feedback/attachments (storage.service uploadFeedbackAttachment).
export const MAX_FEEDBACK_FILES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/** Returns why the file cannot be attached, or null when it can. */
export function feedbackFileProblem(file: File): string | null {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return `${file.name}: only images or videos`;
  if (isImage && file.size > MAX_IMAGE_BYTES) return `${file.name}: images can be at most 5 MB`;
  if (isVideo && file.size > MAX_VIDEO_BYTES) return `${file.name}: videos can be at most 20 MB`;
  return null;
}

export type FeedbackAttachmentRef = { url: string; mimeType: string; kind: 'image' | 'video' };

const uploaded = new WeakMap<File, FeedbackAttachmentRef>();

/** Uploads each file once: a retry after a failed submit reuses the files already stored. */
export async function uploadFeedbackFiles(
  files: File[],
  upload: (file: File) => Promise<FeedbackAttachmentRef>,
  onProgress?: (done: number, total: number) => void,
): Promise<FeedbackAttachmentRef[]> {
  const out: FeedbackAttachmentRef[] = [];
  for (const f of files) {
    onProgress?.(out.length, files.length);
    let ref = uploaded.get(f);
    if (!ref) {
      try {
        ref = await upload(f);
      } catch (err: any) {
        throw new Error(`${f.name}: ${err?.message || 'upload failed'}`);
      }
      uploaded.set(f, ref);
    }
    out.push(ref);
  }
  return out;
}
