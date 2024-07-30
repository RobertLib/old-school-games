import { beforeEach, describe, expect, it, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import commentsRouter from "../../routes/comments.ts";
import {
  COMMENTS_PAGE_SIZE,
  OVERVIEW_PAGE_SIZE,
} from "../../models/comment.ts";

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

/**
 * The same wiring plus an admin session. The app above deliberately has none,
 * so the moderation routes can be checked from both sides.
 */
function buildAdminApp() {
  const adminApp = express();

  adminApp.use(express.json());
  adminApp.use(express.urlencoded({ extended: true }));
  adminApp.set("view engine", "ejs");
  adminApp.set("views", "views");

  adminApp.use((req, res, next) => {
    req.session = {
      user: { id: 1, email: "admin@test.com", role: "ADMIN" },
    } as any;

    req.flash = (() => 0) as any;

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

afterAll(() => {
  server.close();
  adminServer.close();
});

describe("Comments Routes", () => {
  beforeEach(async () => {
    // One statement, the way tests/setup.ts does it: a DELETE per table in
    // hand-kept dependency order and an ALTER SEQUENCE each is the pattern
    // the global cleanup replaced, and a table added later was missed here.
    await pool.query(
      'TRUNCATE "comments", "ratings", "plays", "game_of_the_week", "games", "news", "users" RESTART IDENTITY CASCADE',
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

    // The admin the adminApp session below claims to be. isAdmin reads the
    // role from the database rather than from the session, so a session
    // naming an account that does not exist is refused — which is the point
    // of that middleware, and means the moderation tests need a real row.
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4)',
      [1, "admin@test.com", "x", "ADMIN"],
    );
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

    it("should reject content with script tags", async () => {
      const commentData = {
        nick: "TestUser",
        content: "<script>alert('xss')</script>Malicious content",
        gameId: "1",
      };

      const response = await request(server).post("/comments").send(commentData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"',
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
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
});
