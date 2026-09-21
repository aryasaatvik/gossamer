import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SeoCliConfig } from "../../src/config";
import type { SeoGraph } from "../../src/core/graph";
import type { DecisionBatchReport } from "../../src/decide/record";
import type { WorkflowId } from "../../src/workflows/model";
import type { WorkflowHostResult } from "../../src/workflows/opencode";
import { runKeywordWorkflow, runWorkflow } from "../../src/workflows/run";

const directories: Array<string> = [];
const git = (root: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pagegraph-workflow-"));
  directories.push(root);
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
  writeFileSync(join(root, "AGENTS.md"), "Use primary evidence.\n");
  git(root, "init");
  git(root, "config", "user.name", "PageGraph Test");
  git(root, "config", "user.email", "pagegraph@example.com");
  git(root, "add", "AGENTS.md");
  git(root, "commit", "-m", "test fixture");
  return { root, graph, config };
};

const options = {
  pages: [] as ReadonlyArray<string>,
  queries: ["email api"] as ReadonlyArray<string>,
  kinds: [] as ReadonlyArray<string>,
  competitors: [] as ReadonlyArray<string>,
  domains: [] as ReadonlyArray<string>,
  limit: 1,
  refresh: false,
  dryRun: false,
  allowDirty: false,
};

const report = (family: string): DecisionBatchReport => ({
  kind: "decide",
  schemaVersion: 1,
  family,
  model: "jev-latest",
  threshold: 0.7,
  counts: { inputs: 1, resolved: 1, review: 0 },
  verdicts: { apply: 1 },
  resolved: [],
  review: [],
});

const executorEvidence = {
  searches: [{ tool: "codemode", input: { query: "SEO" }, output: ["tools.gsc.performance"] }],
  calls: [{ tool: "codemode", input: { path: "gsc.performance" }, output: { rows: [] } }],
};

const mutationCases: ReadonlyArray<{
  readonly name: string;
  readonly workflow: WorkflowId;
  readonly family: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly state: unknown;
}> = [
  {
    name: "content in Fumadocs-like MDX",
    workflow: "improve.content",
    family: "content",
    file: "content/docs/email.mdx",
    before: "# Email API\n\nOld overview.\n",
    after: "# Email API\n\nSend and observe transactional email from one API.\n",
    state: {
      summary: "The docs overview is thin.",
      items: [{
        url: "/docs/email",
        query: "email api",
        title: "Email API",
        h1: "Email API",
        first150Words: "Old overview.",
        headings: ["Email API"],
        wordCount: 3,
        structuredData: [],
        categoryLock: "email API",
        siblingIntents: ["email pricing"],
        competitorExcerpts: ["A concrete competing overview."],
      }],
    },
  },
  {
    name: "metadata in a TanStack route",
    workflow: "improve.metadata",
    family: "meta",
    file: "src/routes/(marketing)/pricing.tsx",
    before: 'export const title = "Old pricing";\n',
    after: 'export const title = "Email API pricing";\n',
    state: {
      summary: "Two metadata candidates.",
      items: [{
        url: "/pricing",
        intent: "commercial email API pricing",
        categoryLock: "AI-native email for product teams",
        candidates: [
          { id: "a", title: "Email API pricing", description: "Clear pricing for product teams." },
          { id: "b", title: "Samva pricing", description: "Plans for AI-native email." },
        ],
      }],
    },
  },
  {
    name: "schema in a TanStack route",
    workflow: "improve.schema",
    family: "workflow-schema",
    file: "src/routes/(marketing)/pricing.tsx",
    before: "export const jsonLd = [];\n",
    after: 'export const jsonLd = [{ "@type": "OfferCatalog" }];\n',
    state: {
      summary: "Pricing visibly supports an offer catalog.",
      items: [{
        url: "/pricing",
        pageKind: "page",
        routeSource: "src/routes/(marketing)/pricing.tsx",
        existingTypes: [],
        proposedTypes: ["OfferCatalog"],
        evidence: ["Visible pricing tiers"],
      }],
    },
  },
  {
    name: "contextual links in Fumadocs-like MDX",
    workflow: "improve.links",
    family: "workflow-links",
    file: "content/docs/email.mdx",
    before: "See the pricing options.\n",
    after: "See the [pricing options](/pricing).\n",
    state: {
      summary: "The docs page has a useful pricing transition.",
      items: [{
        from: "/docs/email",
        to: "/pricing",
        anchor: "pricing options",
        context: "See the pricing options.",
        relation: "commercial next step",
      }],
    },
  },
];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow runner", () => {
  it("persists bounded read-only evidence without changing a dirty tree", async () => {
    const { root, graph, config } = fixture();
    writeFileSync(join(root, "AGENTS.md"), "Use primary evidence.\nExisting user change.\n");
    let closed = false;
    const researched: WorkflowHostResult = {
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
      transcript: { messages: ["full transcript"] },
      executor: executorEvidence,
    };

    const result = await runKeywordWorkflow(
      { config, graph, root, options },
      {
        now: (() => {
          const dates = [new Date("2026-09-21T10:00:00.000Z"), new Date("2026-09-21T10:00:01.000Z")];
          return () => dates.shift() ?? new Date("2026-09-21T10:00:01.000Z");
        })(),
        acquireHost: async () => ({
          model: { provider: "test", id: "model" },
          research: async (_prompt, workflowOptions) => {
            expect(workflowOptions.skills).toEqual(["content"]);
            expect(workflowOptions.permissions).toEqual(
              expect.arrayContaining([expect.objectContaining({ action: "edit", effect: "deny" })]),
            );
            return researched;
          },
          continue: async () => {
            throw new Error("read-only workflow must not continue into an action turn");
          },
          close: async () => {
            closed = true;
          },
        }),
        decide: async () => report("workflow-keywords"),
      },
    );

    expect(closed).toBe(true);
    expect(result.run).toMatchObject({
      kind: "pagegraph-workflow-run",
      schemaVersion: 1,
      workflow: "research.keywords",
      model: { provider: "test", id: "model" },
      opencode: { sessionId: "session-1" },
      changes: { files: [] },
      result: { opportunities: [{ query: "email api" }] },
    });
    expect(existsSync(join(result.directory, "summary.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.directory, "run.json"), "utf8"))).toMatchObject({
      evidence: { executor: executorEvidence },
      decisions: [{ family: "workflow-keywords" }],
    });
  });

  it.each(mutationCases)("applies $name in the same session and records its source diff", async (testCase) => {
    const { root, graph, config } = fixture();
    mkdirSync(dirname(join(root, testCase.file)), { recursive: true });
    writeFileSync(join(root, testCase.file), testCase.before);
    git(root, "add", testCase.file);
    git(root, "commit", "-m", "add workflow source");
    let actionSession: string | undefined;

    const result = await runWorkflow(
      { config, graph, root, workflow: testCase.workflow, options },
      {
        acquireHost: async () => ({
          model: { provider: "test", id: "model" },
          research: async (_prompt, workflowOptions) => {
            expect(workflowOptions.permissions).toEqual([
              { action: "edit", resource: `${root}/**`, effect: "allow" },
              { action: "shell", resource: "*", effect: "deny" },
            ]);
            return {
              state: testCase.state,
              sessionId: `session-${testCase.family}`,
              transcript: { messages: ["research"] },
              executor: executorEvidence,
            };
          },
          continue: async (sessionId, _prompt, workflowOptions) => {
            actionSession = sessionId;
            expect(workflowOptions.permissions).toEqual([
              { action: "edit", resource: `${root}/**`, effect: "allow" },
              { action: "shell", resource: "*", effect: "deny" },
            ]);
            writeFileSync(join(root, testCase.file), testCase.after);
            return {
              state: { summary: `Updated ${testCase.workflow}.`, files: [testCase.file], outcome: "applied" },
              sessionId,
              transcript: { messages: ["research", "action"] },
              executor: executorEvidence,
            };
          },
          close: async () => {},
        }),
        decide: async () => report(testCase.family),
      },
    );

    expect(actionSession).toBe(`session-${testCase.family}`);
    expect(result.run.changes.files).toEqual([testCase.file]);
    expect(result.run.result).toEqual({
      summary: `Updated ${testCase.workflow}.`,
      files: [testCase.file],
      outcome: "applied",
    });
    expect(readFileSync(join(root, testCase.file), "utf8")).toBe(testCase.after);
  });
});
