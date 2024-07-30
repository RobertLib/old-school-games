import { beforeEach, describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import newsRoutes from "../../routes/news.ts";

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

app.use("/news", newsRoutes);

describe("News Routes", () => {
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
    await pool.query('ALTER SEQUENCE "news_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "users_id_seq" RESTART WITH 1');

    // Create test user
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4)',
      [1, "test@example.com", "hashedpassword", "ADMIN"]
    );
  });

  describe("GET /news/new", () => {
    it("should render new news form for admin", async () => {
      const response = await request(app).get("/news/new");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/new-news");
      expect(response.body.locals.title).toBe("Add New News");
    });
  });

  describe("POST /news", () => {
    it("should create news item with valid data", async () => {
      const newsData = {
        title: "Test News Title",
        content: "This is test news content",
      };

      const response = await request(app).post("/news").send(newsData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/news");

      // Verify that news was created in database
      const result = await pool.query(
        'SELECT * FROM "news" WHERE "title" = $1',
        [newsData.title]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].content).toBe(newsData.content);
    });

    it("should return validation errors for invalid data", async () => {
      const invalidData = {
        title: "", // Empty title
        content: "", // Empty content
      };

      const response = await request(app).post("/news").send(invalidData);

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/new-news");
      expect(response.body.locals.errors).toBeDefined();
      expect(response.body.locals.errors.length).toBeGreaterThan(0);
    });

    it("should sanitize HTML content", async () => {
      const newsData = {
        title: "Test News",
        content: "<p>Safe content</p><script>alert('xss')</script>",
      };

      const response = await request(app).post("/news").send(newsData);

      expect(response.status).toBe(302);

      // Verify that script tag was removed
      const result = await pool.query(
        'SELECT * FROM "news" WHERE "title" = $1',
        [newsData.title]
      );
      expect(result.rows[0].content).toBe("<p>Safe content</p>");
      expect(result.rows[0].content).not.toContain("<script>");
    });
  });

  describe("GET /news", () => {
    it("should return list of news items", async () => {
      // Create test data
      await pool.query(
        'INSERT INTO "news" ("title", "content", "userId") VALUES ($1, $2, $3)',
        ["Test News 1", "Content 1", 1]
      );
      await pool.query(
        'INSERT INTO "news" ("title", "content", "userId") VALUES ($1, $2, $3)',
        ["Test News 2", "Content 2", 1]
      );

      const response = await request(app).get("/news");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/news-list");
      expect(response.body.locals.news).toHaveLength(2);
      expect(response.body.locals.currentPage).toBe(1);
      expect(response.body.locals.total).toBe(2);
    });

    it("should handle pagination", async () => {
      // Create more test data
      for (let i = 1; i <= 15; i++) {
        await pool.query(
          'INSERT INTO "news" ("title", "content", "userId") VALUES ($1, $2, $3)',
          [`Test News ${i}`, `Content ${i}`, 1]
        );
      }

      const response = await request(app).get("/news?page=2");

      expect(response.status).toBe(200);
      expect(response.body.locals.currentPage).toBe(2);
      expect(response.body.locals.news).toHaveLength(5); // 15 total, 10 per page, page 2 has 5
      expect(response.body.locals.totalPages).toBe(2);
    });

    it("should default to page 1 with invalid page parameter", async () => {
      const response = await request(app).get("/news?page=invalid");

      expect(response.status).toBe(200);
      expect(response.body.locals.currentPage).toBe(1);
    });

    it("should set canonical URL correctly for first page", async () => {
      const response = await request(app).get("/news");

      expect(response.status).toBe(200);
      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/news"
      );
      expect(response.body.locals.prevPageUrl).toBeUndefined();
    });

    it("should set canonical URL correctly for subsequent pages", async () => {
      // Create more test data
      for (let i = 1; i <= 15; i++) {
        await pool.query(
          'INSERT INTO "news" ("title", "content", "userId") VALUES ($1, $2, $3)',
          [`Test News ${i}`, `Content ${i}`, 1]
        );
      }

      const response = await request(app).get("/news?page=2");

      expect(response.status).toBe(200);
      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/news?page=2"
      );
      expect(response.body.locals.prevPageUrl).toBe(
        "https://oldschoolgames.eu/news"
      );
    });
  });
});
