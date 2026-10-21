/**
 * Types shared by the realtime-data services. They live apart from the
 * service so the fan-out, policy and presence services can import them
 * without importing each other.
 */

export type DataChangeType = 'INSERT' | 'UPDATE' | 'DELETE';
export type RealtimeKind = 'table' | 'collection';

export interface DataChangeEvent {
  eventId: string;
  type: DataChangeType;
  kind: RealtimeKind;
  entity: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  commitTimestamp: string;
}

/** Postgres role a subscriber is evaluated as. Mirrors ApiKeyPayload.dbRole. */
export type SubscriberRole = 'anon' | 'authenticated' | 'service_role';

/** What the policy filter needs to know about a subscriber. */
export interface PolicySubscriber {
  id: string;
  role: SubscriberRole;
  jwtClaims?: Record<string, unknown>;
  /** Hash of (role, stable claims) — subscribers in one group share a policy verdict. */
  policyGroup: string;
}

/** Events a subscriber can receive besides the SSE `ready` and `ping` frames. */
export type FanoutKind = 'data_change' | 'broadcast' | 'presence';

/** One message on its way to subscribers, locally or through Redis. */
export interface FanoutMessage {
  v: 1;
  /** instanceId of the API process that published it. */
  origin: string;
  kind: FanoutKind;
  projectId: string;
  /** 'table:orders' | 'collection:posts' | 'broadcast:room-1' */
  channel: string;
  event: unknown;
  /** Subscription id that must not receive this message (a sender's own broadcast). */
  exclude?: string;
  /** Deliver to this subscription id only (a presence sync for the joiner). */
  only?: string;
}

export interface BroadcastEvent {
  eventId: string;
  channel: string;
  event: string;
  payload: unknown;
  sender: { role: SubscriberRole; sub?: string };
  sentAt: string;
}

export interface PresenceMember {
  key: string;
  meta?: Record<string, unknown>;
  lastSeen: number;
}

export interface PresenceEvent {
  type: 'join' | 'leave' | 'sync';
  channel: string;
  key?: string;
  meta?: Record<string, unknown>;
  members?: PresenceMember[];
  truncated?: boolean;
  at: string;
}
