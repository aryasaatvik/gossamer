import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";
import { defineWorkflow, stateWith } from "./types";

const ArchitectureInput = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  inboundPaths: Schema.Array(Schema.String),
  proposedOwner: Schema.String,
  rationale: Schema.String,
});
const ArchitectureState = stateWith(ArchitectureInput);

const ArchitectureDecision = Decision.make({
  input: ArchitectureInput,
  decisions: {
    ownership: Decision.probability({
      instructions:
        "The proposed page owner is the clearest single owner for the route's search intent.",
      criteria: {
        false: "Ownership is ambiguous or conflicts with another route.",
        true: "Ownership is clear.",
      },
    }),
    hierarchy: Decision.probability({
      instructions:
        "The proposed hierarchy and inbound-link relationship make the page discoverable and coherent.",
      criteria: {
        false: "The hierarchy is weak or disconnected.",
        true: "The hierarchy is coherent and discoverable.",
      },
    }),
    action: Decision.classify({
      instructions: "Choose the architecture action supported by the route evidence.",
      criteria: {
        keep: "Keep the current route and ownership.",
        move: "Move or consolidate the route under the proposed owner.",
        create: "Create the proposed missing page or collection.",
      },
    }),
  },
});

export const classify = (
  answers: {
    readonly ownership: { readonly probability: number };
    readonly hierarchy: { readonly probability: number };
    readonly action: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): string => {
  if (anyInReviewBand([answers.ownership.probability, answers.hierarchy.probability], threshold))
    return "review";
  if (answers.ownership.probability < threshold || answers.hierarchy.probability < threshold)
    return "keep";
  const actionProbability = answers.action.probabilities[answers.action.label] ?? 0;
  return actionProbability >= threshold ? answers.action.label : "review";
};

const architectureFamily: DecisionFamily<Schema.Schema.Type<typeof ArchitectureInput>> = {
  name: "workflow-architecture",
  input: ArchitectureInput,
  definitionFor: () => ArchitectureDecision,
  inputRef: (input) => input.path,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};

export const architectureWorkflow = defineWorkflow({
  id: "plan.architecture",
  skills: ["site-architecture"],
  mutatesFiles: false,
  stateSchema: ArchitectureState,
  decisionInputs: (state) => state.items,
  family: architectureFamily,
  researchInstructions:
    "Map public route ownership, hierarchy, collections, and contextual-link relationships from the deterministic graph and source corpus.",
});
