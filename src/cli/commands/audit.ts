import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Effect from "effect/Effect";
import * as Flag from "effect/unstable/cli/Flag";
import * as Option from "effect/Option";

import { Audit, AuditLayer } from "../../audit";
import { makeHostedScanner } from "../../audit/scanners/hosted";
import { makeHttpScanner } from "../../audit/scanners/http";
import { makeLighthouseScanner } from "../../audit/scanners/lighthouse";
import { renderAuditMarkdown, writeAuditFiles } from "../../audit/render";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";

const urls = Argument.string("url").pipe(
  Argument.withDescription("One or more absolute http(s) URLs"),
  Argument.variadic({ min: 1 }),
);
const allowPrivate = Flag.boolean("allow-private").pipe(
  Flag.withDescription(
    "Allow localhost and private addresses (local development only)",
  ),
  Flag.withDefault(false),
);
const probeOnly = Flag.boolean("probe-only").pipe(
  Flag.withDescription("Run HTTP probes without Lighthouse"),
  Flag.withDefault(false),
);
const hosted = Flag.boolean("hosted").pipe(
  Flag.withDescription("Opt in to external agent-readiness scanners"),
  Flag.withDefault(false),
);
const formFactor = Flag.choice("form-factor", [
  "mobile",
  "desktop",
] as const).pipe(
  Flag.withDescription("Lighthouse form factor"),
  Flag.withDefault("mobile"),
);
const runs = Flag.integer("runs").pipe(
  Flag.withDescription("Lighthouse runs per target"),
  Flag.withDefault(1),
);
const concurrency = Flag.integer("concurrency").pipe(
  Flag.withDescription("Maximum concurrent target/scanner pairs"),
  Flag.withDefault(4),
);
const requestTimeoutMs = Flag.integer("request-timeout-ms").pipe(
  Flag.withDescription("HTTP request timeout in milliseconds"),
  Flag.withDefault(15_000),
);
const scannerTimeoutMs = Flag.integer("scanner-timeout-ms").pipe(
  Flag.withDescription("Lighthouse and hosted scanner timeout in milliseconds"),
  Flag.withDefault(180_000),
);
const maxBodyBytes = Flag.integer("max-body-bytes").pipe(
  Flag.withDescription("Maximum captured response bytes"),
  Flag.withDefault(2_000_000),
);
const outputDir = Flag.string("output-dir").pipe(
  Flag.withDescription(
    "Atomically write timestamped JSON and Markdown artifacts",
  ),
  Flag.optional,
);

const positive = (
  name: string,
  value: number,
): Effect.Effect<number, SeoCliError> =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new SeoCliError({ message: `--${name} must be a positive integer` }),
      );

export const auditCommand = Command.make("audit", {
  urls,
  json: jsonFlag,
  allowPrivate,
  probeOnly,
  hosted,
  formFactor,
  runs,
  concurrency,
  requestTimeoutMs,
  scannerTimeoutMs,
  maxBodyBytes,
  outputDir,
}).pipe(
  Command.withDescription(
    "Audit any website without a TanStack app or seo.config.ts",
  ),
  Command.withExamples([
    {
      command: "gossamer audit https://example.com",
      description: "HTTP and Lighthouse audit",
    },
    {
      command: "gossamer audit https://example.com --json",
      description: "One JSON report on stdout",
    },
    {
      command: "gossamer audit http://localhost:3000 --allow-private --probe-only",
      description: "Audit a local app",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.audit")(function* (options) {
      const checkedRuns = yield* positive("runs", options.runs);
      const checkedConcurrency = yield* positive(
        "concurrency",
        options.concurrency,
      );
      const checkedRequestTimeout = yield* positive(
        "request-timeout-ms",
        options.requestTimeoutMs,
      );
      const checkedScannerTimeout = yield* positive(
        "scanner-timeout-ms",
        options.scannerTimeoutMs,
      );
      const checkedMaxBody = yield* positive(
        "max-body-bytes",
        options.maxBodyBytes,
      );

      const scanners = [
        makeHttpScanner({
          allowPrivate: options.allowPrivate,
          timeoutMs: checkedRequestTimeout,
          maxBodyBytes: checkedMaxBody,
        }),
        ...(!options.probeOnly
          ? [
              makeLighthouseScanner({
                allowPrivate: options.allowPrivate,
                timeoutMs: checkedScannerTimeout,
              }),
            ]
          : []),
        ...(options.hosted
          ? [
              makeHostedScanner({
                allowPrivate: options.allowPrivate,
                timeoutMs: checkedScannerTimeout,
                maxBodyBytes: checkedMaxBody,
                origins: {
                  isitagentready: "https://isitagentready.com",
                  isAgentic: "https://is-agentic.com",
                },
              }),
            ]
          : []),
      ];

      const report = yield* Effect.gen(function* () {
        const audit = yield* Audit.Service;
        return yield* audit.run({
          targets: [...new Set(options.urls)],
          options: {
            concurrency: checkedConcurrency,
            formFactors: [options.formFactor],
            runs: checkedRuns,
            allowPrivate: options.allowPrivate,
            requestTimeoutMs: checkedRequestTimeout,
            scannerTimeoutMs: checkedScannerTimeout,
            maxBodyBytes: checkedMaxBody,
          },
        });
      }).pipe(
        Effect.provide(AuditLayer(scanners)),
        Effect.mapError((error) => new SeoCliError({ message: error.message })),
      );

      if (options.json) yield* printJson(report);
      else yield* printText(renderAuditMarkdown(report));

      if (Option.isSome(options.outputDir)) {
        const directory = options.outputDir.value;
        const artifacts = yield* Effect.tryPromise({
          try: () => writeAuditFiles(report, directory),
          catch: (cause) =>
            new SeoCliError({
              message: `Could not write audit artifacts: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* Effect.logInfo(
          `Wrote ${artifacts.json} and ${artifacts.markdown}`,
        );
      }

      const structural = report.findings.filter(
        (finding) => finding.severity === "structural",
      );
      const http = report.results.filter((result) => result.scanner === "http");
      if (
        structural.length > 0 ||
        http.every((result) => result.status === "error")
      ) {
        return yield* new SeoCliError({
          message: `${structural.length} structural finding(s); see the report above.`,
        });
      }
    }),
  ),
);
