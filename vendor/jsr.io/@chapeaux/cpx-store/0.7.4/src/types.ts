/** Lifecycle hooks that a plugin can implement to intercept store operations. */
export interface StorePlugin {
  name: string;
  onInit?(store: any): void;
  onBeforeSet?(prop: string, value: unknown, oldValue: unknown): boolean | void;
  onAfterSet?(prop: string, value: unknown, oldValue: unknown): void;
  onGet?(prop: string): { handled: boolean; value?: unknown } | void;
  onFlush?(changes: Map<string, { old: unknown; val: unknown }>): void;
  onDestroy?(): void;
}

/** Controls how the history plugin records changes for a given property. */
export type HistoryStrategy = 'snapshot' | 'patch' | 'none';

/** A single entry in the undo/redo history stack. */
export interface HistoryEntry {
  prop: string;
  strategy: HistoryStrategy;
  old?: unknown;
  val?: unknown;
  forwardPatch?: unknown;
  reversePatch?: unknown;
  checkpointIndex?: number;
}

/** A middleware function with an optional filter for selective execution. */
export interface MiddlewareEntry {
  filter?: string | RegExp | ((prop: string) => boolean);
  fn: (prop: string, value: unknown, oldValue?: unknown) => void;
}

/** Transport abstraction for sending and receiving state operations between peers. */
export interface SyncTransport {
  send(op: StateOperation): void;
  onReceive(handler: (op: StateOperation) => void): void;
  connect(): Promise<void>;
  disconnect(): void;
}

/** A serializable record of a single state mutation, used by the collab plugin and transports. */
export interface StateOperation {
  id: string;
  origin: string;
  timestamp: number;
  prop: string;
  type: 'set' | 'patch';
  value?: unknown;
  patch?: unknown;
}
