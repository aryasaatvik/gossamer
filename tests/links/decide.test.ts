import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DecisionModel } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import {
  buildLinksDecideReport,
  classifyVerdict,
  decideLinks,
  decodeLinkCandidates,
  LinkDecision,
  type LinkCandidate,
  type LinkDecisionRecord,
} from "../../src/links/decide";

/** Shape the provider receives after `DecisionModel` encodes the candidate. */
type DecodedState = {
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly sourceText: string;
  readonly existingAnchor?: string | null;
};

const probability = (value: number) => ({ _tag: "Probability" as const, probability: value });

/**
 * A `DecisionModel` backed by a lookup table, never the network. `make` runs the
 * same answer validation the live provider does, so a malformed mock fails like a
 * malformed provider response would.
 */
const mockDecisionModel = (
  answers: (state: DecodedState) => { readonly realReason: number; readonly anchorPresent: number },
  onDecide?: (state: DecodedState, decisionKeys: ReadonlyArray<string>) => void,
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.sync(() => {
          const decoded = state as unknown as DecodedState;
          onDecide?.(decoded, Object.keys(decisions));
          const { realReason, anchorPresent } = answers(decoded);
          return {
            answers: {
              realReason: probability(realReason),
              anchorPresent: probability(anchorPresent),
            },
            usage: { inputTokens: 12, outputTokens: 3 },
          };
        }),
    }),
  );

const record = (
  sourceUrl: string,
  verdict: LinkDecisionRecord["verdict"],
): LinkDecisionRecord => ({
  sourceUrl,
  destinationUrl: `${sourceUrl}-target`,
  sourceText: `${sourceUrl} copy`,
  existingAnchor: null,
  realReason: 0.9,
  anchorPresent: 0.1,
  verdict,
});

describe("LinkDecision", () => {
  it("asks both decisions as probabilities over the candidate input", () => {
    expect(LinkDecision.decisions.realReason._tag).toBe("Probability");
    expect(LinkDecision.decisions.anchorPresent._tag).toBe("Probability");
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
      counts: { candidates: 4, recommend: 1, present: 1, skip: 1, review: 1 },
    });
    expect(report.resolved.map((entry) => entry.verdict)).toEqual(["recommend", "present", "skip"]);
    expect(report.review.map((entry) => entry.sourceUrl)).toEqual(["/d"]);
    // Every candidate appears exactly once across the two buckets.
    expect([...report.resolved, ...report.review]).toHaveLength(4);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
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
    expect(report.resolved.map((entry) => entry.verdict)).toEqual(["recommend", "present", "skip"]);
    expect(report.review).toEqual([
      {
        sourceUrl: "/d",
        destinationUrl: "/x",
        sourceText: "Ambiguous copy.",
        existingAnchor: null,
        realReason: 0.55,
        anchorPresent: 0.1,
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
      verdict: "recommend",
    });

    // One provider call per candidate, asking both decisions together.
    expect(states.map((state) => state.sourceUrl)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(decisionKeys).toEqual([
      ["realReason", "anchorPresent"],
      ["realReason", "anchorPresent"],
      ["realReason", "anchorPresent"],
      ["realReason", "anchorPresent"],
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

    expect(JSON.parse(JSON.stringify(report))).toEqual({
      kind: "links-decide",
      schemaVersion: 1,
      model: "jev-latest",
      threshold: 0.7,
      counts: { candidates: 4, recommend: 1, present: 1, skip: 1, review: 1 },
      resolved: [
        {
          sourceUrl: "/a",
          destinationUrl: "/pricing",
          sourceText: "Pricing is simple.",
          existingAnchor: null,
          realReason: 0.92,
          anchorPresent: 0.08,
          verdict: "recommend",
        },
        {
          sourceUrl: "/b",
          destinationUrl: "/docs",
          sourceText: "Read the docs.",
          existingAnchor: "docs",
          realReason: 0.88,
          anchorPresent: 0.9,
          verdict: "present",
        },
        {
          sourceUrl: "/c",
          destinationUrl: "/blog",
          sourceText: "A passing mention.",
          existingAnchor: null,
          realReason: 0.05,
          anchorPresent: 0.1,
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
          verdict: "review",
        },
      ],
    });
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
