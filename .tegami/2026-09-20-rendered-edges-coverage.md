---
packages:
  "pagegraph": patch
---

### Assert contextual coverage on the rendered graph

`pagegraph links verify` now closes the loop between declared and served links:

- `links verify <url> --emit-rendered <path>` writes the crawl's raw edge set as a
  versioned `links-rendered` artifact that preserves each anchor's `region`
  (`body` vs `nav`/`footer`/`header`) and the provenance a gate needs — `origin`,
  `seed`, the rendered page paths, and the crawl's `limit`, `truncated`,
  `bodyTruncated`, and `failures`. It is also a drop-in input for
  `links candidates --rendered`.
- `links verify --rendered <path>` replays a saved artifact instead of crawling, so
  one crawl can be asserted repeatedly without re-fetching.
- `links verify --assert-coverage` evaluates the `seo.config.ts` `coverage` rules
  against the anchors a crawler actually receives. Only same-origin body-region
  anchors count, matching `check`'s `related`-only semantics; the rule universe
  stays the declared graph's sitemap-eligible pages. An unmet rule exits 1, and the
  command refuses to assert — rather than reporting a false pass — on a truncated
  crawl, a page that failed to fetch, a truncated body, a missing `coverage`
  policy, or an origin mismatch.

The default `--json` summary is unchanged; the `coverage` block appears only under
`--assert-coverage`.
