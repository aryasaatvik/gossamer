import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";
import { defineWorkflow, stateWith } from "./types";

const CompetitorInput = Schema.Struct({
  domain: Schema.String,
  url: Schema.String,
  query: Schema.String,
  title: Schema.String,
  excerpt: Schema.String,
  overlap: Schema.Array(Schema.String),
});

const CompetitorState = stateWith(CompetitorInput);

const CompetitorDecision = Decision.make({
  input: CompetitorInput,
  decisions: {
    relevant: Decision.probability({
      instructions:
        "The result is a genuine search competitor for the supplied query and product context.",
      criteria: {
        false: "The result is incidental or serves a different need.",
        true: "The result competes for the same need.",
      },
    }),
    usefulGap: Decision.probability({
      instructions: "The result exposes a useful content or page opportunity for the site.",
      criteria: {
        false: "There is no actionable opening in this result.",
        true: "The result reveals an actionable opening.",
      },
    }),
    action: Decision.classify({
      instructions: "Choose the appropriate competitive-research follow-up.",
      criteria: {
        observe: "Keep the result as context only.",
        differentiate: "Use it to improve an existing page's differentiation.",
        create: "Use it as evidence for a distinct new page or content asset.",
      },
    }),
  },
});

const classify = (
  answers: {
    readonly relevant: { readonly probability: number };
    readonly usefulGap: { readonly probability: number };
    readonly action: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): string => {
  if (anyInReviewBand([answers.relevant.probability, answers.usefulGap.probability], threshold))
    return "review";
  if (answers.relevant.probability < threshold || answers.usefulGap.probability < threshold)
    return "observe";
  return (answers.action.probabilities[answers.action.label] ?? 0) >= threshold
    ? answers.action.label
    : "review";
};

const competitorFamily: DecisionFamily<Schema.Schema.Type<typeof CompetitorInput>> = {
  name: "workflow-competitors",
  input: CompetitorInput,
  definitionFor: () => CompetitorDecision,
  inputRef: (input) => `${input.domain} · query:${input.query}`,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};

export const competitorsWorkflow = defineWorkflow({
  id: "research.competitors",
  skills: ["competitive-landscape"],
  mutatesFiles: false,
  stateSchema: CompetitorState,
  decisionInputs: (state) => state.items,
  family: competitorFamily,
  researchInstructions:
    "Find current search competitors, compare their pages with the supplied public corpus, and cite the evidence that reveals a useful opening.",
});
