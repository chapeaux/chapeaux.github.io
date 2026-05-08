import { ReactiveState } from '../reactivity.ts';

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    && Object.getPrototypeOf(val) === Object.prototype;
}

const proxyCache = new WeakMap<object, Map<string, object>>();

function getCachedProxy(target: object, path: string): object | undefined {
  return proxyCache.get(target)?.get(path);
}

function setCachedProxy(target: object, path: string, proxy: object) {
  let map = proxyCache.get(target);
  if (!map) {
    map = new Map();
    proxyCache.set(target, map);
  }
  map.set(path, proxy);
}

function ensureSignal(store: any, fullPath: string, value: unknown): ReactiveState<unknown> {
  let signal = store._signals.get(fullPath);
  if (!signal) {
    signal = new ReactiveState(value);
    store._signals.set(fullPath, signal);
  } else if (!Object.is(signal._value, value)) {
    signal._value = value;
  }
  return signal;
}

/** Creates a recursive Proxy for nested object access, routing mutations through the store's pipeline with dot-path keys. */
export function createNestedProxy(
  obj: Record<string, unknown>,
  parentPath: string,
  store: any
): Record<string, unknown> {
  const cached = getCachedProxy(obj, parentPath);
  if (cached) return cached as Record<string, unknown>;

  const proxy = new Proxy(obj, {
    get(_target, prop: string) {
      const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
      const rawValue = _target[prop];

      if (isPlainObject(rawValue)) {
        ensureSignal(store, fullPath, rawValue).get();
        return createNestedProxy(rawValue, fullPath, store);
      }

      const signal = ensureSignal(store, fullPath, rawValue);
      return signal.get();
    },

    set(_target, prop: string, value) {
      const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
      store._setProperty(fullPath, value);
      return true;
    }
  });

  setCachedProxy(obj, parentPath, proxy);
  return proxy as Record<string, unknown>;
}
