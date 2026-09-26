import { candidateClusterOf, matchesClusterFilter, type LinkCandidatePair } from "./link-candidates";
import type { SeoGraph, SeoNode } from "./graph";
import type { AnchorRegion, SimpleEdge } from "./links";
import { isSitemapEligible } from "./projections";

export interface PageContent {
  readonly path: string;
  readonly sentences: ReadonlyArray<string>;
}

export interface LinkSuggestion extends LinkCandidatePair {
  readonly sentence: string;
  readonly anchor: string;
  readonly targetSentence: string;
  readonly score: number;
  readonly scores: { readonly topical: number; readonly rarity: number; readonly inboundNeed: number; readonly graph: number };
}

export interface LinksSuggestionReport {
  readonly kind: "links-candidates";
  readonly schemaVersion: 2;
  readonly origin: string;
  readonly limit: number;
  readonly pageLimit: number;
  readonly maxBodyBytes: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly candidates: ReadonlyArray<LinkSuggestion>;
}

/** Select pages around low-inbound directions without materializing the full pair universe. */
export const selectSuggestionPages = (
  graph: SeoGraph,
  options: {
    readonly pageLimit: number;
    readonly targets: ReadonlySet<string>;
    readonly sources: ReadonlySet<string>;
    readonly clusters: ReadonlyArray<string>;
    readonly renderedEdges: ReadonlyArray<SimpleEdge & { readonly region?: AnchorRegion }>;
  },
): ReadonlyArray<SeoNode> => {
  const eligible = [...graph.nodes.values()].filter(isSitemapEligible).sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(eligible.map((node) => [node.path, node]));
  for (const path of [...options.targets, ...options.sources]) {
    if (!byPath.has(path)) throw new Error(`Requested page is not a sitemap-eligible graph path: ${path}`);
  }
  const selected = new Set([...options.targets, ...options.sources]);
  if (selected.size > options.pageLimit || (options.targets.size > 0 && options.sources.size === 0 && options.targets.size >= options.pageLimit)) {
    throw new Error("--page-limit must leave room for a candidate source beyond requested targets");
  }
  const normalized = (path: string): string => path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "") || "/";
  const key = (source: string, destination: string): string => `${normalized(source)}\u0000${normalized(destination)}`;
  const excluded = new Set([
    ...graph.edges.filter((edge) => edge.type === "related").map((edge) => key(edge.from, edge.to)),
    ...options.renderedEdges.filter((edge) => edge.region === undefined || edge.region === "body").map((edge) => key(edge.from, edge.to)),
  ]);
  const inbound = new Map<string, number>();
  for (const edge of graph.edges) if (edge.type === "related") inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  const sections = new Map<string, Array<SeoNode>>();
  const rootKinds = new Map<string, Array<SeoNode>>();
  for (const node of eligible) {
    const segments = node.path.split("/").filter(Boolean);
    const section = segments[0];
    if (section) {
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section)!.push(node);
    }
    if (segments.length <= 1) {
      if (!rootKinds.has(node.kind)) rootKinds.set(node.kind, []);
      rootKinds.get(node.kind)!.push(node);
    }
  }
  const requestedSources = eligible.filter((node) => options.sources.has(node.path));
  const requestedSections = new Map<string, Array<SeoNode>>();
  const requestedRootKinds = new Map<string, Array<SeoNode>>();
  const relevant = new Map<string, SeoNode>();
  for (const source of requestedSources) {
    const segments = source.path.split("/").filter(Boolean);
    const section = segments[0];
    if (section) {
      if (!requestedSections.has(section)) requestedSections.set(section, []);
      requestedSections.get(section)!.push(source);
      for (const node of sections.get(section) ?? []) relevant.set(node.path, node);
    }
    if (segments.length <= 1) {
      if (!requestedRootKinds.has(source.kind)) requestedRootKinds.set(source.kind, []);
      requestedRootKinds.get(source.kind)!.push(source);
      for (const node of rootKinds.get(source.kind) ?? []) relevant.set(node.path, node);
    }
  }
  const relevantDestinations = options.sources.size === 0 ? eligible : [...relevant.values()];
  const destinations = (options.targets.size === 0 ? relevantDestinations : relevantDestinations.filter((node) => options.targets.has(node.path)))
    .sort((a, b) => (inbound.get(a.path) ?? 0) - (inbound.get(b.path) ?? 0) || a.path.localeCompare(b.path));
  const directionBudget = Math.max(100, options.pageLimit * 100);
  let examined = 0;
  for (const destination of destinations) {
    if (selected.size >= options.pageLimit || examined >= directionBudget) break;
    const segments = destination.path.split("/").filter(Boolean);
    const section = segments[0];
    const sources = [...new Map([
      ...(section ? (options.sources.size > 0 ? requestedSections : sections).get(section) ?? [] : []),
      ...(segments.length <= 1 ? (options.sources.size > 0 ? requestedRootKinds : rootKinds).get(destination.kind) ?? [] : []),
    ].map((node) => [node.path, node])).values()];
    for (const source of sources) {
      if (source.path === destination.path) continue;
      if (++examined > directionBudget) break;
      const cluster = candidateClusterOf(source, destination);
      if (!cluster || (options.clusters.length > 0 && !options.clusters.some((filter) => matchesClusterFilter(cluster.key, filter)))
        || excluded.has(key(source.path, destination.path))) continue;
      const needed = Number(!selected.has(source.path)) + Number(!selected.has(destination.path));
      if (selected.size + needed > options.pageLimit) continue;
      selected.add(source.path); selected.add(destination.path);
      if (selected.size >= options.pageLimit) break;
    }
  }
  return eligible.filter((node) => selected.has(node.path));
};

const decode = (text: string): string => text
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

/** Restrict placements to visible main/article copy, ignoring site chrome and scripts. */
export const extractPageSentences = (html: string): ReadonlyArray<string> => {
  const visibleHtml = html.replace(/<(script|style|noscript|svg|nav|header|footer|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const containerHtml = visibleHtml.replace(/<(pre|code|table|dl)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const container = /<main\b/i.test(containerHtml) ? "main" : "article";
  if (!new RegExp(`<${container}\\b`, "i").test(containerHtml)) return [];
  const suppressedTags = new Set(["script", "style", "noscript", "svg", "nav", "header", "footer", "template", "a", "pre", "code", "table", "dl", "kbd", "samp"]);
  const blockTags = new Set(["p", "li", "blockquote", "section", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack: Array<{ name: string; suppressed: boolean }> = [];
  const blocks: Array<string> = [];
  let current = "";
  let inside = 0;
  const flush = () => { if (current.trim()) blocks.push(current); current = ""; };
  for (const token of visibleHtml.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) {
      if (inside > 0 && !stack.some((entry) => entry.suppressed)) current += token;
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)\b([^>]*)>/i.exec(token);
    if (!tag) continue;
    const name = tag[2]!.toLowerCase();
    if (tag[1] === "/") {
      if (name === container && inside > 0) inside--;
      const at = stack.findLastIndex((entry) => entry.name === name);
      if (blockTags.has(name) || suppressedTags.has(name) || name === container || (at >= 0 && stack[at]!.suppressed)) flush();
      if (at >= 0) stack.splice(at);
      continue;
    }
    const attrs = tag[3] ?? "";
    const hidden = /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)
      || /\baria-hidden\s*=\s*(?:"true"|'true'|true)(?:\s|$)/i.test(attrs)
      || /\bstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')/i.test(attrs);
    const suppressed = hidden || suppressedTags.has(name) || /\brole\s*=\s*(?:"(?:table|grid)"|'(?:table|grid)'|(?:table|grid))(?:\s|$)/i.test(attrs);
    if (name === container) { flush(); inside++; }
    if (suppressed || blockTags.has(name)) flush();
    if (!voidTags.has(name) && !/\/\s*>$/.test(token)) stack.push({ name, suppressed });
  }
  flush();
  return blocks.flatMap((block) => decode(block).replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
    .map((part) => part.trim()).filter((part) => part.length >= 30 && part.length <= 500 && !/;\s*(?:or|and)?$/i.test(part));
};

const stop = new Set("a an as at about after again also and are but by can for from had has have in into is it more most of on or our over that the their them there these this those through to was we were with your you what when where which while will would".split(" "));
const words = (value: string): ReadonlyArray<string> => (value.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])
  .filter((word) => !stop.has(word));
const clauseBreaks = new Set(["unless", "because", "although", "whereas", "whether", "until", "however", "therefore", "otherwise"]);

const anchorPhrases = (sentence: string): ReadonlyArray<string> => {
  const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  const phrases: Array<string> = [];
  for (let start = 0; start < tokens.length; start++) {
    if (stop.has(tokens[start]!.text.toLowerCase()) || clauseBreaks.has(tokens[start]!.text.toLowerCase())) continue;
    if (new Set(words(tokens[start]!.text)).size >= 2) phrases.push(tokens[start]!.text);
    for (let end = start + 1; end < Math.min(tokens.length, start + 5); end++) {
      if (!/^\s+$/.test(sentence.slice(tokens[end - 1]!.end, tokens[end]!.start))) break;
      if (clauseBreaks.has(tokens[end]!.text.toLowerCase())) break;
      if (stop.has(tokens[end]!.text.toLowerCase())) continue;
      const phrase = sentence.slice(tokens[start]!.start, tokens[end]!.end);
      if (new Set(words(phrase)).size >= 2) phrases.push(phrase);
    }
  }
  return phrases;
};

/** Deterministic, content-grounded ranking; no placement is emitted without shared terms. */
export const rankLinkSuggestions = (
  pairs: ReadonlyArray<LinkCandidatePair>,
  pages: ReadonlyArray<PageContent>,
  inbound: ReadonlyMap<string, number>,
  limit: number,
): { readonly candidates: ReadonlyArray<LinkSuggestion>; readonly total: number } => {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const frequency = new Map<string, number>();
  for (const page of pages) {
    for (const term of new Set(page.sentences.flatMap(words))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const targetIndexes = new Map(pages.map((page) => {
    const passages = page.sentences.map((sentence) => ({ sentence, normalized: sentence.toLowerCase().replace(/\s+/g, " ").trim(), terms: new Set(words(sentence)) }));
    const byTerm = new Map<string, Array<number>>();
    passages.forEach((passage, index) => {
      for (const term of passage.terms) {
        if (!byTerm.has(term)) byTerm.set(term, []);
        byTerm.get(term)!.push(index);
      }
    });
    return [page.path, { passages, byTerm, terms: new Set(passages.flatMap((passage) => [...passage.terms])) }] as const;
  }));
  const scored: Array<LinkSuggestion> = [];
  for (const pair of pairs) {
    const source = byPath.get(pair.source);
    const target = byPath.get(pair.destination);
    const targetIndex = targetIndexes.get(pair.destination);
    if (!source || !target || !targetIndex || pair.destination === "/") continue;
    const destinationSegments = pair.destination.split("/").filter(Boolean);
    const destinationSlug = destinationSegments.at(-1) ?? "";
    const destinationTerms = words(destinationSlug.replace(/[-_]/g, " "));
    const namedSection = destinationSegments.length >= 2 && ["compare", "legal"].includes(destinationSegments[0]!);
    const namedDestination = destinationTerms.filter((term) => destinationSegments.length === 1 || namedSection || term.length <= 3
      || target.sentences.some((sentence) => [...sentence.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)]
        .some((match) => match[0].toLowerCase() === term)));
    let best: LinkSuggestion | undefined;
    for (const sentence of source.sentences) {
      const sourceTerms = new Set(words(sentence));
      const matching = [...sourceTerms].filter((term) => targetIndex.terms.has(term));
      if (matching.length < 2) continue;
      const normalizedSource = sentence.toLowerCase().replace(/\s+/g, " ").trim();
      for (const anchor of anchorPhrases(sentence)) {
        const anchorTerms = [...new Set(words(anchor))];
        if (namedDestination.length > 0 && !anchorTerms.some((term) => namedDestination.includes(term))) continue;
        const possible = anchorTerms.map((term) => targetIndex.byTerm.get(term) ?? []).sort((a, b) => a.length - b.length)[0] ?? [];
        const passageIndex = possible.find((index) => anchorTerms.every((term) => targetIndex.passages[index]!.terms.has(term)));
        if (passageIndex === undefined) continue;
        const passage = targetIndex.passages[passageIndex]!;
        if (normalizedSource === passage.normalized) continue;
        const overlap = [...sourceTerms].filter((term) => passage.terms.has(term)).length;
        if (overlap >= 6 && overlap / Math.min(sourceTerms.size, passage.terms.size) >= 0.7) continue;
        const topical = anchorTerms.length;
        const rarity = Math.round(anchorTerms.reduce((sum, term) => sum + 1 / (frequency.get(term) ?? 1), 0) * 100) / 100;
        const inboundNeed = Math.round(100 / (1 + (inbound.get(pair.destination) ?? 0))) / 100;
        const graph = pair.cluster.startsWith("kind:") ? 0.5 : 1;
        const scores = { topical, rarity, inboundNeed, graph };
        const score = Math.round((topical + rarity + inboundNeed + graph) * 100) / 100;
        const item: LinkSuggestion = { ...pair, sentence, anchor, targetSentence: passage.sentence, score, scores,
          reason: `${pair.reason}; ${anchorTerms.join(", ")} connect the served passages` };
        if (!best || item.score > best.score || (item.score === best.score && (item.anchor.length < best.anchor.length
          || (item.anchor.length === best.anchor.length && (item.sentence < best.sentence || (item.sentence === best.sentence && item.anchor < best.anchor)))))) best = item;
      }
    }
    if (best) scored.push(best);
  }
  scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination));
  return { candidates: scored.slice(0, limit), total: scored.length };
};

const pathValid = (value: unknown): value is string => typeof value === "string" && /^\/(?!\/)[^?#]*$/.test(value);

export const decodeLinksSuggestionReport = (value: unknown, origin: string): LinksSuggestionReport => {
  if (!value || typeof value !== "object") throw new Error("Suggestion report must be an object");
  const report = value as Partial<LinksSuggestionReport>;
  if (report.kind !== "links-candidates" || report.schemaVersion !== 2 || report.origin !== origin || !Array.isArray(report.candidates)) {
    throw new Error(`Expected schema-version-2 suggestions for ${origin}`);
  }
  if (!Number.isSafeInteger(report.limit) || report.limit! < 1 || !Number.isSafeInteger(report.pageLimit) || report.pageLimit! < 1
    || (report.maxBodyBytes !== undefined && (!Number.isSafeInteger(report.maxBodyBytes) || report.maxBodyBytes < 1 || report.maxBodyBytes > 10_000_000))
    || !Number.isSafeInteger(report.total) || report.total! < report.candidates.length
    || typeof report.truncated !== "boolean" || !Array.isArray(report.skipped)) throw new Error("Invalid suggestion report counts");
  const seen = new Set<string>();
  for (const candidate of report.candidates) {
    if (!pathValid(candidate.source) || !pathValid(candidate.destination) || candidate.source === candidate.destination
      || typeof candidate.cluster !== "string" || typeof candidate.sentence !== "string" || !candidate.sentence.trim()
      || typeof candidate.anchor !== "string" || !candidate.anchor.trim() || !candidate.sentence.includes(candidate.anchor)
      || typeof candidate.targetSentence !== "string" || !candidate.targetSentence.trim()
      || typeof candidate.reason !== "string" || typeof candidate.score !== "number" || !Number.isFinite(candidate.score)
      || !candidate.scores || [candidate.scores.topical, candidate.scores.rarity, candidate.scores.inboundNeed, candidate.scores.graph]
        .some((part) => typeof part !== "number" || !Number.isFinite(part))) {
      throw new Error("Malformed or ungrounded suggestion candidate");
    }
    const key = `${candidate.source}\u0000${candidate.destination}\u0000${candidate.anchor}`;
    if (seen.has(key)) throw new Error("Duplicate suggestion candidate");
    seen.add(key);
  }
  // Early version-2 artifacts did not carry the capture limit. Use the same
  // bounded maximum allowed by site mode so their verbatim passages can be rechecked.
  return { ...report, maxBodyBytes: report.maxBodyBytes ?? 10_000_000 } as LinksSuggestionReport;
};
