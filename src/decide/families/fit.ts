/**
 * The fit family: which existing page should target this query?
 *
 * Candidate ids are provider labels, so the definition is built per input — one
 * `bestPage` classification over the supplied candidates, plus `competition` and
 * `needsNewPage` probabilities. `map` names the page to use, `cannibalized`
 * means several pages already compete, `gap` means none should, and `review` is
 * the confidence band.
 */

import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../run";

/** A candidate page the model may choose. */
export const FitCandidate = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  excerpt: Schema.String,
});
export type FitCandidate = Schema.Schema.Type<typeof FitCandidate>;

/** One query plus the candidate pages already on the site. */
export const FitInput = Schema.Struct({
  query: Schema.String,
  candidates: Schema.Array(FitCandidate),
});
export type FitInput = Schema.Schema.Type<typeof FitInput>;

/** The provider labels are dynamic strings, so cap their length for the provider. */
export const MAX_LABEL_LENGTH = 255;

const candidateCriteria = (candidates: ReadonlyArray<FitCandidate>): Record<string, string> =>
  Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      `${candidate.title} — ${candidate.excerpt}`.slice(0, MAX_LABEL_LENGTH),
    ]),
  );

/** One provider call answers `bestPage`, `competition`, and `needsNewPage`. */
export const makeFitDecision = (input: FitInput) =>
  Decision.make({
    input: FitInput,
    decisions: {
      bestPage: Decision.classify({
        instructions:
          "Choose the candidate page that best targets this query, or the closest starting point to update. Use the page's title and excerpt.",
        criteria: candidateCriteria(input.candidates),
      }),
      competition: Decision.probability({
        instructions:
          "Two or more of the supplied pages already target this query, so they risk cannibalizing each other.",
        criteria: {
          false: "At most one page targets the query.",
          true: "Multiple pages target the query.",
        },
      }),
      needsNewPage: Decision.probability({
        instructions:
          "None of the supplied pages can serve this query well; a new page is the right answer.",
        criteria: {
          false: "An existing page can serve this query.",
          true: "No existing page can serve this query; a new page is needed.",
        },
      }),
    },
  });

/** Reject inputs whose candidate ids cannot become provider labels. */
export const validateFitInput = (input: FitInput): string | undefined => {
  if (input.candidates.length < 2) {
    return "decide fit needs at least two candidates: bestPage compares them.";
  }
  const long = input.candidates.find((candidate) => candidate.id.length > MAX_LABEL_LENGTH);
  if (long !== undefined) {
    return `decide fit candidate id exceeds ${MAX_LABEL_LENGTH} characters: ${long.id.slice(0, 32)}…`;
  }
  return undefined;
};

export type FitVerdict = "map" | "cannibalized" | "gap" | "review";

/**
 * `gap` wins over `cannibalized` when both are confident: a new page is the more
 * decisive answer. `map` needs a confident `bestPage`; otherwise it is `review`.
 */
export const classifyFitVerdict = (
  answers: {
    readonly bestPage: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
    readonly competition: { readonly probability: number };
    readonly needsNewPage: { readonly probability: number };
  },
  threshold: number,
): FitVerdict => {
  if (
    anyInReviewBand([answers.competition.probability, answers.needsNewPage.probability], threshold)
  ) {
    return "review";
  }
  if (answers.needsNewPage.probability >= threshold) return "gap";
  if (answers.competition.probability >= threshold) return "cannibalized";
  const best = answers.bestPage.probabilities[answers.bestPage.label] ?? 0;
  return best >= threshold ? "map" : "review";
};

export const fitFamily: DecisionFamily<FitInput> = {
  name: "fit",
  input: FitInput,
  definitionFor: makeFitDecision,
  inputRef: (input) => `query:${input.query}`,
  evaluate: (_input, answers, threshold) => classifyFitVerdict(answers, threshold),
  validate: validateFitInput,
};
