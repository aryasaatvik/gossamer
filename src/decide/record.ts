/**
 * The one record every decision family emits, and the batch report that groups
 * them. A record is self-describing: which family, model, threshold, and input
 * produced the verdict, plus the raw family-decoded answers the model returned.
 *
 * Answers stay `Schema.Unknown` because each family owns its own answer shape;
 * the record is the transport, not another schema to keep in sync. `review`
 * mirrors `verdict === "review"` and is what `--review-out` selects on.
 */

import * as Schema from "effect/Schema";

/** Provider-reported token usage; unreported counts stay `undefined`. */
export const DecisionUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
});
export type DecisionUsage = Schema.Schema.Type<typeof DecisionUsage>;

/** One answered decision: what was asked, what came back, and how it landed. */
export const DecisionRecord = Schema.Struct({
  /** Family-qualified stable id: `<family>:<index>` within the batch. */
  decisionId: Schema.String,
  schemaVersion: Schema.Literal(1),
  family: Schema.String,
  model: Schema.String,
  threshold: Schema.Number,
  /** sha256 of the canonical input JSON — the cache key. */
  inputHash: Schema.String,
  /** Human reference for the input: a URL, `query:…`, or `from → to`. */
  inputRef: Schema.String,
  verdict: Schema.String,
  review: Schema.Boolean,
  /** Family-decoded model answers, exactly as the family reads them. */
  answers: Schema.Unknown,
  usage: Schema.optional(DecisionUsage),
});
export type DecisionRecord = Schema.Schema.Type<typeof DecisionRecord>;

/** Counts a batch report always carries, independent of family verdicts. */
export interface DecisionCounts {
  readonly inputs: number;
  readonly resolved: number;
  readonly review: number;
}

/**
 * Internal decision-family report. Every input appears exactly once across
 * `resolved` and `review`; `verdicts` counts each family verdict.
 */
export interface DecisionBatchReport {
  readonly kind: "decide";
  readonly schemaVersion: 1;
  readonly family: string;
  readonly model: string;
  readonly threshold: number;
  readonly counts: DecisionCounts;
  readonly verdicts: Readonly<Record<string, number>>;
  readonly resolved: ReadonlyArray<DecisionRecord>;
  readonly review: ReadonlyArray<DecisionRecord>;
}
