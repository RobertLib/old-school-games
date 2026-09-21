import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
// The sidebar's "Latest comments" widget is cached, so every write below drops
// it. Waiting out the TTL meant a freshly posted comment took up to two
// minutes to appear — the whole point of the widget — and a comment an admin
// had just taken down stayed on display for just as long.
import {
  LATEST_COMMENTS_KEY,
  sidebarCache,
} from "../utils/sidebar-cache.ts";
// ...and the same widget on every *other* machine, which the delete above
// cannot reach. See utils/cache-epoch.ts; the game and news writes already
// bumped it and the comment writes were the pair left out, so a comment
// posted on one machine stayed invisible on the next for the whole TTL.
//
// The "comments" scope specifically, not the broad one these writes used to
// bump: a comment is the most frequent write on the site and it drops exactly
// one sidebar entry here, so making every other machine throw away the sitemap
// as well was both wrong and the most expensive invalidation available.
import { bumpCacheEpoch } from "../utils/cache-epoch.ts";

interface CommentData extends ModelData {
  nick: string;
  content: string;
  gameId: number;
  parentId?: number | null;
}

export const COMMENTS_PAGE_SIZE = 20;

/** How many comments the site-wide overview shows per page. */
export const OVERVIEW_PAGE_SIZE = 30;

/**
 * How many replies travel with one root comment.
 *
 * The roots have been paged since this was written — twenty at a time, on an
 * id cursor — but their replies were not, and the docstring below claimed the
 * whole method was bounded. It was not: the recursive term pulled *every*
 * descendant of all twenty roots with no limit, and comment-item.ejs then
 * rendered every one of them. Twenty popular threads is one query and one
 * render of everything ever said under them, and posting is only rate-limited
 * to ten per five minutes per address — so filling a thread is slow but
 * perfectly reachable.
 *
 * The cut is a chronological prefix, which matters for more than tidiness:
 * the window is ordered by "id" within each thread, and a reply always has a
 * higher id than the comment it answers, so a reply that survives the cap can
 * never have had its parent cut from under it. That is what lets the walk in
 * findByGameId stay as it is rather than needing to cope with orphans.
 *
 * Fifty is well past any real thread here and small enough to bound the page.
 * What is left over is counted rather than dropped in silence — see
 * `hiddenReplies` and the note comment-item.ejs renders from it.
 */
export const REPLIES_PER_ROOT = 50;

/**
 * A comment carrying the game it was posted on. The threaded views never need
 * this — they already know which game they are rendering — but anything
 * site-wide has to say what is being talked about.
 */
export interface RecentComment {
  id: number;
  nick: string;
  content: string;
  createdAt: Date | string;
  parentId: number | null;
  gameId: number;
  gameTitle: string;
  gameSlug: string;
}

/** A game and how much conversation it has attracted. */
export interface DiscussedGame {
  gameId: number;
  gameTitle: string;
  gameSlug: string;
  commentCount: number;
  lastCommentAt: Date | string;
}

export default class Comment extends Model {
  nick: string;
  content: string;
  gameId: number;
  parentId: number | null;
  replies: Comment[];
  /**
   * Replies this thread has beyond the ones in `replies` — see
   * REPLIES_PER_ROOT. Zero unless the cap actually cut something, so the
   * views can ask about it without a guard.
   */
  hiddenReplies: number;

  constructor(data: CommentData) {
    super(data);

    this.nick = data.nick;
    this.content = data.content;
    this.gameId = data.gameId;
    this.parentId = data.parentId ?? null;
    this.replies = [];
    this.hiddenReplies = 0;
  }

  /**
   * Returns a batch of top-level comments — the most recent ones first time
   * round, then progressively older ones as `before` walks backwards — each
   * with its replies nested one level deep.
   *
   * A thread can hold thousands of comments, so they are never all sent at
   * once: the roots are paged on an id cursor rather than an offset, so
   * comments posted while someone reads cannot shift the window and duplicate
   * or skip a row, and each root's replies are capped at REPLIES_PER_ROOT.
   * The cap is the half that was missing — the roots were bounded and their
   * replies were not.
   */
  static async findByGameId(
    gameId: number,
    {
      limit = COMMENTS_PAGE_SIZE,
      before = null,
    }: { limit?: number; before?: number | null } = {},
  ): Promise<Comment[]> {
    const { rows: rootRows } = await db.query(
      `SELECT * FROM "comments"
       WHERE "gameId" = $1 AND "parentId" IS NULL
         AND ($2::int IS NULL OR "id" < $2)
       ORDER BY "id" DESC
       LIMIT $3`,
      [gameId, before, limit],
    );

    if (rootRows.length === 0) return [];

    // Newest-first for paging, oldest-first for reading.
    const roots = rootRows.reverse().map((row) => new Comment(row));
    const rootIds = roots.map((root) => root.id);

    // Recursive so a reply to a reply still travels with its thread, and
    // windowed per root so a thread cannot arrive unbounded — see
    // REPLIES_PER_ROOT.
    //
    // A LATERAL per root rather than one ROW_NUMBER over every descendant of
    // the whole batch. Three things change, and none of them is the result:
    //
    //   - The walk is one root's own subtree, so it stays inside that root's
    //     range of "idx_comments_parentId" instead of building a hash of every
    //     descendant of all twenty roots to partition afterwards.
    //   - It walks ids, not rows. The recursive term used to carry every
    //     column of every descendant through the recursion and the two window
    //     functions, and then throw all but fifty per thread away; only the
    //     ids and parents are needed to decide *which* rows the page wants,
    //     and the join below reads the columns for exactly those.
    //   - The LIMIT is inside the lateral, so the rows the database hands back
    //     are bounded by the cap times the batch size rather than by how busy
    //     the threads happen to be.
    //
    // What it cannot avoid is visiting the whole thread: "replyTotal" is a
    // real number in the view ("12 more replies"), so the count has to be
    // exact, and a count of a thread means reaching all of it. COUNT(*) OVER ()
    // is evaluated before the LIMIT, which is what makes one query enough.
    //
    // "rootId" is carried out of the lateral rather than derived afterwards,
    // because the cap has to be per *thread*: capping each immediate parent's
    // own answers would leave the thread as a whole as unbounded as it was. It
    // is only used for the window — the walk below still finds the ancestor
    // itself, which is what keeps the shape of this method's contract
    // unchanged.
    const { rows: replyRows } = await db.query(
      `SELECT c.*, w."replyTotal"
         FROM (
           SELECT r.*
             FROM unnest($1::int[]) AS roots("rootId")
            CROSS JOIN LATERAL (
              WITH RECURSIVE thread AS (
                SELECT c."id", c."parentId"
                  FROM "comments" c
                 WHERE c."parentId" = roots."rootId"
                 UNION ALL
                SELECT c."id", c."parentId"
                  FROM "comments" c JOIN thread t ON c."parentId" = t."id"
              )
              SELECT thread."id",
                     COUNT(*) OVER () AS "replyTotal"
                FROM thread
               ORDER BY thread."id" ASC
               LIMIT $2
            ) r
         ) w
         JOIN "comments" c ON c."id" = w."id"
        ORDER BY c."id" ASC`,
      [rootIds, REPLIES_PER_ROOT],
    );

    const byId = new Map<number, Comment>(roots.map((root) => [root.id, root]));

    for (const row of replyRows) {
      byId.set(row.id, new Comment(row));
    }

    for (const row of replyRows) {
      const reply = byId.get(row.id)!;

      // Walk up to the top-level ancestor so a deep chain is flattened onto
      // its thread instead of marching off the side of the page.
      let ancestor = byId.get(reply.parentId!);

      while (ancestor && ancestor.parentId !== null) {
        ancestor = byId.get(ancestor.parentId);
      }

      if (ancestor) {
        ancestor.replies.push(reply);

        // Assigned, not added to: every row of this thread carries the same
        // total. A row from before the window existed has none, which reads as
        // nothing hidden.
        const total = Number(row.replyTotal) || 0;

        ancestor.hiddenReplies = Math.max(0, total - REPLIES_PER_ROOT);
      }
    }

    return roots;
  }

  /** Top-level comments only — what the "load earlier" batches page through. */
  static async countRoots(gameId: number): Promise<number> {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS count FROM "comments" WHERE "gameId" = $1 AND "parentId" IS NULL',
      [gameId],
    );

    return parseInt(rows[0].count, 10) || 0;
  }

  /** Everything on the game, replies included — used for the heading. */
  static async countAll(gameId: number): Promise<number> {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS count FROM "comments" WHERE "gameId" = $1',
      [gameId],
    );

    return parseInt(rows[0].count, 10) || 0;
  }

  /** How many older top-level comments sit before the given one. */
  static async countOlderThan(gameId: number, id: number): Promise<number> {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count FROM "comments"
       WHERE "gameId" = $1 AND "parentId" IS NULL AND "id" < $2`,
      [gameId, id],
    );

    return parseInt(rows[0].count, 10) || 0;
  }

  /**
   * The newest comments across every game — what the sidebar widget and the
   * /comments overview show. Replies are included: a reply is as much a sign
   * of life as a new thread, and hiding them would make busy threads look
   * quiet.
   *
   * Ordered by "id" rather than "createdAt". The two agree because ids are
   * monotonic, and the primary key already indexes the descending scan, so
   * this needs no index of its own.
   */
  static async findRecent({
    limit = OVERVIEW_PAGE_SIZE,
    offset = 0,
  }: { limit?: number; offset?: number } = {}): Promise<RecentComment[]> {
    const { rows } = await db.query(
      `SELECT c."id", c."nick", c."content", c."createdAt", c."parentId",
              g."id" AS "gameId", g."title" AS "gameTitle", g."slug" AS "gameSlug"
       FROM "comments" c
       JOIN "games" g ON g."id" = c."gameId"
       ORDER BY c."id" DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return rows as RecentComment[];
  }

  /** Every comment on the site — the overview's total for its pagination. */
  static async countSitewide(): Promise<number> {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count
       FROM "comments" c
       JOIN "games" g ON g."id" = c."gameId"`,
    );

    return parseInt(rows[0].count, 10) || 0;
  }

  /** Games with the liveliest threads, busiest first. */
  static async findMostDiscussed(limit = 10): Promise<DiscussedGame[]> {
    const { rows } = await db.query(
      `SELECT g."id" AS "gameId", g."title" AS "gameTitle", g."slug" AS "gameSlug",
              COUNT(c."id")::int AS "commentCount",
              MAX(c."createdAt") AS "lastCommentAt"
       FROM "comments" c
       JOIN "games" g ON g."id" = c."gameId"
       GROUP BY g."id", g."title", g."slug"
       ORDER BY "commentCount" DESC, "lastCommentAt" DESC
       LIMIT $1`,
      [limit],
    );

    return rows as DiscussedGame[];
  }

  static async findById(id: number): Promise<Comment | null> {
    const { rows } = await db.query(
      'SELECT * FROM "comments" WHERE "id" = $1',
      [id],
    );

    return rows[0] ? new Comment(rows[0]) : null;
  }

  static async create({
    nick,
    content,
    gameId,
    parentId,
  }: {
    nick: string;
    content: string;
    gameId: number;
    parentId?: number | null;
  }): Promise<Comment> {
    const { rows } = await db.query(
      'INSERT INTO "comments" ("nick", "content", "gameId", "parentId") VALUES ($1, $2, $3, $4) RETURNING *',
      [nick, content, gameId, parentId ?? null],
    );

    sidebarCache.delete(LATEST_COMMENTS_KEY);
    void bumpCacheEpoch("comments");

    return new Comment(rows[0]);
  }

  /**
   * Removes a comment for good. Replies go with it — "parentId" cascades (see
   * 0020_search_ratings_comments.sql) — which is what moderation wants:
   * deleting spam should not leave the answers to it dangling.
   */
  static async delete(id: number): Promise<void> {
    await db.query('DELETE FROM "comments" WHERE "id" = $1', [id]);

    sidebarCache.delete(LATEST_COMMENTS_KEY);
    void bumpCacheEpoch("comments");
  }
}
