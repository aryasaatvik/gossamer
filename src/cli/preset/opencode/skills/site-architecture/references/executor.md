# Executor Starters for Site Architecture

These snippets are starting points, not an inventory. Discover owned page/query, crawl, sitemap,
and URL evidence only when the deterministic graph does not answer the question.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console page query canonical indexing", limit: 8 }),
  tools.executor.search({ query: "Bing Webmaster crawl sitemap URL information", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const pages = (await search({ query: "tools.<exact-owned-pages-path>", limit: 1 })).items[0];
return pages.path.split(".").reduce((node, segment) => node[segment], tools)({
  siteUrl,
  startDate,
  endDate,
  dimensions: ["PAGE", "QUERY"],
});
~~~

Keep submitted, crawled, indexed, ranking, and clicked evidence distinct. Record reporting dates,
filters, canonical state, task status, errors, and cost. Do not request indexing, submit sitemaps,
or update provider projects.
