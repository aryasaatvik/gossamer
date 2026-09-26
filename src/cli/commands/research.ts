import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import type { SeoCliConfig } from "../../config";
import type { SeoGraph } from "../../core/graph";
import type { WorkflowId, WorkflowRunV1, WorkflowTargetOptions } from "../../workflows/model";
import { runWorkflow } from "../../workflows/run";
import { acquireGraph, loadSeoProjectConfig } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";

export interface WorkflowCommandInput {
  readonly config: SeoCliConfig;
  readonly graph: SeoGraph;
  readonly root: string;
  readonly workflow: WorkflowCommandId;
  readonly options: WorkflowTargetOptions;
  readonly model?: string | undefined;
  readonly out?: string | undefined;
}

export interface WorkflowCommandResult {
  readonly run: WorkflowRunV1;
  readonly directory: string;
}

export type WorkflowCommandId = WorkflowId;

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
  Flag.withDescription("Maximum pages, queries, or opportunities"),
  Flag.withDefault(100),
);
const marketFlag = Flag.String("market").pipe(
  Flag.withDescription("Search market code (for example, us)"),
  Flag.optional,
);
const languageFlag = Flag.String("language").pipe(
  Flag.withDescription("Search language code (for example, en)"),
  Flag.optional,
);
const deviceFlag = Flag.Literals("device", ["desktop", "mobile"]).pipe(
  Flag.withDescription("SERP device context"),
  Flag.optional,
);
const competitorFlag = Flag.String("competitor").pipe(
  Flag.withDescription("Competitor domain or product (repeatable)"),
  Flag.between(0, 256),
);
const domainFlag = Flag.String("domain").pipe(
  Flag.withDescription("Authority target domain (repeatable)"),
  Flag.between(0, 256),
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
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Suppress file writes; discovered Executor tools remain available"),
  Flag.withDefault(false),
);
const allowDirtyFlag = Flag.Boolean("allow-dirty").pipe(
  Flag.withDescription("Permit file changes when the working tree is already dirty"),
  Flag.withDefault(false),
);
export const suggestionsFlag = Flag.String("suggestions").pipe(
  Flag.withDescription("Schema-version-2 links candidate JSON to evaluate"),
  Flag.optional,
);

type FlagSet = Readonly<Record<string, Flag.Flag<unknown>>>;

const baseFlags = {
  page: pageFlag,
  kind: kindFlag,
  limit: limitFlag,
  refresh: refreshFlag,
  model: modelFlag,
  opencodeConfig: configFlag,
  out: outFlag,
  json: jsonFlag,
} as const;

const researchFlags = {
  ...baseFlags,
  query: queryFlag,
  market: marketFlag,
  language: languageFlag,
} as const;

const serpFlags = {
  ...researchFlags,
  device: deviceFlag,
} as const;

const optionalString = (value: unknown): string | undefined => {
  if (!Option.isOption(value)) return undefined;
  const item = Option.getOrUndefined(value);
  return typeof item === "string" ? item : undefined;
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const optionsFrom = (
  flags: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> = {},
): WorkflowTargetOptions => {
  const device = optionalString(flags.device);
  const limit = flags.limit;
  if (typeof limit !== "number") throw new Error("--limit must be a number");
  return {
    pages: strings(flags.page),
    queries: strings(flags.query),
    kinds: strings(flags.kind),
    limit,
    market: optionalString(flags.market),
    language: optionalString(flags.language),
    device: device === "desktop" || device === "mobile" ? device : undefined,
    competitors: strings(flags.competitor),
    domains: strings(flags.domain),
    refresh: flags.refresh === true,
    dryRun: extra.dryRun === true,
    allowDirty: extra.allowDirty === true,
    suggestions: optionalString(flags.suggestions),
  };
};

const resultSummary = (result: WorkflowCommandResult): string => {
  const value = result.run.result;
  if (typeof value === "object" && value !== null && "summary" in value) {
    const summary = (value as { readonly summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return `${result.run.workflow} completed.`;
};

/** Run one workflow command after loading the consumer's graph and config. */
export const runWorkflowCommand = async (
  workflow: WorkflowCommandId,
  flags: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<WorkflowCommandResult> => {
  const project = await Effect.runPromise(loadSeoProjectConfig);
  if (project.config.workflows === undefined) {
    throw new Error("seo.config.ts has no workflows configuration; run `pagegraph init` and add it.");
  }

  const configured = optionalString(flags.opencodeConfig);
  const config =
    configured === undefined
      ? project.config
      : {
          ...project.config,
          workflows: {
            ...project.config.workflows,
            opencode: {
              ...project.config.workflows.opencode,
              configDirectory: configured,
            },
          },
        };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const graph = yield* acquireGraph(config);
        const input: WorkflowCommandInput = {
          config,
          graph,
          root: project.root,
          workflow,
          options: optionsFrom(flags, extra),
          model: optionalString(flags.model),
          out: optionalString(flags.out),
        };
        return yield* Effect.promise(() => runWorkflow(input));
      }),
    ),
  );
};

const commandFlags = (flags: FlagSet): FlagSet => flags;

/** Build a workflow leaf while keeping parsing/output behavior identical. */
export const workflowCommand = (input: {
  readonly name: string;
  readonly description: string;
  readonly workflow: WorkflowCommandId;
  readonly exampleArgs: string;
  readonly flags?: FlagSet;
  readonly writesFiles?: boolean;
}) => {
  const flags = commandFlags(input.flags ?? baseFlags);
  const leaf = Command.make(input.name, flags).pipe(
    Command.withDescription(input.description),
    Command.withExamples([
      {
        command: `pagegraph ${input.workflow.replace(".", " ")} ${input.exampleArgs}`,
        description: "Run the workflow and print its human-readable result",
      },
      {
        command: `pagegraph ${input.workflow.replace(".", " ")} ${input.exampleArgs}${input.writesFiles ? " --dry-run" : ""} --json`,
        description: input.writesFiles
          ? "Preview changes and emit the versioned workflow run"
          : "Emit the versioned workflow run for an agent or CI",
      },
    ]),
    Command.withHandler(
      Effect.fnUntraced(function* (rawFlags: Record<string, unknown>) {
        const limit = rawFlags.limit;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
          return yield* new SeoCliError({ message: "--limit must be a positive integer" });
        }
        const extra = input.writesFiles
          ? {
              dryRun: rawFlags.dryRun,
              allowDirty: rawFlags.allowDirty,
            }
          : {};
        const result = yield* Effect.tryPromise({
          try: () => runWorkflowCommand(input.workflow, rawFlags, extra),
          catch: (cause) => new SeoCliError({ message: messageOf(cause) }),
        });
        if (rawFlags.json === true) yield* printJson(result.run);
        else yield* printText(`${resultSummary(result)}\n\nRun artifact: ${result.directory}`);
      }),
    ),
  );
  return leaf;
};

export const researchCommandGroup = Command.make("research").pipe(
  Command.withDescription("Research page-backed organic-search opportunities with OpenCode and Executor"),
  Command.withSubcommands([
    workflowCommand({
      name: "keywords",
      workflow: "research.keywords",
      exampleArgs: '--query "transactional email api" --market us',
      description: "Discover demand, cluster queries, map existing pages, and identify gaps",
      flags: researchFlags,
    }),
    workflowCommand({
      name: "competitors",
      workflow: "research.competitors",
      exampleArgs: '--query "transactional email api" --competitor resend.com',
      description: "Identify search competitors and page or content openings",
      flags: { ...researchFlags, competitor: competitorFlag },
    }),
    workflowCommand({
      name: "authority",
      workflow: "research.authority",
      exampleArgs: "--domain example.com",
      description: "Find and qualify legitimate authority opportunities",
      flags: { ...researchFlags, domain: domainFlag },
    }),
  ]),
);

export {
  baseFlags,
  researchFlags,
  serpFlags,
  queryFlag,
  marketFlag,
  languageFlag,
  deviceFlag,
  dryRunFlag,
  allowDirtyFlag,
};
