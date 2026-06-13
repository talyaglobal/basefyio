import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface RunCompletedEvent {
  runId: string;
  agentId: string;
  projectId: string;
  finalContent: string | null;
  stepCount: number;
  latencyMs: number;
}

export interface RunFailedEvent {
  runId: string;
  agentId: string;
  projectId: string;
  error: string;
  stepCount: number;
  latencyMs: number;
}

@Injectable()
export class AgentRunEventBus extends EventEmitter {
  emitCompleted(event: RunCompletedEvent): void {
    this.emit('run.completed', event);
  }

  emitFailed(event: RunFailedEvent): void {
    this.emit('run.failed', event);
  }

  onCompleted(handler: (event: RunCompletedEvent) => void): this {
    return this.on('run.completed', handler);
  }

  onFailed(handler: (event: RunFailedEvent) => void): this {
    return this.on('run.failed', handler);
  }
}
