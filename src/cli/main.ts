/**
 * The `pagegraph` CLI program (Bun runtime), wiring the three output planes:
 *  - **data** → stdout, via `Console.log` in the command handlers.
 *  - **status** → stderr, via `Logger.LogToStderr(true)`: the built-in loggers
 *    call `console.error`, so `Effect.log*` never touches stdout. The built-in
 *    `--log-level` flag (from `Command.run`) gates them.
 *  - **diagnostics** → stderr: an expected `SeoCliError` prints `✗ <message>`.
 *
 * This module is what `bin.ts` dynamic-imports, and it is the only place Effect
 * enters the package — which is what keeps Effect an *optional* peer dependency
 * that no consumer of `pagegraph` or `pagegraph/react` ever installs.
 *
 * Two Bun-specific wrinkles are handled here:
 *  - `Command.run` writes its help to stdout, so a flag typo would dump the full
 *    help there. Under Bun, `Console.log` bypasses `process.stdout.write` (it
 *    calls `console.log` natively), so the buffer intercepts `console.log`.
 *  - A graph loader may leave handles alive after the command finishes (the Vite
 *    loader's worker threads do), and the default teardown only force-exits on a
 *    non-zero code, so a custom teardown exits on success too.
 */

import * as fs from "node:fs";

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Runtime from "effect/Runtime";
import * as CliError from "effect/unstable/cli/CliError";
import * as Command from "effect/unstable/cli/Command";

import PackageJson from "../../package.json" with { type: "json" };
import { cli } from "./cli";

type StdoutState = {
  readonly originalLog: typeof console.log;
  readonly buffer: Array<ReadonlyArray<unknown>>;
  discard: boolean;
};

/**
 * Write one buffered line synchronously to fd 1, looping over partial writes and
 * retrying `EAGAIN`. The forced `process.exit` needed to escape the Vite loader's
 * lingering handles truncates async stdout to a slow pipe (`… | jq`) at the OS
 * pipe-buffer boundary; a synchronous write blocks until every byte lands, so
 * `process.exit` afterwards can't cut it off.
 */
const writeLineSync = (line: string): void => {
  const buffer = Buffer.from(`${line}\n`, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    // NOTE: fs.writeSync throws EAGAIN; the write must stay raw-synchronous so process.exit can't truncate stdout
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EAGAIN") continue;
      // NOTE: re-throw non-EAGAIN fs.writeSync errors out of the raw sync-flush boundary
      throw cause;
    }
  }
};

const flushStdout = (state: StdoutState): void => {
  for (const args of state.buffer) {
    writeLineSync(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  }
  state.buffer.length = 0;
};

/**
 * `Command.run` already prints the error itself to stderr (showHelp → Console.error);
 * this adds only the "Try …" nudge, and `commandPath` already starts with "seo".
 */
const formatParseHint = (error: CliError.ShowHelp): string => {
  const helpTarget = error.commandPath.length > 0 ? error.commandPath.join(" ") : "seo";
  return `Try: ${helpTarget} --help`;
};

/**
 * Buffer stdout (`console.log`) so a parse error can suppress the help dump and
 * print a one-line hint to stderr instead. Successful runs flush the buffer as
 * their final act. The Vite loader temporarily re-points `console.log` to stderr
 * while it runs (see `vite-graph-loader.ts`), nested inside this override, so its
 * noise never enters the buffer.
 */
const withStdoutBuffer = <E, R>(program: Effect.Effect<void, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync((): StdoutState => {
      const originalLog = console.log;
      const buffer: Array<ReadonlyArray<unknown>> = [];
      console.log = (...args: Array<unknown>) => buffer.push(args);
      return { originalLog, buffer, discard: false };
    }),
    (state) =>
      program.pipe(
        Effect.tap(() => Effect.sync(() => flushStdout(state))),
        Effect.tapError((error) => {
          if (CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length > 0) {
            state.discard = true;
            return Console.error(formatParseHint(error));
          }
          return Effect.sync(() => flushStdout(state));
        }),
      ),
    (state) =>
      Effect.sync(() => {
        console.log = state.originalLog;
        if (!state.discard && state.buffer.length > 0) flushStdout(state);
        else state.buffer.length = 0;
      }),
  );

const program = withStdoutBuffer(
  Command.run(cli, { version: PackageJson.version }).pipe(
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provide(BunServices.layer),
    Effect.tapErrorTag("SeoCliError", (error) => Console.error(`✗ ${error.message}`)),
  ),
);

/**
 * Run the CLI. An explicit call from `bin.ts` rather than an import-time side
 * effect: the package declares `sideEffects: false`, so a body that only ran on
 * import would be tree-shaken out of the built chunk.
 *
 * Force exit to escape the Vite loader's lingering worker handles. `flushStdout`
 * already wrote the data plane synchronously, so exiting here can't truncate it.
 */
export const run = (): void => {
  BunRuntime.runMain(program, {
    disableErrorReporting: true,
    teardown: (exit, _onExit) => Runtime.defaultTeardown(exit, (code) => process.exit(code)),
  });
};
