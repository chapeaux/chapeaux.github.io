/**
 * @module
 * Undo/redo plugin with configurable per-property history strategies (snapshot, patch, none).
 */
import type { StorePlugin, HistoryStrategy, HistoryEntry } from '../types.ts';
import { diffObjects, applyPatch, reversePatch as reverseObjectPatch } from '../utils/json-patch.ts';
import type { PatchOp } from '../utils/json-patch.ts';

/** Configuration for the history plugin. */
export interface HistoryOptions {
  maxHistory?: number;
  defaultStrategy?: HistoryStrategy;
  strategies?: Record<string, HistoryStrategy>;
  checkpointInterval?: number;
}

/** Creates a plugin that records state changes for undo/redo with configurable per-property strategies. */
export function historyPlugin(options: HistoryOptions = {}): StorePlugin {
  const maxHistory = options.maxHistory ?? 100;
  const defaultStrategy = options.defaultStrategy ?? 'snapshot';
  const strategies = new Map<string, HistoryStrategy>(
    Object.entries(options.strategies ?? {})
  );
  const checkpointInterval = options.checkpointInterval ?? 20;

  let history: HistoryEntry[] = [];
  let pointer = -1;
  let isInternalChange = false;
  let opsSinceCheckpoint = 0;
  let store: any;

  function getStrategy(prop: string): HistoryStrategy {
    return strategies.get(prop) ?? defaultStrategy;
  }

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isObjectPatch(patch: unknown): patch is PatchOp[] {
    return Array.isArray(patch) && patch.length > 0 && 'op' in patch[0];
  }

  function computeStringPatch(
    oldVal: string, newVal: string
  ): { offset: number; deleteCount: number; insert: string } {
    let start = 0;
    const minLen = Math.min(oldVal.length, newVal.length);
    while (start < minLen && oldVal[start] === newVal[start]) start++;

    let oldEnd = oldVal.length;
    let newEnd = newVal.length;
    while (oldEnd > start && newEnd > start && oldVal[oldEnd - 1] === newVal[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    return {
      offset: start,
      deleteCount: oldEnd - start,
      insert: newVal.slice(start, newEnd)
    };
  }

  function applyStringPatch(
    base: string,
    patch: { offset: number; deleteCount: number; insert: string }
  ): string {
    return base.slice(0, patch.offset) + patch.insert + base.slice(patch.offset + patch.deleteCount);
  }

  function reverseStringPatch(
    base: string,
    patch: { offset: number; deleteCount: number; insert: string }
  ): { offset: number; deleteCount: number; insert: string } {
    return {
      offset: patch.offset,
      deleteCount: patch.insert.length,
      insert: base.slice(patch.offset, patch.offset + patch.deleteCount)
    };
  }

  function doUndo() {
    if (pointer < 0) return;
    const entry = history[pointer];
    isInternalChange = true;

    if (entry.strategy === 'patch' && entry.reversePatch) {
      if (isObjectPatch(entry.reversePatch)) {
        const current = store.state[entry.prop] as Record<string, unknown>;
        store.state[entry.prop] = applyPatch(current, entry.reversePatch);
      } else {
        const current = store.state[entry.prop] as string;
        store.state[entry.prop] = applyStringPatch(current, entry.reversePatch as any);
      }
    } else {
      store.state[entry.prop] = entry.old;
    }

    isInternalChange = false;
    pointer--;
  }

  function doRedo() {
    if (pointer >= history.length - 1) return;
    pointer++;
    const entry = history[pointer];
    isInternalChange = true;

    if (entry.strategy === 'patch' && entry.forwardPatch) {
      if (isObjectPatch(entry.forwardPatch)) {
        const current = store.state[entry.prop] as Record<string, unknown>;
        store.state[entry.prop] = applyPatch(current, entry.forwardPatch);
      } else {
        const current = store.state[entry.prop] as string;
        store.state[entry.prop] = applyStringPatch(current, entry.forwardPatch as any);
      }
    } else {
      store.state[entry.prop] = entry.val;
    }

    isInternalChange = false;
  }

  return {
    name: 'history',

    onInit(s: any) {
      store = s;
      store.undo = doUndo;
      store.redo = doRedo;

      (store as any).historyStrategy = (prop: string, strategy: HistoryStrategy) => {
        strategies.set(prop, strategy);
      };
      (store as any).checkpoint = () => {
        opsSinceCheckpoint = 0;
      };
      (store as any).clearHistory = () => {
        history = [];
        pointer = -1;
        opsSinceCheckpoint = 0;
      };
    },

    onAfterSet(prop: string, value: unknown, oldValue: unknown) {
      if (isInternalChange) return;

      history = history.slice(0, pointer + 1);

      const strategy = getStrategy(prop);
      if (strategy === 'none') return;

      const entry: HistoryEntry = { prop, strategy };

      if (strategy === 'patch' && typeof oldValue === 'string' && typeof value === 'string') {
        const forward = computeStringPatch(oldValue, value);
        entry.forwardPatch = forward;
        entry.reversePatch = reverseStringPatch(oldValue, forward);
        opsSinceCheckpoint++;

        if (opsSinceCheckpoint >= checkpointInterval) {
          entry.old = oldValue;
          entry.val = value;
          opsSinceCheckpoint = 0;
        }
      } else if (strategy === 'patch' && isPlainObject(oldValue) && isPlainObject(value)) {
        const forward = diffObjects(oldValue, value);
        entry.forwardPatch = forward;
        entry.reversePatch = reverseObjectPatch(oldValue, forward);
        opsSinceCheckpoint++;

        if (opsSinceCheckpoint >= checkpointInterval) {
          entry.old = oldValue;
          entry.val = value;
          opsSinceCheckpoint = 0;
        }
      } else {
        entry.strategy = 'snapshot';
        entry.old = oldValue;
        entry.val = value;
      }

      history.push(entry);
      pointer++;

      if (maxHistory > 0 && history.length > maxHistory) {
        history.shift();
        pointer--;
      }
    }
  };
}
