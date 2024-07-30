import { TtlCache } from "./cache.ts";

/**
 * The cache behind the chrome every page renders — the genre list and the
 * sidebar widgets.
 *
 * It lives here rather than in the middleware that fills it so that the
 * models can drop an entry when they change what it holds, without the
 * middleware and the models having to import each other in a circle.
 */
export const sidebarCache = new TtlCache();

/** The entry holding the sidebar's "Latest comments" widget. */
export const LATEST_COMMENTS_KEY = "latestComments";

/**
 * The entry holding the pool the featured carousel draws its slides from.
 * Named here, next to the widget keys, because both the model that fills it
 * and the writes that invalidate it live outside the middleware.
 */
export const FEATURED_POOL_KEY = "featuredPool";

/**
 * The entry holding the sidebar's "Recently added" widget.
 *
 * Invalidated by the game writes for the same reason the comment widget is:
 * it is the one widget whose whole purpose is to show what just arrived, and
 * on a five-minute TTL a freshly added game was missing from it for up to
 * five minutes — while the sitemap, the feed and the featured pool had all
 * already been dropped by the same save.
 */
export const RECENTLY_ADDED_KEY = "recentlyAddedGames";

/**
 * The entries holding the "Most played" and "Top rated" widgets.
 *
 * Named here, and dropped by the game writes, for the mirror image of the
 * reason "Recently added" is: a game that has just been deleted went on being
 * offered by both for up to five minutes, and following either link landed on
 * a 404 — while the same save had already dropped the sitemap, the feed, the
 * featured pool and the recently-added list.
 *
 * A rating or a play deliberately does not invalidate these. Those arrive
 * constantly, the ranking they feed moves slowly, and five minutes is the
 * staleness the TTL is there to buy.
 */
export const MOST_PLAYED_GAMES_KEY = "mostPlayedGames";
export const TOP_RATED_GAMES_KEY = "topRatedGames";

/**
 * The entry holding the "Game of the Week" widget.
 *
 * Dropped by the game writes for the same reason as the two above, and it was
 * the one that got left behind when they were fixed — while being the worst
 * case of the lot. The pick is held for an *hour*, not five minutes, and the
 * widget is the largest thing on the homepage: it renders the game's title,
 * its cover art and two links to it. Deleting the game that happens to be
 * game of the week left all of that on display for up to an hour, with every
 * link answering 404 — the row itself is already gone by then, because
 * "gameId" cascades (see 0012_create_game_of_the_week.sql), so nothing but
 * this cache was still claiming the game existed.
 *
 * A rename is the milder half of the same problem: the widget goes on linking
 * to the previous address, which still resolves — the slug history redirects
 * it — but sends every visitor through a 301 for the rest of the hour.
 */
export const GAME_OF_THE_WEEK_KEY = "gameOfTheWeek";

/**
 * The entry holding the "Most discussed games" panel beside the /comments
 * overview.
 *
 * It is a GROUP BY over every comment on the site joined to "games", with no
 * index that can answer it — the one genuinely expensive query on that page,
 * and it ran on every request for page 1. Cached here rather than in the
 * route so that models/comment.ts can drop it on a write, which is the same
 * arrangement "Latest comments" has and for the same reason: the widget and
 * the writes that invalidate it live in different files.
 *
 * Dropped by the comment writes (it counts comments) and by the game writes
 * (it embeds each game's title and slug, so a rename or a delete leaves it
 * pointing at an address that has moved or gone).
 */
export const MOST_DISCUSSED_KEY = "mostDiscussedGames";

/**
 * Five minutes, matching the sidebar's other aggregates rather than the two
 * the "Latest comments" widget gets. A ranking of the busiest threads on the
 * site does not visibly move when one comment is posted, and the writes drop
 * it anyway — the TTL is only the bound on how stale a *remote* machine's copy
 * can get between epoch checks.
 */
export const MOST_DISCUSSED_TTL_MS = 5 * 60 * 1000;

/**
 * The entry holding which listing pages have a game behind them — the curated
 * lists, the genres, the years and the pages of the A–Z filter — and the
 * counts they were decided from. See NonEmptyListings and
 * loadNonEmptyListings in middlewares/sidebar-data.ts, which fills it.
 *
 * Named here rather than written out as a literal in the middleware for the
 * same reason as every key above: the game writes have to drop it, and a
 * literal in one file and a delete in another drift apart silently. This one
 * was the drift — clearGameCaches dropped every other sidebar entry and not
 * this one, so deleting the last game of a genre left the sidebar linking a
 * list that answers 404, on the machine that did the writing, for up to the
 * five minutes of its TTL.
 *
 * The name still says "lists" because the curated lists are what it first
 * held and clearGameCaches deletes it by this name; the genres, the letters
 * and the years were added to the same entry rather than given keys of their
 * own precisely so that delete keeps covering all of them. The value is the
 * cache key alone — the entry spreads its answers onto res.locals under their
 * own names — so it no longer spells a local that would suggest otherwise.
 */
export const NON_EMPTY_LISTS_KEY = "nonEmptyListings";

/**
 * How long a *failed* sidebar load is remembered.
 *
 * TtlCache drops a rejection by default, which is right for a blip and
 * exactly wrong for an outage: with Postgres away every sidebar entry rejects
 * on every request, each after waiting out the pool's connection timeout, and
 * nothing remembered that the last request had just found the same thing. The
 * page still renders its widgets blank — the callers' fallbacks are untouched
 * — but the cost of the outage is paid once every few seconds rather than
 * once per entry per page view.
 *
 * It lives here rather than in the middleware that first needed it because
 * the model-side entries need it just as much: getDevelopers, getPublishers,
 * getYears, Game.findFeatured and Comment.findMostDiscussed all call
 * sidebarCache.get() themselves, and every one of them omitted this — so
 * during an outage they each fired a doomed query per request while the six
 * entries the middleware loads had already stopped.
 */
export const FAILURE_TTL_MS = 3 * 1000;

/**
 * The entries holding the catalogue's facet lists: every developer, every
 * publisher and every release year that has a game behind it.
 *
 * All three are a DISTINCT over the whole "games" table — the publisher one a
 * UNION of two of them — with no index that can serve the scan, and all three
 * were run uncached. routes/sitemap.ts asks for all of them to build the
 * index, routes/lists.ts and the developer, publisher and year pages ask for
 * whichever they need, and views/footer.ejs is on every page on the site. They
 * change only when a game is saved, which is why clearGameCaches drops them.
 */
export const DEVELOPERS_KEY = "gameDevelopers";
export const PUBLISHERS_KEY = "gamePublishers";
export const YEARS_KEY = "gameYears";

/**
 * An hour, like the genre list in middlewares/sidebar-data.ts, which is the
 * same kind of thing: a slowly-changing description of the catalogue rather
 * than a listing of it. Nothing has to wait out the hour after a save — the
 * game writes delete all three by hand — so this only bounds how long a
 * machine that missed the epoch bump can be behind.
 */
export const CATALOGUE_FACETS_TTL_MS = 60 * 60 * 1000;
