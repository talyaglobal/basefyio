export type RealtimeEntityType =
  | 'feedback'
  | 'feedback_comment'
  | 'team'
  | 'team_invite'
  | 'team_member'
  | 'project'
  | 'project_activity';

export type RealtimeAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'status_changed'
  | 'comment_added'
  | 'invite_sent'
  | 'invite_accepted'
  | 'invite_declined'
  | 'member_removed'
  | 'moved'
  | 'activity_appended';

export interface RealtimeEventEnvelope {
  eventId: string;
  traceId: string;
  emittedAt: string;
  feature: 'realtime_phase1';
  entityType: RealtimeEntityType;
  action: RealtimeAction;
  entityId: string;
  actorUserId?: string;
  teamId?: string;
  projectId?: string;
  userIds?: string[];
  payload?: Record<string, unknown>;
}

