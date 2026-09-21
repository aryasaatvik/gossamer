import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WorkflowRunV1 } from "./model";

export const createRunId = (date = new Date()): string =>
  `${date.toISOString().replaceAll(":", "-").replace(".", "-")}-keywords`;

const summary = (run: WorkflowRunV1): string => {
  const counts = run.decisions[0]?.counts;
  return `# PageGraph keyword research

- Run: \`${run.id}\`
- Model: \`${run.model.provider}/${run.model.id}\`
- Pages: ${run.targets.pages.length}
- Queries: ${run.result.opportunities.length}
- Decisions: ${counts?.inputs ?? 0} (${counts?.review ?? 0} review)
- Executor records: ${run.evidence.executor.length}

${run.result.summary}
`;
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
