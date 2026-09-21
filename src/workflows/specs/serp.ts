import * as Schema from "effect/Schema";

import { serpFamily, SerpInput } from "../../decide/families/serp";
import { defineWorkflow } from "./types";

const SerpState = Schema.Struct({
  summary: Schema.String,
  items: Schema.Array(SerpInput),
});

export const serpWorkflow = defineWorkflow({
  id: "analyze.serp",
  skills: ["content"],
  mutatesFiles: false,
  stateSchema: SerpState,
  decisionInputs: (state) => state.items,
  family: serpFamily,
  researchInstructions:
    "Compare each target page with a current SERP snapshot for its query. Identify dominant format, intent, title patterns, and cited evidence.",
});
