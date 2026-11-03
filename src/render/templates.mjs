/**
 * The rendered surfaces of a news property (specification §5): home,
 * section, article, desk, author, tag, archive, search, masthead, standards,
 * corrections, about, and privacy pages, plus the shared document shell
 * (masthead header, skip link, landmarks, footer) they all render inside.
 * Every function here takes plain data and returns an HTML string; nothing
 * reads the filesystem — `src/build.mjs` is the only I/O boundary.
 */
import { slugify } from "@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text";
import { escapeHtml } from "./markdown.mjs";
import { hasAdvertisingInventory } from "./advertising-sales.mjs";
import { renderHeadTags, newsArticleJsonLd, newsMediaOrganizationJsonLd, breadcrumbListJsonLd, webSiteJsonLd, profilePageJsonLd, absoluteUrl } from "./head.mjs";
import { postInstants, publishedDay, latestModified } from "../publication-instants.mjs";
import { aiAuthorshipStatement, authorPathFor, authorProfile, isDeskByline } from "./authors.mjs";
import { LOGO_DIMENSIONS } from "./article-fingerprint.mjs";
import { renderPublicationMedia } from "./media.mjs";
import { homeDescription, parentOrganizations } from "./discovery.mjs";

const PAGE_SIZE = 12;
const esc = escapeHtml;

/**
 * @param {object} property
 * @param {string} path site-relative, beginning with "/"
 * @returns {string}
 */
function url(property, path) {
  return absoluteUrl(property.origin, path);
}

/**
 * @param {string} iso
 * @returns {string}
 */
function humanDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The time of day is shown only when it is a recorded fact; a day-only article shows its day. */
function instantLabel(instant, precision, day) {
  return precision === "instant" ? `${humanDate(instant)} at ${instant.slice(11, 16)} UTC` : humanDate(day);
}

function publicationLabel(post) {
  const resolved = postInstants(post);
  return instantLabel(resolved.publishedInstant, resolved.publishedPrecision, publishedDay(resolved));
}

/** The publisher logo as structured data: a raster ImageObject with its true size. */
function publisherLogo(property) {
  return { url: url(property, "/logo.png"), width: LOGO_DIMENSIONS.width, height: LOGO_DIMENSIONS.height };
}

/**
 * A `<title>` a results page will not cut off: the headline and brand when
 * they fit in 60 characters, else the headline alone, else the headline
 * shortened at a word boundary.
 */
export function documentTitle(headline, siteName, limit = 60) {
  const branded = `${headline} – ${siteName}`;
  if (branded.length <= limit) return branded;
  if (headline.length <= limit) return headline;
  const cut = headline.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,;:–—-]+$/u, "")}…`;
}

/**
 * Render the primary navigation: the property's sections, plus a direct
 * reader-remedy entrance and the established discovery/identity pages.
 * @param {object} property
 * @param {string} [activeSlug]
 * @returns {string}
 */
function primaryNav(property, activeSlug) {
  const items = (property.sections ?? []).map((section) =>
    `<a href="/sections/${esc(section.slug)}/"${section.slug === activeSlug ? ' aria-current="page"' : ""}>${esc(section.title)}</a>`);
  items.push('<a href="/topics/">Topics</a>', '<a href="/tags/">Tags</a>', '<a href="/search/">Search</a>',
    '<a href="/corrections/#report-an-error">Report a problem</a>', '<a href="/masthead/">Masthead</a>');
  if (property.content?.claimStore) items.push('<a href="/wire/">The wire</a>', '<a href="/claims/">Claims</a>');
  return `<nav aria-label="Primary">${items.join("")}</nav>`;
}

/**
 * Render the site masthead header.
 * @param {object} property
 * @param {string} [activeSlug]
 * @returns {string}
 */
function siteHeader(property, activeSlug) {
  return `<header><div class="site-identity"><a class="site-title" href="/">${esc(property.name)}</a>` +
    `<span class="site-tagline">${esc(property.tagline ?? "")}</span></div>${primaryNav(property, activeSlug)}</header>`;
}

/**
 * Render a house ad slot: a placeholder frame that fetches its creative
 * client-side, so build output stays byte-deterministic regardless of which
 * creative is later served. Ported from the Koios.News carrier's footer
 * ad-server pattern, generalized to any configured slot position.
 * @param {object} property
 * @param {string} position
 * @returns {string}
 */
function houseAdSlot(property, position, context = []) {
  const server = property.monetization?.houseAds?.server;
  const slots = property.monetization?.houseAds?.slots ?? [];
  if (!server || !slots.includes(position)) return "";
  // What the page is about (an article's desk and tags) travels to the ad
  // server so it can prefer a fitting house product; nothing about the reader does.
  const contexts = context.filter((value) => typeof value === "string" && value !== "").slice(0, 8).map((value) => slugify(value));
  const contextAttribute = contexts.length > 0 ? ` data-context="${esc(contexts.join(","))}"` : "";
  return `<div class="ad-slot ad-slot--house" data-slot="${esc(position)}" data-property="${esc(slugify(property.name))}" data-ad-server="${esc(server)}"${contextAttribute}></div>`;
}

function adSlot(property, position, post) {
  const aads = property.monetization?.aads;
  if (!aads) return houseAdSlot(property, position);
  const assigned = post?.adUnit;
  const candidates = position === "inArticle" ? aads.inArticle : aads[position] == null ? [] : [aads[position]];
  if (assigned == null && (!Array.isArray(candidates) || candidates.length === 0)) return houseAdSlot(property, position);
  const index = assigned == null && post ? [...post.slug].reduce((sum, character) => sum + character.codePointAt(0), 0) % candidates.length : 0;
  const unit = assigned ?? candidates[index];
  if (!/^\d+$/u.test(unit) || !aads.units?.includes(unit)) throw new Error(`unrecognized A-Ads unit: ${unit}`);
  const loading = position === "footer" ? ' loading="lazy"' : "";
  return `<aside class="ad-slot ad-slot--paid" aria-label="Advertisement"><span class="ad-slot__label">Advertisement</span>` +
    `<iframe data-aa="${unit}" src="https://acceptable.a-ads.com/${unit}/?size=Adaptive" title="Advertisement" height="110"${loading} referrerpolicy="no-referrer"></iframe></aside>`;
}

function followFeeds(property) {
  return `<section class="follow-feeds"><h2>Follow new articles</h2>` +
    `<p>Add ${esc(property.name)} to your feed reader to see each new story.</p>` +
    `<div class="follow-feeds__links"><a href="/feed.xml" type="application/rss+xml">RSS feed</a>` +
    `<a href="/feed.atom" type="application/atom+xml">Atom feed</a></div></section>`;
}

/**
 * Render a direct purchase path for a property-level product.  The market
 * carries payment; the property merely gives readers and agent buyers an
 * honest, stable route to the thing it sells.
 * @param {object} property
 * @returns {string}
 */
function x402Product(property) {
  const product = property.monetization?.x402;
  if (!product || typeof product.market !== "string" || typeof product.route !== "string") return "";
  const href = new URL(product.route, product.market).toString();
  const offerAnchor = typeof product.gateway === "string" && typeof product.operation === "string"
    ? `${product.gateway}-${product.operation}` : "buying";
  const guide = new URL(`/#${encodeURIComponent(offerAnchor)}`, product.market).toString();
  const label = typeof product.label === "string" && product.label.trim() ? product.label.trim() : "Current intelligence briefing";
  const price = Number(product.priceUsd);
  const priceLine = Number.isFinite(price) && price >= 0 ? ` — $${price.toFixed(2)}` : "";
  return `<section class="paid-product"><h2>${esc(label)}</h2>` +
    `<p>Source-linked analysis drawn from the current newsroom record.</p>` +
    `<p>Purchase requires an x402-compatible client; a regular browser cannot complete checkout.</p>` +
    `<a class="paid-product__buy" href="${esc(guide)}">How to buy the briefing${esc(priceLine)}</a>` +
    `<p><a href="${esc(href)}">View the payment terms</a>.</p></section>`;
}

/**
 * Render the footer, with the standing links every property carries.
 * @param {object} property
 * @returns {string}
 */
function siteFooter(property, options = {}) {
  const actor = property.distribution?.activityPubActor;
  const year = (property.masthead?.year ?? new Date().getUTCFullYear());
  const links = [
    '<a href="/about/">About</a>', '<a href="/masthead/">Masthead</a>', '<a href="/standards/">Standards</a>',
    '<a href="/corrections/">Corrections</a>', '<a href="/contact/">Contact</a>', '<a href="/about/#ownership">Ownership</a>', '<a href="/privacy/">Privacy</a>',
    hasAdvertisingInventory(property) ? '<a href="/advertise/">Advertise</a>' : '',
    property.content?.sourceFeeds ? '<a href="/sources/">Newsroom sources</a>' : '',
    '<a href="/archive/">Archive</a>', '<a href="/bibliography/">Article citations</a>',
    '<a href="/feed.xml">RSS</a>', '<a href="/feed.atom">Atom</a>', '<a href="/feed.json">JSON Feed</a>',
    '<a href="/sitemap.xml">Sitemap</a>',
    actor ? `<a rel="me" href="${esc(actor)}">${esc(actor.replace(/^https?:\/\//u, ""))}</a>` : "",
  ].filter(Boolean).join(" · ");
  return `<footer>${options.advertising === false ? "" : options.paidInventory ? adSlot(property, "footer") : houseAdSlot(property, "footer")}<div class="inner">` +
    `<span>© ${esc(String(year))} ${esc(property.name)}</span>${links}</div></footer>`;
}

/**
 * Assemble a complete HTML document from a page's head context and body.
 * @param {object} property
 * @param {import("./head.mjs").HeadContext} headCtx
 * @param {string} bodyHtml inner markup for `<main>`
 * @param {object} [options]
 * @param {string} [options.activeSlug] the active nav item, for `aria-current`
 * @param {string} [options.stylesheetHref] defaults to `/assets/site.css`
 * @param {boolean} [options.shareLinks] load the article sharing control
 * @param {boolean} [options.advertising] false for editorially withdrawn/unavailable pages: no ad slot or client
 * @returns {string}
 */
export function documentShell(property, headCtx, bodyHtml, options = {}) {
  const stylesheet = options.stylesheetHref ?? "/assets/site.css";
  const lang = property.language ?? "en";
  const pageHead = headCtx.ogType === "article" || headCtx.ogImage ? headCtx
    : { ...headCtx, ogImage: absoluteUrl(property.origin, "/og.png"), ogImageWidth: 1200, ogImageHeight: 675 };
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${esc(stylesheet)}">
${renderHeadTags(pageHead)}
</head>
<body>
<a class="skip-to-content" href="#main-content">Skip to content</a>
${siteHeader(property, options.activeSlug)}
<main id="main-content" tabindex="-1" role="main">
${bodyHtml}
</main>
${siteFooter(property, options)}
${options.shareLinks ? '<script src="/assets/share.js" defer></script>\n' : ""}${options.advertising !== false && property.monetization?.houseAds?.server ? '<script src="/assets/house-ad.js" defer></script>' : ""}
</body>
</html>
`;
}

/**
 * Render one story summary card.
 * @param {object} post
 * @param {object} [options]
 * @param {boolean} [options.lead]
 * @param {boolean} [options.showImage]
 * @returns {string}
 */
export function storyCard(post, options = {}) {
  const cls = options.lead ? "story story--lead" : "story";
  const heading = options.lead ? "h1" : "h2";
  const image = options.showImage !== false && post.image
    ? `<a class="story__image" href="/posts/${esc(post.slug)}/"><img src="${esc(post.image)}" alt="${esc(post.imageAlt ?? "")}"${post.imageWidth && post.imageHeight ? ` width="${post.imageWidth}" height="${post.imageHeight}"` : ""}${options.lead ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></a>`
    : "";
  return `<article class="${cls}">${image}` +
    `<span class="story__kicker"><a href="/sections/${esc(post.section)}/">${esc(post.sectionTitle)}</a></span>` +
    `<${heading} class="story__head"><a href="/posts/${esc(post.slug)}/">${esc(post.title)}</a></${heading}>` +
    `<p class="story__sum">${esc(post.description)}</p>` +
    `<p class="story__meta"><time datetime="${esc(postInstants(post).publishedInstant)}">${esc(publicationLabel(post))}</time> · ${esc(post.author)}</p></article>`;
}

/**
 * Render the home page.
 * @param {object} input
 * @param {object} input.property
 * @param {object[]} input.posts all published posts, newest first
 * @param {{slug:string,views:number}[]} [input.mostRead]
 * @param {Date} [input.asOf] current build time for the rolling front page
 * @returns {string}
 */
export function renderHomePage({ property, posts, mostRead, asOf }) {
  const front = asOf === undefined ? posts : posts.filter((post) => {
    // A day-only article is on the front page from the start of its day.
    const resolved = postInstants(post);
    const published = Date.parse(resolved.publishedPrecision === "instant" ? resolved.publishedInstant : `${post.date}T00:00:00Z`);
    return published <= asOf.getTime() && published >= asOf.getTime() - 30 * 24 * 60 * 60 * 1000;
  });
  const lead = front[0];
  const latest = front.slice(0, 10);
  const bySection = new Map();
  for (const post of front) {
    if (!bySection.has(post.section)) bySection.set(post.section, []);
    bySection.get(post.section).push(post);
  }
  const sectionBlocks = (property.sections ?? []).map((section) => {
    const entries = (bySection.get(section.slug) ?? []).slice(0, 4);
    if (entries.length === 0) return "";
    return `<section class="section-block"><h2><a href="/sections/${esc(section.slug)}/">${esc(section.title)}</a></h2>` +
      `<div class="stories">${entries.map((post) => storyCard(post)).join("")}</div></section>`;
  }).filter(Boolean).join("");
  const latestList = latest.length ? `<section class="latest-list"><h2>Latest</h2><div class="stories">` +
    `${latest.map((post) => storyCard(post, { showImage: false })).join("")}</div>` +
    `<p><a href="/archive/">Browse the full archive</a></p></section>` : "";
  const mostReadHtml = mostRead && mostRead.length > 0
    ? `<section class="most-read"><h2>Most Read</h2><ol>${mostRead.map((entry) => {
      const post = posts.find((candidate) => candidate.slug === entry.slug);
      const title = post ? post.title : entry.slug;
      return `<li><a href="/posts/${esc(entry.slug)}/">${esc(title)}</a></li>`;
    }).join("")}</ol></section>`
    : "";
  const body = [
    lead ? `<div class="edition-bar"><span>Latest publication: <time datetime="${esc(postInstants(lead).publishedInstant)}">${esc(publicationLabel(lead))}</time></span><a href="/archive/">All reporting →</a></div>` : "",
    adSlot(property, "header"),
    lead ? `<section class="front-page" aria-label="Featured and latest reporting"><div class="front-page__lead">${storyCard(lead, { lead: true })}</div>` +
      `<aside class="front-page__latest" aria-label="Latest reports"><h2>Latest reports</h2>${front.slice(1, 5).map(post => storyCard(post, {showImage:false})).join("")}</aside></section>` :
      `<h1>Latest reporting</h1><p>No reports published in the past 30 days. <a href="/archive/">Browse the archive</a>.</p>`,
    `<nav class="coverage-nav" aria-label="Explore news desks">${(property.sections ?? []).map(section => `<a href="/sections/${esc(section.slug)}/">${esc(section.title)} <span>${(bySection.get(section.slug) ?? []).length} reports</span></a>`).join("")}</nav>`,
    x402Product(property),
    sectionBlocks,
    latestList,
    mostReadHtml,
    followFeeds(property),
  ].filter(Boolean).join("\n");
  const headCtx = {
    title: property.name,
    description: homeDescription(property),
    canonical: url(property, "/"),
    siteName: property.name,
    ogType: "website",
    locale: property.locale,
    jsonLd: [
      { ...newsMediaOrganizationJsonLd({ id: url(property, "/#publisher"), name: property.name, url: `${property.origin}/`, logo: url(property, "/logo.png") }),
        mainEntityOfPage: { "@id": url(property, "/") },
        logo: { "@type": "ImageObject", ...publisherLogo(property) },
        parentOrganization: parentOrganizations(property) },
      webSiteJsonLd({ name: property.name, url: `${property.origin}/`, description: homeDescription(property), inLanguage: property.language,
        publisherId: url(property, "/#publisher"), searchUrlTemplate: `${url(property, "/search/")}?q={search_term_string}` }),
    ],
    fediverseCreator: property.distribution?.activityPubActor,
    actorUrl: property.distribution?.activityPubActor,
  };
  return documentShell(property, headCtx, body, { paidInventory: true });
}

/**
 * Render a paginated section page.
 * @param {object} input
 * @param {object} input.property
 * @param {object} input.section `{slug,title}`
 * @param {object[]} input.posts every post in the section, newest first
 * @param {number} input.page 1-indexed
 * @returns {string}
 */
export function renderSectionPage({ property, section, posts, page }) {
  const totalPages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const pagePosts = posts.slice(pageStart, pageStart + PAGE_SIZE);
  const base = `/sections/${section.slug}`;
  const pagination = totalPages > 1
    ? `<nav class="pagination" aria-label="Pagination">` +
      `${page > 1 ? `<a href="${page === 2 ? `${base}/` : `${base}/page/${page - 1}/`}">Newer</a>` : "<span></span>"}` +
      `<span>Page ${page} of ${totalPages}</span>` +
      `${page < totalPages ? `<a href="${base}/page/${page + 1}/">Older</a>` : "<span></span>"}</nav>`
    : "";
  const body = `<h1>${esc(section.title)}</h1><div class="stories">${pagePosts.map((post) => storyCard(post)).join("")}</div>${pagination}`;
  const headCtx = {
    title: `${section.title} – ${property.name}`,
    description: `Stories filed under ${section.title}.`,
    canonical: url(property, page === 1 ? `${base}/` : `${base}/page/${page}/`),
    siteName: property.name,
  };
  return documentShell(property, headCtx, body, { activeSlug: section.slug });
}

/**
 * Render the claim ledger and omission ledger sections, when the article's
 * front matter provides them.
 * @param {{text:string,source?:string}[]} [claims]
 * @param {{text:string}[]} [omissions]
 * @returns {string}
 */
function renderLedgers(claims, omissions) {
  const claimHtml = claims && claims.length > 0
    ? `<section class="ledger ledger--claims"><h2>What this article establishes</h2><ol>` +
      claims.map((claim) => `<li>${esc(claim.text)}${claim.source ? `<cite><a href="${esc(claim.source)}">${esc(claim.source)}</a></cite>` : ""}</li>`).join("") +
      `</ol></section>`
    : "";
  const omissionHtml = omissions && omissions.length > 0
    ? `<section class="ledger ledger--omissions"><h2>What this reporting does not establish</h2><ol>` +
      omissions.map((omission) => `<li>${esc(omission.text)}</li>`).join("") + `</ol></section>`
    : "";
  return claimHtml + omissionHtml;
}

/**
 * Render the corrections notice, when the article's front matter provides
 * one.
 * @param {{date:string,note:string}[]} [corrections]
 * @returns {string}
 */
function renderCorrectionNotice(corrections) {
  if (!corrections || corrections.length === 0) return "";
  return `<aside class="correction-notice" aria-label="Corrections to this article"><h2>Corrections</h2><ol>` +
    corrections.map((entry) => `<li><time datetime="${esc(entry.date)}">${esc(humanDate(entry.date))}</time>: ${esc(entry.note)}</li>`).join("") +
    `</ol></aside>`;
}

function renderArticleRights(post) {
  return post.license
    ? `<aside class="article-rights" aria-label="Rights and republication"><h2>Rights and republication</h2><p>Published under ` +
      (post.licenseUrl ? `<a rel="license" href="${esc(post.licenseUrl)}">${esc(post.license)}</a>` : esc(post.license)) +
      `.${post.syndicationRights ? ` ${esc(post.syndicationRights)}` : ""}</p></aside>`
    : "";
}

/** One selected image, carrying only that asset's text alternative and credit. */
function articleFigure({ src, alt, width, height, caption, credit }, { priority = false } = {}) {
  if (!src) return "";
  return `<figure class="article-hero"><img src="${esc(src)}" alt="${esc(alt ?? "")}"` +
    (width && height ? ` width="${width}" height="${height}"` : "") +
    (priority ? ` fetchpriority="high"` : ` loading="lazy"`) + ` decoding="async">` +
    (caption || credit ? `<figcaption>${[caption, credit].filter(Boolean).map(esc).join(" ")}</figcaption>` : "") + `</figure>`;
}

/** The article a subscriber reads, carrying the page's editorial context. */
export function renderSyndicatedArticle(property, post) {
  const image = articleFigure({ src: post.ogImage, alt: post.ogImageAlt,
    width: post.ogImageWidth, height: post.ogImageHeight,
    caption: post.ogImageCaption, credit: post.ogImageCredit });
  return (post.dek ? `<p>${esc(post.dek)}</p>` : "") + image + post.bodyHtml +
    renderPublicationMedia(post.media, { articleUrl: url(property, `/posts/${post.slug}/`) }) +
    renderLedgers(post.claims, post.omissions) + renderCorrectionNotice(post.corrections) +
    `<p>Published by ${esc(property.name)}: <a href="${esc(url(property, `/posts/${post.slug}/`))}">${esc(post.title)}</a>.</p>` +
    renderArticleRights(post);
}

/**
 * Render the share-links row.
 * @param {string} shareUrl absolute article URL
 * @param {string} title
 * @returns {string}
 */
function renderShareLinks(shareUrl, title) {
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedTitle = encodeURIComponent(title);
  return `<div class="share-links">` +
    `<a href="https://x.com/intent/post?url=${encodedUrl}&text=${encodedTitle}" rel="noopener noreferrer">Share on X</a>` +
    `<a href="https://bsky.app/intent/compose?text=${encodedTitle}%20${encodedUrl}" rel="noopener noreferrer">Share on Bluesky</a>` +
    `<a href="https://mastodonshare.com/?url=${encodedUrl}&text=${encodedTitle}" rel="noopener noreferrer">Share on Mastodon</a>` +
    `<button type="button" data-copy-link="${esc(shareUrl)}">Copy link</button>` +
    `<span class="share-links__status" role="status" aria-live="polite"></span>` +
    `</div>`;
}

/**
 * Render related stories: other published posts sharing the article's
 * section or a tag, most recent first, excluding the article itself.
 * @param {object} post
 * @param {object[]} allPosts
 * @returns {string}
 */
function renderRelatedStories(post, allPosts) {
  const tagSet = new Set(post.tags ?? []);
  const related = allPosts
    .filter((candidate) => candidate.slug !== post.slug &&
      (candidate.section === post.section || (candidate.tags ?? []).some((tag) => tagSet.has(tag))))
    .slice(0, 3);
  if (related.length === 0) return "";
  return `<section class="related-stories"><h2>Related stories</h2><div class="related-stories__grid">` +
    related.map((entry) => `<article class="related-story"><h3><a href="/posts/${esc(entry.slug)}/">${esc(entry.title)}</a></h3>` +
      `<p>${esc(entry.description)}</p></article>`).join("") + `</div></section>`;
}

/**
 * Place an advertisement after an article's first paragraph, so the lede is
 * the first thing a reader (and the layout-shift budget) meets. An article
 * without a paragraph closes with it.
 * @param {string} bodyHtml
 * @param {string} adHtml
 */
function withAdAfterLede(bodyHtml, adHtml) {
  if (adHtml === "") return bodyHtml;
  const close = bodyHtml.indexOf("</p>");
  return close < 0 ? bodyHtml + adHtml : `${bodyHtml.slice(0, close + 4)}${adHtml}${bodyHtml.slice(close + 4)}`;
}

/**
 * The reader-facing statement of how the article was made, and the way to
 * report an error in it.
 */
function renderAiDisclosure(property, post) {
  const profile = authorProfile(property, post.authorSlug);
  const standards = '<a href="/standards/">How we report</a> · <a href="/corrections/#report-an-error">Report an error or request a correction</a>';
  const statement = profile.kind === "ai"
    ? `This article is bylined to ${esc(post.author)}, ${profile.jobTitle ? `the ${esc(profile.jobTitle)} of ${esc(property.name)}, ` : ""}an artificial-intelligence character rather than a human journalist. ` +
      `It was researched and drafted with AI, bound to its cited sources, and published after independent editorial assessment.`
    : `${esc(property.name)} produces this reporting with AI assistance, bound to cited sources and published after independent editorial assessment.`;
  return `<p class="article-disclosure"><strong>AI disclosure.</strong> ${statement} ${standards}.</p>`;
}

/**
 * Render a single article page.
 * @param {object} input
 * @param {object} input.property
 * @param {object} input.post the article, with `bodyHtml` already rendered
 * @param {object[]} input.allPosts every published post, for related stories
 * @returns {string}
 */
export function renderArticlePage({ property, post: bare, allPosts, verificationArticleUnit, noindex = false }) {
  const post = postInstants(bare);
  const articleUrl = url(property, `/posts/${post.slug}/`);
  const authorPath = authorPathFor(property, post);
  const profile = authorProfile(property, post.authorSlug);
  const hero = articleFigure({ src: post.image, alt: post.imageAlt,
    width: post.imageWidth, height: post.imageHeight,
    caption: post.imageCaption, credit: post.imageCredit }, { priority: true });
  const rights = renderArticleRights(post);
  const tags = (post.tags ?? []).length > 0
    ? `<p class="tags">${post.tags.map((tag) => `<a href="/tags/${esc(slugify(tag))}/">${esc(tag)}</a>`).join("")}</p>`
    : "";
  const references = post.referenceRecords ?? [];
  const outline = post.outline ?? [];
  const navigation = outline.length >= 3 ? `<details class="article-navigation" open><summary>In this article</summary><nav aria-label="Article sections"><ol>${outline.map(entry => `<li class="article-navigation__level-${entry.level}"><a href="#${esc(entry.id)}">${esc(entry.title)}</a></li>`).join("")}</ol></nav></details>` : "";
  const sources = references.length ? `<section class="article-sources" id="article-sources"><h2>Read the sources</h2><p>The documents cited in this report. Source statements remain attributed to their authors.</p><ol>${references.map(reference => `<li><a href="${esc(reference.url)}">${esc(reference.title)}</a><span>${esc(reference.containerTitle)}</span></li>`).join("")}</ol></section>` : "";
  const inArticleAd = adSlot(property, "inArticle", verificationArticleUnit ? { ...post, adUnit: verificationArticleUnit } : post);
  const updated = post.modifiedInstant !== post.publishedInstant
    ? `<time class="dt-updated" datetime="${esc(post.modifiedInstant)}"> · Updated ${esc(instantLabel(post.modifiedInstant, post.modifiedPrecision, post.modifiedInstant.slice(0, 10)))}</time>`
    : "";
  const body = `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true"> / </span><a href="/sections/${esc(post.section)}/">${esc(post.sectionTitle)}</a></nav><article class="h-entry">` +
    `<span class="article-kicker"><a href="/sections/${esc(post.section)}/">${esc(post.sectionTitle)}</a></span>` +
    `<h1 class="p-name">${esc(post.title)}</h1>` +
    (post.dek ? `<p class="article-dek">${esc(post.dek)}</p>` : "") +
    `<p class="article-byline"><time class="dt-published" datetime="${esc(post.publishedInstant)}">${esc(publicationLabel(post))}</time>` +
    updated +
    ` · By <a class="p-author" href="${esc(authorPath)}">${esc(post.author)}</a></p>` +
    renderAiDisclosure(property, post) +
    `<div class="article-utilities">${post.readingMinutes ? `<span>About ${post.readingMinutes} min read</span>` : ""}${references.length ? `<a href="#article-sources">${references.length} cited sources ↓</a>` : ""}<a href="/standards/">How we report</a></div>` +
    (verificationArticleUnit ? adSlot(property, "header") : "") +
    hero +
    navigation +
    `<div class="e-content">${withAdAfterLede(post.bodyHtml, inArticleAd)}</div>` +
    renderPublicationMedia(post.media) +
    sources +
    `<p class="article-citation"><a href="/posts/${esc(post.slug)}/citation.json" download="${esc(post.slug)}.json">Cite this article (CSL-JSON)</a></p>` +
    houseAdSlot(property, "afterArticle", [post.section, ...(post.tags ?? [])]) +
    tags +
    renderLedgers(post.claims, post.omissions) +
    renderRelatedStories(post, allPosts) +
    renderShareLinks(articleUrl, post.title) +
    renderCorrectionNotice(post.corrections) +
    rights +
    `</article>`;
  const headCtx = {
    title: documentTitle(post.title, property.name),
    socialTitle: post.title,
    description: post.description,
    canonical: articleUrl,
    siteName: property.name,
    ogType: "article",
    locale: property.locale,
    ogImage: post.ogImage,
    ogImageAlt: post.ogImageAlt,
    ogImageWidth: post.ogImageWidth,
    ogImageHeight: post.ogImageHeight,
    noindex: noindex || Boolean(verificationArticleUnit),
    articlePublishedTime: post.publishedInstant,
    articleModifiedTime: post.modifiedInstant,
    articleSection: post.sectionTitle,
    articleTags: post.tags,
    citation: {title:post.title, author:post.author, published:post.publishedAt ?? post.date,
      url:articleUrl, language:property.language ?? property.locale?.replaceAll('_', '-'), publication:property.name,
      recordUrl:url(property, `/posts/${post.slug}/citation.json`)},
    jsonLd: [newsArticleJsonLd({
      headline: post.title,
      url: articleUrl,
      image: post.ogImage,
      images: post.schemaImages,
      media: post.media,
      datePublished: post.publishedInstant,
      dateModified: post.modifiedInstant,
      author: {
        type: isDeskByline(property, post.author) ? "Organization" : "Person",
        name: post.author,
        url: url(property, authorPath),
        jobTitle: profile.jobTitle,
        sameAs: profile.sameAs,
      },
      publisher: { id: url(property, "/#publisher"), name: property.name, url: `${property.origin}/`, logo: publisherLogo(property) },
      description: post.description,
      articleSection: post.sectionTitle,
      inLanguage: property.language ?? property.locale?.replaceAll("_", "-"),
      keywords: post.keywords,
      citations: post.referenceRecords,
      licenseUrl: post.licenseUrl,
      speakableSelector: post.dek ? ".article-dek" : undefined,
    }), breadcrumbListJsonLd([
      { name: "Home", url: url(property, "/") },
      { name: post.sectionTitle, url: url(property, `/sections/${post.section}/`) },
      { name: post.title, url: articleUrl },
    ])],
    fediverseCreator: property.distribution?.activityPubActor,
    actorUrl: property.distribution?.activityPubActor,
  };
  return documentShell(property, headCtx, body, { activeSlug: post.section, paidInventory: true, shareLinks: true });
}

/**
 * Render a plain list-of-posts page (used by tag, author, and desk pages).
 * @param {object} property
 * @param {string} title
 * @param {string} description
 * @param {string} canonicalPath
 * @param {object[]} posts
 * @returns {string}
 */
function renderPostListPage(property, title, description, canonicalPath, posts, { noindex = false } = {}) {
  const body = `<h1>${esc(title)}</h1><ul class="pages">` +
    posts.map((post) => `<li><a href="/posts/${esc(post.slug)}/">${esc(post.title)}</a><p>${esc(post.description)}</p></li>`).join("") +
    `</ul>`;
  const headCtx = { title: `${title} – ${property.name}`, description, canonical: url(property, canonicalPath), siteName: property.name, ...(noindex ? { noindex: true } : {}) };
  return documentShell(property, headCtx, body);
}

/** A tag held by fewer posts than this is a thin page: it is kept for readers but not offered to search. */
export const THIN_TAG_POSTS = 2;

/**
 * Render a tag page.
 * @param {object} property
 * @param {{slug:string,title:string}} tag
 * @param {object[]} posts posts carrying this tag, newest first
 * @returns {string}
 */
export function renderTagPage(property, tag, posts) {
  return renderPostListPage(property, `Tag: ${tag.title}`, `${posts.length} ${posts.length === 1 ? "story" : "stories"} tagged ${tag.title}.`, `/tags/${tag.slug}/`, posts, { noindex: posts.length < THIN_TAG_POSTS });
}

export function renderTopicPage(property, topic, posts) {
  return renderPostListPage(property, `Topic: ${topic.title}`, `${posts.length} stories on ${topic.title}.`, `/topics/${topic.slug}/`, posts);
}

/**
 * Render a coverage desk directly from its section.
 * @param {object} property
 * @param {object} desk `{slug,title,description?}`
 * @param {object[]} posts posts filed to this desk's section, newest first
 * @returns {string}
 */
export function renderDeskPage(property, desk, posts) {
  const description = desk.description ?? `Coverage from the ${desk.title} desk.`;
  const body = `<h1>${esc(desk.title)}</h1><p>${esc(description)}</p>` +
    `<div class="stories">${posts.slice(0, PAGE_SIZE).map((post) => storyCard(post)).join("")}</div>`;
  const headCtx = { title: `${desk.title} – ${property.name}`, description, canonical: url(property, `/desks/${desk.slug}/`), siteName: property.name };
  return documentShell(property, headCtx, body, { activeSlug: desk.slug });
}

/**
 * Render an author page: a ProfilePage whose subject is the byline, with the
 * byline's own statement of whether it is a person or an AI character.
 * @param {object} property
 * @param {{slug:string,name:string,bio?:string}} author
 * @param {object[]} posts posts bylined to this author, newest first
 * @returns {string}
 */
export function renderAuthorPage(property, author, posts) {
  const profile = authorProfile(property, author.slug);
  const statement = aiAuthorshipStatement(property, author);
  const canonical = url(property, `/authors/${author.slug}/`);
  const sectionTitles = [...new Set(posts.map((post) => post.sectionTitle).filter(Boolean))];
  const tagCounts = new Map();
  for (const post of posts) for (const tag of post.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const topTags = [...tagCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([tag]) => tag);
  const knowsAbout = [...new Set([...(profile.knowsAbout ?? []), ...sectionTitles, ...topTags])];
  const body = `<h1>${esc(author.name)}</h1>` +
    (profile.jobTitle ? `<p class="author-role">${esc(profile.jobTitle)}, ${esc(property.name)}</p>` : "") +
    (author.bio ? `<p>${esc(author.bio)}</p>` : "") +
    (statement ? `<p class="author-disclosure"><strong>AI authorship.</strong> ${esc(statement)} <a href="/standards/">How we report</a> · <a href="/corrections/#report-an-error">Report an error</a></p>` : "") +
    `<div class="stories">${posts.map((post) => storyCard(post)).join("")}</div>`;
  const headCtx = {
    title: documentTitle(author.name, property.name), description: author.bio ?? statement ?? "", canonical, siteName: property.name,
    jsonLd: profilePageJsonLd({
      url: canonical,
      dateModified: latestModified(posts.map(postInstants)),
      entity: {
        type: "Person",
        name: author.name,
        description: statement ?? author.bio,
        jobTitle: profile.jobTitle,
        sameAs: profile.sameAs,
        knowsAbout,
      },
      worksFor: { name: property.name, url: `${property.origin}/` },
    }),
  };
  return documentShell(property, headCtx, body);
}

/**
 * Render the archive index page (years).
 * @param {object} property
 * @param {{year:string,months:{month:string,count:number}[],count:number}[]} years
 * @returns {string}
 */
export function renderArchiveIndexPage(property, years) {
  const body = `<h1>Archive</h1>` + years.map((year) =>
    `<section><h2><a href="/archive/${esc(year.year)}/">${esc(year.year)}</a></h2><p>${year.count} posts</p></section>`).join("");
  const headCtx = { title: `Archive – ${property.name}`, description: "The full publication archive by year and month.", canonical: url(property, "/archive/"), siteName: property.name };
  return documentShell(property, headCtx, body);
}

/**
 * Render an archive year page.
 * @param {object} property
 * @param {string} year
 * @param {object[]} posts posts published in this year, newest first
 * @returns {string}
 */
export function renderArchiveYearPage(property, year, posts) {
  return renderPostListPage(property, `Archive: ${year}`, `Posts published in ${year}.`, `/archive/${year}/`, posts);
}

/**
 * Render an archive month page.
 * @param {object} property
 * @param {string} year
 * @param {string} month two-digit month
 * @param {object[]} posts posts published in this month, newest first
 * @returns {string}
 */
export function renderArchiveMonthPage(property, year, month, posts) {
  return renderPostListPage(property, `Archive: ${year}-${month}`, `Posts published in ${year}-${month}.`, `/archive/${year}/${month}/`, posts);
}

/** Render the public publisher and coverage desks from publication settings. */
export function renderMastheadPage(property) {
  const masthead = property.masthead ?? {};
  const deskCards = (property.sections ?? []).map((desk) =>
    `<div class="masthead-card"><h3><a href="/desks/${esc(desk.slug)}/">${esc(desk.title)}</a></h3>` +
    `<p>${esc(desk.description ?? `Coverage from the ${desk.title} desk.`)}</p></div>`).join("");
  const body = `<h1>Masthead</h1><h2>Publisher</h2><p>${esc(masthead.publisher ?? "")}</p>` +
    `<h2>How we publish</h2><p>${esc(masthead.editorialMethod ?? "")}</p>` +
    `<p><a href="/standards/">Editorial standards</a> · <a href="/corrections/">Corrections</a> · <a href="/about/">About</a></p>` +
    `<h2>Coverage desks</h2><div class="desk-grid">${deskCards}</div>`;
  const headCtx = { title: `Masthead – ${property.name}`, description: `Publisher and coverage desks of ${property.name}.`, canonical: url(property, "/masthead/"), siteName: property.name };
  return documentShell(property, headCtx, body);
}

/** Render a static text page with already-escaped body HTML. */
export function renderStaticPage(property, title, path, bodyHtml, { description = title, jsonLd } = {}) {
  const body = `<h1>${esc(title)}</h1>${bodyHtml}`;
  const headCtx = { title: `${title} – ${property.name}`, description, canonical: url(property, path), siteName: property.name, ...(jsonLd ? { jsonLd } : {}) };
  return documentShell(property, headCtx, body);
}

/**
 * Render `/contact/`: how to reach the newsroom, stated from the property's
 * own configuration. Nothing here promises a reply it cannot keep.
 * @param {object} property
 */
export function renderContactPage(property) {
  const email = property.masthead?.contactEmail ?? property.contactEmail ?? "nik@koios.news";
  const publisher = (typeof property.masthead?.publisher === "string" ? property.masthead.publisher : property.masthead?.publisher?.name) ?? property.name;
  const advertising = hasAdvertisingInventory(property)
    ? `<h2>Advertising</h2><p>Advertising and sponsorship inquiries: see <a href="/advertise/">Advertise</a>.</p>` : "";
  const bodyHtml = `<p>${esc(property.name)} is published by ${esc(publisher)}.</p>` +
    `<h2>Newsroom</h2><p>Tips, press inquiries and questions about the reporting: <a href="mailto:${esc(email)}">${esc(email)}</a>. ` +
    `${esc(property.name)}'s reporting is produced with AI under independent editorial assessment, so a reply may come from an automated editorial process and a response time is not guaranteed.</p>` +
    `<h2>Errors and corrections</h2><p>If an article is wrong, <a href="/corrections/#report-an-error">report the error</a>. Corrections are published on the <a href="/corrections/">corrections page</a> and on the article itself.</p>` +
    advertising +
    `<h2>Policies</h2><p><a href="/standards/">Editorial standards</a> · <a href="/masthead/">Masthead</a> · <a href="/about/">About</a></p>`;
  return renderStaticPage(property, "Contact", "/contact/", bodyHtml, {
    description: `How to contact the ${property.name} newsroom, report an error, or ask about advertising.`,
    jsonLd: {
      "@context": "https://schema.org", "@type": "ContactPage", name: `Contact ${property.name}`, url: url(property, "/contact/"),
      about: { "@type": "NewsMediaOrganization", name: property.name, url: `${property.origin}/`,
        contactPoint: [{ "@type": "ContactPoint", contactType: "editorial", email, availableLanguage: property.language ?? "en" }] },
    },
  });
}

/**
 * Render the search page shell (the client script fills in results).
 * @param {object} property
 * @returns {string}
 */
export function renderSearchPage(property) {
  const body = `<h1>Search</h1>` +
    `<p>Find reporting by subject, person or place. Search includes the article text.</p>` +
    `<form id="search-form" class="search-form" role="search" aria-label="Search ${esc(property.name)}"><label for="search-q">Search articles</label>` +
    `<input id="search-q" type="search" name="q" placeholder="Search ${esc(property.name)}">` +
    `<label for="search-section">News desk</label><select name="section" id="search-section"><option value="">All desks</option>${(property.sections ?? []).map(section => `<option value="${esc(section.slug)}">${esc(section.title)}</option>`).join("")}</select>` +
    `<label for="search-sort">Sort by</label><select name="sort" id="search-sort"><option value="relevance">Relevance</option><option value="newest">Newest first</option></select><button type="submit">Search</button></form>` +
    `<p id="search-status" role="status" aria-live="polite">Loading search…</p><ul id="search-results"></ul><noscript>Search needs JavaScript. <a href="/archive/">Browse all articles in the archive</a> or use the news desks above.</noscript><script src="/assets/search.js" defer></script>`;
  const headCtx = { title: `Search – ${property.name}`, description: `Search ${property.name}.`, canonical: url(property, "/search/"), siteName: property.name };
  return documentShell(property, headCtx, body);
}

/**
 * Render the 404 page.
 * @param {object} property
 * @returns {string}
 */
export function render404Page(property) {
  const body = `<h1>Not found</h1><p>The requested page does not exist. <a href="/">Return to ${esc(property.name)}</a>.</p>`;
  const headCtx = { title: `Not found – ${property.name}`, description: "The requested page does not exist.", canonical: url(property, "/404.html"), siteName: property.name };
  return documentShell(property, headCtx, body);
}
