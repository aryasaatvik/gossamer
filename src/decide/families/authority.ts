/**
 * The authority family: is this a real link opportunity, a spam trap, or not
 * worth outreach?
 *
 * Three probabilities judge the domain and one classification places its fit.
 * A confident spam verdict is `spam`, a confident legitimate-and-worth-while fit
 * is `accept`, and everything uncertain is `review` — link outreach is never
 * auto-applied.
 */

import * as Schema from "effect/Schema";
import { Decision } from "effect/unstable/ai";

import { anyInReviewBand, type DecisionFamily } from "../run";

/** The relationship a target could support. */
export const AUTHORITY_FITS = ["directory", "partner", "editorial", "community", "none"] as const;
export type AuthorityFit = (typeof AUTHORITY_FITS)[number];

const AUTHORITY_FIT_CRITERIA: Readonly<Record<AuthorityFit, string>> = {
  directory: "A directory or listing page that accepts submissions.",
  partner: "A partner or integration page that links relevant products.",
  editorial: "Editorial coverage: an article or guide that could cite this page.",
  community: "A community space: forum, Q&A, or discussion group.",
  none: "No genuine fit; outreach here would be noise.",
};

/** One link target plus the evidence the model reads. */
export const AuthorityInput = Schema.Struct({
  domain: Schema.String,
  url: Schema.String,
  anchor: Schema.String,
  /** The surrounding copy on our page that would carry the link. */
  context: Schema.String,
  targetPath: Schema.String,
  /** Referring domains, when known. */
  rd: Schema.optional(Schema.Number),
  /** Extra observed signals, e.g. `["no-outbound", "paid-links"]`. */
  signals: Schema.optional(Schema.Array(Schema.String)),
});
export type AuthorityInput = Schema.Schema.Type<typeof AuthorityInput>;

/** One provider call answers the three probabilities and the fit classification. */
export const AuthorityDecision = Decision.make({
  input: AuthorityInput,
  decisions: {
    legitimate: Decision.probability({
      instructions:
        "The target is a legitimate site a reader would trust: real editorial or community content, not a link farm, PBN, or paid-link network.",
      criteria: {
        false: "The target looks like spam, a link farm, or a paid-link network.",
        true: "The target is a legitimate site.",
      },
    }),
    spam: Decision.probability({
      instructions:
        "The target shows spam signals: thin auto-generated content, exact-match anchor farms, or a link-selling footprint.",
      criteria: {
        false: "No meaningful spam signals.",
        true: "Clear spam or link-selling signals.",
      },
    }),
    outreachWorth: Decision.probability({
      instructions:
        "Outreach to this target is worth the effort: a human could plausibly place a reader-useful link.",
      criteria: {
        false: "Outreach is not worth the effort.",
        true: "Outreach could place a useful link.",
      },
    }),
    fit: Decision.classify({
      instructions: "Classify the relationship this target could support.",
      criteria: AUTHORITY_FIT_CRITERIA as { [label in AuthorityFit]: string },
    }),
  },
});

export type AuthorityVerdict = "accept" | "spam" | "review";

/**
 * `spam` when spam is confident; `accept` only when legitimate, outreach-worthy,
 * and a non-`none` fit are all confident; otherwise `review`.
 */
export const classifyAuthorityVerdict = (
  answers: {
    readonly legitimate: { readonly probability: number };
    readonly spam: { readonly probability: number };
    readonly outreachWorth: { readonly probability: number };
    readonly fit: {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
    };
  },
  threshold: number,
): AuthorityVerdict => {
  if (
    anyInReviewBand(
      [
        answers.legitimate.probability,
        answers.spam.probability,
        answers.outreachWorth.probability,
      ],
      threshold,
    )
  ) {
    return "review";
  }
  if (answers.spam.probability >= threshold) return "spam";
  const fitProbability = answers.fit.probabilities[answers.fit.label] ?? 0;
  if (
    answers.fit.label === "none" ||
    fitProbability < threshold ||
    answers.legitimate.probability < threshold ||
    answers.outreachWorth.probability < threshold
  ) {
    return "review";
  }
  return "accept";
};

export const authorityFamily: DecisionFamily<AuthorityInput> = {
  name: "authority",
  input: AuthorityInput,
  definitionFor: () => AuthorityDecision,
  inputRef: (input) => input.domain,
  evaluate: (_input, answers, threshold) => classifyAuthorityVerdict(answers, threshold),
};
