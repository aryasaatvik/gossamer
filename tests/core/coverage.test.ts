import { describe, expect, it } from "vitest";

import {
  checkCoverage,
  checkGraph,
  checkRenderedCoverage,
  hasStructuralViolations,
} from "../../src/core/checks";
import type { RouteSeo, SeoKind } from "../../src/core/declare";
import type { SeoEdge, SeoGraph, SeoNode } from "../../src/core/graph";
import type { LinkEdge } from "../../src/core/links";

const SITEMAP = { priority: 0.5, changeFrequency: "monthly" } as const;

const routeNode = (path: string, policy: Partial<RouteSeo> & { kind: SeoKind }): SeoNode => ({
  path,
  kind: policy.kind,
  source: "route",
  policy,
});

const moneyNode = (path: string): SeoNode => routeNode(path, { kind: "page", sitemap: { ...SITEMAP } });

const graphOf = (nodes: Array<SeoNode>, edges: Array<SeoEdge> = []): SeoGraph => ({
  nodes: new Map(nodes.map((node) => [node.path, node])),
  edges,
});

const related = (from: string, to: string): SeoEdge => ({ from, to, type: "related" });

describe("checkCoverage", () => {
  it("passes when a matched page has enough incoming contextual links", () => {
    const graph = graphOf(
      [moneyNode("/pricing"), moneyNode("/about")],
      [related("/about", "/pricing")],
    );
    expect(checkCoverage(graph, [{ path: "/pricing", minInbound: 1 }])).toEqual([]);
  });

  it("flags a matched page with too few incoming contextual links, as structural", () => {
    const graph = graphOf([moneyNode("/pricing")]);
    const violations = checkCoverage(graph, [{ path: "/pricing", minInbound: 2 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      severity: "structural",
      rule: "inbound-link-coverage",
      path: "/pricing",
    });
    expect(violations[0]?.message).toContain("requires 2");
  });

  it("counts only related edges, not breadcrumb ancestry", () => {
    const graph = graphOf(
      [moneyNode("/pricing"), moneyNode("/about")],
      [{ from: "/pricing", to: "/about", type: "crumb-parent" }],
    );
    expect(checkCoverage(graph, [{ path: "/about", minInbound: 1 }])).toHaveLength(1);
  });

  it("enforces multiple rules independently", () => {
    const graph = graphOf(
      [moneyNode("/pricing"), moneyNode("/compare"), moneyNode("/about")],
      [related("/pricing", "/compare")],
    );
    const violations = checkCoverage(graph, [
      { path: "/compare", minInbound: 1 }, // satisfied
      { path: "/pricing", minInbound: 1 }, // violated
    ]);
    expect(violations.map((violation) => violation.path)).toEqual(["/pricing"]);
  });

  it("supports * and ** globs and checks every matched page", () => {
    const graph = graphOf(
      [
        moneyNode("/features/email"),
        moneyNode("/features/sms"),
        moneyNode("/features/deep/nested"),
        moneyNode("/blog/one"),
      ],
      [related("/blog/one", "/features/email")],
    );
    // email is satisfied by the related edge; sms is not.
    expect(
      checkCoverage(graph, [{ path: "/features/*", minInbound: 1 }]).map(
        (violation) => violation.path,
      ),
    ).toEqual(["/features/sms"]);
    // `*` does not cross a segment boundary; `**` does.
    expect(
      checkCoverage(graph, [{ path: "/features/**", minInbound: 1 }])
        .map((violation) => violation.path)
        .sort(),
    ).toEqual(["/features/deep/nested", "/features/sms"]);
    expect(checkCoverage(graph, [{ path: "/features/*", minInbound: 1 }])).toHaveLength(1);
  });

  it("flags a rule glob that matches no page", () => {
    const graph = graphOf([moneyNode("/pricing")]);
    const violations = checkCoverage(graph, [{ path: "/missing", minInbound: 1 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "coverage-rule-unmatched", severity: "structural" });
    expect(violations[0]?.message).toContain("matches no page");
  });

  it("flags a rule that only matches non-sitemap-eligible pages", () => {
    const graph = graphOf([
      routeNode("/draft", { kind: "page", sitemap: { ...SITEMAP }, robots: "noindex" }),
    ]);
    const violations = checkCoverage(graph, [{ path: "/draft", minInbound: 1 }]);
    expect(violations[0]?.rule).toBe("coverage-rule-unmatched");
    expect(violations[0]?.message).toContain("not sitemap-eligible");
  });
});

describe("checkRenderedCoverage", () => {
  const body = (from: string, to: string): LinkEdge => ({ from, to, region: "body" });
  const nav = (from: string, to: string): LinkEdge => ({ from, to, region: "nav" });

  it("counts served body anchors and ignores chrome regions", () => {
    const graph = graphOf([moneyNode("/pricing"), moneyNode("/about")], []);
    const violations = checkRenderedCoverage(
      graph,
      [body("/about", "/pricing"), nav("/", "/pricing")],
      [{ path: "/pricing", minInbound: 2 }],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "inbound-link-coverage", path: "/pricing" });
    expect(violations[0]?.message).toContain("has 1 incoming");
  });

  it("passes when the served body anchors meet the rule", () => {
    const graph = graphOf([moneyNode("/pricing"), moneyNode("/about")], []);
    expect(
      checkRenderedCoverage(
        graph,
        [body("/about", "/pricing")],
        [{ path: "/pricing", minInbound: 1 }],
      ),
    ).toEqual([]);
  });

  it("uses the declared sitemap-eligible universe for rule matching", () => {
    const graph = graphOf([
      moneyNode("/pricing"),
      routeNode("/draft", { kind: "page", sitemap: { ...SITEMAP }, robots: "noindex" }),
    ]);
    // A rule aimed at a declared noindex page cannot be asserted on rendered data.
    const unmatched = checkRenderedCoverage(
      graph,
      [body("/", "/draft")],
      [{ path: "/draft", minInbound: 1 }],
    );
    expect(unmatched[0]?.rule).toBe("coverage-rule-unmatched");
    expect(unmatched[0]?.message).toContain("not sitemap-eligible");
    // A glob that matches no declared page reports accordingly.
    const missing = checkRenderedCoverage(graph, [], [{ path: "/missing", minInbound: 1 }]);
    expect(missing[0]?.message).toContain("matches no page");
  });

  it("does not count outgoing or crumb-only declarations", () => {
    const graph = graphOf(
      [moneyNode("/pricing"), moneyNode("/about")],
      [related("/pricing", "/about")],
    );
    // Declared related edge exists, but nothing renders an anchor into /pricing.
    expect(
      checkRenderedCoverage(
        graph,
        [body("/pricing", "/about")],
        [{ path: "/pricing", minInbound: 1 }],
      ),
    ).toHaveLength(1);
  });
});

describe("checkGraph with coverage", () => {
  it("passes coverage violations through and makes the check structural", () => {
    const graph = graphOf([moneyNode("/pricing")]);
    const violations = checkGraph(graph, { coverage: [{ path: "/pricing", minInbound: 1 }] });
    expect(violations.map((violation) => violation.rule)).toContain("inbound-link-coverage");
    expect(hasStructuralViolations(violations)).toBe(true);
  });

  it("is unchanged when no coverage rules are supplied", () => {
    const graph = graphOf([moneyNode("/pricing"), moneyNode("/about")]);
    expect(checkGraph(graph)).toEqual(checkGraph(graph, { coverage: [] }));
  });
});
