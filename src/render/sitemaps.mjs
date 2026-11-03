/**
 * Sitemaps and robots.txt, through the serialized-content web feed.
 *
 * Both sitemaps are static files generated at publication time. The news
 * sitemap's 48-hour window is relative to the build's `asOf`, so a build
 * serves the right window for the moment it was built and goes stale only as
 * fast as the site goes without a new publication; every publication rebuilds
 * it. Serving a window that slides with the request clock would need a
 * request-time worker, which this static carrier deliberately is not.
 * Callers can supply `asOf` to reproduce a particular build.
 */
import { AI_CRAWLERS } from "./discovery.mjs";
import { newsSitemap, robots, sitemap } from "@red-cup-engineering/computer-serialized-content-engineering-services-section/web-feed";

const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * @typedef {object} SitemapEntry
 * @property {string} path site-relative path beginning with "/"
 * @property {string} [lastmod] ISO 8601 instant of the last witnessed revision
 */

/**
 * Render `sitemap.xml` with `lastmod` only for witnessed revisions. The
 * revision instant is kept to the second when the codec supports it; a codec
 * that predates `lastmodPrecision` reduces it to its day, which is still true.
 * @param {SitemapEntry[]} entries
 */
export function renderSitemap(entries, property) {
  return sitemap(entries.map((entry) => ({
    loc: new URL(entry.path, property.origin).toString(),
    ...(entry.lastmod ? { lastmod: entry.lastmod } : {}),
  })), { lastmodPrecision: "instant" });
}

/**
 * Render `news-sitemap.xml`: articles published within 48 hours of the
 * build time, per the Google News sitemap protocol. `publication_date` is the
 * article's resolved publication instant, never a bare day.
 * @param {{slug:string,title:string,publishedInstant:string}[]} posts newest first
 */
export function renderNewsSitemap(posts, property, asOf = new Date()) {
  const now = new Date(asOf).getTime();
  if (!Number.isFinite(now)) throw new TypeError("asOf must be a valid date or instant");
  const threshold = now - NEWS_WINDOW_MS;
  return newsSitemap(posts.filter((post) => {
    const published = Date.parse(post.publishedInstant);
    return published >= threshold && published <= now;
  }).map((post) => ({
    loc: new URL(`/posts/${post.slug}/`, property.origin).toString(),
    publication: { name: property.name, language: property.language ?? "en" },
    publicationDate: post.publishedInstant,
    title: post.title,
  })));
}

/**
 * Crawlers that fetch pages for AI answer engines, training, or search
 * grounding. Each gets an explicit group so its permission does not depend on
 * how a crawler resolves the wildcard group.
 */
export const AI_CRAWLER_USER_AGENTS = Object.freeze([...new Set(["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended", ...AI_CRAWLERS])]);

/**
 * Render `robots.txt`: every crawler, the named AI crawlers among them, may
 * fetch the site, and both sitemaps are listed.
 *
 * Allowing a crawler here is not the same as giving it content for free. When
 * the property sets a Cloudflare pay-per-crawl price, `_headers` quotes it as
 * `Crawler-Price` on article responses, and a priced crawler that has not
 * agreed to it is answered `402 Payment Required` at the edge. `robots.txt`
 * says who may crawl; `Crawler-Price` says what the crawl costs. The release
 * flow also treats `robots.txt` as Cloudflare-managed content, so the edge's
 * own robots policy may be prepended to or override this file.
 */
export function renderRobotsTxt(property) {
  return robots({
    groups: [
      ...AI_CRAWLER_USER_AGENTS.map((userAgent) => ({ userAgent, allow: ["/"] })),
      { userAgent: "*", allow: ["/"] },
    ],
    sitemap: [
      new URL("/sitemap.xml", property.origin).toString(),
      ...(property.distribution?.googleNewsSitemap ? [new URL("/news-sitemap.xml", property.origin).toString()] : []),
    ],
  });
}

/**
 * Render `ads.txt` from `property.monetization.adsTxt` lines, or `undefined`
 * when none are configured (the file is then omitted from the build).
 */
export function renderAdsTxt(property) {
  const lines = property.monetization?.adsTxt;
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  return `${lines.join("\n")}\n`;
}
