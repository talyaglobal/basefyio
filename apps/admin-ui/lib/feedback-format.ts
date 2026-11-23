/** Pure display helpers for the Feedbacks page. */

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  CLOSED: 'Closed',
};

/** Old product domain -> current one, so stored "Page" links keep working. */
export function currentPageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'kolaybase.com' || u.hostname.endsWith('.kolaybase.com')) {
      u.hostname = u.hostname.replace(/kolaybase\.com$/, 'basefyio.com');
      return u.toString();
    }
  } catch {
    /* relative or malformed: leave as stored */
  }
  return url;
}

/** Who sent it: the stored email, else the account's name or email, else nothing. */
export function feedbackAuthor(fb: {
  email?: string | null;
  user?: { email?: string | null; firstName?: string | null; lastName?: string | null } | null;
}): string {
  if (fb.email?.trim()) return fb.email.trim();
  const name = [fb.user?.firstName, fb.user?.lastName].filter(Boolean).join(' ').trim();
  return name || fb.user?.email?.trim() || '';
}

/** STATUS_CHANGED -> "Status changed". */
export function activityActionLabel(action: string): string {
  const text = action.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "OPEN → IN_PROGRESS" -> "Open → In progress"; other detail text is left alone. */
export function activityDetailLabel(detail: string): string {
  return detail.replace(/\b(OPEN|IN_PROGRESS|DONE|CLOSED)\b/g, (s) => STATUS_LABELS[s] ?? s);
}
