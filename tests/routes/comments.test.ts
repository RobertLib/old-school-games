import { beforeEach, describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import commentsRouter from "../../routes/comments.ts";

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

describe("Comments Routes", () => {
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
    await pool.query('ALTER SEQUENCE "comments_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "games_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "users_id_seq" RESTART WITH 1');

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
      ]
    );
  });

  describe("POST /comments", () => {
    it("should create comment with valid data", async () => {
      const commentData = {
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      };

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");
      expect(response.body.locals.comment).toBeDefined();

      // Verify that comment was created in database
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "content" = $1',
        [commentData.content]
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

      const response = await request(app)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"'
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

      const response = await request(app)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"'
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

      const response = await request(app)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"'
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle validation error for invalid game ID", async () => {
      const invalidCommentData = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "invalid", // Invalid game ID
      };

      const response = await request(app)
        .post("/comments")
        .send(invalidCommentData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"'
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should create comment without nick (anonymous)", async () => {
      const commentData = {
        content: "Anonymous comment",
        gameId: "1",
      };

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");
      expect(response.body.locals.comment).toBeDefined();

      // Verify that comment was created in database
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "content" = $1',
        [commentData.content]
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

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");

      // Verify that comment was created with sanitized content
      const result = await pool.query(
        'SELECT * FROM "comments" WHERE "gameId" = $1',
        [1]
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

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");

      // Verify that no comment was created in database
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM "comments"'
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should handle database errors gracefully", async () => {
      // Create an invalid gameId to trigger database error
      const commentData = {
        nick: "TestUser",
        content: "Valid content",
        gameId: "999999999",
      };

      const response = await request(app).post("/comments").send(commentData);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Failed to create comment");
    });
  });
});
