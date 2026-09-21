import * as Schema from "effect/Schema";

import { authorityFamily, AuthorityInput } from "../../decide/families/authority";
import { defineWorkflow } from "./types";

const AuthorityState = Schema.Struct({
  summary: Schema.String,
  items: Schema.Array(AuthorityInput),
});

export const authorityWorkflow = defineWorkflow({
  id: "research.authority",
  skills: ["authority"],
  mutatesFiles: false,
  stateSchema: AuthorityState,
  decisionInputs: (state) => state.items,
  family: authorityFamily,
  researchInstructions:
    "Discover and qualify legitimate directory, editorial, partner, and community opportunities. Preserve source URLs and signals for every candidate.",
});
