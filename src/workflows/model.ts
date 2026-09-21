import type { DecisionBatchReport } from "../decide/record";
import type { SerializedGraph } from "../cli/serialize";

export interface ExecutorEvidenceRecord {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

export interface ExecutorEvidence {
  readonly searches: ReadonlyArray<ExecutorEvidenceRecord>;
  readonly calls: ReadonlyArray<ExecutorEvidenceRecord>;
}

export type WorkflowId = "research.keywords";

export interface WorkflowTargetOptions {
  readonly pages: ReadonlyArray<string>;
  readonly queries: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<string>;
  readonly limit: number;
  readonly market?: string | undefined;
  readonly language?: string | undefined;
  readonly refresh: boolean;
  readonly input: boolean;
}

export interface KeywordCandidate {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface KeywordOpportunity {
  readonly query: string;
  readonly intent: string;
  readonly rationale: string;
  readonly demand?: number | undefined;
  readonly candidates: ReadonlyArray<KeywordCandidate>;
  readonly evidence: ReadonlyArray<string>;
}

export interface KeywordResearchState {
  readonly summary: string;
  readonly opportunities: ReadonlyArray<KeywordOpportunity>;
}

export interface WorkflowRunV1 {
  readonly kind: "pagegraph-workflow-run";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workflow: WorkflowId;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly project: { readonly root: string; readonly head?: string; readonly dirtyAtStart: boolean };
  readonly options: WorkflowTargetOptions;
  readonly model: { readonly provider: string; readonly id: string };
  readonly targets: {
    readonly pages: ReadonlyArray<string>;
    readonly queries: ReadonlyArray<string>;
    readonly kinds: ReadonlyArray<string>;
  };
  readonly evidence: {
    readonly graph: SerializedGraph;
    readonly sources: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    readonly executor: ExecutorEvidence;
  };
  readonly decisions: ReadonlyArray<DecisionBatchReport>;
  readonly changes: {
    readonly files: ReadonlyArray<string>;
    readonly providerCalls: ReadonlyArray<string>;
  };
  readonly result: KeywordResearchState;
  readonly opencode: { readonly agent: "seo"; readonly sessionId: string; readonly transcript: unknown };
}
