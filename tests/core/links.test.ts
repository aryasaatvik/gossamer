import { describe, expect, it } from "vitest";

import {
  buildRenderedGraph,
  diffLinkGraph,
  extractAnchors,
  normalizePath,
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
