import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

const candidates = JSON.stringify([
  {
    sourceUrl: "/blog/post",
    destinationUrl: "/pricing",
    sourceText: "See how pricing scales.",
  },
  {
    sourceUrl: "/docs/start",
    destinationUrl: "/guides",
    sourceText: "A passing mention.",
    existingAnchor: "guides",
  },
]);

const temporaryDirectories: Array<string> = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const writeCandidates = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-decide-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "candidates.json");
  writeFileSync(file, contents);
  return file;
};

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the CLI. By default the TypeSafe key is dropped so the offline tests can
 * never escape to the network; the gated live suite opts back in with `withKey`.
 */
const runDecide = (
  args: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly withKey?: boolean } = {},
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (options.withKey !== true) delete env.TYPESAFE_API_KEY;
    const child = spawn("bun", [cli, "links", "decide", ...args], { env });
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
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });

describe("pagegraph links decide (offline)", () => {
  it("reads candidates from a file and fails cleanly without TYPESAFE_API_KEY", async () => {
    const result = await runDecide([writeCandidates(candidates), "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
  }, 20_000);

  it("reads candidates from stdin", async () => {
    const result = await runDecide(["--json"], { stdin: candidates });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
  }, 20_000);

  it("rejects malformed JSON before reaching the provider", async () => {
    const result = await runDecide([writeCandidates("{ not json"), "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid candidates");
  }, 20_000);

  it("rejects a candidate that fails the schema", async () => {
    const result = await runDecide([writeCandidates('[{"sourceUrl":1}]'), "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid candidates");
  }, 20_000);

  it("rejects a threshold without a non-empty review band", async () => {
    for (const value of ["0.5", "0.4", "0", "1", "1.5"]) {
      const result = await runDecide([writeCandidates(candidates), "--threshold", value]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--threshold must be greater than 0.5 and less than 1");
    }
  }, 20_000);

  it("accepts a threshold inside (0.5, 1) and proceeds to the key check", async () => {
    const result = await runDecide([writeCandidates(candidates), "--threshold", "0.6"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
  }, 20_000);
});

/**
 * Live smoke: only meaningful with a real TypeSafe key. Skipped in CI and on any
 * host without `TYPESAFE_API_KEY`; the mock layer is the contract test above.
 * The child keeps the key (unlike the offline suite) so the live path can run.
 */
describe.skipIf(!process.env.TYPESAFE_API_KEY)("pagegraph links decide (live)", () => {
  it("answers the candidate set through TypeSafe System One", async () => {
    const result = await runDecide([writeCandidates(candidates), "--json"], { withKey: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly kind: string;
      readonly counts: { readonly candidates: number };
      readonly resolved: ReadonlyArray<unknown>;
      readonly review: ReadonlyArray<unknown>;
    };
    expect(report.kind).toBe("links-decide");
    expect(report.counts.candidates).toBe(2);
    expect(report.resolved.length + report.review.length).toBe(2);
  }, 30_000);
});
