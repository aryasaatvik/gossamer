import * as Effect from "effect/Effect";
import type { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  AUTHORITY_FITS,
  AuthorityInput,
  authorityFamily,
  classifyAuthorityVerdict,
} from "../../src/decide/families/authority";
import { decodeFamilyInputs, runDecisions } from "../../src/decide/run";
import { classify, mockDecisionModel, probability } from "./helpers";

const sample = {
  domain: "blog.example",
  url: "https://blog.example/email-guide",
  anchor: "transactional email API",
  context: "We cover how a transactional email API works end to end.",
  targetPath: "/email-api",
  rd: 120,
  signals: ["editorial", "no-outbound-links"],
};

const authorityAnswers =
  (
    options: {
      legitimate?: number;
      spam?: number;
      outreachWorth?: number;
      fit?: string;
    } = {},
  ) =>
  (key: string): DecisionModel.ProviderAnswer => {
    switch (key) {
      case "legitimate":
        return probability(options.legitimate ?? 0.9);
      case "spam":
        return probability(options.spam ?? 0.05);
      case "outreachWorth":
        return probability(options.outreachWorth ?? 0.9);
      case "fit":
        return classify(options.fit ?? "editorial", AUTHORITY_FITS);
      default:
        throw new Error(`unexpected decision ${key}`);
    }
  };

const fitAnswer = (label: string, confidence = 0.9) => {
  const answer = classify(label, AUTHORITY_FITS, confidence);
  return { label: answer.label, probabilities: answer.probabilities };
};

const verdictAnswers = (overrides: {
  legitimate?: number;
  spam?: number;
  outreachWorth?: number;
  fit?: string;
  fitConfidence?: number;
} = {}) => ({
  legitimate: { probability: overrides.legitimate ?? 0.9 },
  spam: { probability: overrides.spam ?? 0.05 },
  outreachWorth: { probability: overrides.outreachWorth ?? 0.9 },
  fit: fitAnswer(overrides.fit ?? "editorial", overrides.fitConfidence ?? 0.9),
});

describe("AuthorityInput", () => {
  it("decodes a target and rejects a malformed one", () => {
    expect(decodeFamilyInputs(authorityFamily, [sample])).toHaveLength(1);
    expect(() => decodeFamilyInputs(authorityFamily, [{ domain: 1 }])).toThrow();
    expect(decodeFamilyInputs(authorityFamily, [{ ...sample, signals: undefined }])).toHaveLength(1);
  });
});

describe("classifyAuthorityVerdict", () => {
  it("accepts a legitimate, worthwhile, well-fitting target", () => {
    expect(classifyAuthorityVerdict(verdictAnswers(), 0.7)).toBe("accept");
  });

  it("fails a confident spam target", () => {
    expect(classifyAuthorityVerdict(verdictAnswers({ spam: 0.9 }), 0.7)).toBe("spam");
  });

  it("reviews anything uncertain or without a fit", () => {
    expect(classifyAuthorityVerdict(verdictAnswers({ legitimate: 0.6 }), 0.7)).toBe("review");
    expect(classifyAuthorityVerdict(verdictAnswers({ legitimate: 0.1 }), 0.7)).toBe("review");
    expect(classifyAuthorityVerdict(verdictAnswers({ outreachWorth: 0.1 }), 0.7)).toBe("review");
    expect(classifyAuthorityVerdict(verdictAnswers({ fit: "none" }), 0.7)).toBe("review");
    expect(classifyAuthorityVerdict(verdictAnswers({ fitConfidence: 0.4 }), 0.7)).toBe("review");
  });
});

describe("authority family run", () => {
  it("splits accept, spam, and review across a batch", async () => {
    const inputs = decodeFamilyInputs(authorityFamily, [
      sample,
      { ...sample, domain: "spam.example" },
      { ...sample, domain: "maybe.example" },
    ]);
    const layer = mockDecisionModel((key, state) => {
      const domain = (state as { domain: string }).domain;
      if (domain === "spam.example") return authorityAnswers({ spam: 0.95 })(key);
      if (domain === "maybe.example") return authorityAnswers({ outreachWorth: 0.6 })(key);
      return authorityAnswers()(key);
    });

    const report = await Effect.runPromise(
      runDecisions({ family: authorityFamily, inputs, model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.verdicts).toEqual({ accept: 1, spam: 1, review: 1 });
    expect(report.resolved.map((record) => record.inputRef).sort()).toEqual([
      "blog.example",
      "spam.example",
    ]);
    expect(report.review[0]?.inputRef).toBe("maybe.example");
  });

  it("exposes the input schema", () => {
    expect(authorityFamily.input).toBe(AuthorityInput);
  });
});
