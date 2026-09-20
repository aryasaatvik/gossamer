import * as Effect from "effect/Effect";
import type { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  classifyContentVerdict,
  CONTENT_VALUES,
  contentFamily,
} from "../../src/decide/families/content";
import { decodeFamilyInputs, runDecisions } from "../../src/decide/run";
import { mockDecisionModel, probability, rate } from "./helpers";

const sample = {
  url: "https://example.com/email-api",
  title: "Transactional email API for product teams",
  h1: "Send transactional email",
  first150Words: "The API sends one message per call and reports delivery events.",
  headings: ["Quickstart", "Events", "Pricing"],
  wordCount: 1200,
  structuredData: ["Article", "FAQPage"],
  categoryLock: "email api",
  competitorExcerpts: ["A competitor's overview."],
};

const falseProbability = 0.05;

type OverrideKey =
  | "answersFirst"
  | "originalValue"
  | "competitiveSubstance"
  | "descriptiveTitle"
  | "structuredDataMatches"
  | "categoryConsistency"
  | "distinctIntent"
  | "value";

const contentAnswers = (
  overrides: Partial<Record<OverrideKey, string | number>> = {},
): ((key: string) => DecisionModel.ProviderAnswer) => {
  const value = (overrides.value as string | undefined) ?? "strong";
  return (key) => {
    if (key === "value") return rate(value, CONTENT_VALUES);
    const probabilityValue = (overrides[key as OverrideKey] as number | undefined) ?? 0.9;
    return probability(probabilityValue);
  };
};

const answersFor = (
  overrides: Partial<Record<Exclude<OverrideKey, "value">, number>> = {},
  value: string = "strong",
  valueConfidence = 0.9,
) => {
  const valueAnswer = rate(value, CONTENT_VALUES, valueConfidence);
  return {
    value: { label: value, probabilities: valueAnswer.probabilities },
    ...Object.fromEntries(
      (
        [
          "answersFirst",
          "originalValue",
          "competitiveSubstance",
          "descriptiveTitle",
          "structuredDataMatches",
          "categoryConsistency",
          "distinctIntent",
        ] as const
      ).map((key) => [key, { probability: overrides[key] ?? 0.9 }]),
    ),
  } as unknown as Parameters<typeof classifyContentVerdict>[0];
};

describe("ContentInput", () => {
  it("decodes a page and rejects a malformed one", () => {
    expect(decodeFamilyInputs(contentFamily, [sample])).toHaveLength(1);
    expect(() => decodeFamilyInputs(contentFamily, [{ url: "x" }])).toThrow();
  });
});

describe("classifyContentVerdict", () => {
  it("passes a confident, strong page", () => {
    expect(classifyContentVerdict(answersFor(), 0.7)).toBe("pass");
  });

  it("flags a thin page and any confidently failed rubric item", () => {
    expect(classifyContentVerdict(answersFor({}, "thin"), 0.7)).toBe("flag");
    expect(classifyContentVerdict(answersFor({ originalValue: falseProbability }), 0.7)).toBe("flag");
  });

  it("reviews when any probability is inside the band", () => {
    expect(classifyContentVerdict(answersFor({ answersFirst: 0.6 }), 0.7)).toBe("review");
    // An ambiguous value distribution is uncertain even if its label is strong.
    expect(classifyContentVerdict(answersFor({}, "strong", 0.4), 0.7)).toBe("review");
  });
});

describe("content family run", () => {
  it("answers all eight decisions per input and splits pass from flag", async () => {
    const inputs = decodeFamilyInputs(contentFamily, [
      sample,
      { ...sample, url: "https://example.com/thin" },
    ]);
    const layer = mockDecisionModel((key, state) => {
      const url = (state as { url: string }).url;
      if (url.endsWith("/thin")) return contentAnswers({ value: "thin" })(key);
      return contentAnswers()(key);
    });

    const report = await Effect.runPromise(
      runDecisions({ family: contentFamily, inputs, model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.verdicts).toEqual({ pass: 1, flag: 1 });
    expect(report.resolved.map((record) => record.verdict).sort()).toEqual(["flag", "pass"]);
    expect(report.resolved[0]?.answers).toMatchObject({ value: { label: "strong" } });
  });
});
