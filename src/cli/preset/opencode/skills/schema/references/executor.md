# Executor Starters for Schema

These snippets are starting points, not an inventory. Discover owned search-appearance, URL
inspection, rich-result, or documentation tools when they can change the eligibility assessment.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console search appearance page", limit: 8 }),
  tools.executor.search({ query: "URL inspection rich results structured data eligibility", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const appearance = (await search({ query: "tools.<exact-search-appearance-path>", limit: 1 })).items[0];
return appearance.path.split(".").reduce((node, segment) => node[segment], tools)({
  siteUrl,
  startDate,
  endDate,
  dimensions: ["SEARCH_APPEARANCE", "PAGE"],
});
~~~

Treat visible page content and current primary requirements as eligibility authority. Record dates,
page filters, result types, task status, errors, and cost. Do not request indexing, submit schemas,
or update provider projects.
