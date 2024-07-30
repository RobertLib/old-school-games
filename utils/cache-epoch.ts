import { type NextFunction, type Request, type Response } from "express";
import db from "../db.ts";
import logger from "./logger.ts";
import { clearAllCaches } from "./cache.ts";
import {
  LATEST_COMMENTS_KEY,
  MOST_DISCUSSED_KEY,
  sidebarCache,
} from "./sidebar-cache.ts";

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
 * The mechanism is a counter per scope in the database — "cache_epochs", from
 * 0033 and 0039. A write bumps the scope it invalidated. Every process reads
 * them all at most once every EPOCH_CHECK_INTERVAL_MS, on the first request
 * that arrives after the interval, and applies the effect of every scope whose
 * number has moved since it last looked.
 *
 * LISTEN/NOTIFY would be quicker, and it would still not replace this. A
 * notification reaches only the sessions listening at the moment it is sent:
 * a machine whose listening connection had dropped — a Supabase restart, a
 * network blip, the gap while it reconnects — misses that write for good and
 * has no way to find out, where a counter can be compared whenever the
 * connection is back. So the counter is the part correctness needs, and
 * LISTEN could only ever be a latency shortcut on top of it, paid for with a
 * connection per machine held open outside the pool for the life of the
 * process. Ten seconds is not a latency this site needs to beat. (This
 * comment used to add that it "does not work through a transaction-mode
 * pooler, which is what the Supabase URL in .env.example points at". It does
 * not point at one any more: .env.example, the README and db.ts all require a
 * direct or session-mode connection, for reasons of their own.)
 *
 * Scopes exist because a single counter made the cheapest write the most
 * expensive invalidation on the site. A posted comment deletes one sidebar
 * entry locally and used to make every other machine drop *everything* — the
 * sitemap held for a day included — so the busiest write on the site threw
 * away the most expensive cache in it, several times an hour. The invariant is
 * that a remote machine drops exactly what the writing machine dropped
 * locally, which means the effect below has to be kept in step with what the
 * caller deletes by hand: see clearGameCaches in models/game.ts and the
 * deletes in models/comment.ts.
 *
 * Failures are logged, like every other cache failure here, and never allowed
 * to take a page down: a database that cannot answer this must not be what
 * breaks the site, and the TTLs still bound how stale anything can get. A
 * failed read is not allowed to hold a request up — see cacheEpochSync — nor
 * to count as a check, see FAILURE_BACKOFF_MS. A failed *bump* is not simply
 * dropped any more: see BUMP_RETRY_DELAYS_MS.
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
 *
 * A second from when the failure *arrived*, not from when the attempt began.
 * It used to be measured from the start, and the failure an outage actually
 * produces is a slow one: the pool waits two seconds for a connection it
 * cannot hand out (db.ts), so the backoff had always expired by the time it
 * was set. The next request started a fresh attempt at once, there was always
 * one in flight, and every request that met it waited — measured against a
 * black-holed database, 76 of 80 requests held for about a second each, and
 * 67 of 70 with the pool exhausted. The backoff tests only ever used
 * failures that arrived instantly, which is the one case where the two
 * clocks agree.
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

/**
 * How long after a failed bump it is tried again, attempt by attempt.
 *
 * The models call bumpCacheEpoch with `void`, after a write that has already
 * committed, and a failure used to be logged and dropped. Nothing ever
 * repeated it — unlike a failed read, which the next interval repeats anyway —
 * so every other machine went on serving what that write had deleted for as
 * long as its own caches lasted: a deleted game in the sitemap for up to a
 * day, and in the game-of-the-week widget for an hour.
 *
 * The write before it succeeded a moment ago, so the database was there, and
 * a bump that fails straight afterwards is nearly always a moment's trouble —
 * the pool full (db.ts waits two seconds for a connection), a connection
 * dropped. A retry a second later usually lands. Doubling from there, and
 * bounded: six retries over about a minute, after which the database is
 * having an outage no retry helps with, and the TTLs are the bound again, as
 * they always were.
 *
 * On unref'd timers, so a retry that is waiting never keeps a process alive
 * by itself — least of all one that is draining. And never against a pool
 * that has been told to end (see runRetry), which is why index.ts needs no
 * hook to stop these the way it stops the prune timers: a retry that comes
 * due during a drain but before pool.end() still has a pool to deliver the
 * bump through, and delivering it is the one useful thing left to do with it.
 */
export const BUMP_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
] as const;

/**
 * What a write says it invalidated, and what a machine that hears about it
 * has to drop in answer.
 *
 * "all" is the broad scope the game and news writes use: those drop the
 * sitemap, both feeds, the rankings, the featured pool, the catalogue facet
 * lists and five sidebar widgets, which is near enough everything that
 * clearing the lot is the honest description of it.
 *
 * "comments" is the narrow one, and the reason scopes exist at all: a posted
 * or deleted comment deletes the "Latest comments" widget and the "Most
 * discussed" panel and nothing else, so that is all a remote machine should
 * drop for it. The two have to be kept in step with what models/comment.ts
 * deletes by hand — the invariant is that a remote machine drops exactly what
 * the writing machine dropped locally, and the panel was added to both sides
 * at once for that reason.
 *
 * A scope added here must have a row in "cache_epochs", seeded by a migration
 * — see 0039 and 0044. bumpCacheEpoch inserts one on conflict, but that only
 * repairs the scope from its *second* bump onwards: the row is created at the
 * column default and a scope another machine has never seen is adopted rather
 * than treated as moved, so the write that created the row invalidates
 * nothing anywhere. The seed is what closes that gap.
 */
const SCOPE_EFFECTS = {
  all: clearAllCaches,
  comments: () => {
    sidebarCache.delete(LATEST_COMMENTS_KEY);
    sidebarCache.delete(MOST_DISCUSSED_KEY);
  },
} satisfies Record<string, () => void>;

export type CacheScope = keyof typeof SCOPE_EFFECTS;

const SCOPES = Object.keys(SCOPE_EFFECTS) as CacheScope[];

/**
 * The counters this process has seen, never going backwards.
 *
 * A bump and a concurrent read are two statements on two connections, and
 * nothing orders them: a SELECT issued before the UPDATE can resolve after
 * it, so the reader would adopt the *older* number on top of the one the
 * bump had just recorded. The next check then saw the counter "move" again
 * and threw away caches that were already current — once per interval, on
 * the very machine that had just rebuilt them. Only ever going up makes the
 * two orders equivalent; a counter that genuinely went backwards would mean
 * the row had been recreated, which nothing here does.
 *
 * A scope this process has never read is absent rather than zero, so the
 * first read of it adopts whatever it finds instead of reporting a move.
 */
const lastSeen = new Map<CacheScope, number>();
// Negative infinity rather than 0, so the very first check happens whatever
// the clock reads — the suite sets it to small numbers.
let lastChecked = Number.NEGATIVE_INFINITY;
let inflight: Promise<void> | null = null;

/**
 * Whether a request should wait for a check at all right now — see
 * cacheEpochSync. False from the moment a check fails, or has outlived the
 * time a request gives it, until one succeeds.
 */
let checksAnswering = true;

/**
 * The failed bumps waiting to be tried again: one per scope, never more.
 *
 * One per scope because a single bump that lands after a write is enough for
 * every other machine to drop what that write dropped — they compare the
 * numbers, they do not count them — so three failed bumps of "all" need one
 * retry, not three.
 *
 * `timer` is set while the retry waits and unset while its query is in
 * flight, and that difference is the whole coalescing rule. A bump that fails
 * while the retry is *waiting* is covered by it: the retry's UPDATE will be
 * issued after that write committed. One that fails while the retry's query
 * is already *in flight* is not — that UPDATE may have committed before this
 * write did, and a machine syncing in between would rebuild from the old data
 * and then see no further move — so it sets `again`, and the retry goes round
 * once more whatever its own outcome.
 */
interface PendingBump {
  attempt: number;
  timer: NodeJS.Timeout | undefined;
  again: boolean;
}

const pendingBumps = new Map<CacheScope, PendingBump>();

function adopt(scope: CacheScope, epoch: number): void {
  const seen = lastSeen.get(scope);

  lastSeen.set(scope, seen === undefined ? epoch : Math.max(seen, epoch));
}

/**
 * How one attempt at a bump went: it landed, it failed in a way another
 * attempt might not, or it failed in a way every attempt would.
 */
type BumpAttempt = "landed" | "failed" | "broken";

/** Programming errors: the same code failing the same way on every attempt. */
const BROKEN = [TypeError, ReferenceError, SyntaxError, RangeError];

/** One attempt at a bump. Never rejects. */
async function tryBump(scope: CacheScope): Promise<BumpAttempt> {
  try {
    // An upsert rather than the plain UPDATE this used to be, because the
    // UPDATE failed silently: "cache_epochs" is seeded by migration (0039 and
    // 0044), and a scope whose row is missing — a migration not yet applied, a
    // row deleted by hand, a scope added in code before its seed — matched
    // nothing, returned nothing and was reported by `rowCount` nobody read.
    // Cross-machine invalidation for that scope then did not happen at all,
    // for the life of the deploy, with no line anywhere saying so. Inserting
    // on conflict makes the *second* bump work; the seed is still what makes
    // the first one work. See below.
    //
    // "cache_epochs"."epoch" + 1 and not "epoch" + 1: inside DO UPDATE, an
    // unqualified column name is ambiguous between the existing row and the
    // one that was proposed. The proposed row's "epoch" is the column
    // default, so the unqualified form would reset the counter rather than
    // advance it — and a counter going backwards is precisely what `adopt`
    // and lastSeen exist to make impossible.
    //
    // A fresh row starts at the column default (1) rather than at 2, and the
    // bump that created it therefore invalidates nothing on any other machine.
    // syncCacheEpoch only counts a scope as moved when it already has a value
    // for it and the new one is greater ("seen !== undefined && epoch > seen")
    // — a scope read for the first time must be adopted, not treated as an
    // invalidation, or every machine would clear its caches on boot. So the
    // other machines meet this row at 1, adopt it, and apply no effect: the
    // write that created it is lost everywhere but here. The upsert is a
    // repair for the writes after it, not for the write making it, which is
    // why every scope in SCOPE_EFFECTS still needs a seed row from a
    // migration — 0044 is that seed restated.
    const { rows } = await db.query(
      `INSERT INTO "cache_epochs" ("scope")
       VALUES ($1)
       ON CONFLICT ("scope") DO UPDATE
         SET "epoch" = "cache_epochs"."epoch" + 1, "bumpedAt" = NOW()
       RETURNING "epoch"`,
      [scope],
    );

    // Monotonic, like the adoption in syncCacheEpoch and for the same
    // reason: a read that started before this UPDATE can land after it, and
    // it carries the older number.
    //
    // But not blind. The number that comes back is this bump *plus every
    // bump another machine made since this one last looked* — and adopting
    // it used to be taken as "nothing to catch up on", so the next sync saw
    // no movement and never applied the others' effect. Machine C deletes a
    // game (1 → 2); within A's sync interval an admin posts news on A, whose
    // write drops only the sitemap and the feeds locally and bumps to 3; A
    // adopts 3, and the deleted game stays in A's sidebars, carousel and
    // most-played list for the rest of their TTLs — up to an hour — linking
    // to a 404. Reproduced against the real module and database. A gap of
    // more than one means somebody else moved it, so their effect is applied
    // here before the number is taken; the same holds when a sync read is
    // still in flight, since it will land on a value this has already passed.
    if (rows[0]) {
      const epoch = Number(rows[0].epoch);
      const seen = lastSeen.get(scope);

      if (seen !== undefined && epoch > seen + 1) {
        logger.info(
          `Cache epoch for ${scope} had moved elsewhere as well; dropping what those writes dropped.`,
        );
        SCOPE_EFFECTS[scope]();
      }

      adopt(scope, epoch);
      return "landed";
    }

    // Unreachable: an upsert either inserts or updates, so it always has a
    // row to return. Said out loud anyway, because the failure it would stand
    // for is the one this whole module exists to prevent — every other
    // machine going on serving a deleted game — and the previous shape of
    // this query failed in exactly that way without a word. Not retried: the
    // statement ran, and running it again would answer the same.
    logger.error(
      `Bumping the "${scope}" cache epoch returned no row; other machines will not drop what this write dropped.`,
    );
    return "broken";
  } catch (error) {
    logger.error("Could not bump the cache epoch:", error);

    // Worth another attempt only if another attempt could go differently. A
    // database that did not answer may answer next time; a TypeError is this
    // code failing, identically every time, and six more of it over a minute
    // would be six more copies of the same line. It is also exactly what a
    // suite that mocks the pool produces when no answer is queued for the
    // bump — thirteen times across tests/models/ when this was written — and
    // a retry there fires a second later into whichever test is running by
    // then, taking the answer that test queued for itself.
    return BROKEN.some((kind) => error instanceof kind) ? "broken" : "failed";
  }
}

/**
 * Advances one scope's counter so every other process applies that scope's
 * effect on its next check. The process that bumps adopts the new value at
 * once, so it does not throw away the caches it has just rebuilt when it next
 * looks.
 *
 * Resolves after the first attempt, as it always did; a failed one is tried
 * again in the background — see BUMP_RETRY_DELAYS_MS.
 */
export async function bumpCacheEpoch(
  scope: CacheScope = "all",
): Promise<void> {
  if ((await tryBump(scope)) !== "failed") return;

  const pending = pendingBumps.get(scope);

  if (pending === undefined) {
    scheduleRetry(scope, { attempt: 0, timer: undefined, again: false });
  } else if (pending.timer === undefined) {
    // In flight: see PendingBump for why that one cannot cover this write.
    pending.again = true;
  }
  // ...and a retry that is still waiting covers it as it stands.
}

function scheduleRetry(scope: CacheScope, pending: PendingBump): void {
  pending.timer = setTimeout(
    () => void runRetry(scope, pending),
    BUMP_RETRY_DELAYS_MS[pending.attempt],
  );
  pending.timer.unref();

  pendingBumps.set(scope, pending);
}

async function runRetry(scope: CacheScope, pending: PendingBump): Promise<void> {
  pending.timer = undefined;

  // The pool has been told to end: the process is draining. A query now
  // would fail with "Cannot use a pool after calling end on the pool" and be
  // logged as one more failure on the way out of a clean deploy, so the bump
  // is given up instead — and said to be, because what it loses is real.
  if (db.ending) {
    pendingBumps.delete(scope);
    logger.error(
      `Shutting down with the "${scope}" cache epoch still unbumped; other machines will keep what that write dropped until their own caches expire.`,
    );
    return;
  }

  const attempt = await tryBump(scope);

  // Reset for the suite while the query was out.
  if (pendingBumps.get(scope) !== pending) return;

  // Already logged by tryBump, and no later attempt would go differently.
  if (attempt === "broken") {
    pendingBumps.delete(scope);
    return;
  }

  if (attempt === "landed" && !pending.again) {
    pendingBumps.delete(scope);
    logger.info(
      `Bumped the "${scope}" cache epoch on retry ${pending.attempt + 1}.`,
    );
    return;
  }

  if (attempt === "landed") {
    // A write failed its own bump while this one was out; it gets a round
    // of its own, with the whole schedule ahead of it.
    pending.attempt = 0;
    pending.again = false;
    scheduleRetry(scope, pending);
    return;
  }

  pending.again = false;
  pending.attempt += 1;

  if (pending.attempt >= BUMP_RETRY_DELAYS_MS.length) {
    pendingBumps.delete(scope);
    logger.error(
      `Gave up bumping the "${scope}" cache epoch after ${pending.attempt + 1} attempts; other machines will keep what that write dropped until their own caches expire.`,
    );
    return;
  }

  scheduleRetry(scope, pending);
}

/**
 * Reads the counters if they have not been read for the last interval, and
 * applies the effect of every scope that has moved. Concurrent callers share
 * one query; a caller inside the interval returns at once.
 *
 * Still one query for every scope, not one per scope: the whole table is one
 * short row per scope — two today, "all" and "comments" — and the cost this
 * middleware is allowed to add per process per interval is one round trip.
 */
export function syncCacheEpoch(): Promise<void> {
  if (inflight) return inflight;

  const startedAt = Date.now();

  if (startedAt - lastChecked < EPOCH_CHECK_INTERVAL_MS) {
    return Promise.resolve();
  }

  inflight = (async () => {
    try {
      const { rows } = await db.query(
        'SELECT "scope", "epoch" FROM "cache_epochs"',
      );

      // Recorded here rather than before the query, so only a read that
      // actually happened opens a fresh interval. Marking the attempt up
      // front meant a database that was down for a minute was asked six
      // times about it and, worse, that a database back up a moment later
      // went unnoticed for the rest of the window.
      lastChecked = startedAt;
      checksAnswering = true;

      const moved: CacheScope[] = [];

      for (const row of rows) {
        const scope = String(row.scope) as CacheScope;

        // A scope this build does not know about is another version of the
        // app writing to the same database — mid-deploy, which is exactly
        // when two machines disagree. Nothing here can apply an effect it has
        // no code for, and pretending to have seen it would mean the effect
        // is never applied once this build does learn it, so it is skipped.
        if (!SCOPES.includes(scope)) continue;

        const epoch = Number(row.epoch);
        const seen = lastSeen.get(scope);

        // Greater, not merely different: see adopt. A number below the one
        // this process holds is a read that overtook its own bump, and
        // clearing on it would drop caches nothing has invalidated.
        if (seen !== undefined && epoch > seen) moved.push(scope);

        adopt(scope, epoch);
      }

      if (moved.length > 0) {
        logger.info(
          `Cache epoch moved for ${moved.join(", ")}; dropping what those writes dropped.`,
        );

        // "all" subsumes every narrower scope, so a check that saw both move
        // runs one clear rather than a clear and then a redundant delete.
        if (moved.includes("all")) SCOPE_EFFECTS.all();
        else for (const scope of moved) SCOPE_EFFECTS[scope]();
      }
    } catch (error) {
      // A short backoff instead of a whole interval — enough to keep a busy
      // moment from firing one doomed query per request, not enough to keep
      // ignoring a database that has come back. Counted from now, when the
      // failure arrived, and not from startedAt: see FAILURE_BACKOFF_MS.
      lastChecked = Date.now() - EPOCH_CHECK_INTERVAL_MS + FAILURE_BACKOFF_MS;
      checksAnswering = false;

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
 *
 * And not at all while checks are failing. The race bounds one request's
 * wait; it did nothing about how many requests waited. A check in flight is
 * shared by every request that arrives while it is out, so during an outage —
 * a new attempt every second, each taking the pool's two seconds to fail —
 * nearly every request on the site waited out a check that was always going
 * to fail. So once a check has failed, or has outlived the time a request
 * gives it, requests start the next one (or join it) and go straight on,
 * until one succeeds. The first request into an outage still waits its
 * SYNC_TIMEOUT_MS; nothing after it does.
 */
export async function cacheEpochSync(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!checksAnswering) {
    void syncCacheEpoch();
    next();
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const check = syncCacheEpoch();

  await Promise.race([
    check,
    new Promise<void>((resolve) => {
      // unref'd so a pending check cannot by itself hold the process open
      // while it is draining.
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, SYNC_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);

  clearTimeout(timer);

  // A check still out after a request's whole budget is not answering, for
  // the purposes of the requests behind this one; the check itself resets
  // this the moment it succeeds. Only while that same check is still out: one
  // that finished in the moment between the timer and this line has already
  // said how it went, and a success must not be overwritten here.
  if (timedOut && inflight === check) checksAnswering = false;

  next();
}

/** For the suite: forget what this process has seen, and anything pending. */
export function resetCacheEpochForTests(): void {
  lastSeen.clear();
  lastChecked = Number.NEGATIVE_INFINITY;
  inflight = null;
  checksAnswering = true;

  for (const pending of pendingBumps.values()) clearTimeout(pending.timer);
  pendingBumps.clear();
}
