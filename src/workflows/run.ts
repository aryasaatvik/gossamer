import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import type { SeoCliConfig } from "../config";
import { allowedByRobots, robotsRules } from "../audit/crawl";
import { probeHttp } from "../audit/scanners/http";
import type { SeoGraph } from "../core/graph";
import { decodeLinksSuggestionReport, extractPageSentences } from "../core/link-suggestions";
import type { DecisionBatchReport } from "../decide/record";
import { createRunId, writeResearchCheckpoint, writeResearchFailure, writeRunBundle } from "./artifact";
import { getWorkflowSpec } from "./catalog";
import { collectWorkflowEvidence, selectGraph } from "./evidence";
import { changedFiles, inspectGit } from "./git";
import type { WorkflowMutationPolicy } from "./mutation";
import { createWorkflowMutationPolicy, repositoryMutationPermissionRules } from "./mutation";
import type { WorkflowId, WorkflowResearchCheckpointV1, WorkflowRunV1, WorkflowTargetOptions } from "./model";
import type { WorkflowHost, WorkflowHostResult } from "./opencode";
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
  /** Test seam for current served-copy validation before an accepted link edit. */
  readonly readSuggestionSentences?: (origin: string, path: string, allowPrivate: boolean, maxBodyBytes: number) => Promise<ReadonlyArray<string>>;
}

const readCurrentSuggestionSentences = async (origin: string, path: string, allowPrivate: boolean, maxBodyBytes: number): Promise<ReadonlyArray<string>> => {
  const options = { sameOrigin: origin, allowPrivate, timeoutMs: 15_000, maxBodyBytes };
  const robots = await probeHttp({ kind: "robots", method: "GET", accept: "text/plain", url: new URL("/robots.txt", origin) }, { ...options, captureBody: true });
  if ((!robots.ok && robots.status !== 404) || robots.bodyTruncated) throw new Error("Could not verify current robots policy for suggestion freshness");
  const rules = robots.ok ? robotsRules(robots.body ?? "").rules : [];
  const url = new URL(path, origin);
  if (!allowedByRobots(`${url.pathname}${url.search}`, rules)) throw new Error(`Suggestion page is robots-disallowed: ${path}`);
  const probe = await probeHttp({ kind: "page-html", method: "GET", accept: "text/html", url }, {
    ...options, captureBody: true, allowUrl: (next) => allowedByRobots(`${next.pathname}${next.search}`, rules),
  });
  const contentType = probe.responseHeaders["content-type"];
  if (!probe.ok || probe.bodyTruncated || !probe.body || !probe.finalUrl
    || (contentType !== undefined && !/text\/html|application\/xhtml\+xml/i.test(contentType))
    || new URL(probe.finalUrl).pathname.replace(/\/+$/, "") !== path.replace(/\/+$/, "")) {
    throw new Error(`Could not verify current served copy for suggestion page ${path}: ${probe.error ?? "unreadable or redirected page"}`);
  }
  return extractPageSentences(probe.body);
};

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
      limit: options.limit,
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
  const suggestionReport = input.options.suggestions === undefined ? undefined : (() => {
    if (spec.id !== "improve.links") throw new Error("--suggestions is only valid for improve links");
    const report = decodeLinksSuggestionReport(JSON.parse(readFileSync(resolve(input.root, input.options.suggestions), "utf8")), new URL(input.config.origin).origin);
    const selectedSources = selectGraph(input.graph, input.options).nodes;
    for (const candidate of report.candidates) {
      if (!input.graph.nodes.has(candidate.source) || !input.graph.nodes.has(candidate.destination)) {
        throw new Error(`Suggestion references a path absent from seo.config.ts: ${candidate.source} → ${candidate.destination}`);
      }
      if (!selectedSources.has(candidate.source)) {
        throw new Error(`Suggestion source is outside workflow page/kind/limit targets: ${candidate.source}`);
      }
    }
    return report;
  })();
  const suppliedEvidence = suggestionReport === undefined ? evidence : { ...evidence, suggestions: suggestionReport };
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
    let researched = await host.research(researchPrompt(spec, suppliedEvidence, input.options), {
      skills: spec.skills,
      permissions: researchPermissions,
    });
    const assertResearchReadOnly = (): void => {
      const researchFiles = changedFiles(gitAtStart, inspectGit(input.root));
      if (researchFiles.length > 0) throw new Error(`${spec.id} changed repository files during its read-only research turn: ${researchFiles.join(", ")}`);
    };
    assertResearchReadOnly();
    const decodeResearchState = (value: unknown) => spec.decodeState(capState(value, input.options.limit));
    let state: ReturnType<typeof decodeResearchState>;
    try {
      state = decodeResearchState(researched.state);
    } catch (firstError) {
      const original = researched;
      let repaired: WorkflowHostResult | undefined;
      try {
        repaired = await host.continue(researched.sessionId, [
          `The previous ${spec.id} research JSON did not match the required state schema: ${firstError instanceof Error ? firstError.message : String(firstError)}.`,
          `Return only one corrected JSON object matching this schema: ${JSON.stringify(spec.stateJsonSchema)}.`,
          "Use only evidence already collected. Do not call tools, edit files, or add commentary.",
        ].join(" "), { skills: spec.skills, permissions: researchPermissions });
        assertResearchReadOnly();
        state = decodeResearchState(repaired.state);
        researched = repaired;
      } catch (repairError) {
        const runsDirectory = input.out ?? workflows.runsDirectory ?? ".pagegraph/runs";
        const path = writeResearchFailure(input.root, runsDirectory, id, {
          kind: "pagegraph-workflow-research-failure", workflow: spec.id, original,
          repaired, firstError: String(firstError), repairError: String(repairError),
        });
        throw new Error(`${spec.id} research state failed schema validation after one read-only repair. Research failure artifact: ${path}`, { cause: repairError });
      }
    }
    const decisionInputs = spec.decisionInputs(state);
    if (suggestionReport !== undefined) {
      const valid = new Set(suggestionReport.candidates.map((item) => `${item.source}\u0000${item.destination}\u0000${item.anchor}\u0000${item.sentence}`));
      for (const item of decisionInputs) {
        const link = item as { from?: unknown; to?: unknown; anchor?: unknown; context?: unknown };
        if (!valid.has(`${link.from}\u0000${link.to}\u0000${link.anchor}\u0000${link.context}`)) {
          throw new Error("Research proposed a link absent from the supplied suggestions");
        }
      }
    }
    for (const item of decisionInputs) {
      const error = spec.validateDecisionInput(item);
      if (error !== undefined) throw new Error(error);
    }
    const runsDirectory = input.out ?? workflows.runsDirectory ?? ".pagegraph/runs";
    const checkpoint: WorkflowResearchCheckpointV1 = {
      kind: "pagegraph-workflow-research-checkpoint",
      schemaVersion: 1,
      id,
      workflow: spec.id,
      startedAt: started.toISOString(),
      checkpointedAt: now().toISOString(),
      project: {
        root: input.root,
        head: gitAtStart.head,
        dirtyAtStart: gitAtStart.dirty,
        filesAtStart: gitAtStart.files,
      },
      options: input.options,
      evidence: { ...suppliedEvidence, executor: researched.executor },
      state,
      decisionInputs,
      opencode: {
        agent: "seo",
        sessionId: researched.sessionId,
        model: host.model,
        transcript: researched.transcript,
      },
    };
    const checkpointPath = writeResearchCheckpoint(input.root, runsDirectory, checkpoint);
    const gitAtCheckpoint = inspectGit(input.root);

    try {
      const decisionReport = await (dependencies.decide ?? defaultDecide)(decisionInputs, spec);
      const accepted = spec.id === "improve.links"
        ? decisionReport.resolved.filter((record) => record.verdict === "add" || record.verdict === "update")
        : undefined;
      const acceptedIndexes = new Set<number>();
      if (accepted !== undefined) {
        for (const record of accepted) {
          const match = /^workflow-links:(\d+)$/.exec(record.decisionId);
          const index = match === null ? -1 : Number(match[1]);
          const item = decisionInputs[index] as { from?: string; to?: string } | undefined;
          if (!item || record.inputRef !== `${item.from} → ${item.to}`) {
            throw new Error(`Decision does not match a researched link: ${record.decisionId}`);
          }
          acceptedIndexes.add(index);
        }
      }
      const actionItems = accepted === undefined ? undefined : (state as { items: ReadonlyArray<unknown> }).items.filter((_, index) => acceptedIndexes.has(index));
      if (actionItems !== undefined && actionItems.length > 0 && suggestionReport !== undefined) {
        const readSentences = dependencies.readSuggestionSentences ?? readCurrentSuggestionSentences;
        const current = new Map<string, ReadonlyArray<string>>();
        for (const item of actionItems as ReadonlyArray<{ from: string; to: string; anchor: string; context: string }>) {
          const candidate = suggestionReport.candidates.find((entry) => entry.source === item.from && entry.destination === item.to
            && entry.anchor === item.anchor && entry.sentence === item.context);
          if (!candidate) throw new Error("Accepted link is absent from the supplied suggestions");
          for (const path of [candidate.source, candidate.destination]) {
            if (!current.has(path)) current.set(path, await readSentences(suggestionReport.origin, path, input.options.allowPrivate === true, suggestionReport.maxBodyBytes));
          }
          if (!current.get(candidate.source)!.includes(candidate.sentence) || !current.get(candidate.destination)!.includes(candidate.targetSentence)) {
            throw new Error(`Suggestion is stale; served copy changed for ${candidate.source} → ${candidate.destination}. Regenerate links candidates --site.`);
          }
        }
      }
      const actionState = actionItems === undefined ? state : { ...(state as Record<string, unknown>), items: actionItems };
      const actionDecisions = accepted === undefined ? decisionReport : {
        ...decisionReport,
        resolved: accepted,
        review: [],
        counts: { inputs: accepted.length, resolved: accepted.length, review: 0 },
        verdicts: { add: accepted.filter((record) => record.verdict === "add").length,
          update: accepted.filter((record) => record.verdict === "update").length },
      };
      const mayAct = spec.mutatesFiles && (actionItems === undefined || actionItems.length > 0);
      const acted = mayAct
        ? await host.continue(researched.sessionId, actionPrompt(spec, actionState, actionDecisions, mutation), {
            skills: spec.skills,
            permissions: actionPermissions,
          })
        : researched;
      const gitAfter = inspectGit(input.root);
      const files = changedFiles(gitAtCheckpoint, gitAfter);
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
        evidence: { ...suppliedEvidence, executor: acted.executor },
        decisions: [decisionArtifact(spec, decisionInputs, decisionReport)],
        changes: {
          files,
          providerCalls: acted.executor.calls.map((call) => call.tool),
        },
        result: mayAct ? acted.state : accepted !== undefined ? { summary: "No link suggestions accepted.", outcome: "no-change", files: [] } : state,
        opencode: { agent: "seo", sessionId: acted.sessionId, transcript: acted.transcript },
      };
      return { run, directory: writeRunBundle(input.root, runsDirectory, run) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${message}\nResearch checkpoint: ${checkpointPath}`, { cause });
    }
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
