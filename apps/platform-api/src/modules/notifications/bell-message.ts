import { RealtimeEventEnvelope } from '../../common/realtime/realtime-events.types';

export interface BellMessage {
  type: 'feedback';
  title: string;
  message: string;
  href: string;
}

/** The bell text for a realtime event, or null when the event is not a bell notification. */
export function bellMessage(e: RealtimeEventEnvelope): BellMessage | null {
  const p = e.payload ?? {};
  const str = (k: string, fallback: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : fallback);
  const actor = str('actorName', 'Someone');
  const fb = `/dashboard/feedbacks#feedback-${e.entityId}`;
  const make = (title: string, message: string, href: string): BellMessage => ({ type: 'feedback', title, message, href });

  if (e.entityType === 'feedback') {
    const title = str('title', 'a feedback');
    switch (e.action) {
      case 'created': {
        const email = typeof p.actorEmail === 'string' ? ` (${p.actorEmail})` : '';
        return make('New feedback submitted', `${actor}${email} submitted "${str('title', 'a new feedback')}".`, fb);
      }
      case 'status_changed': {
        const to = typeof p.to === 'string' ? p.to.replace('_', ' ').toLowerCase() : 'updated';
        return make('Feedback status updated', `${actor} marked "${title}" as ${to}.`, fb);
      }
      case 'updated':
        return make('Feedback updated', `${actor} updated "${title}".`, fb);
      case 'reporter_notified':
        return make('Update on your feedback', `"${str('title', 'your feedback')}": ${str('summary', 'It was updated.')}`, fb);
      case 'deleted':
        return make('Feedback deleted', `${actor} deleted "${title}".`, '/dashboard/feedbacks');
    }
  }
  if (e.entityType === 'feedback_comment' && e.action === 'comment_added') {
    const title = str('feedbackTitle', 'a feedback');
    const preview = typeof p.commentPreview === 'string' ? p.commentPreview : null;
    return make(
      'New feedback comment',
      preview ? `${actor} on "${title}": ${preview}` : `${actor} commented on "${title}".`,
      p.feedbackId ? `/dashboard/feedbacks#feedback-${String(p.feedbackId)}` : '/dashboard/feedbacks',
    );
  }
  if (e.entityType === 'project') {
    const name = str('name', 'a project');
    const page = `/dashboard/projects/${e.entityId}`;
    switch (e.action) {
      case 'created':
        return make('New project created', `${actor} created "${name}".`, page);
      case 'updated': {
        const changes = Array.isArray(p.changes) ? (p.changes as string[]).join(', ') : null;
        return make('Project updated', changes ? `${actor} updated "${name}" (${changes}).` : `${actor} updated "${name}".`, page);
      }
      case 'deleted':
        return make('Project deleted', `${actor} moved "${name}" to trash.`, '/dashboard/projects');
      case 'restored':
        return make('Project restored', `${actor} restored "${name}".`, page);
    }
  }
  return null;
}
