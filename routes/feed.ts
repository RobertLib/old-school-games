import express from "express";
import logger from "../utils/logger.ts";
import Game from "../models/game.ts";
import News from "../models/news.ts";
// The cache itself lives in utils, not here, so the models can drop it on a
// write without importing this router — see utils/page-cache.ts.
import { clearFeedCache, feedCache } from "../utils/page-cache.ts";
import { SITE_URL } from "../utils/site.ts";
import { htmlToPlainText, truncateAtWord } from "../utils/html-text.ts";
// Shared with routes/sitemap.ts, which had a copy of its own. Both only
// swapped the five markup characters, which does not make a document
// well-formed on its own — see utils/xml.ts.
import { escapeXml } from "../utils/xml.ts";

const router = express.Router();

const FEED_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * What a shared cache may do with a feed — the same reasoning as the sitemap's
 * header in routes/sitemap.ts. app.ts mounts these ahead of the
 * "private, no-cache" it stamps on rendered pages, deliberately, but leaving
 * them with no header at all still hands the decision to whatever proxy sits
 * in front of this.
 *
 * Matched to the TTL above, so the copy a reader is handed is never older than
 * the one this process is willing to serve.
 */
const FEED_CACHE_CONTROL = "public, max-age=900";

interface FeedItem {
  title: string;
  url: string;
  description: string;
  date: Date;
}

// Entities are decoded on the way through, not left as they were stored:
// escapeXml runs over the result, so "&amp;" reached readers as "&amp;amp;"
// and they displayed the entity rather than the ampersand.
function toPlainText(html: string | null | undefined, maxLength = 400): string {
  return truncateAtWord(htmlToPlainText(html), maxLength);
}

function buildRssXml({
  title,
  description,
  feedPath,
  items,
}: {
  title: string;
  description: string;
  feedPath: string;
  items: FeedItem[];
}): string {
  const latest = items.length > 0 ? items[0]!.date : new Date();

  const itemTags = items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(SITE_URL + item.url)}</link>
      <guid isPermaLink="true">${escapeXml(SITE_URL + item.url)}</guid>
      <description>${escapeXml(item.description)}</description>
      <pubDate>${item.date.toUTCString()}</pubDate>
    </item>`,
    )
    .join("\n");

  // The two channel-level addresses go through escapeXml like every other
  // value here, which they used to skip. SITE_URL comes from CANONICAL_HOST
  // rather than from a visitor, so nothing can inject through it — but it is
  // still a configured string being pasted into XML, and an "&" in a host
  // makes the *document* malformed rather than one entry: a parser stops at
  // it, so the whole feed is lost to every subscriber. That is the exact
  // failure utils/xml.ts exists to prevent, and routes/sitemap.ts already
  // escapes the same value when it builds <loc>.
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(SITE_URL + "/")}</link>
    <atom:link href="${escapeXml(SITE_URL + feedPath)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>en</language>
    <lastBuildDate>${latest.toUTCString()}</lastBuildDate>
${itemTags}
  </channel>
</rss>`;
}

/**
 * Re-exported under the name it has always had, so the models and the suite
 * keep one address for it while the cache itself lives in utils.
 *
 * feedCache is a TtlCache, which holds the in-flight promise rather than the
 * finished value — so requests arriving while a cold feed is still being
 * built all wait for that one build. The plain Map this replaced was written
 * only once the build had finished, so two crawlers arriving together each
 * ran the whole thing, the same trap /sitemap-index.xml was already out of. A
 * failed build is dropped rather than remembered.
 */
export { clearFeedCache };

async function serveFeed(
  cacheKey: string,
  res: express.Response,
  build: () => Promise<string>,
): Promise<void> {
  try {
    const xml = await feedCache.get(cacheKey, FEED_TTL, build);

    // Set once there is a feed to send rather than up front, so the plain-text
    // 500 below cannot inherit the content type — or the caching.
    res
      .header("Content-Type", "application/rss+xml; charset=utf-8")
      .header("Cache-Control", FEED_CACHE_CONTROL)
      .send(xml);
  } catch (error) {
    logger.error(`Feed generation error (${cacheKey}):`, error);
    res
      .status(500)
      .header("Content-Type", "text/plain")
      .send("Feed temporarily unavailable");
  }
}

// Newly added games — the reason to subscribe.
router.get("/feed.xml", async (req, res) => {
  await serveFeed("games", res, async () => {
    const games = await Game.findRecentForFeed(30);

    return buildRssXml({
      title: "OldSchoolGames — New games",
      description:
        "Classic MS-DOS games newly added to OldSchoolGames.eu — playable free in your browser.",
      feedPath: "/feed.xml",
      items: games.map((game) => ({
        title: game.title,
        url: `/${game.slug}`,
        description:
          toPlainText(game.description) ||
          `Play ${game.title} online — a classic MS-DOS game.`,
        date: new Date(game.createdAt),
      })),
    });
  });
});

router.get("/news/feed.xml", async (req, res) => {
  await serveFeed("news", res, async () => {
    const { news } = await News.findAll({ page: 1, limit: 30 });

    return buildRssXml({
      title: "OldSchoolGames — News",
      description: "News and updates from OldSchoolGames.eu.",
      feedPath: "/news/feed.xml",
      items: news.map((item) => ({
        title: item.title,
        url: `/news/${item.slug}`,
        description: toPlainText(item.content),
        date: new Date(item.createdAt),
      })),
    });
  });
});

export default router;
