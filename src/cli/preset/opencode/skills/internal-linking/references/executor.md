# Executor Starters for Internal Linking

These snippets are starting points, not an inventory. PageGraph's graph is primary; discover owned
query/page or crawl evidence only when it resolves ownership or discoverability.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console query page internal ownership", limit: 8 }),
  tools.executor.search({ query: "Bing Webmaster crawl links URL information", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const owned = (await search({ query: "tools.<exact-owned-pages-path>", limit: 1 })).items[0];
return owned.path.split(".").reduce((node, segment) => node[segment], tools)({
  siteUrl,
  startDate,
  endDate,
  dimensions: ["PAGE", "QUERY"],
});
~~~

Record dates, page and query filters, crawl state, task status, errors, and cost. Search performance
can support a graph recommendation but does not override the source content. Do not submit URLs,
request indexing, or mutate provider projects.
