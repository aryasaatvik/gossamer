import { describe, expect, it } from "vitest";

import {
  candidateSourceText,
  decodeRenderedEdges,
  generateLinkCandidates,
  matchesClusterFilter,
  undirectedEdgeKey,
} from "../../src/core/link-candidates";
import type { RouteSeo, SeoKind } from "../../src/core/declare";
import type { SeoEdge, SeoGraph, SeoNode } from "../../src/core/graph";

const SITEMAP = { priority: 0.5, changeFrequency: "monthly" } as const;

const routeNode = (path: string, policy: Partial<RouteSeo> & { kind: SeoKind }): SeoNode => ({
  path,
  kind: policy.kind,
  source: "route",
  policy,
});

const instanceNode = (
  path: string,
  kind: SeoKind = "article",
  instance: { title: string; description?: string | undefined } = { title: path },
): SeoNode => ({
  path,
  kind,
  source: "blog",
  policy: { kind, sitemap: { ...SITEMAP } },
  instance,
});

const graphOf = (nodes: Array<SeoNode>, edges: Array<SeoEdge> = []): SeoGraph => ({
  nodes: new Map(nodes.map((node) => [node.path, node])),
  edges,
});

const pairs = (graph: SeoGraph, options?: Parameters<typeof generateLinkCandidates>[1]) =>
  generateLinkCandidates(graph, options).candidates.map((c) => `${c.source}→${c.destination}`);

describe("generateLinkCandidates", () => {
  it("proposes both directions within a shared top-level section", () => {
    const graph = graphOf([
      instanceNode("/blog/a"),
      instanceNode("/blog/b"),
      instanceNode("/blog/c"),
    ]);
    const result = generateLinkCandidates(graph);
    expect(pairs(graph)).toEqual([
      "/blog/a→/blog/b",
      "/blog/a→/blog/c",
      "/blog/b→/blog/a",
      "/blog/b→/blog/c",
      "/blog/c→/blog/a",
      "/blog/c→/blog/b",
    ]);
    expect(result.clusters).toEqual([{ key: "blog", candidates: 6 }]);
    expect(result.candidates[0]?.reason).toBe('same top-level section "/blog"');
  });

  it("falls back to kind for root-level pages with no shared section", () => {
    const graph = graphOf([
      routeNode("/pricing", { kind: "page", sitemap: { ...SITEMAP } }),
      routeNode("/about", { kind: "page", sitemap: { ...SITEMAP } }),
    ]);
    const result = generateLinkCandidates(graph);
    expect(pairs(graph)).toEqual(["/about→/pricing", "/pricing→/about"]);
    expect(result.clusters).toEqual([{ key: "kind:page", candidates: 2 }]);
    expect(result.candidates[0]?.reason).toBe('same kind "page"');
  });

  it("does not connect pages that share neither a section nor a kind", () => {
    const graph = graphOf([
      routeNode("/pricing", { kind: "page", sitemap: { ...SITEMAP } }),
      instanceNode("/blog/a"),
    ]);
    expect(pairs(graph)).toEqual([]);
  });

  it("does not group nested pages from different sections by kind", () => {
    const graph = graphOf([
      instanceNode("/blog/a"),
      instanceNode("/docs/b"),
      instanceNode("/blog/c"),
    ]);
    // /blog/a and /blog/c share the "/blog" section; /docs/b shares only a kind.
    expect(pairs(graph)).toEqual([
      "/blog/a→/blog/c",
      "/blog/c→/blog/a",
    ]);
    expect(generateLinkCandidates(graph).clusters).toEqual([{ key: "blog", candidates: 2 }]);
  });

  it("keeps the kind fallback local to root-level pages", () => {
    const graph = graphOf([
      routeNode("/", { kind: "page", sitemap: { ...SITEMAP } }),
      routeNode("/pricing", { kind: "page", sitemap: { ...SITEMAP } }),
      routeNode("/blog", { kind: "page", sitemap: { ...SITEMAP } }),
      instanceNode("/blog/a"),
    ]);
    // Section-first still pairs a section root with its nested page...
    expect(pairs(graph)).toContain("/blog→/blog/a");
    // ...and the root-level pages cluster together by kind...
    expect(pairs(graph)).toContain("/pricing→/blog");
    // ...but a root-level page never joins a nested section by kind.
    expect(pairs(graph)).not.toContain("/pricing→/blog/a");
  });

  it("excludes pairs already declared as a related edge, in either direction", () => {
    const graph = graphOf(
      [instanceNode("/blog/a"), instanceNode("/blog/b")],
      [{ from: "/blog/a", to: "/blog/b", type: "related" }],
    );
    expect(pairs(graph)).toEqual([]);
  });

  it("excludes pairs already rendered as an anchor when rendered edges are supplied", () => {
    const graph = graphOf([instanceNode("/blog/a"), instanceNode("/blog/b")]);
    expect(pairs(graph, { renderedEdges: [{ from: "/blog/b", to: "/blog/a" }] })).toEqual([]);
  });

  it("normalizes queries and hashes on rendered edges before excluding", () => {
    const graph = graphOf([instanceNode("/blog/a"), instanceNode("/blog/b")]);
    expect(
      pairs(graph, { renderedEdges: [{ from: "/blog/a?ref=nav", to: "/blog/b#details" }] }),
    ).toEqual([]);
  });

  it("normalizes queries and hashes on declared edges before excluding", () => {
    const graph = graphOf(
      [instanceNode("/blog/a"), instanceNode("/blog/b")],
      [{ from: "/blog/a/?ref=nav", to: "/blog/b#details", type: "related" }],
    );
    expect(pairs(graph)).toEqual([]);
  });

  it("does not treat a breadcrumb edge as an existing contextual connection", () => {
    const graph = graphOf(
      [routeNode("/blog", { kind: "hub", sitemap: { ...SITEMAP } }), instanceNode("/blog/a")],
      [{ from: "/blog/a", to: "/blog", type: "crumb-parent" }],
    );
    expect(pairs(graph)).toEqual(["/blog→/blog/a", "/blog/a→/blog"]);
  });

  it("excludes noindex, redirect, sitemap-excluded, and param-template pages", () => {
    const graph = graphOf([
      routeNode("/pricing", {
        kind: "page",
        sitemap: { ...SITEMAP },
        robots: "noindex, follow",
      }),
      routeNode("/legacy", { kind: "page", sitemap: { ...SITEMAP }, redirectTo: "/pricing" }),
      routeNode("/hidden", { kind: "page" }),
      routeNode("/blog/$slug", { kind: "article", sitemap: { ...SITEMAP } }),
      routeNode("/about", { kind: "page", sitemap: { ...SITEMAP } }),
    ]);
    expect(pairs(graph)).toEqual([]);
  });

  it("restricts to a cluster with a section or bare-kind filter", () => {
    const graph = graphOf([
      instanceNode("/blog/a"),
      instanceNode("/blog/b"),
      routeNode("/pricing", { kind: "page", sitemap: { ...SITEMAP } }),
      routeNode("/about", { kind: "page", sitemap: { ...SITEMAP } }),
    ]);
    expect(pairs(graph, { clusters: ["blog"] })).toEqual([
      "/blog/a→/blog/b",
      "/blog/b→/blog/a",
    ]);
    expect(pairs(graph, { clusters: ["/blog"] })).toHaveLength(2);
    expect(pairs(graph, { clusters: ["page"] })).toEqual([
      "/about→/pricing",
      "/pricing→/about",
    ]);
  });

  it("orders deterministically, reports totals, and truncates at limit", () => {
    const graph = graphOf([
      instanceNode("/blog/a"),
      instanceNode("/blog/b"),
      instanceNode("/blog/c"),
    ]);
    const result = generateLinkCandidates(graph, { limit: 2 });
    expect(result.candidates.map((c) => `${c.source}→${c.destination}`)).toEqual([
      "/blog/a→/blog/b",
      "/blog/a→/blog/c",
    ]);
    expect(result.total).toBe(6);
    expect(result.truncated).toBe(true);
    expect(result.clusters).toEqual([{ key: "blog", candidates: 6 }]);
  });

  it("returns nothing for an empty graph", () => {
    expect(generateLinkCandidates(graphOf([]))).toEqual({
      candidates: [],
      total: 0,
      truncated: false,
      clusters: [],
    });
  });
});

describe("undirectedEdgeKey", () => {
  it("normalizes trailing slashes and ignores direction", () => {
    expect(undirectedEdgeKey("/a/", "/b")).toBe(undirectedEdgeKey("/b", "/a"));
  });

  it("normalizes queries and hashes to the graph's path key", () => {
    expect(undirectedEdgeKey("/a?ref=nav", "/b#details")).toBe(undirectedEdgeKey("/a", "/b"));
    expect(undirectedEdgeKey("/", "/b/?x=1")).toBe(undirectedEdgeKey("/b", "/"));
  });
});

describe("matchesClusterFilter", () => {
  it("matches a section by name and a kind by its bare label", () => {
    expect(matchesClusterFilter("blog", "blog")).toBe(true);
    expect(matchesClusterFilter("blog", "/blog")).toBe(true);
    expect(matchesClusterFilter("kind:article", "article")).toBe(true);
    expect(matchesClusterFilter("kind:article", "kind:article")).toBe(true);
    expect(matchesClusterFilter("blog", "docs")).toBe(false);
  });
});

describe("candidateSourceText", () => {
  it("prefers an instance description, then title, then route link metadata, then the path", () => {
    expect(candidateSourceText(instanceNode("/blog/a", "article", { title: "T", description: "D" }))).toBe("D");
    expect(candidateSourceText(instanceNode("/blog/a", "article", { title: "T" }))).toBe("T");
    expect(
      candidateSourceText(
        routeNode("/pricing", {
          kind: "page",
          link: { title: "Pricing", description: "Per-email pricing." },
        }),
      ),
    ).toBe("Per-email pricing.");
    expect(candidateSourceText(routeNode("/bare", { kind: "page" }))).toBe("/bare");
  });
});

describe("decodeRenderedEdges", () => {
  it("accepts a bare array, an object with edges, and an object with internalEdges", () => {
    const edge = { from: "/a", to: "/b" };
    expect(decodeRenderedEdges([edge])).toEqual([edge]);
    expect(decodeRenderedEdges({ edges: [edge] })).toEqual([edge]);
    expect(decodeRenderedEdges({ internalEdges: [edge] })).toEqual([edge]);
  });

  it("rejects malformed input", () => {
    expect(() => decodeRenderedEdges({ nope: true })).toThrow("expected an array");
    expect(() => decodeRenderedEdges([{ from: "/a" }])).toThrow("string `from` and `to`");
    expect(() => decodeRenderedEdges(["x"])).toThrow("string `from` and `to`");
  });
});
