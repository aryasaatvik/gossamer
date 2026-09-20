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
      readonly edges: ReadonlyArray<{ from: string; to: string; region: string }>;
    };
    expect(artifact).toMatchObject({
      kind: "links-rendered",
      schemaVersion: 1,
      origin: target.replace(/\/$/, ""),
      seed: target,
      crawl: { pages: 3, limit: 100, truncated: false, root: "/" },
    });
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
});
