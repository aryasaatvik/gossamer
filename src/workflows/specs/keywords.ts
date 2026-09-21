import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";

export const KeywordCandidateSchema = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  excerpt: Schema.String,
});

export const KeywordOpportunitySchema = Schema.Struct({
  query: Schema.String,
  intent: Schema.String,
  rationale: Schema.String,
  demand: Schema.optional(Schema.Number),
  candidates: Schema.Array(KeywordCandidateSchema),
  evidence: Schema.Array(Schema.String),
});
export type KeywordOpportunityInput = Schema.Schema.Type<typeof KeywordOpportunitySchema>;

export const KeywordResearchStateSchema = Schema.Struct({
  summary: Schema.String,
  opportunities: Schema.Array(KeywordOpportunitySchema),
});
export type KeywordResearchStateInput = Schema.Schema.Type<typeof KeywordResearchStateSchema>;

const KeywordDecision = Decision.make({
  input: KeywordOpportunitySchema,
  decisions: {
    supportedDemand: Decision.probability({
      instructions:
        "The cited external evidence supports meaningful search demand for this query in the requested market and language.",
      criteria: { false: "Demand is absent or unsupported.", true: "Demand is supported." },
    }),
    productFit: Decision.probability({
      instructions:
        "The query is relevant to the site's actual product, audience, and public positioning in the supplied project context.",
      criteria: { false: "The query is off-strategy.", true: "The query fits the product." },
    }),
    ownership: Decision.classify({
      instructions: "Choose the most appropriate page-ownership action.",
      criteria: {
        existing: "One existing page should own the query with no material expansion.",
        expand: "An existing page should own the query after meaningful improvement.",
        new: "A distinct new page is justified because no existing page owns the intent.",
      },
    }),
  },
});

const classify = (
  answers: {
    readonly supportedDemand: { readonly probability: number };
    readonly productFit: { readonly probability: number };
    readonly ownership: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): string => {
  if (anyInReviewBand([answers.supportedDemand.probability, answers.productFit.probability], threshold)) {
    return "review";
  }
  if (answers.supportedDemand.probability < threshold || answers.productFit.probability < threshold) {
    return "reject";
  }
  const confidence = answers.ownership.probabilities[answers.ownership.label] ?? 0;
  return confidence >= threshold ? answers.ownership.label : "review";
};

export const keywordFamily: DecisionFamily<KeywordOpportunityInput> = {
  name: "workflow-keywords",
  input: KeywordOpportunitySchema,
  definitionFor: () => KeywordDecision,
  inputRef: (input) => `query:${input.query}`,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};
