import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { DecisionModel } from "effect/unstable/ai";

import {
  classifySerpVerdict,
  SERP_FORMATS,
  serpFamily,
  SerpInput,
} from "../../src/decide/families/serp";
import { decodeFamilyInputs, runDecisions } from "../../src/decide/run";
import { classify, mockDecisionModel, probability } from "./helpers";

const sample = {
  query: "best email api",
  ourPage: {
    url: "https://example.com/email-api",
    title: "Email API for developers",
    kind: "page",
    firstWords: "Send transactional email from your product.",
  },
  serpItems: [
    { type: "organic", rank: 1, domain: "a.example", title: "Best email APIs", snippet: "Compare" },
    { type: "organic", rank: 2, domain: "b.example", title: "Email API comparison" },
  ],
};

const serpAnswers = (
  overrides: Partial<Record<"ourFormatFit" | "intentMatch" | "titlePatternMatch", number>> = {},
): ((key: string) => DecisionModel.ProviderAnswer) => {
  const fit = overrides.ourFormatFit ?? 0.9;
  const intent = overrides.intentMatch ?? 0.9;
  const title = overrides.titlePatternMatch ?? 0.85;
  return (key) => {
    switch (key) {
      case "serpFormat":
        return classify("comparison", SERP_FORMATS);
      case "ourFormatFit":
        return probability(fit);
      case "intentMatch":
        return probability(intent);
      case "titlePatternMatch":
        return probability(title);
      default:
        throw new Error(`unexpected decision ${key}`);
    }
  };
};

describe("SerpInput", () => {
  it("decodes a saved SERP snapshot and rejects a malformed one", () => {
    expect(decodeFamilyInputs(serpFamily, [sample])).toHaveLength(1);
    expect(() => decodeFamilyInputs(serpFamily, [{ query: "x" }])).toThrow();
  });
});

describe("classifySerpVerdict", () => {
  const answers = (fit: number, intent: number, title: number) => ({
    ourFormatFit: { probability: fit },
    intentMatch: { probability: intent },
    titlePatternMatch: { probability: title },
  });

  it("aligns when intent and format are confidently positive", () => {
    expect(classifySerpVerdict(answers(0.9, 0.9, 0.8), 0.7)).toBe("aligned");
  });

  it("mismatches when either intent or format is confidently negative", () => {
    expect(classifySerpVerdict(answers(0.9, 0.05, 0.8), 0.7)).toBe("mismatch");
    expect(classifySerpVerdict(answers(0.1, 0.9, 0.8), 0.7)).toBe("mismatch");
    expect(classifySerpVerdict(answers(0.1, 0.1, 0.8), 0.7)).toBe("mismatch");
  });

  it("reviews when any probability is inside the band", () => {
    expect(classifySerpVerdict(answers(0.6, 0.9, 0.8), 0.7)).toBe("review");
    expect(classifySerpVerdict(answers(0.9, 0.9, 0.55), 0.7)).toBe("review");
  });
});

describe("serp family run", () => {
  it("answers the format and three probabilities in one call per input", async () => {
    const layer = mockDecisionModel(serpAnswers());

    const report = await Effect.runPromise(
      runDecisions({
        family: serpFamily,
        inputs: decodeFamilyInputs(serpFamily, [sample]),
        model: "mock",
        threshold: 0.7,
      }).pipe(Effect.provide(layer)),
    );

    expect(report.family).toBe("serp");
    expect(report.verdicts).toEqual({ aligned: 1 });
    expect(report.resolved[0]?.inputRef).toBe("https://example.com/email-api · query:best email api");
    expect(report.resolved[0]?.answers).toMatchObject({
      serpFormat: { label: "comparison" },
      ourFormatFit: { probability: 0.9 },
    });
  });

  it("routes a confidently wrong format and an uncertain one apart", async () => {
    const inputs = decodeFamilyInputs(serpFamily, [
      sample,
      { ...sample, query: "wrong", ourPage: { ...sample.ourPage, url: "https://example.com/wrong" } },
      { ...sample, query: "uncertain", ourPage: { ...sample.ourPage, url: "https://example.com/uncertain" } },
    ]);

    const layer = mockDecisionModel((key, state) => {
      const query = (state as { query: string }).query;
      if (query === "wrong") return serpAnswers({ ourFormatFit: 0.1 })(key);
      if (query === "uncertain") return serpAnswers({ intentMatch: 0.6 })(key);
      return serpAnswers()(key);
    });

    const report = await Effect.runPromise(
      runDecisions({ family: serpFamily, inputs, model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.verdicts).toEqual({ aligned: 1, mismatch: 1, review: 1 });
    expect(report.review.map((record) => record.inputRef)).toEqual([
      "https://example.com/uncertain · query:uncertain",
    ]);
  });

  it("exposes the input schema", () => {
    expect(serpFamily.input).toBe(SerpInput);
  });
});
