import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SeoCliConfig } from "../../src/config";
import type { SeoGraph } from "../../src/core/graph";
import type { DecisionBatchReport } from "../../src/decide/record";
import { runKeywordWorkflow } from "../../src/workflows/run";

const directories: Array<string> = [];
const git = (root: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("keyword workflow", () => {
  it("persists fake-host evidence and Jev state as a versioned run bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "pagegraph-workflow-"));
    directories.push(root);
    writeFileSync(join(root, "AGENTS.md"), "Use primary evidence.");
    writeFileSync(join(root, "remove.md"), "tracked before the run");
    git(root, "init");
    git(root, "config", "user.name", "PageGraph Test");
    git(root, "config", "user.email", "pagegraph@example.com");
    git(root, "add", "AGENTS.md", "remove.md");
    git(root, "commit", "-m", "test fixture");
    writeFileSync(join(root, "AGENTS.md"), "Use primary evidence.\nDirty before workflow.");
    const graph: SeoGraph = {
      nodes: new Map([
        [
          "/pricing",
          {
            path: "/pricing",
            kind: "page",
            source: "route",
            policy: { kind: "page", sitemap: { priority: 0.8, changeFrequency: "monthly" } },
          },
        ],
      ]),
      edges: [],
    };
    const config: SeoCliConfig = {
      origin: "https://example.com",
      disallow: [],
      loadGraph: async () => ({ graph, dispose: async () => {} }),
      workflows: {
        opencode: { configDirectory: ".pagegraph/opencode", defaultModel: "test/model" },
        context: { files: ["AGENTS.md"] },
        runsDirectory: ".pagegraph/runs",
      },
    };
    let closed = false;
    const report: DecisionBatchReport = {
      kind: "decide",
      schemaVersion: 1,
      family: "workflow-keywords",
      model: "jev-latest",
      threshold: 0.7,
      counts: { inputs: 1, resolved: 1, review: 0 },
      verdicts: { expand: 1 },
      resolved: [],
      review: [],
    };

    const result = await runKeywordWorkflow(
      {
        config,
        graph,
        root,
        options: {
          pages: [],
          queries: ["email api"],
          kinds: [],
          limit: 1,
          refresh: false,
        },
      },
      {
        now: (() => {
          const dates = [new Date("2026-09-21T10:00:00.000Z"), new Date("2026-09-21T10:00:01.000Z")];
          return () => dates.shift() ?? new Date("2026-09-21T10:00:01.000Z");
        })(),
        acquireHost: async () => ({
          model: { provider: "test", id: "model" },
          researchKeywords: async (_prompt) => {
            writeFileSync(join(root, "AGENTS.md"), "Changed again during workflow.");
            rmSync(join(root, "remove.md"));
            return {
              state: {
                summary: "One supported opportunity.",
                opportunities: [
                  {
                    query: "email api",
                    intent: "commercial",
                    rationale: "Matches the pricing page.",
                    candidates: [{ path: "/pricing", title: "Pricing", excerpt: "Email API pricing" }],
                    evidence: ["executor.search -> keyword tool"],
                  },
                  {
                    query: "second query",
                    intent: "informational",
                    rationale: "Should be truncated by --limit.",
                    candidates: [],
                    evidence: ["executor.search -> keyword tool"],
                  },
                ],
              },
              sessionId: "session-1",
              transcript: { messages: [{ type: "assistant", content: [] }] },
              executor: {
                searches: [{ tool: "codemode", input: {}, output: { matches: 1 } }],
                calls: [{ tool: "codemode", input: {}, output: { demand: 10 } }],
              },
            };
          },
          close: async () => {
            closed = true;
          },
        }),
        decide: async () => report,
      },
    );

    expect(closed).toBe(true);
    expect(result.run).toMatchObject({
      kind: "pagegraph-workflow-run",
      schemaVersion: 1,
      workflow: "research.keywords",
      model: { provider: "test", id: "model" },
      opencode: { sessionId: "session-1" },
      changes: { files: ["AGENTS.md", "remove.md"] },
      result: { opportunities: [{ query: "email api" }] },
    });
    expect(existsSync(join(result.directory, "summary.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.directory, "run.json"), "utf8"))).toMatchObject({
      evidence: {
        executor: {
          searches: [{ tool: "codemode" }],
          calls: [{ tool: "codemode" }],
        },
      },
      decisions: [{ family: "workflow-keywords" }],
    });
  });
});
