import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import express from "express";
import ejs from "ejs";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import pool from "../../db.ts";
import Game from "../../models/game.ts";
import gamesRouter, {
  PER_GAME_WINDOW_MS,
  PLAYS_PER_GAME,
  RATINGS_PER_GAME,
} from "../../routes/games.ts";
import crypto from "crypto";
import { VOTER_COOKIE, voterId } from "../../middlewares/voter-id.ts";
import { readCookie } from "../../utils/cookies.ts";
import { credentialOf } from "../../utils/session-credential.ts";

/**
 * An error a test provoked on purpose, so the handler at the bottom of this
 * file can tell it from one the routes produced by themselves and keep its
 * stack out of the run's output.
 */
function provoked(message: string): Error {
  return Object.assign(new Error(message), { expected: true });
}

/** The templates, for the cases that render the real form. */
const VIEWS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../views",
);

const app = express();

// Test setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mock middleware for authentication and admin role - simple without session
app.use((req, res, next) => {
  // Simulate logged in admin user - simple object without session touch.
  //
  // The credential is what a real login writes into the session: isAdmin
  // compares it with the account's stored hash on every admin request and
  // signs out a session that does not match (see utils/session-credential.ts).
  // The users row below is inserted with the password "hashedpassword".
  req.session = {
    user: {
      id: 1,
      email: "admin@test.com",
      role: "ADMIN",
      credential: credentialOf("hashedpassword"),
    },
  } as any;
  next();
});

// Setup view engine
app.set("view engine", "ejs");
app.set("views", "views");

// Mock render function
app.use((req, res, next) => {
  res.render = function (view: string, locals?: any) {
    // For tests simply return JSON response
    return res.json({ view, locals });
  };
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

// Mock request IP. A test that needs a second visitor names one in
// "x-test-ip"; everything else arrives from the same address.
app.use((req, res, next) => {
  const override = req.headers["x-test-ip"];

  Object.defineProperty(req, "ip", {
    value: typeof override === "string" ? override : "127.0.0.1",
    writable: true,
    configurable: true,
  });
  next();
});

/**
 * Ratings are deduplicated per browser, not per IP, so the routes need the
 * same voter-id cookie the real app issues.
 *
 * The middleware mints one on safe methods only (see voter-id.ts): a browser
 * receives its id from the page it is looking at and then posts with it. The
 * tests here post straight to the routes without that page view, so this
 * stands in for it — a request arriving without the cookie is handed one, on
 * the request and on the response, as if the page had been fetched first.
 */
app.use((req, res, next) => {
  if (
    !readCookie(req.headers.cookie, VOTER_COOKIE) &&
    !req.headers["x-test-no-voter"]
  ) {
    const id = crypto.randomUUID();

    req.headers.cookie = [req.headers.cookie, `${VOTER_COOKIE}=${id}`]
      .filter(Boolean)
      .join("; ");
    res.cookie(VOTER_COOKIE, id, { httpOnly: true, sameSite: "lax" });
  }

  next();
});
app.use(voterId);

/**
 * Takes the voter id back off, for the two routes that answer differently
 * without one.
 *
 * The middleware above issues one unconditionally, so a browser that refuses
 * the cookie — which is what those branches are written for — cannot otherwise
 * be expressed here. A header rather than a second app, so these cases run
 * against exactly the stack every other test in this file uses.
 */
app.use((req, res, next) => {
  if (req.headers["x-test-no-voter"]) {
    delete (req as any).voterId;
  }
  next();
});

/**
 * Stands in for the locals sidebarData sets on every page request, which this
 * app does not mount. The value is JSON in the header so a test can send the
 * empty list that middleware falls back to when its own query fails.
 */
app.use((req, res, next) => {
  const header = req.headers["x-test-genres"];

  if (typeof header === "string") {
    res.locals.gameGenres = JSON.parse(header);
  }

  next();
});

app.use("/games", gamesRouter);

// Error handling middleware - must be after routes
app.use((err: any, req: any, res: any, next: any) => {
  // Errors a test asked for are not worth a stack trace: the run would be
  // buried in the failures it deliberately provoked. Anything else still
  // prints, which is what this handler was here for.
  if (!err?.expected) {
    console.error("Test error:", err);
  }

  // "Internal server error", not err.message: the routes no longer write
  // their own 500 bodies, so what a client sees is whatever the app's error
  // handler sends — and that never leaks an exception's text (see app.ts).
  res.status(500).json({ error: "Internal server error" });
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

afterAll(() => {
  server.close();
});

describe("Games Routes", () => {
  beforeEach(async () => {
    // One statement, the way tests/setup.ts does it: a DELETE per table in
    // hand-kept dependency order and an ALTER SEQUENCE each is the pattern
    // the global cleanup replaced, and a table added later was missed here.
    //
    // "rate_limits" too. RESTART IDENTITY gives every test a game 1, and the
    // play and rating budgets are counted per address *per game* — so without
    // it the plays and votes of every earlier test were spent against the
    // same "127.0.0.1:1" and a later test met a 429 it had not earned.
    await pool.query(
      'TRUNCATE "comments", "ratings", "plays", "game_of_the_week", "games", "news", "users", "rate_limits" RESTART IDENTITY CASCADE',
    );

    // Create test user
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4)',
      [1, "admin@test.com", "hashedpassword", "ADMIN"],
    );
  });

  // The failure paths below stand a model method up as a rejection. Left in
  // place it would be the model every later test in the file talks to.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /games/new", () => {
    it("should render new game form for admin", async () => {
      const response = await request(server).get("/games/new");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/new-game");
      expect(response.body.locals.game).toBeNull();
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
    });
  });

  describe("POST /games", () => {
    it("should create game with valid data", async () => {
      const gameData = {
        title: "Test Game",
        description: "Test Description",
        genre: "ACTION",
        developer: "Test Developer",
        publisher: "Test Publisher",
        release: 1990,
        // Paths from the site's root. "image1.jpg", "test-stream" and
        // "test-manual" were accepted once and are refused now: an address
        // with no leading slash resolves against whichever page prints it —
        // see NOT_A_SITE_PATH in tests/validations/games.test.ts.
        images: ["/images/image1.jpg", "/images/image2.jpg"],
        stream: "/streams/test.jsdos",
        manual: "/manuals/test.pdf",
      };

      const response = await request(server).post("/games").send(gameData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");

      // Verify that game was created in database
      const result = await pool.query(
        'SELECT * FROM "games" WHERE "title" = $1',
        [gameData.title],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe(gameData.title);
      expect(result.rows[0].description).toBe(gameData.description);
      expect(result.rows[0].genre).toBe(gameData.genre);
      expect(result.rows[0].slug).toBe("test-game");
    });

    /**
     * The two values validateGame used to pass and the column behind it then
     * refuse — the 500 page, admin's entry gone, which is the very failure
     * the validator was written to prevent. Both are checked here rather than
     * only at the model, because the route is where an admin meets them.
     */
    it("should accept a form that leaves the release year blank", async () => {
      const response = await request(server).post("/games").send({
        title: "No Year Recorded",
        genre: "ACTION",
        release: "   ",
      });

      expect(response.status).toBe(302);

      const { rows } = await pool.query(
        'SELECT "release" FROM "games" WHERE "title" = $1',
        ["No Year Recorded"],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].release).toBeNull();
    });

    it("should store a lower-case genre in the case the enum holds", async () => {
      const response = await request(server).post("/games").send({
        title: "Lower Case Genre",
        genre: "action",
      });

      expect(response.status).toBe(302);

      const { rows } = await pool.query(
        'SELECT "genre" FROM "games" WHERE "title" = $1',
        ["Lower Case Genre"],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].genre).toBe("ACTION");
    });

    // Postgres trims only the trailing spaces on a varchar cast, so the
    // leading ones used to survive into the column: the title rendered with
    // the gap and sorted ahead of the whole catalogue in findAdjacentGames.
    it("should store the title trimmed", async () => {
      const response = await request(server)
        .post("/games")
        .send({ title: "  Padded Title  ", genre: "ACTION" });

      expect(response.status).toBe(302);

      const { rows } = await pool.query(
        `SELECT "title" FROM "games" WHERE "slug" = 'padded-title'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Padded Title");
    });

    // A rejected save used to reach Game.create, throw out of validate() and
    // arrive as the 500 page with the admin's entry gone. It comes back as
    // the form now, carrying both the reason and what they typed.
    it("should re-render the form with errors for invalid data", async () => {
      const invalidGameData = {
        title: "", // Missing required title
        description: "Test Description",
      };

      const response = await request(server).post("/games").send(invalidGameData);

      // 422, not 200: a form that came back covered in errors did not
      // succeed, and a 200 is what a browser, a password manager and an
      // access log all read as "that worked".
      expect(response.status).toBe(422);
      expect(response.body.view).toBe("games/new-game");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "title", message: "Title is required" }),
          expect.objectContaining({ field: "genre" }),
        ]),
      );
      // The description survives, so the admin does not retype it.
      expect(response.body.locals.formData.description).toBe(
        "Test Description",
      );

      // Verify that no game was created in database
      const result = await pool.query('SELECT COUNT(*) as count FROM "games"');
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should reject a javascript: address in an image field", async () => {
      const response = await request(server)
        .post("/games")
        .send({
          title: "Test Game",
          genre: "ACTION",
          images: ["javascript:alert(1)"],
        });

      expect(response.status).toBe(422);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "images" })]),
      );

      const result = await pool.query('SELECT COUNT(*) as count FROM "games"');
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should reject an implausible release year", async () => {
      const response = await request(server)
        .post("/games")
        .send({ title: "Test Game", genre: "ACTION", release: "19993" });

      expect(response.status).toBe(422);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "release" })]),
      );
    });

    it("should reject a genre outside the enum", async () => {
      const response = await request(server)
        .post("/games")
        .send({ title: "Test Game", genre: "NOT_A_GENRE" });

      expect(response.status).toBe(422);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "genre", message: "Unknown genre" }),
        ]),
      );
    });
  });

  describe("GET /games/:id/edit", () => {
    it("should render edit form for existing game", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(server).get(`/games/${gameId}/edit`);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/edit-game");
      expect(response.body.locals.game.title).toBe("Test Game");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
    });

    it("should return 404 for non-existent game", async () => {
      const response = await request(server).get("/games/999/edit");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /games/:id", () => {
    it("should update existing game", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer", "publisher", "release", "images", "stream", "manual") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING "id"',
        [
          "Original Title",
          "original-title",
          "Original Description",
          "ACTION",
          "Original Developer",
          "Original Publisher",
          1990,
          ["image1.jpg"],
          "original-stream",
          "original-manual",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const updatedData = {
        title: "Updated Title",
        description: "Updated Description",
        genre: "STRATEGY",
        developer: "Updated Developer",
        publisher: "Updated Publisher",
        release: 1995,
        // Paths from the site's root, for the reason given on the create test.
        images: ["/images/updated1.jpg", "/images/updated2.jpg"],
        stream: "/streams/updated.jsdos",
        manual: "/manuals/updated.pdf",
      };

      const response = await request(server)
        .post(`/games/${gameId}`)
        .send(updatedData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");

      // Verify that game was updated in database
      const result = await pool.query('SELECT * FROM "games" WHERE "id" = $1', [
        gameId,
      ]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe(updatedData.title);
      expect(result.rows[0].description).toBe(updatedData.description);
      expect(result.rows[0].genre).toBe(updatedData.genre);
      expect(result.rows[0].slug).toBe("updated-title");
    });

    it("should return 404 for non-existent game", async () => {
      const updatedData = {
        title: "Updated Title",
        description: "Updated Description",
        genre: "STRATEGY",
        developer: "Updated Developer",
      };

      const response = await request(server).post("/games/999").send(updatedData);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /games/:id/delete", () => {
    it("should delete existing game", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(server).post(`/games/${gameId}/delete`);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");

      // Verify that game was deleted from database
      const result = await pool.query('SELECT * FROM "games" WHERE "id" = $1', [
        gameId,
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it("should handle deletion of non-existent game", async () => {
      const response = await request(server).post("/games/999/delete");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });
  });

  describe("POST /games/:id/rate", () => {
    it("should rate a game successfully", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(server)
        .post(`/games/${gameId}/rate`)
        .send({ rating: "5" });

      expect(response.status).toBe(200);
      expect(response.body.averageRating).toBe(5);
      expect(response.body.ratingCount).toBe(1);
      expect(response.body.userRating).toBe(5);

      // Verify that rating was created in database
      const result = await pool.query(
        'SELECT * FROM "ratings" WHERE "gameId" = $1',
        [gameId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].rating).toBe(5);
      expect(result.rows[0].ipAddress).toBe("127.0.0.1");
      expect(result.rows[0].voterId).toBeTruthy();
    });

    it("should update the existing rating when the same visitor votes again", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      // An agent keeps the voter-id cookie, so both votes come from the
      // same "browser".
      const agent = request.agent(app);

      await agent.post(`/games/${gameId}/rate`).send({ rating: "3" });

      const response = await agent
        .post(`/games/${gameId}/rate`)
        .send({ rating: "5" });

      expect(response.status).toBe(200);
      expect(response.body.averageRating).toBe(5);
      expect(response.body.ratingCount).toBe(1);

      // Verify that only one rating exists and it's updated
      const result = await pool.query(
        'SELECT * FROM "ratings" WHERE "gameId" = $1',
        [gameId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].rating).toBe(5);
    });

    it("should keep votes separate for different visitors on the same IP", async () => {
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      // Two independent requests get two different voter-id cookies, the way
      // two people behind one NAT would.
      await request(server).post(`/games/${gameId}/rate`).send({ rating: "1" });
      await request(server).post(`/games/${gameId}/rate`).send({ rating: "5" });

      const result = await pool.query(
        'SELECT * FROM "ratings" WHERE "gameId" = $1',
        [gameId],
      );
      expect(result.rows).toHaveLength(2);
    });

    it("should validate rating range", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(server)
        .post(`/games/${gameId}/rate`)
        .send({ rating: "6" }); // Invalid rating

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Rating must be between 1 and 5");

      // Verify that no rating was created
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "ratings" WHERE "gameId" = $1',
        [gameId],
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should return 404 when rating a game that does not exist", async () => {
      const response = await request(server)
        .post("/games/999/rate")
        .send({ rating: "5" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Game not found");
    });

    // The id was validated with parseInt, which reads "5abc" as 5 — so the
    // check passed and the raw string reached Postgres as a bad integer,
    // answering with a 500 rather than refusing the request.
    it("should return 400 for a game id with trailing rubbish", async () => {
      for (const id of ["5abc", "1.5", "1%20OR%201=1"]) {
        const response = await request(server)
          .post(`/games/${id}/rate`)
          .send({ rating: "5" });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("Invalid game ID");
      }
    });
  });

  describe("POST /games/:id/play", () => {
    it("should record a play and return 204", async () => {
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(server).post(`/games/${gameId}/play`);

      expect(response.status).toBe(204);

      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "plays" WHERE "gameId" = $1',
        [gameId],
      );
      expect(parseInt(result.rows[0].count)).toBe(1);
    });

    it("should record multiple plays for the same game", async () => {
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ],
      );
      const gameId = gameResult.rows[0].id;

      await request(server).post(`/games/${gameId}/play`);
      await request(server).post(`/games/${gameId}/play`);
      await request(server).post(`/games/${gameId}/play`);

      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "plays" WHERE "gameId" = $1',
        [gameId],
      );
      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    it("should return 404 for non-existent game", async () => {
      const response = await request(server).post("/games/99999/play");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Game not found");
    });

    it("should return 400 for a non-numeric game id", async () => {
      const response = await request(server).post("/games/abc/play");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid game ID");
    });
  });

  describe("GET /games/collection", () => {
    async function seedGame(title: string, slug: string) {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre","developer","images") VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"',
        [title, slug, "<p>A <b>great</b> game.</p>", "ACTION", "Dev", ["a.jpg"]],
      );
      return rows[0].id;
    }

    it("returns the games for the given ids", async () => {
      const id = await seedGame("Doom", "doom");

      const response = await request(server).get(`/games/collection?ids=${id}`);

      expect(response.status).toBe(200);
      expect(response.body.games).toHaveLength(1);
      expect(response.body.games[0].title).toBe("Doom");
      expect(response.body.games[0].slug).toBe("doom");
      expect(response.body.games[0].image).toBe("a.jpg");
    });

    it("strips HTML out of the description", async () => {
      const id = await seedGame("Doom", "doom");

      const response = await request(server).get(`/games/collection?ids=${id}`);

      expect(response.body.games[0].description).toBe("A great game.");
    });

    it("decodes the entities the stored description holds", async () => {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre","developer","images") VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"',
        [
          "Sam & Max",
          "sam-max",
          // What Game.serialize stores: DOMPurify escapes the ampersand.
          "<p>Sam &amp; Max hit the road.</p>",
          "ADVENTURE",
          "LucasArts",
          ["a.jpg"],
        ],
      );

      const response = await request(server).get(
        `/games/collection?ids=${rows[0].id}`,
      );

      // The cards print this straight at the reader, so an entity left in
      // place showed up as the literal text "&amp;".
      expect(response.body.games[0].description).toBe("Sam & Max hit the road.");
    });

    it("silently omits ids that no longer exist", async () => {
      const id = await seedGame("Doom", "doom");

      const response = await request(server).get(
        `/games/collection?ids=${id},999999`,
      );

      expect(response.status).toBe(200);
      expect(response.body.games).toHaveLength(1);
    });

    it("returns an empty list for a missing or junk ids parameter", async () => {
      expect((await request(server).get("/games/collection")).body.games).toEqual(
        [],
      );
      expect(
        (await request(server).get("/games/collection?ids=abc,,-1")).body.games,
      ).toEqual([]);
    });
  });

  describe("GET /games/my-ratings", () => {
    it("returns nothing for a browser that has never voted", async () => {
      const response = await request(server).get("/games/my-ratings");

      expect(response.status).toBe(200);
      expect(response.body.ratings).toEqual({});
    });

    it("returns this browser's own votes", async () => {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre","developer") VALUES ($1,$2,$3,$4,$5) RETURNING "id"',
        ["Doom", "doom", "d", "ACTION", "id"],
      );
      const gameId = rows[0].id;
      const agent = request.agent(app);

      await agent.post(`/games/${gameId}/rate`).send({ rating: "4" });

      const response = await agent.get("/games/my-ratings");

      expect(response.body.ratings[gameId]).toBe(4);
    });

    it("does not leak another browser's votes", async () => {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre","developer") VALUES ($1,$2,$3,$4,$5) RETURNING "id"',
        ["Doom", "doom", "d", "ACTION", "id"],
      );

      await request(server).post(`/games/${rows[0].id}/rate`).send({ rating: "4" });

      const response = await request(server).get("/games/my-ratings");

      expect(response.body.ratings).toEqual({});
    });
  });

  /**
   * The allowlist the two admin forms validate a posted genre against.
   *
   * genreList() prefers the copy sidebarData leaves on res.locals and falls
   * back to a query. Which of the two it used was never asserted, and the
   * fallback could not run at all — see the first test.
   */
  describe("the genre allowlist the form is validated against", () => {
    it("queries for the list when the cached one is empty", async () => {
      // What sidebarData leaves behind when its own getGenres() failed: the
      // entry's fallback, which is [] and not undefined. Read with `??` that
      // counts as a hit, so the query behind it never ran and a valid genre
      // came back "Unknown genre" — with the form's own dropdown empty.
      const response = await request(server)
        .post("/games")
        .set("x-test-genres", "[]")
        .send({ title: "Fallback Game", genre: "ACTION" });

      expect(response.status).toBe(302);

      const { rows } = await pool.query('SELECT "genre" FROM "games"');
      expect(rows).toHaveLength(1);
      expect(rows[0].genre).toBe("ACTION");
    });

    it("spends no query when the cached list has entries", async () => {
      const getGenres = vi.spyOn(Game, "getGenres");

      const response = await request(server)
        .post("/games")
        .set("x-test-genres", JSON.stringify(["ACTION"]))
        .send({ title: "Cached Game", genre: "ACTION" });

      expect(response.status).toBe(302);
      expect(getGenres).not.toHaveBeenCalled();
    });

    it("refuses a genre the cached list does not carry", async () => {
      const response = await request(server)
        .post("/games")
        .set("x-test-genres", JSON.stringify(["ACTION"]))
        .send({ title: "Wrong Genre", genre: "STRATEGY" });

      expect(response.status).toBe(422);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "genre", message: "Unknown genre" }),
        ]),
      );
    });
  });

  /**
   * next(), so the app's own 404 view answers — rather than the id travelling
   * on to Postgres as a failed integer cast, which is a 500.
   */
  describe("a game id that is not a number", () => {
    it("falls through to 404 on the edit form", async () => {
      const response = await request(server).get("/games/abc/edit");

      expect(response.status).toBe(404);
    });

    it("falls through to 404 on update", async () => {
      const response = await request(server)
        .post("/games/abc")
        .send({ title: "Test Game", genre: "ACTION" });

      expect(response.status).toBe(404);
    });

    it("falls through to 404 on delete", async () => {
      const response = await request(server).post("/games/abc/delete");

      expect(response.status).toBe(404);
    });
  });

  /**
   * The edit form's own refusal path. The create form's was covered; this one
   * has two steps create does not — it re-reads the game to render the form
   * around, and gives up if that game has gone.
   */
  describe("POST /games/:id with invalid data", () => {
    it("re-renders the edit form with the admin's own values", async () => {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre") VALUES ($1,$2,$3,$4) RETURNING "id"',
        ["Original Title", "original-title", "Original Description", "ACTION"],
      );
      const gameId = rows[0].id;

      const response = await request(server).post(`/games/${gameId}`).send({
        title: "",
        genre: "ACTION",
        description: "Edited Description",
      });

      expect(response.status).toBe(422);
      expect(response.body.view).toBe("games/edit-game");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "title",
            message: "Title is required",
          }),
        ]),
      );
      // The stored game still goes over, because the form's action is built
      // from its id — but the edit is what refills the fields, so the admin
      // does not get their work replaced by what the database still holds.
      expect(response.body.locals.game.id).toBe(gameId);
      expect(response.body.locals.formData.description).toBe(
        "Edited Description",
      );

      const after = await pool.query(
        'SELECT "title" FROM "games" WHERE "id" = $1',
        [gameId],
      );
      expect(after.rows[0].title).toBe("Original Title");
    });

    it("404s when the game went away while the form was open", async () => {
      // Invalid data *and* no such game: the refusal path re-reads the game to
      // render around and finds nothing, which is the 404 rather than a form
      // rendered around an undefined game.
      const response = await request(server)
        .post("/games/999")
        .send({ title: "", genre: "ACTION" });

      expect(response.status).toBe(404);
    });
  });

  /**
   * What each route does when the model throws. The admin form posts hand the
   * error on and let the app's 500 view answer; everything a fetch() calls
   * answers in JSON, because that is what the client can read.
   */
  describe("when a model call fails", () => {
    it("hands a failed create to the error handler", async () => {
      vi.spyOn(Game, "create").mockRejectedValue(provoked("create failed"));

      const response = await request(server)
        .post("/games")
        .send({ title: "Test Game", genre: "ACTION" });

      expect(response.status).toBe(500);
    });

    it("hands a failed update to the error handler", async () => {
      const { rows } = await pool.query(
        'INSERT INTO "games" ("title","slug","description","genre") VALUES ($1,$2,$3,$4) RETURNING "id"',
        ["Test Game", "test-game", "Test Description", "ACTION"],
      );

      vi.spyOn(Game, "update").mockRejectedValue(provoked("update failed"));

      const response = await request(server)
        .post(`/games/${rows[0].id}`)
        .send({ title: "Updated Title", genre: "ACTION" });

      expect(response.status).toBe(500);
    });

    it("hands a failed delete to the error handler", async () => {
      vi.spyOn(Game, "delete").mockRejectedValue(provoked("delete failed"));

      const response = await request(server).post("/games/1/delete");

      expect(response.status).toBe(500);
    });

    it("answers the collection endpoint 500 in JSON", async () => {
      vi.spyOn(Game, "findByIds").mockRejectedValue(
        provoked("collection failed"),
      );

      const response = await request(server).get("/games/collection?ids=1,2");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });

    it("answers the voter's own ratings 500 in JSON", async () => {
      vi.spyOn(Game, "getVoterRatings").mockRejectedValue(
        provoked("ratings failed"),
      );

      const response = await request(server).get("/games/my-ratings");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });

    it("answers a rating that cannot be saved 500 in JSON", async () => {
      // A plain error, not the foreign-key violation a deleted game raises —
      // that one is the 404 the suite already covers.
      vi.spyOn(Game, "rate").mockRejectedValue(provoked("rate failed"));

      const response = await request(server)
        .post("/games/1/rate")
        .send({ rating: "4" });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });

    it("answers a play that cannot be recorded 500 in JSON", async () => {
      vi.spyOn(Game, "recordPlay").mockRejectedValue(provoked("play failed"));

      const response = await request(server).post("/games/1/play");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    });
  });

  /**
   * A browser that refuses the voter cookie. The middleware issues one on
   * every request, so these two branches are only reachable with it taken
   * back off again — see the header in the harness above.
   */
  describe("a browser with no voter id", () => {
    it("is given an empty rating map rather than an error", async () => {
      const response = await request(server)
        .get("/games/my-ratings")
        .set("x-test-no-voter", "1");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ratings: {} });
    });

    it("is told why it cannot rate", async () => {
      const response = await request(server)
        .post("/games/1/rate")
        .set("x-test-no-voter", "1")
        .send({ rating: "4" });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "Cookies are required to rate games",
      });
    });

    /**
     * And refused *before* the limiter counts it.
     *
     * The check used to live inside the handler, which put it after
     * ratingLimiter — so a browser with cookies off, or a script that never
     * sends one, spent one of the fifty ratings per quarter hour on every
     * attempt while none of them could ever be stored. Fifty of those and the
     * address was out of budget, taking every real voter behind the same NAT
     * with it. requireVoterId sits ahead of the limiter now, for the same
     * reason requireGameId sits ahead of the play limiter.
     *
     * Proved through a positive case rather than a sleep: a second request
     * that *does* carry an id reaches the limiter, and the counter standing at
     * one — with the refused attempt sent first and answered first — is the
     * assertion. It is a 404, because game 999999 does not exist, which is
     * past the limiter and therefore counted.
     */
    it("is refused before the limiter has counted the attempt", async () => {
      await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'rate:%'`);

      const refused = await request(server)
        .post("/games/1/rate")
        .set("x-test-no-voter", "1")
        .send({ rating: "4" });

      expect(refused.status).toBe(400);

      const counted = await request(server)
        .post("/games/999999/rate")
        .send({ rating: "4" });

      expect(counted.status).toBe(404);

      const { rows } = await pool.query(
        `SELECT COALESCE(SUM("hits"), 0)::int AS hits FROM "rate_limits"
          WHERE "key" LIKE 'rate:%' AND "expiresAt" > NOW()`,
      );

      expect(rows[0].hits).toBe(1);

      await pool.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'rate:%'`);
    });
  });

  it("defaults the rating figures on a game that reached the route unhydrated", async () => {
    // findByIds fills both in on every row it builds, so this is the route's
    // guard rather than something the model can produce today. It is asserted
    // because the alternative is a card rendering "undefined" stars.
    vi.spyOn(Game, "findByIds").mockResolvedValue([
      { id: 7, title: "Bare", slug: "bare", genre: "ACTION" },
    ] as any);

    const response = await request(server).get("/games/collection?ids=7");

    expect(response.status).toBe(200);
    expect(response.body.games[0]).toMatchObject({
      id: 7,
      averageRating: 0,
      ratingCount: 0,
    });
  });

  /**
   * Plays and votes counted per address *and per game*, on top of the flood
   * brakes each endpoint already had.
   *
   * Those brakes are per address across every game, and generous on purpose
   * — thirty plays a minute, fifty ratings a quarter hour — so one client
   * could spend all of it on one game: ~43,000 plays a day, enough to own
   * /most-played, and ~4,800 votes a day by dropping the voter cookie between
   * them, which swamps the five votes of doubt the ranking weighs every game
   * with. See PLAYS_PER_GAME and RATINGS_PER_GAME in routes/games.ts.
   */
  describe("one address, one game, one day", () => {
    async function seedGame(slug: string): Promise<number> {
      const { rows } = await pool.query(
        // Two parameters for one value: "title" is VARCHAR and "slug" is TEXT,
        // and Postgres will not deduce one type for a parameter used as both.
        `INSERT INTO "games" ("title", "slug", "genre") VALUES ($1, $2, 'ACTION')
         RETURNING "id"`,
        [slug, slug],
      );

      return rows[0].id as number;
    }

    const play = (gameId: number, ip = "127.0.0.1") =>
      request(server).post(`/games/${gameId}/play`).set("x-test-ip", ip);

    // A fresh request is a fresh voter cookie (see the middleware at the
    // top), which is exactly the client that drops its cookie between votes.
    const rate = (gameId: number, ip = "127.0.0.1") =>
      request(server)
        .post(`/games/${gameId}/rate`)
        .set("x-test-ip", ip)
        .send({ rating: 5 });

    async function count(table: "plays" | "ratings", gameId: number) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "gameId" = $1`,
        [gameId],
      );

      return rows[0].n as number;
    }

    it("counts a handful of plays of one game from one address, then stops", async () => {
      const gameId = await seedGame("doom");

      for (let n = 0; n < PLAYS_PER_GAME; n++) {
        expect((await play(gameId)).status).toBe(204);
      }

      const refused = await play(gameId);

      expect(refused.status).toBe(429);
      // JSON, like every other answer this endpoint gives.
      expect(refused.body.error).toEqual(expect.any(String));
      expect(await count("plays", gameId)).toBe(PLAYS_PER_GAME);
    });

    it("counts the same address's other games, and other addresses, apart", async () => {
      const doom = await seedGame("doom");
      const quake = await seedGame("quake");

      for (let n = 0; n < PLAYS_PER_GAME; n++) await play(doom);

      expect((await play(doom)).status).toBe(429);
      expect((await play(quake)).status).toBe(204);
      expect((await play(doom, "203.0.113.9")).status).toBe(204);
    });

    it("counts votes on one game from one address, however many cookies they carry", async () => {
      const gameId = await seedGame("doom");

      for (let n = 0; n < RATINGS_PER_GAME; n++) {
        expect((await rate(gameId)).status).toBe(200);
      }

      const refused = await rate(gameId);

      expect(refused.status).toBe(429);
      // rating-stars.js shows the visitor `error` out of the JSON body.
      expect(refused.body.error).toEqual(expect.any(String));
      expect(await count("ratings", gameId)).toBe(RATINGS_PER_GAME);

      // Another game, and another address, have budgets of their own.
      expect((await rate(await seedGame("quake"))).status).toBe(200);
      expect((await rate(gameId, "203.0.113.9")).status).toBe(200);
    });

    /**
     * One IPv6 client is handed a whole range by its provider, so keying on
     * the exact address would give it a fresh budget per address it cares to
     * source from. ipKeyGenerator collapses one to its /56, as the
     * address-wide limiters on these two routes already do.
     */
    it("counts an IPv6 range as one address", async () => {
      const gameId = await seedGame("doom");

      // 2001:db8:abcd:1200::/56 holds 1200 to 12ff in the fourth group.
      for (let n = 0; n < PLAYS_PER_GAME; n++) {
        await play(gameId, `2001:db8:abcd:120${n}::1`);
      }

      expect((await play(gameId, "2001:db8:abcd:12ff::7")).status).toBe(429);
      // And the next /56 along is somebody else.
      expect((await play(gameId, "2001:db8:abcd:1300::1")).status).toBe(204);
    });

    // The privacy policy states how long this key keeps an address, so what
    // the key holds and how long it lasts are pinned here.
    it("keys the count by the address and the game, for a day", async () => {
      const gameId = await seedGame("doom");

      await play(gameId);
      await rate(gameId);

      const { rows } = await pool.query(
        `SELECT "key", EXTRACT(EPOCH FROM ("expiresAt" - NOW()))::int AS "secondsLeft"
           FROM "rate_limits" WHERE "key" LIKE '%-game:%' ORDER BY "key"`,
      );

      expect(rows.map((row) => row.key)).toEqual([
        `play-game:127.0.0.1:${gameId}`,
        `rate-game:127.0.0.1:${gameId}`,
      ]);

      for (const row of rows) {
        expect(row.secondsLeft).toBeGreaterThan(PER_GAME_WINDOW_MS / 1000 - 60);
        expect(row.secondsLeft).toBeLessThanOrEqual(PER_GAME_WINDOW_MS / 1000);
      }
    });

    /**
     * "Deleted within 25 minutes" was the whole of what the policy said about
     * a rate-limit counter, and a key that holds an address for a day would
     * have made it untrue. The window is read off the constant the limiters
     * use, and the policy has to name it.
     */
    it("is a window the privacy policy states", () => {
      const policy = readFileSync(path.join(VIEWS, "privacy-policy.ejs"), "utf8");
      const hours = PER_GAME_WINDOW_MS / (60 * 60 * 1000);

      expect(hours).toBe(24);
      expect(policy).toContain(`${hours} hours and 10 minutes`);
    });
  });

  /**
   * The form drew exactly four image inputs, and validateGame stores the
   * posted array as it arrives — so saving any edit of a game with more than
   * four images, even one that changed nothing, deleted the fifth onwards.
   * Six went in, four came back.
   *
   * These render the real template: the router's res.render is stubbed to
   * JSON above, so the locals it would have rendered with are taken from that
   * and handed to views/games/game-form.ejs directly.
   */
  describe("the edit form and a game's images", () => {
    const SIX = [1, 2, 3, 4, 5, 6].map((n) => `/images/doom-${n}.png`);

    function renderForm(locals: Record<string, unknown>): Promise<string> {
      return ejs.renderFile(
        path.join(VIEWS, "games", "game-form.ejs"),
        { gameGenres: ["ACTION"], csrfToken: "t", ...locals },
        { root: VIEWS, views: [VIEWS] },
      );
    }

    const imageInputs = (html: string) => [
      ...new JSDOM(html).window.document.querySelectorAll<HTMLInputElement>(
        'input[name="images"]',
      ),
    ];

    async function insertGame(images: string[]): Promise<number> {
      const { rows } = await pool.query(
        `INSERT INTO "games" ("title", "slug", "genre", "images")
         VALUES ('Doom', 'doom', 'ACTION', $1) RETURNING "id"`,
        [images],
      );

      return rows[0].id as number;
    }

    it("keeps every image through an unchanged save", async () => {
      const id = await insertGame(SIX);

      const edit = await request(server).get(`/games/${id}/edit`);
      const html = await renderForm({ game: edit.body.locals.game });

      // What the browser would post: every named control, in document order.
      const { window } = new JSDOM(html);
      const form = window.document.querySelector("form")!;
      const body = new URLSearchParams(
        [...new window.FormData(form).entries()].map(
          ([name, value]) => [name, String(value)] as [string, string],
        ),
      );

      const saved = await request(server)
        .post(`/games/${id}`)
        .type("form")
        .send(body.toString());

      expect(saved.status).toBe(302);

      const { rows } = await pool.query(
        'SELECT "images" FROM "games" WHERE "id" = $1',
        [id],
      );

      expect((rows[0].images as string[]).filter(Boolean)).toEqual(SIX);
    });

    it("draws one input per stored image, a spare, and labels them all", async () => {
      const inputs = imageInputs(await renderForm({ game: { id: 1, images: SIX } }));

      expect(inputs.map((input) => input.value)).toEqual([...SIX, ""]);

      const document = new JSDOM(
        await renderForm({ game: { id: 1, images: SIX } }),
      ).window.document;
      const labels = inputs.map(
        (input) => document.querySelector(`label[for="${input.id}"]`)?.textContent,
      );

      expect(labels).toEqual([
        "Cover",
        "Image 1",
        "Image 2",
        "Image 3",
        "Image 4",
        "Image 5",
        "Image 6",
      ]);
      // Distinct ids, or a label would name the wrong field.
      expect(new Set(inputs.map((input) => input.id)).size).toBe(inputs.length);
    });

    // A new game, or one with only a few images, gets the four it always did.
    it("never draws fewer than four", async () => {
      expect(imageInputs(await renderForm({ game: null }))).toHaveLength(4);
      expect(
        imageInputs(await renderForm({ game: { id: 1, images: ["/a.png"] } })),
      ).toHaveLength(4);
      expect(
        imageInputs(await renderForm({ game: { id: 1, images: SIX.slice(0, 4) } })),
      ).toHaveLength(5);
    });

    /**
     * The spare is posted back blank and stored as a trailing "" (the cover
     * getter and every listing skip it). Counted from the last *filled* slot,
     * or each save would add one more empty input than the last.
     */
    it("does not grow by a spare on every save", async () => {
      const inputs = imageInputs(
        await renderForm({ game: { id: 1, images: [...SIX, "", ""] } }),
      );

      expect(inputs).toHaveLength(7);
    });

    // A refused save is re-rendered from what was posted, including the spare
    // the admin may have filled in, and every input carries the error.
    it("marks every input when the images were refused", async () => {
      const posted = [...SIX, "javascript:alert(1)"];
      const html = await renderForm({
        game: { id: 1, images: SIX },
        formData: { images: posted },
        errors: [{ field: "images", message: "Refused" }],
      });
      const inputs = imageInputs(html);
      const document = new JSDOM(html).window.document;

      expect(inputs.map((input) => input.value)).toEqual([...posted, ""]);
      expect(document.getElementById("images-error")?.textContent?.trim()).toBe(
        "Refused",
      );

      for (const input of inputs) {
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.getAttribute("aria-describedby")).toBe("images-error");
        expect(input.className).toContain("is-invalid");
      }
    });
  });
});
