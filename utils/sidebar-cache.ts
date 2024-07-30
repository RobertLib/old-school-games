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
