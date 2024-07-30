import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from "express-rate-limit";
import logger from "./logger.ts";
import db from "../db.ts";

/**
 * A rate-limit store backed by Postgres, so every machine counts against the
 * same budget.
 *
 * express-rate-limit defaults to an in-memory store, which means each machine
 * keeps its own tally. On one machine that is the same thing; the moment the
 * app runs on two, every limit silently doubles — and the limits that matter
 * are the ones guarding login attempts and comment posting, where doubling is
 * a weakened control rather than a tuning detail.
 *
 * Every limiter needs its own instance, because init() hands the store that
 * limiter's window. `prefix` is what keeps their counters apart in the shared
 * table; express-rate-limit also reads it to tell a genuine double-count
 * misconfiguration from two limiters legitimately counting the same address.
 *
 * Failures are not swallowed here: the limiters pass `passOnStoreError`, which
 * is the library's own way of saying "if the store is unreachable, let the
 * request through". A database blip should cost the site its rate limiting,
 * not its availability.
 */
export class PostgresRateLimitStore implements Store {
  /** Keys from one instance are visible to every other process. */
  localKeys = false;

  prefix: string;

  #windowSeconds = 60;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.#windowSeconds = options.windowMs / 1000;
  }

  #key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  /**
   * Counts a hit and returns the running total, in one statement.
   *
   * The CASE arms are what make the window slide: a row whose window has
   * already run out is reset to a single hit rather than continuing to
   * accumulate. Reading the row first and then writing it would let two
   * concurrent requests both see the same total, which is precisely the race
   * a rate limiter cannot afford.
   */
  async increment(key: string): Promise<IncrementResponse> {
    const { rows } = await db.query(
      `INSERT INTO "rate_limits" ("key", "hits", "expiresAt")
       VALUES ($1, 1, NOW() + make_interval(secs => $2::double precision))
       ON CONFLICT ("key") DO UPDATE SET
         "hits" = CASE
           WHEN "rate_limits"."expiresAt" <= NOW() THEN 1
           ELSE "rate_limits"."hits" + 1
         END,
         "expiresAt" = CASE
           WHEN "rate_limits"."expiresAt" <= NOW()
             THEN NOW() + make_interval(secs => $2::double precision)
           ELSE "rate_limits"."expiresAt"
         END
       RETURNING "hits", "expiresAt"`,
      [this.#key(key), this.#windowSeconds],
    );

    return {
      totalHits: Number(rows[0].hits),
      resetTime: new Date(rows[0].expiresAt),
    };
  }

  /**
   * Gives a hit back, for requests the limiter was told not to count — see
   * `skipSuccessfulRequests` on the login limiter in routes/auth.ts.
   *
   * This is the one method here that must not reject, and the reason is in
   * express-rate-limit rather than in anything this app does. Every other
   * call into a store is awaited inside the middleware, where
   * `passOnStoreError` turns a failure into "let the request through". The
   * decrement is not: it is attached to the response's own "finish" event and
   * left unguarded —
   *
   *   void finishPromise.then(async () => { ... await decrementKey() })
   *
   * — with no catch anywhere in the chain. A rejection there is an unhandled
   * one, and node's default for those since v15 is to terminate the process.
   *
   * So a database blip while somebody logged in successfully would not cost
   * the site its rate limiting, as it does everywhere else — it would take the
   * process down, on the one request that had just *worked*. That is the exact
   * failure this app is built not to have: both limiters pass
   * `passOnStoreError`, db.ts logs an idle client error rather than exiting,
   * and every sidebar widget has a fallback.
   *
   * A lost decrement costs one hit out of a fifteen-minute budget, and the
   * window expires on its own regardless.
   */
  async decrement(key: string): Promise<void> {
    try {
      await db.query(
        `UPDATE "rate_limits" SET "hits" = GREATEST("hits" - 1, 0)
         WHERE "key" = $1 AND "expiresAt" > NOW()`,
        [this.#key(key)],
      );
    } catch (error) {
      logger.error("Rate limit decrement failed:", error);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const { rows } = await db.query(
      `SELECT "hits", "expiresAt" FROM "rate_limits"
       WHERE "key" = $1 AND "expiresAt" > NOW()`,
      [this.#key(key)],
    );

    if (!rows[0]) return undefined;

    return {
      totalHits: Number(rows[0].hits),
      resetTime: new Date(rows[0].expiresAt),
    };
  }

  async resetKey(key: string): Promise<void> {
    await db.query('DELETE FROM "rate_limits" WHERE "key" = $1', [
      this.#key(key),
    ]);
  }

  /** Only this limiter's keys, not every limiter sharing the table. */
  async resetAll(): Promise<void> {
    await db.query('DELETE FROM "rate_limits" WHERE "key" LIKE $1', [
      `${this.prefix}:%`,
    ]);
  }
}

/**
 * Bridges express-rate-limit's own logging onto this app's logger.
 *
 * The library takes a `logger` option and falls back to writing on the
 * console when it is not given, which is what every limiter here was doing.
 * That matters for exactly one line, and it is the most important line the
 * library ever emits: when `passOnStoreError` lets a request through because
 * the store refused it, this is the only sign that rate limiting — including
 * the brake on password guessing in routes/auth.ts — is silently off.
 *
 * Unlogged by utils/logger.ts it never reached error.log, and in production
 * it went to stdout in plain text beside the JSON lines everything else
 * writes, so nothing collecting those parsed it. A control that fails open
 * has to say so where the failure is actually read.
 *
 * The arguments are the other way round on each side — the library passes
 * (error, message) and logger.ts takes (message, ...args) — which is the
 * whole reason this is an adapter rather than the logger passed directly.
 */
export const rateLimitLogger = {
  error: (error: unknown, message?: string): void => {
    logger.error(message ?? "express-rate-limit error:", error);
  },
  warn: (error: unknown, message?: string): void => {
    logger.warn(message ?? "express-rate-limit warning:", error);
  },
};

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

let pruneTimer: NodeJS.Timeout | undefined;

/**
 * Clears out windows that have expired.
 *
 * One timer for the whole process, not one per store: every instance writes
 * to the same table, so five limiters would otherwise run five identical
 * deletes against it. Nothing reads an expired row — increment() resets it in
 * place — so this is purely about the table not growing without bound.
 */
export function startRateLimitPruning(): void {
  if (pruneTimer) return;

  const prune = async (): Promise<void> => {
    try {
      await db.query('DELETE FROM "rate_limits" WHERE "expiresAt" <= NOW()');
    } catch (error) {
      // Housekeeping must never take the process down with it.
      logger.error("Rate limit pruning failed:", error);
    }
  };

  pruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
  // unref'd so a pending sweep cannot by itself hold the process open.
  pruneTimer.unref?.();
}

export function stopRateLimitPruning(): void {
  if (!pruneTimer) return;

  clearInterval(pruneTimer);
  pruneTimer = undefined;
}
