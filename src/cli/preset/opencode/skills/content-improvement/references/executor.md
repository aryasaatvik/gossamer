# Executor Starters for Content Improvement

These snippets are starting points, not an inventory. Discover owned performance and current SERP
evidence during the read-only research turn.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console page query performance", limit: 8 }),
  tools.executor.search({ query: "OpenSEO current SERP intent competitor pages", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const serp = (await search({ query: "tools.<exact-serp-path>", limit: 1 })).items[0];
return serp.path.split(".").reduce((node, segment) => node[segment], tools)({
  query,
  market,
  language,
  device,
});
~~~

Record market, language, device, dates, limits, task status, errors, and cost. Search evidence may
support a source edit only after the host evaluates it; never edit during research or write to an
OpenSEO project.
