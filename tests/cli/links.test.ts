import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

let server: Server;
let target: string;

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(body));
    };
    switch (request.url) {
      case "/":
        html(
          `<nav><a href="/nav-only">Nav</a></nav>
           <main><a href="/about">About</a><a href="/legacy">Legacy</a>
           <a href="https://external.test/x">External</a>
           <a href="/sitemap.xml">Sitemap</a></main>
           <footer><a href="/legal">Legal</a></footer>`,
        );
        return;
      case "/about":
        html(`<main><a href="/deep">Deep</a></main>`);
        return;
      case "/deep":
        html(`<main><a href="/">Home</a></main>`);
        return;
      case "/nav-only":
      case "/legal":
      case "/current":
        html("<main>Leaf</main>");
        return;
      case "/legacy":
        response.writeHead(301, { location: "/current" });
        response.end();
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
  target = `http://127.0.0.1:${address.port}/`;
});

const temporaryDirectories: Array<string> = [];

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Async spawn, not spawnSync: this test's fixture server shares the vitest event
// loop, so a synchronous spawn would block it and deadlock the child.
const runLinks = (
  args: ReadonlyArray<string>,
  cwd: string = tmpdir(),
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [cli, "links", "verify", ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

describe("pagegraph links verify", () => {
  it("reports depth, orphans, and coverage as versioned JSON", async () => {
    const result = await runLinks([target, "--allow-private", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      kind: "links-verify",
      schemaVersion: 1,
      origin: target.replace(/\/$/, ""),
      seed: target,
      crawl: {
        pages: 6,
        limit: 100,
        truncated: false,
        failures: [],
        bodyTruncated: false,
        truncatedPages: [],
      },
      rendered: {
        pages: 6,
        // The /sitemap.xml anchor is a real internal body link even though the
        // crawl budget skips fetching it, so it counts as an edge.
        internalEdges: 7,
        contextualEdges: 5,
        maxDepth: 2,
        // /current is reached only through the /legacy redirect, so the graph
        // links nothing to its canonical path.
        orphans: ["/current"],
      },
      declared: null,
      warnings: [],
    });
  }, 20_000);

  it("bounds the crawl with --limit and flags truncation", async () => {
    const result = await runLinks([target, "--allow-private", "--limit", "2", "--json"]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly crawl: { readonly pages: number; readonly truncated: boolean };
    };
    expect(report.crawl.pages).toBe(2);
    expect(report.crawl.truncated).toBe(true);
  }, 20_000);

  it("diffs the declared graph when a seo.config.ts matches the crawl origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pagegraph-links-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "seo.config.mjs"),
      `export default {
  origin: ${JSON.stringify(new URL(target).origin)},
  disallow: [],
  loadGraph: async () => ({
    graph: {
      nodes: new Map([["/", { path: "/", kind: "page", source: "route", policy: { kind: "page" } }]]),
      edges: [{ from: "/", to: "/declared-only", type: "related" }],
    },
    dispose: async () => {},
  }),
};
`,
    );

    const result = await runLinks([target, "--allow-private", "--json"], directory);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly declared: {
        readonly edges: number;
        readonly declaredNotRendered: ReadonlyArray<{ from: string; to: string }>;
      } | null;
      readonly warnings: ReadonlyArray<string>;
    };
    expect(report.declared?.edges).toBe(1);
    expect(report.declared?.declaredNotRendered).toEqual([
      { from: "/", to: "/declared-only" },
    ]);
    expect(report.warnings).toEqual([]);
  }, 20_000);

  it("skips the declared diff when the config origin differs from the crawl origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pagegraph-links-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "seo.config.mjs"),
      `export default {
  origin: "https://elsewhere.example",
  disallow: [],
  loadGraph: async () => ({
    graph: {
      nodes: new Map([["/", { path: "/", kind: "page", source: "route", policy: { kind: "page" } }]]),
      edges: [{ from: "/", to: "/declared-only", type: "related" }],
    },
    dispose: async () => {},
  }),
};
`,
    );

    const result = await runLinks([target, "--allow-private", "--json"], directory);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly declared: unknown;
      readonly warnings: ReadonlyArray<string>;
    };
    expect(report.declared).toBeNull();
    expect(report.warnings).toEqual([
      expect.stringContaining("differs from crawled origin"),
    ]);
  }, 20_000);

  it("renders the human report on stdout", async () => {
    const result = await runLinks([target, "--allow-private"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("max homepage depth  2");
    expect(result.stdout).toContain("rendered orphans    1");
    expect(result.stdout).toContain("/current");
  }, 20_000);

  it("rejects a private target without --allow-private", async () => {
    const result = await runLinks([target, "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No page could be crawled");
    expect(result.stderr).toContain("Private target is not allowed");
  }, 20_000);

  it("keeps invalid input off stdout", async () => {
    const result = await runLinks(["not-a-url", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Not a valid URL");
  }, 20_000);
});
