import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";
import { defineWorkflow, stateWith } from "./types";

const AiSearchInput = Schema.Struct({
  url: Schema.String,
  query: Schema.String,
  answer: Schema.String,
  entities: Schema.Array(Schema.String),
  citations: Schema.Array(Schema.String),
  extractableSections: Schema.Array(Schema.String),
});
const AiSearchState = stateWith(AiSearchInput);

const AiSearchDecision = Decision.make({
  input: AiSearchInput,
  decisions: {
    extractable: Decision.probability({
      instructions:
        "The page exposes concise, self-contained passages an answer engine can accurately extract.",
      criteria: {
        false: "The answer is buried, vague, or difficult to quote accurately.",
        true: "The answer is easy to extract accurately.",
      },
    }),
    entityClarity: Decision.probability({
      instructions:
        "The page clearly identifies the product, entities, relationships, and audience it describes.",
      criteria: {
        false: "Entities or relationships are ambiguous.",
        true: "Entities and relationships are clear.",
      },
    }),
    citationSupport: Decision.probability({
      instructions:
        "The answer's material claims have visible first-party support or trustworthy cited sources.",
      criteria: {
        false: "Material claims lack sufficient support.",
        true: "Material claims are supported.",
      },
    }),
  },
});

const classify = (
  answers: {
    readonly extractable: { readonly probability: number };
    readonly entityClarity: { readonly probability: number };
    readonly citationSupport: { readonly probability: number };
  },
  threshold: number,
): string => {
  const values = [
    answers.extractable.probability,
    answers.entityClarity.probability,
    answers.citationSupport.probability,
  ];
  if (anyInReviewBand(values, threshold)) return "review";
  return values.every((value) => value >= threshold) ? "ready" : "improve";
};

const aiSearchFamily: DecisionFamily<Schema.Schema.Type<typeof AiSearchInput>> = {
  name: "workflow-ai-search",
  input: AiSearchInput,
  definitionFor: () => AiSearchDecision,
  inputRef: (input) => `${input.url} · query:${input.query}`,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};

export const aiSearchWorkflow = defineWorkflow({
  id: "analyze.ai-search",
  skills: ["ai-search"],
  mutatesFiles: false,
  stateSchema: AiSearchState,
  decisionInputs: (state) => state.items,
  family: aiSearchFamily,
  researchInstructions:
    "Evaluate extractability, entity clarity, and citation support for answer-engine visibility using the page corpus and current search evidence.",
});
