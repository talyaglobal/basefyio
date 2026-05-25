export type RealtimeEntityType =
  | 'feedback'
  | 'feedback_comment'
  | 'team'
  | 'team_invite'
  | 'team_member'
  | 'project'
  | 'project_activity'
  | 'billing';

export interface RealtimeEventEnvelope {
  eventId: string;
  traceId: string;
  emittedAt: string;
  feature: 'realtime_phase1';
  entityType: RealtimeEntityType;
  action: string;
  entityId: string;
  actorUserId?: string;
  teamId?: string;
  projectId?: string;
  userIds?: string[];
  payload?: Record<string, unknown>;
}

