import { Data, Schema } from "effect";

import {
  AuditFinding,
  FindingSeverity,
  ScannerStatus,
  type AuditReport,
} from "./model";

const DiffFindingGroup = Schema.Struct({
  target: Schema.String,
  scanner: Schema.String,
  rule: Schema.String,
  severity: FindingSeverity,
  findings: Schema.Array(AuditFinding),
});

const FindingAdded = Schema.TaggedStruct("FindingAdded", {
  group: DiffFindingGroup,
});
const FindingRemoved = Schema.TaggedStruct("FindingRemoved", {
  group: DiffFindingGroup,
});
const FindingChanged = Schema.TaggedStruct("FindingChanged", {
  target: Schema.String,
  scanner: Schema.String,
  rule: Schema.String,
  beforeSeverity: FindingSeverity,
  afterSeverity: FindingSeverity,
  before: Schema.Array(AuditFinding),
  after: Schema.Array(AuditFinding),
});
const ScannerDegraded = Schema.TaggedStruct("ScannerDegraded", {
  target: Schema.String,
  scanner: Schema.String,
});
const ScannerRecovered = Schema.TaggedStruct("ScannerRecovered", {
  target: Schema.String,
  scanner: Schema.String,
});
const TargetAdded = Schema.TaggedStruct("TargetAdded", {
  target: Schema.String,
});
const TargetRemoved = Schema.TaggedStruct("TargetRemoved", {
  target: Schema.String,
});
const ScannerAdded = Schema.TaggedStruct("ScannerAdded", {
  target: Schema.String,
  scanner: Schema.String,
  status: ScannerStatus,
});
const ScannerRemoved = Schema.TaggedStruct("ScannerRemoved", {
  target: Schema.String,
  scanner: Schema.String,
});

/** One normalized semantic change between two audit reports. */
export const AuditDiffChange = Schema.Union([
  FindingAdded,
  FindingRemoved,
  FindingChanged,
  ScannerDegraded,
  ScannerRecovered,
  TargetAdded,
  TargetRemoved,
  ScannerAdded,
  ScannerRemoved,
]).pipe(Schema.toTaggedUnion("_tag"));
export type AuditDiffChange = typeof AuditDiffChange.Type;

export const AuditDiffOutcome = Schema.Literals([
  "unchanged",
  "changed",
  "regressed",
] as const);
export type AuditDiffOutcome = typeof AuditDiffOutcome.Type;

export const AuditDiffSummary = Schema.Struct({
  structuralRegressions: Schema.Number,
  editorialRegressions: Schema.Number,
  scannerRegressions: Schema.Number,
  coverageRegressions: Schema.Number,
  improvements: Schema.Number,
  informationalChanges: Schema.Number,
});
export type AuditDiffSummary = typeof AuditDiffSummary.Type;

const AuditDiffSource = Schema.Struct({
  reportSchemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  targets: Schema.Array(Schema.String),
});

/** Versioned machine-readable contract emitted by `gossamer diff --json`. */
export const AuditDiff = Schema.Struct({
  kind: Schema.Literal("audit-diff"),
  schemaVersion: Schema.Literal(1),
  before: AuditDiffSource,
  after: AuditDiffSource,
  outcome: AuditDiffOutcome,
  summary: AuditDiffSummary,
  changes: Schema.Array(AuditDiffChange),
  ignored: Schema.Tuple([
    Schema.Literal("generatedAt"),
    Schema.Literal("warnings"),
    Schema.Literal("results[].evidence"),
  ]),
});
export type AuditDiff = typeof AuditDiff.Type;

export type AuditComparisonResult = Data.TaggedEnum<{
  Success: { readonly diff: AuditDiff };
  InvalidReport: { readonly issues: ReadonlyArray<string> };
}>;
export const AuditComparisonResult = Data.taggedEnum<AuditComparisonResult>();

type FindingGroup = {
  readonly target: string;
  readonly scanner: string;
  readonly rule: string;
  readonly severity: FindingSeverity;
  readonly findings: ReadonlyArray<AuditFinding>;
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const tupleKey = (...parts: ReadonlyArray<string>): string =>
  JSON.stringify(parts);

const severityOf = (
  findings: ReadonlyArray<AuditFinding>,
): FindingSeverity =>
  findings.some((finding) => finding.severity === "structural")
    ? "structural"
    : "editorial";

const findingsByIdentity = (
  findings: ReadonlyArray<AuditFinding>,
): Map<string, FindingGroup> => {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const key = tupleKey(finding.target, finding.scanner, finding.rule);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  return new Map(
    [...groups.entries()].map(([key, group]) => {
      const sorted = group.toSorted((left, right) =>
        compareStrings(canonicalJson(left), canonicalJson(right)),
      );
      const first = sorted[0]!;
      return [
        key,
        {
          target: first.target,
          scanner: first.scanner,
          rule: first.rule,
          severity: severityOf(sorted),
          findings: sorted,
        },
      ];
    }),
  );
};

const validateReport = (
  label: "before" | "after",
  report: AuditReport,
): ReadonlyArray<string> => {
  const issues: string[] = [];
  const targets = new Set<string>();
  for (const target of report.targets) {
    if (targets.has(target)) issues.push(`${label}: duplicate target ${target}`);
    targets.add(target);
  }

  const results = new Set<string>();
  for (const result of report.results) {
    if (!targets.has(result.target)) {
      issues.push(
        `${label}: scanner ${result.scanner} references undeclared target ${result.target}`,
      );
    }
    const key = tupleKey(result.target, result.scanner);
    if (results.has(key)) {
      issues.push(
        `${label}: duplicate scanner result ${result.scanner} for ${result.target}`,
      );
    }
    results.add(key);
    for (const finding of result.findings) {
      if (finding.target !== result.target) {
        issues.push(
          `${label}: finding ${finding.rule} targets ${finding.target} inside result for ${result.target}`,
        );
      }
    }
  }

  const flattened = report.results
    .flatMap((result) => result.findings)
    .map(canonicalJson)
    .sort(compareStrings);
  const topLevel = report.findings.map(canonicalJson).sort(compareStrings);
  if (canonicalJson(flattened) !== canonicalJson(topLevel)) {
    issues.push(`${label}: top-level findings do not match result findings`);
  }

  return issues;
};

const resultMap = (report: AuditReport) =>
  new Map(
    report.results.map((result) => [
      tupleKey(result.target, result.scanner),
      result,
    ]),
  );

const changeSortKey = (change: AuditDiffChange): string => {
  switch (change._tag) {
    case "FindingAdded":
    case "FindingRemoved":
      return tupleKey(
        change.group.target,
        change.group.scanner,
        change.group.rule,
        change._tag,
      );
    case "FindingChanged":
      return tupleKey(change.target, change.scanner, change.rule, change._tag);
    case "ScannerAdded":
    case "ScannerRemoved":
    case "ScannerDegraded":
    case "ScannerRecovered":
      return tupleKey(change.target, change.scanner, "", change._tag);
    case "TargetAdded":
    case "TargetRemoved":
      return tupleKey(change.target, "", "", change._tag);
  }
};

const summarize = (changes: ReadonlyArray<AuditDiffChange>): AuditDiffSummary => {
  let structuralRegressions = 0;
  let editorialRegressions = 0;
  let scannerRegressions = 0;
  let coverageRegressions = 0;
  let improvements = 0;
  let informationalChanges = 0;

  for (const change of changes) {
    switch (change._tag) {
      case "FindingAdded":
        if (change.group.severity === "structural") structuralRegressions++;
        else editorialRegressions++;
        break;
      case "FindingRemoved":
      case "ScannerRecovered":
        improvements++;
        break;
      case "FindingChanged":
        if (
          change.beforeSeverity === "editorial" &&
          change.afterSeverity === "structural"
        ) {
          structuralRegressions++;
        } else if (
          change.beforeSeverity === "structural" &&
          change.afterSeverity === "editorial"
        ) {
          improvements++;
        } else {
          informationalChanges++;
        }
        break;
      case "ScannerDegraded":
        scannerRegressions++;
        break;
      case "TargetRemoved":
      case "ScannerRemoved":
        coverageRegressions++;
        break;
      case "TargetAdded":
        informationalChanges++;
        break;
      case "ScannerAdded":
        if (change.status === "error") scannerRegressions++;
        else informationalChanges++;
        break;
    }
  }

  return {
    structuralRegressions,
    editorialRegressions,
    scannerRegressions,
    coverageRegressions,
    improvements,
    informationalChanges,
  };
};

const outcomeOf = (
  summary: AuditDiffSummary,
  changes: ReadonlyArray<AuditDiffChange>,
): AuditDiffOutcome => {
  if (
    summary.structuralRegressions > 0 ||
    summary.scannerRegressions > 0 ||
    summary.coverageRegressions > 0
  ) {
    return "regressed";
  }
  return changes.length > 0 ? "changed" : "unchanged";
};

/** Compare two decoded audit reports while ignoring non-semantic scanner evidence. */
export const compareAuditReports = (
  before: AuditReport,
  after: AuditReport,
): AuditComparisonResult => {
  const issues = [
    ...validateReport("before", before),
    ...validateReport("after", after),
  ];
  if (issues.length > 0) return AuditComparisonResult.InvalidReport({ issues });

  const changes: AuditDiffChange[] = [];
  const beforeTargets = new Set(before.targets);
  const afterTargets = new Set(after.targets);
  for (const target of beforeTargets) {
    if (!afterTargets.has(target)) changes.push({ _tag: "TargetRemoved", target });
  }
  for (const target of afterTargets) {
    if (!beforeTargets.has(target)) changes.push({ _tag: "TargetAdded", target });
  }

  const beforeResults = resultMap(before);
  const afterResults = resultMap(after);
  for (const [key, result] of beforeResults) {
    const next = afterResults.get(key);
    if (next === undefined) {
      changes.push({
        _tag: "ScannerRemoved",
        target: result.target,
        scanner: result.scanner,
      });
    } else if (result.status === "ok" && next.status === "error") {
      changes.push({
        _tag: "ScannerDegraded",
        target: result.target,
        scanner: result.scanner,
      });
    } else if (result.status === "error" && next.status === "ok") {
      changes.push({
        _tag: "ScannerRecovered",
        target: result.target,
        scanner: result.scanner,
      });
    }
  }
  for (const [key, result] of afterResults) {
    if (!beforeResults.has(key)) {
      changes.push({
        _tag: "ScannerAdded",
        target: result.target,
        scanner: result.scanner,
        status: result.status,
      });
    }
  }

  const beforeFindings = findingsByIdentity(before.findings);
  const afterFindings = findingsByIdentity(after.findings);
  for (const [key, group] of beforeFindings) {
    const next = afterFindings.get(key);
    if (next === undefined) {
      changes.push({ _tag: "FindingRemoved", group });
    } else if (
      canonicalJson(group.findings) !== canonicalJson(next.findings)
    ) {
      changes.push({
        _tag: "FindingChanged",
        target: group.target,
        scanner: group.scanner,
        rule: group.rule,
        beforeSeverity: group.severity,
        afterSeverity: next.severity,
        before: group.findings,
        after: next.findings,
      });
    }
  }
  for (const [key, group] of afterFindings) {
    if (!beforeFindings.has(key)) {
      changes.push({ _tag: "FindingAdded", group });
    }
  }

  changes.sort((left, right) =>
    compareStrings(changeSortKey(left), changeSortKey(right)),
  );
  const summary = summarize(changes);
  const targets = (report: AuditReport) => report.targets.toSorted(compareStrings);
  return AuditComparisonResult.Success({
    diff: {
      kind: "audit-diff",
      schemaVersion: 1,
      before: {
        reportSchemaVersion: 1,
        generatedAt: before.generatedAt,
        targets: targets(before),
      },
      after: {
        reportSchemaVersion: 1,
        generatedAt: after.generatedAt,
        targets: targets(after),
      },
      outcome: outcomeOf(summary, changes),
      summary,
      changes,
      ignored: ["generatedAt", "warnings", "results[].evidence"],
    },
  });
};
