/**
 * Rendered link-graph crawl: fetch a site's served HTML through the audit's
 * hardened HTTP probe (DNS-pinned, private-IP-blocked) and collect the anchors
 * from each page. The crawl is breadth-first and bounded by `limit`.
 *
 * This module only does I/O and shape conversion; the graph model, homepage
 * depth, orphan set, and declared-vs-rendered diff are the pure functions in
 * `../core/links`. Per-page failures are data (one dead link does not abort the
 * crawl), so the caller can report coverage alongside the graph.
 */

import type { Anchor, RenderedPage } from "../core/links";
import { normalizePath } from "../core/links";
import type { ProbeOptions, ProbeRequest } from "./model";
import { probeHttp } from "./scanners/http";

export interface CrawlFailure {
  readonly url: string;
  readonly error: string;
}

export interface CrawlOptions {
  /** Maximum pages fetched, including the seed. Attempts count, not just successes. */
  readonly limit: number;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly allowPrivate: boolean;
  /** Parallel requests per breadth-first level. Defaults to 4. */
  readonly concurrency?: number | undefined;
}

export interface CrawlResult {
  readonly origin: string;
  readonly seed: string;
  readonly pages: ReadonlyArray<RenderedPage>;
  readonly failures: ReadonlyArray<CrawlFailure>;
  /** True when discovery outran `limit` and pages were left unvisited. */
  readonly truncated: boolean;
  readonly limit: number;
}

/** Anchors that are never HTML documents; skipped so they do not consume the budget. */
const NON_PAGE =
  /\.(?:avif|css|csv|gif|ico|jpe?g|js|json|map|mp4|pdf|png|rss|svg|txt|webm|webp|woff2?|xml|zip)$/i;

/** The graph keys pages by path, so dedupe crawled URLs the same way. */
const pageKey = (url: URL): string => normalizePath(url);

interface QueueItem {
  readonly url: URL;
  readonly depth: number;
}

interface ProbedPage {
  readonly item: QueueItem;
  readonly page: RenderedPage | null;
  readonly failure: CrawlFailure | null;
  readonly links: ReadonlyArray<URL>;
}

/** Run `run` over `items` with at most `limit` in flight, preserving order. */
const mapLimit = async <A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const results: Array<B | undefined> = Array.from({ length: items.length });
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await run(items[current]!);
    }
  });
  await Promise.all(workers);
  return results.map((result, at) => {
    if (result === undefined) throw new Error(`Crawl worker ${at} produced no result`);
    return result;
  });
};

/**
 * Crawl `seed`'s origin breadth-first and return one {@link RenderedPage} per
 * successfully fetched HTML page. The seed must be an absolute `http(s)` URL;
 * private and reserved destinations are rejected unless `allowPrivate` is set.
 */
export const crawlRenderedPages = async (
  seed: string,
  options: CrawlOptions,
): Promise<CrawlResult> => {
  let seedUrl: URL;
  try {
    seedUrl = new URL(seed);
  } catch {
    throw new Error(`Not a valid URL: ${seed}`);
  }
  if (seedUrl.protocol !== "https:" && seedUrl.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${seedUrl.protocol}`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error(`Crawl limit must be a positive integer: ${options.limit}`);
  }

  const origin = seedUrl.origin;
  const probeOptions: ProbeOptions = {
    allowPrivate: options.allowPrivate,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
    captureAnchors: true,
  };
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const visited = new Set<string>([pageKey(seedUrl)]);
  const pages: Array<RenderedPage> = [];
  const failures: Array<CrawlFailure> = [];
  let attempts = 0;
  let truncated = false;
  let frontier: Array<QueueItem> = [{ url: seedUrl, depth: 0 }];

  const probePage = async (item: QueueItem): Promise<ProbedPage> => {
    const request: ProbeRequest = {
      kind: "page-html",
      method: "GET",
      accept: "text/html, */*;q=0.1",
      url: item.url,
    };
    const probe = await probeHttp(request, probeOptions);
    if (!probe.ok || probe.finalUrl === null) {
      return {
        item,
        page: null,
        failure: {
          url: item.url.href,
          error: probe.error ?? `HTTP ${probe.status ?? "no response"}`,
        },
        links: [],
      };
    }
    const finalUrl = new URL(probe.finalUrl);
    if (finalUrl.origin !== origin) {
      return {
        item,
        page: null,
        failure: { url: item.url.href, error: `Redirected off-origin to ${probe.finalUrl}` },
        links: [],
      };
    }
    const anchors: ReadonlyArray<Anchor> = probe.anchors ?? [];
    const links = anchors.flatMap((anchor) => {
      if (!anchor.internal) return [];
      let target: URL;
      try {
        target = new URL(anchor.href);
      } catch {
        return [];
      }
      if (target.origin !== origin) return [];
      if (NON_PAGE.test(target.pathname)) return [];
      return [target];
    });
    return { item, page: { url: probe.finalUrl, anchors }, failure: null, links };
  };

  while (frontier.length > 0) {
    const remaining = options.limit - attempts;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const batch = frontier.length > remaining ? frontier.slice(0, remaining) : frontier;
    if (frontier.length > batch.length) truncated = true;
    frontier = [];
    attempts += batch.length;

    const probed = await mapLimit(batch, concurrency, probePage);
    const discovered: Array<QueueItem> = [];
    for (const result of probed) {
      if (result.page !== null) pages.push(result.page);
      if (result.failure !== null) failures.push(result.failure);
      if (result.page === null) continue;
      for (const link of result.links) {
        const key = pageKey(link);
        if (visited.has(key)) continue;
        visited.add(key);
        discovered.push({ url: link, depth: result.item.depth + 1 });
      }
    }
    frontier = discovered;
  }

  return { origin, seed: seedUrl.href, pages, failures, truncated, limit: options.limit };
};
