import * as Effect from "effect/Effect";
import type { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  classifyMetaVerdict,
  MAX_LABEL_LENGTH,
  MetaInput,
  metaFamily,
  validateMetaInput,
} from "../../src/decide/families/meta";
import { decodeFamilyInputs, runDecisions } from "../../src/decide/run";
import { classify, mockDecisionModel, probability } from "./helpers";

const sample = {
  url: "https://example.com/email-api",
  intent: "choose an email api",
  categoryLock: "email api",
  candidates: [
    { id: "a", title: "Email API", description: "Send transactional email." },
    { id: "b", title: "Email pricing", description: "Volume pricing." },
  ],
};

const idsOf = (state: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
  (state.candidates as ReadonlyArray<{ id: string }>).map((candidate) => candidate.id);

const metaAnswers =
  (
    options: {
      best?: string;
      intentFit?: number;
      lengthOk?: number;
      categoryDrift?: number;
      clickbait?: number;
    } = {},
  ) =>
  (key: string, state: Readonly<Record<string, unknown>>): DecisionModel.ProviderAnswer => {
    const ids = idsOf(state);
    switch (key) {
      case "best":
        return classify(options.best ?? ids[0]!, ids);
      case "intentFit":
        return probability(options.intentFit ?? 0.9);
      case "lengthOk":
        return probability(options.lengthOk ?? 0.9);
      case "categoryDrift":
        return probability(options.categoryDrift ?? 0.05);
      case "clickbait":
        return probability(options.clickbait ?? 0.05);
      default:
        throw new Error(`unexpected decision ${key}`);
    }
  };

const bestAnswer = (label: string, confidence = 0.9) => {
  const answer = classify(label, ["a", "b"], confidence);
  return { label: answer.label, probabilities: answer.probabilities };
};

const answers = (overrides: {
  bestConfidence?: number;
  intentFit?: number;
  lengthOk?: number;
  categoryDrift?: number;
  clickbait?: number;
} = {}) => ({
  best: bestAnswer("a", overrides.bestConfidence ?? 0.9),
  intentFit: { probability: overrides.intentFit ?? 0.9 },
  lengthOk: { probability: overrides.lengthOk ?? 0.9 },
  categoryDrift: { probability: overrides.categoryDrift ?? 0.05 },
  clickbait: { probability: overrides.clickbait ?? 0.05 },
});

describe("MetaInput", () => {
  it("decodes candidates and rejects a malformed input", () => {
    expect(decodeFamilyInputs(metaFamily, [sample])).toHaveLength(1);
    expect(() => decodeFamilyInputs(metaFamily, [{ url: "x" }])).toThrow();
  });
});

describe("validateMetaInput", () => {
  it("requires two candidates and bounded label ids", () => {
    expect(validateMetaInput(sample)).toBeUndefined();
    expect(validateMetaInput({ ...sample, candidates: [sample.candidates[0]!] })).toContain(
      "at least two candidates",
    );
    expect(
      validateMetaInput({
        ...sample,
        candidates: [
          { id: "x".repeat(MAX_LABEL_LENGTH + 1), title: "t", description: "d" },
          sample.candidates[1]!,
        ],
      }),
    ).toContain("exceeds");
  });

  it("rejects duplicate candidate ids", () => {
    expect(
      validateMetaInput({
        ...sample,
        candidates: [
          { id: "a", title: "one", description: "d" },
          { id: "a", title: "two", description: "d" },
        ],
      }),
    ).toContain("unique");
  });
});

describe("classifyMetaVerdict", () => {
  it("chooses the best candidate when every concern is confidently clear", () => {
    expect(classifyMetaVerdict(answers(), 0.7)).toBe("choose:a");
  });

  it("reviews a low-probability pick or any concern", () => {
    expect(classifyMetaVerdict(answers({ bestConfidence: 0.4 }), 0.7)).toBe("review");
    expect(classifyMetaVerdict(answers({ intentFit: 0.1 }), 0.7)).toBe("review");
    expect(classifyMetaVerdict(answers({ lengthOk: 0.1 }), 0.7)).toBe("review");
    expect(classifyMetaVerdict(answers({ categoryDrift: 0.9 }), 0.7)).toBe("review");
    expect(classifyMetaVerdict(answers({ clickbait: 0.9 }), 0.7)).toBe("review");
    expect(classifyMetaVerdict(answers({ intentFit: 0.6 }), 0.7)).toBe("review");
  });
});

describe("meta family run", () => {
  it("builds labels from the candidates and chooses or reviews", async () => {
    const inputs = decodeFamilyInputs(metaFamily, [sample, { ...sample, url: "https://e.com/x" }]);
    const layer = mockDecisionModel((key, state) => {
      const url = (state as { url: string }).url;
      if (url.endsWith("/x")) return metaAnswers({ clickbait: 0.9 })(key, state);
      return metaAnswers()(key, state);
    });

    const report = await Effect.runPromise(
      runDecisions({ family: metaFamily, inputs, model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.verdicts).toEqual({ "choose:a": 1, review: 1 });
    expect(report.resolved[0]?.verdict).toBe("choose:a");
    expect(report.review[0]?.inputRef).toBe("https://e.com/x");
  });
});
