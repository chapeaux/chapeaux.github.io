let activeTracking: Set<Trackable> | null = null;

interface Trackable {
  _subscribers: Set<ReactiveComputed<unknown>>;
}

/** A mutable reactive value that notifies subscribing computed values when it changes. */
export class ReactiveState<T> implements Trackable {
  _value: T;
  _subscribers: Set<ReactiveComputed<unknown>> = new Set();

  constructor(value: T) {
    this._value = value;
  }

  get(): T {
    if (activeTracking) activeTracking.add(this);
    return this._value;
  }

  set(value: T) {
    if (Object.is(this._value, value)) return;
    this._value = value;
    for (const sub of this._subscribers) {
      sub._markDirty();
    }
  }
}

/** A derived reactive value that auto-tracks dependencies during evaluation and caches until invalidated. */
export class ReactiveComputed<T> implements Trackable {
  _fn: () => T;
  _cache: T | undefined;
  _dirty = true;
  _deps: Set<Trackable> = new Set();
  _subscribers: Set<ReactiveComputed<unknown>> = new Set();

  constructor(fn: () => T) {
    this._fn = fn;
  }

  _markDirty() {
    if (this._dirty) return;
    this._dirty = true;
    for (const sub of this._subscribers) {
      sub._markDirty();
    }
  }

  _retrack() {
    for (const dep of this._deps) {
      dep._subscribers.delete(this as ReactiveComputed<unknown>);
    }
    this._deps.clear();

    const prev = activeTracking;
    activeTracking = new Set();
    this._cache = this._fn();
    this._deps = activeTracking;
    activeTracking = prev;

    for (const dep of this._deps) {
      dep._subscribers.add(this as ReactiveComputed<unknown>);
    }
    this._dirty = false;
  }

  get(): T {
    if (activeTracking) activeTracking.add(this);
    if (this._dirty) this._retrack();
    return this._cache as T;
  }
}

/** Executes a function without tracking any signal reads as dependencies. */
export function untrack<T>(fn: () => T): T {
  const prev = activeTracking;
  activeTracking = null;
  const result = fn();
  activeTracking = prev;
  return result;
}
