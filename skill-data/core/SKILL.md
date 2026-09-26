---
name: core
description: Use when adding Pagegraph to a TanStack Start app or changing its SEO wiring — staticData.seo declarations, seoHead in route head(), typed related links, content collections, the seoRouteConfig coverage gate, seo.config.ts, sitemap and robots routes — or when a `pagegraph check`, coverage, or rendered-head failure needs diagnosing.
---

# Pagegraph and TanStack Start

Each route declares its SEO policy once in `staticData.seo`; Pagegraph derives the sitemap, robots, breadcrumbs, JSON-LD, related links, and `pagegraph check` from those declarations. TanStack Start still owns routing and the document shell. This skill ships inside the Pagegraph CLI that printed it, so it matches that version. Run the app's installed binary (`bunx pagegraph` from the app root) so the guidance and the types agree.

Before editing, read the app's `package.json`, `src/routes/`, `src/routeTree.gen.ts`, any existing `seo.config.ts`, and `vite.config.ts`. Adapt the paths below to the app's layout.

## Wire it up

**1. Bind site identity and typed paths once.** Route files never repeat the origin or brand.

```ts
// src/lib/seo.ts
import { createSeo } from "pagegraph/react";
import type { FileRouteTypes } from "../routeTree.gen";

declare module "pagegraph" {
  interface Register {
    paths: FileRouteTypes["fullPaths"];
    kinds: "page" | "article" | "hub";
  }
}

export const { seoHead } = createSeo({
  origin: "https://example.com",
  site: {
    name: "Example",
    logo: "/logo.png",
    publisherLogo: "/publisher.png",
    defaultImage: "/og.png",
    defaultAuthor: { name: "Example Team" },
  },
  organization: {
    description: "What the company does.",
    sameAs: [],
    contactPoint: { contactType: "support", email: "support@example.com" },
  },
  website: { searchPath: "/search?q={search_term_string}" },
});
```

The `Register` augmentation is what types `staticData.seo` on TanStack routes and checks `related` and `redirectTo` against real paths, so a renamed route becomes a compile error. `kinds` is the app's own taxonomy; nothing branches on it.

**2. Declare policy on the route, content in `head()`.**

```tsx
// src/routes/(marketing)/pricing.tsx
import { createFileRoute } from "@tanstack/react-router";
import { seoHead } from "../../lib/seo";

export const Route = createFileRoute("/(marketing)/pricing")({
  staticData: {
    seo: {
      kind: "page",
      crumb: "Pricing",
      sitemap: { priority: 0.9, changeFrequency: "monthly" },
      related: ["/features"],
      link: { title: "Pricing", description: "Simple volume pricing." },
    },
  },
  head: (ctx) =>
    seoHead(ctx, {
      title: "Pricing — Example",
      description: "Simple volume pricing.",
    }),
  component: PricingPage,
});
```

- `staticData.seo` is static crawl policy and graph edges: `kind`, `crumb`, `sitemap` (or `false`), `robots`, `related`, `link`, `redirectTo`.
- `seoHead(ctx, instance)` takes the full `title` (no suffix is added) and `description`, and optionally `article`, `faqs`, `service`, `itemList`, `jsonLd`, `canonicalPath`, and `breadcrumbs`. It returns `meta` and a canonical `links` entry for TanStack to render; the document shell must keep `<HeadContent />` and `<Scripts />`.
- `link` is how other pages render a card for this route. Add it to every route that appears in someone's `related`.
- Declare `related` only for links the page actually renders in its body.
- `crumb` accepts `(match) => string` for dynamic segments, such as a title from `loaderData`.

**3. Export one graph loader.** The CLI, sitemap, and robots all read it.

```ts
// src/lib/seo/graph.ts
import { buildSeoGraph } from "pagegraph";
import { routeTree } from "../../routeTree.gen";
import { posts } from "../content/posts"; // the app's own content source

export const loadSeoGraph = async () =>
  buildSeoGraph({
    routeTree,
    collections: [
      {
        route: "/blog/$slug",
        source: "blog",
        instances: posts.map((post) => ({
          path: `/blog/${post.slug}`,
          title: post.title,
          description: post.description,
          publishedAt: post.date,
        })),
      },
    ],
  });
```

A param route such as `/blog/$slug` never enters the sitemap itself; list its pages as a collection. Instances inherit the param route's `kind` and `sitemap`, so declare those on `/blog/$slug`. Omit `collections` when every public page is a static route.

**4. Point the CLI at the loader** with `seo.config.ts` at the app root:

```ts
// seo.config.ts
import { defineSeoConfig, viteGraphLoader } from "pagegraph/config";

export default defineSeoConfig({
  origin: "https://example.com",
  disallow: ["/dashboard", "/api"],
  loadGraph: viteGraphLoader({
    root: import.meta.dirname,
    entry: "/src/lib/seo/graph.ts",
    exportName: "loadSeoGraph",
  }),
});
```

`entry` is root-relative and evaluated in a headless Vite server, so aliases and content plugins resolve as they do in the app. Optional fields: `contentSignal`, `coverage` (`[{ path, minInbound }]`, contextual-link minimums enforced by `check`), `directives`, and `transform`.

**5. Serve the projections.** In Start server routes, return `renderSitemap(graph, { origin, indexable })` and `renderRobots(graph, { origin, indexable, disallow, contentSignal })` from `pagegraph`. On preview deployments, pass `indexable: false` so robots.txt disallows everything; the sitemap body does not change.

**6. Optionally gate coverage at build time.**

```ts
// vite.config.ts
import { fileURLToPath } from "node:url";
import { seoRouteConfig } from "pagegraph/vite";

// Add alongside tanstackStart(); it runs its own route parse and does not replace the Start plugin.
seoRouteConfig({
  outputPath: fileURLToPath(new URL("./src/lib/route-config.ts", import.meta.url)),
  publicGroups: ["(marketing)"],
  enforceCoverageIn: ["(marketing)"],
  alwaysDisallow: ["/dashboard", "/api"],
});
```

This plugin fails dev startup and `vite build` when a page leaf in an enforced group has neither `staticData` nor `head`. It writes `robotsExclusions` and `reservedSegments` to `outputPath`. Feed `robotsExclusions` into `seo.config.ts` `disallow` and `renderRobots` instead of repeating the list.

## Rules that bite

- `robots` values must be lowercase (`"noindex, follow"`). The sitemap projection matches `noindex` literally, so `check` rejects mixed case.
- A route with `robots` containing `noindex` or with `redirectTo` must not declare a positive `sitemap`. Use `sitemap: false` or omit it.
- A `related` target route without `link` fails `check`. Collection instances are exempt because their card uses the instance `title` and `description`.
- Coverage enforcement sees only route files inside the named group folders. `route.tsx` layouts, `.ts` server routes, and ungrouped routes are not checked. List ungrouped public routes in `extraPublicRoutes`.
- `seoRouteConfig` throws if the directory of `outputPath` does not exist. Point it outside `src/routes` so the route watcher does not loop.
- The graph knows route declarations and collection instances, not `head()` output. Editorial title and description checks cover instances only. A route's rendered title is verified only by inspecting HTML.
- Keep indexable pages server-rendered or prerendered. An `ssr: false` route's head is not in the served HTML.

## Verify

| Changed | Run | Proves |
| --- | --- | --- |
| Declarations, collections, `seo.config.ts` | `pagegraph check` | No structural violations (exit 1 otherwise); editorial findings are reported but do not fail |
| Graph shape | `pagegraph graph`, `pagegraph inspect /path` | Nodes, edges, and a page's sitemap status |
| Sitemap or robots wiring | `pagegraph sitemap`, `pagegraph robots` | The projections from the declared graph |
| `head()`, `seoHead` input, document shell | `pagegraph inspect <full-url> --live` against a running server | The served `<head>` and JSON-LD |
| Rendered links vs `related` | `pagegraph links verify <url>` (add `--assert-coverage` for `coverage` rules) | What a crawler receives, not what was declared |
| Coverage gate | `vite build` | Every enforced page leaf declares SEO |

A passing `check` says nothing about served HTML. Verify head changes with `inspect --live` or a rendered-head test. Add `--json` when a script consumes the output. Stdout carries the data and stderr carries status. Check the exit code as well as the output.
