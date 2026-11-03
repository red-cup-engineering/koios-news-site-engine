/**
 * Discovery surfaces a crawler, a card renderer or an answer engine reads before
 * it reads an article: the home description, parent organizations, robots.txt
 * with explicit crawler groups, llms.txt and RFC 9116 security.txt. Pure
 * functions of the property record and the built corpus; no I/O.
 */

/** The AI and answer-engine crawlers robots.txt names explicitly (all allowed). */
export const AI_CRAWLERS = Object.freeze([
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot",
  "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot",
]);

/** Koios.News is a Causeway Services (public media) publication of the 561 Group. */
export const DEFAULT_PARENT_ORGANIZATIONS = Object.freeze([
  Object.freeze({ name: "Causeway Services", url: "https://services.561.group/" }),
  Object.freeze({ name: "561 Group", url: "https://561.group/" }),
]);

export const DEFAULT_SECURITY_CONTACT = "cto@561.group";
const SECURITY_VALIDITY_DAYS = 330;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;

/**
 * The home page's meta description: `property.description` when set, else the
 * tagline, lengthened with what the newsroom publishes when the tagline alone
 * is too short to describe a page (search snippets want 50-160 characters).
 * @param {object} property
 * @returns {string}
 */
export function homeDescription(property) {
  const explicit = typeof property.description === "string" ? property.description.trim() : "";
  if (explicit) return explicit;
  const tagline = (property.tagline ?? "").trim();
  if (tagline.length >= DESCRIPTION_MIN) return tagline;
  const desks = (property.sections ?? []).length;
  const detail = desks > 0 ? `Sourced reporting from ${desks} desks, with RSS, Atom and JSON feeds.` : "Sourced reporting with RSS, Atom and JSON feeds.";
  const composed = tagline ? `${tagline} ${detail}` : detail;
  return composed.length <= DESCRIPTION_MAX ? composed : `${composed.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/**
 * Organizations that publish this property, outermost last, as schema.org
 * parentOrganization references.
 * @param {object} property
 * @returns {{"@type":"Organization",name:string,url:string}[]}
 */
export function parentOrganizations(property) {
  const declared = property.parentOrganizations;
  const list = Array.isArray(declared) ? declared : DEFAULT_PARENT_ORGANIZATIONS;
  return list.map(({ name, url }) => ({ "@type": "Organization", name, url }));
}

/** `robots.txt`: everyone allowed, each AI crawler named explicitly, then the sitemaps. */
export function renderRobotsGroups(sitemaps) {
  const groups = ["User-agent: *\nAllow: /", ...AI_CRAWLERS.map((agent) => `User-agent: ${agent}\nAllow: /`)];
  return `${groups.join("\n\n")}\n\n${sitemaps.map((location) => `Sitemap: ${location}`).join("\n")}\n`;
}

/**
 * RFC 9116 security.txt. Expires is under a year from the build instant, so
 * every release renews it.
 * @param {object} property
 * @param {Date} asOf
 * @returns {string}
 */
export function renderSecurityTxt(property, asOf) {
  const contact = property.security?.contact ?? DEFAULT_SECURITY_CONTACT;
  const expires = new Date(asOf.getTime() + SECURITY_VALIDITY_DAYS * 86_400_000).toISOString();
  return `Contact: mailto:${contact}\nExpires: ${expires}\nPreferred-Languages: ${property.language ?? "en"}\nCanonical: ${new URL("/.well-known/security.txt", property.origin).toString()}\n`;
}

const oneLine = (text, limit) => {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : limit - 1)}…`;
};
const linkText = (text) => String(text).replace(/[[\]]/gu, "");

/**
 * llms.txt (llmstxt.org): what the publication is, its desks, its latest
 * stories, its feeds and open data, and the paid briefing, as links with
 * one-line notes. `routes` is the set of page paths this build emits, so only
 * pages that exist are linked.
 * @param {object} input
 * @param {object} input.property
 * @param {{slug:string,title:string,description?:string,date?:string,publishedAt?:string}[]} input.posts newest first
 * @param {Set<string>} input.routes built file paths, e.g. "masthead/index.html"
 * @param {number} [input.latest]
 * @returns {string}
 */
export function renderLlmsTxt({ property, posts, routes, latest = 20 }) {
  const abs = (path) => new URL(path, property.origin).toString();
  const has = (path) => routes.has(path);
  const lines = [`# ${property.name}`, "", `> ${homeDescription(property)}`, ""];
  lines.push(`${property.name} is the 561 Group's AI-assisted newsroom, published by Causeway Services (public media). Stories are drafted with AI assistance, independently assessed before publication, and carry their sources, licence and a dated corrections register.`, "");
  const sections = property.sections ?? [];
  if (sections.length) {
    lines.push("## Sections", "");
    for (const section of sections) {
      if (has(`sections/${section.slug}/index.html`)) lines.push(`- [${linkText(section.title)}](${abs(`/sections/${section.slug}/`)}): ${oneLine(section.description ?? `Stories filed under ${section.title}.`, 140)}`);
    }
    lines.push("");
  }
  if (posts.length) {
    lines.push("## Latest stories", "");
    for (const post of posts.slice(0, latest)) {
      lines.push(`- [${linkText(post.title)}](${abs(`/posts/${post.slug}/`)}): ${oneLine(post.description, 200)}`);
    }
    lines.push("");
  }
  const feeds = [
    ["RSS feed", "/feed.xml", "newest stories as RSS"],
    ["Atom feed", "/feed.atom", "newest stories as Atom"],
    ["JSON Feed", "/feed.json", "newest stories as JSON Feed"],
    ["News sitemap", "/news-sitemap.xml", "stories from the last two days for news crawlers"],
    ["Sitemap", "/sitemap.xml", "every page with its last modification date"],
  ];
  lines.push("## Feeds and data", "", ...feeds.map(([label, path, note]) => `- [${label}](${abs(path)}): ${note}`));
  if (has("search/index.html")) lines.push(`- [Search](${abs("/search/")}): full-text search of every published story`);
  if (has("archive/index.html")) lines.push(`- [Archive](${abs("/archive/")}): all published reporting by year and month`);
  if (has("claims/index.html")) lines.push(`- [Claims](${abs("/claims/")}): the checked claims behind stories, with their sources`);
  lines.push("");
  const newsroom = [
    ["masthead/index.html", "/masthead/", "Masthead", "the publisher, desks and editors"],
    ["standards/index.html", "/standards/", "Standards", "the editorial and sourcing standards stories are held to"],
    ["corrections/index.html", "/corrections/", "Corrections", "the register of corrections and how to report an error"],
  ].filter(([file]) => has(file));
  if (newsroom.length) lines.push("## Newsroom", "", ...newsroom.map(([, path, label, note]) => `- [${label}](${abs(path)}): ${note}`), "");
  const product = property.monetization?.x402;
  if (product && typeof product.market === "string" && typeof product.route === "string") {
    const price = Number(product.priceUsd);
    const label = typeof product.label === "string" && product.label.trim() ? product.label.trim() : "Current intelligence briefing";
    const priceNote = Number.isFinite(price) && price >= 0 ? `$${price.toFixed(2)} per request` : "paid per request";
    lines.push("## Paid briefing", "", `- [${linkText(label)}](${new URL(product.route, product.market).toString()}): source-linked analysis drawn from the current newsroom record, ${priceNote} over x402 (USDC) at ${new URL(product.market).host}; an x402-compatible client is required`, "");
  }
  lines.push("## Optional", "", "- [561 Group](https://561.group/): the group that owns the newsroom", `- [Causeway Services](https://services.561.group/): the 561 Group company that publishes ${property.name}`, "");
  return lines.join("\n");
}
