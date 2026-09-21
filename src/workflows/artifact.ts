import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import summaryTemplate from "./prompts/summary.md" with { type: "text" };
import type { WorkflowRunV1 } from "./model";
import { TextTemplate } from "./template";

export const createRunId = (date = new Date(), nonce = randomUUID()): string =>
  `${date.toISOString().replaceAll(":", "-").replace(".", "-")}-${nonce.slice(0, 8)}-keywords`;

const summary = (run: WorkflowRunV1): string => {
  const counts = run.decisions[0]?.counts;
  return TextTemplate.from(summaryTemplate)
    .values({
      runId: run.id,
      model: `${run.model.provider}/${run.model.id}`,
      pages: run.targets.pages.length,
      queries: run.result.opportunities.length,
      decisions: counts?.inputs ?? 0,
      review: counts?.review ?? 0,
      executorSearches: run.evidence.executor.searches.length,
      executorCalls: run.evidence.executor.calls.length,
      summary: run.result.summary,
    })
    .render();
};

export const writeRunBundle = (
  root: string,
  runsDirectory: string,
  run: WorkflowRunV1,
): string => {
  const directory = resolve(root, runsDirectory, run.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(resolve(directory, "summary.md"), summary(run), "utf8");
  return directory;
};
