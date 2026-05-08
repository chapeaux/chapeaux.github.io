/**
 * @module
 * localStorage persistence plugin with cross-tab synchronization via storage events.
 */
import type { StorePlugin } from '../types.ts';

/** Configuration for the persistence plugin. */
export interface PersistenceOptions {
  key?: string;
}

/** Creates a plugin that persists state to localStorage and syncs across browser tabs via storage events. */
export function persistencePlugin(options: PersistenceOptions = {}): StorePlugin {
  let store: any;
  let storageKey: string | null = options.key ?? null;
  let storageHandler: ((e: StorageEvent) => void) | null = null;

  return {
    name: 'persistence',

    onInit(s: any) {
      store = s;

      if (!storageKey && typeof s.getAttribute === 'function') {
        storageKey = s.getAttribute('persist');
      }

      if (storageKey) {
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) {
            const parsed = JSON.parse(saved);
            for (const [key, value] of Object.entries(parsed)) {
              store._state[key] = value;
              const signal = store._signals.get(key);
              if (signal) signal._value = value;
            }
          }
        } catch { /* ignore parse errors or unavailable localStorage */ }

        if (typeof window !== 'undefined') {
          storageHandler = (e: StorageEvent) => {
            if (e.key !== storageKey) return;
            try {
              store.sync(JSON.parse(e.newValue!));
            } catch { /* ignore parse errors */ }
          };
          window.addEventListener('storage', storageHandler);
        }
      }
    },

    onFlush() {
      if (!storageKey || store._isSyncing) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(store._state));
      } catch { /* ignore quota errors */ }
    },

    onDestroy() {
      if (storageHandler && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageHandler);
        storageHandler = null;
      }
    }
  };
}
