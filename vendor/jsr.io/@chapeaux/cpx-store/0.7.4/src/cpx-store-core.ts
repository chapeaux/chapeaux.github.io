/**
 * @module
 * Headless store core that runs in any JavaScript runtime.
 * Provides CPXStoreCoreMixin for custom base classes and CPXStoreCore for direct use.
 */
import { ReactiveState, ReactiveComputed } from './reactivity.ts';
import { createNestedProxy } from './utils/nested-proxy.ts';
import type { StorePlugin } from './types.ts';

type Constructor = new (...args: any[]) => any;

/** The full interface provided by the store core mixin, implemented by both CPXStoreCore and CPXStore. */
export interface CPXStoreBase {
  _state: Record<string, unknown>;
  _signals: Map<string, ReactiveState<unknown>>;
  _computedSignals: Map<string, ReactiveComputed<unknown>>;
  _plugins: StorePlugin[];
  _pendingChanges: Map<string, { old: unknown; val: unknown }>;
  _changeHandlers: Set<(changes: Map<string, { old: unknown; val: unknown }>) => void>;
  _flushScheduled: boolean;
  _batchDepth: number;
  _isSyncing: boolean;
  _initialized: boolean;
  state: Record<string, unknown>;
  _setup(initialState?: Record<string, unknown>, plugins?: StorePlugin[]): void;
  _resolveNestedPath(path: string): { parent: Record<string, unknown>; key: string } | undefined;
  _setProperty(prop: string, value: unknown): void;
  _init(): void;
  _destroy(): void;
  use(plugin: StorePlugin): this;
  computed(name: string, fn: () => unknown): void;
  onChange(handler: (changes: Map<string, { old: unknown; val: unknown }>) => void): () => void;
  _emitChanges(changes: Map<string, { old: unknown; val: unknown }>): void;
  _scheduleFlush(): void;
  _flush(): void;
  batch(fn: () => void): void;
  transaction(fn: () => void): void;
  dispatch(action: (state: Record<string, unknown>) => Promise<void>): Promise<void>;
  sync(incoming: Record<string, unknown>): void;
  onSyncReceived(newState: Record<string, unknown>, oldState: Record<string, unknown>): void;
  undo(): void;
  redo(): void;
  toJSON(): Record<string, unknown>;
}

/** Injects all store state management logic into a base class. Apply to `HTMLElement` for a Web Component or to a bare class for headless use. */
export function CPXStoreCoreMixin<T extends Constructor>(Base: T): T & (new (...args: any[]) => CPXStoreBase) {
  return class StoreBase extends Base {
    _state!: Record<string, unknown>;
    _signals!: Map<string, ReactiveState<unknown>>;
    _computedSignals!: Map<string, ReactiveComputed<unknown>>;
    _plugins!: StorePlugin[];
    _pendingChanges!: Map<string, { old: unknown; val: unknown }>;
    _changeHandlers!: Set<(changes: Map<string, { old: unknown; val: unknown }>) => void>;
    _flushScheduled!: boolean;
    _batchDepth!: number;
    _isSyncing!: boolean;
    _initialized!: boolean;
    state!: Record<string, unknown>;

    constructor(...args: any[]) {
      super(...args);
    }

    _setup(initialState: Record<string, unknown> = {}, plugins: StorePlugin[] = []) {
      this._state = { ...initialState };
      this._signals = new Map();
      this._computedSignals = new Map();
      this._plugins = [];
      this._pendingChanges = new Map();
      this._changeHandlers = new Set();
      this._flushScheduled = false;
      this._batchDepth = 0;
      this._isSyncing = false;
      this._initialized = false;

      for (const [key, value] of Object.entries(initialState)) {
        this._signals.set(key, new ReactiveState(value));
      }

      for (const plugin of plugins) {
        this.use(plugin);
      }
    }

    _resolveNestedPath(path: string): { parent: Record<string, unknown>; key: string } | undefined {
      const parts = path.split('.');
      let current: unknown = this._state;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!_isPlainObject(current)) return undefined;
        current = (current as Record<string, unknown>)[parts[i]];
      }
      if (!_isPlainObject(current)) return undefined;
      return { parent: current as Record<string, unknown>, key: parts[parts.length - 1] };
    }

    _setProperty(prop: string, value: unknown) {
      if (this._computedSignals.has(prop)) return;

      const isNested = prop.includes('.');
      let oldValue: unknown;

      if (isNested) {
        const resolved = this._resolveNestedPath(prop);
        if (!resolved) return;
        oldValue = resolved.parent[resolved.key];
      } else {
        oldValue = this._state[prop];
      }

      if (Object.is(oldValue, value)) return;

      for (const plugin of this._plugins) {
        if (plugin.onBeforeSet) {
          if (plugin.onBeforeSet(prop, value, oldValue) === false) return;
        }
      }

      if (isNested) {
        const resolved = this._resolveNestedPath(prop);
        if (resolved) resolved.parent[resolved.key] = value;
      } else {
        this._state[prop] = value;
      }

      const signal = this._signals.get(prop);
      if (signal) {
        signal.set(value);
      } else {
        this._signals.set(prop, new ReactiveState(value));
      }

      if (!this._pendingChanges.has(prop)) {
        this._pendingChanges.set(prop, { old: oldValue, val: value });
      } else {
        this._pendingChanges.get(prop)!.val = value;
      }

      for (const plugin of this._plugins) {
        if (plugin.onAfterSet) plugin.onAfterSet(prop, value, oldValue);
      }

      this._scheduleFlush();
    }

    _init() {
      if (this._initialized) return;
      this._initialized = true;

      for (const plugin of this._plugins) {
        if (plugin.onInit) plugin.onInit(this);
      }

      const self = this;
      this.state = new Proxy(this._state, {
        get: (_target, prop: string) => {
          const computed = self._computedSignals.get(prop);
          if (computed) return computed.get();

          for (const plugin of self._plugins) {
            if (plugin.onGet) {
              const result = plugin.onGet(prop);
              if (result && result.handled) return result.value;
            }
          }

          const signal = self._signals.get(prop);
          const value = signal ? signal.get() : _target[prop];

          if (_isPlainObject(value)) {
            return createNestedProxy(value as Record<string, unknown>, prop, self);
          }
          return value;
        },

        set: (_target, prop: string, value) => {
          self._setProperty(prop, value);
          return true;
        },

        deleteProperty: (_target, prop: string) => {
          if (prop in _target) {
            const oldValue = _target[prop];
            delete _target[prop];
            self._signals.delete(prop);
            self._pendingChanges.set(prop, { old: oldValue, val: undefined });
            self._scheduleFlush();
          }
          return true;
        },

        has: (_target, prop: string) => {
          return self._computedSignals.has(prop) || prop in _target;
        },

        ownKeys: (_target) => {
          return [...Object.keys(_target), ...self._computedSignals.keys()];
        },

        getOwnPropertyDescriptor: (_target, prop: string) => {
          if (self._computedSignals.has(prop)) {
            return { configurable: true, enumerable: true, value: self._computedSignals.get(prop)!.get() };
          }
          return Object.getOwnPropertyDescriptor(_target, prop);
        }
      });
    }

    _destroy() {
      for (const plugin of this._plugins) {
        if (plugin.onDestroy) plugin.onDestroy();
      }
      this._changeHandlers.clear();
    }

    use(plugin: StorePlugin): this {
      this._plugins.push(plugin);
      return this;
    }

    computed(name: string, fn: () => unknown) {
      this._computedSignals.set(name, new ReactiveComputed(fn));
    }

    onChange(handler: (changes: Map<string, { old: unknown; val: unknown }>) => void): () => void {
      this._changeHandlers.add(handler);
      return () => { this._changeHandlers.delete(handler); };
    }

    _emitChanges(changes: Map<string, { old: unknown; val: unknown }>) {
      for (const handler of this._changeHandlers) {
        handler(changes);
      }
    }

    _scheduleFlush() {
      if (this._batchDepth > 0) return;
      if (this._flushScheduled) return;
      this._flushScheduled = true;
      queueMicrotask(() => this._flush());
    }

    _flush() {
      this._flushScheduled = false;
      if (this._pendingChanges.size === 0) return;

      const changes = new Map<string, { old: unknown; val: unknown }>();
      for (const [prop, change] of this._pendingChanges) {
        if (!Object.is(change.old, change.val)) changes.set(prop, change);
      }
      this._pendingChanges.clear();

      if (changes.size === 0) return;

      for (const plugin of this._plugins) {
        if (plugin.onFlush) plugin.onFlush(changes);
      }

      this._emitChanges(changes);
    }

    batch(fn: () => void) {
      this._batchDepth++;
      try {
        fn();
      } finally {
        this._batchDepth--;
        if (this._batchDepth === 0) this._flush();
      }
    }

    transaction(fn: () => void) {
      const snapshot = { ...this._state };
      const signalSnapshot = new Map<string, unknown>();
      for (const [k, s] of this._signals) signalSnapshot.set(k, s._value);

      this._batchDepth++;
      try {
        fn();
        this._batchDepth--;
        if (this._batchDepth === 0) this._flush();
      } catch (e) {
        this._batchDepth--;
        Object.keys(this._state).forEach(k => delete this._state[k]);
        Object.assign(this._state, snapshot);
        for (const [k, val] of signalSnapshot) {
          const s = this._signals.get(k);
          if (s) s._value = val;
        }
        this._pendingChanges.clear();
        throw e;
      }
    }

    async dispatch(action: (state: Record<string, unknown>) => Promise<void>) {
      this._batchDepth++;
      try {
        await action(this.state);
        this._batchDepth--;
        if (this._batchDepth === 0) this._flush();
      } catch (error) {
        this._batchDepth--;
        if (this._batchDepth === 0) this._flush();
        throw error;
      }
    }

    sync(incoming: Record<string, unknown>) {
      this._isSyncing = true;
      const oldState = { ...this._state };
      this.batch(() => {
        for (const [key, value] of Object.entries(incoming)) {
          this.state[key] = value;
        }
      });
      this._isSyncing = false;
      this.onSyncReceived({ ...this._state }, oldState);
    }

    onSyncReceived(
      _newState: Record<string, unknown>,
      _oldState: Record<string, unknown>
    ) {}

    undo() {}
    redo() {}

    toJSON(): Record<string, unknown> {
      return { ...this._state };
    }
  };
}

function _isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    && Object.getPrototypeOf(val) === Object.prototype;
}

const CPXHeadlessBase: new (...args: any[]) => CPXStoreBase = CPXStoreCoreMixin(class {});

/** Headless store that runs in any JavaScript runtime without a DOM. Initializes immediately in the constructor. */
export class CPXStoreCore extends CPXHeadlessBase {
  constructor(initialState: Record<string, unknown> = {}, ...plugins: StorePlugin[]) {
    super();
    this._setup(initialState, plugins);
    this._init();
  }
}

export type { StorePlugin } from './types.ts';
