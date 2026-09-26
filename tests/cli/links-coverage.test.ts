import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

let server: Server;
let target: string;
let brokenServer: Server;
let brokenTarget: string;

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(body));
    };
    switch (request.url) {
      case "/":
        // Two body anchors into /pricing (the contextual count) plus one nav
        // anchor that a rendered coverage rule must ignore.
        html(
          `<nav><a href="/pricing">Pricing</a></nav>
           <main><a href="/about">About</a><a href="/pricing">Pricing</a></main>`,
        );
        return;
      case "/about":
        html(`<main><a href="/pricing">Pricing</a></main>`);
        return;
      case "/pricing":
        html(`<main><a href="/about">About</a></main>`);
        return;
      default:
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
    }
  });
  // A site with a dead internal link: /missing is discovered but never renders,
  // so its outgoing anchors are absent from the crawl.
  brokenServer = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(`<main><a href="/ok">Ok</a><a href="/missing">Missing</a></main>`));
      return;
    }
    if (request.url === "/ok") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(`<main>Ok</main>`));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve, reject) => {
      brokenServer.once("error", reject);
      brokenServer.listen(0, "127.0.0.1", resolve);
    }),
  ]);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
  target = `http://127.0.0.1:${address.port}/`;
  const brokenAddress = brokenServer.address();
  if (brokenAddress === null || typeof brokenAddress === "string") {
    throw new Error("Broken fixture did not bind");
  }
  brokenTarget = `http://127.0.0.1:${brokenAddress.port}/`;
});

const temporaryDirectories: Array<string> = [];

afterAll(async () => {
  await Promise.all(
    [server, brokenServer].map(
      (instance) =>
        new Promise<void>((resolve, reject) =>
          instance.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const configFor = (origin: string, coverage: string): string => `const node = (path) => ({
  path,
  kind: "page",
  source: "route",
  policy: { kind: "page", sitemap: { priority: 0.5, changeFrequency: "monthly" } },
});

export default {
  origin: ${JSON.stringify(origin)},
  disallow: [],
  ${coverage}
  loadGraph: async () => ({
    graph: {
      nodes: new Map([["/", node("/")], ["/about", node("/about")], ["/pricing", node("/pricing")]]),
      edges: [{ from: "/about", to: "/pricing", type: "related" }],
    },
    dispose: async () => {},
  }),
};
`;

const configDirectory = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-links-coverage-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "seo.config.mjs"), contents);
  return directory;
};

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Async spawn: the fixture server shares the vitest event loop, so a synchronous
// spawn would block it inside the child's request handling.
const runVerify = (args: ReadonlyArray<string>, cwd: string): Promise<CliResult> =>
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

interface VerifyReport {
  readonly origin: string;
  readonly seed: string;
  readonly crawl: { readonly pages: number };
  readonly rendered: { readonly internalEdges: number; readonly contextualEdges: number };
  readonly coverage?: {
    readonly rules: number;
    readonly ok: boolean;
    readonly violations: ReadonlyArray<{ rule: string; path?: string }>;
  };
  readonly warnings: ReadonlyArray<string>;
}

describe("pagegraph links verify — rendered-edge artifact", () => {
  it("writes a decodeRenderedEdges-compatible artifact with provenance and region", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pagegraph-emit-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "rendered.json");

    const result = await runVerify(
      [target, "--allow-private", "--emit-rendered", artifactPath, "--json"],
      tmpdir(),
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as VerifyReport;
    // The default summary stays exactly as before — no coverage key.
    expect(report).not.toHaveProperty("coverage");

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly origin: string;
      readonly seed: string;
      readonly crawl: Record<string, unknown>;
      readonly nodes: ReadonlyArray<string>;
      readonly edges: ReadonlyArray<{ from: string; to: string; region: string }>;
    };
    expect(artifact).toMatchObject({
      kind: "links-rendered",
      schemaVersion: 1,
      origin: target.replace(/\/$/, ""),
      seed: target,
      crawl: { pages: 3, limit: 100, truncated: false, root: "/", failures: [] },
    });
    expect([...artifact.nodes].sort()).toEqual(["/", "/about", "/pricing"]);
    // Every crawled edge is present, and the nav/body distinction survives.
    const pricing = artifact.edges.filter((edge) => edge.to === "/pricing");
    expect(pricing.map((edge) => edge.region).sort()).toEqual(["body", "body", "nav"]);
  }, 20_000);

  it("replays a saved artifact offline and asserts coverage from it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pagegraph-replay-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "seo.config.mjs"),
      configFor(new URL(target).origin, `coverage: [{ path: "/pricing", minInbound: 2 }],`),
    );
    const artifactPath = join(directory, "rendered.json");

    const emitted = await runVerify(
      [target, "--allow-private", "--emit-rendered", artifactPath],
      directory,
    );
    expect(emitted.status).toBe(0);

    // No URL, no crawl: the artifact is the whole input.
    const result = await runVerify(
      ["--rendered", artifactPath, "--assert-coverage", "--json"],
      directory,
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as VerifyReport;
    expect(report.origin).toBe(target.replace(/\/$/, ""));
    expect(report.crawl.pages).toBe(3);
    expect(report.rendered.contextualEdges).toBe(4);
    expect(report.coverage).toMatchObject({ rules: 1, ok: true });
  }, 20_000);

  it("refuses coverage when replayed discovery provenance is incomplete", async () => {
    const directory = configDirectory(
      configFor(new URL(target).origin, `coverage: [{ path: "/pricing", minInbound: 1 }],`),
    );
    const artifactPath = join(directory, "rendered.json");
    const emitted = await runVerify([target, "--allow-private", "--emit-rendered", artifactPath], directory);
    expect(emitted.status).toBe(0);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      crawl: { discoveryFailures: Array<{ url: string; error: string }> };
    };
    artifact.crawl.discoveryFailures = [{ url: `${target}sitemap.xml`, error: "malformed sitemap" }];
    writeFileSync(artifactPath, JSON.stringify(artifact));

    const result = await runVerify(["--rendered", artifactPath, "--assert-coverage", "--json"], directory);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("discovery was incomplete");
  }, 20_000);

  it("allows a non-HTML link alternate but refuses a declared page served as non-HTML", async () => {
    const directory = configDirectory(
      configFor(new URL(target).origin, `coverage: [{ path: "/pricing", minInbound: 1 }],`),
    );
    const artifactPath = join(directory, "rendered.json");
    const emitted = await runVerify([target, "--allow-private", "--emit-rendered", artifactPath], directory);
    expect(emitted.status).toBe(0);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      crawl: { nonHtml: Array<{ url: string; finalUrl: string; contentType: string }> };
    };
    artifact.crawl.nonHtml = [{ url: `${target}auth.md`, finalUrl: `${target}auth.md`, contentType: "text/markdown" }];
    writeFileSync(artifactPath, JSON.stringify(artifact));
    expect((await runVerify(["--rendered", artifactPath, "--assert-coverage", "--json"], directory)).status).toBe(0);

    artifact.crawl.nonHtml = [{ url: `${target}pricing`, finalUrl: `${target}pricing`, contentType: "text/markdown" }];
    writeFileSync(artifactPath, JSON.stringify(artifact));
    const declared = await runVerify(["--rendered", artifactPath, "--assert-coverage", "--json"], directory);
    expect(declared.status).toBe(1);
    expect(declared.stderr).toContain("declared page");
  }, 20_000);

  it("exits 1 when a rendered coverage rule is unmet", async () => {
    // /pricing has three anchors into it — two body and one nav. Requiring 3
    // fails only because the nav anchor does not count as contextual.
    const directory = configDirectory(
      configFor(new URL(target).origin, `coverage: [{ path: "/pricing", minInbound: 3 }],`),
    );

    const result = await runVerify(
      [target, "--allow-private", "--assert-coverage", "--json"],
      directory,
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as VerifyReport;
    expect(report.coverage?.ok).toBe(false);
    expect(report.coverage?.violations[0]).toMatchObject({
      rule: "inbound-link-coverage",
      path: "/pricing",
    });
    expect(result.stderr).toContain("rendered coverage violation");
  }, 20_000);

  it("refuses to assert coverage on a truncated crawl", async () => {
    const directory = configDirectory(
      configFor(new URL(target).origin, `coverage: [{ path: "/pricing", minInbound: 1 }],`),
    );

    const result = await runVerify(
      [target, "--allow-private", "--limit", "1", "--assert-coverage", "--json"],
      directory,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("truncated crawl");
  }, 20_000);

  it("refuses to assert when seo.config.ts declares no coverage rules", async () => {
    const directory = configDirectory(configFor(new URL(target).origin, ""));

    const result = await runVerify(
      [target, "--allow-private", "--assert-coverage", "--json"],
      directory,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("declares no `coverage` rules");
  }, 20_000);

  it("refuses to assert when the artifact is from another origin", async () => {
    const directory = configDirectory(
      configFor("https://elsewhere.example", `coverage: [{ path: "/pricing", minInbound: 1 }],`),
    );
    const artifactPath = join(directory, "rendered.json");
    writeFileSync(
      artifactPath,
      `${JSON.stringify({
        kind: "links-rendered",
        schemaVersion: 1,
        origin: new URL(target).origin,
        seed: target,
        crawl: { pages: 1, root: "/", limit: 100, truncated: false },
        edges: [{ from: "/about", to: "/pricing", region: "body" }],
      })}\n`,
    );

    const result = await runVerify(
      ["--rendered", artifactPath, "--assert-coverage", "--json"],
      directory,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot assert coverage");
  }, 20_000);

  it("rejects a malformed artifact instead of asserting on it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pagegraph-bad-artifact-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "rendered.json");
    writeFileSync(artifactPath, `${JSON.stringify({ schemaVersion: 2, edges: [] })}\n`);

    const result = await runVerify(["--rendered", artifactPath, "--json"], directory);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not read rendered artifact");
  }, 20_000);

  it("records failed pages in the artifact and refuses to assert on them", async () => {
    const directory = configDirectory(
      configFor(new URL(brokenTarget).origin, `coverage: [{ path: "/pricing", minInbound: 1 }],`),
    );
    const artifactPath = join(directory, "rendered.json");

    const emitted = await runVerify(
      [brokenTarget, "--allow-private", "--emit-rendered", artifactPath],
      directory,
    );
    expect(emitted.status).toBe(0);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      readonly crawl: { readonly failures: ReadonlyArray<{ url: string; error: string }> };
    };
    expect(artifact.crawl.failures).toHaveLength(1);
    expect(artifact.crawl.failures[0]?.url).toContain("/missing");

    const crawled = await runVerify(
      [brokenTarget, "--allow-private", "--assert-coverage", "--json"],
      directory,
    );
    expect(crawled.status).toBe(1);
    expect(crawled.stderr).toContain("failed to fetch");

    const replayed = await runVerify(
      ["--rendered", artifactPath, "--assert-coverage", "--json"],
      directory,
    );
    expect(replayed.status).toBe(1);
    expect(replayed.stderr).toContain("failed to fetch");
  }, 20_000);
});
