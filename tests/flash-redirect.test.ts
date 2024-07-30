import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request, { type Response } from "supertest";
import http, { type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import app from "../app.ts";
import pool from "../db.ts";
import Game from "../models/game.ts";
import News from "../models/news.ts";
import Comment from "../models/comment.ts";
import User from "../models/user.ts";
import type { PostgresSessionStore } from "../utils/session-store.ts";

const server = app.listen(0);
const email = "flash-redirect-admin@example.com";
const password = "a long password for the flash redirect tests";

interface Browser {
  cookie: string;
  token: string;
  sid: string;
}

function rememberCookies(jar: Map<string, string>, headers: unknown): void {
  for (const header of (headers as string[] | undefined) ?? []) {
    const pair = header.split(";")[0]!;
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookies(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function csrfToken(page: string): string {
  const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
    page,
  )?.[1];
  expect(token, "no CSRF token on the page").toBeDefined();
  return token!;
}

async function signIn(): Promise<Browser> {
  const jar = new Map<string, string>();
  const form = await request(server).get("/login");
  rememberCookies(jar, form.headers["set-cookie"]);

  const login = await request(server)
    .post("/login")
    .set("Cookie", cookies(jar))
    .set("x-csrf-token", csrfToken(form.text))
    .type("form")
    .send({ email, password })
    .redirects(0);
  expect(login.status).toBe(302);
  rememberCookies(jar, login.headers["set-cookie"]);

  // Login rotates the CSRF secret, so the following page supplies the token
  // the browser must use for its admin POST.
  const page = await request(server).get("/").set("Cookie", cookies(jar));
  rememberCookies(jar, page.headers["set-cookie"]);
  const signed = decodeURIComponent(jar.get("connect.sid")!);

  return {
    cookie: cookies(jar),
    token: csrfToken(page.text),
    sid: signed.slice(2, signed.lastIndexOf(".")),
  };
}

/** Hold exactly one write, so the following GET can consume the saved flash. */
function holdNextSave(sid: string): {
  reached: Promise<void>;
  release: () => void;
} {
  const store = app.locals.sessionStore as PostgresSessionStore;
  const original = store.set;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let held = false;

  vi.spyOn(store, "set").mockImplementation(function (
    this: PostgresSessionStore,
    ...args
  ) {
    if (args[0] !== sid || held) return original.apply(this, args);
    held = true;
    arrive();
    void released.then(() => original.apply(this, args));
  });

  return { reached, release };
}

/**
 * Follow Location when its headers arrive, as browsers do. Waiting for the
 * whole POST with supertest would conceal this race: express-session holds
 * its last body byte until the save completes, but sends its headers early.
 */
function postAndFollow(
  browser: Browser,
  path: string,
  form: Record<string, string>,
): Promise<{ status: number; location: string; page: Response }> {
  const address = server.address() as AddressInfo;
  const body = new URLSearchParams(form).toString();

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
        method: "POST",
        headers: {
          Cookie: browser.cookie,
          "x-csrf-token": browser.token,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (redirect) => {
        redirect.resume();
        const location = redirect.headers.location;
        if (!location) {
          reject(new Error(
            `POST ${path} returned ${redirect.statusCode} without Location`,
          ));
          return;
        }

        void request(server).get(location).set("Cookie", browser.cookie).then(
          (page) => resolve({ status: redirect.statusCode ?? 0, location, page }),
          reject,
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

interface Fixtures {
  gameId: number;
  newsId: number;
  commentId: number;
}

interface FlashCase {
  name: string;
  path: () => string;
  form: Record<string, string>;
  message: string;
  location: string;
}

describe("admin flashes are persisted before redirect headers leave", () => {
  let fixtures: Fixtures;

  beforeEach(async () => {
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    const user = await User.upsertAdmin({ email, password });
    const game = await Game.create({
      title: "Flash redirect fixture game",
      genre: "ACTION",
    });
    const news = await News.create({
      title: "Flash redirect fixture news",
      content: "An article for the flash regression.",
      userId: user.id,
    });
    const comment = await Comment.create({
      nick: "Flash test",
      content: "Remove me.",
      gameId: game.id,
    });
    fixtures = { gameId: game.id, newsId: news.id, commentId: comment.id };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query('DELETE FROM "games" WHERE "title" LIKE $1', [
      "Flash redirect %",
    ]);
    await pool.query('DELETE FROM "news" WHERE "title" LIKE $1', [
      "Flash redirect %",
    ]);
    await pool.query(
      `DELETE FROM "session" WHERE "sess" -> 'user' ->> 'email' = $1`,
      [email],
    );
  });

  afterAll(async () => {
    server.close();
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  const cases: FlashCase[] = [
    {
      name: "create a game",
      path: () => "/games",
      form: { title: "Flash redirect created game", genre: "ACTION" },
      message: "Game created successfully.",
      location: "/",
    },
    {
      name: "edit a game",
      path: () => `/games/${fixtures.gameId}`,
      form: { title: "Flash redirect edited game", genre: "ACTION" },
      message: "Game updated successfully.",
      location: "/",
    },
    {
      name: "create news",
      path: () => "/news",
      form: {
        title: "Flash redirect created news",
        content: "An article newly added.",
      },
      message: "News added successfully!",
      location: "/news",
    },
    {
      name: "edit news",
      path: () => `/news/${fixtures.newsId}`,
      form: {
        title: "Flash redirect edited news",
        content: "The updated article.",
      },
      message: "News updated successfully!",
      location: "/news/flash-redirect-edited-news",
    },
    {
      name: "moderate a comment",
      path: () => `/comments/${fixtures.commentId}/delete`,
      form: {},
      message: "Comment deleted.",
      location: "/comments",
    },
    {
      name: "explain a missing comment",
      path: () => "/comments/2147483647/delete",
      form: {},
      message: "Comment not found.",
      location: "/comments",
    },
  ];

  it.each(cases)("$name", async ({ path, form, message, location }) => {
    const browser = await signIn();
    const target = path();
    let response: ServerResponse | undefined;
    const observe = (
      incoming: IncomingMessage,
      outgoing: ServerResponse,
    ): void => {
      if (incoming.method === "POST" && incoming.url === target) response = outgoing;
    };
    server.on("request", observe);

    const hold = holdNextSave(browser.sid);
    const browserFlow = postAndFollow(browser, target, form);

    try {
      await Promise.race([
        hold.reached,
        browserFlow.then(() => {
          throw new Error("POST finished before its flash reached the store");
        }),
      ]);

      // This continuation runs after the current synchronous stack. On the
      // old redirect path, express-session calls writetop() immediately after
      // store.set() returns, so headersSent is already true here. Checking
      // the server response makes this deterministic without a sleep or any
      // assumption about when the client socket receives those bytes.
      expect(response).toBeDefined();
      expect(
        response!.headersSent,
        "redirect headers left before the session save completed",
      ).toBe(false);

      const stored = await pool.query(
        'SELECT "sess" FROM "session" WHERE "sid" = $1',
        [browser.sid],
      );
      expect(JSON.stringify(stored.rows[0].sess)).not.toContain(message);

      hold.release();
      const followed = await browserFlow;
      expect(followed.status).toBe(302);
      expect(followed.location).toBe(location);
      expect(followed.page.status).toBe(200);
      expect(followed.page.text).toContain(message);

      // A message remains one-shot even though the redirect now saves it
      // explicitly before express-session finishes the response.
      const again = await request(server)
        .get(location)
        .set("Cookie", browser.cookie);
      expect(again.text).not.toContain(message);
    } finally {
      hold.release();
      server.off("request", observe);
      await browserFlow;
    }
  });

  it("returns the real error page when saving the flash fails", async () => {
    const browser = await signIn();
    const store = app.locals.sessionStore as PostgresSessionStore;
    vi.spyOn(store, "set").mockImplementationOnce((_sid, _data, callback) => {
      process.nextTick(callback!, new Error("flash session write failed"));
    });

    const failed = await request(server)
      .post("/comments/2147483647/delete")
      .set("Cookie", browser.cookie)
      .set("x-csrf-token", browser.token)
      .redirects(0);

    expect(failed.status).toBe(500);
    expect(failed.headers.location).toBeUndefined();
    expect(failed.text).toContain("500 - Server Error - OldSchoolGames");
  });
});
