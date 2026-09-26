import type { LinkCandidatePair } from "./link-candidates";

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

const decode = (text: string): string => text
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

/** Restrict placements to visible main/article copy, ignoring site chrome and scripts. */
export const extractPageSentences = (html: string): ReadonlyArray<string> => {
  const clean = html.replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
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
