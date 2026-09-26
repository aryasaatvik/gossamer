import { describe, expect, it } from "vitest";
import { decodeLinksSuggestionReport, extractPageSentences, rankLinkSuggestions } from "../../src/core/link-suggestions";

const sentence = "Our transactional email guide explains delivery retries and message tracking for product teams.";
const targetSentence = "Delivery retries and message tracking keep transactional email reliable at scale.";
const pair = { source: "/blog/guide", destination: "/blog/retries", cluster: "blog", reason: "same section" };

describe("content-backed link suggestions", () => {
  it("chooses served main copy with a contiguous verbatim anchor and deterministic scores", () => {
    const extracted = extractPageSentences(`<nav>Delivery retries and message tracking.</nav><main><p>${sentence}</p></main>`);
    expect(extracted).toContain(sentence);
    const pages = [{ path: pair.source, sentences: extracted }, { path: pair.destination, sentences: [targetSentence] }];
    const first = rankLinkSuggestions([pair], pages, new Map(), 10);
    expect(first).toEqual(rankLinkSuggestions([pair], pages, new Map(), 10));
    expect(first.candidates).toHaveLength(1);
    const suggestion = first.candidates[0]!;
    expect(suggestion.sentence).toBe(sentence);
    expect(sentence).toContain(suggestion.anchor);
    expect(suggestion.targetSentence).toBe(targetSentence);
    expect(suggestion.scores.inboundNeed).toBe(1);
    expect(rankLinkSuggestions([pair], pages, new Map([[pair.destination, 3]]), 10).candidates[0]!.score).toBeLessThan(suggestion.score);
  });

  it("excludes unrelated and unplaceable pages, and bounds the output", () => {
    const pages = [
      { path: pair.source, sentences: [sentence] },
      { path: pair.destination, sentences: ["Our pricing details show annual subscriptions and billing terms for organizations."] },
    ];
    expect(rankLinkSuggestions([pair], pages, new Map(), 10).total).toBe(0);
    expect(rankLinkSuggestions([pair], pages.slice(0, 1), new Map(), 10).total).toBe(0);
    pages[1] = { path: pair.destination, sentences: [targetSentence] };
    expect(rankLinkSuggestions([pair], pages, new Map(), 0)).toEqual({ candidates: [], total: 1 });
  });

  it("does not join separate blocks into a fabricated sentence", () => {
    const first = "The guide explains transactional delivery retries for teams";
    const second = "Message tracking gives operators a clear record of every attempt.";
    expect(extractPageSentences(`<main><p>${first}</p><p>${second}</p></main>`)).toEqual([first, second]);
  });

  it("rejects malformed, wrong-origin, and nonverbatim artifacts", () => {
    const candidate = rankLinkSuggestions([pair], [
      { path: pair.source, sentences: [sentence] }, { path: pair.destination, sentences: [targetSentence] },
    ], new Map(), 1).candidates[0]!;
    const report = { kind: "links-candidates", schemaVersion: 2, origin: "https://example.com", limit: 1, pageLimit: 2, total: 1, truncated: false, skipped: [], candidates: [candidate] };
    expect(decodeLinksSuggestionReport(report, report.origin)).toEqual(report);
    expect(() => decodeLinksSuggestionReport(report, "https://other.example")).toThrow();
    expect(() => decodeLinksSuggestionReport({ ...report, candidates: [{ ...candidate, anchor: "invented" }] }, report.origin)).toThrow();
  });
});
