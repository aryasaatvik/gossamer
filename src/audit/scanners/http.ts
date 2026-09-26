import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { extractAnchors } from "../../core/links";
import type {
  DocumentSignals,
  HttpProbe,
  ProbeKind,
  ProbeOptions,
  ProbeRequest,
} from "../model";
import {
  networkHostname,
  pinnedLookup,
  resolveTargetUrl,
  type HostResolver,
} from "../network";
import { ScannerFailure, type Scanner, type ScannerInput } from "../scanner";

export class HttpProbeError extends Data.TaggedError("HttpProbeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const discoveryPaths: ReadonlyArray<{
  readonly kind: ProbeKind;
  readonly path: string;
  readonly accept: string;
}> = [
  { kind: "robots", path: "/robots.txt", accept: "text/plain, */*;q=0.1" },
  {
    kind: "sitemap",
    path: "/sitemap.xml",
    accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
  },
  {
    kind: "llms",
    path: "/llms.txt",
    accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
  },
];

const selectedHeaders = [
  "cache-control",
  "cf-cache-status",
  "content-language",
  "content-length",
  "content-signal",
  "content-type",
  "link",
  "server",
  "vary",
  "x-robots-tag",
] as const;

export const validateTargetUrl = async (
  url: URL,
  allowPrivate: boolean,
  resolve?: HostResolver,
): Promise<void> => {
  await resolveTargetUrl(url, allowPrivate, resolve);
};

export const buildProbeRequests = (
  targets: ReadonlyArray<URL>,
  extraDiscovery: ReadonlyArray<{
    readonly kind: ProbeKind;
    readonly path: string;
    readonly accept: string;
  }> = [],
): ReadonlyArray<ProbeRequest> => {
  const requests: Array<ProbeRequest> = [];
  const seenDiscoveryOrigins = new Set<string>();
  for (const target of targets) {
    requests.push(
      {
        kind: "page-head",
        method: "HEAD",
        accept: "text/html, */*;q=0.1",
        url: target,
      },
      {
        kind: "page-html",
        method: "GET",
        accept: "text/html, */*;q=0.1",
        url: target,
      },
      {
        kind: "page-markdown",
        method: "GET",
        accept: "text/markdown, text/plain;q=0.8, */*;q=0.1",
        url: target,
      },
    );
    if (seenDiscoveryOrigins.has(target.origin)) continue;
    seenDiscoveryOrigins.add(target.origin);
    for (const discovery of [...discoveryPaths, ...extraDiscovery]) {
      requests.push({
        kind: discovery.kind,
        method: "GET",
        accept: discovery.accept,
        url: new URL(discovery.path, target.origin),
      });
    }
  }
  return requests;
};

const responseHeaders = (
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const header of selectedHeaders) {
    const value = headers[header];
    if (value !== undefined)
      values[header] = Array.isArray(value) ? value.join(", ") : value;
  }
  return values;
};

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(
    `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
};

const metaContent = (
  html: string,
  key: "description" | "robots",
): string | null => {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attribute(tag, "name")?.toLowerCase() === key)
      return attribute(tag, "content");
  }
  return null;
};

const canonicalUrl = (html: string): string | null => {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (
      (attribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? []).includes(
        "canonical",
      )
    )
      return attribute(tag, "href");
  }
  return null;
};

const countMatches = (value: string, pattern: RegExp): number =>
  [...value.matchAll(pattern)].length;

export const extractDocumentSignals = (
  body: string,
  contentType: string,
  requestedUrl: URL,
): DocumentSignals => {
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  const isMarkdown = contentType.includes("text/markdown");
  const looksJson =
    contentType.includes("json") || requestedUrl.pathname.endsWith(".json");
  const titleMatch = isHtml
    ? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)
    : null;
  let jsonValid: boolean | null = null;
  if (looksJson && body.trim().length > 0) {
    try {
      JSON.parse(body);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }
  return {
    title: titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null,
    description: isHtml ? metaContent(body, "description") : null,
    canonicalUrl: isHtml ? canonicalUrl(body) : null,
    robots: isHtml ? metaContent(body, "robots") : null,
    jsonLdCount: isHtml
      ? countMatches(
          body,
          /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/gi,
        )
      : 0,
    modulePreloadCount: isHtml
      ? countMatches(
          body,
          /<link\b[^>]*rel\s*=\s*["'][^"']*modulepreload[^"']*["'][^>]*>/gi,
        )
      : 0,
    scriptCount: isHtml ? countMatches(body, /<script\b/gi) : 0,
    stylesheetCount: isHtml
      ? countMatches(
          body,
          /<link\b[^>]*rel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*>/gi,
        )
      : 0,
    wordCount: isMarkdown
      ? body.trim().split(/\s+/).filter(Boolean).length
      : null,
    jsonValid,
  };
};

const readBoundedBody = async (
  response: IncomingMessage,
  maxBodyBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  let truncated = false;
  for await (const chunk of response) {
    const value = new Uint8Array(chunk);
    const remaining = maxBodyBytes - length;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      length += Math.max(remaining, 0);
      truncated = true;
      response.destroy();
      break;
    }
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

const bodyExcerpt = (body: string, contentType: string): string | null => {
  if (contentType.includes("text/html") || body.length === 0) return null;
  return [...body]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .slice(0, 600);
};

const requestPinned = async (
  url: URL,
  request: ProbeRequest,
  options: ProbeOptions & { readonly resolve?: HostResolver },
): Promise<IncomingMessage> => {
  const addresses = await resolveTargetUrl(
    url,
    options.allowPrivate,
    options.resolve,
  );
  const transport = url.protocol === "https:" ? requestHttps : requestHttp;
  const hostname = networkHostname(url.hostname);
  return new Promise((resolve, reject) => {
    const outgoing = transport({
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: {
        accept: request.accept,
        host: url.host,
        "user-agent": "pagegraph/0.4 (+https://tanstack.com)",
      },
      agent: false,
      lookup: pinnedLookup(addresses),
      signal: AbortSignal.timeout(options.timeoutMs),
      ...(url.protocol === "https:"
        ? {
            servername: isIP(hostname) === 0 ? hostname : undefined,
            checkServerIdentity: (
              _host: string,
              certificate: Parameters<typeof checkServerIdentity>[1],
            ) => checkServerIdentity(hostname, certificate),
          }
        : undefined),
    });
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
};

export const probeHttp = async (
  request: ProbeRequest,
  options: ProbeOptions & { readonly resolve?: HostResolver },
): Promise<HttpProbe> => {
  const startedAt = performance.now();
  const redirects: Array<string> = [];
  let headersAt: number | null = null;
  try {
    let currentUrl = request.url;
    let response: IncomingMessage | null = null;
    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      if (options.sameOrigin !== undefined && currentUrl.origin !== options.sameOrigin) {
        throw new Error(`Redirected off-origin to ${currentUrl.href}`);
      }
      if (options.allowUrl !== undefined && !options.allowUrl(currentUrl)) {
        throw new Error(`Redirected to robots-disallowed URL ${currentUrl.href}`);
      }
      response = await requestPinned(currentUrl, request, options);
      headersAt = performance.now();
      const location = response.headers.location;
      const status = response.statusCode ?? 0;
      if (status < 300 || status >= 400 || location === undefined) break;
      if (redirectCount === 10) throw new Error("Redirect limit exceeded");
      response.destroy();
      currentUrl = new URL(location, currentUrl);
      redirects.push(currentUrl.href);
    }
    if (response === null)
      throw new Error("Request did not produce a response");
    const bounded =
      request.method === "HEAD"
        ? { bytes: new Uint8Array(), truncated: false }
        : await readBoundedBody(response, options.maxBodyBytes);
    const contentType =
      typeof response.headers["content-type"] === "string"
        ? response.headers["content-type"]
        : "";
    const body = new TextDecoder().decode(bounded.bytes);
    const anchors =
      options.captureAnchors === true && (contentType.includes("text/html") || contentType.includes("application/xhtml+xml"))
        ? extractAnchors(body, currentUrl.href)
        : undefined;
    return {
      kind: request.kind,
      method: request.method,
      accept: request.accept,
      requestedUrl: request.url.href,
      finalUrl: currentUrl.href,
      redirects,
      status: response.statusCode ?? null,
      ok:
        response.statusCode !== undefined &&
        response.statusCode >= 200 &&
        response.statusCode < 300,
      headersMs:
        headersAt === null
          ? null
          : Math.round((headersAt - startedAt) * 10) / 10,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      responseHeaders: responseHeaders(response.headers),
      capturedBodyBytes: bounded.bytes.byteLength,
      capturedBodySha256:
        bounded.bytes.byteLength === 0
          ? null
          : createHash("sha256").update(bounded.bytes).digest("hex"),
      bodyTruncated: bounded.truncated,
      bodyExcerpt: bodyExcerpt(body, contentType),
      ...(options.captureBody === true ? { body } : {}),
      document:
        body.length === 0
          ? null
          : extractDocumentSignals(body, contentType, currentUrl),
      anchors,
      error: null,
    };
  } catch (error) {
    return {
      kind: request.kind,
      method: request.method,
      accept: request.accept,
      requestedUrl: request.url.href,
      finalUrl: null,
      redirects,
      status: null,
      ok: false,
      headersMs:
        headersAt === null
          ? null
          : Math.round((headersAt - startedAt) * 10) / 10,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      responseHeaders: {},
      capturedBodyBytes: 0,
      capturedBodySha256: null,
      bodyTruncated: false,
      bodyExcerpt: null,
      ...(options.captureBody === true ? { body: undefined } : {}),
      document: null,
      error: errorMessage(error),
    };
  }
};

export const probeAll = async (
  requests: ReadonlyArray<ProbeRequest>,
  options: ProbeOptions & { readonly resolve?: HostResolver },
): Promise<ReadonlyArray<HttpProbe>> => {
  const results: Array<HttpProbe | undefined> = Array.from({
    length: requests.length,
  });
  const pending = requests.map((request, index) => ({ index, request }));
  const workers = Array.from(
    { length: Math.min(4, Math.max(1, pending.length)) },
    async () => {
      while (pending.length > 0) {
        const item = pending.shift();
        if (item !== undefined)
          results[item.index] = await probeHttp(item.request, options);
      }
    },
  );
  await Promise.all(workers);
  return results.map((result, index) => {
    if (result === undefined)
      throw new Error(`Probe ${index} did not produce a result`);
    return result;
  });
};

/** Effect boundary retained at the scanner seam; failures remain per-probe data. */
export const probeHttpEffect = Effect.fn("SeoAudit.probeHttp")(function* (
  request: ProbeRequest,
  options: ProbeOptions & { readonly resolve?: HostResolver },
) {
  return yield* Effect.tryPromise({
    try: () => probeHttp(request, options),
    catch: (cause) =>
      new HttpProbeError({ message: errorMessage(cause), cause }),
  });
});

export const makeHttpScanner = (
  options: ProbeOptions & {
    readonly resolve?: HostResolver;
    readonly discovery?: ReadonlyArray<{
      readonly kind: ProbeKind;
      readonly path: string;
      readonly accept: string;
    }>;
  },
): Scanner => ({
  id: "http",
  description: "HTTP metadata, discovery, and content-negotiation probes",
  scan: (input: ScannerInput) =>
    Effect.fn("SeoAudit.scanHttp")(function* () {
      const target = new URL(input.target.url);
      const evidence = yield* Effect.tryPromise({
        try: () =>
          probeAll(buildProbeRequests([target], options.discovery), options),
        catch: (cause) =>
          new ScannerFailure({
            scanner: "http",
            target: target.href,
            message: errorMessage(cause),
            cause,
          }),
      });
      const acquisitionErrors = evidence.flatMap((probe) =>
        probe.status === null && probe.error !== null ? [probe.error] : [],
      );
      if (acquisitionErrors.length === evidence.length) {
        return yield* new ScannerFailure({
          scanner: "http",
          target: target.href,
          message: `Every HTTP probe failed: ${[...new Set(acquisitionErrors)].join("; ")}`,
        });
      }
      return { evidence };
    })(),
});
