import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  AuditFinding,
  AuditOptions,
  AuditReport,
  ScannerResult,
} from "./model";
import { evaluateRules, pageRules } from "./rules";
import { ScannerRegistry } from "./scanner-registry";
import type { Scanner, ScannerInput } from "./scanner";

export class InvalidTarget extends Data.TaggedError("InvalidTarget")<{
  readonly target: string;
  readonly message: string;
}> {}

export type AuditError = InvalidTarget;

export interface AuditRequest {
  readonly targets: readonly string[];
  readonly options?: AuditOptions;
  readonly scanners?: readonly string[];
}

export interface AuditService {
  readonly run: (
    request: AuditRequest,
  ) => Effect.Effect<AuditReport, AuditError>;
}

export namespace Audit {
  export class Service extends Context.Service<Service, AuditService>()(
    "pagegraph/Audit",
  ) {}
}

const validateTarget = (
  target: string,
): Effect.Effect<{ readonly url: string }, InvalidTarget> =>
  Effect.try({
    try: () => {
      const url = new URL(target);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("only http and https URLs are supported");
      }
      if (url.username || url.password) {
        throw new Error("credentials in URLs are not supported");
      }
      return { url: url.toString() };
    },
    catch: (cause) =>
      new InvalidTarget({
        target,
        message: cause instanceof Error ? cause.message : "invalid URL",
      }),
  });

const runOne = Effect.fn("Audit.runScanner")(function* (
  scanner: Scanner,
  target: { readonly url: string },
  options: AuditOptions,
): Effect.fn.Return<ScannerResult> {
  const input: ScannerInput = { target, options };
  const result = yield* scanner.scan(input).pipe(
    Effect.map((observation) => ({
      scanner: scanner.id,
      target: target.url,
      status: "ok" as const,
      ...(observation.evidence === undefined
        ? {}
        : { evidence: observation.evidence }),
      // Page metadata rules apply to the HTTP page evidence only. Lighthouse
      // and hosted scanners have different evidence domains and must not emit
      // false missing-title/description findings.
      findings: [
        ...(observation.findings ?? []),
        ...evaluateRules(
          [
            ...(scanner.rules ?? []),
            ...(scanner.id === "http" ? pageRules : []),
          ],
          observation,
          input,
        ),
      ],
    })),
    Effect.catchTag("ScannerFailure", (error) =>
      Effect.succeed({
        scanner: scanner.id,
        target: target.url,
        status: "error" as const,
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  return result;
});

const runAudit = Effect.fn("Audit.run")(function* (
  registry: ScannerRegistry.Service["Service"],
  request: AuditRequest,
) {
  const targets = yield* Effect.forEach(request.targets, validateTarget);
  const options = {
    ...defaultOptions,
    ...(request.options ?? {}),
    policy: { ...defaultOptions.policy, ...(request.options?.policy ?? {}) },
  };
  const available = registry.all();
  const scanners =
    request.scanners === undefined
      ? available
      : available.filter((scanner) => request.scanners!.includes(scanner.id));
  const pairs = targets.flatMap((target) =>
    scanners.map((scanner) => ({ target, scanner })),
  );
  const results = yield* Effect.forEach(
    pairs,
    ({ target, scanner }) => runOne(scanner, target, options),
    { concurrency: Math.max(1, Math.floor(options.concurrency ?? 4)) },
  );
  const findings: AuditFinding[] = results.flatMap((result) => result.findings);
  const warnings = results
    .filter((result) => result.status === "error")
    .map(
      (result) =>
        `${result.scanner} failed for ${result.target}: ${result.error ?? "unknown error"}`,
    );
  const generatedAt = yield* Effect.clockWith((clock) =>
    Effect.map(clock.currentTimeMillis, (millis) =>
      new Date(millis).toISOString(),
    ),
  );
  return {
    schemaVersion: 1 as const,
    generatedAt,
    targets: targets.map(({ url }) => url),
    results,
    findings,
    warnings,
  };
});

const defaultOptions: Required<Pick<AuditOptions, "concurrency" | "policy">> = {
  concurrency: 4,
  policy: {
    titleMinLength: 10,
    titleMaxLength: 70,
    descriptionMinLength: 50,
    descriptionMaxLength: 160,
    requireCanonical: true,
  },
};

export const makeAudit = (
  registry: ScannerRegistry.Service["Service"],
): AuditService => ({
  run: (request) => runAudit(registry, request),
});

export const AuditLive = Layer.effect(
  Audit.Service,
  Effect.map(ScannerRegistry.Service, makeAudit),
);
