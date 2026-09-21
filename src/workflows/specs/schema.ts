import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";
import { defineWorkflow, stateWith } from "./types";

const SchemaInput = Schema.Struct({
  url: Schema.String,
  pageKind: Schema.String,
  routeSource: Schema.String,
  existingTypes: Schema.Array(Schema.String),
  proposedTypes: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
});
const SchemaState = stateWith(SchemaInput);

const SchemaDecision = Decision.make({
  input: SchemaInput,
  decisions: {
    pageTypeSupported: Decision.probability({
      instructions:
        "The proposed JSON-LD type accurately describes the page and its visible content.",
      criteria: {
        false: "The proposed type is unsupported or misleading.",
        true: "The proposed type is supported.",
      },
    }),
    evidenceComplete: Decision.probability({
      instructions: "The evidence is sufficient to justify the proposed structured-data change.",
      criteria: { false: "Important evidence is missing.", true: "The evidence is sufficient." },
    }),
    action: Decision.classify({
      instructions: "Choose the schema action supported by the page evidence.",
      criteria: {
        keep: "Keep current JSON-LD unchanged.",
        update: "Update existing JSON-LD types or properties.",
        add: "Add a justified JSON-LD block.",
      },
    }),
  },
});

const classify = (
  answers: {
    readonly pageTypeSupported: { readonly probability: number };
    readonly evidenceComplete: { readonly probability: number };
    readonly action: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): string => {
  if (
    anyInReviewBand(
      [answers.pageTypeSupported.probability, answers.evidenceComplete.probability],
      threshold,
    )
  )
    return "review";
  return (answers.action.probabilities[answers.action.label] ?? 0) >= threshold
    ? answers.action.label
    : "review";
};

const schemaFamily: DecisionFamily<Schema.Schema.Type<typeof SchemaInput>> = {
  name: "workflow-schema",
  input: SchemaInput,
  definitionFor: () => SchemaDecision,
  inputRef: (input) => input.url,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};

export const schemaWorkflow = defineWorkflow({
  id: "improve.schema",
  skills: ["technical"],
  mutatesFiles: true,
  stateSchema: SchemaState,
  decisionInputs: (state) => state.items,
  family: schemaFamily,
  researchInstructions:
    "Inspect rendered head output and the route or Fumadocs source to derive only structured-data types justified by visible content.",
  actionInstructions:
    "Apply justified JSON-LD changes at the owning source, preserve the existing composition contracts, and leave the diff uncommitted.",
});
