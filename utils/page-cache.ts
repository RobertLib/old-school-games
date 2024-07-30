import { TtlCache } from "./cache.ts";

/**
 * The caches behind the three documents that are built from the whole
 * catalogue rather than per request: the sitemap, the two RSS feeds and the
 * /most-played page.
 *
 * They live here for the same reason utils/sidebar-cache.ts exists, and the
 * reason is not tidiness. Each of these used to be a module-level TtlCache
 * inside the route that serves it, with a clear function exported beside it —
 * and the models have to call those clear functions, because a game or an
 * article that has just been saved is exactly what makes all three stale. So
 * models/game.ts imported routes/sitemap.ts, routes/feed.ts and
 * routes/lists.ts, and models/news.ts imported the first two.
 *
 * That closed seven import cycles, models -> routes -> models, including
 *
 *   models/game.ts -> routes/sitemap.ts -> routes/lists.ts -> models/game.ts
 *
 * They ran only by luck. ESM resolves a cycle by handing the second importer
 * a module whose bindings are still in their temporal dead zone, and every
 * one of these edges happened to be read inside a function body at request
 * time rather than while the module was evaluating. One `Game.something()` at
 * the top level of routes/lists.ts — or one `LISTS.filter` in a model — and
 * the process would have failed to boot with "Cannot access 'Game' before
 * initialization", from a file that looks nothing like the one that broke.
 *
 * With the caches here, the arrows point one way: routes and models both
 * depend on utils, and neither depends on the other.
 *
 * The keys are exported alongside the caches for the same reason
 * sidebar-cache.ts exports its own: a route that filled an entry under one
 * literal while a model deleted another was how the "Recently added" widget
 * came to be missed. Nothing here should name these strings twice.
 */

/** The sitemap index and every chunk, built and held as one entry. */
export const sitemapCache = new TtlCache();
export const SITEMAP_KEY = "sitemap";

/**
 * The two RSS feeds. One cache, two entries — "games" and "news" — because a
 * game write and an article write invalidate different ones, and clearing the
 * cache outright is cheap enough that clearFeedCache below does not bother
 * telling them apart.
 */
export const feedCache = new TtlCache();

/** The /most-played page, which aggregates the whole "plays" table. */
export const mostPlayedCache = new TtlCache();
export const MOST_PLAYED_KEY = "most-played";

/**
 * Drops the cached sitemap, so a game or article that has just been added,
 * renamed or removed is not missing from it — or still named in it — for the
 * day the entry would otherwise be held.
 */
export function clearSitemapCache(): void {
  sitemapCache.delete(SITEMAP_KEY);
}

/**
 * Drops both feeds.
 *
 * clear() rather than deleting one key: the game feed and the news feed are
 * two entries in one cache, the callers know which of them they invalidated,
 * and rebuilding the other costs one query on the next request that asks for
 * it. Telling them apart would be a distinction nothing benefits from.
 */
export function clearFeedCache(): void {
  feedCache.clear();
}

/**
 * Drops the cached /most-played page.
 *
 * A deleted game used to stay on it for up to five minutes, with its link
 * answering 404 — the same gap the sidebar's own "Most played" widget had.
 */
export function clearMostPlayedCache(): void {
  mostPlayedCache.delete(MOST_PLAYED_KEY);
}
