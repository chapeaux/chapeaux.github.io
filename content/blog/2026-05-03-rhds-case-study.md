+++
title = "Geoff Case Study: Red Hat Design System"
date = 2026-05-03
template = "blog-page.html"
type = "Blog Post"
description = "How we migrated the Red Hat Design System documentation site — 711 pages, 46 web components, and 500+ design tokens — from Eleventy to Geoff. SPARQL-driven navigation, Lit SSR, RDFa output, and client-side search powered by the same Oxigraph engine."

[data]
about = "Static site generators"
creator = "Red Hat UX"
+++

The [Red Hat Design System](https://ux.redhat.com) (<abbr title="Red Hat Design System">RHDS</abbr>) documentation site was migrated from [Eleventy](https://www.11ty.dev/) 3.x to [Geoff](https://github.com/chapeaux/geoff) as a proof-of-concept for a large-scale, real-world site. The original site has 700+ pages, 46 web component element docs, 13 design patterns, 6 foundation sections, design token documentation, and accessibility guides — all built with Lit <abbr title="Server-Side Rendering">SSR</abbr>, custom Eleventy plugins, Nunjucks templates, and <abbr title="YAML Ain't Markup Language">YAML</abbr> frontmatter.

This post walks through how the migration worked, what Geoff features it exercised, and what we learned.

## Migration Scope

The migration converted 711 pages total: 84 documentation pages, 233 element doc pages (overview, style, guidelines, accessibility, and code tabs for each of the 46 components), 382 interactive demos, and 12 token category pages. Content was converted from <abbr title="YAML Ain't Markup Language">YAML</abbr> frontmatter to <abbr title="Tom's Obvious, Minimal Language">TOML</abbr>, Nunjucks templates to Tera, and the 30+ custom Eleventy plugins were replaced with 7 Deno plugins using Geoff's lifecycle hooks.

A Node.js migration script handles the bulk conversion:

1. Reads each Markdown file's <abbr title="YAML Ain't Markup Language">YAML</abbr> frontmatter and converts it to <abbr title="Tom's Obvious, Minimal Language">TOML</abbr>
2. Maps Eleventy layouts to Geoff templates (`basic.njk` → `page.html`, `has-toc.njk` → `page-toc.html`)
3. Assigns Schema.org content types (`Web Page`, `Foundation`, `Guide`, `Pattern`, `Element Documentation`)
4. Generates element doc frontmatter from `data.yaml` metadata files
5. Resolves Nunjucks `{% include %}` directives (accessibility partials) inline
6. Creates demo pages wrapping raw <abbr title="HyperText Markup Language">HTML</abbr> component examples

The script is idempotent — running it again on a new <abbr title="Red Hat Design System">RHDS</abbr> version regenerates all content cleanly.

## SPARQL-Driven Navigation

The original site hardcodes its sidebar navigation structure in an Eleventy config file, with Nunjucks templates iterating over Eleventy collections. In Geoff, the sidebar is driven entirely by <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries against the content graph. Each section — About, Get Started, Foundations, Elements, Patterns, Tokens, Accessibility — is a single `sparql()` call that filters pages by their `navSection` property and sorts by `order`.

For simple sections, the `pages()` function is even more concise:

```html
{%- set nav = pages(section="about", sort="order") -%}
{%- for p in nav -%}
  <a href="{{ p.url }}">{{ p.sidenavTitle | default(value=p.title) }}</a>
{%- endfor -%}
```

The Elements section — 46 components, each with multiple sub-pages — required a <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> query that filtered to only `overview` sections, ensuring the nav showed "Accordion" once rather than listing every tab:

```html
{%- set el = sparql(query="
  SELECT DISTINCT ?name ?elname WHERE {
    GRAPH ?g {
      ?s <urn:rhds:elementName> ?elname ;
         <urn:rhds:section> 'overview' ;
         <https://schema.org/name> ?name .
    }
  } ORDER BY ?name
") -%}
```

Sections with sub-pages (Get Started has Designers and Developers sub-sections, each with their own child pages) use tag-based filtering to show only top-level entries:

```sparql
FILTER(CONTAINS(?tags, 'getstarted'))
```

The active page state uses Tera's `is starting_with` test against the built-in `page_url` variable:

```html
<rh-navigation-vertical-list summary="About"
  {% if nav_url is starting_with("/about") %}open{% endif %}>
```

## Plugin Architecture

Seven Deno plugins replaced the 30+ Eleventy plugins:

**`rhds-site-data`** uses `on_graph_updated` to inject the package version from `package.json` as an <abbr title="Resource Description Framework">RDF</abbr> triple. Templates query it with `sparql()` to populate the masthead version badge. The same plugin also uses `on_page_render` to inject the version as an `extra_var`, ensuring it survives incremental rebuilds in dev mode where `on_graph_updated` may not re-fire.

**`rhds-toc`** uses `on_page_render` to scan the rendered <abbr title="HyperText Markup Language">HTML</abbr> for `<h2>` headings, generate slugified IDs, and produce `<uxdot-toc-item>` light <abbr title="Document Object Model">DOM</abbr> content for the table-of-contents web component. The original Eleventy site used `markdown-it-anchor` and a `toc` filter — in Geoff, it is a 60-line plugin. One subtlety: the regex uses the `g` flag, so `lastIndex` must be reset between pages to avoid inconsistent results.

**`rhds-token-tables`** uses both hooks. `on_graph_updated` inserts every design token as a `schema:DefinedTerm` triple with `schema:termCode`, `schema:value`, and `schema:inDefinedTermSet` — making all 500+ tokens queryable via <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> and searchable via the `<geoff-search>` component. `on_page_render` generates the token reference tables with `<samp>` elements styled via <abbr title="Cascading Style Sheets">CSS</abbr> custom properties (`--samp-color`, `--samp-width`, `--samp-font-family`), grouped by subcategory with headings from <abbr title="World Wide Web Consortium">W3C</abbr> DTCG `$extensions` metadata. The tables include <abbr title="Resource Description Framework in Attributes">RDFa</abbr> annotations — each token row is a `schema:DefinedTerm` with `schema:termCode` and `schema:value` properties, making the token documentation machine-readable directly from the page markup.

**`rhds-import-map`**, **`rhds-dynamic-imports`**, **`rhds-cem-api`**, and **`sitemap`** handle import map generation, per-page component imports, Custom Elements Manifest <abbr title="Application Programming Interface">API</abbr> tables, and sitemap.xml output respectively.

## Web Component SSR

The <abbr title="Red Hat Design System">RHDS</abbr> site uses 46 [Lit](https://lit.dev/)-based web components for its documentation chrome and interactive examples. Geoff's `component()` template function with `renderer="lit"` enables server-side rendering via `@lit-labs/ssr`, producing declarative shadow <abbr title="Document Object Model">DOM</abbr> `<template shadowrootmode="open">` elements:

```html
{{ component(name="rh-skip-link", href="#main",
             slot_content="Skip to main content",
             renderer="lit") | safe }}
```

Components with browser-only <abbr title="Application Programming Interface">API</abbr>s in their constructor or `connectedCallback` — `localStorage`, `window.location`, `fetch`, `document.createElement` — are flagged `no_ssr=true` and hydrate client-side only:

```html
{{ component(name="rh-back-to-top", href="#", no_ssr=true) | safe }}
```

The <abbr title="Server-Side Rendering">SSR</abbr> assessment identified 9 components requiring `no_ssr`:

| Component | Browser <abbr title="Application Programming Interface">API</abbr> | Location |
|---|---|---|
| `rh-alert` | `document.body` | event handler |
| `rh-audio-player` | `window.navigator` | constructor |
| `rh-dialog` | `document.body.style` | method |
| `rh-footer` | `window.location` | property getter |
| `rh-menu-dropdown` | `window.open` | event handler |
| `rh-scheme-toggle` | `localStorage` | constructor |
| `rh-site-status` | `fetch()` | connectedCallback |
| `rh-tooltip` | `document.createElement` | constructor |
| `rh-back-to-top` | `document.createElement` | import-time via pfe-core |

The remaining 37 components are safe for Lit <abbr title="Server-Side Rendering">SSR</abbr>. All assessments are documented without modifying the component source code.

The Geoff <abbr title="Server-Side Rendering">SSR</abbr> worker strips Lit hydration markers (`<?>`, `<!--lit-part-->`, `<!--lit-node-->`) from the rendered output, producing clean declarative shadow <abbr title="Document Object Model">DOM</abbr> that doesn't interfere with the host element's attributes.

## Design Tokens and Theming

The <abbr title="Red Hat Design System">RHDS</abbr> migration surfaced a fundamental difference between how the current Eleventy site handles tokens and how Geoff's theme system works — and the Geoff approach turns out to be significantly better.

### The Current RHDS Approach

The current <abbr title="Red Hat Design System">RHDS</abbr> site uses [Style Dictionary](https://amzn.github.io/style-dictionary/) to compile tokens from <abbr title="YAML Ain't Markup Language">YAML</abbr> source files into multiple output formats — <abbr title="Cascading Style Sheets">CSS</abbr> custom properties, <abbr title="JavaScript">JS</abbr> modules, <abbr title="JavaScript Object Notation">JSON</abbr>, and Sass variables. The token build pipeline is a Node.js dependency chain: source <abbr title="YAML Ain't Markup Language">YAML</abbr> → Style Dictionary transforms → compiled outputs in `@rhds/tokens`. The documentation site then imports these compiled outputs via `node_modules` and serves them through an Eleventy passthrough copy and a dynamically generated import map.

This creates several pain points:

- **Build coupling.** Changing a token value requires rebuilding the `@rhds/tokens` package before the documentation site can reflect the change. The token compilation and the site build are separate pipelines with separate dependency trees.
- **Format proliferation.** The same design decision exists in <abbr title="YAML Ain't Markup Language">YAML</abbr> source, compiled <abbr title="JavaScript Object Notation">JSON</abbr>, compiled <abbr title="JavaScript">JS</abbr> modules, compiled <abbr title="Cascading Style Sheets">CSS</abbr>, and Sass variables — five representations of one value. Keeping them in sync is the build tool's job, but debugging mismatches requires understanding the full compilation chain.
- **No semantic layer.** Tokens are organized by category (color, space, border) but there is no formal distinction between design system primitives (the raw palette) and theme decisions (how a specific site uses those primitives). A site that wants to override `--rh-color-surface-lightest` has to know it maps to `#ffffff` and trace that through the token hierarchy.
- **No light/dark mode at the token level.** Dark mode is handled by individual components via `color-scheme` and `light-dark()` <abbr title="Cascading Style Sheets">CSS</abbr> functions. There is no single place to say "in dark mode, the page background is `#1f1f1f`" — each component makes its own decision.

### Geoff's Design System / Theme Split

Geoff introduces a clean separation between **design system tokens** and **theme tokens**:

**Design system tokens** (`tokens.json`) are the raw palette — the foundational values that exist independently of any site. For <abbr title="Red Hat Design System">RHDS</abbr>, this is the full `@rhds/tokens` <abbr title="JavaScript Object Notation">JSON</abbr> file, preserved with all metadata. The conversion script simply copies it:

```toml
[design]
tokens = ["./themes/rhds/tokens.json"]
```

Geoff's theme system ignores unknown fields (`filePath`, `isSource`, `original`, `name`, `attributes`, `path`) when generating <abbr title="Cascading Style Sheets">CSS</abbr> custom properties, so the full Style Dictionary output works as-is. Plugins can still use the metadata — `name` has pre-computed <abbr title="Cascading Style Sheets">CSS</abbr> property names, `original` preserves alias references like `{color.gray.20}`, and `attributes` has structured category metadata useful for token documentation.

**Design system tokens** (`tokens.json`) define the light/dark primitives alongside the palette. The `surface-critical` group nests `on` → `light`/`dark` under each semantic name, using aliases to the raw palette:

```json
{
  "surface-critical": {
    "$type": "color",
    "background": {
      "on": {
        "light": { "$value": "{color-critical.white}" },
        "dark": { "$value": "{color.gray-90}" }
      }
    },
    "text": {
      "on": {
        "light": { "$value": "{color-critical.black}" },
        "dark": { "$value": "{color.gray-20}" }
      }
    },
    "border": {
      "on": {
        "light": { "$value": "{color-critical.gray-light}" },
        "dark": { "$value": "{color.gray-70}" }
      }
    }
  }
}
```

**Theme tokens** (`theme.json`) are semantic — they create the `light-dark()` aggregates by referencing the design system primitives via dot-path aliases:

```json
{
  "surface-critical": {
    "$type": "color",
    "background": {
      "$value": "light-dark({surface-critical.background.on.light}, {surface-critical.background.on.dark})",
      "$description": "Page background"
    },
    "text": {
      "$value": "light-dark({surface-critical.text.on.light}, {surface-critical.text.on.dark})",
      "$description": "Primary text"
    },
    "border": {
      "$value": "light-dark({surface-critical.border.on.light}, {surface-critical.border.on.dark})",
      "$description": "Borders"
    }
  }
}
```

Together, these produce <abbr title="Cascading Style Sheets">CSS</abbr> like:

```css
/* From tokens.json — primitives */
--surface-critical-background-on-light: #ffffff;
--surface-critical-background-on-dark: #1f1f1f;

/* From theme.json — aggregate */
--surface-critical-background: light-dark(
  var(--surface-critical-background-on-light),
  var(--surface-critical-background-on-dark)
);
```

The group convention (`background` → `on` → `light`/`dark`) keeps the token hierarchy clean — each semantic concept is a single node with its mode variants nested underneath. Geoff's `geoff theme generate` auto-detects these pairs and generates the `light-dark()` aggregates automatically. The result works natively in Shadow <abbr title="Document Object Model">DOM</abbr> without `@media (prefers-color-scheme)` duplication, and the user can override with `<rh-scheme-toggle>` which sets `color-scheme: light` or `color-scheme: dark` on the body and persists the preference to localStorage.

### What This Enables

**Single source of truth with layered overrides.** The design system tokens are the raw palette. The theme tokens reference them by alias (`{color-critical.white}`) and add semantic meaning. A derivative site can create its own `theme.json` that overrides only what changes — different brand color, different surface palette — while inheriting everything else through Geoff's theme inheritance chain.

**Light/dark mode as a first-class token concern.** Instead of each component independently implementing dark mode, the theme declares which tokens change between schemes. The `light-dark()` <abbr title="Cascading Style Sheets">CSS</abbr> function handles the runtime switching, and `<rh-scheme-toggle>` persists the user's preference to localStorage.

**No build coupling.** The design system <abbr title="JavaScript Object Notation">JSON</abbr> is a static file — no compilation step between changing a value and seeing it on the site. Geoff reads the tokens at build time and generates <abbr title="Cascading Style Sheets">CSS</abbr> directly. The token documentation plugin reads the same file to generate reference tables with `<samp>` examples and <abbr title="Resource Description Framework in Attributes">RDFa</abbr> annotations.

**Tokens in the knowledge graph.** The `rhds-token-tables` plugin injects every token as a `schema:DefinedTerm` triple in the <abbr title="Resource Description Framework">RDF</abbr> graph via `on_graph_updated`. This means tokens are searchable via `<geoff-search>` (searching "--rh-color-brand" finds the token), queryable via <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> in templates, and annotated with <abbr title="Resource Description Framework in Attributes">RDFa</abbr> in the <abbr title="HyperText Markup Language">HTML</abbr> output — making the token documentation machine-readable.

**`geoff theme generate`** can create a starter `theme.json` from any design system token file, auto-detecting `-on-light`/`-on-dark` pairs and producing `light-dark()` aggregates. This eliminates the manual work of mapping primitives to semantic tokens.

### Token Documentation

The `<samp>` element pattern from the original site was preserved — each token example is a `<samp>` styled via `--samp-*` <abbr title="Cascading Style Sheets">CSS</abbr> custom properties set on the `<tr>`. Color tokens show circular swatches, border tokens show styled borders, font tokens show "Aa" specimens, and spacing tokens show proportional bars. All driven by the same `samp.css` stylesheet as the original.

Token subpath exports required special handling — the `@rhds/tokens` package uses Node.js `exports` map entries (`"./media.js"` → `"./js/media.js"`) that don't translate to browser import maps. The migration copies the resolved files to their expected subpaths.

## RDFa and Structured Data

With `[linked_data] rdfa = true` in `geoff.toml`, every page includes:

- **<abbr title="Resource Description Framework in Attributes">RDFa</abbr> prefix declarations** on `<html>` — `prefix="schema: https://schema.org/ dc: http://purl.org/dc/terms/ foaf: http://xmlns.com/foaf/0.1/ rhds: urn:rhds:"`
- **`typeof` and `resource` attributes** on `<article>` — `vocab="https://schema.org/" typeof="WebPage" resource="/about/"`
- **`property` attributes** on headings — `property="schema:name"`
- **Inline Markdown <abbr title="Resource Description Framework in Attributes">RDFa</abbr>** — `[Red Hat](rdfa:creator)` → `<span property="schema:creator">Red Hat</span>`
- **Hidden `<meta>` properties** via `{{ rdfa_meta(page_uri=page_uri) | safe }}` for fields without visible content
- **<abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr>** with `[data]` frontmatter fields and multi-vocabulary `@context`

The `[data]` frontmatter section proved clean for adding structured data without <abbr title="Internationalized Resource Identifier">IRI</abbr>s:

```toml
[data]
about = "Web Components"
isPartOf = "Red Hat Design System"
programmingLanguage = "JavaScript"
```

These resolve to `schema:about`, `schema:isPartOf`, and `schema:programmingLanguage` via the mapping registry and appear in both <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> and <abbr title="Resource Description Framework in Attributes">RDFa</abbr> output automatically. The <abbr title="JavaScript Object Notation for Linked Data">JSON-LD</abbr> block generates a proper `@context` that includes only the prefixes actually used:

```json
{
  "@context": {
    "@vocab": "https://schema.org/",
    "rhds": "urn:rhds:"
  },
  "@id": "https://ux.redhat.com/about/",
  "@type": "WebPage",
  "about": "Design systems",
  "name": "About the Design System",
  "rhds:navSection": "about"
}
```

## Client-Side Search

The `<geoff-search>` component queries the site's <abbr title="Resource Description Framework">RDF</abbr> graph — including plugin-injected token triples — so searching "rh-accordion" finds element documentation, searching "--rh-color-brand" finds design tokens by <abbr title="Cascading Style Sheets">CSS</abbr> custom property name, and searching "Accordion" finds both the element and the pattern.

The search index is an N-Triples file (645<abbr title="Kilobyte">KB</abbr>, 8,500+ triples) loaded by the `<geoff-search>` web component on first interaction. [Oxigraph <abbr title="WebAssembly">WASM</abbr>](https://www.npmjs.com/package/oxigraph) runs the same <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> engine in the browser that built the site. Results are deduplicated by <abbr title="Uniform Resource Locator">URL</abbr> and display breadcrumb context ("Elements › Accordion") for pages with generic titles like "Overview" or "Accessibility."

The search <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> query also checks `urn:rhds:sidenavTitle` — so searching "Designers" finds the Get Started sub-page even though its `schema:name` is "Overview."

## Lessons Learned

**Tera template operator precedence matters.** `{% set x = "a" ~ var | replace(...) ~ "b" %}` silently fails in Tera because `|` binds tighter than `~` in a `{% set %}` assignment. The template parses successfully but produces incorrect output. Moving the filter into `{{ var | replace(...) }}` output expressions works reliably. This consumed significant debugging time because the failure is silent — Tera does not report an error, it just produces wrong results.

**Stray files in `templates/` crash everything.** Tera attempts to parse all files in the template directory. A `.bak` or `.swp` file from an editor causes a cascading "Template not found" error for every template in the directory, with no indication of which file caused the failure.

**Order values need zero-padding for <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> sorting.** <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> sorts strings lexicographically — `"10"` sorts before `"2"`. Zero-padding order values to 3 digits (`"001"`, `"010"`, `"100"`) ensures correct ordering without numeric casting. The `pages()` function sorts the same way, so padding is needed there too.

**The `http://` vs `https://` Schema.org namespace split is real.** Geoff's `MappingRegistry` now uses `https://schema.org/` (with TLS), but legacy triples or external tools may use `http://`. The search component's <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries must match the namespace the build pipeline actually uses. We discovered this when search returned 2 results instead of 700 — the search index had `https://` triples but the query used `http://`.

**Plugin `extra_vars` are the right abstraction for per-page data.** The `on_page_render` hook proved more practical than `on_graph_updated` for data like <abbr title="Table of Contents">TOC</abbr> items and version numbers, because `extra_vars` are injected directly into the Tera context without requiring <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries. Use `on_graph_updated` for site-wide data that other pages may query; use `on_page_render` for data specific to the page being rendered.

**Global regex `lastIndex` persists across plugin calls.** The <abbr title="Table of Contents">TOC</abbr> plugin uses a regex with the `g` flag to find headings. Because the plugin's `on_page_render` function is called once per page but the regex is a module-level constant, `lastIndex` accumulates and causes intermittent failures. Reset it with `HEADING_PATTERN.lastIndex = 0` before each `exec()` loop.

**`@import` in constructed stylesheets fails silently.** The `uxdot-pattern` component had `@import url(...)` inside a `css` tagged template literal. Browsers reject `@import` in constructed stylesheets per spec, but the error is easy to miss. The fix: remove the `@import` from the component <abbr title="Cascading Style Sheets">CSS</abbr> and load the dependency as a `<link>` tag in the base template.

**Geoff's Deno plugin bridge uses `extra_vars`, not `templateVars`.** The <abbr title="TypeScript">TS</abbr> SDK types define `RenderHookResult.templateVars`, but the Rust protocol serializes the field as `extra_vars`. Plugins must return `{ page, extra_vars }` — not `{ templateVars }` — for the values to reach templates.

## Disconnecting from Node

The migration is also a step toward disconnecting the <abbr title="Red Hat Design System">RHDS</abbr> tooling from the Node.js ecosystem. Geoff plugins are Deno-native, the migration scripts can be converted to Deno, and the design tokens are served as static assets rather than resolved through `node_modules`. The compiled web component <abbr title="JavaScript">JS</abbr> is standard <abbr title="ECMAScript Module">ESM</abbr> served via import maps — no bundler required.

The phased plan: Deno tooling first (already done for plugins), then [JSR](https://jsr.io/) publishing for `@rhds/elements` and `@rhds/tokens` alongside npm, then optionally migrating the element build pipeline from `tsc`/wireit to Deno.

## Build Performance

The migrated site builds 711 pages in ~10 seconds on a ThinkPad P1 Gen 7, including 7 Deno plugin dispatches (graph_updated + page_render for each page), <abbr title="SPARQL Protocol and RDF Query Language">SPARQL</abbr> queries in every template, token table generation, and <abbr title="Table of Contents">TOC</abbr> extraction. Pages render in parallel via Rayon. The search index is 645<abbr title="Kilobyte">KB</abbr> covering 8,500+ triples across content pages, element metadata, and design tokens.

The `geoff serve` dev server re-renders pages on file changes with the full three-phase pipeline — ingest, plugin hooks, render — with hot reload via WebSocket. Plugin hooks including `on_graph_updated` and `on_page_render` run on every rebuild, so <abbr title="Table of Contents">TOC</abbr> items, version badges, and token tables update live during development.

## Try the Migration

The [MIGRATION.md](https://github.com/chapeaux/rhds-geoff/blob/main/MIGRATION.md) in the `rhds-geoff` repo documents the full process — content conversion, token conversion, static asset copying, plugin setup, and build configuration. The migration script is idempotent: check out a new <abbr title="Red Hat Design System">RHDS</abbr> version, run the script, build. The v4.0.4 → v4.1.0 upgrade took one command.
