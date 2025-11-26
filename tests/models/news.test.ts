import { beforeEach, describe, it, expect, beforeAll } from "vitest";
import pool from "../../db.ts";
import News from "../../models/news.ts";

describe("News", () => {
  beforeAll(async () => {
    // Ensure database is ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  beforeEach(async () => {
    // Clean tables before each test - handle foreign keys properly
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "games"');
    await pool.query('DELETE FROM "news"');
    await pool.query('DELETE FROM "users"');

    // Reset auto-increment sequences
    await pool.query('ALTER SEQUENCE "news_id_seq" RESTART WITH 1');
    await pool.query('ALTER SEQUENCE "users_id_seq" RESTART WITH 1');

    // Create test user with explicit ID to avoid conflicts
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET email = $2, password = $3, role = $4',
      [1, "test@example.com", "hashedpassword", "ADMIN"]
    );
  });

  describe("create", () => {
    it("should create a new news item", async () => {
      const newsData = {
        title: "Test News",
        content: "This is a test news content",
        userId: 1,
      };

      const news = await News.create(newsData);

      expect(news).toBeInstanceOf(News);
      expect(news.title).toBe(newsData.title);
      expect(news.content).toBe(newsData.content);
      expect(news.userId).toBe(newsData.userId);
      expect(news.id).toBe(1);
    });
  });

  describe("findAll", () => {
    it("should return empty array when no news exist", async () => {
      const result = await News.findAll();

      expect(result.news).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it("should return paginated news", async () => {
      // Create test data
      await News.create({
        title: "News 1",
        content: "Content 1",
        userId: 1,
      });
      await News.create({
        title: "News 2",
        content: "Content 2",
        userId: 1,
      });
      await News.create({
        title: "News 3",
        content: "Content 3",
        userId: 1,
      });

      const result = await News.findAll({ page: 1, limit: 2 });

      expect(result.news).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.totalPages).toBe(2);
      expect(result.news[0].title).toBe("News 3"); // Most recent first
      expect(result.news[1].title).toBe("News 2");
    });
  });

  describe("findRecent", () => {
    it("should return recent news items", async () => {
      // Create test data
      await News.create({
        title: "Old News",
        content: "Old content",
        userId: 1,
      });
      await News.create({
        title: "Recent News",
        content: "Recent content",
        userId: 1,
      });

      const recentNews = await News.findRecent(1);

      expect(recentNews).toHaveLength(1);
      expect(recentNews[0].title).toBe("Recent News");
    });

    it("should respect the limit parameter", async () => {
      // Create more test data
      for (let i = 1; i <= 5; i++) {
        await News.create({
          title: `News ${i}`,
          content: `Content ${i}`,
          userId: 1,
        });
      }

      const recentNews = await News.findRecent(3);

      expect(recentNews).toHaveLength(3);
      expect(recentNews[0].title).toBe("News 5"); // Most recent first
    });
  });

  describe("findById", () => {
    it("should return news item by id", async () => {
      const createdNews = await News.create({
        title: "Test News",
        content: "Test content",
        userId: 1,
      });

      const foundNews = await News.findById(createdNews.id);

      expect(foundNews).toBeInstanceOf(News);
      expect(foundNews!.id).toBe(createdNews.id);
      expect(foundNews!.title).toBe("Test News");
    });

    it("should return null for non-existent id", async () => {
      const foundNews = await News.findById(999);

      expect(foundNews).toBeNull();
    });
  });

  describe("count", () => {
    it("should return count of news items", async () => {
      // Initially should be 0
      let count = await News.count();
      expect(count).toBe(0);

      // Add some news items
      await News.create({
        title: "News 1",
        content: "Content 1",
        userId: 1,
      });
      await News.create({
        title: "News 2",
        content: "Content 2",
        userId: 1,
      });

      count = await News.count();
      expect(count).toBe(2);
    });
  });
});
