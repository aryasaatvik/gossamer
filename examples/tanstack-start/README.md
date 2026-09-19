# TanStack Start cookbook

This is a drop-in wiring example for a TanStack Start app. The package has no opinion about your
router layout or content source: the route tree is the source of truth, and the same graph feeds
rendered head tags, discovery files, the CLI, and CI.

## 1. Bind site identity once

Create `src/lib/seo.ts`. Route modules only provide page content; they do not repeat the origin,
organization, or JSON-LD identity.

```ts
import { createSeo, defineJsonLd, jsonLdRef } from "gossamer/react";

export const seo = createSeo({
  origin: "https://example.com",
  site: {
    name: "Example",
    logo: "/logo.png",
    publisherLogo: "/publisher.png",
    defaultImage: "/og.png",
    defaultAuthor: { name: "Example Team" },
  },
  organization: {
    legalName: "Example, Inc.",
    description: "A concise description of the company.",
    sameAs: ["https://github.com/example"],
    contactPoint: { contactType: "support", email: "support@example.com" },
  },
  website: { searchPath: "/search?q={search_term_string}" },
  jsonLd: {
    site: (ids) => [
      defineJsonLd({
        "@type": "SoftwareApplication",
        "@id": "https://example.com/#product",
        name: "Example",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        provider: jsonLdRef(ids.organization),
      }),
    ],
  },
});

export const { seoHead } = seo;
```

## 2. Declare policy on the route

`staticData.seo` owns crawl policy and graph edges. `head()` owns the content for the concrete
match. Together they produce the canonical URL, social metadata, BreadcrumbList, and any page
schema the instance warrants.

```tsx
import { createFileRoute } from "@tanstack/react-router";

import { seoHead } from "../lib/seo";

export const Route = createFileRoute("/docs")({
  staticData: {
    seo: {
      kind: "page",
      crumb: "Docs",
      sitemap: { priority: 0.8, changeFrequency: "weekly" },
      related: ["/pricing"],
      link: {
        title: "Documentation",
        description: "Guides and API references for the Example platform.",
      },
    },
  },
  head: (ctx) =>
    seoHead(ctx, {
      title: "Documentation | Example",
      description: "Guides and API references for the Example platform.",
      service: {
        name: "Example documentation",
        serviceType: "Developer documentation",
      },
    }),
  component: DocsPage,
});

function DocsPage() {
  return <main><h1>Documentation</h1></main>;
}
```

For an article, pass `article` instead of `service`. For a page with custom schema, pass a
`jsonLd` array containing `defineJsonLd(...)` documents. The route declaration remains the same.

## 3. Build one graph for projections and the CLI

Import the generated route tree from the same app that Start uses. Collections are optional and
are useful for dynamic routes such as `/blog/$slug`.

```ts
// src/lib/seo/graph.ts
import { buildSeoGraph } from "gossamer";

import { routeTree } from "../../routeTree.gen";

export const loadSeoGraph = async () =>
  buildSeoGraph({
    routeTree,
    collections: [
      {
        route: "/blog/$slug",
        source: "blog",
        instances: [
          {
            path: "/blog/typed-routing",
            title: "Typed routing without drift",
            description: "Keep route declarations and generated discovery surfaces aligned.",
            publishedAt: "2026-01-15",
          },
        ],
      },
    ],
  });
```

Expose that loader to the CLI with `seo.config.ts` at the app root:

```ts
import { defineSeoConfig, viteGraphLoader } from "gossamer/config";

export default defineSeoConfig({
  origin: "https://example.com",
  disallow: ["/dashboard", "/api"],
  contentSignal: "search=yes, ai-input=yes, ai-train=yes",
  loadGraph: viteGraphLoader({
    root: import.meta.dirname,
    entry: "/src/lib/seo/graph.ts",
    exportName: "loadSeoGraph",
  }),
});
```

If you use the Vite coverage gate, point it at a generated route config so public route groups
cannot silently ship without `staticData` or `head`:

```ts
// vite.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { seoRouteConfig } from "gossamer/vite";

export default defineConfig({
  plugins: [
    seoRouteConfig({
      outputPath: fileURLToPath(new URL("./src/lib/route-config.ts", import.meta.url)),
      publicGroups: ["(marketing)", "(docs)"],
      enforceCoverageIn: ["(marketing)", "(docs)"],
      alwaysDisallow: ["/dashboard", "/api"],
    }),
  ],
});
```

## 4. Serve sitemap and robots

Wire the pure projections into your Start server routes. The response shape is ordinary Web API
code, so it works with whichever Start server-route convention your app uses:

```ts
import { renderRobots, renderSitemap } from "gossamer";
import { loadSeoGraph } from "../lib/seo/graph";

export async function sitemapResponse() {
  const graph = await loadSeoGraph();
  return new Response(
    renderSitemap(graph, { origin: "https://example.com", indexable: true }),
    { headers: { "content-type": "application/xml" } },
  );
}

export async function robotsResponse() {
  const graph = await loadSeoGraph();
  return new Response(
    renderRobots(graph, {
      origin: "https://example.com",
      indexable: true,
      disallow: ["/dashboard", "/api"],
      contentSignal: "search=yes, ai-input=yes, ai-train=yes",
    }),
    { headers: { "content-type": "text/plain" } },
  );
}
```

For preview deployments, pass `indexable: false`; the renderer emits a disallow-all response and
omits the sitemap and content-signal directives.

## 5. Inspect locally and compare deployments

The CLI evaluates `seo.config.ts` inside a headless Vite server, so aliases and content plugins
resolve the same way they do in the app:

```bash
gossamer check
gossamer graph --format mermaid
gossamer inspect /docs
gossamer sitemap
gossamer robots

gossamer audit http://localhost:3000 --allow-private --probe-only --output-dir .audit/current
before="$(find .audit/before -type f -name '*.json' -print | sort | tail -n 1)"
after="$(find .audit/current -type f -name '*.json' -print | sort | tail -n 1)"
if [ -z "$before" ] || [ -z "$after" ]; then
  echo "expected one JSON audit artifact in each directory" >&2
  exit 1
fi
gossamer diff "$before" "$after"
gossamer diff "$before" "$after" --json | jq
```

`gossamer check` exits non-zero for structural graph violations. `gossamer diff` exits non-zero only when
coverage or scanner quality regresses; timestamps and raw Lighthouse timings are deliberately
ignored. Each audit invocation writes one timestamped JSON artifact and one Markdown report; the
globs above select those JSON artifacts for a reviewable before/after comparison.
