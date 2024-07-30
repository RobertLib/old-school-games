import { type NextFunction, type Request, type Response } from "express";
import db from "../db.ts";
import logger from "./logger.ts";
import { clearAllCaches } from "./cache.ts";

/**
 * Cross-machine cache invalidation.
 *
 * Every cache in this app — the sitemap, the feeds, the sidebar widgets, the
 * game-of-the-week pick — is a Map in the memory of one process, and every
 * `clear*` call a write makes only reaches the process that handled the
 * admin's request. That was fine while one machine served the site. Fly
 * starts machines on demand and a deploy leaves more than one behind, so an
 * admin deleting a game on machine A left machine B offering it from the
 * sitemap (24h), the game-of-the-week widget (1h) and the feed (15min), all
 * linking to a 404. Rate limits had the same bug and moved to Postgres in
 * 0028_rate_limits.sql; this is the same fix applied to the caches.
 *
 * The mechanism is a single counter in the database — "cache_epochs", from
 * 0033. A write bumps it. Every process reads it at most once every
 * EPOCH_CHECK_INTERVAL_MS, on the first request that arrives after the
 * interval, and drops every cache it holds when the number has moved since
 * it last looked. LISTEN/NOTIFY would be quicker, but it needs a connection
 * held open outside the pool and does not work through a transaction-mode
 * pooler, which is what the Supabase URL in .env.example points at.
 *
 * Failures are logged and dropped, like every other cache failure here: a
 * database that cannot answer this must not be what takes a page down, and
 * the TTLs still bound how stale anything can get.
 */
export const EPOCH_CHECK_INTERVAL_MS = 10_000;

let lastSeen: number | null = null;
// Negative infinity rather than 0, so the very first check happens whatever
// clock the caller passes — the suite passes small ones.
let lastChecked = Number.NEGATIVE_INFINITY;
let inflight: Promise<void> | null = null;

/**
 * Advances the shared counter so every other process drops its caches on
 * its next check. The process that bumps adopts the new value at once, so it
 * does not throw away the caches it has just rebuilt when it next looks.
 */
export async function bumpCacheEpoch(): Promise<void> {
  try {
    const { rows } = await db.query(
      `UPDATE "cache_epochs"
       SET "epoch" = "epoch" + 1, "bumpedAt" = NOW()
       WHERE "id" = 1
       RETURNING "epoch"`,
    );

    if (rows[0]) lastSeen = Number(rows[0].epoch);
  } catch (error) {
    logger.error("Could not bump the cache epoch:", error);
  }
}

/**
 * Reads the shared counter if it has not been read for the last interval,
 * and clears every in-memory cache when it has moved. Concurrent callers
 * share one query; a caller inside the interval returns at once.
 */
export function syncCacheEpoch(now: number = Date.now()): Promise<void> {
  if (inflight) return inflight;

  if (now - lastChecked < EPOCH_CHECK_INTERVAL_MS) return Promise.resolve();

  lastChecked = now;

  inflight = (async () => {
    try {
      const { rows } = await db.query(
        'SELECT "epoch" FROM "cache_epochs" WHERE "id" = 1',
      );

      if (!rows[0]) return;

      const epoch = Number(rows[0].epoch);

      if (lastSeen !== null && epoch !== lastSeen) {
        logger.info(
          `Cache epoch moved from ${lastSeen} to ${epoch}; dropping every cache.`,
        );
        clearAllCaches();
      }

      lastSeen = epoch;
    } catch (error) {
      logger.error("Could not read the cache epoch:", error);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Express middleware form of syncCacheEpoch. Awaited, so the request that
 * happens to fall on a check boundary is served from fresh caches rather
 * than from the ones the check is about to drop. It costs one tiny query
 * per process per interval; every other request pays nothing.
 */
export async function cacheEpochSync(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await syncCacheEpoch();
  next();
}

/** For the suite: forget what this process has seen. */
export function resetCacheEpochForTests(): void {
  lastSeen = null;
  lastChecked = Number.NEGATIVE_INFINITY;
  inflight = null;
}
