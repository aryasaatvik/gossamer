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
