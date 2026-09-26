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
  /** Normalized final path of the seed page — the depth BFS root, even after a redirect. */
  readonly root: string;
  readonly pages: ReadonlyArray<RenderedPage>;
  readonly failures: ReadonlyArray<CrawlFailure>;
  /** URLs whose captured body hit `maxBodyBytes`; anchors past the cutoff are missing. */
  readonly truncatedBodies: ReadonlyArray<string>;
  /** True when discovery outran `limit` and pages were left unvisited. */
  readonly truncated: boolean;
  /** Discovery requests that failed or returned malformed data. */
  readonly discoveryFailures: ReadonlyArray<CrawlFailure>;
  /** URLs excluded by robots.txt; they were never requested as pages. */
  readonly skipped: ReadonlyArray<string>;
  /** True when a sitemap index or URL set exceeded the crawl's discovery budget. */
  readonly sitemapTruncated: boolean;
  /** Whether a usable sitemap contributed page URLs. */
  readonly sitemapUsed: boolean;
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
  /** Whether the captured body was cut at `maxBodyBytes`. */
  readonly bodyTruncated: boolean;
  readonly canonical: string | null;
}

const XML_LOC = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
const xmlText = (value: string): string => value.trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const robotsRules = (body: string): { readonly rules: ReadonlyArray<{ path: string; allow: boolean }>; readonly sitemaps: ReadonlyArray<string> } => {
  const rules: Array<{ path: string; allow: boolean }> = [];
  const sitemaps: Array<string> = [];
  let applies = false;
  let hasDirective = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (name === "sitemap") { sitemaps.push(value); continue; }
    if (name === "user-agent") {
      if (hasDirective) { applies = false; hasDirective = false; }
      if (value === "*") applies = true;
      continue;
    }
    if (name === "allow" || name === "disallow") {
      hasDirective = true;
      if (applies && value.startsWith("/")) rules.push({ path: value, allow: name === "allow" });
    }
  }
  return { rules, sitemaps };
};

const allowedByRobots = (path: string, rules: ReadonlyArray<{ path: string; allow: boolean }>): boolean => {
  let chosen: { path: string; allow: boolean } | undefined;
  for (const rule of rules) {
    if (path.startsWith(rule.path) && (chosen === undefined || rule.path.length >= chosen.path.length)) chosen = rule;
  }
  return chosen?.allow ?? true;
};

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
    sameOrigin: origin,
  };
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const visited = new Set<string>([pageKey(seedUrl)]);
  /** Final paths already rendered, so a redirect cannot add the same page twice. */
  const rendered = new Set<string>();
  const pages: Array<RenderedPage> = [];
  const failures: Array<CrawlFailure> = [];
  const truncatedBodies: Array<string> = [];
  const discoveryFailures: Array<CrawlFailure> = [];
  const skipped: Array<string> = [];
  let sitemapTruncated = false;
  let sitemapUsed = false;
  let attempts = 0;
  let truncated = false;
  let root = pageKey(seedUrl);
  let frontier: Array<QueueItem> = [{ url: seedUrl, depth: 0 }];

  const discoveryProbe = async (url: URL, kind: "robots" | "sitemap") =>
    probeHttp({ kind, method: "GET", accept: "text/plain, application/xml, text/xml", url }, {
      ...probeOptions, captureAnchors: false, captureBody: true,
    });
  const robots = await discoveryProbe(new URL("/robots.txt", origin), "robots");
  if (!robots.ok && robots.status !== 404) {
    discoveryFailures.push({ url: new URL("/robots.txt", origin).href, error: robots.error ?? `HTTP ${robots.status}` });
  }
  if (robots.bodyTruncated) discoveryFailures.push({ url: robots.requestedUrl, error: "robots.txt body truncated" });
  const policy = robots.ok && !robots.bodyTruncated ? robotsRules(robots.body ?? "") : { rules: [], sitemaps: [] };
  const permitted = (url: URL): boolean => {
    if (allowedByRobots(url.pathname, policy.rules)) return true;
    skipped.push(url.href);
    return false;
  };
  const sitemapUrls: Array<URL> = [];
  const sitemapQueue = (policy.sitemaps.length > 0 ? policy.sitemaps : [new URL("/sitemap.xml", origin).href])
    .flatMap((entry) => { try { return [new URL(entry, origin)]; } catch { return []; } });
  const seenSitemaps = new Set<string>();
  const seenSitemapPages = new Set<string>();
  while (sitemapQueue.length > 0) {
    const url = sitemapQueue.shift()!;
    if (url.origin !== origin || seenSitemaps.has(url.href) || !permitted(url)) continue;
    if (seenSitemaps.size >= Math.max(1, Math.min(options.limit, 16))) { sitemapTruncated = true; break; }
    seenSitemaps.add(url.href);
    const probe = await discoveryProbe(url, "sitemap");
    if (!probe.ok) {
      if (probe.status !== 404 || policy.sitemaps.length > 0) discoveryFailures.push({ url: url.href, error: probe.error ?? `HTTP ${probe.status}` });
      continue;
    }
    const body = probe.body ?? "";
    if (probe.bodyTruncated || !/<(?:urlset|sitemapindex)\b/i.test(body)) {
      discoveryFailures.push({ url: url.href, error: probe.bodyTruncated ? "sitemap body truncated" : "malformed sitemap" });
      continue;
    }
    sitemapUsed = true;
    const index = /<sitemapindex\b/i.test(body);
    const entries = [...body.matchAll(index ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi : /<url\b[^>]*>([\s\S]*?)<\/url>/gi)];
    for (const entry of entries) {
      XML_LOC.lastIndex = 0;
      const loc = XML_LOC.exec(entry[1] ?? "")?.[1];
      if (loc === undefined) continue;
      let target: URL;
      try { target = new URL(xmlText(loc), url); } catch { continue; }
      if (target.origin !== origin || !permitted(target)) continue;
      if (index) { sitemapQueue.push(target); continue; }
      if (NON_PAGE.test(target.pathname)) continue;
      const key = pageKey(target);
      if (seenSitemapPages.has(key)) continue;
      if (seenSitemapPages.size >= options.limit * 4) { sitemapTruncated = true; break; }
      seenSitemapPages.add(key);
      sitemapUrls.push(target);
    }
    if (sitemapTruncated) break;
  }
  if (!permitted(seedUrl)) frontier = [];

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
        bodyTruncated: false,
        canonical: null,
      };
    }
    if (!probe.responseHeaders["content-type"]?.includes("text/html")) {
      return {
        item, page: null,
        failure: { url: item.url.href, error: "Response is not HTML" },
        links: [], bodyTruncated: false, canonical: null,
      };
    }
    const finalUrl = new URL(probe.finalUrl);
    if (finalUrl.origin !== origin) {
      return {
        item,
        page: null,
        failure: { url: item.url.href, error: `Redirected off-origin to ${probe.finalUrl}` },
        links: [],
        bodyTruncated: false,
        canonical: null,
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
    return {
      item,
      page: { url: probe.finalUrl, anchors },
      failure: null,
      links,
      bodyTruncated: probe.bodyTruncated,
      canonical: probe.document?.canonicalUrl ?? null,
    };
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
      if (result.failure !== null) failures.push(result.failure);
      if (result.page === null) continue;
      let page = result.page;
      let finalKey = pageKey(new URL(page.url));
      if (result.canonical !== null) {
        try {
          const canonical = new URL(result.canonical, page.url);
          if (canonical.origin === origin) {
            finalKey = pageKey(canonical);
            page = { ...page, url: canonical.href };
          }
        } catch { /* Invalid canonical does not hide fetched HTML. */ }
      }
      // The seed's final path is the BFS root, even when the homepage redirected.
      if (result.item.depth === 0) root = finalKey;
      // A redirect can land on a page another request already rendered; keep one.
      if (rendered.has(finalKey)) continue;
      rendered.add(finalKey);
      visited.add(finalKey);
      pages.push(page);
      if (result.bodyTruncated) truncatedBodies.push(page.url);
      for (const link of result.links) {
        if (!permitted(link)) continue;
        const key = pageKey(link);
        if (visited.has(key)) continue;
        visited.add(key);
        discovered.push({ url: link, depth: result.item.depth + 1 });
      }
    }
    if (attempts === 1) {
      for (const url of sitemapUrls) {
        const key = pageKey(url);
        if (visited.has(key) || !permitted(url)) continue;
        visited.add(key);
        discovered.push({ url, depth: 1 });
      }
    }
    frontier = discovered;
  }

  return {
    origin,
    seed: seedUrl.href,
    root,
    pages,
    failures,
    truncatedBodies,
    truncated,
    discoveryFailures,
    skipped: [...new Set(skipped)],
    sitemapTruncated,
    sitemapUsed,
    limit: options.limit,
  };
};
