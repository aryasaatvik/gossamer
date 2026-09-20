import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  applyBudget,
  buildLinksDecideReport,
  classifyVerdict,
  decideLinks,
  decodeLinkCandidates,
  LINK_DIRECTIONS,
  LINK_RELEVANCE,
  LinkDecision,
  type LinkCandidate,
  type LinkDecisionRecord,
  type LinkDirection,
  type LinkRelevanceLabel,
} from "../../src/links/decide";
import { classify as classifyAnswer, probability, rate as rateAnswer } from "../decide/helpers";

/** Shape the provider receives after `DecisionModel` encodes the candidate. */
type DecodedState = {
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly sourceText: string;
  readonly existingAnchor?: string | null;
};

type MockAnswers = {
  readonly realReason: number;
  readonly anchorPresent: number;
  readonly direction?: LinkDirection;
  readonly relevance?: LinkRelevanceLabel;
};

/**
 * A `DecisionModel` backed by a lookup table, never the network. `make` runs the
 * same answer validation the live provider does, so a malformed mock fails like a
 * malformed provider response would.
 */
const mockDecisionModel = (
  answers: (state: DecodedState) => MockAnswers,
  onDecide?: (state: DecodedState, decisionKeys: ReadonlyArray<string>) => void,
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.sync(() => {
          const decoded = state as unknown as DecodedState;
          onDecide?.(decoded, Object.keys(decisions));
          const { realReason, anchorPresent, direction = "a_to_b", relevance = "useful" } =
            answers(decoded);
          return {
            answers: {
              realReason: probability(realReason),
              anchorPresent: probability(anchorPresent),
              direction: classifyAnswer(direction, LINK_DIRECTIONS),
              relevance: rateAnswer(relevance, LINK_RELEVANCE),
            },
            usage: { inputTokens: 12, outputTokens: 3 },
          };
        }),
    }),
  );

const relevanceOf = (label: LinkRelevanceLabel) => ({
  rating: LINK_RELEVANCE.indexOf(label),
  label,
  probabilities: rateAnswer(label, LINK_RELEVANCE).probabilities,
});

const record = (
  sourceUrl: string,
  verdict: LinkDecisionRecord["verdict"],
  options: {
    readonly destinationUrl?: string;
    readonly direction?: LinkDirection;
    readonly relevance?: LinkRelevanceLabel;
  } = {},
): LinkDecisionRecord => {
  const destinationUrl = options.destinationUrl ?? `${sourceUrl}-target`;
  const direction = options.direction ?? "a_to_b";
  return {
    sourceUrl,
    destinationUrl,
    sourceText: `${sourceUrl} copy`,
    existingAnchor: null,
    realReason: 0.9,
    anchorPresent: 0.1,
    direction,
    relevance: relevanceOf(options.relevance ?? "useful"),
    ...(direction === "b_to_a" ? { from: destinationUrl, to: sourceUrl } : { from: sourceUrl, to: destinationUrl }),
    verdict,
  };
};

describe("LinkDecision", () => {
  it("asks all four decisions over the candidate input", () => {
    expect(LinkDecision.decisions.realReason._tag).toBe("Probability");
    expect(LinkDecision.decisions.anchorPresent._tag).toBe("Probability");
    expect(LinkDecision.decisions.direction._tag).toBe("Classify");
    expect(LinkDecision.decisions.relevance._tag).toBe("Rate");
  });
});

describe("classifyVerdict", () => {
  it("recommends when there is a real reason and no anchor", () => {
    expect(classifyVerdict(0.92, 0.08, 0.7)).toBe("recommend");
  });

  it("treats an existing anchor as present regardless of reason", () => {
    expect(classifyVerdict(0.9, 0.9, 0.7)).toBe("present");
    expect(classifyVerdict(0.1, 0.9, 0.7)).toBe("present");
  });

  it("skips when there is no real reason", () => {
    expect(classifyVerdict(0.05, 0.1, 0.7)).toBe("skip");
  });

  it("routes an uncertain probability on either decision to review", () => {
    expect(classifyVerdict(0.55, 0.1, 0.7)).toBe("review");
    expect(classifyVerdict(0.9, 0.45, 0.7)).toBe("review");
    expect(classifyVerdict(0.6, 0.6, 0.7)).toBe("review");
  });

  it("treats a probability exactly on the boundary as confident", () => {
    expect(classifyVerdict(0.7, 0.3, 0.7)).toBe("recommend");
    expect(classifyVerdict(0.3, 0.3, 0.7)).toBe("skip");
    expect(classifyVerdict(0.31, 0.7, 0.7)).toBe("review");
  });
});

describe("decodeLinkCandidates", () => {
  it("accepts a candidate without an existing anchor", () => {
    const decoded = decodeLinkCandidates([
      { sourceUrl: "/a", destinationUrl: "/b", sourceText: "copy" },
    ]);
    expect(decoded).toEqual([{ sourceUrl: "/a", destinationUrl: "/b", sourceText: "copy" }]);
    expect(decoded[0]?.existingAnchor).toBeUndefined();
  });

  it("rejects a malformed candidate set", () => {
    expect(() => decodeLinkCandidates([{ sourceUrl: 1 }])).toThrow();
    expect(() => decodeLinkCandidates({ sourceUrl: "/a" })).toThrow();
  });
});

describe("buildLinksDecideReport", () => {
  it("buckets below-threshold records into review and counts every verdict", () => {
    const report = buildLinksDecideReport({
      model: "mock",
      threshold: 0.7,
      records: [
        record("/a", "recommend"),
        record("/b", "present"),
        record("/c", "skip"),
        record("/d", "review"),
      ],
    });

    expect(report).toMatchObject({
      kind: "links-decide",
      schemaVersion: 1,
      model: "mock",
      threshold: 0.7,
      budget: null,
      dropped: 0,
      counts: { candidates: 4, recommend: 1, present: 1, skip: 1, review: 1 },
    });
    expect(report.resolved.map((entry) => entry.verdict)).toEqual(["recommend", "present", "skip"]);
    expect(report.review.map((entry) => entry.sourceUrl)).toEqual(["/d"]);
    // Every candidate appears exactly once across the two buckets.
    expect([...report.resolved, ...report.review]).toHaveLength(4);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });
});

describe("applyBudget", () => {
  it("keeps the top-K per source by relevance, preserving original order", () => {
    const records = [
      record("/a", "recommend", { destinationUrl: "/a1", relevance: "useful" }),
      record("/a", "recommend", { destinationUrl: "/a2", relevance: "essential" }),
      record("/a", "recommend", { destinationUrl: "/a3", relevance: "irrelevant" }),
      record("/b", "recommend", { destinationUrl: "/b1", relevance: "essential" }),
    ];

    const kept = applyBudget(records, 2);

    expect(kept.map((entry) => entry.destinationUrl)).toEqual(["/a1", "/a2", "/b1"]);
  });

  it("passes through sources at or under the budget", () => {
    const records = [record("/a", "recommend", { destinationUrl: "/a1" })];
    expect(applyBudget(records, 4)).toEqual(records);
  });

  it("counts b_to_a candidates against the outbound page's budget", () => {
    const records = [
      record("/a", "recommend", { destinationUrl: "/z", direction: "b_to_a", relevance: "useful" }),
      record("/b", "recommend", { destinationUrl: "/z", direction: "b_to_a", relevance: "essential" }),
      record("/c", "recommend", { destinationUrl: "/z", direction: "b_to_a", relevance: "irrelevant" }),
    ];

    // All three share the outbound page /z; the top two by relevance survive.
    expect(applyBudget(records, 2).map((entry) => entry.sourceUrl)).toEqual(["/a", "/b"]);
  });
});

describe("decideLinks", () => {
  const candidates: ReadonlyArray<LinkCandidate> = [
    { sourceUrl: "/a", destinationUrl: "/pricing", sourceText: "Pricing is simple." },
    {
      sourceUrl: "/b",
      destinationUrl: "/docs",
      sourceText: "Read the docs.",
      existingAnchor: "docs",
    },
    { sourceUrl: "/c", destinationUrl: "/blog", sourceText: "A passing mention." },
    { sourceUrl: "/d", destinationUrl: "/x", sourceText: "Ambiguous copy." },
  ];

  const probabilities: Record<string, { realReason: number; anchorPresent: number }> = {
    "/a": { realReason: 0.92, anchorPresent: 0.08 },
    "/b": { realReason: 0.88, anchorPresent: 0.9 },
    "/c": { realReason: 0.05, anchorPresent: 0.1 },
    "/d": { realReason: 0.55, anchorPresent: 0.1 },
  };

  it("maps answers to records and routes below-threshold candidates to review", async () => {
    const states: Array<DecodedState> = [];
    const decisionKeys: Array<ReadonlyArray<string>> = [];
    const layer = mockDecisionModel(
      (state) => probabilities[state.sourceUrl]!,
      (state, keys) => {
        states.push(state);
        decisionKeys.push(keys);
      },
    );

    const report = await Effect.runPromise(
      decideLinks(candidates, { model: "mock", threshold: 0.7, concurrency: 1 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.counts).toEqual({
      candidates: 4,
      recommend: 1,
      present: 1,
      skip: 1,
      review: 1,
    });
    expect(report.budget).toBeNull();
    expect(report.dropped).toBe(0);
    expect(report.resolved.map((entry) => entry.verdict)).toEqual(["recommend", "present", "skip"]);
    expect(report.review).toEqual([
      {
        sourceUrl: "/d",
        destinationUrl: "/x",
        sourceText: "Ambiguous copy.",
        existingAnchor: null,
        realReason: 0.55,
        anchorPresent: 0.1,
        direction: "a_to_b",
        relevance: relevanceOf("useful"),
        from: "/d",
        to: "/x",
        verdict: "review",
      },
    ]);
    expect(report.resolved[0]).toEqual({
      sourceUrl: "/a",
      destinationUrl: "/pricing",
      sourceText: "Pricing is simple.",
      existingAnchor: null,
      realReason: 0.92,
      anchorPresent: 0.08,
      direction: "a_to_b",
      relevance: relevanceOf("useful"),
      from: "/a",
      to: "/pricing",
      verdict: "recommend",
    });

    // One provider call per candidate, asking all four decisions together.
    expect(states.map((state) => state.sourceUrl)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(decisionKeys).toEqual([
      ["realReason", "anchorPresent", "direction", "relevance"],
      ["realReason", "anchorPresent", "direction", "relevance"],
      ["realReason", "anchorPresent", "direction", "relevance"],
      ["realReason", "anchorPresent", "direction", "relevance"],
    ]);
    // An absent optional field stays absent; a present one is encoded.
    expect(Object.hasOwn(states[0]!, "existingAnchor")).toBe(false);
    expect(states[1]!.existingAnchor).toBe("docs");
  });

  it("emits the exact JSON shape under JSON.stringify", async () => {
    const layer = mockDecisionModel((state) => probabilities[state.sourceUrl]!);
    const report = await Effect.runPromise(
      decideLinks(candidates, { model: "jev-latest", threshold: 0.7, concurrency: 2 }).pipe(
        Effect.provide(layer),
      ),
    );

    const relevance = relevanceOf("useful");
    expect(JSON.parse(JSON.stringify(report))).toEqual({
      kind: "links-decide",
      schemaVersion: 1,
      model: "jev-latest",
      threshold: 0.7,
      budget: null,
      dropped: 0,
      counts: { candidates: 4, recommend: 1, present: 1, skip: 1, review: 1 },
      resolved: [
        {
          sourceUrl: "/a",
          destinationUrl: "/pricing",
          sourceText: "Pricing is simple.",
          existingAnchor: null,
          realReason: 0.92,
          anchorPresent: 0.08,
          direction: "a_to_b",
          relevance,
          from: "/a",
          to: "/pricing",
          verdict: "recommend",
        },
        {
          sourceUrl: "/b",
          destinationUrl: "/docs",
          sourceText: "Read the docs.",
          existingAnchor: "docs",
          realReason: 0.88,
          anchorPresent: 0.9,
          direction: "a_to_b",
          relevance,
          from: "/b",
          to: "/docs",
          verdict: "present",
        },
        {
          sourceUrl: "/c",
          destinationUrl: "/blog",
          sourceText: "A passing mention.",
          existingAnchor: null,
          realReason: 0.05,
          anchorPresent: 0.1,
          direction: "a_to_b",
          relevance,
          from: "/c",
          to: "/blog",
          verdict: "skip",
        },
      ],
      review: [
        {
          sourceUrl: "/d",
          destinationUrl: "/x",
          sourceText: "Ambiguous copy.",
          existingAnchor: null,
          realReason: 0.55,
          anchorPresent: 0.1,
          direction: "a_to_b",
          relevance,
          from: "/d",
          to: "/x",
          verdict: "review",
        },
      ],
    });
  });

  it("reverses the recommended endpoints when the model picks b_to_a", async () => {
    const layer = mockDecisionModel((state) => ({
      ...probabilities[state.sourceUrl]!,
      direction: "b_to_a",
    }));
    const report = await Effect.runPromise(
      decideLinks([candidates[0]!], { model: "mock", threshold: 0.7 }).pipe(Effect.provide(layer)),
    );

    expect(report.resolved[0]).toMatchObject({
      sourceUrl: "/a",
      destinationUrl: "/pricing",
      direction: "b_to_a",
      from: "/pricing",
      to: "/a",
      verdict: "recommend",
    });
  });

  it("applies the per-source budget and reports what it dropped", async () => {
    const sameSource: ReadonlyArray<LinkCandidate> = [
      { sourceUrl: "/a", destinationUrl: "/a1", sourceText: "one" },
      { sourceUrl: "/a", destinationUrl: "/a2", sourceText: "two" },
      { sourceUrl: "/a", destinationUrl: "/a3", sourceText: "three" },
    ];
    const layer = mockDecisionModel((state) => ({
      ...probabilities["/a"]!,
      relevance: state.destinationUrl === "/a2" ? "essential" : "irrelevant",
    }));

    const report = await Effect.runPromise(
      decideLinks(sameSource, { model: "mock", threshold: 0.7, budget: 1 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.budget).toBe(1);
    expect(report.dropped).toBe(2);
    expect(report.counts.candidates).toBe(1);
    expect(report.resolved[0]?.destinationUrl).toBe("/a2");
  });

  it("returns an empty report for no candidates", async () => {
    const layer = mockDecisionModel(() => ({ realReason: 0.9, anchorPresent: 0.1 }));
    const report = await Effect.runPromise(
      decideLinks([], { model: "mock", threshold: 0.7 }).pipe(Effect.provide(layer)),
    );

    expect(report.counts).toEqual({
      candidates: 0,
      recommend: 0,
      present: 0,
      skip: 0,
      review: 0,
    });
    expect(report.resolved).toEqual([]);
    expect(report.review).toEqual([]);
  });
});
