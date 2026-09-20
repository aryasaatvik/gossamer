import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Decision, DecisionModel } from "effect/unstable/ai";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildDecisionReport,
  decodeFamilyInputs,
  inputHash,
  runDecisions,
  type DecisionFamily,
} from "../../src/decide/run";

interface FakeInput {
  readonly id: string;
  readonly okay: boolean;
}

const FakeInput = Schema.Struct({ id: Schema.String, okay: Schema.Boolean });

/** A minimal family: one probability mapped to accept/reject/review. */
const fakeFamily: DecisionFamily<FakeInput> = {
  name: "fake",
  input: FakeInput,
  definitionFor: () =>
    Decision.make({
      input: FakeInput,
      decisions: {
        okay: Decision.probability({
          instructions: "The input is okay",
          criteria: { false: "not okay", true: "okay" },
        }),
      },
    }),
  inputRef: (input) => input.id,
  evaluate: (_input, answers, threshold) => {
    const probability = (answers as { okay: { probability: number } }).okay.probability;
    if (probability >= threshold) return "accept";
    if (probability <= 1 - threshold) return "reject";
    return "review";
  },
};

const probability = (value: number) => ({ _tag: "Probability" as const, probability: value });

/** Deterministic `DecisionModel` backed by a lookup; never the network. */
const mockModel = (
  answers: (state: FakeInput) => number,
  onDecide?: (state: FakeInput) => void,
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.sync(() => {
          const decoded = state as unknown as FakeInput;
          onDecide?.(decoded);
          return {
            answers: Object.fromEntries(
              Object.keys(decisions).map((key) => [key, probability(answers(decoded))]),
            ),
            usage: { inputTokens: 12, outputTokens: 3 },
          };
        }),
    }),
  );

const temporaryDirectories: Array<string> = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-decide-run-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const inputs: ReadonlyArray<FakeInput> = [
  { id: "a", okay: true },
  { id: "b", okay: false },
  { id: "c", okay: false },
];

const values: Record<string, number> = { a: 0.92, b: 0.05, c: 0.55 };

describe("inputHash", () => {
  it("is stable for equal values and differs for different ones", () => {
    expect(inputHash({ a: 1 })).toBe(inputHash({ a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
    expect(inputHash("x")).toHaveLength(64);
  });
});

describe("buildDecisionReport", () => {
  it("buckets review records apart and counts verdicts", () => {
    const base = {
      schemaVersion: 1 as const,
      family: "fake",
      model: "mock",
      threshold: 0.7,
      inputHash: "h",
      inputRef: "ref",
      answers: {},
    };
    const report = buildDecisionReport({
      family: "fake",
      model: "mock",
      threshold: 0.7,
      records: [
        { ...base, decisionId: "fake:0", verdict: "accept", review: false },
        { ...base, decisionId: "fake:1", verdict: "reject", review: false },
        { ...base, decisionId: "fake:2", verdict: "review", review: true },
      ],
    });

    expect(report).toMatchObject({
      kind: "decide",
      schemaVersion: 1,
      family: "fake",
      counts: { inputs: 3, resolved: 2, review: 1 },
      verdicts: { accept: 1, reject: 1, review: 1 },
    });
    expect(report.resolved.map((record) => record.decisionId)).toEqual(["fake:0", "fake:1"]);
    expect(report.review.map((record) => record.decisionId)).toEqual(["fake:2"]);
  });
});

describe("decodeFamilyInputs", () => {
  it("decodes valid inputs and rejects invalid ones", () => {
    expect(decodeFamilyInputs(fakeFamily, [{ id: "a", okay: true }])).toEqual([
      { id: "a", okay: true },
    ]);
    expect(() => decodeFamilyInputs(fakeFamily, [{ id: "a" }])).toThrow();
    expect(() => decodeFamilyInputs(fakeFamily, [{ id: 1, okay: true }])).toThrow();
  });
});

describe("runDecisions", () => {
  it("answers every input and routes the review band to review", async () => {
    const seen: Array<string> = [];
    const layer = mockModel((state) => values[state.id]!, (state) => seen.push(state.id));

    const report = await Effect.runPromise(
      runDecisions({ family: fakeFamily, inputs, model: "mock", threshold: 0.7, concurrency: 1 }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(report.counts).toEqual({ inputs: 3, resolved: 2, review: 1 });
    expect(report.verdicts).toEqual({ accept: 1, reject: 1, review: 1 });
    expect(report.resolved.map((record) => record.inputRef)).toEqual(["a", "b"]);
    expect(report.review.map((record) => record.inputRef)).toEqual(["c"]);
    expect(report.review[0]?.review).toBe(true);
    expect(report.review[0]?.answers).toEqual({ okay: { probability: 0.55 } });
    expect(report.review[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("reuses cached answers without calling the provider", async () => {
    const cacheDir = temporaryDirectory();
    const first = await Effect.runPromise(
      runDecisions({
        family: fakeFamily,
        inputs,
        model: "mock",
        threshold: 0.7,
        concurrency: 1,
        cacheDir,
      }).pipe(Effect.provide(mockModel((state) => values[state.id]!))),
    );

    // A layer that would flip every verdict if it were consulted.
    const second = await Effect.runPromise(
      runDecisions({
        family: fakeFamily,
        inputs,
        model: "mock",
        threshold: 0.7,
        concurrency: 1,
        cacheDir,
      }).pipe(Effect.provide(mockModel(() => 0.99))),
    );

    expect(second.verdicts).toEqual(first.verdicts);
    expect(second.resolved.map((record) => record.answers)).toEqual(
      first.resolved.map((record) => record.answers),
    );
    expect(second.review.map((record) => record.verdict)).toEqual(
      first.review.map((record) => record.verdict),
    );
    // Cached records carry no provider usage — the call never happened.
    expect(second.resolved.every((record) => record.usage === undefined)).toBe(true);
  });

  it("returns an empty report for no inputs", async () => {
    const report = await Effect.runPromise(
      runDecisions({ family: fakeFamily, inputs: [], model: "mock", threshold: 0.7 }).pipe(
        Effect.provide(mockModel(() => 0.9)),
      ),
    );
    expect(report.counts).toEqual({ inputs: 0, resolved: 0, review: 0 });
    expect(report.verdicts).toEqual({});
    expect(report.resolved).toEqual([]);
    expect(report.review).toEqual([]);
  });
});
