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
  /** Every same-origin page path the crawl rendered, in first-seen order. */
  readonly nodes: ReadonlyArray<string>;
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
 * Assemble a {@link RenderedGraph} from page/edge sets. Edges are already
 * same-origin and path-keyed by the callers, so this is the shared, pure tail of
 * {@link buildRenderedGraph} and {@link renderedGraphFromEdges}.
 */
const graphFromEdges = (
  nodes: Set<string>,
  edges: Array<LinkEdge>,
  root: string,
): RenderedGraph => {
  const rootKey = root.replace(/\/+$/, "") || "/";
  const internalEdges = edges;
  const contextualEdges = edges.filter((edge) => edge.region === "body");
  const incoming = new Set(internalEdges.map((edge) => edge.to));
  const orphans = [...nodes].filter((path) => path !== rootKey && !incoming.has(path)).sort();
  const depthByPath = breadthFirstDepth(internalEdges, rootKey);
  let maxDepth: number | null = null;
  for (const value of depthByPath.values()) {
    if (maxDepth === null || value > maxDepth) maxDepth = value;
  }
  return {
    nodes: [...nodes],
    edges,
    internalEdges,
    contextualEdges,
    orphans,
    depthByPath,
    maxDepth,
  };
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
  return graphFromEdges(nodes, edges, root);
};

/** A URL or an already-normalized graph path key both collapse to the path key. */
const pathKeyOf = (value: string): string => {
  try {
    return normalizePath(new URL(value));
  } catch {
    const pathname = value.split(/[?#]/, 1)[0] ?? "";
    return pathname.replace(/\/+$/, "") || "/";
  }
};

/**
 * Rebuild a {@link RenderedGraph} from a rendered-edge set alone — the artifact
 * `pagegraph links verify --emit-rendered` writes. Path keys are normalized the
 * same way as a crawl, and `nodes` carries the rendered page paths the artifact
 * recorded, so an edge-less page (a redirect target with no internal links) stays
 * a node and its orphan/depth report survives replay. Without `nodes` the node set
 * falls back to the edge endpoints.
 */
export const renderedGraphFromEdges = (
  edges: ReadonlyArray<LinkEdge>,
  root: string = "/",
  nodes: ReadonlyArray<string> = [],
): RenderedGraph => {
  const nodeSet = new Set(nodes.map(pathKeyOf));
  const kept: Array<LinkEdge> = [];
  for (const edge of edges) {
    const from = pathKeyOf(edge.from);
    const to = pathKeyOf(edge.to);
    nodeSet.add(from);
    nodeSet.add(to);
    kept.push({ from, to, region: edge.region });
  }
  return graphFromEdges(nodeSet, kept, root);
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

/** A page the crawl could not render; its outgoing anchors are absent. */
export interface RenderedEdgeFailure {
  readonly url: string;
  readonly error: string;
}

/**
 * Provenance for a rendered-edge artifact: enough to trust the edges and to
 * refuse a gate that would assert on an incomplete crawl. `root` is the seed's
 * normalized final path (its post-redirect path), so depth and orphans rebuild
 * exactly as the crawl computed them.
 */
export interface RenderedEdgeArtifactCrawl {
  /** Pages whose HTML was rendered into `edges`. */
  readonly pages: number;
  /** Normalized final path of the seed — the depth BFS root. */
  readonly root: string;
  /** The crawl's page budget (`--limit`). */
  readonly limit: number;
  /** True when discovery outran `limit`; a gate must not assert on this. */
  readonly truncated: boolean;
  /** True when any captured body was cut at `--max-body-bytes`. */
  readonly bodyTruncated: boolean;
  /** URLs whose captured body was cut; anchors past the cutoff are missing. */
  readonly truncatedPages: ReadonlyArray<string>;
  /** Pages that failed to fetch; their outgoing anchors are missing. */
  readonly failures: ReadonlyArray<RenderedEdgeFailure>;
  readonly discoveryFailures?: ReadonlyArray<RenderedEdgeFailure>;
  readonly skipped?: ReadonlyArray<string>;
  readonly sitemapTruncated?: boolean;
  readonly sitemapUsed?: boolean;
}

/**
 * The stable, `decodeRenderedEdges`-compatible artifact `pagegraph links verify
 * --emit-rendered` writes and `--rendered` reads. It carries the raw served edges
 * (with `region`), the rendered page paths, and the provenance a coverage gate
 * needs to decide whether the crawl is trustworthy, so one crawl can be asserted
 * repeatedly without re-fetching.
 */
export interface RenderedEdgeArtifact {
  readonly kind: "links-rendered";
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly seed: string;
  readonly crawl: RenderedEdgeArtifactCrawl;
  /** Normalized paths of every rendered page — replay's node set. */
  readonly nodes: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<LinkEdge>;
}

/** The rendered-edge artifact schema this package writes and accepts. */
export const RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION = 1 as const;

const ARTIFACT_KIND = "links-rendered";

const REGIONS: ReadonlySet<string> = new Set(["nav", "footer", "header", "body"]);

const decodeArtifactEdges = (input: unknown): ReadonlyArray<LinkEdge> => {
  if (!Array.isArray(input)) {
    throw new Error("`edges` must be an array of { from, to, region } edges");
  }
  return input.map((item) => {
    if (item === null || typeof item !== "object") {
      throw new Error("each artifact edge must be an object with string `from` and `to`");
    }
    const { from, to, region } = item as { from?: unknown; to?: unknown; region?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      throw new Error("each artifact edge must have string `from` and `to`");
    }
    if (region !== undefined && !REGIONS.has(region as string)) {
      throw new Error(
        `artifact edge region must be one of nav, footer, header, body (received ${JSON.stringify(region)})`,
      );
    }
    return { from, to, region: (region as AnchorRegion | undefined) ?? "body" };
  });
};

const decodeArtifactNodes = (input: unknown): ReadonlyArray<string> => {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.every((path) => typeof path === "string")) {
    throw new Error("rendered-edge artifact `nodes` must be an array of paths");
  }
  return input;
};

const decodeArtifactFailures = (input: unknown): ReadonlyArray<RenderedEdgeFailure> => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error("rendered-edge artifact `crawl.failures` must be an array");
  }
  return input.map((item) => {
    if (item === null || typeof item !== "object") {
      throw new Error("each artifact failure must be an object with string `url` and `error`");
    }
    const { url, error } = item as { url?: unknown; error?: unknown };
    if (typeof url !== "string" || typeof error !== "string") {
      throw new Error("each artifact failure must have string `url` and `error`");
    }
    return { url, error };
  });
};

const requiredAbsoluteUrl = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(`rendered-edge artifact must carry a non-empty string \`${field}\``);
  }
  try {
    void new URL(value);
  } catch {
    throw new Error(
      `rendered-edge artifact \`${field}\` must be an absolute URL (received ${JSON.stringify(value)})`,
    );
  }
  return value;
};

const requiredInteger = (value: unknown, field: string, minimum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(
      `rendered-edge artifact \`${field}\` must be an integer >= ${minimum} (received ${JSON.stringify(value)})`,
    );
  }
  return value as number;
};

/**
 * Decode a rendered-edge artifact from user input. Throws on any other shape —
 * this is user input, not a provider payload. `root`, `bodyTruncated`,
 * `truncatedPages`, `failures`, and `nodes` are optional so a hand-written edge
 * dump that only carries provenance can still be replayed.
 */
export const decodeRenderedEdgeArtifact = (input: unknown): RenderedEdgeArtifact => {
  if (input === null || typeof input !== "object") {
    throw new Error("rendered-edge artifact must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value["kind"] !== ARTIFACT_KIND) {
    throw new Error(
      `rendered-edge artifact \`kind\` must be "${ARTIFACT_KIND}" (received ${JSON.stringify(value["kind"])})`,
    );
  }
  if (value["schemaVersion"] !== RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported rendered-edge artifact schemaVersion: ${JSON.stringify(value["schemaVersion"])}`,
    );
  }
  const origin = requiredAbsoluteUrl(value["origin"], "origin");
  const seed = requiredAbsoluteUrl(value["seed"], "seed");
  const crawl = value["crawl"];
  if (crawl === null || typeof crawl !== "object") {
    throw new Error("rendered-edge artifact must carry a `crawl` object");
  }
  const provenance = crawl as Record<string, unknown>;
  const truncatedPages = provenance["truncatedPages"];
  if (
    truncatedPages !== undefined &&
    (!Array.isArray(truncatedPages) || !truncatedPages.every((url) => typeof url === "string"))
  ) {
    throw new Error("rendered-edge artifact `truncatedPages` must be an array of URLs");
  }
  const bodyTruncated = provenance["bodyTruncated"];
  if (bodyTruncated !== undefined && typeof bodyTruncated !== "boolean") {
    throw new Error("rendered-edge artifact `bodyTruncated` must be a boolean");
  }
  if (typeof provenance["truncated"] !== "boolean") {
    throw new Error("rendered-edge artifact `crawl.truncated` must be a boolean");
  }
  const skipped = provenance["skipped"];
  if (skipped !== undefined && (!Array.isArray(skipped) || !skipped.every((url) => typeof url === "string"))) {
    throw new Error("rendered-edge artifact `crawl.skipped` must be an array of URLs");
  }
  for (const field of ["sitemapTruncated", "sitemapUsed"] as const) {
    if (provenance[field] !== undefined && typeof provenance[field] !== "boolean") {
      throw new Error(`rendered-edge artifact \`crawl.${field}\` must be a boolean`);
    }
  }
  return {
    kind: ARTIFACT_KIND,
    schemaVersion: RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION,
    origin,
    seed,
    crawl: {
      pages: requiredInteger(provenance["pages"], "crawl.pages", 0),
      root: typeof provenance["root"] === "string" ? provenance["root"] : pathKeyOf(seed),
      limit: requiredInteger(provenance["limit"], "crawl.limit", 1),
      truncated: provenance["truncated"],
      bodyTruncated: bodyTruncated === true,
      truncatedPages: (truncatedPages as ReadonlyArray<string> | undefined) ?? [],
      failures: decodeArtifactFailures(provenance["failures"]),
      ...(provenance["discoveryFailures"] === undefined ? {} : { discoveryFailures: decodeArtifactFailures(provenance["discoveryFailures"]) }),
      ...(skipped === undefined ? {} : { skipped: skipped as ReadonlyArray<string> }),
      ...(provenance["sitemapTruncated"] === undefined ? {} : { sitemapTruncated: provenance["sitemapTruncated"] as boolean }),
      ...(provenance["sitemapUsed"] === undefined ? {} : { sitemapUsed: provenance["sitemapUsed"] as boolean }),
    },
    nodes: decodeArtifactNodes(value["nodes"]),
    edges: decodeArtifactEdges(value["edges"]),
  };
};
