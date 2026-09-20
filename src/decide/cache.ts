/**
 * Answer cache keyed by input hash. One JSON file per key under `--cache <dir>`.
 *
 * Only model answers are cached — verdicts are recomputed from answers and the
 * current threshold, so raising or lowering `--threshold` never serves a stale
 * verdict. Cache files are plain data: a missing or unreadable file is a miss,
 * never an error that fails the run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Read cached answers for `key`, or `undefined` on any miss (absent or unreadable). */
export const cacheGet = (cacheDir: string, key: string): unknown | undefined => {
  const file = join(cacheDir, `${key}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/** Persist answers for `key`; creates `cacheDir` on first write. */
export const cachePut = (cacheDir: string, key: string, answers: unknown): void => {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${key}.json`), `${JSON.stringify(answers, null, 2)}\n`, "utf8");
};
