/**
 * Pure candidate generation for contextual cross-links.
 *
 * Given the declared graph, enumerate `(source, destination)` pairs that are
 * *plausible* contextual links and *not already connected*. A pair is plausible
 * when the two pages sit in the same cluster: a shared top-level section (e.g.
 * `/blog/a` and `/blog/b` under `/blog`) or, for root-level pages that share no
 * section, the same `kind`. Only sitemap-eligible pages are candidates — a
 * noindex, redirect, or param template is not a link surface.
 *
 * The plan is a proposal, never an application: nothing here writes a
 * declaration. Effect- and framework-free so it runs in the CLI, a Worker, or a
 * test on the same graph.
 */

import type { SeoGraph, SeoNode } from "./graph";
import type { AnchorRegion, SimpleEdge } from "./links";
import { isSitemapEligible } from "./projections";

/** One proposed contextual link, in the direction the link would be authored. */
export interface LinkCandidatePair {
  readonly source: string;
  readonly destination: string;
  /** The cluster the pair shares: a top-level section, or `kind:<kind>`. */
  readonly cluster: string;
  /** Why the pair is plausible, e.g. `same top-level section "/blog"`. */
  readonly reason: string;
}

export interface LinkCandidateOptions {
  /** Maximum candidates to return after ordering (default 50). */
  readonly limit?: number;
  /** Restrict to these clusters; a filter may be a section or a bare kind. */
  readonly clusters?: ReadonlyArray<string>;
  /** Anchors already served in HTML. Only body-region edges exclude their own direction. */
  readonly renderedEdges?: ReadonlyArray<SimpleEdge & { readonly region?: AnchorRegion }>;
}

/** One cluster and how many candidate pairs it contributes (before `limit`). */
export interface LinkClusterSummary {
  readonly key: string;
  readonly candidates: number;
}

export interface LinkCandidateResult {
  readonly candidates: ReadonlyArray<LinkCandidatePair>;
  /** Candidate pairs before `limit` was applied (after cluster filters). */
  readonly total: number;
  readonly truncated: boolean;
  readonly clusters: ReadonlyArray<LinkClusterSummary>;
}

/**
 * Canonical path key: query and hash stripped, trailing slashes removed, "/"
 * preserved. This is the same path key the graph and the rendered-link core
 * use, so a served anchor like `/blog/a?ref=nav` still matches the graph pair
 * `/blog/a`.
 */
const normalize = (path: string): string => {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};

/** Directionless pair key, so an edge in either direction means "connected". */
export const undirectedEdgeKey = (from: string, to: string): string => {
  const [a, b] = [normalize(from), normalize(to)].sort();
  return `${a}\u0000${b}`;
};

const directedEdgeKey = (from: string, to: string): string => `${normalize(from)}\u0000${normalize(to)}`;

/** First path segment, or undefined for the root page. */
const topSegment = (path: string): string | undefined => {
  const segment = path.split("/").filter(Boolean)[0];
  return segment === undefined || segment === "" ? undefined : segment;
};

/** A page with no nested segment (`/`, `/pricing`, `/blog`) is root-level. */
const isRootLevel = (path: string): boolean => path.split("/").filter(Boolean).length <= 1;

/**
 * The cluster a pair shares, or undefined when they share none. Section-first:
 * a shared top-level section wins. The kind fallback is local to root-level
 * pages, so it never pairs two nested pages from different sections.
 */
export const candidateClusterOf = (a: SeoNode, b: SeoNode): { key: string; reason: string } | undefined => {
  const aSegment = topSegment(a.path);
  const bSegment = topSegment(b.path);
  if (aSegment !== undefined && aSegment === bSegment) {
    return { key: aSegment, reason: `same top-level section "/${aSegment}"` };
  }
  if (isRootLevel(a.path) && isRootLevel(b.path) && a.kind === b.kind) {
    return { key: `kind:${a.kind}`, reason: `same kind "${a.kind}"` };
  }
  return undefined;
};

/** A `--cluster` filter matches a section by name, or a kind via its bare label. */
export const matchesClusterFilter = (cluster: string, filter: string): boolean => {
  const normalized = filter.replace(/^\/+/, "").toLowerCase();
  const key = cluster.toLowerCase();
  return key === normalized || key === `kind:${normalized}`;
};

/** Human reason string for a candidate's source page, used when handing a plan to Jev. */
export const candidateSourceText = (node: SeoNode): string =>
  node.instance?.description?.trim() ||
  node.instance?.title?.trim() ||
  node.policy.link?.description?.trim() ||
  node.policy.link?.title?.trim() ||
  node.path;

/**
 * Enumerate reviewable contextual-link candidates from the declared graph.
 *
 * Excluded: self-pairs, pages that are not sitemap-eligible, pairs already
 * declared as a `related` edge, and — when {@link LinkCandidateOptions.renderedEdges}
 * is supplied — pairs already rendered as an anchor. Queries, hashes, and
 * trailing slashes are normalized so both sides compare by the graph's path key.
 */
export const generateLinkCandidates = (
  graph: SeoGraph,
  options: LinkCandidateOptions = {},
): LinkCandidateResult => {
  const limit = options.limit ?? 50;
  const filters = options.clusters ?? [];
  // Legacy bare edges have no region. Treat them as body links so a v1 edge dump
  // remains conservative; region-aware artifacts retain nav/header/footer edges.
  const rendered = new Set(
    (options.renderedEdges ?? []).filter((edge) => edge.region === undefined || edge.region === "body")
      .map((edge) => directedEdgeKey(edge.from, edge.to)),
  );
  const declared = new Set(
    graph.edges
      .filter((edge) => edge.type === "related")
      .map((edge) => directedEdgeKey(edge.from, edge.to)),
  );

  const eligible = [...graph.nodes.values()].filter(isSitemapEligible);

  const all: Array<LinkCandidatePair> = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      const cluster = candidateClusterOf(a, b);
      if (cluster === undefined) continue;
      if (filters.length > 0 && !filters.some((filter) => matchesClusterFilter(cluster.key, filter))) {
        continue;
      }
      for (const [source, destination] of [[a.path, b.path], [b.path, a.path]]) {
        const key = directedEdgeKey(source!, destination!);
        if (declared.has(key) || rendered.has(key)) continue;
        all.push({ source: source!, destination: destination!, cluster: cluster.key, reason: cluster.reason });
      }
    }
  }

  const compare = (x: LinkCandidatePair, y: LinkCandidatePair): number =>
    x.cluster < y.cluster
      ? -1
      : x.cluster > y.cluster
        ? 1
        : x.source < y.source
          ? -1
          : x.source > y.source
            ? 1
            : x.destination < y.destination
              ? -1
              : x.destination > y.destination
                ? 1
                : 0;
  all.sort(compare);

  const counts = new Map<string, number>();
  for (const pair of all) counts.set(pair.cluster, (counts.get(pair.cluster) ?? 0) + 1);

  const candidates = all.slice(0, limit);
  return {
    candidates,
    total: all.length,
    truncated: all.length > candidates.length,
    clusters: [...counts.entries()].map(([key, count]) => ({ key, candidates: count })),
  };
};

/**
 * Decode a rendered-edge dump supplied to the CLI: either a bare array of
 * `{ from, to }` edges, or an object carrying `edges` (or `internalEdges`).
 * Throws on any other shape — this is user input, not a provider payload.
 */
export const decodeRenderedEdges = (input: unknown): ReadonlyArray<SimpleEdge & { readonly region?: AnchorRegion }> => {
  const array =
    Array.isArray(input)
      ? input
      : input !== null && typeof input === "object" && Array.isArray((input as { edges?: unknown }).edges)
        ? (input as { edges: ReadonlyArray<unknown> }).edges
        : input !== null &&
            typeof input === "object" &&
            Array.isArray((input as { internalEdges?: unknown }).internalEdges)
          ? (input as { internalEdges: ReadonlyArray<unknown> }).internalEdges
          : undefined;

  if (array === undefined) {
    throw new Error(
      "expected an array of { from, to } edges, or an object with an `edges` array",
    );
  }

  return array.map((item) => {
    if (item === null || typeof item !== "object") {
      throw new Error("each rendered edge must be an object with string `from` and `to`");
    }
    const { from, to, region } = item as { from?: unknown; to?: unknown; region?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      throw new Error("each rendered edge must have string `from` and `to`");
    }
    if (region !== undefined && !["nav", "header", "footer", "body"].includes(region as string)) {
      throw new Error("rendered edge region must be nav, header, footer, or body");
    }
    return region === undefined ? { from, to } : { from, to, region: region as AnchorRegion };
  });
};
