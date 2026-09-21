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
  it("filters the graph and deduplicates global and workflow context", () => {
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
      ]),
      edges: [
        { from: "/blog/one", to: "/pricing", type: "related" },
        { from: "/blog/two", to: "/pricing", type: "related" },
      ],
    };

    const evidence = collectWorkflowEvidence(
      graph,
      {
        pages: ["/blog/*"],
        queries: [],
        kinds: ["article"],
        limit: 1,
        refresh: false,
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
    expect(evidence.sources).toEqual([
      { path: "AGENTS.md", content: "project context" },
      { path: "docs/seo.md", content: "seo context" },
    ]);
  });
});
