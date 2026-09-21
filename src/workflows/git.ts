import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GitState {
  readonly head?: string | undefined;
  readonly dirty: boolean;
  readonly files: ReadonlyArray<string>;
  readonly fingerprints: Readonly<Record<string, string>>;
}

const run = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const nul = (value: string): ReadonlyArray<string> => value.split("\0").filter((item) => item.length > 0);

const fingerprint = (root: string, path: string): string => {
  const absolute = resolve(root, path);
  const content = existsSync(absolute) ? readFileSync(absolute) : Buffer.from("<deleted>");
  const status = run(root, ["status", "--short", "--", path]);
  return createHash("sha256").update(status).update("\0").update(content).digest("hex");
};

export const inspectGit = (root: string): GitState => {
  try {
    const tracked = nul(run(root, ["diff", "--name-only", "-z", "HEAD"]));
    const untracked = nul(run(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const files = [...new Set([...tracked, ...untracked])].sort();
    return {
      head: run(root, ["rev-parse", "HEAD"]),
      dirty: files.length > 0,
      files,
      fingerprints: Object.fromEntries(files.map((path) => [path, fingerprint(root, path)])),
    };
  } catch {
    return { dirty: false, files: [], fingerprints: {} };
  }
};

export const changedFiles = (before: GitState, after: GitState): ReadonlyArray<string> =>
  [...new Set([...before.files, ...after.files])]
    .filter((path) => before.fingerprints[path] !== after.fingerprints[path])
    .sort();
