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
 * the TTLs still bound how stale anything can get. A failed read is also not
 * allowed to hold a request up — see cacheEpochSync — nor to count as a
 * check, see FAILURE_BACKOFF_MS.
 */
export const EPOCH_CHECK_INTERVAL_MS = 10_000;

/**
 * How long a *failed* read is allowed to stand in for a successful one.
 *
 * The interval above was applied to both outcomes, so one read that failed
 * because the database was away also bought ten seconds of not looking
 * again — and a machine coming back up was ignored for the rest of that
 * window. Retrying at once is the other extreme: every request would fire
 * its own doomed query for as long as the outage lasted. A second is short
 * enough that a recovery is noticed almost immediately and long enough that
 * a burst of traffic still shares one attempt.
 */
export const FAILURE_BACKOFF_MS = 1_000;

/**
 * How long the middleware waits for the read before serving the page anyway.
 *
 * Even a fast failure is not guaranteed: with the database unreachable the
 * query waits for a connection the pool cannot hand out (db.ts gives that
 * two seconds), and every request falling on a check boundary waited with
 * it. The page does not need this to render — the caches it would drop are
 * at worst one interval stale — so the check is raced against a timer and
 * the loser is simply left to finish in the background. The same shape and
 * the same budget as the /healthz probe in app.ts.
 */
export const SYNC_TIMEOUT_MS = 2_000;

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
/**
 * The counter this process has seen, never going backwards.
 *
 * A bump and a concurrent read are two statements on two connections, and
 * nothing orders them: a SELECT issued before the UPDATE can resolve after
 * it, so the reader would adopt the *older* number on top of the one the
 * bump had just recorded. The next check then saw the counter "move" again
 * and threw away caches that were already current — once per interval, on
 * the very machine that had just rebuilt them. Only ever going up makes the
 * two orders equivalent; a counter that genuinely went backwards would mean
 * the row had been recreated, which nothing here does.
 */
function highestSeen(epoch: number): number {
  return lastSeen === null ? epoch : Math.max(lastSeen, epoch);
}

export async function bumpCacheEpoch(): Promise<void> {
  try {
    const { rows } = await db.query(
      `UPDATE "cache_epochs"
       SET "epoch" = "epoch" + 1, "bumpedAt" = NOW()
       WHERE "id" = 1
       RETURNING "epoch"`,
    );

    // Monotonic, like the adoption in syncCacheEpoch and for the same
    // reason: a read that started before this UPDATE can land after it, and
    // it carries the older number.
    if (rows[0]) lastSeen = highestSeen(Number(rows[0].epoch));
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

  inflight = (async () => {
    try {
      const { rows } = await db.query(
        'SELECT "epoch" FROM "cache_epochs" WHERE "id" = 1',
      );

      // Recorded here rather than before the query, so only a read that
      // actually happened opens a fresh interval. Marking the attempt up
      // front meant a database that was down for a minute was asked six
      // times about it and, worse, that a database back up a moment later
      // went unnoticed for the rest of the window.
      lastChecked = now;

      if (!rows[0]) return;

      const epoch = Number(rows[0].epoch);

      // Greater, not merely different: see highestSeen. A number below the
      // one this process holds is a read that overtook its own bump, and
      // clearing on it would drop caches nothing has invalidated.
      if (lastSeen !== null && epoch > lastSeen) {
        logger.info(
          `Cache epoch moved from ${lastSeen} to ${epoch}; dropping every cache.`,
        );
        clearAllCaches();
      }

      lastSeen = highestSeen(epoch);
    } catch (error) {
      // A short backoff instead of a whole interval — enough to keep a busy
      // moment from firing one doomed query per request, not enough to keep
      // ignoring a database that has come back.
      lastChecked = now - EPOCH_CHECK_INTERVAL_MS + FAILURE_BACKOFF_MS;

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
 *
 * Awaited, but not indefinitely. With Postgres unreachable the query does
 * not fail quickly — it waits for a connection the pool cannot produce —
 * and this middleware sits above every page, so the one request per
 * interval that runs the check was the one request per interval that hung.
 * Racing it against SYNC_TIMEOUT_MS bounds that: the check carries on in
 * the background (syncCacheEpoch never rejects and clears the caches
 * whenever it does finish), and the page is served from what this process
 * holds, which is the same answer the other 999 requests in the interval
 * get anyway.
 */
export async function cacheEpochSync(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  await Promise.race([
    syncCacheEpoch(),
    new Promise<void>((resolve) => {
      // unref'd so a pending check cannot by itself hold the process open
      // while it is draining.
      timer = setTimeout(resolve, SYNC_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);

  clearTimeout(timer);

  next();
}

/** For the suite: forget what this process has seen. */
export function resetCacheEpochForTests(): void {
  lastSeen = null;
  lastChecked = Number.NEGATIVE_INFINITY;
  inflight = null;
}
