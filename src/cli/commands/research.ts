import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { runKeywordWorkflow } from "../../workflows/run";
import type { WorkflowTargetOptions } from "../../workflows/model";
import { acquireGraph, loadSeoProjectConfig } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";

const pageFlag = Flag.String("page").pipe(
  Flag.withDescription("Page path or glob to include (repeatable; default: public corpus)"),
  Flag.between(0, 256),
);
const queryFlag = Flag.String("query").pipe(
  Flag.withDescription("Seed or target query (repeatable)"),
  Flag.between(0, 256),
);
const kindFlag = Flag.String("kind").pipe(
  Flag.withDescription("PageGraph or content kind to include (repeatable)"),
  Flag.between(0, 64),
);
const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Maximum pages and opportunities"),
  Flag.withDefault(100),
);
const marketFlag = Flag.String("market").pipe(Flag.withDescription("Search market code"), Flag.optional);
const languageFlag = Flag.String("language").pipe(
  Flag.withDescription("Search language code"),
  Flag.optional,
);
const refreshFlag = Flag.Boolean("refresh").pipe(
  Flag.withDescription("Ask discovered tools to bypass reusable evidence when supported"),
  Flag.withDefault(false),
);
const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("OpenCode provider/model override"),
  Flag.optional,
);
const configFlag = Flag.String("opencode-config").pipe(
  Flag.withDescription("OpenCode config-directory override"),
  Flag.optional,
);
const outFlag = Flag.String("out").pipe(
  Flag.withDescription("Run-artifact directory override"),
  Flag.optional,
);
const inputFlag = Flag.Boolean("input").pipe(
  Flag.withDescription("Allow TTY fallback questions; --no-input fails instead"),
  Flag.withDefault(true),
);

const keywordsCommand = Command.make("keywords", {
  page: pageFlag,
  query: queryFlag,
  kind: kindFlag,
  limit: limitFlag,
  market: marketFlag,
  language: languageFlag,
  refresh: refreshFlag,
  model: modelFlag,
  opencodeConfig: configFlag,
  out: outFlag,
  input: inputFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Discover demand, cluster queries, map pages, and identify gaps"),
  Command.withExamples([
    {
      command: 'pagegraph research keywords --query "transactional email api" --market us --no-input',
      description: "Run bounded noninteractive keyword research",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* (flags) {
      if (!Number.isSafeInteger(flags.limit) || flags.limit <= 0) {
        return yield* new SeoCliError({ message: "--limit must be a positive integer" });
      }
      const project = yield* loadSeoProjectConfig;
      if (project.config.workflows === undefined) {
        return yield* new SeoCliError({
          message: "seo.config.ts has no workflows configuration; run `pagegraph init` and add it.",
        });
      }
      const configOverride = Option.getOrUndefined(flags.opencodeConfig);
      const config =
        configOverride === undefined
          ? project.config
          : {
              ...project.config,
              workflows: {
                ...project.config.workflows,
                opencode: {
                  ...project.config.workflows.opencode,
                  configDirectory: configOverride,
                },
              },
            };
      const graph = yield* Effect.scoped(acquireGraph(config));
      const options: WorkflowTargetOptions = {
        pages: flags.page,
        queries: flags.query,
        kinds: flags.kind,
        limit: flags.limit,
        market: Option.getOrUndefined(flags.market),
        language: Option.getOrUndefined(flags.language),
        refresh: flags.refresh,
        input: flags.input,
      };
      const result = yield* Effect.tryPromise({
        try: () =>
          runKeywordWorkflow({
            config,
            graph,
            root: project.root,
            options,
            model: Option.getOrUndefined(flags.model),
            out: Option.getOrUndefined(flags.out),
          }),
        catch: (cause) =>
          new SeoCliError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      if (flags.json) yield* printJson(result.run);
      else yield* printText(`${result.run.result.summary}\n\nRun artifact: ${result.directory}`);
    }),
  ),
);

export const researchCommandGroup = Command.make("research").pipe(
  Command.withDescription("Research page-backed organic-search opportunities with OpenCode and Executor"),
  Command.withSubcommands([keywordsCommand]),
);
