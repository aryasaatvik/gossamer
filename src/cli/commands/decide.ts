/**
 * `pagegraph decide <family>` — the decision runner over a batch. Each family
 * subcommand reads a batch of inputs, answers every decision for an input in one
 * provider call, and separates confident verdicts from `review`.
 *
 * `decide links` is the links family alias of the legacy `pagegraph links decide`.
 * Effect and the TypeSafe provider live only in this CLI-internal command; the
 * library entries stay Effect-free.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import type * as Config from "effect/Config";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";

import { authorityFamily } from "../../decide/families/authority";
import { contentFamily } from "../../decide/families/content";
import { fitFamily } from "../../decide/families/fit";
import { metaFamily } from "../../decide/families/meta";
import { serpFamily } from "../../decide/families/serp";
import { decodeInputsText } from "../../decide/inputs";
import { decodeFamilyInputs, runDecisions, type DecisionFamily } from "../../decide/run";
import { renderDecideReport } from "../../decide/render";
import {
  decideLinks,
  decodeLinkCandidates,
  DEFAULT_LINK_BUDGET,
  type LinkCandidate,
} from "../../links/decide";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import { renderLinksDecideReport } from "../render";

/** Default probability boundary between a confident and an uncertain answer. */
export const DEFAULT_DECIDE_THRESHOLD = 0.7;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const positive = (name: string, value: number): Effect.Effect<number, SeoCliError> =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(new SeoCliError({ message: `--${name} must be a positive integer` }));

const checkThreshold = (value: number): Effect.Effect<number, SeoCliError> =>
  Number.isFinite(value) && value > 0.5 && value < 1
    ? Effect.succeed(value)
    : Effect.fail(
        new SeoCliError({
          message: "--threshold must be greater than 0.5 and less than 1 (a review band needs 1 - t < t)",
        }),
      );

const decideFile = Argument.String("file").pipe(
  Argument.withDescription("JSON batch: an array, { inputs: [...] }, or JSONL (default: stdin)"),
  Argument.optional,
);
const decideThresholdFlag = Flag.Finite("threshold").pipe(
  Flag.withDescription("Probability above which an answer is confident; below is review (0.5 < t < 1)"),
  Flag.withDefault(DEFAULT_DECIDE_THRESHOLD),
);
const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("TypeSafe System One model identifier"),
  Flag.withDefault("jev-latest"),
);
const concurrencyFlag = Flag.Int("concurrency").pipe(
  Flag.withDescription("Maximum concurrent decision calls"),
  Flag.withDefault(4),
);
const cacheFlag = Flag.String("cache").pipe(
  Flag.withDescription("Reuse model answers by input hash; directory for cache files"),
  Flag.optional,
);
const reviewOutFlag = Flag.String("review-out").pipe(
  Flag.withDescription("Write only below-threshold records to this JSON file"),
  Flag.optional,
);
const budgetFlag = Flag.Int("budget").pipe(
  Flag.withDescription("Keep only the top-K candidates per source by relevance"),
  Flag.withDefault(DEFAULT_LINK_BUDGET),
);

/** Read the batch text from a file argument or stdin; a TTY with no file is an error. */
const readInputsText = (file: string | undefined): Effect.Effect<string, SeoCliError> =>
  Effect.try({
    try: () => {
      if (file !== undefined) return readFileSync(file, "utf8");
      if (process.stdin.isTTY) {
        throw new Error("no input file given and stdin is a TTY");
      }
      return readFileSync(0, "utf8");
    },
    catch: (cause) => new SeoCliError({ message: `Could not read inputs: ${messageOf(cause)}` }),
  });

/** Parse the batch text, then schema-decode every input against the family. */
const parseInputs = <Input>(
  family: DecisionFamily<Input>,
  text: string,
): Effect.Effect<ReadonlyArray<Input>, SeoCliError> =>
  Effect.try({
    try: () => decodeFamilyInputs(family, decodeInputsText(text)),
    catch: (cause) => new SeoCliError({ message: `Invalid inputs: ${messageOf(cause)}` }),
  });

/** Apply a family's optional input guard to every decoded input. */
const validateInputs = <Input>(
  family: DecisionFamily<Input>,
  inputs: ReadonlyArray<Input>,
): Effect.Effect<void, SeoCliError> =>
  Effect.gen(function* () {
    if (family.validate === undefined) return;
    for (const input of inputs) {
      const problem = family.validate(input);
      if (problem !== undefined) return yield* new SeoCliError({ message: problem });
    }
  });

const requireKey = (family: string): Effect.Effect<void, SeoCliError> =>
  process.env.TYPESAFE_API_KEY === undefined || process.env.TYPESAFE_API_KEY === ""
    ? Effect.fail(
        new SeoCliError({
          message: `TYPESAFE_API_KEY is not set; \`pagegraph decide ${family}\` answers through TypeSafe System One.`,
        }),
      )
    : Effect.void;

/** TypeSafe System One decision model over the shared fetch HTTP client. */
const typeSafeDecisionModel = (
  model: string,
): Layer.Layer<DecisionModel.DecisionModel, Config.ConfigError> =>
  TypeSafeDecisionModel.model(model).pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.provide(FetchHttpClient.layer),
  );

const decisionErrorMessage = (error: AiError.AiError | Config.ConfigError): SeoCliError =>
  error._tag === "AiError"
    ? new SeoCliError({ message: `Decision request failed (${error.reason._tag}): ${error.message}` })
    : new SeoCliError({ message: `TypeSafe configuration failed: ${error.message}` });

/** Write the below-threshold records to `file`, creating its parent directory. */
const writeReviewRecords = (
  file: string | undefined,
  payload: { readonly family: string; readonly model: string; readonly threshold: number; readonly review: ReadonlyArray<unknown> },
): Effect.Effect<void, SeoCliError> =>
  file === undefined
    ? Effect.void
    : Effect.try({
        try: () => {
          mkdirSync(dirname(resolve(file)), { recursive: true });
          writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        },
        catch: (cause) =>
          new SeoCliError({ message: `Could not write review records to ${file}: ${messageOf(cause)}` }),
      });

/** The flag values every decide subcommand receives. */
interface DecideOptions {
  readonly file: Option.Option<string>;
  readonly json: boolean;
  readonly threshold: number;
  readonly model: string;
  readonly concurrency: number;
  readonly cache: Option.Option<string>;
  readonly reviewOut: Option.Option<string>;
}

/** Run one family over a decoded batch and print its report. */
const runFamily = <Input>(
  family: DecisionFamily<Input>,
  options: DecideOptions,
): Effect.Effect<void, SeoCliError> =>
  Effect.gen(function* () {
    const threshold = yield* checkThreshold(options.threshold);
    const concurrency = yield* positive("concurrency", options.concurrency);
    const text = yield* readInputsText(Option.getOrUndefined(options.file));
    const inputs = yield* parseInputs(family, text);
    yield* validateInputs(family, inputs);
    yield* requireKey(family.name);

    const report = yield* runDecisions({
      family,
      inputs,
      model: options.model,
      threshold,
      concurrency,
      cacheDir: Option.getOrUndefined(options.cache),
    }).pipe(
      Effect.provide(typeSafeDecisionModel(options.model)),
      Effect.mapError(decisionErrorMessage),
    );

    yield* writeReviewRecords(Option.getOrUndefined(options.reviewOut), {
      family: report.family,
      model: report.model,
      threshold: report.threshold,
      review: report.review,
    });

    if (options.json) yield* printJson(report);
    else yield* printText(renderDecideReport(report));
  });

/** Parse the legacy link-candidate batch (array or `{ inputs }`). */
const parseLinks = (text: string): Effect.Effect<ReadonlyArray<LinkCandidate>, SeoCliError> =>
  Effect.try({
    try: () => decodeLinkCandidates(decodeInputsText(text)),
    catch: (cause) => new SeoCliError({ message: `Invalid candidates: ${messageOf(cause)}` }),
  });

/** Flag values `decide links` receives: the shared set plus `--budget`. */
interface LinksDecideOptions {
  readonly file: Option.Option<string>;
  readonly json: boolean;
  readonly threshold: number;
  readonly model: string;
  readonly concurrency: number;
  readonly cache: Option.Option<string>;
  readonly reviewOut: Option.Option<string>;
  readonly budget: number;
}

/** `decide links` — the links family alias over the legacy `links decide` report. */
const runLinks = (options: LinksDecideOptions): Effect.Effect<void, SeoCliError> =>
  Effect.gen(function* () {
    const threshold = yield* checkThreshold(options.threshold);
    const concurrency = yield* positive("concurrency", options.concurrency);
    const budget = yield* positive("budget", options.budget);
    const text = yield* readInputsText(Option.getOrUndefined(options.file));
    const candidates = yield* parseLinks(text);
    yield* requireKey("links");

    const report = yield* decideLinks(candidates, {
      model: options.model,
      threshold,
      concurrency,
      cacheDir: Option.getOrUndefined(options.cache),
      budget,
    }).pipe(
      Effect.provide(typeSafeDecisionModel(options.model)),
      Effect.mapError(decisionErrorMessage),
    );

    yield* writeReviewRecords(Option.getOrUndefined(options.reviewOut), {
      family: "links",
      model: report.model,
      threshold: report.threshold,
      review: report.review,
    });

    if (options.json) yield* printJson(report);
    else yield* printText(renderLinksDecideReport(report));
  });

const decideCommand = (config: {
  readonly name: string;
  readonly description: string;
  readonly examples: ReadonlyArray<{ readonly command: string; readonly description: string }>;
  readonly run: (options: DecideOptions) => Effect.Effect<void, SeoCliError>;
}) =>
  Command.make(config.name, {
    file: decideFile,
    json: jsonFlag,
    threshold: decideThresholdFlag,
    model: modelFlag,
    concurrency: concurrencyFlag,
    cache: cacheFlag,
    reviewOut: reviewOutFlag,
  }).pipe(
    Command.withDescription(config.description),
    Command.withExamples(config.examples),
    Command.withHandler((options) => config.run(options)),
  );

/** Build a family subcommand from its family and help text. */
const familySubcommand = <Input>(
  family: DecisionFamily<Input>,
  config: {
    readonly description: string;
    readonly examples: ReadonlyArray<{ readonly command: string; readonly description: string }>;
  },
) =>
  decideCommand({
    name: family.name,
    description: config.description,
    examples: config.examples,
    run: (options) => runFamily(family, options),
  });

const serpCommand = familySubcommand(serpFamily, {
  description:
    "Classify the SERP format and score our page's fit, intent, and title (aligned | mismatch | review)",
  examples: [
    {
      command: "pagegraph decide serp serp.json",
      description: "Decide a saved SERP snapshot and print the reviewable plan",
    },
    {
      command: "cat serp.json | pagegraph decide serp --json | jq",
      description: "Read the SERP batch from stdin and emit versioned JSON",
    },
  ],
});

const contentCommand = familySubcommand(contentFamily, {
  description:
    "Score a page's content rubric and place its value on thin | adequate | strong (pass | flag | review)",
  examples: [
    {
      command: "pagegraph decide content page.json",
      description: "Decide a page's content quality and print the reviewable plan",
    },
    {
      command: "cat page.json | pagegraph decide content --json | jq",
      description: "Read the content batch from stdin and emit versioned JSON",
    },
  ],
});

const fitCommand = familySubcommand(fitFamily, {
  description:
    "Choose the best existing page for a query, or flag cannibalization or a gap (map | cannibalized | gap | review)",
  examples: [
    {
      command: "pagegraph decide fit candidates.json",
      description: "Rank existing pages for a query and print the reviewable plan",
    },
    {
      command: "cat candidates.json | pagegraph decide fit --json | jq",
      description: "Read the fit batch from stdin and emit versioned JSON",
    },
  ],
});

const metaCommand = familySubcommand(metaFamily, {
  description:
    "Rank supplied title/description candidates for a page (choose:<id> | review)",
  examples: [
    {
      command: "pagegraph decide meta meta.json",
      description: "Rank metadata candidates and print the chosen one or a review",
    },
    {
      command: "cat meta.json | pagegraph decide meta --json | jq",
      description: "Read the meta batch from stdin and emit versioned JSON",
    },
  ],
});

const authorityCommand = familySubcommand(authorityFamily, {
  description:
    "Judge a link target's legitimacy, spam, and outreach worth, plus its fit (accept | spam | review)",
  examples: [
    {
      command: "pagegraph decide authority targets.json",
      description: "Judge a batch of link targets and print the reviewable plan",
    },
    {
      command: "cat targets.json | pagegraph decide authority --json | jq",
      description: "Read the authority batch from stdin and emit versioned JSON",
    },
  ],
});

const linksDecideCommand = Command.make("links", {
  file: decideFile,
  json: jsonFlag,
  threshold: decideThresholdFlag,
  model: modelFlag,
  concurrency: concurrencyFlag,
  cache: cacheFlag,
  reviewOut: reviewOutFlag,
  budget: budgetFlag,
}).pipe(
  Command.withDescription(
    "Answer the links family: real reason, anchor present, direction, and relevance per candidate",
  ),
  Command.withExamples([
    {
      command: "pagegraph decide links candidates.json",
      description: "Answer a candidate batch and print the reviewable plan",
    },
    {
      command: "pagegraph decide links candidates.json --budget 2",
      description: "Keep the top two candidates per source by relevance",
    },
    {
      command: "cat candidates.json | pagegraph decide links --json | jq",
      description: "Read candidates from stdin and emit versioned JSON",
    },
  ]),
  Command.withHandler((options) => runLinks(options)),
);

/**
 * `pagegraph decide` groups the decision families. Each family answers one batch
 * of inputs through TypeSafe System One; confident verdicts resolve, answers in
 * the confidence band go to review, and nothing is applied automatically.
 */
export const decideCommandGroup = Command.make("decide").pipe(
  Command.withDescription("Answer calibrated SEO decisions over a batch with Jev"),
  Command.withExamples([
    {
      command: "pagegraph decide links candidates.json --json | jq",
      description: "Decide a link-candidate batch and emit versioned JSON",
    },
  ]),
  Command.withSubcommands([
    serpCommand,
    contentCommand,
    fitCommand,
    metaCommand,
    authorityCommand,
    linksDecideCommand,
  ]),
);
