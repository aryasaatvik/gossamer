/**
 * A graph loader that evaluates the host app's own graph module inside a
 * headless Vite server.
 *
 * The SEO graph is built *by the app*: its module reads the generated route
 * tree and whatever content collections it owns, so it pulls in the app's real
 * module graph — path aliases, virtual modules from content plugins, bare
 * imports that only exist inside a server runtime. A CLI cannot just `import()`
 * that from Node or Bun.
 *
 * So this boots a scoped, in-process Vite server (middleware mode, no HMR, no
 * watcher, no HTTP listener), `ssrLoadModule`s the app's graph module, and calls
 * its exported loader. The graph comes back as a live in-process object — there
 * is no serialization boundary for the commands to cross — and the server is
 * closed by {@link LoadedSeoGraph.dispose}.
 *
 * Everything host-shaped is an option: the app supplies its own {@link
 * ViteGraphLoaderOptions.plugins} (a content plugin, an MDX loader), {@link
 * ViteGraphLoaderOptions.stubs} for bare modules that only resolve inside its
 * server runtime, and {@link ViteGraphLoaderOptions.env} for variables its
 * modules parse at import. This file knows about none of them.
 */

import { createServer, type InlineConfig, type PluginOption } from "vite";

import type { SeoGraph } from "../core/graph";

/** A graph, plus the release of whatever producing it acquired. */
export interface LoadedSeoGraph {
  readonly graph: SeoGraph;
  /** Called once the command is done with the graph, on success or failure. */
  readonly dispose: () => Promise<void>;
}

/**
 * Produces the SEO graph for the `pagegraph` CLI. A plain promise on purpose: a
 * config file must be writable without Effect, which the CLI keeps behind its
 * `bin` (an optional peer dependency).
 */
export type SeoGraphLoader = () => Promise<LoadedSeoGraph>;

export interface ViteGraphLoaderOptions {
  /** The app's Vite root — the directory its aliases and plugins resolve against. */
  readonly root: string;
  /** Module exporting the graph loader, root-relative (e.g. `/lib/seo/graph.ts`). */
  readonly entry: string;
  /** Named export on `entry` returning `Promise<SeoGraph>`. Defaults to `loadSeoGraph`. */
  readonly exportName?: string | undefined;
  /** Vite plugins the app's module graph needs — a content/MDX plugin, say. */
  readonly plugins?: ReadonlyArray<PluginOption> | undefined;
  /**
   * Bare or virtual module ids to replace with inert source, so a module that
   * only resolves inside the app's server runtime does not break the load.
   */
  readonly stubs?: Readonly<Record<string, string>> | undefined;
  /**
   * Variables to seed on `process.env` before the app's modules parse it. Vite
   * exposes prefixed values through `import.meta.env`, so this is how a module
   * that demands an env var at import time is satisfied. Existing values win —
   * a real `.env` is never clobbered.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Vite and its plugins write progress to stdout. The CLI reserves stdout for the
 * data plane, so redirect it to stderr for the duration of the load.
 *
 * Both the stream method and `console.log`/`info` are swapped: under Bun,
 * `console.log` writes to fd 1 natively rather than going through
 * `process.stdout.write`, so the stream swap alone would miss a plugin that
 * logs through the console.
 */
const withCleanStdout = async <A>(run: () => Promise<A>): Promise<A> => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalInfo = console.info;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  console.log = (...args: Array<unknown>) => console.error(...args);
  console.info = (...args: Array<unknown>) => console.error(...args);
  try {
    return await run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.info = originalInfo;
  }
};

/** Turn `{ id: source }` into a Vite plugin that resolves and loads each id. */
const stubPlugin = (stubs: Readonly<Record<string, string>>): PluginOption => {
  const virtualIdOf = (id: string) => `\0seo-cli-stub:${id}`;
  const sourceByVirtualId = new Map(
    Object.entries(stubs).map(([id, source]) => [virtualIdOf(id), source]),
  );
  return {
    name: "seo:stubs",
    resolveId: (id) => (id in stubs ? virtualIdOf(id) : null),
    load: (id) => sourceByVirtualId.get(id) ?? null,
  };
};

const seedEnv = (env: Readonly<Record<string, string>>): void => {
  for (const [key, value] of Object.entries(env)) {
    // oxlint-disable-next-line node/no-process-env -- CLI boundary: seeds the raw env BEFORE the app's own env module parses it; that module is the consumer here, not an option
    process.env[key] ??= value;
  }
};

const inlineConfigFor = (options: ViteGraphLoaderOptions): InlineConfig => ({
  configFile: false,
  root: options.root,
  mode: "production",
  logLevel: "error",
  appType: "custom",
  clearScreen: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  resolve: { tsconfigPaths: true },
  plugins: [
    ...(options.stubs === undefined ? [] : [stubPlugin(options.stubs)]),
    ...(options.plugins ?? []),
  ],
});

/**
 * Build a {@link SeoGraphLoader} that evaluates `entry` in a headless Vite
 * server rooted at `root`, and returns what its `exportName` export resolves to.
 */
export const viteGraphLoader =
  (options: ViteGraphLoaderOptions): SeoGraphLoader =>
  async () => {
    const exportName = options.exportName ?? "loadSeoGraph";
    if (options.env) seedEnv(options.env);

    const server = await withCleanStdout(() => createServer(inlineConfigFor(options))).catch(
      (cause: unknown) => {
        throw new Error(`Could not start the Vite loader: ${messageOf(cause)}`);
      },
    );

    // The server is a resource from here on: a failed load must still close it,
    // and a successful one hands the close to the caller as `dispose`.
    const graph = await withCleanStdout(async () => {
      const module = (await server.ssrLoadModule(options.entry)) as Record<string, unknown>;
      const load = module[exportName];
      if (typeof load !== "function") {
        throw new Error(
          `${options.entry} has no \`${exportName}\` export (found: ${Object.keys(module).join(", ") || "nothing"}).`,
        );
      }
      return (await load()) as SeoGraph;
    }).catch(async (cause: unknown) => {
      // Close on the way out, but never let a close failure bury the real
      // error: the reason the graph did not build is the useful one.
      await withCleanStdout(() => server.close()).catch(() => {});
      throw new Error(`Could not build the SEO graph: ${messageOf(cause)}`);
    });

    return { graph, dispose: () => withCleanStdout(() => server.close()) };
  };
