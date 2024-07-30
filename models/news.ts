import pool from "../db.ts";
import Model, { type ModelData } from "./model.ts";
// From utils, not from the two routers that serve these documents: reaching
// into the routes closed a models -> routes -> models import cycle — see
// utils/page-cache.ts.
import { clearFeedCache, clearSitemapCache } from "../utils/page-cache.ts";
import { RESERVED_NEWS_SLUGS } from "../utils/reserved-slugs.ts";
import {
  type SlugConfig,
  findFirstSlugs,
  resolveSlug,
  resolveSlugForUpdate,
  slugify,
  withResolvedSlug,
} from "../utils/slug.ts";
import { bumpCacheEpoch } from "../utils/cache-epoch.ts";
import { sanitizeHtml } from "../utils/sanitize-html.ts";
import { isPageBeyondTotal, totalPages } from "../utils/pagination.ts";

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
 * What tells utils/slug.ts which table it is resolving a slug for — the whole
 * of the difference between an article's slug and a game's. See SlugConfig,
 * and GAME_SLUGS in models/game.ts for the other half of the pair.
 *
 * The `liveFilter` is the one thing that genuinely differs: "news" is
 * soft-deleted and "games" is not, so a deleted article has no address to
 * keep and falls through to a fresh resolve.
 */
const NEWS_SLUGS: SlugConfig = {
  table: "news",
  historyTable: "news_slugs",
  foreignKey: "newsId",
  reserved: RESERVED_NEWS_SLUGS,
  fallbackBase: "news",
  liveFilter: 'AND "deletedAt" IS NULL',
};

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
   *
   * The loop itself is in utils/slug.ts, which games share — "/news/new" is
   * the admin form and is declared ahead of "/news/:slug", which is why the
   * reserved set matters here too.
   */
  static async resolveSlug(title: string, newsId?: number): Promise<string> {
    return resolveSlug(pool, NEWS_SLUGS, title, newsId);
  }

  /**
   * The slug an existing article keeps, or moves to, when it is saved. Kept
   * when it is the new title's base or that base with a collision suffix, so
   * an edit to the body cannot move the address — see resolveSlugForUpdate in
   * utils/slug.ts for the case that made this necessary.
   */
  static async resolveSlugForUpdate(
    title: string,
    newsId: number,
  ): Promise<string> {
    return resolveSlugForUpdate(pool, NEWS_SLUGS, title, newsId);
  }

  /**
   * The first slug each of these articles ever had — what the news feed
   * names them by for good. See findFirstSlugs in utils/slug.ts.
   */
  static async findFirstSlugs(ids: number[]): Promise<Map<number, string>> {
    return findFirstSlugs(pool, NEWS_SLUGS, ids);
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
      //
      // 0054's trigger records the same row again, and that is not a second
      // copy to keep in step: the trigger is what covers an article written
      // by anything other than this model, and here it finds its work done.
      // It fires only once the whole statement has run — AFTER triggers on a
      // WITH statement wait for every part of it — so the "history" row below
      // is already there, the trigger's ON CONFLICT writes nothing, and the
      // first slug in the history is this one. See the same note in
      // Game.create.
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
    // Clamped, as Game.find clamps it. A page of 0 or below produced a
    // negative OFFSET, which Postgres refuses outright ("OFFSET must not be
    // negative") — a 500 for a "?page=0" anyone can type, on a method the
    // routes are not the only callers of. parsePageParam rejects those today;
    // a model that computes an offset from its argument cannot depend on it.
    const offset = (Math.max(1, page) - 1) * limit;

    // The count first, and the listing query only if the page it would serve
    // is in range — the same order routes/home.ts uses, for the same reason.
    // parsePageParam admits anything up to MAX_PAGE, so "/news?page=9999"
    // made Postgres walk past 99 980 rows to find out the address does not
    // exist; the count is cheap and this method needs it anyway. See
    // isPageBeyondTotal.
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) as count FROM "news" WHERE "deletedAt" IS NULL`,
    );

    const total = parseInt(countRows[0].count, 10);

    if (isPageBeyondTotal({ page, limit, total })) {
      return { news: [], total, totalPages: totalPages(total, limit) };
    }

    const newsResult = await pool.query(
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
    );

    const news = newsResult.rows.map((row) => new News(row));

    return { news, total, totalPages: totalPages(total, limit) };
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
      // 0054's trigger records it too, at the end of this statement, and finds
      // it here — see the same note in create().
      //
      // The *outgoing* slug is not written here, because it is in the history
      // already: the trigger recorded it the moment it became live, however
      // it got there, and 0054 backfilled every article that had none. This
      // statement used to record it as well — a `previous` CTE, UNIONed with
      // `updated` into one INSERT — for an article that had not come through
      // create() and so had no history at all: renaming one recorded only the
      // new slug, and the address it had been published at went to a 404.
      // That arm had the fault Game.update describes: both of its rows were
      // new, so the UNION's output order decided which took the lower id, and
      // a new slug sorting first took it — findFirstSlugs then named the new
      // address the article's first, and /news/feed.xml, whose guid is that
      // first slug, announced the renamed article to every subscriber again.
      // With the outgoing slug recorded before this statement runs, the one
      // row below is the only one that can be new.
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

    const article = new News(result.rows[0]);

    // Sanitized on the way out as well, because this is what
    // views/news/news-detail.ejs prints with <%- %>: create() and update()
    // clean what they write, but an article that did not go through them was
    // rendered exactly as stored. See Game.findBySlug for the rest of it.
    article.content = sanitizeHtml(article.content);

    return article;
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
