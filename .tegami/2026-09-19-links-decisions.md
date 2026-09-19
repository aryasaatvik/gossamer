---
packages:
  "pagegraph": minor
---

### Verify and plan contextual links

Add `pagegraph links`, three commands over the link graph:

- `links verify <url>` crawls served HTML and reports homepage depth, rendered
  orphans, and the declared-vs-rendered gap. Anchor extraction honors `<base href>`,
  and the crawl dedupes redirect targets and surfaces truncated bodies.
- `links candidates` proposes reviewable, section-clustered contextual links from
  the declared graph, excluding anchors already rendered, with an optional
  `--decide` pass.
- `links decide` answers real-reason and anchor-present probabilities for a
  candidate set through TypeSafe System One (Jev), routing below-threshold
  answers to human review.

`pagegraph check` also gains `--require-inbound` (with a configurable policy) so a
sitemap-eligible page must have at least N incoming contextual edges.
