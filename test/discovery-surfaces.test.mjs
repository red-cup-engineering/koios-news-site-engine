import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildConfiguredProperty } from "../scripts/build-property.mjs";
import { homeDescription, renderLlmsTxt, renderRobotsGroups, renderSecurityTxt } from "../src/render/discovery.mjs";

const fixture = fileURLToPath(new URL("./fixtures/property.json", import.meta.url));
const instant = new Date("2026-10-21T12:00:00.000Z");

function build(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "koios-discovery-"));
  const property = JSON.parse(readFileSync(fixture, "utf8"));
  property.content = { ...property.content, root: fileURLToPath(new URL("./fixtures/content", import.meta.url)) };
  mutate(property);
  const config = join(root, "property.json");
  writeFileSync(config, JSON.stringify(property));
  const out = join(root, "public");
  buildConfiguredProperty(config, out, { asOf: instant });
  const read = (path, encoding = "utf8") => readFileSync(join(out, path), encoding === "bytes" ? undefined : encoding);
  return { read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a short tagline is lengthened into a search-ready description; an explicit one wins", () => {
  const short = homeDescription({ tagline: "General news with systems-analysis depth.", sections: [{}, {}, {}] });
  assert.ok(short.length >= 50 && short.length <= 160, short);
  assert.match(short, /^General news with systems-analysis depth\. /u);
  assert.equal(homeDescription({ tagline: "x", description: "Chosen on purpose." }), "Chosen on purpose.");
  const long = "A tagline that is already long enough to describe the page to a search engine snippet.";
  assert.equal(homeDescription({ tagline: long }), long);
});

test("the home page declares its parents, search, description and a complete icon set", () => {
  const site = build();
  try {
    const home = site.read("index.html");
    const description = home.match(/<meta name="description" content="([^"]*)">/u)[1];
    assert.ok(description.length >= 50 && description.length <= 160, description);
    const graph = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)].flatMap((match) => [JSON.parse(match[1])].flat());
    const publisher = graph.find((node) => node["@type"] === "NewsMediaOrganization");
    assert.deepEqual(publisher.parentOrganization.map((org) => [org.name, org.url]), [
      ["Causeway Services", "https://services.561.group/"], ["561 Group", "https://561.group/"],
    ]);
    const website = graph.find((node) => node["@type"] === "WebSite");
    assert.equal(website.potentialAction["@type"], "SearchAction");
    assert.equal(website.potentialAction.target.urlTemplate, "https://koios.news/search/?q={search_term_string}");
    const apple = site.read("apple-touch-icon.png", "bytes");
    assert.deepEqual([...apple.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(apple.readUInt32BE(16), 180);
    const ico = site.read("favicon.ico", "bytes");
    assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
    assert.deepEqual([...ico.subarray(22, 30)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(site.read("apple-touch-icon.png", "bytes"), apple, "icons are deterministic");
  } finally { site.cleanup(); }
});

test("headers carry HSTS without includeSubDomains alongside the existing policy", () => {
  const site = build();
  try {
    const headers = site.read("_headers");
    assert.match(headers, /^\s+Strict-Transport-Security: max-age=63072000$/mu);
    assert.doesNotMatch(headers, /includeSubDomains/u);
    assert.match(headers, /^\s+X-Content-Type-Options: nosniff$/mu);
    assert.match(headers, /frame-ancestors 'none'/u);
    assert.match(headers, /object-src|default-src 'self'/u);
  } finally { site.cleanup(); }
});

test("robots names each AI crawler and both sitemaps; security.txt follows RFC 9116", () => {
  const site = build();
  try {
    const robots = site.read("robots.txt");
    for (const agent of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot"]) {
      assert.match(robots, new RegExp(`User-agent: ${agent}\\nAllow: /\\n`, "u"));
    }
    assert.match(robots, /^User-agent: \*\nAllow: \/\n/u);
    assert.match(robots, /^Sitemap: https:\/\/koios\.news\/sitemap\.xml$/mu);
    assert.match(robots, /^Sitemap: https:\/\/koios\.news\/news-sitemap\.xml$/mu);
    const security = site.read(".well-known/security.txt");
    assert.match(security, /^Contact: mailto:cto@561\.group$/mu);
    assert.match(security, /^Canonical: https:\/\/koios\.news\/\.well-known\/security\.txt$/mu);
    assert.match(security, /^Expires: 2027-09-16T12:00:00\.000Z$/mu);
  } finally { site.cleanup(); }
});

test("llms.txt lists sections, latest stories, feeds, newsroom pages and the paid briefing", () => {
  const site = build((property) => {
    property.monetization = { ...property.monetization, x402: {
      market: "https://market.561.group", route: "/v1/koios/briefing/current", priceUsd: "0.25", label: "Koios Intelligence Briefing",
    } };
  });
  try {
    const llms = site.read("llms.txt");
    assert.match(llms, /^# Koios\.News\n\n> /u);
    assert.match(llms, /^## Sections$/mu);
    assert.match(llms, /^- \[World\]\(https:\/\/koios\.news\/sections\/world\/\): /mu);
    assert.match(llms, /^## Latest stories$/mu);
    assert.match(llms, /^- \[[^\]]+\]\(https:\/\/koios\.news\/posts\/[a-z0-9-]+\/\): /mu);
    assert.match(llms, /\(https:\/\/koios\.news\/feed\.json\)/u);
    assert.match(llms, /\(https:\/\/koios\.news\/news-sitemap\.xml\)/u);
    assert.match(llms, /\(https:\/\/koios\.news\/masthead\/\)/u);
    assert.match(llms, /^- \[Koios Intelligence Briefing\]\(https:\/\/market\.561\.group\/v1\/koios\/briefing\/current\): .*\$0\.25 per request over x402/mu);
    assert.doesNotMatch(llms, /morgan|sennhauser|emsenn/iu);
  } finally { site.cleanup(); }
});

test("llms.txt links only pages the build emits", () => {
  const llms = renderLlmsTxt({
    property: { name: "Koios.News", origin: "https://koios.news", tagline: "A tagline long enough to need no help from the sections.", sections: [{ slug: "a", title: "A" }] },
    posts: [], routes: new Set(["masthead/index.html"]),
  });
  assert.match(llms, /masthead/u);
  assert.doesNotMatch(llms, /\/sections\/a\/|\/standards\/|\/corrections\/|## Latest stories/u);
});

test("renderers are pure: same inputs, same bytes", () => {
  assert.equal(renderRobotsGroups(["https://a/sitemap.xml"]), renderRobotsGroups(["https://a/sitemap.xml"]));
  const property = { origin: "https://koios.news", language: "en" };
  assert.equal(renderSecurityTxt(property, instant), renderSecurityTxt(property, instant));
});
