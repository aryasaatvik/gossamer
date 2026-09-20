import { describe, expect, it } from "@effect/vitest";
import type { AnyRouteMatch } from "@tanstack/react-router";

import { orphanPaths, renderLinksDecideReport, renderTree, renderViolations } from "../../src/cli/render";
import { serializeGraph } from "../../src/cli/serialize";
import type { Violation } from "../../src/core/checks";
import type { SeoGraph, SeoNode } from "../../src/core/graph";
import type { LinksDecideReport } from "../../src/links/decide";

const graphOf = (nodes: Array<SeoNode>, edges: SeoGraph["edges"] = []): SeoGraph => ({
  nodes: new Map(nodes.map((node) => [node.path, node])),
  edges,
});

describe("serializeGraph", () => {
  const dynamicCrumb = (match: AnyRouteMatch): string => String(match.pathname);

  it("flattens the node Map to a path-sorted array and renders a function crumb as a sentinel", () => {
    const graph = graphOf([
      {
        path: "/pricing",
        kind: "page",
        source: "route",
        policy: { kind: "page", crumb: "Pricing" },
      },
      {
        path: "/blog/$slug",
        kind: "article",
        source: "route",
        policy: { kind: "article", crumb: dynamicCrumb },
      },
    ]);
    const serialized = serializeGraph(graph);
    expect(serialized.nodes.map((node) => node.path)).toEqual(["/blog/$slug", "/pricing"]);
    expect(serialized.nodes[0]?.policy.crumb).toBe("(dynamic)");
    expect(serialized.nodes[1]?.policy.crumb).toBe("Pricing");
    // The payload must round-trip through JSON with no functions surviving.
    expect(() => JSON.parse(JSON.stringify(serialized))).not.toThrow();
  });
});

describe("orphanPaths", () => {
  it("returns nodes with no incoming edge", () => {
    const graph = graphOf(
      [
        { path: "/", kind: "page", source: "route", policy: { kind: "page" } },
        { path: "/pricing", kind: "page", source: "route", policy: { kind: "page" } },
        { path: "/lonely", kind: "page", source: "route", policy: { kind: "page" } },
      ],
      [{ from: "/pricing", to: "/", type: "crumb-parent" }],
    );
    const orphans = orphanPaths(graph);
    expect(orphans.has("/")).toBe(false); // has an incoming crumb-parent edge
    expect(orphans.has("/pricing")).toBe(true);
    expect(orphans.has("/lonely")).toBe(true);
  });
});

describe("renderViolations", () => {
  const structural: Violation = {
    severity: "structural",
    rule: "dead-edge",
    path: "/x",
    message: "broken",
  };
  const editorial: Violation = {
    severity: "editorial",
    rule: "duplicate-title",
    path: "/y",
    message: "dupe",
  };

  it("reports a clean graph", () => {
    expect(renderViolations([])).toContain("No violations");
  });

  it("separates structural and editorial blocks and states the failing condition", () => {
    const output = renderViolations([structural, editorial]);
    expect(output).toContain("Structural (1)");
    expect(output).toContain("Editorial (1)");
    expect(output).toContain("structural violations fail the check");
  });

  it("notes editorial-only output as non-failing", () => {
    expect(renderViolations([editorial])).toContain("no structural violations");
  });
});

describe("renderTree", () => {
  it("renders an indented hierarchy with a summary line", () => {
    const graph = graphOf(
      [
        { path: "/", kind: "page", source: "route", policy: { kind: "page" } },
        {
          path: "/pricing",
          kind: "page",
          source: "route",
          policy: { kind: "page", sitemap: { priority: 0.9, changeFrequency: "weekly" } },
        },
      ],
      [{ from: "/pricing", to: "/", type: "crumb-parent" }],
    );
    const output = renderTree(graph);
    expect(output).toContain("/pricing  ·  page  sitemap:0.9");
    expect(output).toContain("2 nodes");
    expect(output).toContain("1 edges");
  });
});

describe("renderLinksDecideReport", () => {
  const relevance = {
    rating: 2,
    label: "essential" as const,
    probabilities: { irrelevant: 0.05, useful: 0.05, essential: 0.9 },
  };
  const report: LinksDecideReport = {
    kind: "links-decide",
    schemaVersion: 1,
    model: "jev-latest",
    threshold: 0.7,
    budget: 4,
    dropped: 0,
    counts: { candidates: 2, recommend: 1, present: 0, skip: 0, review: 1 },
    resolved: [
      {
        sourceUrl: "/blog/post",
        destinationUrl: "/pricing",
        sourceText: "See how pricing scales.",
        existingAnchor: null,
        realReason: 0.93,
        anchorPresent: 0.06,
        direction: "a_to_b",
        relevance,
        from: "/blog/post",
        to: "/pricing",
        verdict: "recommend",
      },
    ],
    review: [
      {
        sourceUrl: "/docs/start",
        destinationUrl: "/guides",
        sourceText: "A passing mention.",
        existingAnchor: null,
        realReason: 0.58,
        anchorPresent: 0.44,
        direction: "both",
        relevance,
        from: "/docs/start",
        to: "/guides",
        verdict: "review",
      },
    ],
  };

  it("groups resolved verdicts and surfaces the review bucket", () => {
    const output = renderLinksDecideReport(report);
    expect(output).toContain("2 candidate(s) · model jev-latest · threshold 0.70");
    expect(output).toContain("Recommend (1):");
    expect(output).toContain("/blog/post → /pricing");
    expect(output).toContain("realReason 0.93 · anchorPresent 0.06");
    expect(output).toContain("Review (1):");
    expect(output).toContain("/docs/start ↔ /guides");
  });

  it("states when nothing needs review", () => {
    const output = renderLinksDecideReport({
      ...report,
      counts: { ...report.counts, review: 0 },
      review: [],
    });
    expect(output).toContain("No candidates need review.");
    expect(output).not.toContain("Review (");
  });
});
