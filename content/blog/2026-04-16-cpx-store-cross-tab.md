+++
title = "Syncing State Across Browser Tabs with CPX Store"
date = 2026-04-16
template = "blog-page.html"
type = "Blog Post"
description = "A practical walkthrough of cross-tab state synchronization using cpx-store — a reactive Web Component that turns localStorage into a real-time communication channel between browser tabs."
+++

Open two browser tabs to the same page. Click a button in one. Nothing happens in the other. That is the default. Every tab is an island — separate JavaScript runtime, separate DOM, separate state. Most applications simply accept this and move on.

But browsers already have a mechanism for tabs to talk to each other, and it requires zero servers, zero WebSockets, and zero configuration. It is the [`storage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event) event — fired automatically by the browser whenever `localStorage` changes, delivered to every other tab on the same origin. [CPX Store](https://github.com/chapeaux/cpx-store) builds on this to make cross-tab state synchronization a one-line feature.

This article walks through how that works, and builds a small demo you can try right now: a synchronized counter and theme switcher that stays in lockstep across every tab you open.

## The Mechanism: How Tabs Already Talk

When one tab writes to `localStorage`, the browser fires a `storage` event in every *other* tab on the same origin. The event carries the key that changed, the old value, and the new value. This is not a polyfill or a library feature — it is part of the [Web Storage API](https://html.spec.whatwg.org/multipage/webstorage.html#the-storage-event), supported in every browser since <abbr title="Internet Explorer">IE</abbr> 8.

```javascript
// Tab A writes
localStorage.setItem('count', '42');

// Tab B receives (automatically, no setup)
window.addEventListener('storage', (e) => {
  console.log(e.key);      // "count"
  console.log(e.newValue);  // "42"
  console.log(e.oldValue);  // whatever it was before
});
```

The catch: the event only fires in *other* tabs, not the one that wrote the value. This is by design — the writing tab already knows what it just did. But it means you need careful coordination to avoid infinite loops (Tab A writes, Tab B receives and writes back, Tab A receives...).

CPX Store handles this coordination for you.

## CPX Store in 30 Seconds

[CPX Store](https://github.com/chapeaux/cpx-store) is a reactive state management Web Component. It wraps a JavaScript `Proxy` around a plain object so that every property assignment is intercepted — triggering change events, recording history for undo/redo, and optionally persisting to `localStorage`. It also supports [memoized computed properties](https://github.com/chapeaux/cpx-store/blob/main/src/cpx-store.ts) with explicit dependency lists and a lightweight `dispatch()` method for structured async actions.

The entire base class is [about 160 lines of TypeScript](https://github.com/chapeaux/cpx-store/blob/main/src/cpx-store.ts). No dependencies. No build step required. It works in Chrome, Firefox, Safari, and Edge.

A minimal store:

```javascript
import { CPXStore } from '@chapeaux/cpx-store';

class CounterStore extends CPXStore {
  constructor() {
    super({ count: 0 });
  }
}

customElements.define('counter-store', CounterStore);
```

```html
<counter-store id="myStore"></counter-store>
```

After the element connects to the <abbr title="Document Object Model">DOM</abbr>, `store.state.count++` triggers a `change` event on the element and an `app-state-update` event on `window`. Any component listening will update. The Proxy intercept means there is no `.setState()` call, no action dispatch, no reducer — just assignment.

## Adding Cross-Tab Sync

To persist state and sync it across tabs, add a `persist` attribute with a storage key:

```html
<counter-store persist="demo-counter"></counter-store>
```

That is it. CPX Store handles everything automatically:

1. **Restore** — On connect, persisted state is restored from `localStorage` before any events fire
2. **Persist** — Every state change is written to `localStorage` under the key `demo-counter`
3. **Sync** — A `storage` event listener picks up changes from other tabs and applies them via the base class's `sync()` method, which guards against write-back loops automatically

Under the hood, `sync()` sets an internal `_isSyncing` flag before applying state. This tells the Proxy's `set` trap not to write back to `localStorage` — preventing the infinite loop where Tab A writes, Tab B receives and writes back, Tab A receives again. The flag is transparent to consumers: middleware still runs, change events still fire, history still records. You never need to touch `_isSyncing` directly.

The `sync()` method is also the public <abbr title="Application Programming Interface">API</abbr> for applying remote state from any transport — <abbr title="Server-Sent Events">SSE</abbr>, WebSockets, Solid, or anything else. More on that in the [cross-device section](#beyond-tabs-cross-device-state-sync) below.

### Side Effects with `onStorageChanged`

If you need to do something when remote state arrives — whether from another tab or from `sync()` — override `onStorageChanged`. It works like the native Web Components `attributeChangedCallback` pattern: the base class handles the plumbing, and you get a clean hook for domain logic.

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

The callback receives the new state (already applied) and a snapshot of the old state, so you can compare and act on specific changes. If you don't need side effects, don't override it — cross-tab sync works without it.

## A Fun Demo: The Tab Party

Here is a complete example you can paste into a single <abbr title="HyperText Markup Language">HTML</abbr> file and open in multiple tabs. It synchronizes a click counter and a color theme across every tab on the same origin.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tab Party</title>
  <style>
    :root { --bg: #fafafa; --fg: #111; --accent: #0066cc; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem;
           background: var(--bg); color: var(--fg); transition: all 0.3s; }
    body.ocean  { --bg: #0a2540; --fg: #e0f0ff; --accent: #00d4ff; }
    body.sunset { --bg: #1a0a2e; --fg: #ffd6e0; --accent: #ff6b9d; }
    body.forest { --bg: #0a1f0a; --fg: #c8e6c9; --accent: #66bb6a; }
    h1 { font-size: 2rem; }
    .count { font-size: 4rem; font-weight: 800; color: var(--accent); }
    button { padding: 0.5rem 1rem; margin: 0.25rem; border: 2px solid var(--accent);
             background: transparent; color: var(--accent); border-radius: 6px;
             cursor: pointer; font-size: 1rem; }
    button:hover { background: var(--accent); color: var(--bg); }
  </style>
</head>
<body>
  <party-store persist="tab-party"></party-store>

  <h1>Tab Party</h1>
  <p class="count" id="count-display">0</p>
  <button id="btn-inc">+1</button>
  <button id="btn-dec">&minus;1</button>
  <button id="btn-undo">Undo</button>
  <button id="btn-redo">Redo</button>
  <hr>
  <button data-theme="">Default</button>
  <button data-theme="ocean">Ocean</button>
  <button data-theme="sunset">Sunset</button>
  <button data-theme="forest">Forest</button>

  <script type="module">
    import { CPXStore } from 'https://esm.sh/@chapeaux/cpx-store';

    class PartyStore extends CPXStore {
      constructor() {
        super(
          { count: 0, theme: '' },
          [(prop, val) => console.log(`[sync] ${prop} = ${val}`)]
        );
      }
    }

    customElements.define('party-store', PartyStore);

    // Wait for the element to connect, then wire up the UI
    await customElements.whenDefined('party-store');
    const store = document.querySelector('party-store');

    // Render on every change
    store.addEventListener('change', (e) => {
      const { prop, value } = e.detail;
      if (prop === 'count')
        document.getElementById('count-display').textContent = value;
      if (prop === 'theme')
        document.body.className = value;
    });

    // Initial render
    document.getElementById('count-display').textContent = store.state.count;
    document.body.className = store.state.theme;

    // Button handlers
    document.getElementById('btn-inc').onclick = () => store.state.count++;
    document.getElementById('btn-dec').onclick = () => store.state.count--;
    document.getElementById('btn-undo').onclick = () => store.undo();
    document.getElementById('btn-redo').onclick = () => store.redo();

    document.querySelectorAll('[data-theme]').forEach(btn => {
      btn.onclick = () => store.state.theme = btn.dataset.theme;
    });
  </script>
</body>
</html>
```

Open this file in two (or ten) tabs. Click the increment button in one — the counter updates in all of them. Switch the theme to "Ocean" — every tab fades to dark blue. Hit Undo in any tab — the last change rolls back everywhere.

### What Is Happening

1. Tab A clicks "+1". The Proxy `set` trap fires: middleware logs the change, history records a delta (just the property name and old/new values — not a full state snapshot), `localStorage.setItem('tab-party', ...)` persists the new state, and a `change` event updates Tab A's <abbr title="User Interface">UI</abbr>.

2. The browser delivers a `storage` event to Tabs B, C, D (every other tab on the same origin). The base class receives it, sets `_isSyncing = true`, applies the new state via `Object.assign` through the Proxy, then calls `onStorageChanged` (if overridden). The Proxy fires `change` events for each updated property, updating the <abbr title="User Interface">UI</abbr> — but the persistence step is skipped because `_isSyncing` is true.

3. Result: all tabs are in sync, no loops, no server, no WebSockets. The `PartyStore` class is 8 lines — no manual event listeners, no restore logic, no sync guards.

## Things Worth Noticing

**It works offline.** There is no network involved. `localStorage` is a browser-local <abbr title="Application Programming Interface">API</abbr>. You can disconnect from the internet, open tabs, and they still sync.

**Undo/redo is per-tab.** Each tab maintains its own `_history` array of property-level deltas. If Tab A makes three changes and Tab B makes one, hitting Undo in Tab A rolls back Tab A's last change — not Tab B's. This is usually what you want: undo is a local editing concept, not a global one. History is capped at 100 entries by default (configurable via the `maxHistory` constructor option) to prevent unbounded memory growth in long-running sessions.

**The `storage` event is same-origin only.** Tabs must share the same protocol, host, and port. `http://localhost:3000` and `http://localhost:3001` are different origins — their stores will not sync.

**State is JSON-serializable.** Because the sync mechanism uses `JSON.stringify` / `JSON.parse`, the state must be serializable. Functions, DOM nodes, `Map`, `Set`, and circular references will not survive the round-trip. Stick to plain objects, arrays, strings, numbers, and booleans.

## Beyond Tabs: Cross-Device State Sync

The `storage` event only works within a single browser on a single device. To synchronize state across phones, laptops, and tablets — or between different users entirely — you need a server in the middle. The good news: CPX Store's architecture does not change. The Proxy interception, the middleware pipeline, the `_isSyncing` guard, and the event broadcasting all work exactly the same way. You swap the transport, not the pattern.

Here are four approaches, each suited to different needs.

### Server-Sent Events (<abbr title="Server-Sent Events">SSE</abbr>)

The simplest server-side option. A client sends state changes to the server via a standard `POST` request. The server fans those changes out to every other connected client through a persistent <abbr title="Server-Sent Events">SSE</abbr> stream — a one-way channel that the browser manages natively via the [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) <abbr title="Application Programming Interface">API</abbr>.

<abbr title="Server-Sent Events">SSE</abbr> runs over plain <abbr title="HyperText Transfer Protocol">HTTP</abbr>, so it traverses corporate proxies, load balancers, and <abbr title="Content Delivery Network">CDN</abbr>s without special configuration. The browser handles reconnection automatically — if the connection drops, `EventSource` re-establishes it and picks up where it left off, with no application code required. For most state synchronization use cases — settings, preferences, dashboards, collaborative forms — <abbr title="Server-Sent Events">SSE</abbr> provides everything you need with the least operational complexity.

The Chapeaux ecosystem already uses this pattern: [oxigraph-cloud](https://github.com/chapeaux/oxigraph-cloud) delivers real-time change notifications via <abbr title="Server-Sent Events">SSE</abbr> using the [<abbr title="World Wide Web Consortium">W3C</abbr> Solid Notifications Protocol](https://solidproject.org/TR/notifications-protocol). The same infrastructure that pushes knowledge graph updates to a web <abbr title="User Interface">UI</abbr> could push store state to any connected device.

A store that syncs over <abbr title="Server-Sent Events">SSE</abbr> looks like this:

```javascript
class SyncedStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });

    // Subscribe to remote changes
    const events = new EventSource('/api/store/stream');
    events.onmessage = (e) => this.sync(JSON.parse(e.data));
  }

  onStorageChanged(newState, oldState) {
    // Push local changes to the server
    fetch('/api/store/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

The `sync()` call applies the remote state through the Proxy (so <abbr title="User Interface">UI</abbr> components update), guards against write-back loops, and calls `onStorageChanged` — which handles the outbound direction, posting local changes to the server. The server fans those changes out to every other connected `EventSource`.

### WebSockets

Where <abbr title="Server-Sent Events">SSE</abbr> is one-way (server to client), WebSockets are full duplex — state changes flow in both directions over a single persistent connection. This eliminates the separate `POST` step: the client writes to the WebSocket, and the server broadcasts to all other clients on the same socket.

The benefit is lower latency for high-frequency updates — think collaborative cursors, live drawing, or real-time gaming. The tradeoff is operational: WebSocket connections are stateful, so they require sticky sessions or a pub/sub layer (like [Redis](https://redis.io/)) behind a load balancer. They also do not auto-reconnect by default — you need to handle that in application code or use a library like [reconnecting-websocket](https://github.com/pladaria/reconnecting-websocket).

For applications where updates happen every few seconds rather than many times per second, <abbr title="Server-Sent Events">SSE</abbr> is usually the better choice. WebSockets earn their complexity when latency matters more than simplicity.

```javascript
class RealtimeStore extends CPXStore {
  constructor() {
    super({ count: 0, theme: 'light' });

    this.ws = new WebSocket('wss://example.com/store');
    this.ws.onmessage = (e) => this.sync(JSON.parse(e.data));
  }

  onStorageChanged(newState, oldState) {
    // Send local changes to all other clients
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(newState));
    }
  }
}
```

The same `sync()` call, the same `onStorageChanged` hook — only the transport object changes. Both directions share a single connection, so state changes propagate with one network round-trip instead of two.

### Solid Pods

[Solid](https://solidproject.org/) is a <abbr title="World Wide Web Consortium">W3C</abbr> specification for decentralized data storage. Each user owns a **pod** — a personal data store that applications read from and write to with the user's permission. State lives in the pod as a resource (a <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> document, a Turtle file, or any <abbr title="Resource Description Framework">RDF</abbr> format), and changes are broadcast to subscribers via the Solid Notifications Protocol.

The benefit is architectural: the user controls their data, not the application. Two different applications can read and write the same pod resource — a settings panel on your laptop and a companion app on your phone — without either application needing to know about the other. Access control, authentication, and data portability are handled by the Solid specification rather than by each application independently.

This is the most opinionated option and the most aligned with the Chapeaux project's direction. It also requires a Solid pod provider (self-hosted or third-party) and familiarity with <abbr title="Resource Description Framework">RDF</abbr> serialization. For teams already working with linked data, it is a natural fit. For teams that are not, <abbr title="Server-Sent Events">SSE</abbr> or WebSockets will get you cross-device sync with fewer moving parts.

```javascript
class PodStore extends CPXStore {
  constructor(podUrl) {
    super({ count: 0, theme: 'light' });
    this.resourceUrl = `${podUrl}/app/state.json`;

    // Subscribe to changes via Solid Notifications
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
    // Write state back to the pod resource
    fetch(this.resourceUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newState),
    });
  }
}
```

The Solid Notifications stream tells the store *that* the resource changed — the store then fetches the new state from the pod. Writes go directly to the pod via `PUT`. The pod handles access control, so multiple applications and devices can share the same resource without coordinating with each other.

### <abbr title="Conflict-free Replicated Data Type">CRDT</abbr>s

The three approaches above all assume a simple model: the most recent write wins. That works for settings, counters, and most application state. But for true multi-device collaboration — two people editing the same document at the same time, or a user making changes offline that need to merge cleanly when they reconnect — last-write-wins silently drops data.

[<abbr title="Conflict-free Replicated Data Type">CRDT</abbr>s](https://crdt.tech/) (Conflict-free Replicated Data Types) are data structures designed to merge concurrent edits without conflicts. Libraries like [Yjs](https://yjs.dev/) and [Automerge](https://automerge.org/) provide <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> implementations for maps, arrays, and text that can sync over any transport — WebSocket, WebRTC, or even sneakernet.

CPX Store's middleware pipeline is a natural integration point: a middleware function can intercept every state change, feed it into the <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> document, and apply remote <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> updates back through the Proxy. The store remains the single source of truth for the <abbr title="User Interface">UI</abbr>; the <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> handles the merge semantics underneath.

This is the most powerful option and the most complex. Reach for it when you need offline-first collaboration with guaranteed convergence — not for a shared theme toggle.

## Why This Is Hard in React

React's state management ecosystem is large, mature, and entirely framework-specific. [Redux](https://redux.js.org/), [Zustand](https://zustand-demo.pmnd.rs/), [Jotai](https://jotai.org/), [Recoil](https://recoiljs.org/) — each solves the same fundamental problem (reactive state with change propagation), and each is tightly coupled to React's rendering model. That coupling creates friction when state needs to leave the React tree.

Cross-tab sync in Redux requires middleware that serializes the store to `localStorage` and deserializes it on `storage` events — effectively reimplementing what CPX Store does in its base class, but layered on top of Redux's action/reducer/dispatch machinery. Cross-device sync adds another middleware layer for the network transport. Each layer must integrate with Redux's specific patterns: dispatching actions, handling thunks or sagas, managing serialization of the entire store shape. The same is true for Zustand's `persist` middleware, Jotai's atomWithStorage, and every other framework-specific solution.

CPX Store sidesteps this because it operates at a lower level — the <abbr title="Document Object Model">DOM</abbr>. A `<counter-store>` element is a <abbr title="Document Object Model">DOM</abbr> node. Any JavaScript on the page can read its `.state`, listen to its `change` events, or set properties on it. React components, Vue components, Svelte components, jQuery plugins, and plain `<script>` tags all interact with it the same way — through the <abbr title="Document Object Model">DOM</abbr> <abbr title="Application Programming Interface">API</abbr> that every framework already knows how to use.

This means the sync logic — whether `localStorage`, <abbr title="Server-Sent Events">SSE</abbr>, WebSocket, or <abbr title="Conflict-free Replicated Data Type">CRDT</abbr> — lives in the store itself, not in framework-specific middleware. It works the same regardless of what renders the <abbr title="User Interface">UI</abbr>. If you migrate from React to Vue, or from Vue to vanilla Web Components, the store and all its sync behavior come along unchanged. The state layer and the rendering layer are decoupled by design, because Web Components and the <abbr title="Document Object Model">DOM</abbr> are the decoupling layer.

The base class is not a limitation — it is the point. There is nothing framework-specific to outgrow.

## Try It

Install CPX Store and build something that talks across tabs:

```bash
# Using JSR (recommended)
deno add jsr:@chapeaux/cpx-store

# Using npm
npm install @chapeaux/cpx-store
```

CPX Store is published to [JSR](https://jsr.io/@chapeaux/cpx-store) with full TypeScript source — no build step, no `.d.ts` files to maintain, just import and go. It is also available on [npm](https://www.npmjs.com/package/@chapeaux/cpx-store) for projects that use Node-based tooling.

The full source is on [GitHub](https://github.com/chapeaux/cpx-store). Cross-tab sync requires zero additional code — just add `persist="your-key"` to the <abbr title="HyperText Markup Language">HTML</abbr> element. Override `onStorageChanged` if you need side effects. Call `sync()` to apply remote state from any transport. That is less code than most framework tutorials spend on their `package.json`.
