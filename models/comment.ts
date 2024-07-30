import crypto from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";
import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import { deriveKey } from "../utils/session-secret.ts";
// The sidebar's "Latest comments" widget is cached, so every write below drops
// it. Waiting out the TTL meant a freshly posted comment took up to two
// minutes to appear — the whole point of the widget — and a comment an admin
// had just taken down stayed on display for just as long.
import {
  FAILURE_TTL_MS,
  LATEST_COMMENTS_KEY,
  MOST_DISCUSSED_KEY,
  MOST_DISCUSSED_TTL_MS,
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
  /** Read only to set `hasSource` — see Comment. */
  sourceHash?: string | null;
}

/**
 * How finely an IPv6 source is told apart: by its /56, which is how the
 * comment limiter in routes/comments.ts already counts one — both read it
 * from here, so one source is exactly one rate-limit budget.
 *
 * Not the /64 a single IPv6 network usually is. The limiter hands a /56 one
 * budget of ten comments, and a /56 holds 256 /64s, so a source finer than
 * the budget let one budget put each of its comments on a /64 of its own:
 * the flood this exists for — a /48 posting through its 256 budgets — would
 * never have repeated a source at all. Coarser than the budget would lump
 * unrelated subscribers together, on the providers that delegate a /56 per
 * customer, for no gain the limiter has not already given away. And a /56
 * says less about who someone is than a /64 does.
 *
 * IPv4 is the whole address, as it is to the limiter.
 */
export const SOURCE_IPV6_SUBNET = 56;

/**
 * How long a comment's source is kept — see pruneSources.
 *
 * Shorter than the 90 days a vote's address is kept (models/game.ts), because
 * the two are found out differently. A burst of votes hides inside an
 * average and can take weeks to notice; a burst of comments is on every page
 * of the site the moment it is posted — the Latest comments sidebar — so it is
 * dealt with within days or not at all. A month outlives that with room to
 * spare, and is a retention period the privacy policy can state plainly.
 */
export const SOURCE_RETENTION_DAYS = 30;

/**
 * How many rows one pruning statement may touch — the same bound, and the
 * same reasoning, as PRUNE_BATCH_SIZE in models/game.ts: one statement over a
 * backlog runs into the pool's statement_timeout, fails the same way every
 * day after, and never meets the retention the policy states.
 */
const PRUNE_BATCH_SIZE = 5_000;

/**
 * How many of a source's comments the review page lists. The count above the
 * list is exact whatever this says; a flood is thousands, and the page is for
 * recognising one, not for reading all of it.
 */
export const SOURCE_REVIEW_LIMIT = 50;

/**
 * The key comment sources are hashed under: derived from SESSION_SECRET for
 * this and nothing else (see deriveKey), so a source can never verify as a
 * session signature or as any other value this app signs, and it cannot be
 * recomputed from the database alone.
 *
 * Rotating SESSION_SECRET rotates it, which ends the grouping: comments from
 * before the rotation no longer match anything posted after it. That costs at
 * most one retention window of moderation, and it is the same lever that
 * ends every session, so it is pulled for reasons that outweigh it.
 */
const SOURCE_KEY = deriveKey("comment source v1");

/**
 * The source recorded with a comment: a keyed hash of where it came from, or
 * null when there is nothing to hash.
 *
 * The address is reduced the way the comment limiter reduces it —
 * ipKeyGenerator is the function express-rate-limit keys by, and
 * SOURCE_IPV6_SUBNET is the subnet both use — so an IPv4 client written in
 * its IPv6-mapped form ("::ffff:203.0.113.7", which a dual-stack socket
 * reports) is the same source as the same client in plain IPv4.
 *
 * Hashed, and never stored or logged as it was: the only thing moderation
 * asks of a source is "are these two the same", which the hash answers
 * exactly, while an address would also say where someone lives. HMAC rather
 * than a plain digest, because there are only four billion IPv4 addresses —
 * a digest of one is reversed by trying them all, and a keyed hash cannot be
 * tried without the key.
 */
export function commentSource(ip: string | null | undefined): string | null {
  // Express leaves req.ip undefined when there is no socket behind the
  // request; an empty key would make every such comment one source.
  if (!ip) return null;

  return crypto
    .createHmac("sha256", SOURCE_KEY)
    .update(ipKeyGenerator(ip, SOURCE_IPV6_SUBNET))
    .digest("hex");
}

/**
 * What deleting everything from one comment's source would take down — the
 * review page's summary, and its list.
 */
export interface SourceSummary {
  /** Comments posted from the source, the one the admin clicked included. */
  total: number;
  /**
   * Replies to those comments posted from anywhere else. They go too, as they
   * do when one comment is deleted: "parentId" cascades.
   */
  otherReplies: number;
  /** The newest SOURCE_REVIEW_LIMIT of them, with the games they are on. */
  comments: RecentComment[];
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
 * The cut keeps the *newest* fifty. It used to keep the oldest — a
 * chronological prefix, chosen because a reply always has a higher id than
 * the comment it answers, so no survivor could lose its parent to the cap and
 * the ancestor walk in findByGameId never met an orphan. The cost was on the
 * reader's side: the note under the thread said "older replies are not
 * shown" about replies that were in fact the newest, and a reply posted to a
 * thread already at the cap appeared once, appended by comments.js, and was
 * gone on reload. Each reply now arrives carrying the root of its thread, so
 * it is filed under that root directly and there is no walk left to orphan.
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
  /** Whether a source is still recorded — see Comment.hasSource. */
  hasSource: boolean;
}

/**
 * How many games the "Most discussed" panel shows.
 *
 * A constant rather than a parameter with a default, because the result is
 * cached under one key: a caller asking for a different number would either
 * be served somebody else's list or need a key of its own, and there has only
 * ever been one caller. See MOST_DISCUSSED_KEY.
 */
export const MOST_DISCUSSED_LIMIT = 10;

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
  /**
   * Whether this comment still has a source to act on, which is what decides
   * whether an admin is offered "all from this source".
   *
   * A flag rather than the hash. Every view that renders a comment is handed
   * the instance, and the route tests serialise the locals whole, so a hash on
   * the instance would be one careless template away from the page. It never
   * leaves the database after it is written: the lookups below take a comment
   * id and resolve the hash in SQL.
   */
  hasSource: boolean;

  constructor(data: CommentData) {
    super(data);

    this.nick = data.nick;
    this.content = data.content;
    this.gameId = data.gameId;
    this.parentId = data.parentId ?? null;
    this.replies = [];
    this.hiddenReplies = 0;
    this.hasSource = data.sourceHash != null;
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
    // own answers would leave the thread as a whole as unbounded as it was.
    // And it comes all the way out of the query, because it is also how each
    // reply is filed. The window keeps a thread's *newest* replies (see
    // REPLIES_PER_ROOT), so a survivor's parent may be one the cap dropped —
    // an ancestor walk through the rows that came back would lose it, where
    // the root it was found under is known exactly.
    const { rows: replyRows } = await db.query(
      `SELECT c.*, w."replyTotal", w."rootId"
         FROM (
           SELECT r.*, roots."rootId"
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
               ORDER BY thread."id" DESC
               LIMIT $2
            ) r
         ) w
         JOIN "comments" c ON c."id" = w."id"
        ORDER BY c."id" ASC`,
      [rootIds, REPLIES_PER_ROOT],
    );

    const rootsById = new Map<number, Comment>(
      roots.map((root) => [root.id, root]),
    );

    // Oldest first — the query orders them so — and filed under the root the
    // query found them under, so a deep chain is flattened onto its thread
    // instead of marching off the side of the page.
    for (const row of replyRows) {
      const root = rootsById.get(Number(row.rootId));

      if (!root) continue;

      root.replies.push(new Comment(row));

      // Assigned, not added to: every row of this thread carries the same
      // total. A row from before the window existed has none, which reads as
      // nothing hidden.
      const total = Number(row.replyTotal) || 0;

      root.hiddenReplies = Math.max(0, total - REPLIES_PER_ROOT);
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
    // The page is chosen from ids alone, and only its rows meet "games".
    // LIMIT/OFFSET used to sit on top of the join, so every comment the
    // offset skipped was joined to its game first and then thrown away: at
    // offset 90,000 that was 90,030 rows through the join (~55k buffers,
    // ~29ms), and a crawler walking every page of /comments did work that
    // grew with the square of the comment count. The skipped rows are now
    // read off the primary key and nothing else. Nothing can drop out of the
    // join — "gameId" is NOT NULL with a cascading key (0024) — so the page
    // holds exactly the rows it did.
    // "hasSource" as a flag and never the hash itself — see Comment.hasSource.
    const { rows } = await db.query(
      `SELECT c."id", c."nick", c."content", c."createdAt", c."parentId",
              g."id" AS "gameId", g."title" AS "gameTitle", g."slug" AS "gameSlug",
              c."sourceHash" IS NOT NULL AS "hasSource"
       FROM (
         SELECT "id" FROM "comments"
         ORDER BY "id" DESC
         LIMIT $1 OFFSET $2
       ) page
       JOIN "comments" c ON c."id" = page."id"
       JOIN "games" g ON g."id" = c."gameId"
       ORDER BY c."id" DESC`,
      [limit, offset],
    );

    return rows as RecentComment[];
  }

  /** Every comment on the site — the overview's total for its pagination. */
  static async countSitewide(): Promise<number> {
    const { rows } = await db.query(
      // No join to "games". It looked like the filter that keeps orphaned
      // comments out of the total, and it never was one: 0024 made
      // "comments"."gameId" NOT NULL with a cascading foreign key, so every
      // comment has exactly one game and deleting a game takes its comments
      // with it. The join could therefore neither drop a row nor add one —
      // it only made the count that decides how many pages /comments offers
      // read the whole of "games" as well.
      //
      // findRecent still joins, and has to: it *selects* the game's title and
      // slug for each row it renders.
      `SELECT COUNT(*) AS count FROM "comments"`,
    );

    return parseInt(rows[0].count, 10) || 0;
  }

  /**
   * Games with the liveliest threads, busiest first.
   *
   * Cached for MOST_DISCUSSED_TTL_MS and dropped by every comment write below
   * — this is a GROUP BY over every comment on the site joined to "games",
   * with nothing that can index it, and it used to run on every request for
   * page 1 of /comments. The game writes drop it too, because it carries a
   * title and a slug per game (see clearGameCaches in models/game.ts).
   */
  static async findMostDiscussed(
    limit: number = MOST_DISCUSSED_LIMIT,
  ): Promise<DiscussedGame[]> {
    return sidebarCache.get(
      MOST_DISCUSSED_KEY,
      MOST_DISCUSSED_TTL_MS,
      () => Comment.loadMostDiscussed(limit),
      // Failures remembered for a few seconds, like every entry the sidebar
      // middleware loads. Without it, a Postgres outage made every request
      // for /comments fire this doomed GROUP BY again — each one first
      // waiting out the pool's two-second connection timeout — because a
      // rejection is dropped from the cache by default. See FAILURE_TTL_MS.
      FAILURE_TTL_MS,
    );
  }

  private static async loadMostDiscussed(
    limit: number,
  ): Promise<DiscussedGame[]> {
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

  /**
   * Stores a comment, and the source it came from.
   *
   * `ip` is the address the request came from, and it goes no further than
   * this: it is hashed by commentSource and only the hash is written. Taken
   * here rather than hashed by the caller so that the model is the one place
   * that decides what is stored — the same arrangement as the sanitising in
   * News.create — and the column's CHECK (0056) refuses anything that is not
   * a hash, should a caller ever hand over an address some other way.
   */
  static async create({
    nick,
    content,
    gameId,
    parentId,
    ip,
  }: {
    nick: string;
    content: string;
    gameId: number;
    parentId?: number | null;
    ip?: string | null;
  }): Promise<Comment> {
    const { rows } = await db.query(
      'INSERT INTO "comments" ("nick", "content", "gameId", "parentId", "sourceHash") VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [nick, content, gameId, parentId ?? null, commentSource(ip)],
    );

    sidebarCache.delete(LATEST_COMMENTS_KEY);
    // And the "Most discussed" panel, which counts exactly this — see
    // MOST_DISCUSSED_KEY. It was the half of the pair that went uncached and
    // therefore uninvalidated; now that it is held for five minutes, a write
    // has to say so.
    sidebarCache.delete(MOST_DISCUSSED_KEY);
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

    clearCommentCaches();
  }

  /**
   * Everything posted from the same source as comment `id`, as the review
   * page shows it before anything is deleted: how many, how many replies from
   * elsewhere would go with them, and the newest of them.
   *
   * Null when the comment is gone or no longer has a source — its source was
   * pruned, or it was posted before sources were recorded — because then
   * there is nothing to group by and the page has nothing to offer.
   *
   * The hash is resolved from the id inside the query, here and in
   * deleteSameSource, so it never comes out of the database at all.
   */
  static async findSameSource(
    id: number,
    limit: number = SOURCE_REVIEW_LIMIT,
  ): Promise<SourceSummary | null> {
    // "otherReplies" is what the cascade would add: every descendant of the
    // source's comments, walked the way findByGameId walks a thread, minus
    // the ones the source posted itself. UNION rather than UNION ALL, so a
    // reply the source wrote to its own comment is counted once.
    const { rows: counts } = await db.query(
      `WITH RECURSIVE source AS (
         SELECT "sourceHash" FROM "comments"
         WHERE "id" = $1 AND "sourceHash" IS NOT NULL
       ), posted AS (
         SELECT c."id" FROM "comments" c
         JOIN source s ON c."sourceHash" = s."sourceHash"
       ), doomed AS (
         SELECT "id" FROM posted
         UNION
         SELECT r."id" FROM "comments" r JOIN doomed d ON r."parentId" = d."id"
       )
       SELECT (SELECT COUNT(*) FROM posted)::int AS "total",
              (SELECT COUNT(*) FROM doomed)::int AS "doomed",
              EXISTS (SELECT 1 FROM source) AS "found"`,
      [id],
    );

    const summary = counts[0];

    if (!summary?.found) return null;

    // Ordered and paged like findRecent, and joined to "games" for the same
    // reason: the page says which game each one is on.
    const { rows: comments } = await db.query(
      `SELECT c."id", c."nick", c."content", c."createdAt", c."parentId",
              g."id" AS "gameId", g."title" AS "gameTitle", g."slug" AS "gameSlug",
              TRUE AS "hasSource"
       FROM "comments" c
       JOIN "games" g ON g."id" = c."gameId"
       WHERE c."sourceHash" = (
         SELECT "sourceHash" FROM "comments" WHERE "id" = $1
       )
       ORDER BY c."id" DESC
       LIMIT $2`,
      [id, limit],
    );

    return {
      total: summary.total,
      otherReplies: summary.doomed - summary.total,
      comments: comments as RecentComment[],
    };
  }

  /**
   * Deletes every comment posted from the same source as comment `id`,
   * returning how many the source had posted.
   *
   * The same semantics as delete() above, only wider: replies go with the
   * comments they answer, whoever wrote them, because "parentId" cascades —
   * which is the point, since spam that people have answered should not
   * leave the answers behind. The count is the source's own comments; the
   * review page has already said how many replies go with them.
   *
   * Nothing is deleted when the comment has no source any more: the subquery
   * is then NULL, and "sourceHash" = NULL matches no row.
   */
  static async deleteSameSource(id: number): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM "comments"
       WHERE "sourceHash" = (
         SELECT "sourceHash" FROM "comments" WHERE "id" = $1
       )`,
      [id],
    );

    const deleted = rowCount ?? 0;

    // Exactly the caches the single delete drops, and only when something
    // went: a stale review page posted twice changes nothing, and has no
    // reason to throw away the sidebar on every machine.
    if (deleted > 0) clearCommentCaches();

    return deleted;
  }

  /**
   * Clears the source off comments past the retention window, returning how
   * many were cleared.
   *
   * The comment stays — it is public, and nothing about it is personal data
   * once nothing links it to where it came from. Only the hash goes, which is
   * the part that does link it; after this the comment can still be deleted
   * on its own, but no longer grouped with anything. The same job as
   * Game.pruneRatingIps, written the same way (see below), and called from
   * the same daily sweep in index.ts.
   *
   * No cache is dropped. The sidebar's copy of a pruned comment may go on
   * saying it has a source for its last two minutes, which only means an
   * admin who clicks in that window is told there is none.
   *
   * Served by "idx_comments_source_retention", in batches of PRUNE_BATCH_SIZE.
   */
  static async pruneSources(
    days: number = SOURCE_RETENTION_DAYS,
    batchSize: number = PRUNE_BATCH_SIZE,
  ): Promise<number> {
    let total = 0;

    for (;;) {
      // The shape Game.pruneRatingIps arrived at, for the reason written out
      // there, and it was measured here rather than assumed: the two
      // predicates are perfectly correlated — once the first window has
      // passed, every old comment has been scrubbed already — but the planner
      // multiplies them as if they were independent, and the obvious
      // `"id" IN (SELECT … LIMIT)` came out as a hash semi join over a
      // sequential scan of the whole table. With 300k comments and 4
      // eligible that was ~15ms and ~3.2k buffers, on every boot of every
      // machine; ORDER BY the index's own column plus = ANY(ARRAY(...)) walks
      // the partial index to the LIMIT and updates by primary key — 0.04ms
      // and 70 buffers for the same four rows.
      const { rowCount } = await db.query(
        `UPDATE "comments" SET "sourceHash" = NULL
         WHERE "id" = ANY(ARRAY(
           SELECT "id" FROM "comments"
           WHERE "sourceHash" IS NOT NULL
             AND "createdAt" < NOW() - make_interval(days => $1::int)
           ORDER BY "createdAt"
           LIMIT $2
         ))`,
        [days, batchSize],
      );

      const touched = rowCount ?? 0;

      total += touched;

      // A short batch means nothing eligible is left; a full one might be
      // the last, and one more query that finds nothing is how that is
      // learned.
      if (touched < batchSize) return total;
    }
  }
}

/**
 * What every comment deletion leaves stale: the Latest comments widget and
 * the "Most discussed" panel on this machine, and — through the "comments"
 * epoch — the same two on every other one. See the imports at the top of this
 * file for why each is here.
 *
 * One function, because there are two deletions now and "exactly what the
 * single delete drops" is a promise best kept by not writing it twice.
 */
function clearCommentCaches(): void {
  sidebarCache.delete(LATEST_COMMENTS_KEY);
  // As in create(): a deleted comment changes the counts behind the panel,
  // and moderation deleting a thread's root takes its replies with it.
  sidebarCache.delete(MOST_DISCUSSED_KEY);
  void bumpCacheEpoch("comments");
}
