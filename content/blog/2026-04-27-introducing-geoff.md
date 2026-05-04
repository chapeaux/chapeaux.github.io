+++
title = "Introducing Geoff: A Static Site Generator with a Knowledge Graph Inside"
date = 2026-04-27
template = "blog-page.html"
type = "Blog Post"
description = "Geoff is a Rust-based static site generator that turns Markdown files into a queryable RDF knowledge graph. Write plain frontmatter, get SPARQL queries in templates, JSON-LD in every page, SHACL validation, and client-side search powered by the same Oxigraph engine via WASM."
+++

Static site generators have a content model problem. You write a blog post in Markdown, add some metadata in frontmatter, and the generator turns it into <abbr title="HyperText Markup Language">HTML</abbr>. But the metadata is trapped. It lives in individual files, accessible only through the generator's proprietary template functions — `range .Site.Pages` in [Hugo](https://gohugo.io/), `section.pages` in [Zola](https://www.getzola.org/). Every generator invents its own query language for slicing and filtering content. None of them produce structured data unless you hand-write <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> templates. And none of them can tell you, before you build, whether your content is valid.

[Geoff](https://github.com/chapeaux/geoff) takes a different approach. Every content file becomes a node in an <abbr title="Resource Description Framework">RDF</abbr> knowledge graph, queryable with <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> from inside your templates. Structured data (<abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>) is generated automatically. Content validation rules are expressed as [<abbr title="Shapes Constraint Language">SHACL</abbr>](https://www.w3.org/TR/shacl/) shapes. And you never need to type an <abbr title="Internationalized Resource Identifier">IRI</abbr> — you write `type = "Blog Post"` and Geoff maps it to `schema:BlogPosting` behind the scenes.

This article introduces what Geoff is, how it compares to Hugo and Zola, and where it is headed.

## What Geoff Is

Geoff is a static site generator written in Rust. Single binary, zero runtime dependencies. You write Markdown with <abbr title="Tom's Obvious, Minimal Language">TOML</abbr> frontmatter, and Geoff builds static <abbr title="HyperText Markup Language">HTML</abbr>. In that sense, it is the same species as Hugo and Zola.

The difference is what happens between parsing and rendering. Geoff takes every piece of frontmatter — title, date, author, type, tags, custom fields — and inserts it as <abbr title="Resource Description Framework">RDF</abbr> triples into an in-memory graph backed by [Oxigraph](https://oxigraph.org/). By the time templates execute, the entire site is a queryable knowledge graph. Templates can ask questions like "give me all blog posts sorted by date" or "find every page tagged `rust` that was published this year" using standard <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> — not a generator-specific <abbr title="Application Programming Interface">API</abbr>.

A minimal Geoff site:

```
my-site/
├── geoff.toml
├── content/
│   ├── blog/
│   │   └── hello.md
│   └── about.md
├── templates/
│   ├── base.html
│   ├── page.html
│   └── blog.html
└── ontology/
    └── mappings.toml
```

The config is two lines:

```toml
base_url = "https://example.com"
title = "My Site"
```

A content file looks like any other static site generator:

```markdown
+++
title = "Hello World"
date = 2026-04-27
template = "blog-page.html"
type = "Blog Post"
description = "My first post."
+++

# Hello World

This is a blog post.
```

No <abbr title="Resource Description Framework">RDF</abbr> syntax. No <abbr title="Internationalized Resource Identifier">IRI</abbr>s. Just frontmatter fields that Geoff maps to ontology terms automatically.

## How the Graph Works

When Geoff processes `hello.md`, it creates triples like:

```
<urn:geoff:content:blog/hello.md>  schema:name         "Hello World" .
<urn:geoff:content:blog/hello.md>  schema:datePublished "2026-04-27" .
<urn:geoff:content:blog/hello.md>  rdf:type             schema:BlogPosting .
<urn:geoff:content:blog/hello.md>  schema:description   "My first post." .
```

Each page gets its own named graph, so you can query specific pages or the entire site. The mapping from `type = "Blog Post"` to `schema:BlogPosting` happens through a resolution pipeline:

1. Check `ontology/mappings.toml` for a persisted mapping
2. Try an exact label match against bundled vocabularies (Schema.org, Dublin Core, <abbr title="Friend of a Friend">FOAF</abbr>, <abbr title="Semantically-Interlinked Online Communities">SIOC</abbr>)
3. Fall back to fuzzy matching (Jaro-Winkler similarity, threshold 0.7)

If Geoff finds a high-confidence match (≥ 0.95), it maps automatically and saves the mapping. Otherwise, it prompts you. Either way, the mapping is persisted in `ontology/mappings.toml` so the next build is instant:

```toml
[types]
"Blog Post" = "https://schema.org/BlogPosting"

[properties]
title = "https://schema.org/name"
date = "https://schema.org/datePublished"
```

Once mapped, the same vocabulary terms are used for <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> output, <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries, and <abbr title="Shapes Constraint Language">SHACL</abbr> validation. One mapping drives everything.

## SPARQL in Templates

This is the feature that makes the graph practical for site building. Geoff registers a `sparql()` function in [Tera](https://keats.github.io/tera/) (the same template engine Zola uses), so templates can query the site graph directly:

```html
{% set posts = sparql(query="
  SELECT ?title ?date ?url WHERE {
    GRAPH ?g {
      ?s <https://schema.org/name> ?title .
      ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>
         <https://schema.org/BlogPosting> .
      OPTIONAL { ?s <https://schema.org/datePublished> ?date }
      OPTIONAL { ?s <https://schema.org/url> ?url }
    }
  }
  ORDER BY DESC(?date)
") %}

{% for post in posts %}
  <article>
    <h2><a href="{{ post.url }}">{{ post.title }}</a></h2>
    {% if post.date %}<time>{{ post.date }}</time>{% endif %}
  </article>
{% endfor %}
```

This replaces the bespoke content-query <abbr title="Application Programming Interface">API</abbr>s that every other generator invents. In Hugo, the same listing requires `{{ range .Site.RegularPages }}` with `.Type` filters and `.ByDate` sorting — a Go template <abbr title="Application Programming Interface">API</abbr> that only works in Hugo. In Zola, it is `section.pages | sort(attribute="date") | reverse` — a Tera filter chain that only works in Zola. Both are proprietary. <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> is a <abbr title="World Wide Web Consortium">W3C</abbr> standard with a [specification](https://www.w3.org/TR/sparql12-query/), a formal grammar, and implementations in every major programming language.

The query language is more expressive, too. Want blog posts that share a tag with the current page? Hugo requires a multi-step `intersect` pipeline. Zola cannot do it without taxonomy pages. In Geoff, it is a `JOIN`:

```html
{% set related = sparql(query="
  SELECT DISTINCT ?title ?url WHERE {
    GRAPH ?g1 { <" ~ page_uri ~ "> <https://schema.org/keywords> ?tag }
    GRAPH ?g2 {
      ?other <https://schema.org/keywords> ?tag .
      ?other <https://schema.org/name> ?title .
      ?other <https://schema.org/url> ?url .
      FILTER(?other != <" ~ page_uri ~ ">)
    }
  }
  LIMIT 5
") %}
```

Cross-cutting queries like this are where the graph model earns its keep. The content model is relational, not hierarchical — any page can relate to any other page through shared properties, without filesystem conventions or taxonomy configuration.

## JSON-LD for Free

Every page Geoff builds includes a `<script type="application/ld+json">` block generated from the same triples that feed <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr>:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "BlogPosting",
  "name": "Hello World",
  "datePublished": "2026-04-27",
  "author": { "@type": "Person", "name": "Jane Smith" }
}
</script>
```

In Hugo and Zola, <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> requires a hand-written template partial that reads frontmatter fields and assembles the <abbr title="JavaScript Object Notation">JSON</abbr> manually. Every field must be mapped twice — once in the template logic, once in the <abbr title="JavaScript Object Notation">JSON</abbr> structure. Geoff generates it from the graph, so the <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> is always consistent with the content and always uses the correct Schema.org types.

## SHACL Validation

Geoff can validate your content against [<abbr title="Shapes Constraint Language">SHACL</abbr>](https://www.w3.org/TR/shacl/) shapes before building. A shape is a set of constraints expressed in <abbr title="Resource Description Framework">RDF</abbr> — "every BlogPosting must have a title and a date" — that Geoff checks against the graph:

```bash
geoff validate
# ✓ 0 violations, 2 warnings (3 shapes checked)
```

```bash
geoff shapes
# Generates starter shapes from your existing content
```

Hugo and Zola have no validation mechanism. If a blog post is missing a date, you discover it when the template renders an empty `<time>` element — or when a reader notices. <abbr title="Shapes Constraint Language">SHACL</abbr> catches it at build time with an actionable error.

## How It Compares to Hugo and Zola

All three are fast, single-binary static site generators that take Markdown in and produce <abbr title="HyperText Markup Language">HTML</abbr> out. The differences are in what sits between input and output.

| | Hugo | Zola | Geoff |
|---|---|---|---|
| **Language** | Go | Rust | Rust |
| **Templates** | Go templates | Tera (Jinja2) | Tera (Jinja2) |
| **Content queries** | Go template functions | Tera filters | <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> (<abbr title="World Wide Web Consortium">W3C</abbr> standard) |
| **Structured data** | Manual templates | Manual templates | Automatic <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> |
| **RDFa output** | None | None | Native (template helpers + Markdown syntax) |
| **Content validation** | None | None | <abbr title="Shapes Constraint Language">SHACL</abbr> shapes |
| **Data model** | Filesystem hierarchy | Filesystem hierarchy | <abbr title="Resource Description Framework">RDF</abbr> knowledge graph |
| **Plugin system** | None (Go modules) | None | Rust (cdylib) + Deno (TypeScript) |
| **Dev server** | Built-in | Built-in | Built-in (hot reload via WebSocket) |
| **Theming** | Go template partials | Sass variables | <abbr title="World Wide Web Consortium">W3C</abbr> Design Tokens → <abbr title="Cascading Style Sheets">CSS</abbr> custom properties |
| **Asset optimization** | Hugo Pipes (built-in) | None | lightningcss + WebP + cache hashes |
| **Client-side search** | None (bring your own) | Elasticlunr.js (text index) | Oxigraph <abbr title="WebAssembly">WASM</abbr> (<abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr>, structured queries, <abbr title="Accessible Rich Internet Applications">ARIA</abbr> combobox) |
| **Incremental builds** | Yes | No | Yes (cache-aware) |
| **Ecosystem** | Massive (themes, docs) | Growing | Early |

### Where Hugo and Zola Are Better

**Ecosystem.** Hugo has thousands of themes, extensive documentation, and a decade of community knowledge. Zola has a smaller but mature ecosystem. Geoff has three starter templates and this blog post.

**Build speed for large sites.** Hugo is famously fast — thousands of pages in milliseconds. Geoff uses Rayon for parallel rendering and incremental caching, but it has not been benchmarked against Hugo at scale. For sites under a few hundred pages, the difference is not perceptible.

**Learning curve for templates.** Hugo's Go templates and Zola's Tera filters are well-documented and widely understood. Geoff's <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries are more powerful but have a steeper learning curve for developers who have not encountered query languages before. That said, if you have used <abbr title="Structured Query Language">SQL</abbr>, <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> will feel familiar.

### Where Geoff Is Better

**Cross-cutting content queries.** Any question you can express in <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> — related posts by shared tags, pages grouped by author and date range, content filtered by custom <abbr title="Resource Description Framework">RDF</abbr> properties — is one template call. Hugo and Zola require chained template functions, taxonomy configuration, or workarounds.

**Structured data output.** <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> is generated from the graph, not hand-coded in templates. It uses the correct Schema.org types because the same vocabulary mapping that drives the graph also drives the <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>.

**Content validation.** <abbr title="Shapes Constraint Language">SHACL</abbr> shapes catch missing fields, wrong types, and constraint violations at build time. This is especially valuable for multi-author sites or content managed by non-developers.

**Plugin system.** Geoff supports both native Rust plugins (loaded dynamically via `libloading`) and TypeScript plugins (run as Deno subprocesses via <abbr title="JavaScript Object Notation">JSON</abbr>-<abbr title="Remote Procedure Call">RPC</abbr>). Eight lifecycle hooks — from `on_init` through `on_build_complete` — let plugins modify content, inject template variables, add output files, or react to file changes during dev.

**Client-side search.** Hugo has no built-in search. Zola ships Elasticlunr.js with a <abbr title="JavaScript Object Notation">JSON</abbr> text index — keyword matching, no structure. Geoff's `<geoff-search>` component runs the same Oxigraph <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> engine in the browser via <abbr title="WebAssembly">WASM</abbr>, querying an <abbr title="Resource Description Framework">RDF</abbr> index that preserves content types, tags, dates, and relationships. Faceted search is a <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> `FILTER` clause, not a feature you configure separately.

**Custom <abbr title="Resource Description Framework">RDF</abbr> properties.** Power users can add arbitrary <abbr title="Resource Description Framework">RDF</abbr> triples via a `[rdf.custom]` frontmatter table, queryable in templates like any other property. Hugo and Zola support custom frontmatter fields, but they are not part of a larger queryable data model — they are just key-value pairs scoped to a single page.

## The Plugin System

Geoff plugins implement up to eight async lifecycle hooks:

```rust
#[async_trait]
pub trait Plugin: Send + Sync {
    fn name(&self) -> &str;
    async fn on_init(&self, ctx: &mut InitContext) -> Result<()>;
    async fn on_build_start(&self, ctx: &mut BuildContext) -> Result<()>;
    async fn on_content_parsed(&self, ctx: &mut ContentContext) -> Result<()>;
    async fn on_graph_updated(&self, ctx: &mut GraphContext) -> Result<()>;
    async fn on_validation_complete(&self, ctx: &mut ValidationContext) -> Result<()>;
    async fn on_page_render(&self, ctx: &mut RenderContext) -> Result<()>;
    async fn on_build_complete(&self, ctx: &mut OutputContext) -> Result<()>;
    async fn on_file_changed(&self, ctx: &mut WatchContext) -> Result<()>;
}
```

A reading-time plugin that calculates estimated minutes from word count:

```rust
async fn on_content_parsed(&self, ctx: &mut ContentContext) -> Result<()> {
    let words = ctx.page.raw_body.split_whitespace().count();
    let minutes = (words as f64 / 200.0).ceil() as u64;
    ctx.page.frontmatter.insert(
        "reading_time_minutes".into(), minutes.into()
    );
    Ok(())
}
```

The same plugin in TypeScript, running as a Deno subprocess:

```typescript
import { definePlugin } from "./sdk/mod.ts";

definePlugin({
  name: "reading-time",
  on_content_parsed(ctx) {
    const words = ctx.page.raw_body.split(/\s+/).length;
    const minutes = Math.ceil(words / 200);
    ctx.page.frontmatter.reading_time_minutes = minutes;
  },
});
```

Rust plugins are compiled to `cdylib` and loaded dynamically — native speed, no subprocess overhead. Deno plugins communicate over <abbr title="JavaScript Object Notation">JSON</abbr>-<abbr title="Remote Procedure Call">RPC</abbr> 2.0 on stdin/stdout — easier to write, easier to distribute, no compilation step.

## Dev Experience

```bash
geoff init my-site --template blog    # Scaffold a new site
geoff serve --open                    # Dev server with hot reload
geoff build                           # Build to dist/
geoff validate                        # Check SHACL shapes
geoff new blog/my-post.md --type "Blog Post" --title "My Post"
```

The dev server (`geoff serve`) runs on [Axum](https://github.com/tokio-rs/axum), watches `content/`, `templates/`, and `ontology/` for changes, and pushes reload events over WebSocket. Pages are rendered in memory — no disk writes during development. A `/api/sparql` endpoint lets you test queries against the live graph from your browser or from `curl`.

Incremental builds skip unchanged content files. Templates that use `sparql()` are always re-rendered because their output depends on graph state, not just their own source file.

## Client-Side Search with the Same Engine

Most static site generators bolt on search as an afterthought. Hugo has no built-in search — you bring [Lunr.js](https://lunrjs.com/), [Pagefind](https://pagefind.app/), or Algolia. Zola generates a search index as a <abbr title="JavaScript Object Notation">JSON</abbr> blob and ships [Elasticlunr.js](http://elasticlunr.com/) to query it. Both approaches use a text search engine that knows nothing about the content's structure — you search titles and bodies, maybe filter by section, and get back a list of keyword matches.

Geoff does something different. At build time, it serializes the search-relevant slice of the <abbr title="Resource Description Framework">RDF</abbr> graph — titles, descriptions, dates, <abbr title="Uniform Resource Locator">URL</abbr>s, tags, content types — to an N-Triples file. On the client, a `<geoff-search>` web component lazy-loads [Oxigraph's <abbr title="WebAssembly">WASM</abbr> build](https://www.npmjs.com/package/oxigraph) and runs real <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries against the index in the browser. The same query engine that built the site now searches it.

Enable it in `geoff.toml`:

```toml
[search]
enabled = true
```

Add the component to a template:

```html
<script type="module" src="/geoff-search.js"></script>
<geoff-search></geoff-search>
```

That is it. The build writes a `search.nt` file (20<abbr title="Kilobyte">KB</abbr> for a 42-page site), and the component loads it on first interaction. Oxigraph <abbr title="WebAssembly">WASM</abbr> is ~300<abbr title="Kilobyte">KB</abbr> gzipped, lazy-loaded — it does not affect initial page load. The search index is also available during `geoff serve` — no build required to test search during development.

The search component supports structured query syntax:

- **Multiple terms:** `rust sparql` matches pages containing both words (implicit AND)
- **Quoted phrases:** `"knowledge graph"` matches the exact phrase
- **OR:** `rust OR python` matches pages containing either term
- **AND:** `rust AND sparql` is explicit AND (same as a space)

Queries search both titles and descriptions. `OR` binds looser than AND, so `rust sparql OR python` means "(rust AND sparql) OR python."

The component follows the <abbr title="Accessible Rich Internet Applications">ARIA</abbr> combobox pattern — keyboard navigation with Arrow keys, Enter to select, Escape to close — and positions its results dropdown using <abbr title="Cascading Style Sheets">CSS</abbr> anchor positioning with a fallback for browsers that do not support it yet. Styling is customizable via <abbr title="Cascading Style Sheets">CSS</abbr> custom properties (`--geoff-search-bg`, `--geoff-search-highlight`, etc.) and adapts to dark mode automatically.

Because the index is <abbr title="Resource Description Framework">RDF</abbr>, not a flat text index, the search is inherently faceted. The component's <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> query can filter by content type, tag, date range, or any combination — the same kinds of queries you write in templates. The search index uses the same predicates, the same <abbr title="Internationalized Resource Identifier">IRI</abbr>s, and the same Oxigraph engine as the build-time graph. There is no translation layer between what the server knows and what the client can query. No other static site generator can make that claim.

## Design Token Theming

Geoff now includes a standards-based theming system built on the [<abbr title="World Wide Web Consortium">W3C</abbr> Design Tokens](https://www.designtokens.org/) format (DTCG 2025.10). Themes are <abbr title="JavaScript Object Notation">JSON</abbr> token files that produce <abbr title="Cascading Style Sheets">CSS</abbr> custom properties, with inheritance for derivative themes and <abbr title="Resource Description Framework">RDF</abbr> integration for querying tokens in templates.

A theme file:

```json
{
  "color-critical": {
    "$type": "color",
    "primary": { "$value": "#0066cc" },
    "text": { "$value": "#1a1a1a" }
  }
}
```

Becomes <abbr title="Cascading Style Sheets">CSS</abbr> custom properties:

```css
:root {
  --color-critical-primary: #0066cc;
  --color-critical-text: #1a1a1a;
}
```

Token groups with `-critical` in the name are inlined in `<head>` for the critical rendering path. Everything else loads as a deferred external stylesheet via `<link rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'">` with a `<noscript>` fallback.

Light and dark modes use the <abbr title="Cascading Style Sheets">CSS</abbr> `light-dark()` function with `-on-light` and `-on-dark` primitive variables — no `@media` query duplication, works natively in Shadow <abbr title="Document Object Model">DOM</abbr>.

Themes inherit from parent themes — a derivative theme overrides only what changes, inheriting everything else through deep merge. The `share = true` config publishes the resolved tokens as both DTCG <abbr title="JavaScript Object Notation">JSON</abbr> and N-Triples, so other Geoff sites can reference them as a remote base theme.

Two <abbr title="Command-Line Interface">CLI</abbr> commands support theme development:

- `geoff theme preview` generates a specimen site with color swatches, typography samples, spacing scales, and every template variation
- `geoff theme edit` serves a visual editor with web component <abbr title="User Interface">UI</abbr>, type-adaptive inputs, <abbr title="Shapes Constraint Language">SHACL</abbr> validation, and live <abbr title="Cascading Style Sheets">CSS</abbr> injection into preview iframes

### Asset Optimization

The build pipeline now includes configurable post-processing:

```toml
[theme.optimize]
minify_css = true
minify_js = true
hash_assets = true

[theme.optimize.images]
webp = true
quality = 80
max_width = 1920
```

<abbr title="Cascading Style Sheets">CSS</abbr> is minified via [lightningcss](https://lightningcss.dev/). <abbr title="JavaScript">JS</abbr> gets basic comment and whitespace stripping. Images are converted to WebP and optionally resized. Cache-busting content hashes are appended to <abbr title="Cascading Style Sheets">CSS</abbr>/<abbr title="JavaScript">JS</abbr> filenames with <abbr title="HyperText Markup Language">HTML</abbr> references updated automatically.

## What's New Since Launch

Since the initial release, Geoff has added several major capabilities:

**RDFa output.** Templates can emit RDFa Lite 1.1 attributes using `{{ rdfa_attrs | safe }}`, `{{ rdfa_prop(name="title") | safe }}`, and the `rdfa` filter. Markdown supports inline annotations with `[text](rdfa:property)` syntax. All property names are resolved through the mapping registry — no <abbr title="Internationalized Resource Identifier">IRI</abbr>s needed.

**`[data]` frontmatter.** A new frontmatter section for structured data with friendly names: `[data]\nwordCount = 1500`. Keys are resolved through the mapping registry, and values appear automatically in <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> output.

**Navigation helpers.** `pages()` filters and sorts pages by any frontmatter field. `tree()` builds hierarchical navigation from the <abbr title="Uniform Resource Locator">URL</abbr> structure. Both replace the need for <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> in common navigation patterns.

**Custom vocabulary prefixes.** Declare additional namespaces in `[linked_data.prefixes]` — <abbr title="Simple Knowledge Organization System">SKOS</abbr>, W3C ORG, <abbr title="Data Catalog Vocabulary">DCAT</abbr>, or any custom ontology. They flow to <abbr title="Internationalized Resource Identifier">IRI</abbr> expansion, <abbr title="Resource Description Framework in Attributes">RDFa</abbr> output, and <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> contexts.

**Richer JSON-LD.** The `<script type="application/ld+json">` block now includes all page triples from the graph, not just the five standard fields. Custom fields from `[data]` and `[rdf.custom]` appear automatically. Multi-vocabulary `@context` is generated with only the prefixes actually used.

**URL style.** `[build] url_style = "directory"` produces `/about/` instead of `/about.html`.

**Search improvements.** The `<geoff-search>` component now supports structured query syntax (quotes, AND, OR, multi-term), full keyboard navigation with the <abbr title="Accessible Rich Internet Applications">ARIA</abbr> combobox pattern, <abbr title="Cascading Style Sheets">CSS</abbr> anchor positioning for the results overlay, and dark mode. The search index is also served live during `geoff serve`.

**Default property mappings.** Common frontmatter fields (title, author, date, description, tags, and others) are mapped to Schema.org <abbr title="Internationalized Resource Identifier">IRI</abbr>s by default — no `ontology/mappings.toml` required for standard use cases. User-defined mappings override the defaults.

**Design system / theme separation.** A new `[design]` config section references external design system token files (e.g. from `node_modules`). `geoff theme generate my-brand` reads the design system, detects `-on-light`/`-on-dark` pairs, and generates a `theme.json` with `light-dark()` aggregates and <abbr title="Cascading Style Sheets">CSS</abbr> `var()` fallbacks. The design system is the palette; the theme is the paint scheme. Multiple themes can reference the same design system.

## What Is Planned

Geoff is functional and growing. Here is what is coming:

**Federation.** Linking to external <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> endpoints or other Geoff sites via federated queries. A documentation site could query an <abbr title="Application Programming Interface">API</abbr> reference site's graph at build time to pull in type signatures or changelogs without duplicating content.

**<abbr title="Internationalization — adapting software for different languages and regions">i18n</abbr> driven by <abbr title="Resource Description Framework">RDF</abbr> labels.** The bundled vocabularies already include multilingual labels (`rdfs:label "Product"@en, "Producto"@es`). A future version could generate localized pages by resolving labels to the target language.

**Theme ecosystem.** Starter templates exist for blogs, documentation, and portfolios. A theme registry with installable templates is the next step toward making Geoff practical for people who want to publish, not configure.

## Try It

```bash
# Install
cargo install chapeaux-geoff

# Create a blog
geoff init my-blog --template blog
cd my-blog

# Start writing
geoff serve --open
```

The source is on [GitHub](https://github.com/chapeaux/geoff). It is part of the [Chapeaux](/) ecosystem — a collection of standards-based web development tools.

Geoff is not trying to replace Hugo or Zola for every use case. If you need a theme ecosystem and a decade of community answers on Stack Overflow, Hugo is the right choice. If you want a fast Rust <abbr title="Static Site Generator">SSG</abbr> with good defaults and minimal configuration, Zola is excellent. But if your content has structure — if pages relate to each other through shared properties, if you want your metadata to be queryable and validatable, if you want structured data output without maintaining parallel template logic — Geoff gives you a foundation that filesystem-based generators cannot.
