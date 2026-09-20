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
]);

const temporaryDirectories: Array<string> = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const writeFile = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-decide-group-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "inputs.json");
  writeFileSync(file, contents);
  return file;
};

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn `pagegraph decide ...` with the TypeSafe key dropped. */
const runDecide = (args: ReadonlyArray<string>, stdin?: string): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const child = spawn("bun", [cli, "decide", ...args], { env });
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
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });

describe("pagegraph decide (offline)", () => {
  it("fails cleanly without TYPESAFE_API_KEY", async () => {
    const result = await runDecide(["links", writeFile(candidates), "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
  }, 20_000);

  it("reads a batch from stdin", async () => {
    const result = await runDecide(["links", "--json"], candidates);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY is not set");
  }, 20_000);

  it("rejects malformed JSON before reaching the provider", async () => {
    const result = await runDecide(["links", writeFile("{ not json"), "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid candidates");
  }, 20_000);

  it("rejects a threshold without a non-empty review band", async () => {
    const result = await runDecide(["links", writeFile(candidates), "--threshold", "0.5"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--threshold must be greater than 0.5 and less than 1");
  }, 20_000);
});
