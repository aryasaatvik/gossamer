---
name: core
description: Use when integrating or debugging Pagegraph's route-declared SEO in a TanStack Start app, including staticData.seo, rendered head tags, the Vite coverage gate, sitemap and robots projections, and CLI checks.
---

# Pagegraph and TanStack Start

Read the app's lockfile, route files, and `seo.config.ts` before editing. Use its installed Pagegraph types for exact options. TanStack Start owns routing and document rendering; Pagegraph derives SEO projections from route declarations.

## Adoption path

1. Start with one public route. Decide its canonical URL and indexability. Keep stable policy in `staticData.seo` and page-specific title and description in `head(ctx)`.
2. Bind site identity once with `createSeo` from `pagegraph/react`; use its `seoHead(ctx, instance)` in route heads. Import `pagegraph` for the TanStack Router `StaticDataRouteOption` augmentation.
3. Add `seoRouteConfig` from `pagegraph/vite` when a public route group needs a build-time coverage gate or generated route config. It runs a separate router-generator parse; it does not replace `tanstackStart()`.
4. Add `seo.config.ts` with `defineSeoConfig` and `viteGraphLoader` when the app needs CLI graph, sitemap, robots, or CI projections. The route tree and `staticData.seo` remain the declarations.
5. Run `pagegraph check` for declared-graph violations. Inspect served HTML separately with `pagegraph inspect <url> --live` or a focused rendered-head test. A green graph check does not prove the deployed head.

For the full option surface, see the installed Pagegraph package's `README.md` sections **Quick start**, **Coverage gate (Vite)**, and **CLI**. Check the consuming app's installed Pagegraph version before copying an option.

## Minimal route integration

```ts
// src/lib/seo.ts
import "pagegraph";
import { createSeo } from "pagegraph/react";

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
    description: "Example product documentation.",
    sameAs: [],
    contactPoint: { contactType: "support", email: "support@example.com" },
  },
  website: { searchPath: "/search?q={search_term_string}" },
});
```

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
    },
  },
  head: (ctx) => seoHead(ctx, {
    title: "Pricing — Example",
    description: "Simple volume pricing.",
  }),
  component: () => <h1>Pricing</h1>,
});
```

Check `SeoConfig` in the consuming app's installed types for version-specific changes. Declare `related` only for contextual links the source route renders. A route targeted by a `related` link needs `link: { title, description }` metadata for its card; content-instance targets use frontmatter instead.

## Optional coverage and graph

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { seoRouteConfig } from "pagegraph/vite";

export default defineConfig({
  plugins: [
    tanstackStart(),
    seoRouteConfig({
      outputPath: fileURLToPath(new URL("./src/lib/route-config.ts", import.meta.url)),
      publicGroups: ["(marketing)"],
      enforceCoverageIn: ["(marketing)"],
      alwaysDisallow: ["/dashboard", "/api"],
    }),
  ],
});
```

`outputPath` must be absolute. For sitemap, robots, and graph checks, configure `seo.config.ts` with `defineSeoConfig` and `viteGraphLoader` from `pagegraph/config`, then run `pagegraph check`. Read the installed README's **CLI** example before writing the loader path; it depends on the app's source layout.

## Route and document boundaries

- `seoHead` returns TanStack head `meta` and canonical `links`. Its JSON-LD uses TanStack's `script:ld+json` descriptor. Keep `<HeadContent />` and `<Scripts />` in the Start document shell.
- A route's SEO declaration is a policy, not its rendered content. Verify titles, descriptions, canonical links, robots directives, and JSON-LD against rendered output when changing head behavior.
- Keep indexable pages server rendered or prerendered. Treat `ssr: false` dashboard routes as non-indexable unless the app handles their SEO separately.
- Use `seoRouteConfig` only for groups that should declare SEO. Its coverage rule rejects a page leaf missing both `staticData` and `head`; it does not validate the quality of either.
- `pagegraph check` fails on structural graph violations and reports editorial findings separately. For live page inspection, `pagegraph inspect <url> --live` checks the rendered head; `pagegraph audit <url> --probe-only` inspects deployed site signals.

## CLI verification

- CLI graph commands load the app through Vite. The Pagegraph binary bundles its own Effect runtime, while the host supplies Vite; Lighthouse is needed only for its scanner.
- Use `--json` when a command's structured output is consumed by automation. Keep diagnostics separate from parsed stdout and honor nonzero exit status.
