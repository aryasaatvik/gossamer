/**
 * Deterministic decision-model doubles for family tests. `DecisionModel.make`
 * runs the same answer validation the live provider does, so a malformed mock
 * fails exactly as a malformed provider response would — and no test touches the
 * network or needs `TYPESAFE_API_KEY`.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DecisionModel } from "effect/unstable/ai";

export const probability = (value: number): DecisionModel.ProviderProbabilityAnswer => ({
  _tag: "Probability",
  probability: value,
});

/** A classify answer that puts `confidence` on `label` and splits the rest. */
export const classify = (
  label: string,
  labels: ReadonlyArray<string>,
  confidence = 0.9,
): DecisionModel.ProviderClassifyAnswer => {
  const rest = (1 - confidence) / (labels.length - 1);
  return {
    _tag: "Classify",
    label,
    probabilities: Object.fromEntries(labels.map((level) => [level, level === label ? confidence : rest])),
  };
};

/** A rate answer positioned at `level`, with its `rating` as the level index. */
export const rate = (
  level: string,
  levels: ReadonlyArray<string>,
  confidence = 0.9,
): DecisionModel.ProviderRateAnswer => {
  const rest = (1 - confidence) / (levels.length - 1);
  return {
    _tag: "Rate",
    rating: levels.indexOf(level),
    probabilities: Object.fromEntries(levels.map((each) => [each, each === level ? confidence : rest])),
  };
};

/** A `DecisionModel` backed by `answer(key, state)`; never the network. */
export const mockDecisionModel = (
  answer: (key: string, state: Readonly<Record<string, unknown>>) => DecisionModel.ProviderAnswer,
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.sync(() => ({
          answers: Object.fromEntries(
            Object.keys(decisions).map((key) => [
              key,
              answer(key, state as Readonly<Record<string, unknown>>),
            ]),
          ),
          usage: { inputTokens: 1, outputTokens: 1 },
        })),
    }),
  );
