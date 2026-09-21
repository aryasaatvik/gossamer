import * as Schema from "effect/Schema";

import { contentFamily, ContentInput } from "../../decide/families/content";
import { defineWorkflow } from "./types";

const ContentState = Schema.Struct({
  summary: Schema.String,
  items: Schema.Array(ContentInput),
});

export const contentWorkflow = defineWorkflow({
  id: "analyze.content",
  skills: ["content-analysis"],
  mutatesFiles: false,
  stateSchema: ContentState,
  decisionInputs: (state) => state.items,
  family: contentFamily,
  researchInstructions:
    "Inspect page content, sibling intent, structured data, and competitive excerpts. Judge substance and answer quality from supplied evidence.",
});

export const improveContentWorkflow = defineWorkflow({
  id: "improve.content",
  skills: ["content-improvement"],
  mutatesFiles: true,
  stateSchema: ContentState,
  decisionInputs: (state) => state.items,
  family: contentFamily,
  researchInstructions:
    "Inspect the target page and its supporting research before proposing a bounded content improvement.",
  actionInstructions:
    "Apply only evidence-backed copy edits that preserve the page's category, intent, and public product claims; leave the diff uncommitted.",
});
