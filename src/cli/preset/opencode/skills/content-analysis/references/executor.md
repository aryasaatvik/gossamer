# Executor Starters for Content Analysis

These snippets are starting points, not an inventory. Discover owned query/page performance and
current result-page evidence when they can change the diagnosis.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console query page performance", limit: 8 }),
  tools.executor.search({ query: "OpenSEO current SERP competitor content", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const owned = (await search({ query: "tools.<exact-owned-performance-path>", limit: 1 })).items[0];
return owned.path.split(".").reduce((node, segment) => node[segment], tools)({
  siteUrl,
  startDate,
  endDate,
  dimensions: ["PAGE", "QUERY"],
});
~~~

Keep Search Console or Bing performance separate from provider estimates and live-page
observations. Record reporting dates, filters, market, limits, task status, errors, and cost. Do not
change content or provider state.
