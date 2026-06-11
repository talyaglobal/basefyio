import { OperationEventResponse } from './operation-event-response';

export interface OperationEventsPage {
  events: OperationEventResponse[];
  nextCursor: string | null;
}
