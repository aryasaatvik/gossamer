import { aiSearchWorkflow } from "./specs/ai-search";
import { architectureWorkflow } from "./specs/architecture";
import { authorityWorkflow } from "./specs/authority";
import { competitorsWorkflow } from "./specs/competitors";
import { contentWorkflow, improveContentWorkflow } from "./specs/content";
import {
  KeywordResearchStateSchema,
  keywordFamily,
} from "./specs/keywords";
import { linksWorkflow } from "./specs/links";
import { metadataWorkflow } from "./specs/metadata";
import { serpWorkflow } from "./specs/serp";
import { schemaWorkflow } from "./specs/schema";
import { defineWorkflow, type AnyWorkflowSpec } from "./specs/types";
import { workflowIds } from "./model";
import type { WorkflowId } from "./model";
export { workflowIds } from "./model";
export type { WorkflowId } from "./model";

const keywordWorkflow = defineWorkflow({
  id: "research.keywords",
  skills: ["content"],
  mutatesFiles: false,
  stateSchema: KeywordResearchStateSchema,
  decisionInputs: (state) => state.opportunities,
  family: keywordFamily,
  researchInstructions:
    "Discover demand, cluster queries, map existing pages, and identify page-ownership gaps using current Executor evidence.",
});

const specs: ReadonlyArray<AnyWorkflowSpec> = [
  keywordWorkflow,
  competitorsWorkflow,
  authorityWorkflow,
  serpWorkflow,
  contentWorkflow,
  aiSearchWorkflow,
  architectureWorkflow,
  improveContentWorkflow,
  metadataWorkflow,
  schemaWorkflow,
  linksWorkflow,
];

export const workflowCatalog: ReadonlyMap<WorkflowId, AnyWorkflowSpec> = new Map(
  specs.map((spec) => [spec.id, spec]),
);

export const getWorkflowSpec = (id: WorkflowId): AnyWorkflowSpec => {
  const spec = workflowCatalog.get(id);
  if (spec === undefined) throw new Error(`Unknown PageGraph workflow: ${id}`);
  return spec;
};
