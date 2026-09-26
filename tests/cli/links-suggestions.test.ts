import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
let server: Server;
let origin: string;
let directory: string;
const source = "Our transactional email guide explains delivery retries and message tracking for product teams.";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/blog/guide") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<nav><a href="/blog/retries">Retries</a></nav><main><p>${source}</p></main>`);
    } else if (request.url === "/blog/retries") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main><p>Delivery retries and message tracking keep transactional email reliable at scale.</p></main>");
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = mkdtempSync(join(tmpdir(), "pagegraph-suggestions-"));
  writeFileSync(join(directory, "seo.config.mjs"), `const node = path => ({ path, kind: "article", source: "blog", policy: { kind: "article", sitemap: { priority: 0.5, changeFrequency: "monthly" } } });
export default { origin: ${JSON.stringify(origin)}, disallow: [], loadGraph: async () => ({ graph: { nodes: new Map([["/blog/guide", node("/blog/guide")], ["/blog/retries", node("/blog/retries")]]), edges: [] }, dispose: async () => {} }) };`);
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });

const run = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
  const child = spawn("bun", [cli, "links", "candidates", ...args], { cwd: directory });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (part: Buffer) => { stdout += part.toString(); });
  child.stderr.on("data", (part: Buffer) => { stderr += part.toString(); });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

describe("links candidates --site", () => {
  it("emits a versioned suggestion from served copy despite a nav-only link", async () => {
    const result = await run(["--site", origin, "--allow-private", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe(2);
    const item = report.candidates.find((candidate: { source: string }) => candidate.source === "/blog/guide");
    expect(item.sentence).toBe(source);
    expect(source).toContain(item.anchor);
    expect(item.targetSentence).toContain("Delivery retries");
  }, 20000);

  it("rejects a mismatched origin and reports page-limit truncation", async () => {
    expect((await run(["--site", "https://wrong.example", "--json"])).status).not.toBe(0);
    const limited = await run(["--site", origin, "--allow-private", "--page-limit", "1", "--json"]);
    expect(limited.status).toBe(0);
    expect(JSON.parse(limited.stdout)).toMatchObject({ truncated: true, skipped: [{ path: "/blog/retries", reason: "page limit" }] });
  }, 20000);
});
