import { describe, expect, it } from "vitest";
import { decodeLinksSuggestionReport, extractPageSentences, rankLinkSuggestions, selectSuggestionPages } from "../../src/core/link-suggestions";

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
    expect(suggestion.anchor).toBe("delivery retries and message tracking");
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

  it("ignores hidden copy and text inside an existing link", () => {
    const visible = "Our transactional email guide explains delivery retries and message tracking for teams.";
    const html = `<main><div hidden><div>Hidden transactional delivery retries.</div>Hidden message tracking copy.</div><p style="display:none">Hidden message tracking copy.</p><template>Template delivery retries copy.</template><p>${visible}</p><p>Read <a href="/other">delivery retries and message tracking</a> for another topic.</p></main>`;
    const extracted = extractPageSentences(html);
    expect(extracted).toContain(visible);
    expect(extracted.join(" ")).not.toContain("Hidden");
    expect(extracted.join(" ")).not.toContain("Template");
    expect(extracted.join(" ")).not.toContain("delivery retries and message tracking for another");
  });

  it("ignores a main-tag example inside script and reads the visible article", () => {
    const copy = "This article explains delivery retries and message tracking for transactional email teams.";
    expect(extractPageSentences(`<script>const example = "<main>fake";</script><article><p>${copy}</p></article>`)).toEqual([copy]);
  });

  it("excludes code and both table forms from editorial sentences", () => {
    const copy = "Delivery retries and message tracking help teams diagnose failed messages.";
    const html = `<main><p>${copy}</p><pre><code>subject: "Your order shipped"; delivery retries and message tracking</code></pre>
      <table><tr><th>Capability</th><td>Samva</td><td>Delivery events signed with HMAC-SHA256.</td></tr></table>
      <dl><div><dt>Webhooks</dt><dd><p>Delivery events signed with HMAC-SHA256.</p></dd></div></dl>
      <div role="table"><div role="row">Delivery events signed with HMAC-SHA256.</div></div></main>`;
    expect(extractPageSentences(html)).toEqual([copy]);
    expect(extractPageSentences(`<main><p>Our delivery retries <code>send()</code> and message tracking help teams.</p></main>`).join(" "))
      .not.toContain("Our delivery retries and message tracking");
  });

  it("requires two distinct anchor terms together in one target passage", () => {
    const source = "The applicable account controls can be used after the service ends.";
    const target = "Your account lets you review account activity for the service.";
    expect(rankLinkSuggestions([pair], [{ path: pair.source, sentences: [source] },
      { path: pair.destination, sentences: [target] }], new Map(), 10).total).toBe(0);
    expect(rankLinkSuggestions([pair], [{ path: pair.source, sentences: ["Delivery retries help teams. Message tracking shows results."] },
      { path: pair.destination, sentences: ["Delivery teams can retry failed sends.", "Operators track message history."] }], new Map(), 10).total).toBe(0);
  });

  it("rejects repeated copy and anchors that do not describe a named destination", () => {
    const repeated = "Samva keeps per-message delivery timelines in the dashboard on every plan.";
    const comparison = { source: "/compare/sendgrid", destination: "/compare/mailgun", cluster: "compare", reason: "same section" };
    expect(rankLinkSuggestions([comparison], [{ path: comparison.source, sentences: [repeated] },
      { path: comparison.destination, sentences: [repeated] }], new Map(), 10).total).toBe(0);
    const shortRepeat = "Pricing verified September 19, 2026.";
    expect(rankLinkSuggestions([comparison], [{ path: comparison.source, sentences: [shortRepeat] },
      { path: comparison.destination, sentences: [shortRepeat] }], new Map(), 10).total).toBe(0);

    const generic = "Teams send from many languages with official libraries.";
    const named = { ...comparison, destination: "/compare/postmark" };
    const target = ["Postmark separates transactional and broadcast message streams.", generic];
    expect(rankLinkSuggestions([named], [{ path: named.source, sentences: [generic] },
      { path: named.destination, sentences: target }], new Map(), 10).total).toBe(0);
    const specific = "Postmark transactional streams keep broadcasts separate for teams.";
    expect(rankLinkSuggestions([named], [{ path: named.source, sentences: [specific] },
      { path: named.destination, sentences: target }], new Map(), 10).candidates[0]?.anchor).toContain("Postmark");
    const sendGrid = { ...comparison, source: "/compare/postmark", destination: "/compare/sendgrid" };
    expect(rankLinkSuggestions([sendGrid], [{ path: sendGrid.source, sentences: [generic] },
      { path: sendGrid.destination, sentences: ["SendGrid supports many languages with official libraries."] }], new Map(), 10).total).toBe(0);
  });

  it("does not use legal clause fragments or unfinished list items", () => {
    const legal = "Customer will not submit payment-card data unless Arya Labs has separately approved that processing in writing.";
    const target = "Do not submit payment-card data unless Arya Labs has approved that use in a separate written agreement.";
    const policy = { source: "/legal/privacy", destination: "/legal/dpa", cluster: "legal", reason: "same section" };
    expect(rankLinkSuggestions([policy], [{ path: policy.source, sentences: [legal] },
      { path: policy.destination, sentences: [target] }], new Map(), 10).total).toBe(0);
    const cookies = { ...policy, source: "/legal/sla", destination: "/legal/cookies" };
    expect(rankLinkSuggestions([cookies], [{ path: cookies.source, sentences: ["This SLA applies to each account using Samva Services."] },
      { path: cookies.destination, sentences: ["Samva links product usage to a user account under a separate permission."] }], new Map(), 10).total).toBe(0);
    const home = { ...policy, source: "/contact", destination: "/" };
    expect(rankLinkSuggestions([home], [{ path: home.source, sentences: ["Preparing security verification."] },
      { path: home.destination, sentences: ["Preparing security verification."] }], new Map(), 10).total).toBe(0);
    expect(extractPageSentences("<main><li>use the Services for protected health information; or</li></main>")).toEqual([]);
  });

  it("selects a bounded explicit pair from a large declared graph", () => {
    const paths = [...Array.from({ length: 2000 }, (_, index) => `/blog/a${index}`), "/blog/guide", "/blog/retries"];
    const node = (path: string) => ({ path, kind: "article", source: "blog" as const,
      policy: { kind: "article", sitemap: { priority: 0.5, changeFrequency: "monthly" as const } } });
    const graph = { nodes: new Map(paths.map((path) => [path, node(path)])), edges: [] };
    expect(selectSuggestionPages(graph, { pageLimit: 2, sources: new Set(["/blog/guide"]), targets: new Set(["/blog/retries"]), clusters: [], renderedEdges: [] }).map((page) => page.path)).toEqual(["/blog/guide", "/blog/retries"]);
    expect(() => selectSuggestionPages(graph, { pageLimit: 2, sources: new Set(), targets: new Set(["/blog/guide", "/blog/retries"]), clusters: [], renderedEdges: [] })).toThrow("leave room");
    const lateSource = `/blog/a1999`;
    expect(selectSuggestionPages(graph, { pageLimit: 2, sources: new Set([lateSource]), targets: new Set(["/blog/retries"]), clusters: [], renderedEdges: [] }).map((page) => page.path)).toEqual([lateSource, "/blog/retries"]);
    expect(selectSuggestionPages(graph, { pageLimit: 2, sources: new Set([lateSource]), targets: new Set(), clusters: [], renderedEdges: [] }).map((page) => page.path)).toEqual(["/blog/a0", lateSource]);
  });

  it("selects a late explicit source without scanning unrelated sections", () => {
    const paths = [...Array.from({ length: 2000 }, (_, index) => `/early/p${index}`), "/late/source", "/late/target"];
    const node = (path: string) => ({ path, kind: "article", source: "blog" as const,
      policy: { kind: "article", sitemap: { priority: 0.5, changeFrequency: "monthly" as const } } });
    const graph = { nodes: new Map(paths.map((path) => [path, node(path)])), edges: [] };
    expect(selectSuggestionPages(graph, { pageLimit: 2, sources: new Set(["/late/source"]), targets: new Set(), clusters: [], renderedEdges: [] }).map((page) => page.path)).toEqual(["/late/source", "/late/target"]);
  });

  it("does not spend the direction budget on unrelated requested sources", () => {
    const paths = ["/early/source", ...Array.from({ length: 200 }, (_, index) => `/early/p${index}`), "/late/source", "/late/target"];
    const node = (path: string) => ({ path, kind: "article", source: "blog" as const,
      policy: { kind: "article", sitemap: { priority: 0.5, changeFrequency: "monthly" as const } } });
    const graph = { nodes: new Map(paths.map((path) => [path, node(path)])), edges: [] };
    expect(selectSuggestionPages(graph, { pageLimit: 3, sources: new Set(["/early/source", "/late/source"]), targets: new Set(), clusters: ["late"], renderedEdges: [] }).map((page) => page.path))
      .toEqual(["/early/source", "/late/source", "/late/target"]);
  });

  it("rejects malformed, wrong-origin, and nonverbatim artifacts", () => {
    const candidate = rankLinkSuggestions([pair], [
      { path: pair.source, sentences: [sentence] }, { path: pair.destination, sentences: [targetSentence] },
    ], new Map(), 1).candidates[0]!;
    const report = { kind: "links-candidates", schemaVersion: 2, origin: "https://example.com", limit: 1, pageLimit: 2, maxBodyBytes: 3_000_000, total: 1, truncated: false, skipped: [], candidates: [candidate] };
    expect(decodeLinksSuggestionReport(report, report.origin)).toEqual(report);
    const { maxBodyBytes: _missing, ...earlyVersionTwo } = report;
    expect(decodeLinksSuggestionReport(earlyVersionTwo, report.origin).maxBodyBytes).toBe(10_000_000);
    expect(() => decodeLinksSuggestionReport({ ...report, maxBodyBytes: 10_000_001 }, report.origin)).toThrow();
    expect(() => decodeLinksSuggestionReport(report, "https://other.example")).toThrow();
    expect(() => decodeLinksSuggestionReport({ ...report, candidates: [{ ...candidate, anchor: "invented" }] }, report.origin)).toThrow();
  });
});
