/**
 * @module
 * Collaboration plugin with pluggable transports, operation logging, and conflict resolution.
 */
import type { StorePlugin, SyncTransport, StateOperation } from '../types.ts';

/** Determines which operation wins when local and remote mutations conflict on the same property. */
export interface ConflictResolver {
  resolve(local: StateOperation, remote: StateOperation): StateOperation;
}

/** Configuration for the collaboration plugin. */
export interface CollabOptions {
  transport: SyncTransport;
  clientId?: string;
  resolver?: ConflictResolver;
}

/** Default conflict resolver: last-writer-wins by timestamp. */
class LastWriterWinsResolver implements ConflictResolver {
  resolve(local: StateOperation, remote: StateOperation): StateOperation {
    return remote.timestamp >= local.timestamp ? remote : local;
  }
}

/** Creates a plugin that broadcasts local mutations and applies remote operations via a pluggable transport. */
export function collabPlugin(options: CollabOptions): StorePlugin {
  const transport = options.transport;
  const clientId = options.clientId ?? crypto.randomUUID();
  const resolver: ConflictResolver = options.resolver ?? new LastWriterWinsResolver();

  let store: any;
  const operationLog: StateOperation[] = [];

  // Track the latest local op per prop for conflict resolution
  const latestLocalOps = new Map<string, StateOperation>();

  function handleReceive(op: StateOperation): void {
    // Skip our own operations (echo prevention)
    if (op.origin === clientId) return;

    // Check for conflict: do we have a local op for the same prop?
    const localOp = latestLocalOps.get(op.prop);
    let opToApply = op;

    if (localOp) {
      opToApply = resolver.resolve(localOp, op);
      // If the resolver chose the local op, don't apply the remote one
      if (opToApply === localOp) return;
    }

    // Apply via store.sync() which sets _isSyncing = true
    store.sync({ [opToApply.prop]: opToApply.value });

    // Log the received operation
    operationLog.push(op);
  }

  return {
    name: 'collab',

    onInit(s: any) {
      store = s;

      // Register receive handler before connecting
      transport.onReceive(handleReceive);

      // Connect the transport (fire-and-forget; connect is async)
      transport.connect();

      // Expose methods on the store instance
      (store as any).getOperationLog = () => [...operationLog];

      (store as any).connect = (newTransport: SyncTransport, opts?: Partial<CollabOptions>) => {
        // Disconnect existing transport
        transport.disconnect();

        // The new transport setup would require a new plugin instance;
        // for simplicity, expose reconnect on the same transport
        newTransport.onReceive(handleReceive);
        return newTransport.connect();
      };

      (store as any).disconnect = () => {
        transport.disconnect();
      };
    },

    onAfterSet(prop: string, value: unknown, _oldValue: unknown) {
      // Only broadcast local mutations (not synced/remote ones)
      if (store._isSyncing) return;

      const op: StateOperation = {
        id: crypto.randomUUID(),
        origin: clientId,
        timestamp: Date.now(),
        prop,
        type: 'set',
        value,
      };

      operationLog.push(op);
      latestLocalOps.set(prop, op);
      transport.send(op);
    },

    onDestroy() {
      transport.disconnect();
    },
  };
}
