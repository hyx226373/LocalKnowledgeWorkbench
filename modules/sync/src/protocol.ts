import type { SyncProgress } from './types.ts';

export interface StartMessage {
  type: 'start';
  rootId: string;
  dbPath: string;
  localPath: string;
}

export interface CancelMessage {
  type: 'cancel';
}

export interface WhenIdleMessage {
  type: 'when-idle';
  id: number;
}

export type MainToWorker = StartMessage | CancelMessage | WhenIdleMessage;

export interface ProgressMessage {
  type: 'progress';
  progress: SyncProgress;
}

export interface IdleAckMessage {
  type: 'idle-ack';
  id: number;
  error?: string;
}

export interface FinishedMessage {
  type: 'finished';
  status: 'cancelled' | 'error';
  message?: string;
}

export type WorkerToMain = ProgressMessage | IdleAckMessage | FinishedMessage;
