import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SeoGraph } from "../../src/core/graph";
import { collectWorkflowEvidence } from "../../src/workflows/evidence";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const node = (path: string, kind: "page" | "article") => ({
  path,
  kind,
  source: "route",
  policy: { kind, sitemap: { priority: 0.5, changeFrequency: "monthly" as const } },
});

describe("workflow evidence", () => {
  it("keeps bounded targets while preserving direct inbound and outbound neighbor evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "pagegraph-evidence-"));
    directories.push(root);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "AGENTS.md"), "project context");
    writeFileSync(join(root, "docs/seo.md"), "seo context");
    const graph: SeoGraph = {
      nodes: new Map([
        ["/pricing", node("/pricing", "page")],
        ["/blog/one", node("/blog/one", "article")],
        ["/blog/two", node("/blog/two", "article")],
        ["/blog/unrelated", node("/blog/unrelated", "article")],
      ]),
      edges: [
        { from: "/blog/one", to: "/pricing", type: "related" },
        { from: "/blog/two", to: "/blog/one", type: "related" },
      ],
    };

    const evidence = collectWorkflowEvidence(
      graph,
      {
        pages: ["/blog/one"],
        queries: [],
        kinds: ["article"],
        competitors: [],
        domains: [],
        limit: 1,
        refresh: false,
        dryRun: false,
        allowDirty: false,
      },
      root,
      "research.keywords",
      {
        files: ["AGENTS.md"],
        byWorkflow: { "research.keywords": ["AGENTS.md", "docs/seo.md"] },
      },
    );

    expect(evidence.graph.nodes.map((item) => item.path)).toEqual(["/blog/one"]);
    expect(evidence.graph.edges).toEqual([]);
    expect(evidence.neighborhood).toEqual({
      inbound: [
        expect.objectContaining({
          edge: { from: "/blog/two", to: "/blog/one", type: "related" },
          node: expect.objectContaining({ path: "/blog/two", kind: "article", source: "route" }),
        }),
      ],
      outbound: [
        expect.objectContaining({
          edge: { from: "/blog/one", to: "/pricing", type: "related" },
          node: expect.objectContaining({ path: "/pricing", kind: "page", source: "route" }),
        }),
      ],
    });
    expect([
      ...evidence.graph.nodes.map((item) => item.path),
      ...evidence.neighborhood.inbound.map((item) => item.node.path),
      ...evidence.neighborhood.outbound.map((item) => item.node.path),
    ]).not.toContain("/blog/unrelated");
    expect(evidence.sources).toEqual([
      { path: "AGENTS.md", content: "project context" },
      { path: "docs/seo.md", content: "seo context" },
    ]);
  });
});
