/**
 * Pure link-graph utilities: read anchors out of rendered HTML, model the
 * rendered graph, compute homepage depth, and diff it against the declared
 * graph. Effect- and framework-free so it runs in the CLI, a Worker, or a test
 * on the same data.
 *
 * This is the "served HTML" half of the SEO graph: the declared graph describes
 * intent, this describes what a crawler actually receives.
 */

/** Where an anchor sits in the document, coarsely. */
export type AnchorRegion = "nav" | "footer" | "header" | "body";

export interface Anchor {
  readonly href: string;
  readonly text: string;
  readonly region: AnchorRegion;
  /** True when the resolved target shares the page's origin. */
  readonly internal: boolean;
}

export interface LinkEdge {
  readonly from: string;
  readonly to: string;
  readonly region: AnchorRegion;
}

export interface RenderedGraph {
  readonly edges: ReadonlyArray<LinkEdge>;
  readonly internalEdges: ReadonlyArray<LinkEdge>;
  /** Same-origin body-region edges: the contextual surface. */
  readonly contextualEdges: ReadonlyArray<LinkEdge>;
  /** Same-origin pages with no incoming internal edge ("reachable only via nav" is not implied). */
  readonly orphans: ReadonlyArray<string>;
  readonly depthByPath: ReadonlyMap<string, number>;
  readonly maxDepth: number | null;
}

const REGION_TAGS = new Set(["nav", "footer", "header"]);

const TOKEN =
  /<(\/?)(nav|footer|header)\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

// A real `href` attribute is preceded by whitespace (or the tag's start). The
// boundary keeps `data-href`, `xhref`, and similar attributes from reading as
// links, and stops a decoy from winning over a genuine `href`.
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const BASE_TAG = /<base\b[^>]*>/gi;

const NON_NAVIGABLE = /^(?:#|mailto:|tel:|javascript:|data:)/i;

const stripTags = (value: string): string => value.replace(/<[^>]*>/g, " ");

const decodeEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");

const anchorText = (value: string): string =>
  decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim();

/** Normalize a same-origin URL to the graph's path key (no query/hash; "/" preserved). */
export const normalizePath = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
};

const hrefValue = (attributes: string): string | undefined => {
  const match = HREF.exec(attributes);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
};

/**
 * The document base URL. Browsers use the first `<base>` element that has an
 * `href` attribute and ignore every later one, so a `<base>` carrying only
 * `target` is skipped, but the first `<base href>` wins even when its value is
 * empty (it then resolves to the document URL) or invalid (the base is ignored,
 * resolving to the document URL). With no `<base href>` at all, links resolve
 * against the response URL.
 */
const documentBase = (html: string, responseUrl: URL): URL => {
  BASE_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = BASE_TAG.exec(html)) !== null) {
    const href = hrefValue(tag[0]);
    if (href === undefined) continue;
    if (href.length === 0) return responseUrl;
    try {
      return new URL(href, responseUrl);
    } catch {
      return responseUrl;
    }
  }
  return responseUrl;
};

/**
 * Extract every anchor in document order, tagging each with the region tag it
 * sits inside. Anchor text keeps only its letters and a coarse entity decode;
 * this is a classifier input, not a renderer.
 */
export const extractAnchors = (html: string, baseUrl: string): ReadonlyArray<Anchor> => {
  const base = new URL(baseUrl);
  const resolutionBase = documentBase(html, base);
  const regions: Array<AnchorRegion> = [];
  const anchors: Array<Anchor> = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(html)) !== null) {
    const closing = match[1];
    const regionTag = match[2];
    if (regionTag !== undefined) {
      const region = regionTag.toLowerCase() as AnchorRegion;
      if (closing === "/") {
        const index = regions.lastIndexOf(region);
        if (index !== -1) regions.splice(index, 1);
      } else {
        regions.push(region);
      }
      continue;
    }
    const attributes = match[3];
    const raw = hrefValue(attributes);
    if (raw === undefined || raw.length === 0 || NON_NAVIGABLE.test(raw)) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, resolutionBase);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const region = regions.length === 0 ? "body" : regions[regions.length - 1]!;
    anchors.push({
      href: resolved.href,
      text: anchorText(match[4] ?? ""),
      region,
      internal: resolved.origin === base.origin,
    });
  }
  return anchors;
};

export interface RenderedPage {
  readonly url: string;
  readonly anchors: ReadonlyArray<Anchor>;
}

const breadthFirstDepth = (
  edges: ReadonlyArray<LinkEdge>,
  root: string,
): ReadonlyMap<string, number> => {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    adjacency.set(edge.from, targets);
  }
  const depth = new Map<string, number>([[root, 0]]);
  const queue: Array<string> = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, currentDepth + 1);
      queue.push(next);
    }
  }
  return depth;
};

/**
 * Build the rendered graph from crawled pages. `origin` fixes the graph's
 * same-origin boundary — pages and anchors on another origin are dropped, not
 * silently folded in — and `root` is the normalized path the depth BFS starts
 * from (the seed's final path when the homepage redirected). Every page path is
 * keyed the way the declared graph keys its routes.
 */
export const buildRenderedGraph = (
  origin: string,
  pages: ReadonlyArray<RenderedPage>,
  root: string = "/",
): RenderedGraph => {
  const originUrl = new URL(origin);
  const graphOrigin = originUrl.origin;
  const rootKey = root.replace(/\/+$/, "") || "/";
  const edges: Array<LinkEdge> = [];
  const nodes = new Set<string>();
  for (const page of pages) {
    let pageUrl: URL;
    try {
      pageUrl = new URL(page.url);
    } catch {
      continue;
    }
    if (pageUrl.origin !== graphOrigin) continue;
    const path = normalizePath(pageUrl);
    nodes.add(path);
    for (const anchor of page.anchors) {
      let targetUrl: URL;
      try {
        targetUrl = new URL(anchor.href);
      } catch {
        continue;
      }
      if (targetUrl.origin !== graphOrigin) continue;
      const target = normalizePath(targetUrl);
      if (target === path) continue;
      edges.push({ from: path, to: target, region: anchor.region });
    }
  }
  const internalEdges = edges;
  const contextualEdges = edges.filter((edge) => edge.region === "body");
  const incoming = new Set(internalEdges.map((edge) => edge.to));
  const orphans = [...nodes]
    .filter((path) => path !== rootKey && !incoming.has(path))
    .sort();
  const depthByPath = breadthFirstDepth(internalEdges, rootKey);
  let maxDepth: number | null = null;
  for (const value of depthByPath.values()) {
    if (maxDepth === null || value > maxDepth) maxDepth = value;
  }
  return { edges, internalEdges, contextualEdges, orphans, depthByPath, maxDepth };
};

export interface SimpleEdge {
  readonly from: string;
  readonly to: string;
}

export interface LinkGraphDiff {
  /** Declared internal edges with no matching rendered anchor. */
  readonly declaredNotRendered: ReadonlyArray<SimpleEdge>;
  /** Rendered contextual edges that no declared edge accounts for. */
  readonly renderedNotDeclared: ReadonlyArray<SimpleEdge>;
  readonly declaredCount: number;
  readonly renderedContextualCount: number;
}

const edgeKey = (edge: SimpleEdge): string => `${edge.from}\u0000${edge.to}`;

const normalizeEdge = (edge: SimpleEdge): SimpleEdge => ({
  from: edge.from === "" ? "/" : edge.from.replace(/\/+$/, "") || "/",
  to: edge.to === "" ? "/" : edge.to.replace(/\/+$/, "") || "/",
});

/**
 * Diff rendered contextual edges against declared `related`/`crumb` edges. Both
 * sides are path-keyed; the diff is directional and reports each direction
 * separately because they call for different fixes.
 */
export const diffLinkGraph = (
  declared: ReadonlyArray<SimpleEdge>,
  rendered: RenderedGraph,
): LinkGraphDiff => {
  const declaredNormalized = declared.map(normalizeEdge);
  const declaredKeys = new Set(declaredNormalized.map(edgeKey));
  const renderedKeys = new Set(rendered.contextualEdges.map(edgeKey));
  const declaredNotRendered = declaredNormalized.filter(
    (edge) => !renderedKeys.has(edgeKey(edge)),
  );
  const renderedNotDeclared = rendered.internalEdges
    .filter((edge) => edge.region === "body")
    .map((edge) => normalizeEdge(edge))
    .filter((edge) => !declaredKeys.has(edgeKey(edge)));
  return {
    declaredNotRendered,
    renderedNotDeclared,
    declaredCount: declaredNormalized.length,
    renderedContextualCount: rendered.contextualEdges.length,
  };
};
