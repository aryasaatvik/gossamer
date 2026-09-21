import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../../decide/run";
import { defineWorkflow, stateWith } from "./types";

const LinksInput = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  anchor: Schema.String,
  context: Schema.String,
  relation: Schema.String,
});
const LinksState = stateWith(LinksInput);

const LinksDecision = Decision.make({
  input: LinksInput,
  decisions: {
    useful: Decision.probability({
      instructions:
        "The proposed link helps a reader navigate from the source page to a related target.",
      criteria: {
        false: "The link is forced, redundant, or confusing.",
        true: "The link is useful and contextual.",
      },
    }),
    supported: Decision.probability({
      instructions: "The target and anchor are supported by the source and target page content.",
      criteria: {
        false: "The link or anchor overstates the target.",
        true: "The link is supported.",
      },
    }),
    action: Decision.classify({
      instructions: "Choose the internal-link action supported by the graph and page evidence.",
      criteria: {
        add: "Add the contextual link.",
        update: "Update an existing link's anchor or placement.",
        skip: "Do not add or change the link.",
      },
    }),
  },
});

const classify = (
  answers: {
    readonly useful: { readonly probability: number };
    readonly supported: { readonly probability: number };
    readonly action: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): string => {
  if (anyInReviewBand([answers.useful.probability, answers.supported.probability], threshold))
    return "review";
  return (answers.action.probabilities[answers.action.label] ?? 0) >= threshold
    ? answers.action.label
    : "review";
};

const linksFamily: DecisionFamily<Schema.Schema.Type<typeof LinksInput>> = {
  name: "workflow-links",
  input: LinksInput,
  definitionFor: () => LinksDecision,
  inputRef: (input) => `${input.from} → ${input.to}`,
  evaluate: (_input, answers, threshold) => classify(answers, threshold),
};

export const linksWorkflow = defineWorkflow({
  id: "improve.links",
  skills: ["technical"],
  mutatesFiles: true,
  stateSchema: LinksState,
  decisionInputs: (state) => state.items,
  family: linksFamily,
  researchInstructions:
    "Use the deterministic PageGraph edges and source content to propose useful contextual internal links and safe anchor text.",
  actionInstructions:
    "Apply only useful, supported links at the owning source or route declaration; preserve generated graph contracts and leave the diff uncommitted.",
});
