import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DecisionModel } from "effect/unstable/ai";
import { afterAll, describe, expect, it } from "vitest";

import { decideLinks, type LinkCandidate } from "../../src/links/decide";

const probability = (value: number) => ({ _tag: "Probability" as const, probability: value });

const candidates: ReadonlyArray<LinkCandidate> = [
  { sourceUrl: "/a", destinationUrl: "/b", sourceText: "copy" },
];

/** A model whose answers depend on state, counting every provider call. */
const countingModel = (
  answers: (sourceUrl: string) => { readonly realReason: number; readonly anchorPresent: number },
  counter: { calls: number },
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.sync(() => {
          counter.calls += 1;
          const { sourceUrl } = state as unknown as { sourceUrl: string };
          const { realReason, anchorPresent } = answers(sourceUrl);
          return {
            answers: Object.fromEntries(
              Object.keys(decisions).map((key) => {
                const value = key === "realReason" ? realReason : anchorPresent;
                return [key, probability(value)];
              }),
            ),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }),
    }),
  );

const temporaryDirectories: Array<string> = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-links-cache-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("decideLinks cache", () => {
  it("reuses answers for the same model and calls the provider for another", async () => {
    const cacheDir = temporaryDirectory();
    const first = { calls: 0 };
    const firstReport = await Effect.runPromise(
      decideLinks(candidates, { model: "jev-latest", threshold: 0.7, cacheDir }).pipe(
        Effect.provide(countingModel(() => ({ realReason: 0.9, anchorPresent: 0.1 }), first)),
      ),
    );
    expect(first.calls).toBe(1);
    expect(firstReport.counts.recommend).toBe(1);

    // Same model and input: a warm cache skips the provider entirely.
    const cached = { calls: 0 };
    const cachedReport = await Effect.runPromise(
      decideLinks(candidates, { model: "jev-latest", threshold: 0.7, cacheDir }).pipe(
        Effect.provide(countingModel(() => ({ realReason: 0.1, anchorPresent: 0.1 }), cached)),
      ),
    );
    expect(cached.calls).toBe(0);
    expect(cachedReport.counts.recommend).toBe(1);

    // A different model must not reuse the other model's answers.
    const other = { calls: 0 };
    const otherReport = await Effect.runPromise(
      decideLinks(candidates, { model: "jev-preview", threshold: 0.7, cacheDir }).pipe(
        Effect.provide(countingModel(() => ({ realReason: 0.1, anchorPresent: 0.1 }), other)),
      ),
    );
    expect(other.calls).toBe(1);
    expect(otherReport.counts.skip).toBe(1);
  });
});
