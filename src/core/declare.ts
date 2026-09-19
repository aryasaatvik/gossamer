/**
 * The declaration surface: what a route says about itself in
 * `staticData.seo`. Everything else in this package derives from it.
 *
 * The two vocabularies a consumer owns — the set of valid paths and the set of
 * valid page kinds — are supplied by augmenting {@link Register}, the same
 * pattern TanStack Router uses for its own typed registry. Unaugmented, both
 * fall back to `string`, so the package compiles and behaves on its own.
 */

import type { AnyRouteMatch } from "@tanstack/react-router";

/**
 * Consumer-augmented registry.
 *
 * ```ts
 * declare module "pagegraph" {
 *   interface Register {
 *     paths: FileRouteTypes["fullPaths"];
 *     kinds: "page" | "article" | "hub";
 *   }
 * }
 * ```
 */
export interface Register {}

/** Every public full path in the consumer's route tree (type-only; erased at runtime). */
export type PublicPath = Register extends { paths: infer P extends string } ? P : string;

/** The consumer's page taxonomy. A label: nothing in the core branches on it. */
export type SeoKind = Register extends { kinds: infer K extends string } ? K : string;

export interface SitemapPolicy {
  priority: number;
  changeFrequency: "weekly" | "monthly";
}

export interface RouteSeo {
  kind: SeoKind;
  /** Breadcrumb label; fn form reads the match (e.g. loaderData frontmatter title). */
  crumb?: string | ((match: AnyRouteMatch) => string) | undefined;
  /** false = excluded from sitemap. Absent on non-indexable kinds is fine. */
  sitemap?: SitemapPolicy | false | undefined;
  /** meta robots value, e.g. "noindex, follow" on a hub page. */
  robots?: string | undefined;
  /** Typed cross-link edges. */
  related?: ReadonlyArray<PublicPath> | undefined;
  /** How OTHER pages render a card for this page. */
  link?: { title: string; description: string } | undefined;
  /** This route is a redirect/alias. */
  redirectTo?: PublicPath | undefined;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    seo?: RouteSeo | undefined;
  }
}
