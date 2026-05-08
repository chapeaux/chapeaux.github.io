/**
 * @module
 * Filterable middleware plugin that runs functions before each state mutation.
 */
import type { StorePlugin, MiddlewareEntry } from '../types.ts';

/** Creates a plugin that runs middleware functions before each state mutation. Middleware can throw to cancel. */
export function middlewarePlugin(
  entries: (MiddlewareEntry | MiddlewareEntry['fn'])[]
): StorePlugin {
  const middleware: MiddlewareEntry[] = entries.map(e =>
    typeof e === 'function' ? { fn: e } : e
  );

  function matches(filter: MiddlewareEntry['filter'], prop: string): boolean {
    if (!filter) return true;
    if (typeof filter === 'string') return prop === filter || prop.startsWith(filter + '.');
    if (filter instanceof RegExp) return filter.test(prop);
    return filter(prop);
  }

  return {
    name: 'middleware',
    onBeforeSet(prop: string, value: unknown, oldValue: unknown) {
      for (const entry of middleware) {
        if (matches(entry.filter, prop)) {
          entry.fn(prop, value, oldValue);
        }
      }
    }
  };
}
