/**
 * The content family: does this page carry enough original substance?
 *
 * Seven probabilities score the page's editorial quality and one rating places
 * its overall value on `thin | adequate | strong`. A confident page with a
 * `thin` value or any failed probability is `flag`; an uncertain answer is
 * `review`. Nothing is rewritten here — the verdict is the plan.
 */

import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../run";

/** Ordered value scale from least to most substance. */
export const CONTENT_VALUES = ["thin", "adequate", "strong"] as const;
export type ContentValue = (typeof CONTENT_VALUES)[number];

/** One page plus the evidence the rubric reads. */
export const ContentInput = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  h1: Schema.String,
  first150Words: Schema.String,
  headings: Schema.Array(Schema.String),
  wordCount: Schema.Number,
  /** schema.org types present on the page, e.g. `["Article", "FAQPage"]`. */
  structuredData: Schema.Array(Schema.String),
  /** The topic the page must stay inside; drifting outside it is a failure. */
  categoryLock: Schema.String,
  competitorExcerpts: Schema.optional(Schema.Array(Schema.String)),
});
export type ContentInput = Schema.Schema.Type<typeof ContentInput>;

const boolean = (instructions: string, falseText: string, trueText: string) =>
  Decision.probability({ instructions, criteria: { false: falseText, true: trueText } });

/** One provider call answers the seven rubric probabilities and the value rating. */
export const ContentDecision = Decision.make({
  input: ContentInput,
  decisions: {
    answersFirst: boolean(
      "The first 150 words answer the reader's question directly, before background or preamble.",
      "The opening delays the answer.",
      "The opening answers the question up front.",
    ),
    originalValue: boolean(
      "The page adds original value — first-hand experience, data, or a distinct point of view — beyond restating common knowledge.",
      "The page restates what every other result already says.",
      "The page adds information a reader cannot get elsewhere.",
    ),
    competitiveSubstance: boolean(
      "The page has enough depth and specificity to compete with the current results for this topic.",
      "The page is shallower or less specific than the competition.",
      "The page matches or exceeds the competition's substance.",
    ),
    descriptiveTitle: boolean(
      "The title is descriptive and specific to the page's content rather than vague or clickbait.",
      "The title is vague or misleading.",
      "The title describes the page's actual content.",
    ),
    structuredDataMatches: boolean(
      "The page's structured data matches its content type and the query intent.",
      "Structured data is missing, wrong, or mismatched.",
      "Structured data correctly describes the page.",
    ),
    categoryConsistency: boolean(
      "The page stays inside its locked category; its headings and body do not drift into an adjacent topic.",
      "The page drifts outside the locked category.",
      "The page stays inside the locked category.",
    ),
    distinctIntent: boolean(
      "The page serves a distinct intent rather than duplicating another page that already targets this query.",
      "The page duplicates an existing page's intent.",
      "The page serves an intent no existing page covers.",
    ),
    value: Decision.rate({
      instructions:
        "Overall reader value of this page: thin restates what exists, adequate is competitive, strong is the best available answer.",
      criteria: CONTENT_VALUES,
    }),
  },
});

export type ContentVerdict = "pass" | "flag" | "review";

/** The seven rubric probabilities that decide pass/flag once confidence is settled. */
const RUBRIC_KEYS = [
  "answersFirst",
  "originalValue",
  "competitiveSubstance",
  "descriptiveTitle",
  "structuredDataMatches",
  "categoryConsistency",
  "distinctIntent",
] as const;

/**
 * `flag` when the value rating is `thin` or any rubric probability is
 * confidently false; `review` when any probability (rubric or value
 * distribution) is inside the band; `pass` otherwise.
 */
export const classifyContentVerdict = (
  answers: {
    readonly value: { readonly label: string; readonly probabilities: Readonly<Record<string, number>> };
  } & Record<string, { readonly probability: number }>,
  threshold: number,
): ContentVerdict => {
  const rubric = RUBRIC_KEYS.map((key) => answers[key].probability);
  const distribution = Object.values(answers.value.probabilities);
  if (anyInReviewBand([...rubric, ...distribution], threshold)) return "review";
  if (answers.value.label === "thin") return "flag";
  if (rubric.some((probability) => probability <= 1 - threshold)) return "flag";
  return "pass";
};

export const contentFamily: DecisionFamily<ContentInput> = {
  name: "content",
  input: ContentInput,
  definitionFor: () => ContentDecision,
  inputRef: (input) => input.url,
  evaluate: (_input, answers, threshold) => classifyContentVerdict(answers, threshold),
};
