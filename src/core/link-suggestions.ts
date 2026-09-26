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
    if (section) sections.set(section, [...(sections.get(section) ?? []), node]);
    if (segments.length <= 1) rootKinds.set(node.kind, [...(rootKinds.get(node.kind) ?? []), node]);
  }
  const destinations = (options.targets.size === 0 ? eligible : eligible.filter((node) => options.targets.has(node.path)))
    .sort((a, b) => (inbound.get(a.path) ?? 0) - (inbound.get(b.path) ?? 0) || a.path.localeCompare(b.path));
  for (const destination of destinations) {
    if (selected.size >= options.pageLimit) break;
    const section = destination.path.split("/").filter(Boolean)[0];
    const sources = [...new Map([
      ...(section ? sections.get(section) ?? [] : []),
      ...(destination.path.split("/").filter(Boolean).length <= 1 ? rootKinds.get(destination.kind) ?? [] : []),
    ].map((node) => [node.path, node])).values()];
    for (const source of sources) {
      if (source.path === destination.path || (options.sources.size > 0 && !options.sources.has(source.path))) continue;
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
  const clean = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*(?:\shidden(?:\s|=|>)|\saria-hidden\s*=\s*["']?true|\sstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)))[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "\u0000");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(clean)?.[1]
    ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(clean)?.[1];
  if (main === undefined) return [];
  const blocks = main.replace(/<\/(?:p|li|h[1-6]|blockquote|section|div)>/gi, "\u0000")
    .replace(/<[^>]*>/g, " ");
  return decode(blocks).split("\u0000").flatMap((block) => block.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
    .map((part) => part.trim()).filter((part) => part.length >= 30 && part.length <= 500);
};

const stop = new Set("about after again also and are but can for from have into more most our over that the their them there these this those through with your what when where which while will would".split(" "));
const words = (value: string): ReadonlyArray<string> => (value.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])
  .filter((word) => !stop.has(word));

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
  const scored: Array<LinkSuggestion> = [];
  for (const pair of pairs) {
    const source = byPath.get(pair.source);
    const target = byPath.get(pair.destination);
    if (!source || !target) continue;
    const targetTerms = new Set(target.sentences.flatMap(words));
    let best: LinkSuggestion | undefined;
    for (const sentence of source.sentences) {
      const matching = [...new Set(words(sentence))].filter((term) => targetTerms.has(term));
      if (matching.length < 2) continue;
      const anchor = sentence.match(/\b(?:[A-Za-z][\w-]*\s+){0,3}[A-Za-z][\w-]*\b/g)
        ?.filter((phrase) => words(phrase).filter((term) => targetTerms.has(term)).length >= 2)
        .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
      if (!anchor || !sentence.includes(anchor)) continue;
      const anchorTerms = new Set(words(anchor));
      const targetSentence = target.sentences.find((candidate) => words(candidate).filter((term) => anchorTerms.has(term)).length >= 2);
      if (!targetSentence) continue;
      const topical = matching.length;
      const rarity = Math.round(matching.reduce((sum, term) => sum + 1 / (frequency.get(term) ?? 1), 0) * 100) / 100;
      const inboundNeed = Math.round(100 / (1 + (inbound.get(pair.destination) ?? 0))) / 100;
      const graph = pair.cluster.startsWith("kind:") ? 0.5 : 1;
      const scores = { topical, rarity, inboundNeed, graph };
      const score = Math.round((topical + rarity + inboundNeed + graph) * 100) / 100;
      const item: LinkSuggestion = { ...pair, sentence, anchor, targetSentence, score, scores,
        reason: `${pair.reason}; ${matching.join(", ")} connect the served passages` };
      if (!best || item.score > best.score || (item.score === best.score && item.sentence < best.sentence)) best = item;
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
  return report as LinksSuggestionReport;
};
