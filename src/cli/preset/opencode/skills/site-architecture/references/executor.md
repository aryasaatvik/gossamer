# Executor Starters for Site Architecture

These snippets are starting points, not an inventory. Discover owned page/query, crawl, sitemap,
and URL evidence only when the deterministic graph does not answer the question.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Search Console page performance", limit: 8 }),
  tools.executor.search({ query: "Bing Webmaster crawl", limit: 8 }),
]);
~~~

Inspect a selected tool's signature before executing it. This is Code Mode's local schema lookup;
it does not call the provider:

~~~ts
return await search({ query: "tools.<exact-path-returned-by-executor>", limit: 1 });
~~~

In a later turn, call that exact path with the required fields from its returned signature. Property,
project, URL, date, and dimension arguments differ between integrations. Do not copy guessed fields
from a recipe. Prefer page/query performance for demand and ownership questions; use URL inspection
when the question actually concerns crawl, canonical, or indexing state.

Keep submitted, crawled, indexed, ranking, and clicked evidence distinct. Record reporting dates,
filters, canonical state, task status, errors, and cost. Do not request indexing, submit sitemaps,
or update provider projects.
