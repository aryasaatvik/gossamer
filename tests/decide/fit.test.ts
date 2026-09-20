import * as Effect from "effect/Effect";
import type { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  classifyFitVerdict,
  FitInput,
  fitFamily,
  MAX_LABEL_LENGTH,
  validateFitInput,
} from "../../src/decide/families/fit";
import { decodeFamilyInputs, runDecisions } from "../../src/decide/run";
import { classify, mockDecisionModel, probability } from "./helpers";

const sample = {
  query: "best email api",
  candidates: [
    { id: "/email-api", title: "Email API", excerpt: "Send transactional email." },
    { id: "/pricing", title: "Pricing", excerpt: "Volume pricing." },
  ],
};

const idsOf = (state: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
  (state.candidates as ReadonlyArray<{ id: string }>).map((candidate) => candidate.id);

const fitAnswers =
  (options: { best?: string; competition?: number; needsNewPage?: number } = {}) =>
  (key: string, state: Readonly<Record<string, unknown>>): DecisionModel.ProviderAnswer => {
    const ids = idsOf(state);
    switch (key) {
      case "bestPage":
        return classify(options.best ?? ids[0]!, ids);
      case "competition":
        return probability(options.competition ?? 0.05);
      case "needsNewPage":
        return probability(options.needsNewPage ?? 0.05);
      default:
        throw new Error(`unexpected decision ${key}`);
    }
  };

const bestAnswer = (label: string, confidence = 0.9) => {
  const answer = classify(label, ["/a", "/b"], confidence);
  return { label: answer.label, probabilities: answer.probabilities };
};

describe("FitInput", () => {
  it("decodes candidates and rejects a malformed input", () => {
    expect(decodeFamilyInputs(fitFamily, [sample])).toHaveLength(1);
    expect(() => decodeFamilyInputs(fitFamily, [{ query: "x", candidates: [{}] }])).toThrow();
  });
});

describe("validateFitInput", () => {
  it("requires two candidates and bounded label ids", () => {
    expect(validateFitInput(sample)).toBeUndefined();
    expect(validateFitInput({ query: "x", candidates: [sample.candidates[0]!] })).toContain(
      "at least two candidates",
    );
    const longId = "x".repeat(MAX_LABEL_LENGTH + 1);
    expect(
      validateFitInput({
        query: "x",
        candidates: [{ id: longId, title: "t", excerpt: "e" }, sample.candidates[1]!],
      }),
    ).toContain("exceeds");
  });

  it("rejects duplicate candidate ids", () => {
    expect(
      validateFitInput({
        query: "x",
        candidates: [
          { id: "a", title: "one", excerpt: "e" },
          { id: "a", title: "two", excerpt: "e" },
        ],
      }),
    ).toContain("unique");
  });
});

describe("classifyFitVerdict", () => {
  const answers = (competition: number, needsNewPage: number, bestConfidence = 0.9) => ({
    bestPage: bestAnswer("/a", bestConfidence),
    competition: { probability: competition },
    needsNewPage: { probability: needsNewPage },
  });

  it("maps when a page is confidently best and there is no conflict", () => {
    expect(classifyFitVerdict(answers(0.05, 0.05), 0.7)).toBe("map");
  });

  it("prefers gap over cannibalized when both are confident", () => {
    expect(classifyFitVerdict(answers(0.9, 0.05), 0.7)).toBe("cannibalized");
    expect(classifyFitVerdict(answers(0.05, 0.9), 0.7)).toBe("gap");
    expect(classifyFitVerdict(answers(0.9, 0.9), 0.7)).toBe("gap");
  });

  it("reviews an uncertain conflict or an uncertain best page", () => {
    expect(classifyFitVerdict(answers(0.6, 0.05), 0.7)).toBe("review");
    expect(classifyFitVerdict(answers(0.05, 0.05, 0.4), 0.7)).toBe("review");
  });
});

describe("fit family run", () => {
  it("builds the label set from the candidates and maps the batch", async () => {
    const inputs = decodeFamilyInputs(fitFamily, [
      sample,
      { query: "no page", candidates: sample.candidates },
      { query: "crowded", candidates: sample.candidates },
    ]);
    const layer = mockDecisionModel((key, state) => {
      const query = (state as { query: string }).query;
      if (query === "no page") return fitAnswers({ needsNewPage: 0.9 })(key, state);
      if (query === "crowded") return fitAnswers({ competition: 0.9 })(key, state);
      return fitAnswers()(key, state);
    });

    const report = await Effect.runPromise(
      runDecisions({ family: fitFamily, inputs, model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.verdicts).toEqual({ map: 1, gap: 1, cannibalized: 1 });
    expect(report.resolved[0]?.inputRef).toBe("query:best email api");
  });

  it("exposes the input schema", () => {
    expect(fitFamily.input).toBe(FitInput);
  });
});
