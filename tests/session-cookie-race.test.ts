import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request, { type Response } from "supertest";
import app from "../app.ts";
import pool from "../db.ts";
import User from "../models/user.ts";
import type session from "express-session";
import { PostgresSessionStore } from "../utils/session-store.ts";
import { CSRF_COOKIE } from "../middlewares/csrf.ts";

const server = app.listen(0);
const email = "session-cookie-race@example.com";
const password = "a long password for session-cookie races";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function remember(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers["set-cookie"] as unknown as string[] ?? []) {
    const pair = header.split(";")[0]!;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

function cookies(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function csrfToken(response: Response): string {
  const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(response.text)?.[1];
  expect(token).toBeDefined();
  return token!;
}

function sid(jar: Map<string, string>): string {
  const signed = decodeURIComponent(jar.get("connect.sid")!);
  return signed.slice(2, signed.lastIndexOf("."));
}

function sessionCookies(response: Response): string[] {
  return (response.headers["set-cookie"] as unknown as string[] ?? [])
    .filter((cookie) => cookie.startsWith("connect.sid="));
}

async function signIn(jar: Map<string, string>): Promise<Response> {
  const form = await request(server).get("/login").set("Cookie", cookies(jar));
  remember(jar, form);
  const login = await request(server)
    .post("/login")
    .set("Cookie", cookies(jar))
    .set("x-csrf-token", csrfToken(form))
    .type("form")
    .send({ email, password });
  expect(login.status).toBe(302);
  remember(jar, login);
  return login;
}

async function expiry(id: string): Promise<Date | null> {
  const { rows } = await pool.query('SELECT "expire" FROM "session" WHERE "sid" = $1', [id]);
  return rows[0]?.expire ?? null;
}

/**
 * Hold before response headers exist: browsers apply Set-Cookie as soon as
 * headers arrive, so holding only the store's final save conceals this race.
 */
function holdNextAdminLookup(): { reached: Promise<void>; release: () => void } {
  const original = User.findById;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  vi.spyOn(User, "findById").mockImplementationOnce(async (id) => {
    arrive();
    await released;
    return original.call(User, id);
  });
  return { reached, release };
}

describe("session cookie delivery and inactivity", () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE "session", "rate_limits"');
    await User.upsertAdmin({ email, password });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    server.close();
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
  });

  it("keeps initial repeated failed logins anonymous and still accepts the next login", async () => {
    const jar = new Map<string, string>();
    const form = await request(server).get("/login");
    remember(jar, form);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await request(server).post("/login")
        .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(form))
        .type("form").send({ email, password: "an incorrect long password" });
      expect(failed.status).toBe(401);
      expect(sessionCookies(failed)).toEqual([]);
      remember(jar, failed);
    }
    expect((await pool.query('SELECT COUNT(*) FROM "session"')).rows[0].count).toBe("0");
    expect(sessionCookies(await signIn(jar))).toHaveLength(1);
    expect((await request(server).get("/games/new").set("Cookie", cookies(jar))).status)
      .toBe(200);
  });

  it.each([
    { method: "GET", quoted: false },
    { method: "POST", quoted: false },
    { method: "GET", quoted: true },
  ] as const)(
    "keeps the new login after a delayed $method (quoted cookie: $quoted)",
    async ({ method, quoted }) => {
      const jar = new Map<string, string>();
      await signIn(jar);
      const oldSid = sid(jar);
      const oldCookie = quoted
        ? cookies(jar).replace(/connect\.sid=([^;]+)/, 'connect.sid="$1"')
        : cookies(jar);
      const page = await request(server).get("/").set("Cookie", oldCookie);
      remember(jar, page);
      const hold = holdNextAdminLookup();
      const delayed = method === "GET"
        ? request(server).get("/games/new").set("Cookie", oldCookie)
        : request(server).post("/comments/999999/delete")
          .set("Cookie", oldCookie).set("x-csrf-token", csrfToken(page));
      const pending = delayed.then((response) => response);

      await hold.reached;
      try {
        const logout = await request(server).post("/logout")
          .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(page));
        expect(logout.status).toBe(302);
        expect(sessionCookies(logout)).toEqual([]);
        remember(jar, logout);
        await signIn(jar);
        expect(sid(jar)).not.toBe(oldSid);
      } finally {
        hold.release();
      }

      const late = await pending;
      expect(late.status).toBe(method === "GET" ? 200 : 302);
      expect(sessionCookies(late)).toEqual([]);
      remember(jar, late);
      expect(await expiry(oldSid)).toBeNull();
      expect((await request(server).get("/games/new").set("Cookie", cookies(jar))).status)
        .toBe(200);
      expect((await request(server).get("/games/new").set("Cookie", oldCookie)).status)
        .toBe(302);
    },
  );

  it("keeps the new login and its fresh forms when an earlier logout response arrives afterwards", async () => {
    const jar = new Map<string, string>();
    await signIn(jar);
    const oldSid = sid(jar);
    const page = await request(server).get("/").set("Cookie", cookies(jar));
    remember(jar, page);
    const store = app.locals.sessionStore as PostgresSessionStore;
    const original = store.destroy;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => { arrive = resolve; });

    // The deletion commits, but the old logout is still waiting before it
    // sends headers. The same browser can now log in from another tab.
    vi.spyOn(store, "destroy").mockImplementation(function (
      this: PostgresSessionStore, id, callback,
    ) {
      original.call(this, id, ((error?: unknown) => {
        if (id !== oldSid) {
          (callback as ((error?: unknown) => void) | undefined)?.(error);
          return;
        }
        expect(error).toBeFalsy();
        arrive();
        void released.then(() => callback?.());
      }) as () => void);
    });
    const pending = request(server).post("/logout")
      .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(page))
      .then((response) => response);

    let freshPage!: Response;
    let newSecret: string | undefined;
    await reached;
    try {
      expect(await expiry(oldSid)).toBeNull();
      await signIn(jar);
      expect(sid(jar)).not.toBe(oldSid);
      freshPage = await request(server).get("/games/new").set("Cookie", cookies(jar));
      expect(freshPage.status).toBe(200);
      remember(jar, freshPage);
      newSecret = jar.get(CSRF_COOKIE);
      expect(newSecret).toBeDefined();
    } finally {
      release();
    }

    const logout = await pending;
    expect(logout.status).toBe(302);
    expect(sessionCookies(logout)).toEqual([]);
    remember(jar, logout);
    // A successful GET only proves the session id survived. An old logout
    // used to overwrite the new login's CSRF cookie while leaving that id
    // intact, so the form loaded after login still failed its next POST.
    const submitted = await request(server).post("/comments/2147483647/delete")
      .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(freshPage));
    expect(submitted.status).toBe(302);
    expect(submitted.headers.location).toBe("/comments");
    expect(jar.get(CSRF_COOKIE)).toBe(newSecret);
    expect((logout.headers["set-cookie"] as unknown as string[] ?? [])
      .filter((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))).toEqual([]);
    expect((await request(server).get("/games/new").set("Cookie", cookies(jar))).status)
      .toBe(200);
  });

  it("reports a failed store deletion instead of claiming logout succeeded", async () => {
    const jar = new Map<string, string>();
    await signIn(jar);
    const page = await request(server).get("/").set("Cookie", cookies(jar));
    remember(jar, page);
    const id = sid(jar);
    const store = app.locals.sessionStore as PostgresSessionStore;
    vi.spyOn(store, "destroy").mockImplementationOnce((_id, callback) => {
      (callback as (error: Error) => void)(new Error("session deletion failed"));
    });
    const logout = await request(server).post("/logout")
      .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(page));
    expect(logout.status).toBe(500);
    expect(sessionCookies(logout)).toEqual([]);
    expect(await expiry(id)).not.toBeNull();
    expect((await request(server).get("/games/new").set("Cookie", cookies(jar))).status)
      .toBe(200);
  });

  it("keeps revocation final for another store instance with independent idle expiry", async () => {
    const jar = new Map<string, string>();
    await signIn(jar);
    const id = sid(jar);
    const otherStore = new PostgresSessionStore({
      pool, idleTimeoutSeconds: WEEK_MS / 1000, errorLog: () => {},
    });
    try {
      const loaded = await new Promise<session.Session & session.SessionData>((resolve, reject) => {
        otherStore.load(id, (error, data) => {
          if (error) return reject(error);
          if (!data) return reject(new Error("session not loaded"));
          resolve(data as session.Session & session.SessionData);
        });
      });
      const page = await request(server).get("/").set("Cookie", cookies(jar));
      const logout = await request(server).post("/logout")
        .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(page));
      expect(logout.status).toBe(302);
      loaded.flash = { error: ["An old in-flight write."] };
      await new Promise<void>((resolve, reject) => {
        loaded.save((error) => error ? reject(error) : resolve());
      });
      await new Promise<void>((resolve, reject) => {
        otherStore.touch(id, loaded, (error) => error ? reject(error) : resolve());
      });
      expect(await expiry(id)).toBeNull();
    } finally {
      otherStore.close();
    }
  });

  it("issues a persistent login cookie while giving its row only seven days", async () => {
    const jar = new Map<string, string>();
    const before = Date.now();
    const login = await signIn(jar);
    const cookie = sessionCookies(login)[0]!;
    const cookieExpiry = new Date(/Expires=([^;]+)/.exec(cookie)![1]!).getTime();
    expect(cookieExpiry - before).toBeGreaterThan(364 * 24 * 60 * 60 * 1000);
    expect(cookie).toMatch(/Path=\/;.*HttpOnly;.*SameSite=Lax/);
    expect(Math.abs((await expiry(sid(jar)))!.getTime() - Date.now() - WEEK_MS))
      .toBeLessThan(2_000);
  });

  it.each(["GET", "POST"] as const)(
    "renews seven idle days on an authenticated %s without rewriting the browser id",
    async (method) => {
      const jar = new Map<string, string>();
      await signIn(jar);
      const page = await request(server).get("/").set("Cookie", cookies(jar));
      remember(jar, page);
      await pool.query('UPDATE "session" SET "expire" = NOW() + INTERVAL \'1 hour\' WHERE "sid" = $1', [sid(jar)]);
      const response = method === "GET"
        ? await request(server).get("/games/new").set("Cookie", cookies(jar))
        : await request(server).post("/comments/999999/delete")
          .set("Cookie", cookies(jar)).set("x-csrf-token", csrfToken(page));
      expect(response.status).toBe(method === "GET" ? 200 : 302);
      expect(sessionCookies(response)).toEqual([]);
      expect(Math.abs((await expiry(sid(jar)))!.getTime() - Date.now() - WEEK_MS))
        .toBeLessThan(2_000);
      if (method === "POST") {
        const next = await request(server).get("/").set("Cookie", cookies(jar));
        expect(next.text).toContain("Comment not found.");
        expect(sessionCookies(next)).toEqual([]);
      }
    },
  );

  it("refuses an idle-expired session despite its still-live browser cookie", async () => {
    const jar = new Map<string, string>();
    await signIn(jar);
    await pool.query('UPDATE "session" SET "expire" = NOW() - INTERVAL \'1 second\' WHERE "sid" = $1', [sid(jar)]);
    const page = await request(server).get("/games/new").set("Cookie", cookies(jar));
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/login");
    expect(sessionCookies(page)).toEqual([]);
  });
});
