import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export interface GitState {
  readonly head?: string | undefined;
  readonly dirty: boolean;
  readonly files: ReadonlyArray<string>;
  readonly fingerprints: Readonly<Record<string, string>>;
}

const run = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const nul = (value: string): ReadonlyArray<string> => value.split("\0").filter((item) => item.length > 0);

const fingerprint = (root: string, gitRoot: string, path: string): string => {
  const absolute = resolve(root, path);
  const gitPath = relative(gitRoot, absolute);
  const status = run(gitRoot, ["status", "--short", "--", gitPath]);
  let content: Buffer;
  if (!existsSync(absolute)) {
    content = Buffer.from("<deleted>");
  } else if (statSync(absolute).isDirectory()) {
    const stage = run(gitRoot, ["ls-files", "--stage", "--", gitPath]);
    const mode = stage.split(/\s+/, 1)[0];
    if (mode !== "160000") throw new Error(`Cannot fingerprint directory reported as a Git file: ${path}`);
    const submoduleRoot = realpathSync(run(absolute, ["rev-parse", "--show-toplevel"]));
    if (submoduleRoot !== realpathSync(absolute)) throw new Error(`Git submodule is unavailable: ${path}`);
    content = Buffer.from(`gitlink:${stage}\0${JSON.stringify(inspectGit(submoduleRoot))}`);
  } else {
    content = readFileSync(absolute);
  }
  return createHash("sha256").update(status).update("\0").update(content).digest("hex");
};

export const inspectGit = (root: string): GitState => {
  const absoluteRoot = realpathSync(root);
  let gitTopLevel: string;
  try {
    gitTopLevel = run(absoluteRoot, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { dirty: false, files: [], fingerprints: {} };
  }
  const gitRoot = realpathSync(gitTopLevel);

  const tracked = nul(run(gitRoot, ["diff", "--name-only", "-z", "HEAD"]));
  const untracked = nul(run(gitRoot, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]));
  const files = [...new Set([...tracked, ...untracked])]
    .map((path) => relative(absoluteRoot, resolve(gitRoot, path)))
    .sort();
  return {
    head: run(gitRoot, ["rev-parse", "HEAD"]),
    dirty: files.length > 0,
    files,
    fingerprints: Object.fromEntries(files.map((path) => [path, fingerprint(absoluteRoot, gitRoot, path)])),
  };
};

export const changedFiles = (before: GitState, after: GitState): ReadonlyArray<string> =>
  [...new Set([...before.files, ...after.files])]
    .filter((path) => before.fingerprints[path] !== after.fingerprints[path])
    .sort();
