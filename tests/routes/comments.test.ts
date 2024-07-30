import { beforeEach, describe, expect, it, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import { sidebarCache } from "../../utils/sidebar-cache.ts";
import commentsRouter from "../../routes/comments.ts";
import Comment, {
  COMMENTS_PAGE_SIZE,
  OVERVIEW_PAGE_SIZE,
  SOURCE_RETENTION_DAYS,
  commentSource,
} from "../../models/comment.ts";
import { credentialOf } from "../../utils/session-credential.ts";

const app = express();

// Test setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup view engine
app.set("view engine", "ejs");
app.set("views", "views");

// Mock render function
app.use((req, res, next) => {
  const originalRender = res.render;
  res.render = function (
    this: express.Response,
    view: string,
    locals?: any,
    callback?: any,
  ) {
    // Callback form renders for real — the load-more route embeds the HTML
    // in its JSON response. Without one, tests just want the view name.
    if (typeof callback === "function") {
      return (originalRender as any).call(this, view, locals, callback);
    }
    return res.json({ view, locals });
  } as any;
  next();
});

// Mock flash middleware
app.use((req, res, next) => {
  req.flash = ((type?: string, message?: string | string[]) => {
    if (type && message) {
      return 0; // Returns number of messages
    }
    return {}; // Returns all messages
  }) as any;
  next();
});

// Mock request referer
app.use((req, res, next) => {
  req.get = (name: string): any => {
    if (name === "Referer") {
      return "/games/1";
    }
    if (name === "set-cookie") {
      return undefined;
    }
    return undefined;
  };
  next();
});

app.use("/comments", commentsRouter);

/** What the admin's users row stores as its password hash — see beforeEach. */
const ADMIN_PASSWORD_HASH = "x";

/**
 * Every flash the admin app was asked to show, oldest first, so a test can
 * read what the moderator was told. Emptied before each test.
 */
const flashes: [string, string][] = [];

/**
 * The same wiring plus an admin session. The app above deliberately has none,
 * so the moderation routes can be checked from both sides.
 *
 * `user` is who the session says it is, and it is checked against the users
 * row of that id — so the non-admin app below is refused by isAdmin itself,
 * not by a session that simply lacks a role.
 */
function buildAdminApp(
  user: { id: number; email: string; role: string } = {
    id: 1,
    email: "admin@test.com",
    role: "ADMIN",
  },
) {
  const adminApp = express();

  adminApp.use(express.json());
  adminApp.use(express.urlencoded({ extended: true }));
  adminApp.set("view engine", "ejs");
  adminApp.set("views", "views");

  adminApp.use((req, res, next) => {
    // The credential a real login writes into the session, for the password
    // hash the users row below is seeded with. isAdmin compares the two on
    // every admin request and signs out a session whose credential does not
    // match — see utils/session-credential.ts — so a session without one is
    // not an admin session any more, whatever role it names.
    req.session = {
      user: { ...user, credential: credentialOf(ADMIN_PASSWORD_HASH) },
    } as any;

    req.flash = ((type: string, message: string) => {
      flashes.push([type, message]);
      return 0;
    }) as any;

    const originalRender = res.render;
    res.render = function (
      this: express.Response,
      view: string,
      locals?: any,
      callback?: any,
    ) {
      if (typeof callback === "function") {
        return (originalRender as any).call(this, view, locals, callback);
      }
      return res.json({ view, locals });
    } as any;

    next();
  });

  adminApp.use("/comments", commentsRouter);

  return adminApp;
}

const adminApp = buildAdminApp();

// A signed-in account that is not an admin: its users row is seeded with the
// role "USER" in beforeEach.
const memberApp = buildAdminApp({
  id: 2,
  email: "member@test.com",
  role: "USER",
});

/**
 * One listening server for the whole file, handed to supertest directly.
 *
 * `request(app)` opens a fresh server on an ephemeral port for every single
 * call and closes it again when the response arrives — this suite did that a
 * few hundred times a run. Ports come back round: a request could be answered
 * by whatever had taken the port since, which showed up as an assertion
 * failing against a status the routes under test cannot even produce (a 401,
 * from an app with no authentication in it at all). Intermittent, unrelated to
 * the code being tested, and impossible to read.
 *
 * Passing the server instead means supertest opens and closes nothing.
 */
const server = app.listen(0);
const adminServer = adminApp.listen(0);
const memberServer = memberApp.listen(0);

afterAll(() => {
  server.close();
  adminServer.close();
  memberServer.close();
});

describe("Comments Routes", () => {
  beforeEach(async () => {
    // The "Most discussed" panel is held for five minutes now (see
    // MOST_DISCUSSED_KEY), and the models drop it on a write — but the
    // truncation below is a statement of this file's own, which no model has
    // heard about. Without this, one test's counts are served to the next
    // and the panel describes a table that has since been emptied.
    sidebarCache.clear();

    // One statement, the way tests/setup.ts does it: a DELETE per table in
    // hand-kept dependency order and an ALTER SEQUENCE each is the pattern
    // the global cleanup replaced, and a table added later was missed here.
    //
    // "rate_limits" too, because every post below comes from the same
    // loopback address and so spends the same ten-per-five-minutes budget.
    // The file used to sit one or two posts under it by luck; the limiter's
    // own tests spend all ten, and without this every post after them in the
    // file is refused.
    await pool.query(
      'TRUNCATE "comments", "ratings", "plays", "game_of_the_week", "games", "news", "users", "rate_limits" RESTART IDENTITY CASCADE',
    );

    // Create test game
    await pool.query(
      'INSERT INTO "games" ("id", "title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        1,
        "Test Game",
        "test-game",
        "Test Description",
        "ACTION",
        "Test Developer",
      ],
    );

    // The admin the adminApp session below claims to be, and the member the
    // memberApp one does. isAdmin reads the role from the database rather
    // than from the session, so a session naming an account that does not
    // exist is refused — which is the point of that middleware, and means the
    // moderation tests need a real row for each.
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)',
      [1, "admin@test.com", ADMIN_PASSWORD_HASH, "ADMIN", 2, "member@test.com", "USER"],
    );

    flashes.length = 0;
  });

  describe("POST /comments", () => {
    it("should create comment with valid data", async () => {
      const commentData = {
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");
      expect(response.body.locals.comment).toBeDefined();

      // Verify that comment was created in database
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "content" = $1',
        [commentData.content],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].nick).toBe(commentData.nick);
      expect(result.rows[0].content).toBe(commentData.content);
      expect(result.rows[0].gameId).toBe(1);
    });

    /**
     * The same POST, answered two ways.
     *
     * views/comments/comment-form.ejs carries an action and a method now, so
     * the form works with the script blocked, failed or still loading —
     * before, pressing "Post comment" without JavaScript re-requested the
     * game page as a GET and threw the comment away. What the browser must
     * not get back is the rendered fragment the fetch path gets: one
     * unstyled <article> on a blank page, with no way back and a re-post
     * offered on reload.
     *
     * The two are told apart by the content type, because that is the thing
     * that actually differs — public/js/comments.js sends JSON, a browser
     * sends the form encoding.
     */
    describe("without JavaScript", () => {
      it("redirects to the game's comment thread", async () => {
        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({ nick: "TestUser", content: "No script here", gameId: "1" });

        expect(response.status).toBe(303);
        expect(response.headers.location).toBe("/test-game#comments");
      });

      it("stores the comment it redirected away from", async () => {
        await request(server)
          .post("/comments")
          .type("form")
          .send({ nick: "TestUser", content: "No script here", gameId: "1" });

        const result = await pool.query(
          'SELECT * FROM "comments" WHERE "content" = $1',
          ["No script here"],
        );

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].nick).toBe("TestUser");
      });

      // A reply lands on the same page; the thread is paged, so #comments and
      // not the new comment's own id — a fragment that matches nothing puts
      // the visitor back at the top of the page.
      it("redirects a reply to the same place", async () => {
        const parent = await request(server)
          .post("/comments")
          .send({ nick: "TestUser", content: "Parent", gameId: "1" });

        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({
            nick: "TestUser",
            content: "Child",
            gameId: "1",
            parentId: String(parent.body.locals.comment.id),
          });

        expect(response.status).toBe(303);
        expect(response.headers.location).toBe("/test-game#comments");
      });

      // The half that must not change: comments.js pastes the response
      // straight into the thread.
      it("still answers a JSON post with the rendered fragment", async () => {
        const response = await request(server)
          .post("/comments")
          .send({ nick: "TestUser", content: "Scripted", gameId: "1" });

        expect(response.status).toBe(200);
        expect(response.body.view).toBe("comments/comment-item");
      });

      /**
       * ...and the refusals, which used to answer in JSON whoever had asked.
       *
       * The success path had been taught to tell a form post from a fetch and
       * the four failure paths had not, so a visitor with scripts off was
       * shown the raw text of `{"error":"Invalid parent comment"}` as a whole
       * document — with no way back and the browser offering to re-post it on
       * reload. The page is views/400.ejs with the reason on it, which is the
       * same answer validations/comments.ts already gives a rejected form.
       */
      it("renders a page when a form post names a parent that is not there", async () => {
        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({
            nick: "TestUser",
            content: "Orphan",
            gameId: "1",
            parentId: "999999",
          });

        expect(response.status).toBe(400);
        expect(response.body.view).toBe("400");
        expect(response.body.locals.message).toBe("Invalid parent comment");
      });

      it("renders a page when a form post names a game that is not there", async () => {
        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({
            nick: "TestUser",
            content: "Nowhere",
            gameId: "999999999",
          });

        expect(response.status).toBe(404);
        expect(response.body.view).toBe("400");
        expect(response.body.locals.message).toBe("Game not found");
      });

      // The same refusal to the client that can read it. Both halves of the
      // endpoint now agree about who sent the request — see isJsonRequest.
      it("still answers a JSON post's refusal in JSON", async () => {
        const response = await request(server).post("/comments").send({
          nick: "TestUser",
          content: "Orphan",
          gameId: "1",
          parentId: "999999",
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid parent comment");
      });
    });

    it("should handle validation error for empty content", async () => {
      const invalidCommentData = {
        nick: "TestUser",
        content: "", // Empty content
        gameId: "1",
      };

      const response = await request(server)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"',
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle validation error for content too long", async () => {
      const longContent = "a".repeat(1001); // Over 1000 character limit
      const invalidCommentData = {
        nick: "TestUser",
        content: longContent,
        gameId: "1",
      };

      const response = await request(server)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"',
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle validation error for nick too long", async () => {
      const longNick = "a".repeat(256); // Over 255 character limit
      const invalidCommentData = {
        nick: longNick,
        content: "Valid content",
        gameId: "1",
      };

      const response = await request(server)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"',
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle validation error for invalid game ID", async () => {
      const invalidCommentData = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "invalid", // Invalid game ID
      };

      const response = await request(server)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"',
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    // validateComment runs ahead of the limiter, as it does in routes/games.ts:
    // a broken client looping on a malformed post would otherwise spend the
    // 10-per-5-minutes budget that real comments come out of — a budget shared
    // by everyone behind the same address.
    it("does not spend the rate-limit budget on a rejected post", async () => {
      await pool.query('DELETE FROM "rate_limits"');

      const response = await request(server)
        .post("/comments")
        .send({ nick: "TestUser", content: "Valid content", gameId: "nope" });

      expect(response.status).toBe(400);

      const counted = await pool.query(
        `SELECT COUNT(*) as count FROM "rate_limits" WHERE "key" LIKE 'comment:%'`,
      );

      expect(parseInt(counted.rows[0].count)).toBe(0);
    });

    /**
     * The eleventh comment in five minutes, refused the way every other
     * refusal of this POST is.
     *
     * The limiter was given an object `message` and no handler, so
     * express-rate-limit sent the object as the body of every 429 — which is
     * what comments.js wants, and exactly what a browser submitting the form
     * without JavaScript does not: that visitor was shown the raw text
     * `{"error":"Too many comments, please try again later."}` as a page.
     * refuseComment's docstring says that failure was fixed for every other
     * refusal; this was the one it had not reached.
     */
    describe("over the rate limit", () => {
      const LIMIT = 10;

      async function spendBudget() {
        for (let n = 1; n <= LIMIT; n++) {
          const response = await request(server)
            .post("/comments")
            .send({ nick: "Flooder", content: `Comment ${n}`, gameId: "1" });

          expect(response.status).toBe(200);
        }
      }

      it("renders the 400 page with the reason for a form post", async () => {
        await spendBudget();

        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({ nick: "Flooder", content: "One too many", gameId: "1" });

        expect(response.status).toBe(429);
        expect(response.body.view).toBe("400");
        expect(response.body.locals).toEqual({
          noindex: true,
          message: "Too many comments, please try again later.",
        });
      });

      // The half that must not change: comments.js reads `error`.
      it("still answers comments.js in JSON", async () => {
        await spendBudget();

        const response = await request(server)
          .post("/comments")
          .send({ nick: "Flooder", content: "One too many", gameId: "1" });

        expect(response.status).toBe(429);
        expect(response.headers["content-type"]).toMatch(/json/);
        expect(response.body).toEqual({
          error: "Too many comments, please try again later.",
        });
      });

      // The limiter sets these before it hands over to the handler, and a
      // handler of our own must not be what loses them.
      it("keeps the rate-limit headers on the refusal", async () => {
        await spendBudget();

        const response = await request(server)
          .post("/comments")
          .type("form")
          .send({ nick: "Flooder", content: "One too many", gameId: "1" });

        expect(response.status).toBe(429);
        expect(response.headers["ratelimit-limit"]).toBe(String(LIMIT));
        expect(response.headers["ratelimit-remaining"]).toBe("0");
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      });

      it("stores nothing it refused", async () => {
        await spendBudget();

        await request(server)
          .post("/comments")
          .type("form")
          .send({ nick: "Flooder", content: "One too many", gameId: "1" });

        const { rows } = await pool.query(
          `SELECT COUNT(*) AS count FROM "comments" WHERE "content" = $1`,
          ["One too many"],
        );

        expect(parseInt(rows[0].count, 10)).toBe(0);
      });
    });

    it("should create comment without nick (anonymous)", async () => {
      const commentData = {
        content: "Anonymous comment",
        gameId: "1",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");
      expect(response.body.locals.comment).toBeDefined();

      // Verify that comment was created in database
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "content" = $1',
        [commentData.content],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].nick).toBe("anonymous"); // Anonymous nick
      expect(result.rows[0].content).toBe(commentData.content);
      expect(result.rows[0].gameId).toBe(1);
    });

    it("should sanitize and trim content", async () => {
      const commentData = {
        nick: "TestUser",
        content: "  Trimmed content  ",
        gameId: "1",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");

      // Verify that comment was created with sanitized content
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "gameId" = $1',
        [1],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].content).toContain("Trimmed content");
    });

    /**
     * Stored as typed, not refused. A pattern check used to answer this 400,
     * and with it any sentence mentioning "javascript:" — while the only
     * thing that makes a comment safe to show is that every view renders it
     * through EJS's escaping <%= %>, which turns the tag into text.
     */
    it("should store content with script tags as text rather than refuse it", async () => {
      const commentData = {
        nick: "TestUser",
        content: "<script>alert('xss')</script>Malicious content",
        gameId: "1",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(200);

      const result = await pool.query(
        'SELECT "content" FROM "comments" WHERE "gameId" = 1',
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].content).toBe(commentData.content);
    });

    it("should return 404 when the game does not exist", async () => {
      const commentData = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "999999999",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Game not found");
    });

    /**
     * A reply whose parent a moderator deleted between the check and the
     * insert.
     *
     * The route reads the parent and confirms it belongs to this game, and
     * Postgres then refuses the row on "comments_parentId_fkey" — the same
     * SQLSTATE as a vanished game, which is why this was answered "Game not
     * found" and sent the visitor to look for a page that is perfectly fine.
     *
     * Forced through the read rather than raced for real: the window is
     * between two statements and nothing in a test can reliably sit inside
     * it. What is under test is which error the route recognises, and the
     * error Postgres raises is the same either way.
     */
    it("answers 409 when the parent comment vanished mid-request", async () => {
      const findById = vi
        .spyOn(Comment, "findById")
        .mockResolvedValue({ id: 999999, gameId: 1 } as any);

      try {
        const response = await request(server).post("/comments").send({
          nick: "TestUser",
          content: "A reply",
          gameId: "1",
          parentId: "999999",
        });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/removed/i);
        // Specifically not the game, which still exists.
        expect(response.body.error).not.toMatch(/game/i);
      } finally {
        findById.mockRestore();
      }
    });
  });

  describe("GET /comments/:gameId", () => {
    // The suite's beforeEach already seeds a game with id 1.
    const GAME_ID = 1;

    /**
     * `count` top-level comments on one game, oldest first, in one statement.
     *
     * It used to be a loop of single-row inserts — one round trip each, and
     * these tests seed up to twenty-five. That is fine when the machine is
     * idle and not when it is not: the latency alone could spend vitest's
     * default per-test budget, and the test then failed with "Test timed out"
     * rather than anything about what it was doing. One statement takes the
     * round trips out of the budget entirely.
     *
     * The ids come back ordered explicitly rather than in whatever order
     * RETURNING happens to produce, because the callers slice them as a
     * cursor: ids[15] has to be the sixteenth comment.
     */
    async function seedComments(gameId: number, count: number) {
      const { rows } = await pool.query(
        `WITH inserted AS (
           INSERT INTO "comments" ("nick", "content", "gameId")
           SELECT 'player' || i, 'Comment ' || i, $2
           FROM generate_series(1, $1) AS i
           RETURNING "id"
         )
         SELECT "id" FROM inserted ORDER BY "id"`,
        [count, gameId],
      );

      return rows.map((row) => row.id as number);
    }

    it("returns the batch of comments older than the cursor", async () => {
      const gameId = GAME_ID;
      const ids = await seedComments(gameId, 25);

      // Cursor = oldest of the newest ten, i.e. the 16th comment.
      const response = await request(server).get(
        `/comments/${gameId}?before=${ids[15]}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.html).toContain("Comment 15");
      expect(response.body.html).toContain("Comment 6");
      expect(response.body.html).not.toContain("Comment 16");
    });

    it("reports how many older comments are still unloaded", async () => {
      const gameId = GAME_ID;
      const total = COMMENTS_PAGE_SIZE * 2 + 5;
      const ids = await seedComments(gameId, total);

      // Cursor = oldest comment of the first page, so this fetches the second
      // and leaves exactly five behind whatever the page size is.
      const response = await request(server).get(
        `/comments/${gameId}?before=${ids[total - COMMENTS_PAGE_SIZE]}`,
      );

      expect(response.body.remaining).toBe(5);
      expect(response.body.oldestId).toBe(ids[total - COMMENTS_PAGE_SIZE * 2]);
    });

    it("reports nothing remaining once the thread is exhausted", async () => {
      const gameId = GAME_ID;
      const ids = await seedComments(gameId, 12);

      const response = await request(server).get(
        `/comments/${gameId}?before=${ids[2]}`,
      );

      expect(response.body.remaining).toBe(0);
    });

    it("returns an empty batch past the oldest comment", async () => {
      const gameId = GAME_ID;
      const ids = await seedComments(gameId, 3);

      const response = await request(server).get(
        `/comments/${gameId}?before=${ids[0]}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.html).toBe("");
      expect(response.body.remaining).toBe(0);
    });

    it("carries replies along with the comment they belong to", async () => {
      const gameId = GAME_ID;
      const ids = await seedComments(gameId, 15);
      await pool.query(
        'INSERT INTO "comments" ("nick","content","gameId","parentId") VALUES ($1,$2,$3,$4)',
        ["replier", "A nested reply", gameId, ids[1]],
      );

      const response = await request(server).get(
        `/comments/${gameId}?before=${ids[5]}`,
      );

      expect(response.body.html).toContain("A nested reply");
      expect(response.body.html).toContain("comment-reply");
    });

    it("rejects a junk cursor", async () => {
      const gameId = GAME_ID;

      expect(
        (await request(server).get(`/comments/${gameId}?before=abc`)).status,
      ).toBe(400);
    });

    // No cursor is not junk, it is the first batch — which is what
    // Comment.findByGameId does with a null "before". The route used to
    // answer 400 and so could never serve it.
    it("serves the newest batch when no cursor is given", async () => {
      await seedComments(GAME_ID, 25);

      const response = await request(server).get(`/comments/${GAME_ID}`);

      expect(response.status).toBe(200);
      // The newest twenty, oldest-first within the batch, with five older
      // ones still behind them.
      expect(response.body.html).toContain("Comment 25");
      expect(response.body.html).not.toContain("Comment 5");
      expect(response.body.remaining).toBe(5);
    });

    /**
     * An id with no game behind it and a thread the reader has reached the end
     * of used to be answered identically — 200 with an empty batch — so
     * "/comments/999999" was a success and a crawler walking made-up ids was
     * told every one of them exists. The lookup is paid only on the request
     * that has already found nothing, not on every click of the button.
     */
    it("404s an id with no game behind it", async () => {
      const response = await request(server).get("/comments/999999999");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Game not found");
    });

    // ...and the end of a real thread is still a 200 with nothing in it.
    it("still answers an exhausted thread with an empty batch", async () => {
      const response = await request(server).get(`/comments/${GAME_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ html: "", oldestId: null, remaining: 0 });
    });

    it("rejects an invalid game id", async () => {
      const response = await request(server).get("/comments/abc?before=5");

      expect(response.status).toBe(400);
    });
  });

  describe("GET /comments (site-wide overview)", () => {
    /**
     * The same one-statement seed as seedComments above, and for the same
     * reason: the overview tests seed a full page and one over, which was
     * thirty-one round trips before the request under test even started.
     */
    async function seed(count: number, gameId = 1) {
      const { rows } = await pool.query(
        `WITH inserted AS (
           INSERT INTO "comments" ("nick", "content", "gameId")
           SELECT 'player' || i, 'Comment ' || i, $2
           FROM generate_series(1, $1) AS i
           RETURNING "id"
         )
         SELECT "id" FROM inserted ORDER BY "id"`,
        [count, gameId],
      );

      return rows.map((row) => row.id as number);
    }

    it("lists the newest comments first, with the game they belong to", async () => {
      await seed(3);

      const response = await request(server).get("/comments");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comments-index");

      const { comments, total } = response.body.locals;

      expect(total).toBe(3);
      expect(comments.map((c: any) => c.content)).toEqual([
        "Comment 3",
        "Comment 2",
        "Comment 1",
      ]);
      expect(comments[0].gameTitle).toBe("Test Game");
      expect(comments[0].gameSlug).toBe("test-game");
    });

    it("counts replies too — a busy thread should not look quiet", async () => {
      const ids = await seed(2);
      await pool.query(
        'INSERT INTO "comments" ("nick","content","gameId","parentId") VALUES ($1,$2,$3,$4)',
        ["replier", "A reply", 1, ids[0]],
      );

      const response = await request(server).get("/comments");

      expect(response.body.locals.total).toBe(3);
      expect(response.body.locals.comments[0].content).toBe("A reply");
      expect(response.body.locals.comments[0].parentId).toBe(ids[0]);
    });

    it("pages through the archive without repeating a comment", async () => {
      await seed(OVERVIEW_PAGE_SIZE + 4);

      const [first, second] = await Promise.all([
        request(server).get("/comments"),
        request(server).get("/comments?page=2"),
      ]);

      expect(first.body.locals.comments).toHaveLength(OVERVIEW_PAGE_SIZE);
      expect(second.body.locals.comments).toHaveLength(4);

      const firstIds = first.body.locals.comments.map((c: any) => c.id);
      const secondIds = second.body.locals.comments.map((c: any) => c.id);

      expect(firstIds.filter((id: number) => secondIds.includes(id))).toEqual(
        [],
      );
      expect(second.body.locals.totalPages).toBe(2);
    });

    it("only computes the most-discussed list on the first page", async () => {
      await seed(OVERVIEW_PAGE_SIZE + 1);

      const first = await request(server).get("/comments");
      const second = await request(server).get("/comments?page=2");

      expect(first.body.locals.mostDiscussed).toHaveLength(1);
      expect(first.body.locals.mostDiscussed[0]).toMatchObject({
        gameSlug: "test-game",
        commentCount: OVERVIEW_PAGE_SIZE + 1,
      });
      expect(second.body.locals.mostDiscussed).toEqual([]);
    });

    it("ranks the most discussed games by comment count", async () => {
      await pool.query(
        'INSERT INTO "games" ("id","title","slug","genre") VALUES ($1,$2,$3,$4)',
        [2, "Quiet Game", "quiet-game", "RPG"],
      );

      await seed(2, 1);
      await seed(5, 2);

      const response = await request(server).get("/comments");

      expect(
        response.body.locals.mostDiscussed.map((g: any) => g.gameSlug),
      ).toEqual(["quiet-game", "test-game"]);
    });

    it("marks pages past the first as noindex-worthy via canonical", async () => {
      // One past a full page, so page 2 has something on it: a page with no
      // comments at all is a 404 rather than an empty list (below).
      await seed(OVERVIEW_PAGE_SIZE + 1);

      const response = await request(server).get("/comments?page=2");

      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/comments?page=2",
      );
      expect(response.body.locals.page).toBe(2);
    });

    it("404s a page past the end rather than rendering an empty list", async () => {
      await seed(1);

      const response = await request(server).get("/comments?page=3");

      expect(response.status).toBe(404);
    });

    it("renders happily with nothing to show", async () => {
      const response = await request(server).get("/comments");

      expect(response.status).toBe(200);
      expect(response.body.locals.comments).toEqual([]);
      expect(response.body.locals.total).toBe(0);
      expect(response.body.locals.mostDiscussed).toEqual([]);
    });
  });

  describe("POST /comments/:id/delete", () => {
    async function seedComment(parentId: number | null = null) {
      const { rows } = await pool.query(
        'INSERT INTO "comments" ("nick","content","gameId","parentId") VALUES ($1,$2,$3,$4) RETURNING "id"',
        ["player", "Spam", 1, parentId],
      );

      return rows[0].id as number;
    }

    // In the real app validateCsrf runs first, so an anonymous POST is a 403
    // before it ever reaches isAuth. This app mounts the router alone, which is
    // what makes the route's own guard visible.
    it("sends an anonymous visitor to the login page", async () => {
      const id = await seedComment();

      const response = await request(server).post(`/comments/${id}/delete`);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/login");

      const { rows } = await pool.query(
        'SELECT COUNT(*) AS count FROM "comments"',
      );
      expect(parseInt(rows[0].count, 10)).toBe(1);
    });

    it("lets an admin delete a comment and returns to the game", async () => {
      const id = await seedComment();

      const response = await request(adminServer)
        .post(`/comments/${id}/delete`)
        .send({ from: "game" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/test-game#comments");

      const { rows } = await pool.query(
        'SELECT COUNT(*) AS count FROM "comments"',
      );
      expect(parseInt(rows[0].count, 10)).toBe(0);
    });

    it("returns to the overview when that is where the form came from", async () => {
      const id = await seedComment();

      const response = await request(adminServer)
        .post(`/comments/${id}/delete`)
        .send({ from: "list" });

      expect(response.headers.location).toBe("/comments");
    });

    it("takes the replies down with the comment they answer", async () => {
      const rootId = await seedComment();
      const replyId = await seedComment(rootId);
      await seedComment(replyId);

      await request(adminServer)
        .post(`/comments/${rootId}/delete`)
        .send({ from: "list" });

      const { rows } = await pool.query(
        'SELECT COUNT(*) AS count FROM "comments"',
      );
      expect(parseInt(rows[0].count, 10)).toBe(0);
    });

    it("redirects rather than 404s on a junk id, since the 404 view needs sidebar data", async () => {
      const response = await request(adminServer)
        .post("/comments/abc/delete")
        .send({ from: "list" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/comments");
    });

    it("survives a comment that is already gone", async () => {
      const response = await request(adminServer)
        .post("/comments/999999/delete")
        .send({ from: "game" });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/comments");
    });
  });

  /**
   * Every comment one source posted, for a flood.
   *
   * Nothing tied a comment to the others its author had posted, and the only
   * brake was ten comments per five minutes per address — so a flood from an
   * IPv6 /48 was thousands of comments, each taken down with a click of its
   * own and no way to find the rest. A source is now recorded with every
   * comment (see commentSource in models/comment.ts), and these two routes
   * are what an admin does with it: see what one source posted, then delete
   * all of it.
   */
  describe("comments from one source", () => {
    /** The source the test server sees every post in this file come from. */
    const LOOPBACK_SOURCES = [
      commentSource("127.0.0.1"),
      commentSource("::1"),
    ];

    /** A comment posted through the route, as a visitor would post it. */
    async function postComment(content: string, parentId?: number) {
      const response = await request(server)
        .post("/comments")
        .send({ nick: "Flooder", content, gameId: "1", parentId });

      expect(response.status).toBe(200);

      return response.body.locals.comment.id as number;
    }

    /** A comment from somewhere else, written straight to the table. */
    async function seedFrom(
      ip: string | null,
      content: string,
      parentId: number | null = null,
    ) {
      const { rows } = await pool.query(
        `INSERT INTO "comments" ("nick", "content", "gameId", "parentId", "sourceHash")
         VALUES ('neighbour', $1, 1, $2, $3) RETURNING "id"`,
        [content, parentId, ip === null ? null : commentSource(ip)],
      );

      return rows[0].id as number;
    }

    async function contents(): Promise<string[]> {
      const { rows } = await pool.query(
        'SELECT "content" FROM "comments" ORDER BY "id"',
      );

      return rows.map((row) => row.content);
    }

    describe("what a post records", () => {
      it("records where a comment came from, as a hash", async () => {
        await postComment("one");
        await postComment("two");

        const { rows } = await pool.query(
          'SELECT "sourceHash" FROM "comments" ORDER BY "id"',
        );

        expect(LOOPBACK_SOURCES).toContain(rows[0].sourceHash);
        expect(rows[1].sourceHash).toBe(rows[0].sourceHash);
      });

      // The route hands the rendered comment to the view, and this suite
      // serialises those locals whole: whatever is on the instance is one
      // template away from the page. The hash stays in the database.
      it("hands the view a flag, never the hash", async () => {
        const response = await request(server)
          .post("/comments")
          .send({ nick: "Flooder", content: "one", gameId: "1" });

        expect(response.body.locals.comment.hasSource).toBe(true);

        for (const hash of LOOPBACK_SOURCES) {
          expect(JSON.stringify(response.body)).not.toContain(hash);
        }
      });
    });

    describe("POST /comments/:id/source", () => {
      it("shows an admin what the source posted before anything is deleted", async () => {
        const first = await postComment("spam 1");
        await seedFrom("198.51.100.23", "a real comment");
        await postComment("spam 2");
        await seedFrom("198.51.100.23", "please stop", first);

        const response = await request(adminServer).post(
          `/comments/${first}/source`,
        );

        expect(response.status).toBe(200);
        expect(response.body.view).toBe("comments/comment-source");

        const { locals } = response.body;

        expect(locals).toMatchObject({
          noindex: true,
          commentId: first,
          total: 2,
          otherReplies: 1,
          retentionDays: SOURCE_RETENTION_DAYS,
        });
        expect(locals.comments.map((c: any) => c.content)).toEqual([
          "spam 2",
          "spam 1",
        ]);
        expect(locals.comments[0].snippet).toBe("spam 2");
        expect(locals.comments[0].gameSlug).toBe("test-game");

        // Nothing has gone yet: this is the confirmation step.
        expect(await contents()).toHaveLength(4);
      });

      it("sends a comment with no source back with the reason", async () => {
        const unsourced = await seedFrom(null, "from before sources");

        const response = await request(adminServer).post(
          `/comments/${unsourced}/source`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/comments");
        expect(flashes).toEqual([
          [
            "error",
            `No source is recorded for that comment — sources are kept for ${SOURCE_RETENTION_DAYS} days.`,
          ],
        ]);
      });
    });

    describe("POST /comments/:id/source/delete", () => {
      it("deletes everything the source posted and nothing else", async () => {
        const first = await postComment("spam 1");
        await seedFrom("198.51.100.23", "a real comment");
        await postComment("spam 2");
        await seedFrom(null, "from before sources");

        const response = await request(adminServer).post(
          `/comments/${first}/source/delete`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/comments");
        expect(flashes).toEqual([
          [
            "success",
            "Deleted 2 comments from that source, and the replies to them.",
          ],
        ]);
        expect(await contents()).toEqual([
          "a real comment",
          "from before sources",
        ]);
      });

      // The single delete's cascade, only wider: a reply to spam goes with
      // it, whoever wrote the reply.
      it("takes the replies to those comments with them", async () => {
        const spam = await postComment("spam");
        const answer = await seedFrom("198.51.100.23", "please stop", spam);
        await seedFrom("198.51.100.99", "seconded", answer);
        await seedFrom("198.51.100.23", "unrelated");

        await request(adminServer).post(`/comments/${spam}/source/delete`);

        expect(await contents()).toEqual(["unrelated"]);
      });

      /**
       * The single delete drops the sidebar's Latest comments and the "Most
       * discussed" panel, and bumps the "comments" epoch so every other
       * machine does the same. A flood is exactly what those two were
       * showing, so this must not leave them serving it. The epoch itself is
       * checked in tests/models/comment-source.test.ts, where it can be
       * observed; this is the half a visitor sees.
       */
      it("stops the sidebar and the overview showing the flood", async () => {
        const spam = await postComment("spam");
        await postComment("more spam");

        const before = await request(server).get("/comments");

        expect(before.body.locals.mostDiscussed[0].commentCount).toBe(2);

        await request(adminServer).post(`/comments/${spam}/source/delete`);

        const after = await request(server).get("/comments");

        expect(after.body.locals.total).toBe(0);
        expect(after.body.locals.mostDiscussed).toEqual([]);
      });

      it("deletes nothing for a comment with no source", async () => {
        const unsourced = await seedFrom(null, "from before sources");
        await postComment("spam");

        const response = await request(adminServer).post(
          `/comments/${unsourced}/source/delete`,
        );

        expect(response.headers.location).toBe("/comments");
        expect(flashes[0]![0]).toBe("error");
        expect(await contents()).toEqual(["from before sources", "spam"]);
      });
    });

    describe.each([
      ["POST /comments/:id/source", "source"],
      ["POST /comments/:id/source/delete", "source/delete"],
    ])("%s", (_label, action) => {
      // As with the single delete: in the real app validateCsrf answers an
      // anonymous POST first, so this is the route's own guard showing.
      it("sends an anonymous visitor to the login page", async () => {
        const spam = await postComment("spam");

        const response = await request(server).post(
          `/comments/${spam}/${action}`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/login");
        expect(await contents()).toEqual(["spam"]);
      });

      it("refuses an account that is not an admin", async () => {
        const spam = await postComment("spam");

        const response = await request(memberServer).post(
          `/comments/${spam}/${action}`,
        );

        expect(response.status).toBe(403);
        expect(await contents()).toEqual(["spam"]);
      });

      it("redirects rather than 404s on a junk id", async () => {
        const response = await request(adminServer).post(
          `/comments/5abc/${action}`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/comments");
        expect(flashes).toEqual([["error", "Invalid comment."]]);
      });

      it("survives a comment that is already gone", async () => {
        const response = await request(adminServer).post(
          `/comments/999999/${action}`,
        );

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/comments");
        expect(flashes).toEqual([["error", "Comment not found."]]);
      });
    });
  });
});
