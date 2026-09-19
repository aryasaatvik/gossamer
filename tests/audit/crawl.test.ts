import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crawlRenderedPages } from "../../src/audit/crawl";

let server: Server;
let origin: string;

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

    expect(result.pages.map((rendered) => new URL(rendered.url).pathname)).toEqual(["/big"]);
    expect(result.root).toBe("/big");
    expect(result.truncatedBodies).toEqual([`${origin}/big`]);
  });
});
