import { describe, expect, it } from "vitest";

import {
  buildRenderedGraph,
  decodeRenderedEdgeArtifact,
  diffLinkGraph,
  extractAnchors,
  normalizePath,
  renderedGraphFromEdges,
} from "../../src/core/links";

describe("extractAnchors", () => {
  it("resolves relative hrefs against the page and marks internal/external", () => {
    const anchors = extractAnchors(
      `<a href="/docs">Docs</a><a href="https://other.test/x">Other</a><a href="/guides/ses/">SES</a>`,
      "https://example.com/page",
    );
    expect(anchors.map((a) => a.href)).toEqual([
      "https://example.com/docs",
      "https://other.test/x",
      "https://example.com/guides/ses/",
    ]);
    expect(anchors.map((a) => a.internal)).toEqual([true, false, true]);
  });

  it("skips non-navigable schemes and fragment-only links", () => {
    const anchors = extractAnchors(
      `<a href="#section">x</a><a href="mailto:a@b.c">m</a><a href="tel:1">t</a><a href="javascript:void(0)">j</a><a href="/real">r</a>`,
      "https://example.com/",
    );
    expect(anchors.map((a) => a.href)).toEqual(["https://example.com/real"]);
  });

  it("tags the region an anchor sits inside", () => {
    const html = `
      <header><a href="/h">header</a></header>
      <nav><a href="/n">nav</a></nav>
      <main><a href="/b">body</a></main>
      <footer><a href="/f">footer</a></footer>`;
    const regions = extractAnchors(html, "https://example.com/").map((a) => a.region);
    expect(regions).toEqual(["header", "nav", "body", "footer"]);
  });

  it("decodes entities and collapses whitespace in anchor text", () => {
    const [anchor] = extractAnchors(
      `<a href="/x">  Send&nbsp;<strong>email</strong>&amp; docs  </a>`,
      "https://example.com/",
    );
    expect(anchor?.text).toBe("Send email & docs");
  });

  it("ignores non-href attributes such as data-href and xhref", () => {
    const anchors = extractAnchors(
      `<a data-href="/decoy" href="/real">A</a><a xhref="/decoy2">B</a>`,
      "https://example.com/",
    );
    expect(anchors.map((anchor) => anchor.href)).toEqual(["https://example.com/real"]);
  });

  it("resolves relative links against the first <base href>", () => {
    const anchors = extractAnchors(
      `<base href="/docs/"><base href="/ignored/"><a href="guide">Guide</a><a href="/root">Root</a>`,
      "https://example.com/page",
    );
    expect(anchors.map((anchor) => anchor.href)).toEqual([
      "https://example.com/docs/guide",
      "https://example.com/root",
    ]);
  });

  it("falls back to the response URL for an invalid <base href>", () => {
    const anchors = extractAnchors(
      `<base href="http://["><a href="/real">Root</a>`,
      "https://example.com/page",
    );
    expect(anchors.map((anchor) => anchor.href)).toEqual(["https://example.com/real"]);
  });

  it("skips a <base> without href and uses the next one that has it", () => {
    const anchors = extractAnchors(
      `<base target="_blank"><base href="/app/"><a href="x">X</a>`,
      "https://example.com/page",
    );
    expect(anchors.map((anchor) => anchor.href)).toEqual(["https://example.com/app/x"]);
  });

  it("lets the first empty <base href> win and ignores later bases", () => {
    const anchors = extractAnchors(
      `<base href=""><base href="/ignored/"><a href="x">X</a>`,
      "https://example.com/page",
    );
    expect(anchors.map((anchor) => anchor.href)).toEqual(["https://example.com/x"]);
  });
});

describe("normalizePath", () => {
  it("strips trailing slashes, query, and hash but keeps root", () => {
    expect(normalizePath(new URL("https://x.test/guides/ses/?ref=1#a"))).toBe("/guides/ses");
    expect(normalizePath(new URL("https://x.test/"))).toBe("/");
  });
});

describe("buildRenderedGraph", () => {
  const pages = [
    {
      url: "https://example.com/",
      anchors: [
        { href: "https://example.com/compare", text: "compare", region: "body" as const, internal: true },
        { href: "https://example.com/nav", text: "nav", region: "nav" as const, internal: true },
      ],
    },
    {
      url: "https://example.com/compare",
      anchors: [
        { href: "https://example.com/", text: "home", region: "body" as const, internal: true },
        { href: "https://example.com/orphan", text: "o", region: "footer" as const, internal: true },
      ],
    },
    {
      url: "https://example.com/orphan",
      anchors: [],
    },
  ];

  it("splits contextual from nav/footer edges and computes depth from the root", () => {
    const graph = buildRenderedGraph("https://example.com", pages);
    expect(graph.contextualEdges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "/->/compare",
      "/compare->/",
    ]);
    expect(graph.depthByPath.get("/")).toBe(0);
    expect(graph.depthByPath.get("/compare")).toBe(1);
    expect(graph.depthByPath.get("/nav")).toBe(1);
    // /orphan is reached only through /compare's footer edge, so depth 2.
    expect(graph.depthByPath.get("/orphan")).toBe(2);
    expect(graph.maxDepth).toBe(2);
  });

  it("marks pages with no incoming internal edge as orphans", () => {
    const graph = buildRenderedGraph("https://example.com", pages);
    // /orphan is only linked from a footer edge, which still counts as incoming.
    expect(graph.orphans).toEqual([]);
  });

  it("drops pages and anchors outside the graph origin", () => {
    const graph = buildRenderedGraph("https://example.com", [
      {
        url: "https://example.com/",
        anchors: [
          { href: "https://other.test/x", text: "x", region: "body", internal: true },
          { href: "https://example.com/kept", text: "k", region: "body", internal: true },
        ],
      },
      {
        url: "https://other.test/other",
        anchors: [{ href: "https://example.com/leak", text: "l", region: "body", internal: true }],
      },
    ]);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["/->/kept"]);
    expect([...graph.depthByPath.keys()].sort()).toEqual(["/", "/kept"]);
  });

  it("roots depth at the seed's normalized final path after a redirect", () => {
    const graph = buildRenderedGraph(
      "https://example.com",
      [
        {
          url: "https://example.com/en",
          anchors: [
            { href: "https://example.com/en/next", text: "n", region: "body", internal: true },
          ],
        },
        { url: "https://example.com/en/next", anchors: [] },
      ],
      "/en",
    );
    expect(graph.depthByPath.get("/en")).toBe(0);
    expect(graph.depthByPath.get("/en/next")).toBe(1);
    expect(graph.maxDepth).toBe(1);
    // The redirected homepage is the root, not an orphan.
    expect(graph.orphans).toEqual([]);
  });
});

describe("diffLinkGraph", () => {
  it("reports each direction separately", () => {
    const graph = buildRenderedGraph("https://example.com", [
      {
        url: "https://example.com/",
        anchors: [
          { href: "https://example.com/rendered-only", text: "r", region: "body", internal: true },
        ],
      },
    ]);
    const diff = diffLinkGraph([{ from: "/", to: "/declared-only/" }], graph);
    // Declared paths are normalized (trailing slash stripped) before matching.
    expect(diff.declaredNotRendered).toEqual([{ from: "/", to: "/declared-only" }]);
    expect(diff.renderedNotDeclared).toEqual([{ from: "/", to: "/rendered-only" }]);
  });
});

describe("renderedGraphFromEdges", () => {
  const edges = [
    { from: "/", to: "/compare", region: "body" as const },
    { from: "/", to: "/nav", region: "nav" as const },
    { from: "/compare", to: "/", region: "body" as const },
    { from: "/compare", to: "/orphan", region: "footer" as const },
  ];

  it("rebuilds the same contextual split, depth, and orphans as a crawl", () => {
    const graph = renderedGraphFromEdges(edges, "/");
    expect(graph.contextualEdges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "/->/compare",
      "/compare->/",
    ]);
    expect(graph.depthByPath.get("/compare")).toBe(1);
    expect(graph.depthByPath.get("/orphan")).toBe(2);
    expect(graph.maxDepth).toBe(2);
    expect(graph.orphans).toEqual([]);
  });

  it("normalizes full URLs, trailing slashes, queries, and hashes to path keys", () => {
    const graph = renderedGraphFromEdges([
      { from: "https://example.com/", to: "https://example.com/a/?ref=1", region: "body" },
      { from: "/a#top", to: "/", region: "body" },
    ]);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["/->/a", "/a->/"]);
  });

  it("keeps an edge-less rendered page as a node when its path set is supplied", () => {
    // A redirect target with no internal links: the live crawl knows it rendered,
    // but the edge list alone cannot see it.
    const graph = renderedGraphFromEdges(
      [{ from: "/", to: "/leaf", region: "nav" }],
      "/",
      ["/", "/leaf", "/canonical"],
    );
    expect(graph.nodes).toEqual(["/", "/leaf", "/canonical"]);
    expect(graph.orphans).toEqual(["/canonical"]);
  });
});

describe("decodeRenderedEdgeArtifact", () => {
  const artifact = {
    kind: "links-rendered",
    schemaVersion: 1,
    origin: "https://example.com",
    seed: "https://example.com/",
    crawl: {
      pages: 2,
      root: "/",
      limit: 100,
      truncated: false,
      bodyTruncated: false,
      truncatedPages: [],
      failures: [],
    },
    nodes: ["/", "/about"],
    edges: [
      { from: "/", to: "/about", region: "body" },
      { from: "/about", to: "/", region: "nav" },
    ],
  };

  it("preserves provenance and region", () => {
    expect(decodeRenderedEdgeArtifact(artifact)).toEqual(artifact);
  });

  it("defaults an omitted region to body and an omitted root to the seed path", () => {
    const decoded = decodeRenderedEdgeArtifact({
      kind: "links-rendered",
      schemaVersion: 1,
      origin: "https://example.com",
      seed: "https://example.com/en/",
      crawl: { pages: 1, limit: 10, truncated: false },
      edges: [{ from: "/", to: "/en" }],
    });
    expect(decoded.edges).toEqual([{ from: "/", to: "/en", region: "body" }]);
    expect(decoded.crawl.root).toBe("/en");
    expect(decoded.crawl.truncatedPages).toEqual([]);
    expect(decoded.crawl.bodyTruncated).toBe(false);
    expect(decoded.crawl.failures).toEqual([]);
    expect(decoded.nodes).toEqual([]);
  });

  it("rejects an unsupported schema version", () => {
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, schemaVersion: 2 })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects a missing or wrong kind discriminator", () => {
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, kind: "links-verify" })).toThrow(/kind/);
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, kind: undefined })).toThrow(/kind/);
  });

  it("rejects a non-URL origin or seed", () => {
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, origin: "not a URL" })).toThrow(
      /absolute URL/,
    );
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, seed: "" })).toThrow(/seed/);
  });

  it("rejects a missing origin or crawl provenance", () => {
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, origin: "" })).toThrow(/origin/);
    expect(() =>
      decodeRenderedEdgeArtifact({
        ...artifact,
        crawl: { pages: 1, truncated: false },
      }),
    ).toThrow(/crawl\.limit/);
  });

  it("rejects an edge with a bad region or missing endpoints", () => {
    expect(() =>
      decodeRenderedEdgeArtifact({ ...artifact, edges: [{ from: "/", to: "/x", region: "main" }] }),
    ).toThrow(/region/);
    expect(() => decodeRenderedEdgeArtifact({ ...artifact, edges: [{ from: "/" }] })).toThrow(
      /string `from` and `to`/,
    );
  });

  it("rejects a malformed failure entry", () => {
    expect(() =>
      decodeRenderedEdgeArtifact({
        ...artifact,
        crawl: { ...artifact.crawl, failures: [{ url: "/x" }] },
      }),
    ).toThrow(/string `url` and `error`/);
  });
});
