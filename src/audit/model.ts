import { Schema } from "effect";

/** A stable identifier for a scanner, such as `http` or `lighthouse`. */
export type ScannerId = string;

export const formFactors = ["mobile", "desktop"] as const;
export type FormFactor = (typeof formFactors)[number];

export type FindingSeverity = "structural" | "editorial";

export const FindingSeverity = Schema.Literals([
  "structural",
  "editorial",
] as const);

/** A machine-readable audit finding. Values are intentionally open-ended so
 * scanner authors can retain the evidence that led to a finding. */
export const AuditFinding = Schema.Struct({
  scanner: Schema.String,
  target: Schema.String,
  severity: FindingSeverity,
  rule: Schema.String,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
  observed: Schema.optionalKey(Schema.Unknown),
  expected: Schema.optionalKey(Schema.Unknown),
});
export type AuditFinding = typeof AuditFinding.Type;

export const ScannerStatus = Schema.Literals(["ok", "error"] as const);
export type ScannerStatus = typeof ScannerStatus.Type;

/** The result of one scanner against one target. Scanner failures are data in
 * a report rather than an un-attributed failure of the entire audit. */
export const ScannerResult = Schema.Struct({
  scanner: Schema.String,
  target: Schema.String,
  status: ScannerStatus,
  evidence: Schema.optionalKey(Schema.Unknown),
  findings: Schema.Array(AuditFinding),
  error: Schema.optionalKey(Schema.String),
});
export type ScannerResult = typeof ScannerResult.Type;

export const AuditPolicy = Schema.Struct({
  titleMinLength: Schema.optionalKey(Schema.Number),
  titleMaxLength: Schema.optionalKey(Schema.Number),
  descriptionMinLength: Schema.optionalKey(Schema.Number),
  descriptionMaxLength: Schema.optionalKey(Schema.Number),
  requireCanonical: Schema.optionalKey(Schema.Boolean),
});
export type AuditPolicy = typeof AuditPolicy.Type;

/** JSON/Markdown report contract for `gossamer audit`. */
export const AuditReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  targets: Schema.Array(Schema.String),
  results: Schema.Array(ScannerResult),
  findings: Schema.Array(AuditFinding),
  warnings: Schema.Array(Schema.String),
});
export type AuditReport = typeof AuditReport.Type;

export interface AuditTarget {
  readonly url: string;
}

/** Portable HTTP evidence model used by the built-in network scanner. These
 * types stay free of Node and Effect so reports can be rendered in any host. */
export type ProbeKind =
  | "page-head"
  | "page-html"
  | "page-markdown"
  | "robots"
  | "sitemap"
  | "llms"
  | "auth"
  | "integrations"
  | "agent-card"
  | "agent-skills"
  | "oauth-protected-resource"
  | "oauth-authorization-server"
  | "openapi";

export interface ProbeRequest {
  readonly kind: ProbeKind;
  readonly method: "HEAD" | "GET";
  readonly accept: string;
  readonly url: URL;
}

export interface ProbeOptions {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly allowPrivate: boolean;
}

export interface DocumentSignals {
  readonly title: string | null;
  readonly description: string | null;
  readonly canonicalUrl: string | null;
  readonly robots: string | null;
  readonly jsonLdCount: number;
  readonly modulePreloadCount: number;
  readonly scriptCount: number;
  readonly stylesheetCount: number;
  readonly wordCount: number | null;
  readonly jsonValid: boolean | null;
}

export interface HttpProbe {
  readonly kind: ProbeKind;
  readonly method: "HEAD" | "GET";
  readonly accept: string;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly redirects: readonly string[];
  readonly status: number | null;
  readonly ok: boolean;
  readonly headersMs: number | null;
  readonly totalMs: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly capturedBodyBytes: number;
  readonly capturedBodySha256: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyExcerpt: string | null;
  readonly document: DocumentSignals | null;
  readonly error: string | null;
}

export interface AuditOptions {
  readonly concurrency?: number;
  readonly policy?: AuditPolicy;
  readonly formFactors?: readonly FormFactor[];
  readonly runs?: number;
  readonly lighthouse?: boolean;
  readonly scanners?: boolean;
  readonly requestTimeoutMs?: number;
  readonly scannerTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly allowPrivate?: boolean;
  readonly scannerOrigins?: Readonly<Record<string, string>>;
  readonly targets?: readonly URL[];
  readonly [key: string]: unknown;
}

export interface LighthouseMetric {
  readonly id: string;
  readonly title: string;
  readonly numericValue: number | null;
  readonly numericUnit: string | null;
  readonly displayValue: string | null;
  readonly score: number | null;
}

export interface LighthouseCategory {
  readonly id: string;
  readonly title: string;
  readonly score: number | null;
}

export interface LighthouseOpportunity {
  readonly id: string;
  readonly title: string;
  readonly displayValue: string | null;
  readonly savingsMs: number | null;
  readonly savingsBytes: number | null;
}

export interface LighthouseRun {
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly formFactor: FormFactor;
  readonly run: number;
  readonly lighthouseVersion: string | null;
  readonly userAgent: string | null;
  readonly fetchTime: string | null;
  readonly categories: Readonly<Record<string, LighthouseCategory>>;
  readonly metrics: Readonly<Record<string, LighthouseMetric>>;
  readonly opportunities: readonly LighthouseOpportunity[];
  readonly warnings: readonly string[];
  readonly error: string | null;
}
