import pool from "../db.ts";
import Model, { type ModelData } from "./model.ts";
// From utils, not from the two routers that serve these documents: reaching
// into the routes closed a models -> routes -> models import cycle — see
// utils/page-cache.ts.
import { clearFeedCache, clearSitemapCache } from "../utils/page-cache.ts";
import { RESERVED_NEWS_SLUGS } from "../utils/reserved-slugs.ts";
import { slugSharesBase, slugify, withResolvedSlug } from "../utils/slug.ts";
import { bumpCacheEpoch } from "../utils/cache-epoch.ts";
import { sanitizeHtml } from "../utils/sanitize-html.ts";

export interface NewsData extends ModelData {
  title: string;
  slug: string;
  content: string;
  userId?: number | null;
}

/**
 * The unique constraints a save may lose a race on — see withResolvedSlug and
 * the matching list in models/game.ts. "news_slug_unique" is named in
 * 0019_add_slug_to_news.sql; "news_slugs_slug_key" is the history table's own,
 * from 0021_slug_history.sql.
 */
const NEWS_SLUG_CONSTRAINTS = ["news_slug_unique", "news_slugs_slug_key"];

/**
 * Every cache an article write can leave stale: the sitemap and the feed on
 * this machine, and — through the shared epoch — the same on every other.
 * See utils/cache-epoch.ts.
 */
function clearNewsCaches(): void {
  clearSitemapCache();
  clearFeedCache();
  void bumpCacheEpoch();
}

export default class News extends Model {
  title: string;
  slug: string;
  content: string;
  userId?: number | null;

  constructor(data: NewsData) {
    super(data);
    this.title = data.title;
    this.slug = data.slug;
    this.content = data.content;
    this.userId = data.userId;
  }

  /** Delegates to utils/slug.ts, which games share — see Game.createSlug. */
  static createSlug(title: string): string {
    return slugify(title);
  }

  /**
   * A slug for `title` that no other article has ever used. Two articles
   * sharing a title used to collide on the UNIQUE constraint and fail the
   * save; `newsId` lets an article keep an address it already owns.
   */
  static async resolveSlug(title: string, newsId?: number): Promise<string> {
    const base = News.createSlug(title) || "news";

    const { rows } = await pool.query(
      `SELECT "slug" FROM "news_slugs"
       WHERE ("slug" = $1 OR "slug" LIKE $2)
         AND ($3::int IS NULL OR "newsId" <> $3::int)`,
      [base, `${base}-%`, newsId ?? null],
    );

    const taken = new Set<string>(rows.map((row) => row.slug));

    // "/news/new" is the admin form and is declared ahead of "/news/:slug",
    // so an article titled "New" would have been unreachable at its own
    // address — see utils/reserved-slugs.ts.
    if (RESERVED_NEWS_SLUGS.has(base)) taken.add(base);

    if (!taken.has(base)) return base;

    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix++;

    return `${base}-${suffix}`;
  }

  /**
   * The slug an existing article keeps, or moves to, when it is saved. Kept
   * when it is the new title's base or that base with a collision suffix, so
   * an edit to the body cannot move the address — see
   * Game.resolveSlugForUpdate for the case that made this necessary.
   */
  static async resolveSlugForUpdate(
    title: string,
    newsId: number,
  ): Promise<string> {
    const base = News.createSlug(title) || "news";

    const { rows } = await pool.query(
      'SELECT "slug" FROM "news" WHERE "id" = $1 AND "deletedAt" IS NULL',
      [newsId],
    );

    const current: unknown = rows[0]?.slug;

    if (typeof current === "string" && slugSharesBase(current, base)) {
      return current;
    }

    return News.resolveSlug(title, newsId);
  }

  /** Where an article that once lived at `slug` can be found today. */
  static async findCurrentSlug(slug: string): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT n."slug" FROM "news_slugs" ns
       JOIN "news" n ON n."id" = ns."newsId"
       WHERE ns."slug" = $1 AND n."deletedAt" IS NULL`,
      [slug],
    );

    return rows[0]?.slug ?? null;
  }

  static async create(data: {
    title: string;
    content: string;
    userId: number;
  }): Promise<News> {
    // Sanitized here rather than only in the route, which is where this used
    // to happen. Game descriptions have always been cleaned inside the model
    // (see serialize in models/game.ts) and articles were the one thing stored
    // as markup that was not — so a caller reaching for News.create directly
    // stored whatever it was handed, and three views render this with <%- %>.
    // Both current callers already sanitize, and DOMPurify is idempotent over
    // its own output, so this changes nothing for them.
    //
    // The slug is resolved inside the retry, because two articles saved under
    // one title at the same moment both read it as free — see
    // withResolvedSlug.
    const result = await withResolvedSlug(NEWS_SLUG_CONSTRAINTS, async () => {
      const slug = await News.resolveSlug(data.title);

      // One statement, so the article and its slug-history row stay in step.
      return pool.query(
        `WITH inserted AS (
         INSERT INTO "news" ("title", "slug", "content", "userId")
         VALUES ($1, $2, $3, $4)
         RETURNING *
       ), history AS (
         INSERT INTO "news_slugs" ("newsId", "slug")
         SELECT "id", "slug" FROM inserted
         ON CONFLICT ("slug") DO NOTHING
       )
       SELECT * FROM inserted`,
        [data.title, slug, sanitizeHtml(data.content), data.userId],
      );
    });

    // Articles appear in the sitemap, cached for a day, and in /news/feed.xml,
    // cached for fifteen minutes. Games already dropped the sitemap on write
    // and news did not; neither of them dropped the feed, so a new article
    // stayed missing from it until the TTL happened to expire.
    clearNewsCaches();

    return new News(result.rows[0]);
  }

  static async findAll({
    page = 1,
    limit = 10,
  }: {
    page?: number;
    limit?: number;
  } = {}): Promise<{ news: News[]; total: number; totalPages: number }> {
    const offset = (page - 1) * limit;

    const [newsResult, countResult] = await Promise.all([
      pool.query(
        // "id" breaks the tie, and is not decoration: LIMIT/OFFSET over a
        // non-unique sort key has no defined order among equal rows, so two
        // articles sharing a "createdAt" — a seeded batch, or two saves in the
        // same instant — could appear on both pages or on neither. Comments
        // page on "id" for exactly this reason (see Comment.findRecent).
        `SELECT * FROM "news"
         WHERE "deletedAt" IS NULL
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM "news" WHERE "deletedAt" IS NULL`,
      ),
    ]);

    const news = newsResult.rows.map((row) => new News(row));
    const total = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    return { news, total, totalPages };
  }

  static async findRecent(limit = 5): Promise<News[]> {
    const result = await pool.query(
      // Tie broken on "id" as in findAll: without it, which of two articles
      // sharing a "createdAt" makes the cut is left to the planner, so the
      // homepage widget could show a different one on every request.
      `SELECT * FROM "news"
       WHERE "deletedAt" IS NULL
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => new News(row));
  }

  static async findById(id: number): Promise<News | null> {
    const result = await pool.query(
      `SELECT * FROM "news" WHERE "id" = $1 AND "deletedAt" IS NULL`,
      [id],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return new News(result.rows[0]);
  }

  static async count(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as total FROM "news" WHERE "deletedAt" IS NULL`,
    );

    return parseInt(result.rows[0].total, 10);
  }

  static async update(
    id: number,
    data: { title: string; content: string },
  ): Promise<News | null> {
    // Sanitized in the model for the same reason as in create() above, and
    // retried on a slug collision for the same reason too.
    const result = await withResolvedSlug(NEWS_SLUG_CONSTRAINTS, async () => {
      const slug = await News.resolveSlugForUpdate(data.title, id);

      // The new slug joins the history before the old one stops being
      // current, so the previous address keeps resolving to this article.
      return pool.query(
        `WITH updated AS (
         UPDATE "news"
         SET "title" = $1, "slug" = $2, "content" = $3, "updatedAt" = NOW()
         WHERE "id" = $4 AND "deletedAt" IS NULL
         RETURNING *
       ), history AS (
         INSERT INTO "news_slugs" ("newsId", "slug")
         SELECT "id", "slug" FROM updated
         ON CONFLICT ("slug") DO NOTHING
       )
       SELECT * FROM updated`,
        [data.title, slug, sanitizeHtml(data.content), id],
      );
    });

    if (result.rows.length === 0) {
      return null;
    }

    clearNewsCaches();

    return new News(result.rows[0]);
  }

  /**
   * Soft-deletes an article, reporting whether there was one to delete.
   *
   * "deletedAt IS NULL" in the predicate as well as the id: without it a
   * second delete of the same article matched the row again and reported
   * success, and so did a delete of an id that was never there — which the
   * route then flashed as "News deleted successfully!". Every read filters on
   * the same condition, so a row that fails it is already gone as far as the
   * site is concerned.
   */
  static async delete(id: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE "news" SET "deletedAt" = NOW()
       WHERE "id" = $1 AND "deletedAt" IS NULL`,
      [id],
    );

    const deleted = (rowCount ?? 0) > 0;

    // Only when a row actually went, as in Game.delete. Clearing
    // unconditionally threw away the sitemap and both feeds on behalf of a
    // delete that changed nothing — an admin double-clicking a stale button,
    // or a crawler replaying an old form post — and the sitemap is the better
    // part of the catalogue to rebuild.
    if (deleted) {
      clearNewsCaches();
    }

    return deleted;
  }

  static async findBySlug(slug: string): Promise<News | null> {
    const result = await pool.query(
      `SELECT * FROM "news" WHERE "slug" = $1 AND "deletedAt" IS NULL`,
      [slug],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return new News(result.rows[0]);
  }

  static async findForSitemap(): Promise<
    { id: number; slug: string; updatedAt: Date }[]
  > {
    const result = await pool.query(
      `SELECT "id", "slug", "updatedAt" FROM "news" WHERE "deletedAt" IS NULL ORDER BY "id"`,
    );

    return result.rows;
  }
}
