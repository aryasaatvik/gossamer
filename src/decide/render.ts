/**
 * Human-plane formatter for `pagegraph decide <family>`. Pure string-in/string-
 * out so it is unit-testable; the machine plane (`--json`) bypasses it.
 */

import type { DecisionBatchReport, DecisionRecord } from "./record";

/** One review-queue entry: what was asked, how it landed, and the raw answers. */
const reviewLine = (record: DecisionRecord): string =>
  [`  ${record.inputRef}  ·  ${record.verdict}`, `      ${JSON.stringify(record.answers)}`].join("\n");

/**
 * Human `decide` report: the batch header, a verdict breakdown, and the review
 * queue — the only part a human has to act on.
 */
export const renderDecideReport = (report: DecisionBatchReport): string => {
  const lines: Array<string> = [
    `${report.counts.inputs} input(s) · family ${report.family} · model ${report.model} · threshold ${report.threshold.toFixed(2)}`,
    "",
    `  resolved  ${report.counts.resolved}`,
    `  review    ${report.counts.review}`,
    "",
  ];

  const verdicts = Object.entries(report.verdicts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (verdicts.length > 0) {
    lines.push("Verdicts:", "");
    for (const [verdict, count] of verdicts) lines.push(`  ${verdict.padEnd(20)} ${count}`);
    lines.push("");
  }

  if (report.review.length === 0) {
    lines.push("No inputs need review.");
  } else {
    lines.push(`Review queue (${report.review.length}):`, "");
    for (const record of report.review) lines.push(reviewLine(record), "");
    lines.pop();
  }

  return lines.join("\n").trimEnd();
};
