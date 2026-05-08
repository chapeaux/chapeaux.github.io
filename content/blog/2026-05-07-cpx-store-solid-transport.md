+++
title = "CPX Store as a Reactive State Layer for Solid Pod Applications"
date = 2026-05-07
template = "blog-page.html"
type = "Blog Post"
description = "Solid pods give users data sovereignty. CPX Store gives applications reactive state. The new SolidTransport bridges them — the collab plugin's SyncTransport interface, pointed at a pod resource, with W3C Solid Notifications for real-time updates."
+++

[Solid](https://solidproject.org/) has solved the hard problems. Authentication, access control, data portability, decentralized identity — the protocol stack is real, specified, and shipping. What Solid has not solved — by design — is how an application should manage local state on top of a pod. The protocol tells you how to read, write, and subscribe. It does not tell you how to keep a <abbr title="User Interface">UI</abbr> reactive while doing so.

Most Solid applications today use [`@inrupt/solid-client`](https://docs.inrupt.com/developer-tools/javascript/client-libraries/) or raw `fetch()` calls, then manually wire up local state, cache invalidation, and <abbr title="User Interface">UI</abbr> updates. The [previous](/blog/2026-04-16-cpx-store-cross-tab/) [articles](/blog/2026-04-23-cpx-store-scales-up/) in this series sketched a Solid Pod Store using CPX Store's `sync()` and `onSyncReceived` methods — a manual integration that worked but required hand-coding the entire fetch-subscribe-write lifecycle.

CPX Store now ships a `SolidTransport` that does this for you. The same `SyncTransport` interface that powers `BroadcastChannelTransport` and `WebSocketTransport`, pointed at a pod resource, with the <abbr title="World Wide Web Consortium">W3C</abbr> Solid Notifications Protocol handling real-time updates.

## What Solid App Developers Deal With Today

Three friction points come up repeatedly in Solid app development, and none of them are protocol bugs — they are application-layer problems that the protocol deliberately leaves to developers.

**Manual state management.** Reading a pod resource returns <abbr title="Resource Description Framework">RDF</abbr> — Turtle, <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>, or N-Triples depending on content negotiation. The developer must parse it, maintain a local copy in whatever shape the <abbr title="User Interface">UI</abbr> needs, and update the <abbr title="Document Object Model">DOM</abbr> when that copy changes. There is no reactive binding between the pod resource and the rendered page. It is imperative all the way down: fetch, parse, render, repeat.

**Notification-driven re-fetch.** The [<abbr title="World Wide Web Consortium">W3C</abbr> Solid Notifications Protocol](https://solidproject.org/TR/notifications-protocol) tells you *that* a resource changed — you receive an `Update` event on an `EventSource` stream. It does not tell you *what* changed. The application must re-fetch the entire resource and diff it against local state to figure out which properties actually moved. For small resources this is fine. For a document with hundreds of fields, it is wasteful and error-prone.

**No offline story.** If the pod is unreachable — the user is on an airplane, the server is down, the network is slow — the application stalls. There is no local cache that stays reactive and syncs when connectivity returns. Some apps work around this with `localStorage` snapshots, but those are hand-rolled and disconnected from the Solid read/write lifecycle.

These are not flaws in the Solid specification. They are the kind of application-layer plumbing that a reactive state management system is designed to handle.

## How CPX Store Fits

CPX Store's collab plugin defines a [`SyncTransport`](https://github.com/chapeaux/cpx-store/blob/main/src/types.ts) interface with four methods. Each one maps to a step in the Solid protocol lifecycle:

| `SyncTransport` Method | Solid Protocol Operation |
|---|---|
| `connect()` | Fetch the initial resource state, discover the Solid Notifications endpoint, open an `EventSource` |
| `send(op)` | Batch property changes and write them back to the pod via `PUT` |
| `onReceive(handler)` | Register a handler that fires when the Solid Notifications stream delivers an `Update`, re-fetches the resource, and diffs it against local state |
| `disconnect()` | Close the `EventSource` |

The store itself — Proxy-based reactivity, microtask-coalesced events, computed properties with auto-tracking, `batch()` and `transaction()` — runs locally and does not care where the data lives. The transport is a plug. Swap `WebSocketTransport` for `SolidTransport`, and the entire plugin ecosystem — history, persistence, middleware, collab — comes along unchanged.

The headless core (`CPXStoreCore`) means this works without a browser, too. A server-side process could use `CPXStoreCore` with a `SolidTransport` to keep a local state cache in sync with a pod — useful for <abbr title="Server-Side Rendering">SSR</abbr>, <abbr title="Command-Line Interface">CLI</abbr> tools, or background workers.

## Using the SolidTransport

Import it alongside the collab plugin:

```javascript
import { CPXStore } from '@chapeaux/cpx-store';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { SolidTransport } from '@chapeaux/cpx-store/transports/solid';

class PreferencesStore extends CPXStore {
  constructor(podUrl) {
    super(
      { theme: 'light', fontSize: 16, sidebarOpen: true },
      collabPlugin({
        transport: new SolidTransport(
          `${podUrl}/apps/preferences.json`,
          { fetch: authenticatedFetch }
        )
      })
    );
  }
}

customElements.define('preferences-store', PreferencesStore);
```

The constructor takes two arguments: the pod resource <abbr title="Uniform Resource Locator">URL</abbr> and an options object. The `fetch` option accepts an authenticated fetch function — from [`@inrupt/solid-client-authn-browser`](https://docs.inrupt.com/developer-tools/javascript/client-libraries/), from Chapeaux's own [`geoff-solid-auth`](https://github.com/chapeaux/geoff), or from any <abbr title="OpenID Connect">OIDC</abbr> library that produces a `fetch` wrapper. If omitted, it falls back to `globalThis.fetch` for public resources.

```javascript
// For headless / server-side use — same transport, no DOM
import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';

const store = new CPXStoreCore(
  { theme: 'light', fontSize: 16 },
  collabPlugin({
    transport: new SolidTransport(podResourceUrl, { fetch: serverFetch })
  })
);

store.onChange((changes) => {
  for (const [prop, { val }] of changes) {
    console.log(`Pod updated: ${prop} = ${val}`);
  }
});
```

The store consumer does not know or care that data lives in a Solid pod. `store.state.theme = 'dark'` triggers the same reactive pipeline — Proxy intercept, microtask-coalesced event, <abbr title="User Interface">UI</abbr> update — and the transport handles persistence to the pod. Swap `SolidTransport` for `WebSocketTransport` and nothing else changes.

### What Happens Under the Hood

On `connect()`, the transport fetches the pod resource to populate its initial state, then discovers the Solid Notifications endpoint from the resource's `Link` headers (per the <abbr title="World Wide Web Consortium">W3C</abbr> spec) and opens an `EventSource`. You can also pass a `notificationsUrl` option directly if your pod uses a non-standard discovery mechanism.

Outbound writes are batched via `queueMicrotask` — multiple property changes in the same synchronous block produce a single `PUT` to the pod, mirroring how the store itself coalesces `change` events. Failed writes are re-queued automatically.

Inbound notifications trigger a re-fetch of the resource. The transport diffs the fetched state against its last known copy and emits a `StateOperation` for each property that actually changed. <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> `@context` and other `@`-prefixed keys are skipped during diffing, so the transport works with both plain <abbr title="JavaScript Object Notation">JSON</abbr> and <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> resources.

## The <abbr title="Resource Description Framework">RDF</abbr> Question

The transport reads and writes <abbr title="JavaScript Object Notation">JSON</abbr> resources in the pod. This is valid — pods can store any media type — but plain <abbr title="JavaScript Object Notation">JSON</abbr> does not participate in the linked data web. No other application can discover it via <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr>. No agent can reason about what `theme` or `fontSize` mean.

<abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> is the bridge. It is simultaneously valid <abbr title="JavaScript Object Notation">JSON</abbr> (readable by `JSON.parse`) and valid <abbr title="Resource Description Framework">RDF</abbr> (interpretable by any triple store). Store your pod resource as <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> by adding a `@context` that maps property names to ontology terms:

```json
{
  "@context": {
    "theme": "https://schema.org/cssColorScheme",
    "fontSize": "https://schema.org/cssFontSize",
    "sidebarOpen": "urn:app:preferences#sidebarOpen"
  },
  "theme": "dark",
  "fontSize": 16,
  "sidebarOpen": true
}
```

The JavaScript developer never writes <abbr title="Resource Description Framework">RDF</abbr>. They set `store.state.theme = 'dark'`. The transport writes the update to the pod. Because the `@context` is already in the resource, the update is valid <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>. A <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> query anywhere on the web can now find every application that shares the `schema:cssColorScheme` predicate. This is the Solid promise — data portability and interoperability — delivered through a developer experience that looks like plain JavaScript property assignment.

The transport preserves `@context` across writes — it skips `@`-prefixed keys when diffing but does not strip them from the resource. If the resource starts as <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>, it stays <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>.

[Geoff](https://github.com/chapeaux/geoff) already uses this pattern. Its [Solid Auth component](https://github.com/chapeaux/geoff/blob/main/components/geoff-solid-auth.js) saves design tokens to pods as <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> documents. The [<abbr title="Resource Description Framework">RDF</abbr> and <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> article](/blog/2026-04-05-sparql/) in this blog explores why this matters for web applications more broadly.

## What Chapeaux Has Already Built

The `SolidTransport` is not an isolated experiment. The Chapeaux ecosystem has built and tested every layer of the stack it depends on:

**Geoff Solid Auth** — A Web Component that authenticates against a Solid pod with bearer tokens, reads and writes <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> resources using `PUT` and `GET`, and navigates <abbr title="Linked Data Platform">LDP</abbr> container listings. The `SolidTransport` uses the same authentication and serialization patterns.

**Fascinator** — A real-time collaboration server with [Solid-<abbr title="OpenID Connect">OIDC</abbr>](https://solidproject.org/TR/oidc) authentication, including <abbr title="Demonstration of Proof-of-Possession">DPoP</abbr>-bound access tokens and WebID verification. It persists session metadata as Turtle <abbr title="Resource Description Framework">RDF</abbr> in users' pods. This proves that Solid auth works in a collaborative, multi-user context — exactly the scenario the collab plugin is designed for.

**millie** — A detailed [architecture decision](https://github.com/chapeaux/millie/blob/main/docs/arch/ADR-005-lws-integration.md) for integrating Keycloak with <abbr title="World Wide Web Consortium">W3C</abbr> Linked Web Storage. Covers WebID provisioning, <abbr title="Demonstration of Proof-of-Possession">DPoP</abbr> token binding, and <abbr title="Web Access Control">WAC</abbr> authorization.

**oxigraph-cloud** — An extended [Oxigraph](https://oxigraph.org/) <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> engine with a built-in <abbr title="World Wide Web Consortium">W3C</abbr> Solid Notifications change-data-capture engine. It delivers real-time <abbr title="Resource Description Framework">RDF</abbr> triple changes via <abbr title="Server-Sent Events">SSE</abbr> — the same protocol the `SolidTransport` consumes.

## Open Questions

Several hard problems remain beyond what the transport handles today.

**Granularity of pod writes.** The transport writes the full resource state on every flush. For large state objects, Solid's [N3 Patch](https://solidproject.org/TR/protocol#writing-resources) could update individual triples. Mapping property-level `StateOperation`s to triple-level patches is non-trivial but architecturally possible — the history plugin already does something similar with its `patch` strategy.

**<abbr title="Resource Description Framework">RDF</abbr>-level conflict resolution.** The `ConflictResolver` interface operates on `StateOperation` (property-level). <abbr title="Resource Description Framework">RDF</abbr> conflicts happen at the triple level. A pod resource modified by another application that does not share the same state shape would require a resolver that understands <abbr title="Resource Description Framework">RDF</abbr> semantics, not just property names.

**Offline-first.** CPX Store's persistence plugin already caches state to `localStorage`. Stacking it with the `SolidTransport` for a local-first, sync-when-connected pattern is architecturally possible — the plugin system supports both — but the merge strategy for reconciling offline edits with remote pod state needs design work.

## Try It

Install CPX Store and point a store at a Solid pod:

```bash
# Using JSR (recommended)
deno add jsr:@chapeaux/cpx-store

# Using npm
npm install @chapeaux/cpx-store
```

```javascript
import { SolidTransport } from '@chapeaux/cpx-store/transports/solid';
```

Three transports, one interface. `BroadcastChannelTransport` for same-origin tabs. `WebSocketTransport` for server-mediated multi-user sync. `SolidTransport` for decentralized, user-owned state. The store does not care which one you pick — the reactive pipeline, the plugins, and the developer experience are the same.

The full source is on [GitHub](https://github.com/chapeaux/cpx-store). The Solid Project specification lives at [solidproject.org](https://solidproject.org/). The <abbr title="World Wide Web Consortium">W3C</abbr> Solid Notifications Protocol — the piece that makes real-time subscriptions work — is at [solidproject.org/TR/notifications-protocol](https://solidproject.org/TR/notifications-protocol).
