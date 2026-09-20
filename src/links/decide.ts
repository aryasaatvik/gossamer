/**
 * Link decisions over the rendered graph, answered by an Effect `DecisionModel`.
 *
 * A candidate is a `(source → destination)` pair with the source copy. The model
 * answers two probabilities — does the source have a genuine reader-facing
 * reason to link to the destination, and is descriptive anchor text already in
 * the copy — and this module maps them to a verdict. Anything the model is not
 * confident about lands in the `review` bucket; nothing is applied automatically.
 *
 * This module reaches Effect and the TypeSafe provider, so it is CLI-internal:
 * the library entries stay Effect-free and only the bundled `pagegraph` bin
 * ships it.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Decision, DecisionModel } from "effect/unstable/ai";
import type * as AiError from "effect/unstable/ai/AiError";

import { cacheGet, cachePut } from "../decide/cache";
import { cacheKey, inputHash, validCachedAnswers } from "../decide/run";

/** Default probability boundary between a confident and an uncertain answer. */
export const DEFAULT_LINK_THRESHOLD = 0.7;

/** Keep at most this many candidates per source unless `--budget` overrides it. */
export const DEFAULT_LINK_BUDGET = 4;

/** Which direction(s) between the candidate pair deserve a link. */
export const LINK_DIRECTIONS = ["a_to_b", "b_to_a", "both"] as const;
export type LinkDirection = (typeof LINK_DIRECTIONS)[number];

/** Ordered relevance scale for budget selection. */
export const LINK_RELEVANCE = ["irrelevant", "useful", "essential"] as const;
export type LinkRelevanceLabel = (typeof LINK_RELEVANCE)[number];

/** One proposed contextual link, plus the source copy the model reads. */
export const LinkCandidate = Schema.Struct({
  sourceUrl: Schema.String,
  destinationUrl: Schema.String,
  sourceText: Schema.String,
  /** Descriptive anchor text already present for the destination, when known. */
  existingAnchor: Schema.optional(Schema.String),
});
export type LinkCandidate = Schema.Schema.Type<typeof LinkCandidate>;

/**
 * The four decisions every candidate answers in one provider call: two
 * probabilities, a direction classification, and a relevance rating. The
 * probabilities decide the verdict; direction and relevance inform the plan and
 * the per-source budget.
 */
export const LinkDecision = Decision.make({
  input: LinkCandidate,
  decisions: {
    realReason: Decision.probability({
      instructions:
        "The source page has a genuine reader-facing reason to link to the destination page: the destination answers a question the source raises or deepens a topic the source introduces. Navigation, boilerplate, and mere keyword overlap are not reasons.",
      criteria: {
        false: "No genuine reason; the link would be noise or only keyword overlap.",
        true: "A reader of the source would plausibly want the destination next.",
      },
    }),
    anchorPresent: Decision.probability({
      instructions:
        "Descriptive anchor text pointing at the destination already appears in the source copy. A bare mention without a link counts as absent.",
      criteria: {
        false: "No existing anchor to the destination in the copy.",
        true: "Descriptive anchor text to the destination is already in the copy.",
      },
    }),
    direction: Decision.classify({
      instructions:
        "Which direction between the candidate pair deserves a link: source → destination, destination → source, or both.",
      criteria: {
        a_to_b: "The source page should link to the destination page.",
        b_to_a: "The destination page should link to the source page.",
        both: "Both directions are reader-useful.",
      },
    }),
    relevance: Decision.rate({
      instructions:
        "How relevant this link is to the reader: irrelevant is noise, useful is a sensible next step, essential is a link the page is incomplete without.",
      criteria: LINK_RELEVANCE,
    }),
  },
});

/** A decision confidence band around `threshold`: `[0, 1 - threshold] ∪ [threshold, 1]`. */
const isConfident = (probability: number, threshold: number): boolean =>
  probability >= threshold || probability <= 1 - threshold;

/**
 * Map the two probabilities to a verdict. A probability inside the review band
 * makes the whole candidate uncertain, so the confident half of the pair can
 * never auto-resolve it. Requires `threshold > 0.5`, so the review band
 * `(1 - threshold, threshold)` is non-empty.
 *
 * - `present` — descriptive anchor already in the copy; nothing to add.
 * - `recommend` — a real reason and no existing anchor; add a contextual link.
 * - `skip` — no real reason; leave the copy alone.
 * - `review` — at least one answer is inside the band; a human decides.
 */
export const classifyVerdict = (
  realReason: number,
  anchorPresent: number,
  threshold: number,
): LinkVerdict => {
  if (!isConfident(realReason, threshold) || !isConfident(anchorPresent, threshold)) {
    return "review";
  }
  if (anchorPresent >= threshold) return "present";
  if (realReason >= threshold) return "recommend";
  return "skip";
};

export type LinkVerdict = "recommend" | "present" | "skip" | "review";

/** The relevance rating, as the report emits it. */
export interface LinkRelevance {
  readonly rating: number;
  readonly label: LinkRelevanceLabel;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** One candidate with its answers and verdict, exactly as the report emits it. */
export interface LinkDecisionRecord {
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly sourceText: string;
  readonly existingAnchor: string | null;
  readonly realReason: number;
  readonly anchorPresent: number;
  readonly direction: LinkDirection;
  readonly relevance: LinkRelevance;
  /**
   * The endpoints a recommendation directs, honoring `direction`: `b_to_a`
   * reverses the candidate pair. For `both`, they stay source → destination.
   */
  readonly from: string;
  readonly to: string;
  readonly verdict: LinkVerdict;
}

export interface LinksDecideCounts {
  readonly candidates: number;
  readonly recommend: number;
  readonly present: number;
  readonly skip: number;
  readonly review: number;
}

/**
 * `pagegraph links decide` report. `resolved` holds the auto-classified records
 * and `review` the below-threshold ones — every candidate appears exactly once,
 * and only `review` needs a human.
 */
export interface LinksDecideReport {
  readonly kind: "links-decide";
  readonly schemaVersion: 1;
  readonly model: string;
  readonly threshold: number;
  /** Per-source candidate budget, or null when no budget was applied. */
  readonly budget: number | null;
  /** Candidates removed by the per-source budget. */
  readonly dropped: number;
  readonly counts: LinksDecideCounts;
  readonly resolved: ReadonlyArray<LinkDecisionRecord>;
  readonly review: ReadonlyArray<LinkDecisionRecord>;
}

/**
 * Keep the top `budget` candidates per outbound page by relevance rating,
 * preserving the original order. The outbound page is `record.from`, which
 * honors `direction` — grouping by the candidate's `sourceUrl` would misspend the
 * quota when the model recommends the reverse direction. Ties keep their
 * original order (stable sort). Pages with fewer candidates pass through.
 */
export const applyBudget = (
  records: ReadonlyArray<LinkDecisionRecord>,
  budget: number,
): ReadonlyArray<LinkDecisionRecord> => {
  const bySource = new Map<string, Array<LinkDecisionRecord>>();
  for (const record of records) {
    const bucket = bySource.get(record.from);
    if (bucket === undefined) bySource.set(record.from, [record]);
    else bucket.push(record);
  }
  const kept = new Set<LinkDecisionRecord>();
  for (const bucket of bySource.values()) {
    const top = [...bucket].sort((a, b) => b.relevance.rating - a.relevance.rating).slice(0, budget);
    for (const record of top) kept.add(record);
  }
  return records.filter((record) => kept.has(record));
};

/** Group records into resolved/review buckets and count each verdict. */
export const buildLinksDecideReport = (options: {
  readonly model: string;
  readonly threshold: number;
  readonly records: ReadonlyArray<LinkDecisionRecord>;
  readonly budget?: number;
  readonly dropped?: number;
}): LinksDecideReport => {
  const counts = { recommend: 0, present: 0, skip: 0, review: 0 };
  const resolved: Array<LinkDecisionRecord> = [];
  const review: Array<LinkDecisionRecord> = [];
  for (const record of options.records) {
    counts[record.verdict] += 1;
    if (record.verdict === "review") review.push(record);
    else resolved.push(record);
  }
  return {
    kind: "links-decide",
    schemaVersion: 1,
    model: options.model,
    threshold: options.threshold,
    budget: options.budget ?? null,
    dropped: options.dropped ?? 0,
    counts: { candidates: options.records.length, ...counts },
    resolved,
    review,
  };
};

/** The four validated answers a record is built from, cache-compatible JSON. */
interface LinkAnswers {
  readonly realReason: { readonly probability: number };
  readonly anchorPresent: { readonly probability: number };
  readonly direction: {
    readonly label: LinkDirection;
    readonly probabilities: Readonly<Record<string, number>>;
  };
  readonly relevance: {
    readonly rating: number;
    readonly label: LinkRelevanceLabel;
    readonly probabilities: Readonly<Record<string, number>>;
  };
}

/**
 * The endpoints a `recommend` verdict actually directs. `b_to_a` reverses the
 * candidate pair, so the report names the direction the model chose rather than
 * always printing source → destination.
 */
const endpoints = (
  candidate: LinkCandidate,
  direction: LinkDirection,
): { readonly from: string; readonly to: string } =>
  direction === "b_to_a"
    ? { from: candidate.destinationUrl, to: candidate.sourceUrl }
    : { from: candidate.sourceUrl, to: candidate.destinationUrl };

const toRecord = (
  candidate: LinkCandidate,
  answers: LinkAnswers,
  threshold: number,
): LinkDecisionRecord => {
  const realReason = answers.realReason.probability;
  const anchorPresent = answers.anchorPresent.probability;
  const direction = answers.direction.label;
  return {
    sourceUrl: candidate.sourceUrl,
    destinationUrl: candidate.destinationUrl,
    sourceText: candidate.sourceText,
    existingAnchor: candidate.existingAnchor ?? null,
    realReason,
    anchorPresent,
    direction,
    relevance: {
      rating: answers.relevance.rating,
      label: answers.relevance.label,
      probabilities: answers.relevance.probabilities,
    },
    ...endpoints(candidate, direction),
    verdict: classifyVerdict(realReason, anchorPresent, threshold),
  };
};

/**
 * Answer every candidate through the ambient `DecisionModel` and bucket the
 * results. The model answers both decisions in one call per candidate; candidates
 * are dispatched with bounded concurrency. A warm cache skips the provider.
 */
export const decideLinks = (
  candidates: ReadonlyArray<LinkCandidate>,
  options: {
    readonly model: string;
    readonly threshold: number;
    readonly concurrency?: number;
    /** Cache directory; absent means no cache. */
    readonly cacheDir?: string;
    /** Keep the top-K candidates per source by relevance; absent means no budget. */
    readonly budget?: number;
  },
): Effect.Effect<LinksDecideReport, AiError.AiError, DecisionModel.DecisionModel> =>
  Effect.gen(function* () {
    const records = yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const hash = inputHash(candidate);
          const key = cacheKey("links", options.model, hash);
          const cached =
            options.cacheDir === undefined ? undefined : cacheGet(options.cacheDir, key);
          if (cached !== undefined && validCachedAnswers(LinkDecision.decisions, cached)) {
            return toRecord(candidate, cached as LinkAnswers, options.threshold);
          }
          const { answers } = yield* DecisionModel.decide(LinkDecision, { input: candidate });
          if (options.cacheDir !== undefined) cachePut(options.cacheDir, key, answers);
          return toRecord(candidate, answers, options.threshold);
        }),
      { concurrency: options.concurrency ?? 4 },
    );
    const selected = options.budget === undefined ? records : applyBudget(records, options.budget);
    return buildLinksDecideReport({
      model: options.model,
      threshold: options.threshold,
      records: selected,
      budget: options.budget,
      dropped: records.length - selected.length,
    });
  });

/** Decode the candidate array the CLI reads from a file or stdin. Throws on invalid input. */
export const decodeLinkCandidates = (input: unknown): ReadonlyArray<LinkCandidate> =>
  Schema.decodeUnknownSync(Schema.Array(LinkCandidate))(input);
