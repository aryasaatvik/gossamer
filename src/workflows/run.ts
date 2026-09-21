import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import type { SeoCliConfig } from "../config";
import type { SeoGraph } from "../core/graph";
import type { DecisionBatchReport } from "../decide/record";
import { createRunId, writeRunBundle } from "./artifact";
import { getWorkflowSpec } from "./catalog";
import { collectWorkflowEvidence } from "./evidence";
import { changedFiles, inspectGit } from "./git";
import type { WorkflowMutationPolicy } from "./mutation";
import { createWorkflowMutationPolicy, repositoryMutationPermissionRules } from "./mutation";
import type { WorkflowId, WorkflowRunV1, WorkflowTargetOptions } from "./model";
import type { WorkflowHost } from "./opencode";
import { acquireWorkflowHost } from "./opencode";
import actionPromptSource from "./prompts/action.md" with { type: "text" };
import researchPromptSource from "./prompts/research.md" with { type: "text" };
import type { AnyWorkflowSpec } from "./specs/types";
import { TextTemplate } from "./template";

export interface WorkflowInput {
  readonly config: SeoCliConfig;
  readonly graph: SeoGraph;
  readonly root: string;
  readonly workflow: WorkflowId;
  readonly options: WorkflowTargetOptions;
  readonly model?: string | undefined;
  readonly out?: string | undefined;
}

export interface WorkflowDependencies {
  readonly acquireHost?: typeof acquireWorkflowHost;
  readonly decide?: (
    inputs: ReadonlyArray<unknown>,
    spec: AnyWorkflowSpec,
  ) => Promise<DecisionBatchReport>;
  readonly now?: () => Date;
}

const defaultDecide = async (
  inputs: ReadonlyArray<unknown>,
  spec: AnyWorkflowSpec,
): Promise<DecisionBatchReport> => {
  const layer = TypeSafeDecisionModel.model("jev-latest").pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.provide(FetchHttpClient.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Config.Redacted("TYPESAFE_API_KEY");
      return yield* spec.runDecisions({ inputs, model: "jev-latest", threshold: 0.7 });
    }).pipe(Effect.provide(layer)),
  );
};

const capState = (state: unknown, limit: number): unknown => {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return state;
  const record = state as Record<string, unknown>;
  if (Array.isArray(record["opportunities"])) {
    return { ...record, opportunities: record["opportunities"].slice(0, limit) };
  }
  if (Array.isArray(record["items"])) return { ...record, items: record["items"].slice(0, limit) };
  return state;
};

const researchPrompt = (
  spec: AnyWorkflowSpec,
  evidence: ReturnType<typeof collectWorkflowEvidence>,
  options: WorkflowTargetOptions,
): string =>
  TextTemplate.from(researchPromptSource)
    .values({
      workflow: spec.id,
      instructions: spec.researchInstructions,
      skills: spec.skills.join(", "),
      stateSchema: JSON.stringify(spec.stateJsonSchema),
      market: options.market ?? "unspecified",
      language: options.language ?? "unspecified",
      device: options.device ?? "unspecified",
      refresh: options.refresh,
      queries: JSON.stringify(options.queries),
      competitors: JSON.stringify(options.competitors),
      domains: JSON.stringify(options.domains),
      evidence: JSON.stringify(evidence),
    })
    .render();

const actionPrompt = (
  spec: AnyWorkflowSpec,
  state: unknown,
  decisions: DecisionBatchReport,
  policy: WorkflowMutationPolicy,
): string =>
  TextTemplate.from(actionPromptSource)
    .values({
      workflow: spec.id,
      instructions: spec.actionInstructions ?? "Produce the final recommendation.",
      state: JSON.stringify(state),
      decisions: JSON.stringify(decisions),
      mutationMode: policy.mode,
      mutationInstruction:
        policy.mode === "dry-run"
          ? "Do not edit files. Describe the exact intended changes only."
          : "Edit the owning source files through OpenCode tools and inspect the resulting diff.",
    })
    .render();

const decisionArtifact = (
  spec: AnyWorkflowSpec,
  inputs: ReadonlyArray<unknown>,
  report: DecisionBatchReport,
) => ({ family: spec.familyName, questions: spec.decisionQuestions(inputs), report });

export const runWorkflow = async (
  input: WorkflowInput,
  dependencies: WorkflowDependencies = {},
): Promise<{ readonly run: WorkflowRunV1; readonly directory: string }> => {
  const workflows = input.config.workflows;
  if (workflows === undefined) {
    throw new Error("seo.config.ts has no workflows configuration; run `pagegraph init` and configure workflows.");
  }
  const spec = getWorkflowSpec(input.workflow);
  const now = dependencies.now ?? (() => new Date());
  const started = now();
  const id = createRunId(started, spec.id);
  const gitAtStart = inspectGit(input.root);
  const mutation = createWorkflowMutationPolicy({
    root: input.root,
    dirtyAtStart: gitAtStart.dirty,
    dryRun: spec.mutatesFiles ? input.options.dryRun : true,
    allowDirty: input.options.allowDirty,
  });
  if (spec.mutatesFiles) mutation.assertStartAllowed();

  const evidence = collectWorkflowEvidence(
    input.graph,
    input.options,
    input.root,
    spec.id,
    workflows.context,
  );
  const acquire = dependencies.acquireHost ?? acquireWorkflowHost;
  const host: WorkflowHost = await acquire({
    root: input.root,
    config: workflows.opencode,
    model: input.model ?? workflows.opencode.models?.[spec.id],
  });
  try {
    const researchPermissions = repositoryMutationPermissionRules(input.root);
    const actionPermissions =
      spec.mutatesFiles && !input.options.dryRun
        ? mutation.sessionPermissions
        : researchPermissions;
    const researched = await host.research(researchPrompt(spec, evidence, input.options), {
      skills: spec.skills,
      permissions: researchPermissions,
    });
    const gitAfterResearch = inspectGit(input.root);
    const researchFiles = changedFiles(gitAtStart, gitAfterResearch);
    if (researchFiles.length > 0) {
      throw new Error(
        `${spec.id} changed repository files during its read-only research turn: ${researchFiles.join(", ")}`,
      );
    }
    const state = spec.decodeState(capState(researched.state, input.options.limit));
    const decisionInputs = spec.decisionInputs(state);
    for (const item of decisionInputs) {
      const error = spec.validateDecisionInput(item);
      if (error !== undefined) throw new Error(error);
    }
    const decisionReport = await (dependencies.decide ?? defaultDecide)(decisionInputs, spec);
    const acted = spec.mutatesFiles
      ? await host.continue(researched.sessionId, actionPrompt(spec, state, decisionReport, mutation), {
          skills: spec.skills,
          permissions: actionPermissions,
        })
      : researched;
    const gitAfter = inspectGit(input.root);
    const files = changedFiles(gitAtStart, gitAfter);
    if ((!spec.mutatesFiles || input.options.dryRun) && files.length > 0) {
      throw new Error(`${spec.id} changed repository files while running in read-only mode: ${files.join(", ")}`);
    }
    const run: WorkflowRunV1 = {
      kind: "pagegraph-workflow-run",
      schemaVersion: 1,
      id,
      workflow: spec.id,
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
      evidence: { ...evidence, executor: acted.executor },
      decisions: [decisionArtifact(spec, decisionInputs, decisionReport)],
      changes: {
        files,
        providerCalls: acted.executor.calls.map((call) => call.tool),
      },
      result: spec.mutatesFiles ? acted.state : state,
      opencode: { agent: "seo", sessionId: acted.sessionId, transcript: acted.transcript },
    };
    const runsDirectory = input.out ?? workflows.runsDirectory ?? ".pagegraph/runs";
    return { run, directory: writeRunBundle(input.root, runsDirectory, run) };
  } finally {
    await host.close();
  }
};

export type KeywordWorkflowInput = Omit<WorkflowInput, "workflow">;
export type KeywordWorkflowDependencies = WorkflowDependencies;

export const runKeywordWorkflow = (
  input: KeywordWorkflowInput,
  dependencies: KeywordWorkflowDependencies = {},
): Promise<{ readonly run: WorkflowRunV1; readonly directory: string }> =>
  runWorkflow({ ...input, workflow: "research.keywords" }, dependencies);
