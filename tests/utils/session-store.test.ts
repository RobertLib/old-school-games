import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import session, { type SessionData } from "express-session";
import type { Pool } from "pg";
import pool from "../../db.ts";
import logger from "../../utils/logger.ts";
import { PostgresSessionStore } from "../../utils/session-store.ts";

/**
 * The store on its own, against the real "session" table, driven the way
 * express-session drives it: a session read out of the store is built through
 * createSession, a new one is a Session made on the spot, and both are saved
 * by handing the object itself to set().
 *
 * tests/session-revocation.test.ts holds the races this exists for through
 * the whole app; these pin the rules underneath them one at a time.
 */

const store = new PostgresSessionStore({ pool, errorLog: () => {} });

afterAll(() => {
  // Stops connect-pg-simple's prune timer; the pool is the suite's own.
  store.close();
});

type StoredSession = session.Session & SessionData & { note?: string };

/**
 * A session cookie as express-session builds one. Its constructor takes the
 * cookie options at runtime; the types declare none.
 */
function cookieLasting(maxAge: number): session.Cookie {
  const Cookie = session.Cookie as unknown as new (options: {
    maxAge: number;
  }) => session.Cookie;

  return new Cookie({ maxAge });
}

/** What express-session passes as `req` when it builds a session. */
function requestFor(sid: string) {
  return { sessionID: sid, sessionStore: store } as never;
}

/**
 * A session with no row yet, built the way express-session's generate() does
 * — the Session constructor is private in the types, not at runtime.
 */
function newSession(sid: string, note: string): StoredSession {
  const Session = session.Session as unknown as new (
    req: unknown,
    data?: object,
  ) => StoredSession;
  const fresh = new Session(requestFor(sid));

  fresh.cookie = cookieLasting(60 * 60 * 1000);
  fresh.note = note;

  return fresh;
}

/** The session with this id as a request would find it: read, then built. */
function load(sid: string): Promise<StoredSession> {
  return new Promise((resolve, reject) => {
    store.load(sid, (error, loaded) => {
      if (error) return reject(error);
      if (!loaded) return reject(new Error(`no session ${sid}`));

      resolve(loaded as StoredSession);
    });
  });
}

function save(target: StoredSession): Promise<void> {
  return new Promise((resolve, reject) => {
    target.save((error?: unknown) => (error ? reject(error) : resolve()));
  });
}

async function row(sid: string): Promise<{ sess: { note?: string }; expire: Date } | null> {
  const { rows } = await pool.query(
    'SELECT "sess", "expire" FROM "session" WHERE "sid" = $1',
    [sid],
  );

  return rows[0] ?? null;
}

async function deleteRow(sid: string): Promise<void> {
  await pool.query('DELETE FROM "session" WHERE "sid" = $1', [sid]);
}

describe("PostgresSessionStore", () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE "session"');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the row of a new session", async () => {
    await save(newSession("fresh", "first"));

    expect((await row("fresh"))?.sess.note).toBe("first");
  });

  it("updates the row of a session it read", async () => {
    await save(newSession("existing", "first"));

    const loaded = await load("existing");

    loaded.note = "second";
    await save(loaded);

    expect((await row("existing"))?.sess.note).toBe("second");
  });

  /**
   * The bug itself, reduced to the store: the session was read while its row
   * existed, the row was deleted — a logout, a password reset — and the save
   * the request makes on its way out came afterwards. The library's upsert
   * put the row back.
   */
  it("does not re-create the row of a session it read once that row is gone", async () => {
    const info = vi.spyOn(logger, "info");

    await save(newSession("ended", "first"));

    const inFlight = await load("ended");

    await deleteRow("ended");

    inFlight.note = "written on the way out";
    await save(inFlight);

    expect(await row("ended")).toBeNull();
    // And says so, because on the admin surface it is the trace of a reset
    // landing on a session in use.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("ended while this request was in flight"),
    );
  });

  /**
   * The login's session is saved twice — by the route before it redirects,
   * and by express-session on the way out — and the second save must be an
   * update like any other, or a reset landing between the two would be
   * undone by it.
   */
  it("does not re-create the row of a new session that has been saved once", async () => {
    const login = newSession("login", "first");

    await save(login);
    await deleteRow("login");

    login.note = "second save";
    await save(login);

    expect(await row("login")).toBeNull();
  });

  // What express-session calls instead of set() for a session it did not
  // modify. It was an UPDATE already; asserted so that stays true.
  it("does not re-create a deleted row by touching it", async () => {
    await save(newSession("touched", "first"));

    const inFlight = await load("touched");

    await deleteRow("touched");

    await new Promise<void>((resolve, reject) => {
      store.touch("touched", inFlight, ((error?: unknown) =>
        error ? reject(error) : resolve()) as () => void);
    });

    expect(await row("touched")).toBeNull();
  });

  /**
   * The update computes the row's expiry itself, because connect-pg-simple
   * keeps its rule in a private method. The two have to agree, or every save
   * would move the row's lifetime away from what a touch sets it to.
   */
  it("sets the same expiry on an update as the library sets on an insert", async () => {
    const fresh = newSession("expiry", "first");

    await save(fresh);

    const inserted = (await row("expiry"))!.expire;

    const loaded = await load("expiry");

    loaded.note = "second";
    await save(loaded);

    const updated = (await row("expiry"))!.expire;

    expect(updated.getTime()).toBe(inserted.getTime());
    expect(Math.abs(updated.getTime() - fresh.cookie.expires!.getTime())).toBeLessThan(
      1000,
    );
  });

  it("hands a failed update to the caller", async () => {
    const failing = new PostgresSessionStore({
      pool: {
        query: () => Promise.reject(new Error("connection terminated")),
      } as unknown as Pool,
      errorLog: () => {},
    });

    try {
      const loaded = failing.createSession(
        { sessionID: "any", sessionStore: failing } as never,
        { cookie: cookieLasting(1000) },
      );

      const error = await new Promise<unknown>((resolve) => {
        failing.set("any", loaded, resolve);
      });

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("connection terminated");
    } finally {
      failing.close();
    }
  });
});
