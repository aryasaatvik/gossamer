---
packages:
  "pagegraph": patch
---

### Attribute Executor evidence from structured search results

PageGraph now recognizes tool identifiers returned in Executor search-result `path` fields, including
JSON-encoded output, so valid provider calls satisfy the workflow evidence gate. Discovery stays
limited to those structured fields, preventing unrelated dotted metadata from authorizing a call.
