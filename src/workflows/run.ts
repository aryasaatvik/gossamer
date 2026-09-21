import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import type { SeoCliConfig } from "../config";
import type { SeoGraph } from "../core/graph";
import type { DecisionBatchReport } from "../decide/record";
import { runDecisions } from "../decide/run";
import { collectWorkflowEvidence } from "./evidence";
import { changedFiles, inspectGit } from "./git";
import type { WorkflowHost } from "./opencode";
import { acquireWorkflowHost } from "./opencode";
import researchPromptSource from "./prompts/research-keywords.md" with { type: "text" };
import { createRunId, writeRunBundle } from "./artifact";
import { keywordFamily, KeywordResearchStateSchema } from "./specs/keywords";
import { TextTemplate } from "./template";
import type { WorkflowRunV1, WorkflowTargetOptions } from "./model";

export interface KeywordWorkflowInput {
  readonly config: SeoCliConfig;
  readonly graph: SeoGraph;
  readonly root: string;
  readonly options: WorkflowTargetOptions;
  readonly model?: string | undefined;
  readonly out?: string | undefined;
}

export interface KeywordWorkflowDependencies {
  readonly acquireHost?: typeof acquireWorkflowHost;
  readonly decide?: (
    inputs: ReadonlyArray<import("./specs/keywords").KeywordOpportunityInput>,
  ) => Promise<DecisionBatchReport>;
  readonly now?: () => Date;
}

const defaultDecide = async (
  inputs: ReadonlyArray<import("./specs/keywords").KeywordOpportunityInput>,
): Promise<DecisionBatchReport> => {
  const layer = TypeSafeDecisionModel.model("jev-latest").pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.provide(FetchHttpClient.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Config.Redacted("TYPESAFE_API_KEY");
      return yield* runDecisions({
        family: keywordFamily,
        inputs,
        model: "jev-latest",
        threshold: 0.7,
      });
    }).pipe(Effect.provide(layer)),
  );
};

const promptFor = (
  evidence: ReturnType<typeof collectWorkflowEvidence>,
  options: WorkflowTargetOptions,
): string =>
  TextTemplate.from(researchPromptSource)
    .values({
      stateSchema: JSON.stringify(Schema.toJsonSchemaDocument(KeywordResearchStateSchema)),
      market: options.market ?? "unspecified",
      language: options.language ?? "unspecified",
      refresh: options.refresh,
      queries: JSON.stringify(options.queries),
      evidence: JSON.stringify(evidence),
    })
    .render();

export const runKeywordWorkflow = async (
  input: KeywordWorkflowInput,
  dependencies: KeywordWorkflowDependencies = {},
): Promise<{ readonly run: WorkflowRunV1; readonly directory: string }> => {
  const workflows = input.config.workflows;
  if (workflows === undefined) {
    throw new Error("seo.config.ts has no workflows configuration; run `pagegraph init` and configure workflows.");
  }
  const now = dependencies.now ?? (() => new Date());
  const started = now();
  const id = createRunId(started);
  const gitAtStart = inspectGit(input.root);
  const evidence = collectWorkflowEvidence(
    input.graph,
    input.options,
    input.root,
    "research.keywords",
    workflows.context,
  );
  const acquire = dependencies.acquireHost ?? acquireWorkflowHost;
  const host: WorkflowHost = await acquire({
    root: input.root,
    config: workflows.opencode,
    model: input.model ?? workflows.opencode.models?.["research.keywords"],
  });
  try {
    const researched = await host.researchKeywords(promptFor(evidence, input.options));
    const state = {
      ...researched.state,
      opportunities: researched.state.opportunities.slice(0, input.options.limit),
    };
    const decisions = await (dependencies.decide ?? defaultDecide)(state.opportunities);
    const gitAfter = inspectGit(input.root);
    const run: WorkflowRunV1 = {
      kind: "pagegraph-workflow-run",
      schemaVersion: 1,
      id,
      workflow: "research.keywords",
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      project: { root: input.root, head: gitAtStart.head, dirtyAtStart: gitAtStart.dirty },
      options: input.options,
      model: host.model,
      targets: {
        pages: evidence.graph.nodes.map((node) => node.path),
        queries: input.options.queries,
        kinds: input.options.kinds,
      },
      evidence: { ...evidence, executor: researched.executor },
      decisions: [decisions],
      changes: {
        files: changedFiles(gitAtStart, gitAfter),
        providerCalls: researched.executor.calls.map((call) => call.tool),
      },
      result: state,
      opencode: { agent: "seo", sessionId: researched.sessionId, transcript: researched.transcript },
    };
    const runsDirectory = input.out ?? workflows.runsDirectory ?? ".pagegraph/runs";
    return { run, directory: writeRunBundle(input.root, runsDirectory, run) };
  } finally {
    await host.close();
  }
};
