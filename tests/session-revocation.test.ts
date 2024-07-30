import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../app.ts";
import pool from "../db.ts";
import User from "../models/user.ts";

/**
 * Ending a session has to be final, and deleting its row was not enough.
 *
 * express-session saves a modified session when the response ends, and the
 * store it used to be given saved with an upsert. So a request of the same
 * session that was already in flight when the row went — any admin POST, since
 * every one of them writes a flash — wrote the row straight back on its way
 * out. Both the logout and the password reset in create-admin.ts
 * (User.upsertAdmin) end a session by deleting its row, and both were undone
 * that way: a loop of admin POSTs on a stolen session outlived the reset in
 * half the trials, and a logout with two requests in flight had its row back
 * in nine out of ten.
 *
 * Reproduced here deterministically rather than by racing: the in-flight
 * request's save is held at the store until the row has gone, which is the one
 * interleaving the bug needed. Against the real app and the real store,
 * because the point is what the store does with a save it is handed.
 */

const server = app.listen(0);

afterAll(() => {
  server.close();
});

const email = "revocation-admin@example.com";
const password = "the password the session was opened with";

interface SignedIn {
  /** The Cookie header a browser would send from here on. */
  cookie: string;
  /** A masked CSRF token minted after the login, as the next page carries. */
  token: string;
  /** The session id behind the cookie, as the store keys its row. */
  sid: string;
}

/** Later Set-Cookies win, the way a browser jar treats them. */
function withCookies(jar: Map<string, string>, setCookie: unknown): void {
  for (const header of (setCookie as string[] | undefined) ?? []) {
    const pair = header.split(";")[0]!;
    const separator = pair.indexOf("=");

    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function tokenOn(page: string): string {
  const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
    page,
  )?.[1];

  expect(token, "no CSRF token on the page").toBeDefined();

  return token!;
}

async function signIn(): Promise<SignedIn> {
  const jar = new Map<string, string>();
  const form = await request(server).get("/login");

  withCookies(jar, form.headers["set-cookie"]);

  const login = await request(server)
    .post("/login")
    .set("Cookie", cookieHeader(jar))
    .set("x-csrf-token", tokenOn(form.text))
    .type("form")
    .send({ email, password })
    .redirects(0);

  expect(login.status).toBe(302);

  withCookies(jar, login.headers["set-cookie"]);

  // The login rotates the CSRF secret, so the token that authorised it is
  // dead; a browser reads a fresh one off the next page, and so does this.
  const page = await request(server).get("/").set("Cookie", cookieHeader(jar));

  withCookies(jar, page.headers["set-cookie"]);

  // "s:<sid>.<signature>", URL-encoded.
  const signed = decodeURIComponent(jar.get("connect.sid")!);
  const sid = signed.slice(2, signed.lastIndexOf("."));

  return { cookie: cookieHeader(jar), token: tokenOn(page.text), sid };
}

async function rowExists(sid: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM "session" WHERE "sid" = $1',
    [sid],
  );

  return rows.length === 1;
}

/**
 * Holds the next save of one session at the store until it is released.
 *
 * `reached` settles once express-session has handed the store that save —
 * which it does from its res.end wrapper, after the route has run and with
 * the session it loaded at the start of the request — so everything the test
 * does between the two happens while that request is still in flight.
 */
function holdNextSave(sid: string): {
  reached: Promise<void>;
  release: () => void;
} {
  const store = app.locals.sessionStore;
  const original = store.set;

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  vi.spyOn(store, "set").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    if (args[0] !== sid) return original.apply(this, args);

    arrive();
    void released.then(() => original.apply(this, args));
  });

  return { reached, release };
}

/**
 * An admin request that modifies its session — the flash "Comment not found."
 * — so express-session saves it on the way out rather than only touching the
 * expiry. Every admin POST on the site is one of these.
 */
function adminPost(browser: SignedIn) {
  return request(server)
    .post("/comments/999999/delete")
    .set("Cookie", browser.cookie)
    .set("x-csrf-token", browser.token)
    .redirects(0);
}

/** What the old cookie opens now: the admin form, or the way to /login. */
async function adminFormWith(cookie: string) {
  return request(server).get("/games/new").set("Cookie", cookie).redirects(0);
}

describe("ending a session while one of its requests is in flight", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    await User.upsertAdmin({ email, password });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  it("does not let the in-flight save write back a row the reset deleted", async () => {
    const stolen = await signIn();
    const hold = holdNextSave(stolen.sid);

    const inFlight = adminPost(stolen).then((response) => response);

    await hold.reached;

    // The reset create-admin.ts runs: new password, every session ended.
    await User.upsertAdmin({ email, password: "a brand new long password" });

    expect(await rowExists(stolen.sid)).toBe(false);

    hold.release();

    // The response finishes only once its save has — see writeend in
    // express-session — so by now the store has answered it.
    expect((await inFlight).status).toBe(302);

    expect(await rowExists(stolen.sid)).toBe(false);

    const probe = await adminFormWith(stolen.cookie);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe("/login");
  });

  it("does not let the in-flight save write back a row the logout deleted", async () => {
    const browser = await signIn();
    const hold = holdNextSave(browser.sid);

    const inFlight = adminPost(browser).then((response) => response);

    await hold.reached;

    const logout = await request(server)
      .post("/logout")
      .set("Cookie", browser.cookie)
      .set("x-csrf-token", browser.token)
      .redirects(0);

    expect(logout.status).toBe(302);
    expect(await rowExists(browser.sid)).toBe(false);

    hold.release();

    expect((await inFlight).status).toBe(302);

    expect(await rowExists(browser.sid)).toBe(false);

    const probe = await adminFormWith(browser.cookie);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe("/login");
  });

  /**
   * The other half of the store change, and the half that must not break: a
   * session that is still there is saved as before. The flash above is only
   * shown because the save that carried it reached the row.
   */
  it("still saves a session whose row is there", async () => {
    const browser = await signIn();

    const saved = await adminPost(browser);

    expect(saved.status).toBe(302);

    const next = await request(server)
      .get(saved.headers.location!)
      .set("Cookie", browser.cookie);

    expect(next.text).toContain("Comment not found.");
  });
});

/**
 * Defence in depth behind the store: the session carries the credential it
 * was opened with, and the admin guard compares it with the account's current
 * one on every request.
 *
 * The store fix closes the one way a deleted row was known to come back. This
 * is what still holds if a row returns by some other path — a store that
 * upserts again after a dependency update, a session table restored from a
 * backup, a request that read the session before the reset committed and saves
 * it after — because a reset writes a new hash, and a session opened under the
 * old one no longer matches it.
 */
describe("a session that outlives the password it was opened with", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    await User.upsertAdmin({ email, password });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  async function snapshot(sid: string) {
    const { rows } = await pool.query(
      'SELECT "sess", "expire" FROM "session" WHERE "sid" = $1',
      [sid],
    );

    expect(rows).toHaveLength(1);

    return rows[0] as { sess: unknown; expire: Date };
  }

  async function restore(sid: string, row: { sess: unknown; expire: Date }) {
    await pool.query(
      'INSERT INTO "session" ("sid", "sess", "expire") VALUES ($1, $2, $3)',
      [sid, JSON.stringify(row.sess), row.expire],
    );
  }

  it("is signed out by the admin guard even if its row comes back after a reset", async () => {
    const stolen = await signIn();
    const row = await snapshot(stolen.sid);

    expect((await adminFormWith(stolen.cookie)).status).toBe(200);

    await User.upsertAdmin({ email, password: "a brand new long password" });

    // Put back exactly as it was, by whatever route.
    await restore(stolen.sid, row);

    const probe = await adminFormWith(stolen.cookie);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe("/login");

    // Ended rather than merely refused, so the row does not linger for a week
    // being slid forward by every page view the browser makes.
    expect(await rowExists(stolen.sid)).toBe(false);
  });

  /**
   * A session written before sessions carried a credential — every one in
   * production on the day this shipped. It cannot be told apart from one that
   * outlived a reset, so it is treated as one: its admin is asked to sign in
   * once more.
   */
  it("signs out a session that carries no credential at all", async () => {
    const legacy = await signIn();

    await pool.query(
      `UPDATE "session" SET "sess" = ("sess"::jsonb #- '{user,credential}')::json
        WHERE "sid" = $1`,
      [legacy.sid],
    );

    const probe = await adminFormWith(legacy.cookie);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe("/login");
    expect(await rowExists(legacy.sid)).toBe(false);
  });

  it("lets the session opened with the new password in", async () => {
    await User.upsertAdmin({ email, password: "a brand new long password" });

    const jar = new Map<string, string>();
    const form = await request(server).get("/login");

    withCookies(jar, form.headers["set-cookie"]);

    const login = await request(server)
      .post("/login")
      .set("Cookie", cookieHeader(jar))
      .set("x-csrf-token", tokenOn(form.text))
      .type("form")
      .send({ email, password: "a brand new long password" })
      .redirects(0);

    expect(login.status).toBe(302);

    withCookies(jar, login.headers["set-cookie"]);

    expect((await adminFormWith(cookieHeader(jar))).status).toBe(200);
  });
});

/**
 * The login rotates the CSRF secret, which leaves every tab opened before it
 * holding a page whose token masks the old one. Clicking Logout in such a tab
 * used to answer "Your session has expired — please reload the page and
 * submit again" and leave the week-long session signed in. A logout whose
 * Origin names this site is now let through on that alone (see isOwnLogout in
 * middlewares/csrf.ts).
 *
 * Through the real app, under NODE_ENV=production for the length of each
 * case, because that is the only environment with a canonical origin to hold
 * the header against. Every request carries the Host and the forwarded scheme
 * the production redirects expect, as the proxy in front of the app sends.
 */
describe("logging out from a tab opened before the login", () => {
  const SITE = "https://oldschoolgames.eu";
  const PROXIED = { Host: "oldschoolgames.eu", "X-Forwarded-Proto": "https" };

  let previousEnv: string | undefined;

  beforeEach(async () => {
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    await User.upsertAdmin({ email, password });

    previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  /**
   * A page opened in one tab, then a login in another: returns the browser's
   * cookies after both and the token the first tab's logout form carries.
   */
  async function staleTab(): Promise<{ jar: Map<string, string>; stale: string; sid: string }> {
    const jar = new Map<string, string>();

    const about = await request(server).get("/about").set(PROXIED);

    expect(about.status).toBe(200);
    withCookies(jar, about.headers["set-cookie"]);

    const stale = tokenOn(about.text);

    const form = await request(server)
      .get("/login")
      .set(PROXIED)
      .set("Cookie", cookieHeader(jar));

    withCookies(jar, form.headers["set-cookie"]);

    const login = await request(server)
      .post("/login")
      .set(PROXIED)
      .set("Origin", SITE)
      .set("Cookie", cookieHeader(jar))
      .type("form")
      .send({ _csrf: tokenOn(form.text), email, password })
      .redirects(0);

    expect(login.status).toBe(302);
    withCookies(jar, login.headers["set-cookie"]);

    const signed = decodeURIComponent(jar.get("connect.sid")!);
    const sid = signed.slice(2, signed.lastIndexOf("."));

    const admin = await request(server)
      .get("/games/new")
      .set(PROXIED)
      .set("Cookie", cookieHeader(jar))
      .redirects(0);

    expect(admin.status, "not signed in after the login").toBe(200);

    return { jar, stale, sid };
  }

  function logoutWith(jar: Map<string, string>, token: string) {
    return request(server)
      .post("/logout")
      .set(PROXIED)
      .set("Cookie", cookieHeader(jar))
      .type("form")
      .send({ _csrf: token })
      .redirects(0);
  }

  it("signs out when the stale tab's logout says it came from this site", async () => {
    const { jar, stale, sid } = await staleTab();

    const logout = await logoutWith(jar, stale).set("Origin", SITE);

    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe("/");
    expect(await rowExists(sid)).toBe(false);

    const after = await request(server)
      .get("/games/new")
      .set(PROXIED)
      .set("Cookie", cookieHeader(jar))
      .redirects(0);

    expect(after.status).toBe(302);
    expect(after.headers.location).toBe("/login");
  });

  // No Origin is no proof, so the token is still what decides — and a stale
  // one is refused, exactly as before.
  it("still refuses the stale token when nothing proves where it came from", async () => {
    const { jar, stale, sid } = await staleTab();

    const logout = await logoutWith(jar, stale);

    expect(logout.status).toBe(403);
    expect(await rowExists(sid)).toBe(true);
  });

  // SameSite would keep the session cookie off a real cross-site POST anyway;
  // this is the Origin check refusing one even when the cookie is there.
  it("refuses a logout another site sent", async () => {
    const { jar, stale, sid } = await staleTab();

    const logout = await logoutWith(jar, stale).set("Origin", "https://evil.example");

    expect(logout.status).toBe(403);
    expect(await rowExists(sid)).toBe(true);
  });

  // Every other form from the stale tab is still refused: the logout is the
  // one exception.
  it("still refuses the stale tab's other forms", async () => {
    const { jar, stale } = await staleTab();

    const post = await request(server)
      .post("/comments/999999/delete")
      .set(PROXIED)
      .set("Origin", SITE)
      .set("Cookie", cookieHeader(jar))
      .type("form")
      .send({ _csrf: stale })
      .redirects(0);

    expect(post.status).toBe(403);
    expect(post.text).toContain("reload the page");
  });
});
