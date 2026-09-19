/**
 * Read a rendered `<head>` and validate it: title, meta
 * (description/robots/og/twitter), canonical link, and `application/ld+json`
 * blocks, with a minimal per-type JSON-LD check.
 *
 * This is the pure half of `gossamer inspect --live` — the half worth having on its
 * own. The CLI fetches a URL and hands the body here; a test suite can render a
 * page and hand *that* here, asserting the head it actually ships. Both get the
 * same verdict, because it is the same function.
 *
 * No HTML-parsing dependency, by design: a `<head>` is small and well-formed, so
 * string/regex scanning is enough, and the package's core stays zero-dependency
 * (which is also why the object guard below is hand-rolled — `effect/Predicate`
 * is not reachable from this entry). It is honest about its limits: it does not
 * build a DOM, so exotic markup (commented-out tags, CDATA, attributes spanning
 * constructs) is out of scope. This validates *rendered output*, not arbitrary
 * HTML.
 *
 * `issues` are blocking: a non-empty list makes `gossamer inspect --live` exit 1.
 * Required tags are `<title>`, `meta[name=description]`, and
 * `link[rel=canonical]`; any JSON-LD that fails to parse or fails its minimal
 * schema is also blocking.
 */

export interface JsonLdReport {
  type: string;
  valid: boolean;
  errors: Array<string>;
}

export interface LiveHeadReport {
  url: string;
  status: number;
  title?: string | undefined;
  description?: string | undefined;
  canonical?: string | undefined;
  robots?: string | undefined;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLd: Array<JsonLdReport>;
  issues: Array<string>;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

const decodeEntities = (value: string): string =>
  value.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (match) => ENTITIES[match] ?? match);

/** Pull double/single-quoted attributes off a single tag string. */
const parseAttrs = (tag: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
};

/** Normalize a JSON-LD `@type` (string or array) to a single readable label. */
const typeName = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.filter((v) => typeof v === "string").join(", ") || "unknown";
  return "unknown";
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  // NOTE: This zero-dependency core entry cannot import Effect; JSON-LD validation happens immediately after this shallow narrowing.
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Flatten a parsed JSON-LD payload (single object, array, or `@graph`) to items. */
const collectItems = (parsed: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (isObject(parsed)) {
    if (Array.isArray(parsed["@graph"])) return parsed["@graph"].filter(isObject);
    return [parsed];
  }
  return [];
};

const countQuestions = (mainEntity: unknown): number => {
  if (!Array.isArray(mainEntity)) return 0;
  return mainEntity.filter((entry) => isObject(entry) && typeName(entry["@type"]) === "Question")
    .length;
};

const validateItemListElements = (value: unknown): Array<string> => {
  if (!Array.isArray(value) || value.length < 1) {
    return ["ItemList needs at least one `itemListElement` entry."];
  }
  const errors: Array<string> = [];
  value.forEach((entry, index) => {
    if (!isObject(entry) || typeName(entry["@type"]) !== "ListItem") {
      errors.push(`ItemList entry ${index + 1} is not a ListItem.`);
      return;
    }
    if (entry["position"] !== index + 1) {
      errors.push(`ItemList entry ${index + 1} has an invalid position.`);
    }
    if (!entry["name"] || !entry["url"]) {
      errors.push(`ItemList entry ${index + 1} needs a name and URL.`);
    }
  });
  return errors;
};

/** Minimal per-type validation — enough to catch an empty or malformed block. */
const validateItem = (item: Record<string, unknown>): JsonLdReport => {
  const type = typeName(item["@type"]);
  const errors: Array<string> = [];

  if (type === "Article" || type === "NewsArticle" || type === "BlogPosting") {
    if (!item["headline"]) errors.push("Article is missing `headline`.");
    if (!item["datePublished"]) errors.push("Article is missing `datePublished`.");
  } else if (type === "FAQPage") {
    if (countQuestions(item["mainEntity"]) < 1) {
      errors.push("FAQPage needs at least one Question in `mainEntity`.");
    }
  } else if (type === "BreadcrumbList") {
    const items = item["itemListElement"];
    if (!Array.isArray(items) || items.length < 2) {
      errors.push("BreadcrumbList needs at least two `itemListElement` entries.");
    }
  } else if (type === "ItemList") {
    errors.push(...validateItemListElements(item["itemListElement"]));
    const items = item["itemListElement"];
    if (Array.isArray(items) && item["numberOfItems"] !== items.length) {
      errors.push("ItemList `numberOfItems` does not match its entries.");
    }
  }

  return { type, valid: errors.length === 0, errors };
};

const validateLdJson = (raw: string): Array<JsonLdReport> => {
  let parsed: unknown;
  // NOTE: JSON.parse boundary: converts the native parse throw into an unparseable JsonLdReport value in a pure sync validator
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return [
      {
        type: "unparseable",
        valid: false,
        errors: [`JSON parse error: ${cause instanceof Error ? cause.message : String(cause)}`],
      },
    ];
  }
  const items = collectItems(parsed);
  if (items.length === 0) {
    return [{ type: "unknown", valid: false, errors: ["No JSON-LD object found in block."] }];
  }
  return items.map(validateItem);
};

/** Parse a rendered HTML document's `<head>` into a report. Pure. */
export const inspectHtml = (url: string, status: number, html: string): LiveHeadReport => {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1]! : html;

  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : undefined;

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let description: string | undefined;
  let robots: string | undefined;

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag);
    const content = attrs["content"];
    if (content === undefined) continue;
    const property = attrs["property"];
    const name = attrs["name"];
    if (property?.startsWith("og:")) og[property] = content;
    else if (name?.startsWith("twitter:")) twitter[name] = content;
    else if (name === "description") description = content;
    else if (name === "robots") robots = content;
  }

  let canonical: string | undefined;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag);
    if (attrs["rel"] === "canonical") canonical = attrs["href"];
  }

  const jsonLd: Array<JsonLdReport> = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRe.exec(head)) !== null) {
    jsonLd.push(...validateLdJson(scriptMatch[1]!.trim()));
  }

  const issues: Array<string> = [];
  if (status >= 400) issues.push(`Fetch returned HTTP ${status}.`);
  if (!title) issues.push("Missing <title>.");
  if (!description) issues.push("Missing meta description.");
  if (!canonical) issues.push("Missing canonical link.");
  for (const block of jsonLd) {
    if (!block.valid)
      issues.push(...block.errors.map((error) => `JSON-LD (${block.type}): ${error}`));
  }

  return { url, status, title, description, canonical, robots, og, twitter, jsonLd, issues };
};

/** A non-empty `issues` list fails `gossamer inspect --live` (exit 1). */
export const hasBlockingIssues = (report: LiveHeadReport): boolean => report.issues.length > 0;
