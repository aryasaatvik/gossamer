---
packages:
  "pagegraph": minor
---

### Answer SEO decisions with Jev

Add a reusable decision runner and five typed decision families, answered in one
TypeSafe System One call per input. Confident answers produce a plan; answers
inside the confidence band go to a review queue. Nothing is applied automatically.

- `pagegraph decide serp` — classify the SERP format and score our page's fit,
  intent, and title (aligned | mismatch | review).
- `pagegraph decide content` — score the content rubric and place page value on
  thin | adequate | strong (pass | flag | review).
- `pagegraph decide fit` — choose the best existing page for a query, or flag
  cannibalization or a gap (map | cannibalized | gap | review).
- `pagegraph decide meta` — rank supplied title/description candidates
  (choose:<id> | review).
- `pagegraph decide authority` — judge a link target's legitimacy, spam, and
  outreach worth, plus its fit (accept | spam | review).
- `pagegraph decide links` (and the retained `links decide`) — real reason,
  anchor present, direction (A→B / B→A / both), and relevance, with top-K
  per-source budget selection.

Shared flags: `--model`, `--threshold`, `--concurrency`, `--cache`, `--review-out`,
and `--budget` for links. Every record carries the model id and an input hash.
