+++
title = "Every Geoff Site Is Now an AI-Queryable Knowledge Base"
date = 2026-05-07
template = "blog-page.html"
type = "Blog Post"
description = "Geoff sites can now expose their RDF knowledge graph to AI agents via MCP manifests and a WASM SPARQL engine. Zero server cost, zero API to maintain — agents download the engine and data, then query locally."
+++

Static sites are supposed to be simple. You build HTML, deploy it to a CDN, and forget about it. No servers, no APIs, no compute costs. But AI agents in 2026 want to *query* your content, not just scrape it. They want structured answers — "list all blog posts about Rust published this year" or "find components that support dark mode." That requires either a running API server or a creative alternative.

Geoff chose the creative alternative.

## The Problem

Every AI agent framework — Claude Desktop, PydanticAI, LangGraph, CrewAI — supports tool use. An agent can call a function, get structured results, and reason about them. But the standard pattern requires a running server: the agent sends a request, the server processes it, the server returns results.

For a static site, that means you need to stand up and maintain an API server just so agents can ask questions about your content. That defeats the purpose of going static in the first place.

## The Solution: Portable SPARQL

Geoff sites already have a queryable knowledge graph. Every page's frontmatter becomes RDF triples, stored in an Oxigraph graph, and exported as N-Triples files at build time. The browser search component loads these files and runs SPARQL queries client-side via Oxigraph WASM.

The insight: if a browser can download a WASM engine and query data locally, so can an AI agent.

### How It Works

```toml
# geoff.toml
[search]
enabled = true
partition = "section"

[mcp]
enabled = true
```

When you build the site, Geoff generates:

```
dist/
├── .well-known/
│   └── mcp.json           # Discovery manifest
├── bin/
│   ├── geoff-sparql.wasm   # WASM SPARQL engine
│   └── geoff-sparql.wit    # Interface definition
├── search.nt               # Full RDF graph
└── search/
    ├── elements.nt         # Partition (on-demand)
    └── tokens.nt           # Partition (on-demand)
```

The `.well-known/mcp.json` manifest follows the Model Context Protocol convention for tool discovery:

```json
{
  "mcp_version": "1.0",
  "tools": [{
    "name": "sparql_query",
    "description": "Execute a SPARQL query against the site's knowledge graph",
    "runtime": "wasm-wasi",
    "binary_url": "https://example.com/bin/geoff-sparql.wasm",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" }
      },
      "required": ["query"]
    },
    "fixed_arguments": {
      "dataset_url": "https://example.com/search.nt"
    }
  }]
}
```

### The Agent's Perspective

An AI agent encounters a Geoff site and wants to understand its content:

1. **Discover:** Fetch `/.well-known/mcp.json` — learns the site has a `sparql_query` tool
2. **Load:** Download the WASM binary (~2.6MB, cacheable) and the N-Triples data
3. **Query:** Execute SPARQL in a sandboxed WASM runtime — no network needed after initial load
4. **Reason:** Use the structured results to answer user questions

The agent runtime (Wasmtime, Wasmer, or a browser) provides the CPU cycles. The static site serves files. The publisher pays nothing beyond CDN bandwidth.

### One Engine, Two Contexts

The `geoff-sparql-wasm` crate compiles to a WASM module that works in both:

- **Browsers:** The `<geoff-search>` and `<geoff-faceted-search>` components import it as an ES module, replacing the previous CDN dependency on Oxigraph
- **Agent runtimes:** The WIT interface (`geoff-sparql.wit`) defines a typed contract that any WASI-compatible runtime can use

Same engine. Same data. Same query results. A human searching the site and an AI agent querying it see identical information because they're running the same code against the same graph.

### What This Means

**Zero compute cost.** The agent does all the work. Your site serves static files — the same files it was already serving for browser search.

**Version coherence.** The WASM engine and the data are built together. There's no API version mismatch, no stale cache, no eventual consistency problem.

**Offline capable.** Once an agent downloads the WASM and data, it can query without network access. Useful for air-gapped environments or batch processing.

**Faceted access.** When search partitioning is enabled, the manifest lists available datasets. An agent can load only the partition it needs — elements, tokens, blog posts — instead of the full graph.

**No API to maintain.** No server to patch. No rate limiting to configure. No authentication to manage. Deploy to any static host and agents can query it immediately.

## Configuration

```toml
[mcp]
enabled = true              # Generate manifest + WIT
wasm_source = "cdn"         # "cdn" or "local" (bundle WASM in dist/)
wasm_url = ""               # Custom WASM URL (override)
description = ""            # Custom tool description

[search]
enabled = true
partition = "section"       # Optional: split data by section
```

Build the WASM engine (one-time):

```sh
cd crates/geoff-sparql-wasm
wasm-pack build --target web --release
# Copy pkg/ to static/bin/ for local hosting
```

Or reference the CDN-hosted version (default) — no build step needed.

## Try It

```sh
cargo install chapeaux-geoff
geoff init my-site --template blog
```

Add `[mcp] enabled = true` to `geoff.toml`, build, and check `dist/.well-known/mcp.json`. Your static site is now agent-queryable.
