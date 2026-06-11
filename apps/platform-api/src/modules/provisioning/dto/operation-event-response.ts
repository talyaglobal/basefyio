export interface OperationEventResponse {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
