import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SeoCliConfig } from "../../src/config";
import type { SeoGraph } from "../../src/core/graph";
import type { DecisionBatchReport } from "../../src/decide/record";
import type { WorkflowId } from "../../src/workflows/model";
import type { WorkflowHostResult } from "../../src/workflows/opencode";
import { runKeywordWorkflow, runWorkflow } from "../../src/workflows/run";

// Vite treats Markdown imports as asset URLs even when Vitest runs under Bun.
vi.mock("../../src/workflows/prompts/research.md", async () => {
  const { readFile } = await import("node:fs/promises");
  return { default: await readFile(new URL("../../src/workflows/prompts/research.md", import.meta.url), "utf8") };
});
vi.mock("../../src/workflows/prompts/action.md", async () => {
  const { readFile } = await import("node:fs/promises");
  return { default: await readFile(new URL("../../src/workflows/prompts/action.md", import.meta.url), "utf8") };
});

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
          research: async (prompt, workflowOptions) => {
            expect(prompt).toContain("Return at most 1 items or opportunities.");
            expect(workflowOptions.skills).toEqual(["keyword-research"]);
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
    expect(existsSync(join(result.directory, "research.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.directory, "run.json"), "utf8"))).toMatchObject({
      evidence: { executor: executorEvidence },
      decisions: [{ family: "workflow-keywords" }],
    });
  });

  it("preserves validated research when the decision provider fails", async () => {
    const { root, graph, config } = fixture();
    const providerError = new Error("decision transport failed");
    let closed = false;

    let thrown: unknown;
    try {
      await runKeywordWorkflow(
        { config, graph, root, options },
        {
          now: () => new Date("2026-09-21T10:00:00.000Z"),
          acquireHost: async () => ({
            model: { provider: "test", id: "model" },
            research: async () => ({
              state: { summary: "One supported opportunity.", opportunities: [{
                query: "email api",
                intent: "commercial",
                rationale: "Matches the pricing page.",
                candidates: [{ path: "/pricing", title: "Pricing", excerpt: "Email API pricing" }],
                evidence: ["executor.search -> keyword tool"],
              }] },
              sessionId: "session-failed-decision",
              transcript: { messages: ["research transcript"] },
              executor: executorEvidence,
            }),
            continue: async () => {
              throw new Error("read-only workflow must not continue into an action turn");
            },
            close: async () => {
              closed = true;
            },
          }),
          decide: async () => {
            throw providerError;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(providerError);
    const message = (thrown as Error).message;
    const match = message.match(/Research checkpoint: (.+)$/);
    expect(match).not.toBeNull();
    const checkpointPath = match?.[1];
    expect(checkpointPath).toBeDefined();
    expect(closed).toBe(true);

    const checkpoint = JSON.parse(readFileSync(checkpointPath!, "utf8")) as Record<string, any>;
    expect(checkpoint).toMatchObject({
      kind: "pagegraph-workflow-research-checkpoint",
      schemaVersion: 1,
      workflow: "research.keywords",
      project: { root, dirtyAtStart: false, filesAtStart: [] },
      evidence: { executor: executorEvidence },
      state: { summary: "One supported opportunity." },
      decisionInputs: [{ query: "email api" }],
      opencode: {
        agent: "seo",
        sessionId: "session-failed-decision",
        model: { provider: "test", id: "model" },
        transcript: { messages: ["research transcript"] },
      },
    });
    const directory = dirname(checkpointPath!);
    expect(existsSync(join(directory, "run.json"))).toBe(false);
    expect(existsSync(join(directory, "summary.md"))).toBe(false);
  });

  it("detects checkpoint edits made after research during a read-only workflow", async () => {
    const { root, graph, config } = fixture();
    let thrown: unknown;

    try {
      await runKeywordWorkflow(
        { config, graph, root, options },
        {
          acquireHost: async () => ({
            model: { provider: "test", id: "model" },
            research: async () => ({
              state: { summary: "One supported opportunity.", opportunities: [{
                query: "email api",
                intent: "commercial",
                rationale: "Matches the pricing page.",
                candidates: [{ path: "/pricing", title: "Pricing", excerpt: "Email API pricing" }],
                evidence: ["executor.search -> keyword tool"],
              }] },
              sessionId: "session-mutated-checkpoint",
              transcript: { messages: ["research transcript"] },
              executor: executorEvidence,
            }),
            continue: async () => {
              throw new Error("read-only workflow must not continue into an action turn");
            },
            close: async () => {},
          }),
          decide: async () => {
            const runId = readdirSync(join(root, ".pagegraph", "runs"))[0];
            const checkpointPath = join(root, ".pagegraph", "runs", runId!, "research.json");
            writeFileSync(checkpointPath, `${readFileSync(checkpointPath, "utf8")}\nchanged after checkpoint\n`);
            return report("workflow-keywords");
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("changed repository files while running in read-only mode");
    expect((thrown as Error).message).toContain("Research checkpoint:");
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
              { action: "edit", resource: `${root}/**`, effect: "deny" },
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
        decide: async () => testCase.workflow === "improve.links"
          ? { ...report(testCase.family), resolved: [{ decisionId: "workflow-links:0", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict: "add", review: false, answers: {} }] }
          : report(testCase.family),
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

  it.each(["skip", "review"])("never opens an edit turn for %s link suggestions", async (verdict) => {
    const { root, graph, config } = fixture();
    graph.nodes.set("/docs/email", { path: "/docs/email", kind: "page", source: "route", policy: { kind: "page", sitemap: { priority: 0.5, changeFrequency: "monthly" } } });
    const suggestion = { source: "/docs/email", destination: "/pricing", cluster: "kind:page", reason: "same kind; pricing options are relevant", sentence: "See the pricing options for transactional email teams.", anchor: "pricing options", targetSentence: "Pricing options include usage based plans for teams.", score: 4, scores: { topical: 2, rarity: 1, inboundNeed: 1, graph: 0.5 } };
    const path = join(root, "suggestions.json");
    writeFileSync(path, JSON.stringify({ kind: "links-candidates", schemaVersion: 2, origin: config.origin, limit: 1, pageLimit: 2, total: 1, truncated: false, skipped: [], candidates: [suggestion] }));
    git(root, "add", "suggestions.json"); git(root, "commit", "-m", "add suggestions");
    const state = { summary: "One candidate", items: [{ from: suggestion.source, to: suggestion.destination, anchor: suggestion.anchor, context: suggestion.sentence, relation: "pricing" }] };
    let continued = false;
    const result = await runWorkflow({ config, graph, root, workflow: "improve.links", options: { ...options, limit: 2, suggestions: path } }, {
      acquireHost: async () => ({
        model: { provider: "test", id: "model" },
        research: async (prompt) => { expect(prompt).toContain(suggestion.sentence); return { state, sessionId: "links", transcript: {}, executor: executorEvidence }; },
        continue: async () => { continued = true; throw new Error("edit turn opened"); },
        close: async () => {},
      }),
      decide: async () => ({ ...report("workflow-links"), resolved: verdict === "skip" ? [{ decisionId: "workflow-links:0", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict, review: false, answers: {} }] : [], review: verdict === "review" ? [{ decisionId: "workflow-links:0", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict, review: true, answers: {} }] : [] }),
    });
    expect(continued).toBe(false);
    expect(result.run.result).toMatchObject({ outcome: "no-change" });
    expect(result.run.evidence.suggestions?.candidates[0]).toMatchObject({ sentence: suggestion.sentence, anchor: suggestion.anchor });
    expect(result.run.changes.files).toEqual([]);
  });

  it("rejects a wrong-origin suggestion before acquiring a host", async () => {
    const { root, graph, config } = fixture();
    const path = join(root, "wrong.json");
    writeFileSync(path, JSON.stringify({ kind: "links-candidates", schemaVersion: 2, origin: "https://other.example", candidates: [] }));
    git(root, "add", "wrong.json"); git(root, "commit", "-m", "add wrong suggestions");
    let acquired = false;
    await expect(runWorkflow({ config, graph, root, workflow: "improve.links", options: { ...options, suggestions: path } }, {
      acquireHost: async () => { acquired = true; throw new Error("host acquired"); },
    })).rejects.toThrow("Expected schema-version-2 suggestions");
    expect(acquired).toBe(false);
  });

  it("passes only the accepted item when links share the same source and target", async () => {
    const { root, graph, config } = fixture();
    const accepted = { from: "/docs/email", to: "/pricing", anchor: "pricing options", context: "See pricing options for teams.", relation: "plans" };
    const rejected = { ...accepted, anchor: "cheap offers", context: "Find cheap offers today." };
    let actionPrompt = "";
    await runWorkflow({ config, graph, root, workflow: "improve.links", options }, {
      acquireHost: async () => ({
        model: { provider: "test", id: "model" },
        research: async () => ({ state: { summary: "Two proposals", items: [accepted, rejected] }, sessionId: "links", transcript: {}, executor: executorEvidence }),
        continue: async (_sessionId, prompt) => { actionPrompt = prompt; return { state: { summary: "One edit", files: [], outcome: "applied" }, sessionId: "links", transcript: {}, executor: executorEvidence }; },
        close: async () => {},
      }),
      decide: async () => ({ ...report("workflow-links"), resolved: [{ decisionId: "workflow-links:0", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict: "add", review: false, answers: {} }],
        review: [{ decisionId: "workflow-links:1", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict: "review", review: true, answers: {} }] }),
    });
    expect(actionPrompt).toContain(accepted.anchor);
    expect(actionPrompt).not.toContain(rejected.anchor);
  });

  it("keeps an accepted suggestion read-only in dry-run mode", async () => {
    const { root, graph, config } = fixture();
    const item = { from: "/docs/email", to: "/pricing", anchor: "pricing options", context: "See pricing options for teams.", relation: "plans" };
    let continued = false;
    const result = await runWorkflow({ config, graph, root, workflow: "improve.links", options: { ...options, dryRun: true } }, {
      acquireHost: async () => ({
        model: { provider: "test", id: "model" },
        research: async () => ({ state: { summary: "One proposal", items: [item] }, sessionId: "links", transcript: {}, executor: executorEvidence }),
        continue: async (_sessionId, prompt, workflowOptions) => {
          continued = true;
          expect(prompt).toContain("Do not edit files");
          expect(workflowOptions.permissions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "edit", effect: "deny" })]));
          return { state: { summary: "Preview", files: [], outcome: "dry-run" }, sessionId: "links", transcript: {}, executor: executorEvidence };
        },
        close: async () => {},
      }),
      decide: async () => ({ ...report("workflow-links"), resolved: [{ decisionId: "workflow-links:0", schemaVersion: 1, family: "workflow-links", model: "jev-latest", threshold: 0.7, inputHash: "fixture", inputRef: "/docs/email → /pricing", verdict: "add", review: false, answers: {} }] }),
    });
    expect(continued).toBe(true);
    expect(result.run.changes.files).toEqual([]);
  });
});
