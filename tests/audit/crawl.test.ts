import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crawlRenderedPages } from "../../src/audit/crawl";

let server: Server;
let origin: string;
let offOriginUrl = "";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(body));
    };
    switch (request.url) {
      case "/":
        html(`<a href="/alias">Alias</a><a href="/target">Target</a><a href="/leaf">Leaf</a>`);
        return;
      case "/alias":
        response.writeHead(301, { location: "/target" });
        response.end();
        return;
      case "/target":
        html(`<a href="/leaf">Leaf</a>`);
        return;
      case "/leaf":
        html("<main>Leaf</main>");
        return;
      case "/big":
        response.end(page(`<a href="/target">Target</a>${"x".repeat(5_000)}`));
        return;
      case "/canonical-alias":
        html('<link rel="canonical" href="/canonical-target"><a href="/canonical-target">Target</a><a href="/leaf">Leaf</a>');
        return;
      case "/canonical-unvisited":
        html('<link rel="canonical" href="/canonical-target">Alias body');
        return;
      case "/canonical-target":
        html('<a href="/canonical-target">Target</a>');
        return;
      case "/canonical-copy":
        html('<link rel="canonical" href="/canonical-target"><a href="/canonical-target">Target</a>');
        return;
      case "/off-origin":
        response.writeHead(302, { location: offOriginUrl });
        response.end();
        return;
      case "/source-with-markdown":
        html('<a href="/auth.md">Markdown</a><a href="/leaf">Leaf</a>');
        return;
      case "/auth.md":
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Authentication");
        return;
      default:
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("crawlRenderedPages", () => {
  it("renders a redirect target once when it is also discovered directly", async () => {
    const result = await crawlRenderedPages(`${origin}/`, {
      limit: 100,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
      allowPrivate: true,
    });

    const paths = result.pages.map((rendered) => new URL(rendered.url).pathname);
    expect(paths).toEqual(["/", "/target", "/leaf"]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.root).toBe("/");
    expect(result.truncatedBodies).toEqual([]);
  });

  it("surfaces a body truncated at maxBodyBytes", async () => {
    const result = await crawlRenderedPages(`${origin}/big`, {
      limit: 5,
      timeoutMs: 5_000,
      maxBodyBytes: 200,
      allowPrivate: true,
    });

    expect(result.pages.map((rendered) => new URL(rendered.url).pathname)).toContain("/big");
    expect(result.root).toBe("/big");
    expect(result.truncatedBodies).toEqual([`${origin}/big`]);
  });

  it("falls back to page links after a malformed sitemap and reports incomplete discovery", async () => {
    const fixture = createServer((request, response) => {
      if (request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end("<broken>");
      } else if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page('<a href="/linked">Linked</a>'));
      } else if (request.url === "/linked") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page("Linked"));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
      const site = `http://127.0.0.1:${address.port}`;
      const result = await crawlRenderedPages(`${site}/`, {
        limit: 10, timeoutMs: 5_000, maxBodyBytes: 10_000, allowPrivate: true,
      });
      expect(result.pages.map((rendered) => new URL(rendered.url).pathname)).toEqual(["/", "/linked"]);
      expect(result.discoveryFailures).toEqual([{ url: `${site}/sitemap.xml`, error: "malformed sitemap" }]);
      expect(result.sitemapUsed).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it("retains an alias with distinct served links and dedupes identical canonical anchors", async () => {
    const options = { limit: 5, timeoutMs: 5_000, maxBodyBytes: 10_000, allowPrivate: true };
    const fetched = await crawlRenderedPages(`${origin}/canonical-alias`, options);
    expect(fetched.pages.map((page) => new URL(page.url).pathname)).toEqual(["/canonical-alias", "/canonical-target", "/leaf"]);
    expect(fetched.root).toBe("/canonical-alias");

    const copy = await crawlRenderedPages(`${origin}/canonical-copy`, options);
    expect(copy.pages.map((page) => new URL(page.url).pathname)).toEqual(["/canonical-target"]);
    expect(copy.root).toBe("/canonical-target");

    const unvisited = await crawlRenderedPages(`${origin}/canonical-unvisited`, options);
    expect(unvisited.pages.map((page) => new URL(page.url).pathname)).toEqual(["/canonical-unvisited"]);
    expect(unvisited.root).toBe("/canonical-unvisited");
  });

  it("does not request an off-origin redirect target", async () => {
    let fetched = 0;
    const remote = createServer((_request, response) => {
      fetched += 1;
      response.end(page("Remote"));
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    try {
      const address = remote.address();
      if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
      offOriginUrl = `http://127.0.0.1:${address.port}/remote`;
      const result = await crawlRenderedPages(`${origin}/off-origin`, {
        limit: 2, timeoutMs: 5_000, maxBodyBytes: 10_000, allowPrivate: true,
      });
      expect(result.pages).toEqual([]);
      expect(result.failures[0]?.error).toContain("Redirected off-origin");
      expect(fetched).toBe(0);
    } finally {
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      offOriginUrl = "";
    }
  });

  it("records a link-only Markdown alternate without failing HTML coverage", async () => {
    const result = await crawlRenderedPages(`${origin}/source-with-markdown`, {
      limit: 5, timeoutMs: 5_000, maxBodyBytes: 10_000, allowPrivate: true,
    });
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(["/source-with-markdown", "/leaf"]);
    expect(result.failures).toEqual([]);
    expect(result.nonHtml).toEqual([{ url: `${origin}/auth.md`, finalUrl: `${origin}/auth.md`, contentType: "text/markdown" }]);
    expect(result.truncated).toBe(false);
  });

  it("enforces robots across redirects and reports an off-origin advertised sitemap", async () => {
    let site = "";
    let remoteSite = "";
    let privateFetches = 0;
    let remoteFetches = 0;
    const remote = createServer((_request, response) => {
      remoteFetches += 1;
      response.end("<urlset></urlset>");
    });
    const fixture = createServer((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`User-agent: Pagegraph\nDisallow: /private$\nDisallow: /wild*a*a*a*a*a*a*a*a*a*a*b\nSitemap: ${remoteSite}/map.xml\nSitemap: ${site}/sitemap.xml`);
      } else if (request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(`<urlset><url><loc>${site}/numeric?a=1&#38;b=2</loc></url><url><loc>${site}/xhtml</loc></url><url><loc>${site}/document.md</loc></url><url><loc>${site}/bad&#x110000;</loc></url></urlset>`);
      } else if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page('<a href="/go">Go</a>'));
      } else if (request.url === "/go") {
        response.writeHead(302, { location: "/private" });
        response.end();
      } else if (request.url === "/private") {
        privateFetches += 1;
        response.end(page("Private"));
      } else if (request.url === "/numeric?a=1&b=2") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page("Numeric"));
      } else if (request.url === "/xhtml") {
        response.writeHead(200, { "content-type": "application/xhtml+xml" });
        response.end(page('<a href="/numeric?a=1&amp;b=2">Numeric</a>'));
      } else if (request.url === "/document.md") {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Listed alternate");
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await Promise.all([
      new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve)),
    ]);
    try {
      const localAddress = fixture.address();
      const remoteAddress = remote.address();
      if (localAddress === null || typeof localAddress === "string" || remoteAddress === null || typeof remoteAddress === "string") throw new Error("Fixture did not bind");
      site = `http://127.0.0.1:${localAddress.port}`;
      remoteSite = `http://127.0.0.1:${remoteAddress.port}`;
      const result = await crawlRenderedPages(`${site}/`, {
        limit: 10, timeoutMs: 5_000, maxBodyBytes: 10_000, allowPrivate: true,
      });
      expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(["/", "/numeric", "/xhtml"]);
      expect(result.failures[0]?.error).toContain("robots-disallowed");
      expect(result.failures).toContainEqual({ url: `${site}/document.md`, error: "Response is not HTML" });
      expect(result.skipped).toContain(`${site}/private`);
      expect(result.discoveryFailures).toEqual([
        { url: `${remoteSite}/map.xml`, error: "Advertised sitemap is off-origin and was not fetched" },
        { url: `${site}/sitemap.xml`, error: expect.stringContaining("Invalid sitemap <loc>") },
      ]);
      expect(privateFetches).toBe(0);
      expect(remoteFetches).toBe(0);
      expect(result.pages.find((page) => new URL(page.url).pathname === "/xhtml")?.anchors).toHaveLength(1);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => remote.close(() => resolve())),
        new Promise<void>((resolve) => fixture.close(() => resolve())),
      ]);
    }
  });
});
