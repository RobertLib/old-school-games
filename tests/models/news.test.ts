import { beforeEach, describe, it, expect } from "vitest";
import pool from "../../db.ts";
import News from "../../models/news.ts";

describe("News", () => {
  beforeEach(async () => {
    /**
     * One TRUNCATE, for the reasons written out at length in tests/setup.ts.
     *
     * This used to be six DELETEs in hand-maintained foreign-key order
     * followed by two ALTER SEQUENCEs, which is two lists that had to stay in
     * step with each other and with the schema — and a DELETE refused by a
     * foreign key is a cleanup that quietly did not happen, surfacing later as
     * an assertion failing in an unrelated case. CASCADE follows the keys
     * itself and reaches the ones nothing named here at all ("news_slugs",
     * "game_slugs"), and RESTART IDENTITY resets the sequences in the same
     * statement.
     *
     * The 100ms beforeAll sleep that used to sit above this is gone too. It
     * said "ensure database is ready", but nothing about it waited for
     * anything: setup.ts has already connected, truncated and migrated before
     * a line of this file runs, and the first query below would wait for the
     * pool by itself in any case. All it did was add a tenth of a second to
     * the run and imply a race that is not there.
     */
    await pool.query(
      'TRUNCATE "news", "games", "users" RESTART IDENTITY CASCADE',
    );

    // A fixed id, because the cases below reference it. ON CONFLICT is kept
    // rather than needed — the truncation above leaves nothing to conflict
    // with — so that a case which inserts a user of its own cannot break this.
    await pool.query(
      'INSERT INTO "users" ("id", "email", "password", "role") VALUES ($1, $2, $3, $4) ON CONFLICT ("id") DO UPDATE SET "email" = $2, "password" = $3, "role" = $4',
      [1, "test@example.com", "hashedpassword", "ADMIN"],
    );
  });

  // Game descriptions have always been cleaned inside the model; articles
  // relied on routes/news.ts doing it, so News.create stored whatever a
  // direct caller handed it — and three views render this with <%- %>.
  describe("sanitizes stored markup", () => {
    it("strips a script out of a created article", async () => {
      const news = await News.create({
        title: "Payload",
        content: "<p>Safe</p><script>alert(1)</script>",
        userId: 1,
      });

      expect(news.content).toContain("<p>Safe</p>");
      expect(news.content).not.toContain("<script>");
    });

    it("strips a script out of an updated article", async () => {
      const created = await News.create({
        title: "Clean",
        content: "<p>Clean</p>",
        userId: 1,
      });

      const updated = await News.update(created.id, {
        title: "Clean",
        content: "<p>Still</p><script>alert(1)</script>",
      });

      expect(updated!.content).toContain("<p>Still</p>");
      expect(updated!.content).not.toContain("<script>");
    });

    // The route sanitizes before validating lengths, so the model runs over
    // text DOMPurify has already seen. Doing that twice must not creep: an
    // "&" held as "&amp;" would become "&amp;amp;" on the second pass and the
    // reader would see the entity.
    it("leaves already-sanitized markup untouched", async () => {
      const once = "<p>Sam &amp; Max</p>";

      const news = await News.create({
        title: "Idempotent",
        content: once,
        userId: 1,
      });

      expect(news.content).toBe(once);
    });
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
      expect(news.slug).toBe("test-news");
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
      // One page, not none: /news with nothing on it is still page 1 of 1.
      // Math.ceil(0 / limit) is 0, so the view was handed a page number above
      // its own total — which is what paginationUrls clamps for the same
      // reason.
      expect(result.totalPages).toBe(1);
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

  describe("findBySlug", () => {
    it("should return news item by slug", async () => {
      const createdNews = await News.create({
        title: "Test News",
        content: "Test content",
        userId: 1,
      });

      const foundNews = await News.findBySlug(createdNews.slug);

      expect(foundNews).toBeInstanceOf(News);
      expect(foundNews!.slug).toBe("test-news");
      expect(foundNews!.title).toBe("Test News");
    });

    /**
     * news-detail.ejs prints the content with <%- %>. create() and update()
     * sanitise what they write; an article that never went through them was
     * printed as stored, so the lookup the page renders from cleans it too.
     */
    it("sanitises an article that was stored without going through the model", async () => {
      await pool.query(
        `INSERT INTO "news" ("title", "slug", "content")
         VALUES ('Raw', 'raw', $1)`,
        ['<p>ok</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>'],
      );

      const found = await News.findBySlug("raw");

      expect(found!.content).toContain("<p>ok</p>");
      expect(found!.content).not.toContain("<script");
      expect(found!.content).not.toContain("javascript:");
    });

    /**
     * The rename of an article with no history row — one inserted by hand —
     * used to record only the new slug, so its published address went to a
     * 404 instead of a 301.
     *
     * News.update recorded the outgoing slug itself for a while; 0054's
     * trigger is what keeps the address now, by having recorded it when the
     * row went in.
     */
    it("keeps the old address of a hand-inserted article working after a rename", async () => {
      const { rows } = await pool.query(
        `INSERT INTO "news" ("title", "slug", "content")
         VALUES ('Old title', 'old-title', '<p>x</p>') RETURNING "id"`,
      );

      await News.update(rows[0].id, { title: "New title", content: "<p>x</p>" });

      expect(await News.findCurrentSlug("old-title")).toBe("new-title");
    });

    /**
     * The first rename of an article with no history used to write the new
     * slug and the outgoing one in one INSERT … SELECT … UNION, and the
     * UNION's output order decided which got the lower id. A new slug sorting
     * first took it, so findFirstSlugs named the new address the article's
     * first — and /news/feed.xml, which uses that as the item's permanent
     * guid, announced the renamed article to every subscriber again.
     */
    it("keeps the address a hand-inserted article was published at as its first", async () => {
      const { rows } = await pool.query(
        `INSERT INTO "news" ("title", "slug", "content")
         VALUES ('Zeta news', 'zeta-news-hand', '<p>x</p>') RETURNING "id"`,
      );
      const id = rows[0].id as number;

      await News.update(id, { title: "Alpha news", content: "<p>x</p>" });

      expect((await News.findFirstSlugs([id])).get(id)).toBe("zeta-news-hand");
    });

    it("reports the first slug each article ever had", async () => {
      const created = await News.create({
        title: "First name",
        content: "<p>x</p>",
        userId: 1,
      });

      await News.update(created.id, { title: "Second name", content: "<p>x</p>" });

      const first = await News.findFirstSlugs([created.id]);

      expect(first.get(created.id)).toBe("first-name");
    });

    it("should return null for non-existent slug", async () => {
      const foundNews = await News.findBySlug("non-existent");

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

  describe("update", () => {
    it("should update title, slug and content", async () => {
      const created = await News.create({
        title: "Original Title",
        content: "Original content",
        userId: 1,
      });

      const updated = await News.update(created.id, {
        title: "Updated Title",
        content: "Updated content",
      });

      expect(updated).toBeInstanceOf(News);
      expect(updated!.title).toBe("Updated Title");
      expect(updated!.slug).toBe("updated-title");
      expect(updated!.content).toBe("Updated content");
    });

    it("should return null for non-existent id", async () => {
      const updated = await News.update(999, {
        title: "Title",
        content: "Content",
      });

      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    it("should soft-delete a news item", async () => {
      const created = await News.create({
        title: "To Delete",
        content: "Content",
        userId: 1,
      });

      await News.delete(created.id);

      const found = await News.findById(created.id);
      expect(found).toBeNull();
    });

    it("reports whether there was an article to delete", async () => {
      const created = await News.create({
        title: "To Delete",
        content: "Content",
        userId: 1,
      });

      expect(await News.delete(created.id)).toBe(true);
    });

    /**
     * The route flashes "News deleted successfully!" off the back of this, so
     * a soft delete that matched nothing has to say so. Without
     * "deletedAt IS NULL" in the predicate the second call matched the same
     * row again and reported another successful deletion.
     */
    it("reports nothing deleted the second time round", async () => {
      const created = await News.create({
        title: "To Delete",
        content: "Content",
        userId: 1,
      });

      expect(await News.delete(created.id)).toBe(true);
      expect(await News.delete(created.id)).toBe(false);
    });

    it("reports nothing deleted for an id that never existed", async () => {
      expect(await News.delete(999_999)).toBe(false);
    });

    it("should not include deleted items in count", async () => {
      const created = await News.create({
        title: "To Delete",
        content: "Content",
        userId: 1,
      });

      await News.delete(created.id);

      const count = await News.count();
      expect(count).toBe(0);
    });
  });

  describe("slugs", () => {
    // A second article with the same title used to collide on the UNIQUE
    // constraint and fail the save.
    it("should give two articles with the same title distinct slugs", async () => {
      const first = await News.create({
        title: "Same Title",
        content: "One",
        userId: 1,
      });
      const second = await News.create({
        title: "Same Title",
        content: "Two",
        userId: 1,
      });

      expect(first.slug).toBe("same-title");
      expect(second.slug).toBe("same-title-2");
    });

    // Renaming used to change the slug in place, so the published URL 404'd.
    it("should keep the old address pointing at a renamed article", async () => {
      const created = await News.create({
        title: "Original Title",
        content: "Content",
        userId: 1,
      });

      const updated = await News.update(created.id, {
        title: "Better Title",
        content: "Content",
      });

      expect(updated?.slug).toBe("better-title");
      expect(await News.findBySlug("original-title")).toBeNull();
      expect(await News.findCurrentSlug("original-title")).toBe("better-title");
    });

    it("should let an article take back a title it used before", async () => {
      const created = await News.create({
        title: "First Name",
        content: "Content",
        userId: 1,
      });

      await News.update(created.id, { title: "Second Name", content: "C" });
      const back = await News.update(created.id, {
        title: "First Name",
        content: "C",
      });

      expect(back?.slug).toBe("first-name");
    });

    it("should not resolve the old address of a deleted article", async () => {
      const created = await News.create({
        title: "Doomed",
        content: "Content",
        userId: 1,
      });

      await News.delete(created.id);

      expect(await News.findCurrentSlug("doomed")).toBeNull();
    });
  });
});
