import session, { type SessionData } from "express-session";
import connectPg from "connect-pg-simple";
import type { Request } from "express";
import type { Pool } from "pg";
import logger from "./logger.ts";

const PGStore = connectPg(session);

/**
 * connect-pg-simple's own fallback for a session with no expiry, in seconds.
 * Unreachable here — app.ts gives every session cookie a maxAge — but the rule
 * below is its rule, so it is restated whole.
 */
const ONE_DAY_SECONDS = 86_400;

/**
 * When a session's row should expire, in seconds since the epoch.
 *
 * The rule connect-pg-simple applies in its own set() and touch(), written out
 * again because the library keeps it in a private method this class cannot
 * call. The two have to agree: a save that computed a different expiry from a
 * touch would move the row's lifetime back and forth between requests.
 */
function expireSeconds(data: SessionData): number {
  const expires = data.cookie?.expires;

  return expires
    ? Math.ceil(new Date(expires).getTime() / 1000)
    : Math.ceil(Date.now() / 1000 + ONE_DAY_SECONDS);
}

export interface PostgresSessionStoreOptions {
  pool: Pool;
  errorLog?: (...args: unknown[]) => void;
}

/**
 * connect-pg-simple, except that saving a session can never bring back a row
 * that has been deleted.
 *
 * The library's set() is an upsert — `INSERT … ON CONFLICT (sid) DO UPDATE` —
 * and express-session calls it at the end of every request that modified its
 * session, with the session it loaded when the request began. Deleting the row
 * is how this app ends a session: the logout (routes/auth.ts) and the password
 * reset (User.upsertAdmin, run by create-admin.ts) both do exactly that. So a
 * request of the same session that was already in flight wrote the row back on
 * its way out, and the session carried on as if nothing had happened. Every
 * admin POST writes a flash, which is a modification, so on the admin surface
 * that was every request; and isAdmin re-reads only the role, by user id, so
 * the row that came back was a full admin session. Measured before this
 * existed: a loop of admin POSTs on a stolen session survived the reset meant
 * to end it in half the trials with one loop and nine in ten with three, and a
 * logout with two requests in flight had its row back nine times in ten.
 *
 * The distinction that closes it is whether the session being saved has ever
 * had a row:
 *
 * - One that has — read out of the store, or saved once already — is only
 *   ever UPDATEd. If its row has gone, the update matches nothing and the
 *   session stays ended; the request that carried it finishes normally, its
 *   changes going nowhere, which is the right outcome for a request of a
 *   session that no longer exists.
 * - One that has not is the session regenerate() creates at login, and only
 *   that one keeps the library's upsert. Its id was minted a moment ago, so
 *   there is no deleted row it could be resurrecting.
 *
 * touch() — what express-session calls instead of set() for a session it did
 * not modify, to slide the expiry — was already an UPDATE, so it is left alone.
 *
 * Which sessions have a row is known from the objects themselves rather than
 * from anything written into the row: express-session builds every session it
 * reads through createSession() below, and hands that same object to set().
 * A marker stored in the JSON would have needed rows written before this
 * class existed to be treated as new — and those are exactly the rows a
 * deploy of this finds already in the table, every one of them still
 * resurrectable. Tracked this way they are covered from the first request.
 *
 * If a future express-session stopped building sessions through
 * createSession, a session read from the store would look new here and take
 * the upsert — that is, behave as the library always has. Nothing would break
 * loudly, which is why tests/session-revocation.test.ts holds the races
 * themselves rather than trusting this paragraph.
 */
export class PostgresSessionStore extends PGStore {
  /** The pool connect-pg-simple was handed, for the one query it cannot run. */
  #pool: Pool;

  /**
   * The session objects that stand for a row which exists or has existed.
   *
   * Weak, and keyed on the object rather than on the id, so an entry lives
   * exactly as long as the request holding the session: every request builds
   * its own object, and nothing here has to be cleared.
   */
  #persisted = new WeakSet<object>();

  constructor(options: PostgresSessionStoreOptions) {
    super(options);
    this.#pool = options.pool;
  }

  /**
   * Every session express-session reads out of the store is built here —
   * when a request arrives with a cookie, and on req.session.reload() — so
   * this is where one is known to have a row.
   */
  override createSession(
    req: Request,
    data: SessionData,
  ): session.Session & SessionData {
    const loaded = super.createSession(req, data);

    this.#persisted.add(loaded);

    return loaded;
  }

  override set(
    sid: string,
    data: SessionData,
    callback?: (error?: unknown) => void,
  ): void {
    if (!this.#persisted.has(data)) {
      // A new session. Marked once its row is written, not before: the login
      // saves the session itself and express-session saves it again on the
      // way out, and the second save has to be an update like any other — or
      // a reset landing between the two would be undone by it.
      super.set(sid, data, (error?: unknown) => {
        if (!error) this.#persisted.add(data);

        callback?.(error);
      });

      return;
    }

    this.#pool
      .query(
        'UPDATE "session" SET "sess" = $1, "expire" = to_timestamp($2) WHERE "sid" = $3',
        [data, expireSeconds(data), sid],
      )
      .then(
        (result) => {
          // Said, because on the admin surface it is the trace of a reset or
          // a logout landing on a session that was being used at that very
          // moment. Info rather than a warning: the session was ended on
          // purpose, and this is that ending holding.
          if (result.rowCount === 0) {
            logger.info(
              "Session not saved: it was ended while this request was in flight",
            );
          }

          // Called back outside the promise, as connect-pg-simple does, so a
          // throw inside express-session's callback is not turned into a
          // rejection of this chain.
          if (callback) process.nextTick(callback);
        },
        (error: unknown) => {
          if (callback) process.nextTick(callback, error);
        },
      );
  }
}
