import * as Schema from "effect/Schema";

import { metaFamily, MetaInput } from "../../decide/families/meta";
import { defineWorkflow } from "./types";

const MetadataState = Schema.Struct({
  summary: Schema.String,
  items: Schema.Array(MetaInput),
});

export const metadataWorkflow = defineWorkflow({
  id: "improve.metadata",
  skills: ["metadata-improvement"],
  mutatesFiles: true,
  stateSchema: MetadataState,
  decisionInputs: (state) => state.items,
  family: metaFamily,
  researchInstructions:
    "Inspect route intent, current head metadata, and the supplied candidate titles and descriptions before selecting a bounded improvement.",
  actionInstructions:
    "Apply the selected metadata candidate to the owning route or Fumadocs source, preserve truthful claims, and leave the diff uncommitted.",
});
