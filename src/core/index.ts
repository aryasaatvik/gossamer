/**
 * `pagegraph` — declare SEO once on the route; the sitemap, robots.txt, the
 * cross-link graph and the check engine all derive from that declaration.
 *
 * This entry is the pure core: zero runtime dependencies, no React, no I/O.
 * Importing it also installs the `staticData.seo` augmentation on TanStack
 * Router's `StaticDataRouteOption`.
 */

export type { PublicPath, Register, RouteSeo, SeoKind, SitemapPolicy } from "./declare";

export { buildSeoGraph } from "./graph";
export type {
  BuildSeoGraphInput,
  SeoCollection,
  SeoEdge,
  SeoEdgeType,
  SeoGraph,
  SeoInstance,
  SeoNode,
  SeoSource,
} from "./graph";

export { contentSignal, inspectNode, renderRobots, renderSitemap } from "./projections";
export type { NodeReport, ProjectionConfig, RobotsConfig } from "./projections";

export { checkGraph, hasStructuralViolations } from "./checks";
export type { Severity, Violation } from "./checks";

export { hasBlockingIssues, inspectHtml } from "./inspect-html";
export type { JsonLdReport, LiveHeadReport } from "./inspect-html";

export { resolveRouteLink } from "./resolve-route-link";

export {
  buildRenderedGraph,
  diffLinkGraph,
  extractAnchors,
  normalizePath,
} from "./links";
export type {
  Anchor,
  AnchorRegion,
  LinkEdge,
  LinkGraphDiff,
  RenderedGraph,
  RenderedPage,
  SimpleEdge,
} from "./links";
