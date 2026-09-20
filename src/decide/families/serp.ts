/**
 * The serp family: is our page the shape this results page rewards?
 *
 * The model classifies the dominant SERP format and answers three probabilities
 * about our page. A confident match is `aligned`, a confident miss is `mismatch`,
 * and any answer inside the confidence band is `review` — the format question is
 * the one a human is most often needed to settle.
 */

import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../run";

/** The dominant result format — one label per recognizable SERP pattern. */
export const SERP_FORMATS = [
  "definition",
  "tool",
  "comparison",
  "listicle",
  "docs",
  "vendorLanding",
  "forum",
  "other",
] as const;
export type SerpFormat = (typeof SERP_FORMATS)[number];

const SERP_FORMAT_CRITERIA: Readonly<Record<SerpFormat, string>> = {
  definition: "A definition or explainer page: what X is and how it works.",
  tool: "An interactive tool, calculator, or generator.",
  comparison: "A comparison of options: X vs Y, or the best X.",
  listicle: "A ranked or numbered list of items.",
  docs: "Product, API, or reference documentation.",
  vendorLanding: "A vendor's marketing or landing page for its own product.",
  forum: "A community discussion: forum, Reddit, or Stack Overflow.",
  other: "None of the above.",
};

/** One ranked result in the saved SERP snapshot. */
export const SerpItem = Schema.Struct({
  type: Schema.String,
  rank: Schema.Number,
  domain: Schema.String,
  title: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
});
export type SerpItem = Schema.Schema.Type<typeof SerpItem>;

/** Our candidate page, plus the SERP snapshot for the query. */
export const SerpInput = Schema.Struct({
  query: Schema.String,
  ourPage: Schema.Struct({
    url: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    firstWords: Schema.String,
  }),
  serpItems: Schema.Array(SerpItem),
});
export type SerpInput = Schema.Schema.Type<typeof SerpInput>;

/** One provider call answers the SERP format and the three fit probabilities. */
export const SerpDecision = Decision.make({
  input: SerpInput,
  decisions: {
    serpFormat: Decision.classify({
      instructions:
        "Classify the dominant format of this results page from the ranking results. Weigh the top results most heavily.",
      criteria: SERP_FORMAT_CRITERIA as { [label in SerpFormat]: string },
    }),
    ourFormatFit: Decision.probability({
      instructions:
        "Our page's format matches how this results page is won: the same shape a top result uses, not merely a related topic.",
      criteria: {
        false: "Our format is the wrong shape for this SERP.",
        true: "Our format is the shape this SERP rewards.",
      },
    }),
    intentMatch: Decision.probability({
      instructions:
        "Our page satisfies the query's dominant intent: the reader's task after landing, not the literal keywords.",
      criteria: {
        false: "The query wants something our page does not provide.",
        true: "Our page provides what the query asks for.",
      },
    }),
    titlePatternMatch: Decision.probability({
      instructions:
        "Our title follows the pattern the ranking titles use, including the qualifiers and framing a searcher expects.",
      criteria: {
        false: "Our title does not follow the ranking pattern.",
        true: "Our title follows the ranking pattern.",
      },
    }),
  },
});

export type SerpVerdict = "aligned" | "mismatch" | "review";

/**
 * `aligned` needs both intent and format confident-positive; anything else that
 * is confident is `mismatch`. `titlePatternMatch` only widens the review band.
 */
export const classifySerpVerdict = (
  answers: {
    readonly ourFormatFit: { readonly probability: number };
    readonly intentMatch: { readonly probability: number };
    readonly titlePatternMatch: { readonly probability: number };
  },
  threshold: number,
): SerpVerdict => {
  const probabilities = [
    answers.ourFormatFit.probability,
    answers.intentMatch.probability,
    answers.titlePatternMatch.probability,
  ];
  if (anyInReviewBand(probabilities, threshold)) return "review";
  return answers.intentMatch.probability >= threshold && answers.ourFormatFit.probability >= threshold
    ? "aligned"
    : "mismatch";
};

export const serpFamily: DecisionFamily<SerpInput> = {
  name: "serp",
  input: SerpInput,
  definitionFor: () => SerpDecision,
  inputRef: (input) => `query:${input.query}`,
  evaluate: (_input, answers, threshold) => classifySerpVerdict(answers, threshold),
};
