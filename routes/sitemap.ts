import express from "express";
import logger from "../utils/logger.ts";
import Game from "../models/game.ts";
import News from "../models/news.ts";
import { LISTS, countListGames } from "./lists.ts";
// The cache itself lives in utils, not here, so the models can drop it on a
// write without importing this router — see utils/page-cache.ts.
import {
  SITEMAP_KEY,
  clearSitemapCache,
  sitemapCache,
} from "../utils/page-cache.ts";
// absoluteUrl for the artwork, which is what the game page's own JSON-LD
// resolves the same images with — see the image entries below.
import { SITE_URL, absoluteUrl } from "../utils/site.ts";
// Shared with routes/feed.ts, which had a copy of its own. This one escaped
// only three characters and neither dropped what XML cannot carry at all —
// see utils/xml.ts.
import { escapeXml } from "../utils/xml.ts";
// The A–Z browse's pages, for the letter loop below.
import { LETTER_BUCKETS } from "../utils/letter-buckets.ts";

/**
 * One URL in the document.
 *
 * There is no `changefreq` and no `priority` here any more, and every entry
 * below used to carry at least one of them.
 *
 * Neither was ever read by anything this site is submitted to. Google has said
 * plainly, and repeatedly, that it ignores both — priority because a value a
 * site assigns to its own pages carries no information (every site's pages are
 * important to that site), changefreq because the crawler can see how often a
 * page actually changes and does not need to be told. Bing has said the same
 * of priority. So this was several hundred URLs each shipping two elements
 * written for no reader.
 *
 * Worse than merely useless, they were wrong in a way that invited trouble:
 * "daily" sat on listings that change when a game is added, which is not
 * daily, and the priorities encoded a ranking — 1.0 for the home page, 0.6 for
 * a deep publisher page — that this site has no way to act on and no engine
 * asked for.
 *
 * `lastmod` is the one freshness signal that survives, because it is the one
 * that is checked: Google uses it while it is consistently accurate and learns
 * to ignore it when it is not, which is the reasoning the block further down
 * applies when it declines to stamp a date on a page it cannot date honestly.
 */
interface SitemapEntry {
  url: string;
  lastmod?: string;
  /** Absolute addresses of the artwork on that page — see IMAGE_NS. */
  images?: string[];
}

/**
 * The Google image sitemap extension.
 *
 * Every game page carries a cover and a handful of screenshots, and none of
 * them were submitted anywhere — so the one part of this catalogue that is
 * pure visual content had no route into image search but an ordinary crawl.
 *
 * <image:loc> is the whole of it. The extension also defines caption, title,
 * geo_location and license, and Google dropped support for all four in 2022;
 * writing them now would add bytes to every URL in the file for nothing.
 *
 * Declared on the <urlset> only when a chunk actually carries an image. The
 * listing pages here have none, and a namespace declared and never used is
 * noise in a document that crawlers fetch whole.
 */
const IMAGE_NS = "http://www.google.com/schemas/sitemap-image/1.1";


// The protocol caps a single sitemap at 50,000 URLs. Half that keeps each
// file comfortably small and leaves room for the catalogue to grow before
// another one is needed. /sitemap-index.xml used to serve every URL as one
// <urlset> — it worked only because the site had not reached the limit yet.
const MAX_URLS_PER_SITEMAP = 25000;

function buildSitemapXml(entries: SitemapEntry[]): Buffer {
  let usesImages = false;

  const urlTags = entries.map((e) => {
    let tag = `  <url>\n    <loc>${escapeXml(SITE_URL + e.url)}</loc>\n`;
    if (e.lastmod) tag += `    <lastmod>${e.lastmod}</lastmod>\n`;

    // After the core elements rather than among them: those are a fixed
    // sequence in the sitemaps schema, and an extension belongs on the end of
    // it. The images are already filtered for blanks by the caller — a game
    // with an empty first slot would otherwise publish <image:loc></image:loc>
    // and claim the site itself as a picture.
    for (const image of e.images ?? []) {
      usesImages = true;
      tag +=
        `    <image:image>\n` +
        `      <image:loc>${escapeXml(image)}</image:loc>\n` +
        `    </image:image>\n`;
    }

    return tag + `  </url>`;
  });

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"` +
    (usesImages ? `\n        xmlns:image="${IMAGE_NS}"` : ``) +
    `>\n` +
    urlTags.join("\n") +
    `\n</urlset>`;

  return Buffer.from(xml, "utf-8");
}

/** The index itself: one <sitemap> entry per chunk served below. */
function buildSitemapIndexXml(chunks: SitemapEntry[][]): Buffer {
  const sitemapTags = chunks.map((chunk, i) => {
    // The freshest page in a chunk is what that chunk was last modified.
    const lastmod = chunk
      .map((entry) => entry.lastmod)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop();

    let tag = `  <sitemap>\n    <loc>${escapeXml(
      `${SITE_URL}/sitemap-${i + 1}.xml`,
    )}</loc>\n`;
    if (lastmod) tag += `    <lastmod>${lastmod}</lastmod>\n`;
    return tag + `  </sitemap>`;
  });

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapTags.join("\n") +
    `\n</sitemapindex>`;

  return Buffer.from(xml, "utf-8");
}

const router = express.Router();

interface CachedSitemap {
  index: Buffer;
  chunks: Buffer[];
}

const SITEMAP_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * What a shared cache may do with these documents.
 *
 * app.ts stamps "private, no-cache" on everything rendered per request, and
 * deliberately mounts the sitemap, the feeds and robots.txt ahead of it so
 * they stay cacheable — but "cacheable" was then left as no header at all,
 * which is the very thing that comment argues against: with nothing said, a
 * proxy or a CDN applies a heuristic of its own choosing.
 *
 * An hour rather than the day this is held server-side, because a save clears
 * the server's copy and cannot clear anybody else's. Crawlers ask for a
 * sitemap far less often than that, so the shorter life costs nothing.
 */
const SITEMAP_CACHE_CONTROL = "public, max-age=3600";

/** A fixed string that changes only with a deploy. */
const ROBOTS_CACHE_CONTROL = "public, max-age=86400";

// TtlCache holds the in-flight promise rather than the finished value, so the
// requests that arrive while a cold sitemap is still being built all wait for
// that one build. The plain variable this replaced was assigned only once the
// build had finished, so two crawlers arriving together each ran the whole
// thing — and a build is the better part of the catalogue. A failed build is
// dropped rather than remembered, as before.
//
// Re-exported under the name it has always had: the suite and the models both
// reach for it, and only the file it is declared in has moved.
export { clearSitemapCache };

async function buildEntries(): Promise<SitemapEntry[]> {
  const LIMIT = 25; // Same limit as used in routes

  const entries: SitemapEntry[] = [];
  const add = (entry: SitemapEntry) => entries.push(entry);

  // Everything the document is built from, asked for at once.
  //
  // The catalogue count, the news count and the two findForSitemap() calls
  // used to be awaited on their own, spread through the body — four round
  // trips in sequence around the one Promise.all in the middle. They are all
  // independent, and the entries below need the newest dates before the first
  // listing URL is written, so they are fetched together now.
  const [
    totalGamesCount,
    newsCount,
    gameGenres,
    developers,
    publishers,
    years,
    { counts: countMap, lastmods },
    games,
    newsItems,
  ] = await Promise.all([
    Game.count(),
    News.count(),
    Game.getGenres(),
    Game.getDevelopers(),
    Game.getPublishers(),
    Game.getYears(),
    // countMap used to be built by asking count() once per value — 26 letters
    // plus every genre, developer, publisher and year, several hundred queries
    // fired at once through a ten-connection pool, and paid again on every
    // save because a save clears this cache. It is one GROUP BY now; the keys
    // are unchanged, and `lastmods` is the same grouping's MAX("updatedAt").
    Game.getSitemapCounts(),
    Game.findForSitemap(),
    News.findForSitemap(),
  ]);

  /**
   * <lastmod> takes a W3C datetime, and every entry in this file states a
   * plain date. Trimming here rather than at each call site so the format
   * cannot drift between the game entries and the listing ones.
   */
  const asDate = (iso: string | undefined): string | undefined =>
    iso?.split("T")[0];

  const latestGameDate =
    games.length > 0
      ? games
          .map((g) => (g.updatedAt ? new Date(g.updatedAt).getTime() : 0))
          .reduce((a, b) => Math.max(a, b), 0)
      : null;
  const latestNewsDate =
    newsItems.length > 0
      ? newsItems
          .map((n) => new Date(n.updatedAt).getTime())
          .reduce((a, b) => Math.max(a, b), 0)
      : null;

  // Whichever of the two is later, and either on its own. The ternary this
  // replaces consulted the news only when there was also a game date, so a
  // catalogue with no dated game and fresh news shipped the home entry with
  // no <lastmod> at all.
  const latestHomeDate = Math.max(latestGameDate ?? 0, latestNewsDate ?? 0);

  const homeLastmod =
    latestHomeDate > 0
      ? new Date(latestHomeDate).toISOString().split("T")[0]
      : undefined;

  const newsLastmod = latestNewsDate
    ? new Date(latestNewsDate).toISOString().split("T")[0]
    : undefined;

  /**
   * When the catalogue as a whole last changed — what a page that stands over
   * all of it was last modified: the developer, publisher and year indexes and
   * the index of the lists. Full ISO, trimmed by asDate where it is stamped,
   * like the per-group values from Game.getSitemapCounts.
   *
   * Not what a *ranking* was last modified, which is why the curated lists
   * and /most-played no longer take it — see the note on rankings below.
   */
  const catalogueLastmod = latestGameDate
    ? new Date(latestGameDate).toISOString()
    : undefined;

  /**
   * Why the pages that rank games carry no lastmod at all.
   *
   * /most-played orders the catalogue by plays, and every curated list —
   * /top-dos-games, the best-<genre>-games lists and the two decade lists —
   * orders its games by the vote-weighted rating (see `findParams` in
   * routes/lists.ts, all of which sort on "rating"). Their content moves with
   * every play and every vote, and neither of those touches
   * "games"."updatedAt": a play writes a "plays" row and nothing else, and the
   * 0042 trigger writes a vote into "ratingSum" and "ratingCount" alone. So
   * the date these used to be stamped with — the newest edit to any game
   * they could hold — stood still while the ranking under it changed, which
   * is the inaccurate lastmod this file refuses everywhere else: Google leans
   * on the element only while it is consistently right, and one that is
   * wrong on these pages is a reason to stop reading it on the game pages,
   * where it is right. Nothing fetched here knows when the last play or vote
   * was, so they say nothing, as /comments already did for the newest comment.
   *
   * The listings whose content really is the games — a genre, a letter, a
   * studio, a year, and the indexes of those — keep theirs.
   */

  /**
   * Why the deeper pages of a listing get no lastmod while page 1 does.
   *
   * The value available here is MAX("updatedAt") over the games in a group,
   * and that describes the front of the listing honestly — the newest thing
   * in this section is this old — but not page 7 of it, which a game edited
   * today probably does not appear on at all. Google leans on lastmod only
   * while it is consistently accurate and learns to ignore the element when
   * it is not, so the deep pages are left saying nothing rather than all
   * claiming today's date. They are exactly as they were before.
   *
   * Nor is it stamped on /about and /how-to-play: those change when somebody
   * edits the template, which is a deploy, and nothing in the database knows
   * when that was. A made-up date there would be the same mistake.
   */

  // Add paginated pages for main index
  const totalPages = Math.ceil(totalGamesCount / LIMIT);

  for (let page = 2; page <= totalPages; page++) {
    add({
      url: `/?page=${page}`,
    });
  }

  // A ranking by plays, so no lastmod — see the note on rankings above.
  add({ url: `/most-played` });

  // Page 1 only. The deeper pages are noindex — they would compete with the
  // game pages the comments were actually posted on.
  //
  // No lastmod: this page is as fresh as the newest comment on the site, and
  // that date is not among anything fetched above. Asking for it would be a
  // query for one URL's sake.
  add({ url: `/comments` });

  add({
    url: `/developers`,
    lastmod: asDate(catalogueLastmod),
  });
  add({
    url: `/publishers`,
    lastmod: asDate(catalogueLastmod),
  });
  add({
    url: `/years`,
    lastmod: asDate(catalogueLastmod),
  });
  add({ url: `/how-to-play` });

  // /about earns its place: it is a standing page with content worth
  // ranking, and it was reachable by crawl alone before this line.
  //
  // /privacy-policy and /dmca are back beside it. They were taken out when
  // both carried "noindex, follow", and the reasoning was sound for as long
  // as that was true — submitting a page that refuses to be indexed is what
  // Search Console reports as "Submitted URL marked 'noindex'". The tag is
  // gone (routes/home.ts says why), so the objection goes with it. They are
  // listed here for the same reason /about is: a sitemap is the list of
  // pages a site wants indexed, and these two are now on it.
  add({ url: `/about` });
  add({ url: `/privacy-policy` });
  add({ url: `/dmca` });

  // The index of the curated lists, which stands whatever they hold. The
  // lists themselves are added further down, once the counts are in — see
  // there for why.
  add({
    url: `/game-lists`,
    lastmod: asDate(catalogueLastmod),
  });

  // Add paginated pages for news
  const newsPages = Math.ceil(newsCount / 10); // News uses limit of 10

  for (let page = 2; page <= newsPages; page++) {
    add({ url: `/news?page=${page}` });
  }

  // Add curated game list pages
  for (const list of LISTS) {
    // Every one of these used to be listed unconditionally, and the
    // "best-<genre>-games" lists are one genre each — so a genre the
    // catalogue holds nothing for was advertised here and answers 404 (see
    // the guard in routes/lists.ts). countListGames reads the counts already
    // fetched above rather than asking once per list.
    if (countListGames(list, countMap, totalGamesCount) === 0) continue;

    // One URL each, with no ?page= children. These lists are a fixed hundred
    // games on one page now — see LIST_SIZE in routes/lists.ts, which also
    // says why, and which 301s the old paginated addresses onto this one.
    //
    // And no lastmod: every one of them is a ranking by rating, which moves
    // with votes that no game's "updatedAt" records — see the note on
    // rankings above.
    add({ url: `/${list.slug}` });
  }

  // Add letter pages: the twenty-six letters and the one "0-9" page for every
  // slug that begins with a digit — the pages routes/home.ts answers at, from
  // the list that route validates against. It walked the alphabet alone, so a
  // catalogue's "1942" and "688 Attack Sub" were on no listed page, and the
  // keys getSitemapCounts used to produce for them ("letter:1") were never
  // read. Walking the buckets rather than the keys also means a key for a page
  // that does not exist cannot become a URL. See utils/letter-buckets.ts.
  for (const letter of LETTER_BUCKETS) {
    const letterCount = countMap.get(`letter:${letter}`) || 0;

    // All 26 used to be listed whatever the catalogue held, so a letter no
    // slug starts with was advertised to crawlers — and now answers 404.
    if (letterCount === 0) continue;

    add({
      url: `/letter/${letter}`,
      lastmod: asDate(lastmods.get(`letter:${letter}`)),
    });

    const letterPages = Math.ceil(letterCount / LIMIT);

    for (let page = 2; page <= letterPages; page++) {
      add({
        url: `/letter/${letter}?page=${page}`,
      });
    }
  }

  // Add genre pages
  for (const genre of gameGenres) {
    const genreCount = countMap.get(`genre:${genre}`) || 0;

    // The enum carries every genre the site knows, not every genre it has
    // games for; an empty one answers 404 like the letters above.
    if (genreCount === 0) continue;

    add({
      url: `/${genre.toLowerCase()}`,
      lastmod: asDate(lastmods.get(`genre:${genre}`)),
    });

    const genrePages = Math.ceil(genreCount / LIMIT);

    for (let page = 2; page <= genrePages; page++) {
      add({
        url: `/${genre.toLowerCase()}?page=${page}`,
      });
    }
  }

  // Add developer pages
  for (const developer of developers) {
    add({
      url: `/developer/${encodeURIComponent(developer)}`,
      lastmod: asDate(lastmods.get(`developer:${developer}`)),
    });

    const developerCount = countMap.get(`developer:${developer}`) || 0;
    const developerPages = Math.ceil(developerCount / LIMIT);

    for (let page = 2; page <= developerPages; page++) {
      add({
        url: `/developer/${encodeURIComponent(developer)}?page=${page}`,
      });
    }
  }

  // Add publisher pages
  for (const publisher of publishers) {
    add({
      url: `/publisher/${encodeURIComponent(publisher)}`,
      lastmod: asDate(lastmods.get(`publisher:${publisher}`)),
    });

    const publisherCount = countMap.get(`publisher:${publisher}`) || 0;
    const publisherPages = Math.ceil(publisherCount / LIMIT);

    for (let page = 2; page <= publisherPages; page++) {
      add({
        url: `/publisher/${encodeURIComponent(publisher)}?page=${page}`,
      });
    }
  }

  // Add year pages
  for (const year of years) {
    add({
      url: `/year/${year}`,
      lastmod: asDate(lastmods.get(`year:${year}`)),
    });

    const yearCount = countMap.get(`year:${year}`) || 0;
    const yearPages = Math.ceil(yearCount / LIMIT);

    for (let page = 2; page <= yearPages; page++) {
      add({
        url: `/year/${year}?page=${page}`,
      });
    }
  }

  // Prepend home and news listing entries at the start of the array
  entries.unshift(
    {
      url: `/news`,
      lastmod: newsLastmod,
    },
    { url: `/`, lastmod: homeLastmod },
  );

  games.forEach((game) => {
    const lastmod = game.updatedAt
      ? new Date(game.updatedAt).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    // Blank slots dropped, and anything relative made absolute: <image:loc>
    // takes a full address, the same as <loc> above. The admin form accepts a
    // path on this site as well as an address on the media origin (see
    // validations/games.ts), so a relative value is an ordinary one here.
    //
    // Resolved with absoluteUrl(), which is what the game page's JSON-LD
    // uses for the same images, rather than the SITE_URL + image this was.
    // Concatenation is only right for a path that starts with "/" and needs
    // no encoding: a space went out as it stood, and a path stored without
    // its leading slash — which the validator used to accept — was published
    // as "https://oldschoolgames.euimages/doom.png". absoluteUrl() resolves
    // both the way a browser on the page would, so the sitemap and the page
    // name one address for one picture. What still is not http(s) after that
    // (a "data:" URI left over from before the validator) is not an image
    // address a crawler can fetch, and is left out.
    const images = (game.images ?? [])
      .filter(Boolean)
      .map(absoluteUrl)
      .filter((image) => /^https?:\/\//i.test(image));

    add({
      url: `/${game.slug}`,
      lastmod,
      ...(images.length > 0 ? { images } : {}),
    });
  });

  newsItems.forEach((news) => {
    const lastmod = new Date(news.updatedAt).toISOString().split("T")[0];

    add({
      url: `/news/${news.slug}`,
      lastmod,
    });
  });

  return entries;
}

/** Builds and caches the index and every chunk in one pass. */
function getSitemap(): Promise<CachedSitemap> {
  return sitemapCache.get(SITEMAP_KEY, SITEMAP_TTL, async () => {
    const entries = await buildEntries();

    const chunked: SitemapEntry[][] = [];
    for (let i = 0; i < entries.length; i += MAX_URLS_PER_SITEMAP) {
      chunked.push(entries.slice(i, i + MAX_URLS_PER_SITEMAP));
    }

    // An empty catalogue still needs one (empty) sitemap for the index to
    // point at, otherwise the index references nothing and crawlers report an
    // error.
    if (chunked.length === 0) {
      chunked.push([]);
    }

    return {
      index: buildSitemapIndexXml(chunked),
      chunks: chunked.map(buildSitemapXml),
    };
  });
}

function sendUnavailable(res: express.Response, error: unknown): void {
  logger.error("Sitemap generation error:", error);
  // no-store, for the reason routes/feed.ts gives on its own 500: a response
  // with no Cache-Control lets a shared cache invent its own freshness, and a
  // crawler being handed "Sitemap temporarily unavailable" out of a proxy
  // after the outage is over is worse than being handed it during one.
  res
    .status(500)
    .header("Content-Type", "text/plain")
    .header("Cache-Control", "no-store")
    .send("Sitemap temporarily unavailable");
}

/**
 * Served from here rather than as a file in public/, because the Sitemap line
 * has to name the host the site is actually running on. As a static file it
 * carried a hard-coded "oldschoolgames.eu", so any deployment setting
 * CANONICAL_HOST pointed crawlers at somebody else's sitemap.
 *
 * The Disallow list is the admin surface, plus /random.
 *
 * "Disallow: /*?*search=" used to be here as well and is deliberately gone.
 * A search result is already "noindex, follow" (see views/head.ejs, which
 * reasons the case out at length) and the two directives do not stack — they
 * contradict. Disallow stops the crawl, and a page that is never crawled is a
 * page whose noindex is never read: Google's own guidance is that a URL
 * blocked in robots.txt can still be indexed from its inbound links, precisely
 * because the tag saying not to is behind the block. Keeping the reliable half
 * and dropping the half that hides it is the resolution. It costs nothing in
 * crawl budget either: a search URL is produced by submitting a form, so
 * nothing on the site links to one for a crawler to find.
 *
 * "Disallow: /login" and "Disallow: /profile" are gone for that same reason,
 * and they were the worse case of the two: views/footer.ejs links both from
 * every page on the site, so unlike a search URL they have every chance of
 * being found and indexed from those links while the block keeps the tag that
 * forbids it out of reach. /profile already carried a noindex the block was
 * hiding; /login carries one now too (see routes/auth.ts). Both are reliable
 * where a Disallow was not.
 *
 * /logout stays, and costs nothing either way — it answers POST only, so
 * there is no GET there for a crawler to make in the first place.
 *
 * /random is new, and is the opposite case — a link in the navbar on every
 * page, answering every request with a 302 to a different game. Nothing there
 * is worth crawling twice, let alone once per page a crawler visits.
 *
 * ── The AI crawlers ────────────────────────────────────────────────────────
 * GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot and the rest are
 * covered by the "*" group above and are therefore allowed, on the same terms
 * as every other crawler. That is a decision, not an omission, and it is
 * written down here because the file gave no way to tell the two apart — a
 * reader could only conclude that nobody had considered the question.
 *
 * It is the decision the rest of the site already implies. utils/faq.ts marks
 * up /how-to-play as an FAQPage while saying plainly that Google stopped
 * rendering those in 2023, and keeps it because "answer engines read it to
 * find the one paragraph that answers a question". A site that publishes
 * structured data for answer engines and then blocks the crawlers that feed
 * them is arguing with itself. The catalogue is also not the product here:
 * nobody plays a DOS game by reading about it, so a model that has read these
 * descriptions and names the site is a referral rather than a substitute.
 *
 * There is deliberately no named "User-agent: GPTBot" group, and it is worth
 * knowing why before adding one. robots.txt matching is not additive: a
 * crawler obeys the single most specific group that names it and ignores
 * every other, "*" included. So a group naming GPTBot with nothing but an
 * Allow would exempt it from the Disallow list above — the admin forms and
 * /random, which answers every request with a redirect to a different game.
 * A named group has to repeat the whole list to be safe.
 *
 * To reverse this — and it is a business decision, so reversing it needs no
 * argument with any of the above — add one group per agent carrying the same
 * Disallow lines plus "Disallow: /", or state "Disallow: /" alone and accept
 * that the exclusions become moot for that agent. Note that robots.txt is the
 * only lever here: it governs crawling, not training, and an agent that
 * ignores it is not stopped by anything in this file.
 *
 * Every rule ends in "$". A Disallow line is a *prefix* (RFC 9309), so
 * "Disallow: /news/new" also blocked every article whose slug begins with
 * "new" — "New games added" lives at /news/new-games-added, and a title with
 * no Latin letters falls back to /news/news — and "Disallow: /random" blocked
 * the game a title of "Random" is filed under, /random-2, because the bare
 * slug is reserved for the route. Those pages are in the sitemap, so each one
 * was a "Submitted URL blocked by robots.txt" in Search Console and an index
 * entry with no snippet. "$" anchors the rule to the end of the path; Google
 * and Bing both honour it, and RFC 9309 requires it. /random is the one address
 * reached with a query as well ("?not=" names the game to skip), so it gets a
 * second, query-shaped line — a literal "?" in a rule is just a character.
 */
const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /logout$
Disallow: /random$
Disallow: /random?
Disallow: /games/new$
Disallow: /games/*/edit$
Disallow: /news/new$
Disallow: /news/*/edit$

Sitemap: ${SITE_URL}/sitemap-index.xml
`;

/**
 * Exported rather than mounted on this router, because app.ts puts it ahead
 * of the session, CSRF and voter-id middleware. Crawlers are almost the only
 * thing that asks for robots.txt, and going through the full stack handed
 * every one of them a pair of cookies it will never send back — the same
 * waste the flash middleware was rewritten to stop.
 */
export function robotsTxt(req: express.Request, res: express.Response): void {
  res
    .header("Content-Type", "text/plain; charset=utf-8")
    .header("Cache-Control", ROBOTS_CACHE_CONTROL)
    .send(ROBOTS_TXT);
}

/**
 * The conventional address, which this site did not answer.
 *
 * robots.txt names /sitemap-index.xml and Search Console has it registered, so
 * that stays the one document — but /sitemap.xml is where a crawler or an
 * audit tool looks when it has not read robots.txt yet, and where a person
 * types first. A permanent redirect rather than a second copy of the same XML:
 * one sitemap should live at one address, which is the reasoning the rest of
 * this file applies to every other URL on the site.
 */
router.get("/sitemap.xml", (req, res) => {
  res
    .header("Cache-Control", SITEMAP_CACHE_CONTROL)
    .redirect(301, `${SITE_URL}/sitemap-index.xml`);
});

// robots.txt points here, and search engines already have this address
// registered, so it keeps its name — it is simply a real <sitemapindex> now
// rather than a <urlset> wearing the wrong label.
router.get("/sitemap-index.xml", async (req, res) => {
  try {
    const { index } = await getSitemap();

    // Set once there is a document to send, not before: a build that fails
    // below answers 500 in plain text, and it used to inherit the XML content
    // type — and would now inherit an hour of public caching along with it.
    res
      .header("Content-Type", "application/xml; charset=utf-8")
      .header("Cache-Control", SITEMAP_CACHE_CONTROL)
      .send(index);
  } catch (error) {
    sendUnavailable(res, error);
  }
});

router.get("/sitemap-:page.xml", async (req, res, next) => {
  const raw = req.params.page;

  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    return next();
  }

  try {
    const { chunks } = await getSitemap();
    const chunk = chunks[Number(raw) - 1];

    // Both exits below hand the request on to someone who sends HTML — the
    // 404 view, or the error handler — so the XML content type is set only
    // once there is XML to send. Setting it up front left the 404 page
    // labelled "application/xml".
    if (!chunk) {
      return next();
    }

    res
      .header("Content-Type", "application/xml; charset=utf-8")
      .header("Cache-Control", SITEMAP_CACHE_CONTROL)
      .send(chunk);
  } catch (error) {
    sendUnavailable(res, error);
  }
});

export default router;
