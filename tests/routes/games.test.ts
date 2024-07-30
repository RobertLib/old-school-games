import { beforeEach, describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import gamesRouter from "../../routes/games.ts";

const app = express();

// Test setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mock middleware for authentication and admin role - simple without session
app.use((req, res, next) => {
  // Simulate logged in admin user - simple object without session touch
  req.session = {
    user: {
      id: 1,
      email: "admin@test.com",
      role: "ADMIN",
    },
  } as any;
  next();
});

// Setup view engine
app.set("view engine", "ejs");
app.set("views", "views");

// Mock render function
app.use((req, res, next) => {
  const originalRender = res.render;
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

// Mock request IP
app.use((req, res, next) => {
  Object.defineProperty(req, "ip", {
    value: "127.0.0.1",
    writable: true,
    configurable: true,
  });
  next();
});

app.use("/games", gamesRouter);

// Error handling middleware - must be after routes
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Test error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

describe("Games Routes", () => {
  beforeAll(async () => {
    // Ensure database is ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  beforeEach(async () => {
    // Clean tables before each test - in correct order for foreign keys
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "games"');
    await pool.query('DELETE FROM "news"');
    await pool.query('DELETE FROM "users"');

    // Reset auto-increment
    await pool.query('ALTER SEQUENCE "games_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "users_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "comments_id_seq" RESTART WITH 1');

    // Create test user
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4)',
      [1, "admin@test.com", "hashedpassword", "ADMIN"]
    );
  });

  describe("GET /games/new", () => {
    it("should render new game form for admin", async () => {
      const response = await request(app).get("/games/new");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/new-game");
      expect(response.body.locals.game).toBeNull();
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
        images: ["image1.jpg", "image2.jpg"],
        stream: "test-stream",
        manual: "test-manual",
      };

      const response = await request(app).post("/games").send(gameData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");

      // Verify that game was created in database
      const result = await pool.query(
        'SELECT * FROM "games" WHERE "title" = $1',
        [gameData.title]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe(gameData.title);
      expect(result.rows[0].description).toBe(gameData.description);
      expect(result.rows[0].genre).toBe(gameData.genre);
      expect(result.rows[0].slug).toBe("test-game");
    });

    it("should handle validation errors", async () => {
      const invalidGameData = {
        title: "", // Missing required title
        description: "Test Description",
      };

      const response = await request(app).post("/games").send(invalidGameData);

      // Validation error should result in 500 status because Game.create throws an error
      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
      expect(response.body.error).toContain("required");

      // Verify that no game was created in database
      const result = await pool.query('SELECT COUNT(*) as count FROM "games"');
      expect(parseInt(result.rows[0].count)).toBe(0);
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
        ]
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(app).get(`/games/${gameId}/edit`);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("games/edit-game");
      expect(response.body.locals.game.title).toBe("Test Game");
    });

    it("should return 404 for non-existent game", async () => {
      const response = await request(app).get("/games/999/edit");

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
        ]
      );
      const gameId = gameResult.rows[0].id;

      const updatedData = {
        title: "Updated Title",
        description: "Updated Description",
        genre: "STRATEGY",
        developer: "Updated Developer",
        publisher: "Updated Publisher",
        release: 1995,
        images: ["updated1.jpg", "updated2.jpg"],
        stream: "updated-stream",
        manual: "updated-manual",
      };

      const response = await request(app)
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

      const response = await request(app).post("/games/999").send(updatedData);

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
        ]
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(app).post(`/games/${gameId}/delete`);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");

      // Verify that game was deleted from database
      const result = await pool.query('SELECT * FROM "games" WHERE "id" = $1', [
        gameId,
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it("should handle deletion of non-existent game", async () => {
      const response = await request(app).post("/games/999/delete");

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
        ]
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(app)
        .post(`/games/${gameId}/rate`)
        .send({ rating: "5" });

      expect(response.status).toBe(200);
      expect(response.body.averageRating).toBeDefined();

      // Verify that rating was created in database
      const result = await pool.query(
        'SELECT * FROM "ratings" WHERE "gameId" = $1',
        [gameId]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].rating).toBe(5);
      expect(result.rows[0].ipAddress).toBe("127.0.0.1");
    });

    it("should update existing rating for same IP", async () => {
      // Create a test game
      const gameResult = await pool.query(
        'INSERT INTO "games" ("title", "slug", "description", "genre", "developer") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
        [
          "Test Game",
          "test-game",
          "Test Description",
          "ACTION",
          "Test Developer",
        ]
      );
      const gameId = gameResult.rows[0].id;

      // First rating
      await request(app).post(`/games/${gameId}/rate`).send({ rating: "3" });

      // Second rating from same IP
      const response = await request(app)
        .post(`/games/${gameId}/rate`)
        .send({ rating: "5" });

      expect(response.status).toBe(200);
      expect(response.body.averageRating).toBeDefined();

      // Verify that only one rating exists and it's updated
      const result = await pool.query(
        'SELECT * FROM "ratings" WHERE "gameId" = $1',
        [gameId]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].rating).toBe(5);
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
        ]
      );
      const gameId = gameResult.rows[0].id;

      const response = await request(app)
        .post(`/games/${gameId}/rate`)
        .send({ rating: "6" }); // Invalid rating

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Rating must be between 1 and 5");

      // Verify that no rating was created
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "ratings" WHERE "gameId" = $1',
        [gameId]
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle rating non-existent game", async () => {
      const response = await request(app)
        .post("/games/999/rate")
        .send({ rating: "5" });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /games/:id", () => {
    it("should redirect to /:id", async () => {
      const response = await request(app).get("/games/123");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/123");
    });
  });
});
