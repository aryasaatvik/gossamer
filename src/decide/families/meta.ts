/**
 * The meta family: rank the provided title/description candidates for a page.
 *
 * Drafting is out of scope — this only judges candidates the caller supplies.
 * Candidate ids are provider labels, so the `best` classification is built per
 * input. `choose:<id>` requires a confident pick with no intent, length,
 * category-drift, or clickbait concern; anything else is `review`.
 */

import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../run";

/** A candidate title/description pair the model may choose. */
export const MetaCandidate = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
});
export type MetaCandidate = Schema.Schema.Type<typeof MetaCandidate>;

/** One page plus the metadata candidates to rank. */
export const MetaInput = Schema.Struct({
  url: Schema.String,
  intent: Schema.String,
  categoryLock: Schema.String,
  candidates: Schema.Array(MetaCandidate),
});
export type MetaInput = Schema.Schema.Type<typeof MetaInput>;

/** The provider labels are dynamic strings, so cap their length for the provider. */
export const MAX_LABEL_LENGTH = 255;

const candidateCriteria = (candidates: ReadonlyArray<MetaCandidate>): Record<string, string> =>
  Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      `${candidate.title} — ${candidate.description}`.slice(0, MAX_LABEL_LENGTH),
    ]),
  );

/** One provider call answers `best` and the four concern probabilities. */
export const makeMetaDecision = (input: MetaInput) =>
  Decision.make({
    input: MetaInput,
    decisions: {
      best: Decision.classify({
        instructions:
          "Choose the candidate title/description that best serves the page's intent and stays inside its category. Judge the supplied candidates only.",
        criteria: candidateCriteria(input.candidates),
      }),
      intentFit: Decision.probability({
        instructions: "The chosen candidate's promise matches the page's intent.",
        criteria: {
          false: "The candidate promises something the page does not deliver.",
          true: "The candidate matches the page's intent.",
        },
      }),
      lengthOk: Decision.probability({
        instructions:
          "The chosen candidate fits search-result limits: a title near 60 characters, a description near 160.",
        criteria: {
          false: "The candidate is too short or truncated.",
          true: "The candidate fits the result limits.",
        },
      }),
      categoryDrift: Decision.probability({
        instructions: "The chosen candidate drifts outside the page's locked category.",
        criteria: {
          false: "The candidate stays inside the category.",
          true: "The candidate drifts outside the category.",
        },
      }),
      clickbait: Decision.probability({
        instructions:
          "The chosen candidate uses clickbait or overpromises relative to the page's content.",
        criteria: {
          false: "The candidate is accurate and measured.",
          true: "The candidate overpromises or uses clickbait.",
        },
      }),
    },
  });

/** Reject inputs whose candidate ids cannot become provider labels. */
export const validateMetaInput = (input: MetaInput): string | undefined => {
  if (input.candidates.length < 2) {
    return "decide meta needs at least two candidates: best ranks them.";
  }
  const long = input.candidates.find((candidate) => candidate.id.length > MAX_LABEL_LENGTH);
  if (long !== undefined) {
    return `decide meta candidate id exceeds ${MAX_LABEL_LENGTH} characters: ${long.id.slice(0, 32)}…`;
  }
  if (new Set(input.candidates.map((candidate) => candidate.id)).size !== input.candidates.length) {
    return "decide meta candidate ids must be unique: they become provider labels.";
  }
  return undefined;
};

export type MetaVerdict = `choose:${string}` | "review";

/**
 * A clean candidate is `choose:<id>`. Any review-band probability, a low-probability
 * pick, confident drift, clickbait, or a mismatch on intent/length is `review`.
 */
export const classifyMetaVerdict = (
  answers: {
    readonly best: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
    readonly intentFit: { readonly probability: number };
    readonly lengthOk: { readonly probability: number };
    readonly categoryDrift: { readonly probability: number };
    readonly clickbait: { readonly probability: number };
  },
  threshold: number,
): MetaVerdict => {
  if (
    anyInReviewBand(
      [
        answers.intentFit.probability,
        answers.lengthOk.probability,
        answers.categoryDrift.probability,
        answers.clickbait.probability,
      ],
      threshold,
    )
  ) {
    return "review";
  }
  const best = answers.best.probabilities[answers.best.label] ?? 0;
  if (best < threshold) return "review";
  if (
    answers.intentFit.probability < threshold ||
    answers.lengthOk.probability < threshold ||
    answers.categoryDrift.probability >= threshold ||
    answers.clickbait.probability >= threshold
  ) {
    return "review";
  }
  return `choose:${answers.best.label}`;
};

export const metaFamily: DecisionFamily<MetaInput> = {
  name: "meta",
  input: MetaInput,
  definitionFor: makeMetaDecision,
  inputRef: (input) => input.url,
  evaluate: (_input, answers, threshold) => classifyMetaVerdict(answers, threshold),
  validate: validateMetaInput,
};
