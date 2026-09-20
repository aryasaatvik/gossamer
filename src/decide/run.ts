/**
 * The decision runner. A family supplies its input schema, a definition built
 * from the input (families with dynamic labels build one per input), a way to
 * reference the input in a report, and a pure `evaluate` that maps the model's
 * answers to a verdict. The runner hashes, caches, dispatches with bounded
 * concurrency, and buckets confident answers apart from `review`.
 *
 * This module reaches Effect and the provider, so it is CLI-internal: the
 * library entries stay Effect-free and only the bundled `pagegraph` bin ships it.
 */

import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DecisionModel } from "effect/unstable/ai";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as Decision from "effect/unstable/ai/Decision";

import { cacheGet, cachePut } from "./cache";
import { DecisionRecord, type DecisionBatchReport } from "./record";

/**
 * One decision family. `answers` in `evaluate` is erased because each family
 * reads its own `Decision.Answers` shape; the family is the only place that
 * shape is known, and a `DecisionModel` validates it before it arrives.
 */
export interface DecisionFamily<Input> {
  readonly name: string;
  readonly input: Schema.Schema<Input>;
  /** Build the definition for one input; dynamic-label families build per input. */
  readonly definitionFor: (input: Input) => Decision.Definition<any, any>;
  /** Stable human reference for the input in a report. */
  readonly inputRef: (input: Input) => string;
  /** Map validated answers to a verdict; `"review"` means a human decides. */
  readonly evaluate: (input: Input, answers: any, threshold: number) => string;
}

/** A probability is confident when it is at or beyond `threshold` on either side. */
export const isConfident = (probability: number, threshold: number): boolean =>
  probability >= threshold || probability <= 1 - threshold;

/** True when a probability sits inside the review band `(1 - threshold, threshold)`. */
export const inReviewBand = (probability: number, threshold: number): boolean =>
  !isConfident(probability, threshold);

/** True when any probability sits inside the review band. */
export const anyInReviewBand = (
  probabilities: ReadonlyArray<number>,
  threshold: number,
): boolean => probabilities.some((probability) => inReviewBand(probability, threshold));

/** sha256 of the canonical input JSON — deterministic for a schema-decoded input. */
export const inputHash = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** Bump when a family's answer shape changes, so old cache files stop matching. */
export const DECISION_ANSWER_SCHEMA_VERSION = 1;

/**
 * Cache identity. Answers depend on the family and the model as well as the
 * input, so keying by the input hash alone would let a different family or model
 * reuse incompatible answers. The answer-schema version guards shape changes.
 */
export const cacheKey = (family: string, model: string, answerHash: string): string =>
  createHash("sha256")
    .update(`${family}\u0000${model}\u0000v${DECISION_ANSWER_SCHEMA_VERSION}\u0000${answerHash}`)
    .digest("hex");

export interface RunOptions<Input> {
  readonly family: DecisionFamily<Input>;
  readonly inputs: ReadonlyArray<Input>;
  readonly model: string;
  readonly threshold: number;
  readonly concurrency?: number;
  /** Cache directory; absent means no cache. */
  readonly cacheDir?: string;
}

/** Group records into resolved/review buckets and count each verdict. */
export const buildDecisionReport = (options: {
  readonly family: string;
  readonly model: string;
  readonly threshold: number;
  readonly records: ReadonlyArray<DecisionRecord>;
}): DecisionBatchReport => {
  const verdicts: Record<string, number> = {};
  const resolved: Array<DecisionRecord> = [];
  const review: Array<DecisionRecord> = [];
  for (const record of options.records) {
    verdicts[record.verdict] = (verdicts[record.verdict] ?? 0) + 1;
    if (record.review) review.push(record);
    else resolved.push(record);
  }
  return {
    kind: "decide",
    schemaVersion: 1,
    family: options.family,
    model: options.model,
    threshold: options.threshold,
    counts: {
      inputs: options.records.length,
      resolved: resolved.length,
      review: review.length,
    },
    verdicts,
    resolved,
    review,
  };
};

/**
 * Answer every input through the ambient `DecisionModel` and bucket the results.
 * One provider call answers every decision for an input; calls run with bounded
 * concurrency, and a warm cache skips the provider entirely.
 */
export const runDecisions = <Input>(
  options: RunOptions<Input>,
): Effect.Effect<DecisionBatchReport, AiError.AiError, DecisionModel.DecisionModel> =>
  Effect.gen(function* () {
    const records = yield* Effect.forEach(
      options.inputs,
      (input, index) =>
        Effect.gen(function* () {
          const hash = inputHash(input);
          const key = cacheKey(options.family.name, options.model, hash);
          const cached = options.cacheDir === undefined ? undefined : cacheGet(options.cacheDir, key);
          let answers: unknown;
          let usage: DecisionRecord["usage"];
          let verdict: string | undefined;
          if (cached !== undefined) {
            // A corrupt or stale cache file must not abort the run. Evaluating
            // the cached shape is the check: if the family cannot read it, fall
            // through and ask the provider (which surfaces real bugs itself).
            try {
              verdict = options.family.evaluate(input, cached, options.threshold);
              answers = cached;
            } catch {
              verdict = undefined;
            }
          }
          if (verdict === undefined) {
            const response = yield* DecisionModel.decide(options.family.definitionFor(input), {
              input,
            });
            answers = response.answers;
            usage = {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
            };
            if (options.cacheDir !== undefined) cachePut(options.cacheDir, key, answers);
            verdict = options.family.evaluate(input, answers, options.threshold);
          }
          return {
            decisionId: `${options.family.name}:${index}`,
            schemaVersion: 1,
            family: options.family.name,
            model: options.model,
            threshold: options.threshold,
            inputHash: hash,
            inputRef: options.family.inputRef(input),
            verdict,
            review: verdict === "review",
            answers,
            ...(usage === undefined ? {} : { usage }),
          } satisfies DecisionRecord;
        }),
      { concurrency: options.concurrency ?? 4 },
    );
    return buildDecisionReport({
      family: options.family.name,
      model: options.model,
      threshold: options.threshold,
      records,
    });
  });

/** Decode raw batch inputs against a family's schema. Throws on the first invalid input. */
/** `decodeUnknownSync` with an unconstrained schema type; the family types the result. */
const decodeUnknown = Schema.decodeUnknownSync as unknown as (
  schema: Schema.Constraint,
) => (value: unknown) => unknown;

export const decodeFamilyInputs = <Input>(
  family: DecisionFamily<Input>,
  raw: ReadonlyArray<unknown>,
): ReadonlyArray<Input> => raw.map((value) => decodeUnknown(family.input)(value) as Input);
