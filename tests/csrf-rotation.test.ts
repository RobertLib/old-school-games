import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request, { type Response } from "supertest";
import app from "../app.ts";
import pool from "../db.ts";
import Game from "../models/game.ts";
import User from "../models/user.ts";
import { CSRF_COOKIE } from "../middlewares/csrf.ts";

const server = app.listen(0);
const email = "csrf-rotation-admin@example.com";
const password = "a long password for the CSRF rotation tests";
const HELD_SLUG = "csrf-rotation-held-page";

function rememberCookies(jar: Map<string, string>, headers: unknown): void {
  for (const header of (headers as string[] | undefined) ?? []) {
    const pair = header.split(";")[0]!;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);

    if (value === "" || /Max-Age=0(?:;|$)/i.test(header)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function cookies(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function tokenOn(page: string): string {
  const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
    page,
  )?.[1];

  expect(token, "no CSRF token on the page").toBeDefined();
  return token!;
}

function csrfCookies(response: Response): string[] {
  return ((response.headers["set-cookie"] as unknown as string[] | undefined) ?? [])
    .filter((header) => header.startsWith(`${CSRF_COOKIE}=`));
}

async function login(jar: Map<string, string>, token: string): Promise<Response> {
  return request(server)
    .post("/login")
    .set("Cookie", cookies(jar))
    .set("x-csrf-token", token)
    .type("form")
    .send({ email, password })
    .redirects(0);
}

/** Hold a real page after CSRF middleware, before its headers are sent. */
function holdNextPage(): { reached: Promise<void>; release: () => void } {
  const original = Game.findBySlug;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let held = false;

  vi.spyOn(Game, "findBySlug").mockImplementation(async (slug) => {
    if (slug === HELD_SLUG && !held) {
      held = true;
      arrive();
      await released;
    }

    return original.call(Game, slug);
  });

  return { reached, release };
}

beforeEach(async () => {
  await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  await User.upsertAdmin({ email, password });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  server.close();
  await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
  await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
});

describe("CSRF rotation with a page already in flight", () => {
  it("keeps the login's new secret when an anonymous page finishes later", async () => {
    const jar = new Map<string, string>();
    const form = await request(server).get("/login");
    expect(form.status).toBe(200);
    rememberCookies(jar, form.headers["set-cookie"]);
    const oldSecret = jar.get(CSRF_COOKIE);
    const hold = holdNextPage();
    const pending = request(server)
      .get(`/${HELD_SLUG}`)
      .set("Cookie", cookies(jar))
      .then((response) => response);

    try {
      await hold.reached;
      const signedIn = await login(jar, tokenOn(form.text));
      expect(signedIn.status).toBe(302);
      rememberCookies(jar, signedIn.headers["set-cookie"]);
      const newSecret = jar.get(CSRF_COOKIE);
      expect(newSecret).toBeDefined();
      expect(newSecret).not.toBe(oldSecret);

      const page = await request(server).get("/about").set("Cookie", cookies(jar));
      expect(page.status).toBe(200);
      rememberCookies(jar, page.headers["set-cookie"]);

      hold.release();
      const late = await pending;
      expect(late.status).toBe(404);
      expect(csrfCookies(late)).toEqual([]);
      rememberCookies(jar, late.headers["set-cookie"]);
      expect(jar.get(CSRF_COOKIE)).toBe(newSecret);

      // The fresh page's token must still authorize a real unsafe request.
      const logout = await request(server)
        .post("/logout")
        .set("Cookie", cookies(jar))
        .set("x-csrf-token", tokenOn(page.text))
        .redirects(0);
      expect(logout.status).toBe(302);
      expect(logout.headers.location).toBe("/");
    } finally {
      hold.release();
      await pending;
    }
  });

  it("revokes access without changing the secret when a signed-in page finishes after logout", async () => {
    const jar = new Map<string, string>();
    const form = await request(server).get("/login");
    rememberCookies(jar, form.headers["set-cookie"]);
    const signedIn = await login(jar, tokenOn(form.text));
    expect(signedIn.status).toBe(302);
    rememberCookies(jar, signedIn.headers["set-cookie"]);
    const page = await request(server).get("/about").set("Cookie", cookies(jar));
    expect(page.status).toBe(200);
    rememberCookies(jar, page.headers["set-cookie"]);
    const oldSecret = jar.get(CSRF_COOKIE);
    const hold = holdNextPage();
    const pending = request(server)
      .get(`/${HELD_SLUG}`)
      .set("Cookie", cookies(jar))
      .then((response) => response);

    try {
      await hold.reached;
      const logout = await request(server)
        .post("/logout")
        .set("Cookie", cookies(jar))
        .set("x-csrf-token", tokenOn(page.text))
        .redirects(0);
      expect(logout.status).toBe(302);
      expect(csrfCookies(logout)).toEqual([]);
      rememberCookies(jar, logout.headers["set-cookie"]);
      expect(jar.get(CSRF_COOKIE)).toBe(oldSecret);

      // Keeping a valid CSRF token must not keep the revoked session's admin
      // access: authentication is checked independently of the token.
      const refused = await request(server)
        .post("/comments/2147483647/delete")
        .set("Cookie", cookies(jar))
        .set("x-csrf-token", tokenOn(page.text));
      expect(refused.status).toBe(302);
      expect(refused.headers.location).toBe("/login");

      const freshForm = await request(server).get("/login").set("Cookie", cookies(jar));
      expect(freshForm.status).toBe(200);
      rememberCookies(jar, freshForm.headers["set-cookie"]);

      hold.release();
      const late = await pending;
      expect(late.status).toBe(404);
      expect(csrfCookies(late)).toEqual([]);
      rememberCookies(jar, late.headers["set-cookie"]);
      expect(jar.get(CSRF_COOKIE)).toBe(oldSecret);

      const nextLogin = await login(jar, tokenOn(freshForm.text));
      expect(nextLogin.status).toBe(302);
      expect(nextLogin.headers.location).toBe("/");
      rememberCookies(jar, nextLogin.headers["set-cookie"]);
      expect(jar.get(CSRF_COOKIE)).not.toBe(oldSecret);
    } finally {
      hold.release();
      await pending;
    }
  });
});
