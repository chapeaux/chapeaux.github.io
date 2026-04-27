+++
title = "From 162 Lines to IDE Scale: How CPX Store Grew Up"
date = 2026-04-23
template = "blog-page.html"
type = "Blog Post"
description = "CPX Store started as a 162-line reactive Web Component. A plugin architecture, signal-inspired reactivity, microtask batching, pluggable collaboration transport, and a headless core for server-side rendering turn it into a state management system that runs anywhere JavaScript runs — without adding a single framework dependency."
+++

A week ago, [I wrote about CPX Store's cross-tab sync](/blog/2026-04-16-cpx-store-cross-tab/) — how adding `persist="key"` to an <abbr title="HyperText Markup Language">HTML</abbr> element turns `localStorage` into a real-time communication channel between browser tabs. The entire base class was 162 lines of TypeScript. No dependencies. Property assignment through a `Proxy`, synchronous event dispatch, and a tidy undo/redo stack. It was elegant. It was small. And it was not going to survive contact with a real <abbr title="Integrated Development Environment">IDE</abbr>.

The problem was not a bug. It was arithmetic. Every `state.prop = value` ran the full pipeline synchronously: middleware, history push, a scan of every computed property, a `JSON.stringify` to `localStorage`, and two `CustomEvent` dispatches. For a theme toggle or a click counter, that pipeline is invisible. For a code editor with hundreds of state dimensions — selections, diagnostics, decorations, folding state, breakpoints per file — it means a language server sending 100 diagnostics produces 100 full pipeline runs, 200 <abbr title="Document Object Model">DOM</abbr> events, and 100 `localStorage` writes. In the same synchronous block.

This article is about what changed, why, and how the new architecture compares to what the React ecosystem requires to solve the same problems.

## What Broke

Four things, specifically.

**History ate memory.** The undo stack stored raw `{ prop, old, val }` deltas. For small values — a counter, a theme string — this is fine. For a 1<abbr title="Megabyte">MB</abbr> editor buffer, 100 undos means 100 copies of a megabyte-scale string. The heap grows linearly with undo depth, with no way to opt out per property.

**Computed properties scaled badly.** After every mutation, the store scanned *all* computed properties to check whether their dependency arrays included the changed property. With 10 computed values, nobody notices. With 500 — think diagnostics counts per file, visible line ranges, dirty flags across open editors — the scan dominates the mutation cost. The complexity was O(all computed × average dependency count) on every single property assignment.

**No batching existed.** Every assignment was its own transaction. Middleware ran, history recorded, events fired, `localStorage` wrote. There was no way to say "I am about to set 20 properties; please wait until I am done." A debugger stepping through code might update the call stack, locals, watches, and breakpoint states in rapid succession — each triggering the full pipeline independently.

**Collaboration was `localStorage` or nothing.** The cross-tab sync mechanism was hardwired to `localStorage` and the `storage` event. The `sync()` method and `_isSyncing` guard worked, but there was no transport abstraction, no operation log, and no path toward conflict resolution. Multi-user editing over WebSockets required reimplementing the sync layer from scratch.

## The New Architecture

The rewrite keeps the Proxy. Everything else is different — including the assumption that a browser is required. The state management logic now lives in a headless core that runs in any JavaScript runtime. The Web Component is a thin wrapper that bridges that core to the <abbr title="Document Object Model">DOM</abbr>.

### Plugin System

The monolithic `set` trap is gone. In its place: a thin core that dispatches to composable plugins through lifecycle hooks.

```javascript
class EditorStore extends CPXStore {
  constructor() {
    super(
      { content: '', cursor: 0, theme: 'light' },
      middlewarePlugin([
        { filter: /^content/, fn: (prop, val) => validate(val) }
      ]),
      historyPlugin({
        strategies: { content: 'patch', cursor: 'none' },
        maxHistory: 200
      }),
      persistencePlugin()
    );
  }
}
```

Each plugin declares which hooks it uses — `onBeforeSet`, `onAfterSet`, `onFlush`, `onGet`, `onDestroy` — and the core only calls hooks that at least one plugin has registered. Plugin ordering defines execution order: middleware runs first (it can throw to cancel a mutation), then history, then persistence, then event dispatch. A store with no plugins has no overhead from features it does not use.

### Signal-Inspired Reactivity

The <abbr title="Technical Committee 39 — the committee that standardizes JavaScript">TC39</abbr> [Signals proposal](https://github.com/tc39/proposal-signals) defines a model for fine-grained reactive state: `Signal.State` for mutable values, `Signal.Computed` for derived values with automatic dependency tracking, and `Signal.subtle.Watcher` for observing changes. Native browser support is still years away, and the polyfill is not production-ready. But the programming model is sound, and there is no reason to wait for the spec to ship before using it.

CPX Store now includes a lightweight reactivity system — `ReactiveState` and `ReactiveComputed` — that implements the same push-pull model. Each state property is backed by a `ReactiveState`. Computed values are `ReactiveComputed` instances that auto-track their dependencies during evaluation, with no explicit dependency array.

The old <abbr title="Application Programming Interface">API</abbr>:

```javascript
// v0.6 — manual dependency list
this.computed('total', ['price', 'qty'], () => {
  return this.state.price * this.state.qty;
});
```

The new <abbr title="Application Programming Interface">API</abbr>:

```javascript
// v0.7 — automatic tracking, no dependency array
this.computed('total', () => {
  return this.state.price * this.state.qty;
});
```

When the compute function runs, every `state.price` read calls `priceSignal.get()`, which registers the signal as a dependency. When `price` changes, `ReactiveState.set()` marks all subscribing `ReactiveComputed` instances as dirty. The next read of `state.total` triggers re-evaluation. If `qty` changes but `price` does not, only computed values that depend on `qty` are invalidated — not everything.

The invalidation cost is O(affected), not O(all). For an <abbr title="Integrated Development Environment">IDE</abbr> with hundreds of computed values, this is the difference between a mutation taking microseconds and taking milliseconds.

Transitive dependencies work automatically. A computed value that reads another computed value subscribes to it through the same mechanism:

```javascript
this.computed('doubled', () => this.state.base * 2);
this.computed('quadrupled', () => this.state.doubled * 2);

// Changing state.base invalidates 'doubled', which invalidates 'quadrupled'.
// Reading state.quadrupled re-evaluates both, in order.
```

The Proxy remains the <abbr title="Application Programming Interface">API</abbr> surface — `state.price = 5` is still a plain property assignment. The reactivity system runs underneath, invisible to consumers. If <abbr title="Technical Committee 39">TC39</abbr> Signals ship natively, the internal `ReactiveState` and `ReactiveComputed` can be swapped for `Signal.State` and `Signal.Computed` without changing the store's public <abbr title="Application Programming Interface">API</abbr>.

### Microtask-Coalesced Events

The old store dispatched two <abbr title="Document Object Model">DOM</abbr> events synchronously on every mutation. The new store defers event dispatch to a `queueMicrotask` callback. Multiple mutations in the same synchronous block produce a single `change` event containing all changed properties.

```javascript
store.state.a = 1;
store.state.b = 2;
store.state.c = 3;
// One 'change' event fires after the microtask, with all three changes.
```

For explicit control, `batch()` flushes synchronously at the end of the block:

```javascript
store.batch(() => {
  state.a = 1;
  state.b = 2;
  state.c = 3;
}); // One event fires here, synchronously.
```

`transaction()` adds rollback semantics — if the function throws, the state reverts and no events fire:

```javascript
store.transaction(() => {
  state.balance -= 100;
  if (state.balance < 0) throw new Error('insufficient');
}); // State unchanged, no events, error propagates.
```

`dispatch()` — the async action method from v0.6 — now auto-batches:

```javascript
await store.dispatch(async (state) => {
  const data = await fetch('/api/items');
  state.items = await data.json();
  state.loading = false;
}); // One batched event after the promise resolves.
```

### Nested State

Flat state does not scale. An <abbr title="Integrated Development Environment">IDE</abbr> has state per file, per editor pane, per debug session. The new store supports nested objects through recursive Proxies:

```javascript
const store = new EditorStore({
  editor: {
    file1: { content: 'hello', dirty: false },
    file2: { content: 'world', dirty: true }
  }
});

store.state.editor.file1.content = 'updated';
// Triggers change event with prop: "editor.file1.content"
```

Each nested path gets its own `ReactiveState` signal, so computed values that read `state.editor.file1.content` auto-track at the leaf level. Changing `file2` does not invalidate computed values that only depend on `file1`. Nested Proxies are cached via `WeakMap` — accessing `state.editor.file1` repeatedly returns the same Proxy instance, not a new one each time.

### History Strategies

The history plugin now supports per-property strategies instead of storing raw values for everything:

| Strategy | What It Stores | Use Case |
|---|---|---|
| `snapshot` | Full old and new values | Small values (default) |
| `patch` | Text diffs or <abbr title="JavaScript Object Notation">JSON</abbr> Patch operations | Editor buffers, large objects |
| `none` | Nothing | Cursor position, scroll offset |

```javascript
historyPlugin({
  strategies: {
    content: 'patch',   // Store diffs, not full copies
    cursor: 'none',     // No undo for cursor movement
    theme: 'snapshot',  // Full snapshots for small values
  },
  checkpointInterval: 20  // Full snapshot every 20 patch ops
})
```

For string values with the `patch` strategy, the history plugin computes a minimal text diff — the offset, delete count, and inserted text — instead of storing the entire string. For object values, it computes <abbr title="JavaScript Object Notation">JSON</abbr> Patch ([<abbr title="Request for Comments">RFC</abbr> 6902](https://datatracker.ietf.org/doc/html/rfc6902)) operations. Every `checkpointInterval` operations, a full snapshot is stored so that undo can replay patches backward from a known state rather than from the beginning of time.

The memory bound becomes `(stateSize × numberOfCheckpoints) + (maxHistory × averagePatchSize)` instead of `stateSize × maxHistory`. For a 1<abbr title="Megabyte">MB</abbr> editor buffer with 100 undo steps and an average patch size of 100 bytes, this is roughly 1.05<abbr title="Megabyte">MB</abbr> instead of 100<abbr title="Megabyte">MB</abbr>.

### Pluggable Collaboration

The [previous article](/blog/2026-04-16-cpx-store-cross-tab/) described four approaches to cross-device sync: <abbr title="Server-Sent Events">SSE</abbr>, WebSockets, Solid pods, and <abbr title="Conflict-free Replicated Data Type">CRDT</abbr>s. All of them required manual integration — wiring up `sync()` calls and `onStorageChanged` overrides by hand. The new architecture formalizes this with a `SyncTransport` interface and a collaboration plugin.

```javascript
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { BroadcastChannelTransport } from '@chapeaux/cpx-store/transports/broadcast-channel';

class SharedStore extends CPXStore {
  constructor() {
    super(
      { count: 0 },
      collabPlugin({
        transport: new BroadcastChannelTransport('my-channel')
      })
    );
  }
}
```

The collab plugin intercepts every local mutation, wraps it as a `StateOperation` (with a unique <abbr title="Identifier">ID</abbr>, origin client <abbr title="Identifier">ID</abbr>, timestamp, property, and value), and sends it through the transport. Incoming operations are applied via `store.sync()`, with the existing `_isSyncing` guard preventing echo loops.

Two transports ship built-in:

- **`BroadcastChannelTransport`** — Same-origin tab-to-tab communication using the [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) <abbr title="Application Programming Interface">API</abbr>. Uses structured clone instead of <abbr title="JavaScript Object Notation">JSON</abbr> serialization. Replaces the `localStorage` + `storage` event approach from v0.6 with something faster and more capable.

- **`WebSocketTransport`** — Server-mediated multi-user sync. Handles reconnection with exponential backoff (1s, 2s, 4s, up to 30s). Queues outbound operations during disconnect and flushes on reconnect.

Conflict resolution is pluggable. The default is last-writer-wins by timestamp. For <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> integration, implement the `ConflictResolver` interface:

```javascript
collabPlugin({
  transport: new WebSocketTransport('wss://example.com/sync'),
  resolver: {
    resolve(local, remote) {
      return remote.timestamp >= local.timestamp ? remote : local;
    }
  }
})
```

The operation log maintained by the collab plugin uses the same `StateOperation` structure as the history plugin's entries. This is by design — the local undo history and the outbound collaboration stream share a data model, so a single mutation feeds both systems without duplication.

### Headless Mode and Server-Side Rendering

The original CPX Store extended `HTMLElement`. Every feature — state, computed, undo, persistence — was locked inside a Web Component that required a browser <abbr title="Document Object Model">DOM</abbr> to instantiate. You could not create a store in a Node.js <abbr title="Server-Side Rendering">SSR</abbr> handler, a Deno <abbr title="Command-Line Interface">CLI</abbr> tool, or a test runner without a <abbr title="Document Object Model">DOM</abbr> polyfill.

The new architecture splits the store into two layers. A `CPXStoreCoreMixin` function injects all state management logic — reactivity, plugins, batching, transactions, sync, computed, undo/redo — into any base class. Applied to a bare class, it produces `CPXStoreCore`: a headless store with no <abbr title="Document Object Model">DOM</abbr> dependency at all. Applied to `HTMLElement`, it produces `CPXStore`: the Web Component that bridges state changes to `CustomEvent` dispatch.

```javascript
import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';
import { historyPlugin } from '@chapeaux/cpx-store/plugins/history';

// Runs in Node, Deno, Bun, Cloudflare Workers — anywhere
const store = new CPXStoreCore(
  { count: 0, items: [] },
  historyPlugin()
);

store.computed('itemCount', () => (store.state.items as any[]).length);
store.state.items = ['a', 'b', 'c'];
console.log(store.state.itemCount); // 3
```

`CPXStoreCore` initializes immediately in the constructor — no `connectedCallback`, no <abbr title="Document Object Model">DOM</abbr> attachment. The Proxy, plugins, and computed values are all ready to use on the next line. For change notification, `CPXStoreCore` provides `onChange(handler)` instead of <abbr title="Document Object Model">DOM</abbr> events:

```javascript
const unsub = store.onChange((changes) => {
  for (const [prop, { old, val }] of changes) {
    console.log(`${prop}: ${old} → ${val}`);
  }
});
// Later: unsub() to stop listening
```

The `onChange` handler receives the same batched `Map<string, {old, val}>` that the `change` event's `e.detail.changes` carries in the browser. Same data, same batching semantics, no `CustomEvent` or `dispatchEvent` required.

#### <abbr title="Server-Side Rendering">SSR</abbr> Hydration Pattern

A server creates a `CPXStoreCore`, populates it from an <abbr title="Application Programming Interface">API</abbr> or database, serializes the state, and embeds it in the <abbr title="HyperText Markup Language">HTML</abbr> response. The client hydrates a `CPXStore` from that serialized state.

```javascript
// Server — no DOM, no polyfill
import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';

const store = new CPXStoreCore({ user: null, items: [] });
store.state.user = await db.getUser(sessionId);
store.state.items = await db.getItems(store.state.user.id);

const html = `
  <script>window.__STATE__ = ${JSON.stringify(store.toJSON())}</script>
  <my-store></my-store>
`;
```

```javascript
// Client — hydrate into the Web Component
import { CPXStore } from '@chapeaux/cpx-store';
import { historyPlugin } from '@chapeaux/cpx-store/plugins/history';
import { persistencePlugin } from '@chapeaux/cpx-store/plugins/persistence';

class MyStore extends CPXStore {
  constructor() {
    super(window.__STATE__, historyPlugin(), persistencePlugin());
  }
}
customElements.define('my-store', MyStore);
```

The client store picks up exactly where the server left off. Undo history starts from the hydrated state. Persistence kicks in on the first user-driven mutation. The server never needed to know about undo, persistence, or <abbr title="Document Object Model">DOM</abbr> events — it used the headless core to prepare the data and moved on.

#### What Works Without a Browser

The headless core supports everything except <abbr title="Document Object Model">DOM</abbr>-specific features:

| Feature | `CPXStoreCore` | `CPXStore` |
|---|---|---|
| Reactive state (Proxy) | Yes | Yes |
| Computed with auto-tracking | Yes | Yes |
| Plugins (middleware, history, collab) | Yes | Yes |
| `batch()` / `transaction()` / `dispatch()` | Yes | Yes |
| `sync()` / `onSyncReceived` | Yes | Yes |
| `onChange(handler)` | Yes | Yes |
| `toJSON()` | Yes | Yes |
| `change` / `app-state-update` <abbr title="Document Object Model">DOM</abbr> events | — | Yes |
| `persist` <abbr title="HyperText Markup Language">HTML</abbr> attribute | — | Yes |
| `localStorage` persistence | — | Yes |
| `customElements.define()` | — | Yes |

The persistence plugin itself is environment-aware: it checks for `localStorage` and `window` before using them, and accepts an explicit `{ key }` option as an alternative to the `persist` <abbr title="HyperText Markup Language">HTML</abbr> attribute. In a server environment, it silently skips storage operations.

## The Previous Post, Revisited

The [cross-tab sync article](/blog/2026-04-16-cpx-store-cross-tab/) included several code samples against the v0.6 <abbr title="Application Programming Interface">API</abbr>. Every one of them still works conceptually, but the constructor signature, event shape, and sync hooks have changed. Here is each example from that article, followed by its current equivalent.

### The Minimal Store

The v0.6 constructor took `(initialState, middleware[], options)`. Undo/redo and persistence were built into the base class — always present, always running, whether you used them or not.

<div class="before-after">

**v0.6:**

```javascript
import { CPXStore } from '@chapeaux/cpx-store';

class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0 });
  }
}
customElements.define('counter-store', CounterStore);
```

**Now:**

```javascript
import { CPXStore } from '@chapeaux/cpx-store';
import { historyPlugin } from '@chapeaux/cpx-store/plugins/history';

class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0 }, historyPlugin());
  }
}
customElements.define('counter-store', CounterStore);
```

</div>

The constructor now takes `(initialState, ...plugins)`. If you want undo/redo, register `historyPlugin()`. If you do not need it, leave it out — zero overhead. A store with no plugins is just a reactive Proxy with microtask-coalesced events.

If you do not need a Web Component at all — server-side code, a <abbr title="Command-Line Interface">CLI</abbr> tool, a test harness — use `CPXStoreCore` directly:

```javascript
import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';

const store = new CPXStoreCore({ count: 0 }, historyPlugin());
store.state.count++;
store.undo();
```

No `customElements.define`, no <abbr title="Document Object Model">DOM</abbr>, no browser required.

### The `persist` Attribute

In v0.6, the `persist` attribute was handled by code baked into the base class. Now it is handled by the persistence plugin. The <abbr title="HyperText Markup Language">HTML</abbr> stays the same:

```html
<counter-store persist="demo-counter"></counter-store>
```

But the store class must register the plugin:

```javascript
import { historyPlugin } from '@chapeaux/cpx-store/plugins/history';
import { persistencePlugin } from '@chapeaux/cpx-store/plugins/persistence';

class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0 }, historyPlugin(), persistencePlugin());
  }
}
```

The persistence plugin reads the `persist` attribute during `connectedCallback`, restores state from `localStorage`, and writes back on every flush. It also sets up the `storage` event listener for cross-tab sync — the same behavior as before, moved from hardcoded internals to an opt-in plugin.

### The `onStorageChanged` Hook

The previous article showed overriding `onStorageChanged` for side effects when remote state arrives. The method has been renamed to `onSyncReceived` — a clearer name, since the hook fires on any `sync()` call, not just `storage` events.

<div class="before-after">

**v0.6:**

```javascript
class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });
  }

  onStorageChanged(newState, oldState) {
    if (newState.theme !== oldState.theme) {
      document.body.className = newState.theme;
    }
  }
}
```

**Now:**

```javascript
class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' }, persistencePlugin());
  }

  onSyncReceived(newState, oldState) {
    if (newState.theme !== oldState.theme) {
      document.body.className = newState.theme;
    }
  }
}
```

</div>

The signature is identical — `(newState, oldState)` — so the body of the method does not change.

### The Change Event

This is the most visible breaking change. The `change` event now carries all mutations that occurred since the last flush, not a single property.

<div class="before-after">

**v0.6 — one event per mutation, synchronous:**

```javascript
store.addEventListener('change', (e) => {
  const { prop, value } = e.detail;
  if (prop === 'count')
    document.getElementById('count-display').textContent = value;
  if (prop === 'theme')
    document.body.className = value;
});
```

**Now — one event per flush, microtask-deferred:**

```javascript
store.addEventListener('change', (e) => {
  const { changes } = e.detail;
  if (changes.count)
    document.getElementById('count-display').textContent = changes.count.val;
  if (changes.theme)
    document.body.className = changes.theme.val;
});
```

</div>

`e.detail.changes` is an object keyed by property name. Each entry has `{ old, val }`. If three properties change in the same synchronous block — or inside a `batch()` — they all appear in one event. The `old` value is the state before the first mutation in the batch, and `val` is the state after the last.

The global `app-state-update` event on `window` follows the same shape: `e.detail.store` is the element's tag name, and `e.detail.changes` contains the batch.

### Middleware

In v0.6, middleware was an array of bare functions passed as the second constructor argument. Now it is a plugin, and each middleware entry can optionally include a filter.

<div class="before-after">

**v0.6:**

```javascript
class PartyStore extends CPXStore {
  constructor() {
    super(
      { count: 0, theme: '' },
      [(prop, val) => console.log(`[sync] ${prop} = ${val}`)]
    );
  }
}
```

**Now:**

```javascript
import { middlewarePlugin } from '@chapeaux/cpx-store/plugins/middleware';

class PartyStore extends CPXStore {
  constructor() {
    super(
      { count: 0, theme: '' },
      middlewarePlugin([
        (prop, val) => console.log(`[sync] ${prop} = ${val}`)
      ])
    );
  }
}
```

</div>

Bare functions still work — `middlewarePlugin` wraps them automatically. The new capability is filtered middleware: `{ filter: /^editor\./, fn: myLogger }` runs the function only for properties matching the pattern, so a logging middleware does not fire on every cursor-position update.

### The Tab Party Demo

The [previous article](/blog/2026-04-16-cpx-store-cross-tab/) built a complete multi-tab demo: a synchronized counter and theme switcher. Here is that demo updated for the current <abbr title="Application Programming Interface">API</abbr>. The <abbr title="HyperText Markup Language">HTML</abbr> and <abbr title="Cascading Style Sheets">CSS</abbr> are identical — only the `<script>` block changes.

```html
<script type="module">
  import { CPXStore } from 'https://esm.sh/@chapeaux/cpx-store';
  import { middlewarePlugin } from 'https://esm.sh/@chapeaux/cpx-store/plugins/middleware';
  import { historyPlugin } from 'https://esm.sh/@chapeaux/cpx-store/plugins/history';
  import { persistencePlugin } from 'https://esm.sh/@chapeaux/cpx-store/plugins/persistence';

  class PartyStore extends CPXStore {
    constructor() {
      super(
        { count: 0, theme: '' },
        middlewarePlugin([
          (prop, val) => console.log(`[sync] ${prop} = ${val}`)
        ]),
        historyPlugin(),
        persistencePlugin()
      );
    }
  }

  customElements.define('party-store', PartyStore);

  await customElements.whenDefined('party-store');
  const store = document.querySelector('party-store');

  // Render on every change — note the new event shape
  store.addEventListener('change', (e) => {
    const { changes } = e.detail;
    if (changes.count)
      document.getElementById('count-display').textContent = changes.count.val;
    if (changes.theme)
      document.body.className = changes.theme.val;
  });

  // Initial render
  document.getElementById('count-display').textContent = store.state.count;
  document.body.className = store.state.theme;

  // Button handlers — unchanged
  document.getElementById('btn-inc').onclick = () => store.state.count++;
  document.getElementById('btn-dec').onclick = () => store.state.count--;
  document.getElementById('btn-undo').onclick = () => store.undo();
  document.getElementById('btn-redo').onclick = () => store.redo();

  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.onclick = () => store.state.theme = btn.dataset.theme;
  });
</script>
```

Three things changed: the imports (plugins are explicit), the constructor (plugins as rest arguments), and the event handler (reads from `e.detail.changes.count.val` instead of checking `e.detail.prop`). The button handlers — `store.state.count++`, `store.undo()`, theme assignment — are character-for-character identical.

### The <abbr title="Server-Sent Events">SSE</abbr> Sync Store

The previous article showed a store that receives remote state over <abbr title="Server-Sent Events">SSE</abbr> and pushes local changes via `POST`. The pattern still works — `sync()` and `onSyncReceived` handle the plumbing. The only change is the callback name.

<div class="before-after">

**v0.6:**

```javascript
class SyncedStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });

    const events = new EventSource('/api/store/stream');
    events.onmessage = (e) => this.sync(JSON.parse(e.data));
  }

  onStorageChanged(newState, oldState) {
    fetch('/api/store/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

**Now:**

```javascript
class SyncedStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });

    const events = new EventSource('/api/store/stream');
    events.onmessage = (e) => this.sync(JSON.parse(e.data));
  }

  onSyncReceived(newState, oldState) {
    fetch('/api/store/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

</div>

One line changed: `onStorageChanged` → `onSyncReceived`. The `sync()` call, the `_isSyncing` guard, and the `EventSource` wiring are all the same. This store deliberately omits plugins — no undo/redo, no `localStorage` persistence — because a server-synced store may not need them.

### The WebSocket Sync Store

The v0.6 article showed manual WebSocket integration. The new architecture offers two paths: the manual approach with `onSyncReceived` (same as <abbr title="Server-Sent Events">SSE</abbr> above, just swap `EventSource` for `WebSocket`), or the collab plugin with the built-in `WebSocketTransport`.

<div class="before-after">

**v0.6 — manual WebSocket wiring:**

```javascript
class RealtimeStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });

    this.ws = new WebSocket('wss://example.com/store');
    this.ws.onmessage = (e) => this.sync(JSON.parse(e.data));
  }

  onStorageChanged(newState, oldState) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(newState));
    }
  }
}
```

**Now — using the collab plugin:**

```javascript
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { WebSocketTransport } from '@chapeaux/cpx-store/transports/websocket';

class RealtimeStore extends CPXStore {
  constructor() {
    super(
      { count: 0, theme: 'light' },
      collabPlugin({
        transport: new WebSocketTransport('wss://example.com/store')
      })
    );
  }
}
```

</div>

The collab plugin version is shorter because reconnection logic, operation logging, echo prevention, and conflict resolution are handled by the plugin and transport — not hand-coded in the store subclass. The `WebSocketTransport` reconnects automatically with exponential backoff and queues outbound operations during disconnection. The manual approach from v0.6 had none of that — a dropped connection meant silent data loss until the page reloaded.

The manual `sync()` + `onSyncReceived` approach still works for cases where the collab plugin is too opinionated — for instance, if the server sends full state snapshots rather than per-property operations, or if the protocol does not map cleanly to `StateOperation`.

### The Solid Pod Store

The Solid pod example from the previous article used `EventSource` for notifications and `fetch` for reads and writes. It works the same way with the renamed callback.

<div class="before-after">

**v0.6:**

```javascript
class PodStore extends CPXStore {
  constructor(podUrl) {
    super({ count: 0, theme: 'light' });
    this.resourceUrl = `${podUrl}/app/state.json`;

    const events = new EventSource(
      `${podUrl}/.notifications?resource=${encodeURIComponent(this.resourceUrl)}`
    );
    events.onmessage = (e) => {
      const notification = JSON.parse(e.data);
      if (notification.type === 'Update') {
        fetch(this.resourceUrl)
          .then(r => r.json())
          .then(data => this.sync(data));
      }
    };
  }

  onStorageChanged(newState, oldState) {
    fetch(this.resourceUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

**Now:**

```javascript
class PodStore extends CPXStore {
  constructor(podUrl) {
    super({ count: 0, theme: 'light' });
    this.resourceUrl = `${podUrl}/app/state.json`;

    const events = new EventSource(
      `${podUrl}/.notifications?resource=${encodeURIComponent(this.resourceUrl)}`
    );
    events.onmessage = (e) => {
      const notification = JSON.parse(e.data);
      if (notification.type === 'Update') {
        fetch(this.resourceUrl)
          .then(r => r.json())
          .then(data => this.sync(data));
      }
    };
  }

  onSyncReceived(newState, oldState) {
    fetch(this.resourceUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

</div>

Again, one line. The Solid Notifications flow — subscribe to changes, fetch on update, write on local mutation — is transport-level logic that does not benefit from the collab plugin's per-property operation model. The `sync()` / `onSyncReceived` pair remains the right tool for full-state transports like Solid pods.

### Summary of Changes

For readers migrating from code written against the previous article:

| v0.6 | Current | Notes |
|---|---|---|
| `super(state, middleware, options)` | `super(state, ...plugins)` | Plugins replace positional args |
| Built-in undo/redo | `historyPlugin()` | Opt-in, with strategy config |
| Built-in persistence | `persistencePlugin()` | Opt-in |
| `onStorageChanged` | `onSyncReceived` | Same signature |
| `e.detail.prop` / `e.detail.value` | `e.detail.changes.prop.val` | Batched event shape |
| `store._history` | Internal to plugin | Test via undo/redo behavior |
| `store._storageHandler` | Internal to plugin | Test via behavior |
| Manual WebSocket wiring | `collabPlugin()` + `WebSocketTransport` | Optional — manual still works |
| Browser-only | `CPXStoreCore` for headless, `CPXStore` for browser | Same <abbr title="Application Programming Interface">API</abbr>, same plugins |

## How This Compares to the React Ecosystem

React's state management landscape is a marketplace of specialized tools. Each solves a real problem. Each requires its own learning curve, its own integration patterns, and its own upgrade path. Here is how CPX Store's features map to that ecosystem.

### Reactive State: Jotai / Zustand / Redux

[Redux](https://redux.js.org/) requires actions, reducers, a store configuration, and middleware for async operations. [Zustand](https://zustand-demo.pmnd.rs/) simplifies this with a `create()` function but still requires selectors for granular subscriptions. [Jotai](https://jotai.org/) introduces atoms — individual units of state — with automatic dependency tracking between derived atoms.

CPX Store's `ReactiveState` and `ReactiveComputed` are closest in spirit to Jotai's atoms. Both provide fine-grained reactivity with automatic dependency tracking. The difference is coupling: Jotai atoms exist inside React's rendering model. They trigger re-renders through `useAtom` hooks. They cannot be read or written from outside a React component tree without additional plumbing.

A CPX Store element is a <abbr title="Document Object Model">DOM</abbr> node. Any JavaScript on the page — React, Vue, Svelte, a plain `<script>` tag — interacts with it the same way: read `.state`, listen for `change` events, assign properties. The reactive dependency graph runs inside the store, not inside a framework's rendering cycle. This means the same store works with React 19, Lit 4, or vanilla JavaScript without adapter code.

### Batching: React Transitions vs. `batch()` / `transaction()`

React 18 introduced automatic batching — multiple `setState` calls within the same event handler or `useEffect` are coalesced into a single re-render. React 19 extended this with `useTransition` and `useOptimistic` for deferred and speculative updates.

CPX Store's microtask coalescing serves the same purpose but operates at the state layer rather than the rendering layer. Multiple property assignments in the same synchronous block produce one `change` event. `batch()` provides explicit control. `transaction()` adds rollback — something React does not offer natively and would require manual state snapshot management.

The important distinction: React batches *renders*. CPX Store batches *state changes and their side effects* (events, persistence, history). A React application using Zustand or Redux still needs those libraries to handle their own batching for non-render side effects like `localStorage` writes or analytics events. CPX Store handles this in one place because the store owns the entire pipeline from mutation to persistence to broadcast.

### Persistence: Zustand `persist` / Redux Persist

[Zustand's `persist` middleware](https://docs.pmnd.rs/zustand/integrations/persisting-store-data) and [Redux Persist](https://github.com/rt2zz/redux-persist) both serialize store state to `localStorage` and restore it on load. Both require configuration — storage adapters, serialization functions, migration strategies — and both run as middleware within their respective frameworks.

CPX Store's persistence plugin does the same thing, but because it operates at the `onFlush` hook rather than per-mutation, it writes to `localStorage` once per batch rather than once per state change. For a `dispatch()` that sets five properties, Redux Persist potentially writes five times (depending on middleware configuration). CPX Store writes once, after the batch completes.

Cross-tab sync is also built in: the persistence plugin listens for `storage` events and applies remote state through `sync()`, with the `_isSyncing` guard preventing write-back loops. In Redux, you would need a separate middleware or library to handle this — and that library would need to integrate with Redux Persist to avoid conflicts.

### Undo/Redo: No Standard Solution

React has no built-in undo mechanism. Libraries like [use-undo](https://github.com/homerchen19/use-undo) exist for individual state values, but undo across an entire application state — the kind you need for a text editor or a design tool — typically requires custom implementation. Redux offers [redux-undo](https://github.com/omnidan/redux-undo), which wraps a reducer to maintain a history of past states. Each history entry is a full state snapshot, creating the same memory problem CPX Store v0.6 had.

CPX Store's history plugin solves this with per-property strategies. A property storing a 1<abbr title="Megabyte">MB</abbr> editor buffer uses the `patch` strategy and stores 100-byte diffs. A property storing a boolean flag uses the default `snapshot` strategy and stores two booleans. A property storing a cursor position uses `none` and is excluded from history entirely. This granularity is not available in any React state management library I am aware of.

### Collaboration: Roll Your Own

React's ecosystem has no standard answer for real-time collaboration at the state management level. Libraries like [Yjs](https://yjs.dev/) and [Liveblocks](https://liveblocks.io/) provide <abbr title="Conflict-free Replicated Data Type">CRDT</abbr>-based collaboration, but they operate as separate systems that must be integrated with whatever state management library you are using. The integration is non-trivial — you need to synchronize the <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> document with your Redux store or Zustand atoms, handle conflict resolution, and ensure that local optimistic updates do not diverge from the <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> state.

CPX Store's collab plugin and `SyncTransport` interface provide the plumbing that these integrations typically require. The `ConflictResolver` interface is the hook for <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> libraries — implement `resolve(local, remote)` and the store handles the rest. The operation log, echo prevention, and transport abstraction are the parts that every collaboration implementation needs and every team ends up building from scratch.

### Server-Side Rendering: Next.js vs. `CPXStoreCore`

React's <abbr title="Server-Side Rendering">SSR</abbr> story has become increasingly complex. [Next.js](https://nextjs.org/) introduced React Server Components, which split components into server and client layers. State management libraries must navigate this split carefully — Zustand requires a [`createStore` pattern](https://docs.pmnd.rs/zustand/guides/nextjs) with React context to avoid shared state between requests, and Redux needs a [per-request store instance](https://redux.js.org/usage/nextjs) to prevent cross-request data leaks on the server.

CPX Store's `CPXStoreCore` avoids this complexity because it is a plain class with no global singletons and no framework coupling. Each request creates a new `CPXStoreCore` instance, populates it, serializes with `toJSON()`, and discards it. There is no shared state to leak, no context provider to configure, and no framework-specific <abbr title="Server-Side Rendering">SSR</abbr> adapter to maintain. The same plugins — middleware, history, collab — work identically on the server and in the browser because they operate on the store instance, not on framework hooks.

### Computed State: `useMemo` vs. `ReactiveComputed`

React's `useMemo` caches a computed value and recomputes it when dependencies change. The dependency array is explicit — you list the values that the memo depends on — and incorrect dependency arrays are a [well-documented source of bugs](https://react.dev/reference/react/useMemo#troubleshooting).

CPX Store's `ReactiveComputed` tracks dependencies automatically during evaluation. There is no dependency array to get wrong. Conditional dependencies work correctly: if a compute function reads `state.a` only when `state.useA` is true, the dependency on `state.a` is only tracked when `state.useA` is true. When `state.useA` changes to false, the next evaluation drops `state.a` from the dependency set. `useMemo` cannot express this — it always tracks the same dependencies regardless of runtime control flow.

## What This Does Not Do

CPX Store is not a <abbr title="User Interface">UI</abbr> framework. It does not render components, manage a virtual <abbr title="Document Object Model">DOM</abbr>, or handle routing. It is a state management layer that happens to have a Web Component interface (`CPXStore`) for browser use and a plain class interface (`CPXStoreCore`) for everywhere else. It pairs with whatever renders your <abbr title="User Interface">UI</abbr> — React, Lit, Svelte, `document.getElementById`, or no <abbr title="User Interface">UI</abbr> at all.

It is also not a <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> engine. The collaboration plugin provides transport abstraction, operation logging, and a conflict resolution interface. It does not implement operational transform or <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> merge semantics. For true multi-user document editing, you still need Yjs or Automerge — but CPX Store gives you the integration hooks rather than leaving you to build them.

## The Numbers

The new architecture across all source files:

| Component | Size | Purpose |
|---|---|---|
| Headless core (`CPXStoreCore`) | ~280 lines | Plugin system, Proxy, nested state, batch/transaction |
| Web Component wrapper (`CPXStore`) | ~45 lines | <abbr title="Document Object Model">DOM</abbr> events, `HTMLElement` lifecycle |
| Reactivity | ~80 lines | ReactiveState, ReactiveComputed, auto-tracking |
| Middleware plugin | ~30 lines | Filterable middleware |
| History plugin | ~160 lines | Undo/redo with strategies |
| Persistence plugin | ~55 lines | localStorage + cross-tab sync (environment-aware) |
| Collab plugin | ~105 lines | Transport abstraction + operation log |
| BroadcastChannel transport | ~40 lines | Same-origin tab sync |
| WebSocket transport | ~120 lines | Multi-user sync with reconnection |
| Nested proxy utility | ~70 lines | Recursive Proxy with WeakMap cache |
| <abbr title="JavaScript Object Notation">JSON</abbr> Patch utility | ~55 lines | Object diff/apply for history |
| **Total** | **~1,040 lines** | Zero dependencies |

The entire system — reactivity, plugins, undo/redo with patch compression, nested state, collaboration with two transports, a <abbr title="JavaScript Object Notation">JSON</abbr> Patch implementation, and a headless core for <abbr title="Server-Side Rendering">SSR</abbr> — is about a thousand lines of TypeScript with no external dependencies. Of those, roughly 280 lines are the headless core that runs anywhere, and 45 lines are the Web Component wrapper. A React application achieving the same capability would typically combine Redux or Zustand (~15<abbr title="Kilobyte">KB</abbr> minified), Redux Persist (~8<abbr title="Kilobyte">KB</abbr>), a custom undo library, a collaboration layer, and a framework-specific <abbr title="Server-Side Rendering">SSR</abbr> adapter — each with its own dependency tree, its own versioning cadence, and its own integration surface.

## Try It

The full source is on [GitHub](https://github.com/chapeaux/cpx-store). Install it and start building:

```bash
# Using JSR (recommended)
deno add jsr:@chapeaux/cpx-store

# Using npm
npm install @chapeaux/cpx-store
```

Two entry points, one <abbr title="Application Programming Interface">API</abbr>:

```javascript
// Browser — Web Component with DOM events
import { CPXStore } from '@chapeaux/cpx-store';

// Server / CLI / tests — plain class, no DOM
import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';
```

The [previous article's Tab Party demo](/blog/2026-04-16-cpx-store-cross-tab/) still works — the `persist` attribute, `sync()` method, and `change` events are all preserved. The difference is that behind those same entry points, the store can now handle workloads that would have brought the original 162-line version to its knees — and it can do it on the server, too.
