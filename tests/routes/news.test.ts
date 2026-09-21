import { beforeEach, describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../db.ts";
import News from "../../models/news.ts";
import newsRoutes from "../../routes/news.ts";
import {
  HEADLINE_MAX,
  LD_TEXT_MAX,
  htmlToPlainText,
} from "../../utils/html-text.ts";

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
      [1, "test@example.com", "hashedpassword", "ADMIN"],
    );
  });

  describe("GET /news/new", () => {
    it("should render new news form for admin", async () => {
      const response = await request(server).get("/news/new");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/new-news");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.title).toBe("Add New News - OldSchoolGames");
    });
  });

  describe("POST /news", () => {
    it("should create news item with valid data", async () => {
      const newsData = {
        title: "Test News Title",
        content: "This is test news content",
      };

      const response = await request(server).post("/news").send(newsData);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/news");

      // Verify that news was created in database
      const result = await pool.query(
        'SELECT * FROM "news" WHERE "title" = $1',
        [newsData.title],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].content).toBe(newsData.content);
    });

    it("should return validation errors for invalid data", async () => {
      const invalidData = {
        title: "", // Empty title
        content: "", // Empty content
      };

      const response = await request(server).post("/news").send(invalidData);

      // 422, not 200: a form that came back covered in errors did not
      // succeed. Matches the game forms — see routes/games.ts.
      expect(response.status).toBe(422);
      expect(response.body.view).toBe("news/new-news");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.errors).toBeDefined();
      expect(response.body.locals.errors.length).toBeGreaterThan(0);
    });

    it("should sanitize HTML content", async () => {
      const newsData = {
        title: "Test News",
        content: "<p>Safe content</p><script>alert('xss')</script>",
      };

      const response = await request(server).post("/news").send(newsData);

      expect(response.status).toBe(302);

      // Verify that script tag was removed
      const result = await pool.query(
        'SELECT * FROM "news" WHERE "title" = $1',
        [newsData.title],
      );
      expect(result.rows[0].content).toBe("<p>Safe content</p>");
      expect(result.rows[0].content).not.toContain("<script>");
    });
  });

  describe("GET /news", () => {
    it("should return list of news items", async () => {
      // Create test data
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Test News 1", "test-news-1", "Content 1", 1],
      );
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Test News 2", "test-news-2", "Content 2", 1],
      );

      const response = await request(server).get("/news");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/news-list");
      expect(response.body.locals.news).toHaveLength(2);
      expect(response.body.locals.currentPage).toBe(1);
      expect(response.body.locals.total).toBe(2);
    });

    /**
     * views/news/news-list.ejs used to render every item's stored HTML in
     * full, so /news shipped ten whole articles and read all ten out to a
     * screen reader where the page shows a teaser. The list gets plain-text
     * excerpts, the same way routes/home.ts feeds the homepage card.
     */
    it("hands the list plain-text excerpts rather than the articles", async () => {
      const content = `<p>${"Guybrush Threepwood wants to be a mighty pirate. ".repeat(20)}</p>`;

      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Long Article", "long-article", content, 1],
      );

      const response = await request(server).get("/news");
      const [item] = response.body.locals.news;

      expect(item.excerpt).toBeDefined();
      expect(item.excerpt).not.toContain("<p>");
      expect(item.excerpt.length).toBeLessThanOrEqual(241);
      expect(item.excerpt).toContain("Guybrush Threepwood");
    });

    it("leaves a short article whole", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Short", "short", "<p>Two new games today.</p>", 1],
      );

      const response = await request(server).get("/news");

      expect(response.body.locals.news[0].excerpt).toBe("Two new games today.");
    });

    it("should handle pagination", async () => {
      // Create more test data
      for (let i = 1; i <= 15; i++) {
        await pool.query(
          'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
          [`Test News ${i}`, `test-news-${i}`, `Content ${i}`, 1],
        );
      }

      const response = await request(server).get("/news?page=2");

      expect(response.status).toBe(200);
      expect(response.body.locals.currentPage).toBe(2);
      expect(response.body.locals.news).toHaveLength(5); // 15 total, 10 per page, page 2 has 5
      expect(response.body.locals.totalPages).toBe(2);
    });

    it("should default to page 1 with invalid page parameter", async () => {
      const response = await request(server).get("/news?page=invalid");

      expect(response.status).toBe(200);
      expect(response.body.locals.currentPage).toBe(1);
    });

    it("should clamp negative page parameter to page 1", async () => {
      const response = await request(server).get("/news?page=-3");

      expect(response.status).toBe(200);
      expect(response.body.locals.currentPage).toBe(1);
    });

    it("should set canonical URL correctly for first page", async () => {
      const response = await request(server).get("/news");

      expect(response.status).toBe(200);
      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/news",
      );
      expect(response.body.locals.prevPageUrl).toBeUndefined();
    });

    it("should set canonical URL correctly for subsequent pages", async () => {
      // Create more test data
      for (let i = 1; i <= 15; i++) {
        await pool.query(
          'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
          [`Test News ${i}`, `test-news-${i}`, `Content ${i}`, 1],
        );
      }

      const response = await request(server).get("/news?page=2");

      expect(response.status).toBe(200);
      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/news?page=2",
      );
      expect(response.body.locals.prevPageUrl).toBe(
        "https://oldschoolgames.eu/news",
      );
    });
  });

  describe("GET /news/:slug", () => {
    it("should render news detail for valid slug", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Test Article", "test-article", "<p>Content here</p>", 1],
      );

      const response = await request(server).get("/news/test-article");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/news-detail");
      expect(response.body.locals.newsItem.title).toBe("Test Article");
      expect(response.body.locals.canonicalUrl).toBe(
        "https://oldschoolgames.eu/news/test-article",
      );
    });

    /**
     * The Article node's two prose fields, both of which used to be shipped
     * at whatever length the editor happened to write.
     *
     * `headline` was the stored title verbatim while the <title> beside it
     * went through fitTitle — a cap on one half of a pair and none on the
     * other. `description` was a bare `slice`, which cuts mid-word in a field
     * the meta description three lines above it is careful not to.
     *
     * Seeded well past both limits on purpose: a title of ordinary length
     * passes either version of this code, so only an over-long one can tell
     * them apart.
     */
    it("bounds the headline and description of the Article node", async () => {
      const title = `The Secret of Monkey Island ${"Turns Thirty Five ".repeat(8)}Today`;
      const content = `<p>${"Guybrush Threepwood wants to be a mighty pirate. ".repeat(30)}</p>`;

      expect(title.length).toBeGreaterThan(HEADLINE_MAX);
      expect(htmlToPlainText(content).length).toBeGreaterThan(LD_TEXT_MAX);

      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        [title, "long-article", content, 1],
      );

      const { ldJson } = (await request(server).get("/news/long-article")).body
        .locals;

      expect(ldJson.headline.length).toBeLessThanOrEqual(HEADLINE_MAX + 1);
      expect(ldJson.description.length).toBeLessThanOrEqual(LD_TEXT_MAX + 1);

      // On a word boundary, which is the whole point of preferring
      // truncateAtWord to a slice — and the ellipsis is what says the cut
      // happened rather than leaving a sentence that simply stops.
      for (const field of [ldJson.headline, ldJson.description]) {
        expect(field.endsWith("…")).toBe(true);
        expect(field.slice(0, -1)).not.toMatch(/\s$/);
      }

      // The headline still opens with what the article is about, rather than
      // being cut so hard the subject is gone.
      expect(ldJson.headline.startsWith("The Secret of Monkey Island")).toBe(
        true,
      );
    });

    it("should return 404 for non-existent slug", async () => {
      const response = await request(server).get("/news/does-not-exist");

      expect(response.status).toBe(404);
    });

    it("should return 404 for invalid slug characters", async () => {
      const response = await request(server).get("/news/!!invalid!!");

      expect(response.status).toBe(404);
    });

    // Renaming an article used to 404 its published address.
    it("should redirect a renamed article's old address", async () => {
      const created = await News.create({
        title: "Old Headline",
        content: "Content",
        userId: 1,
      });

      await News.update(created.id, {
        title: "New Headline",
        content: "Content",
      });

      const response = await request(server).get("/news/old-headline");

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/news/new-headline");
    });
  });

  describe("GET /news/:id/edit", () => {
    it("should render edit form for existing news item", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Test Article", "test-article", "<p>Content here</p>", 1],
      );

      const response = await request(server).get("/news/1/edit");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("news/edit-news");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.newsItem.title).toBe("Test Article");
    });

    it("should return 404 for non-existent news item", async () => {
      const response = await request(server).get("/news/999/edit");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /news/:id (update)", () => {
    it("should update news item with valid data", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Original Title", "original-title", "Original content", 1],
      );

      const response = await request(server).post("/news/1").send({
        title: "Updated Title",
        content: "Updated content",
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/news/updated-title");

      const result = await pool.query('SELECT * FROM "news" WHERE "id" = 1');
      expect(result.rows[0].title).toBe("Updated Title");
      expect(result.rows[0].slug).toBe("updated-title");
      expect(result.rows[0].content).toBe("Updated content");
    });

    it("should return validation errors for invalid data", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["Original Title", "original-title", "Original content", 1],
      );

      const response = await request(server).post("/news/1").send({
        title: "",
        content: "",
      });

      expect(response.status).toBe(422);
      expect(response.body.view).toBe("news/edit-news");
      // Every admin form render, GET and 422 alike, carries the tag — see
      // ADMIN_FORM_META in routes/games.ts.
      expect(response.body.locals.noindex).toBe(true);
      expect(response.body.locals.errors).toBeDefined();
      expect(response.body.locals.errors.length).toBeGreaterThan(0);
    });

    it("should return 404 for non-existent news item", async () => {
      const response = await request(server).post("/news/999").send({
        title: "Title",
        content: "Content",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /news/:id/delete", () => {
    it("should soft-delete news item and redirect to /news", async () => {
      await pool.query(
        'INSERT INTO "news" ("title", "slug", "content", "userId") VALUES ($1, $2, $3, $4)',
        ["To Delete", "to-delete", "Content", 1],
      );

      const response = await request(server).post("/news/1/delete");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/news");

      const result = await pool.query('SELECT * FROM "news" WHERE "id" = 1');
      expect(result.rows[0].deletedAt).not.toBeNull();
    });
  });
});
