import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.ts";
import News from "../models/news.ts";

/**
 * The migrations in this batch that change data rather than only schema, run
 * again against a state they exist to repair. 0052 and 0053 are idempotent —
 * a migration runs once, but a repair that can safely run twice is one that
 * cannot make things worse on a database it finds already correct. 0054
 * installs triggers as well as backfilling, so it is replayed rather than
 * rerun; see there.
 */
const MIGRATIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

async function run(file: string): Promise<void> {
  const sql = await readFile(path.join(MIGRATIONS, file), "utf8");
  const client = await pool.connect();

  // In a transaction, as the runner applies it: LOCK TABLE means nothing
  // outside one.
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await pool.query(
    'TRUNCATE "ratings", "games", "news", "users" RESTART IDENTITY CASCADE',
  );
});

async function insertGame(slug: string): Promise<number> {
  const { rows } = await pool.query(
    // Two parameters for one value: "title" is VARCHAR and "slug" is TEXT, and
    // Postgres will not deduce one type for a parameter used as both.
    `INSERT INTO "games" ("title", "slug", "genre") VALUES ($1, $2, 'ACTION')
     RETURNING "id"`,
    [slug, slug],
  );

  return rows[0].id as number;
}

describe("0052 — recomputing the rating totals", () => {
  /**
   * 0042's backfill and its trigger left a window in which a changed vote was
   * counted by neither, leaving a total that disagrees with the ratings and
   * still passes the CHECK constraint.
   */
  it("puts totals that drifted back in step with the ratings", async () => {
    const drifted = await insertGame("drifted");
    const correct = await insertGame("correct");

    await pool.query(
      `INSERT INTO "ratings" ("gameId", "rating", "voterId")
       VALUES ($1, 5, 'a'), ($1, 3, 'b'), ($2, 4, 'a')`,
      [drifted, correct],
    );
    // Drift, the way 0042's window produced it: a total the trigger was not
    // there to correct. The trigger is on "ratings", so this write is not seen.
    await pool.query(
      `UPDATE "games" SET "ratingSum" = 2, "ratingCount" = 2 WHERE "id" = $1`,
      [drifted],
    );

    await run("0052_games_rating_totals_recompute.sql");

    const { rows } = await pool.query(
      `SELECT "id", "ratingSum", "ratingCount" FROM "games" ORDER BY "id"`,
    );

    expect(rows).toEqual([
      { id: drifted, ratingSum: 8, ratingCount: 2 },
      { id: correct, ratingSum: 4, ratingCount: 1 },
    ]);
  });

  it("zeroes a game whose votes are all gone", async () => {
    const game = await insertGame("forgotten");

    await pool.query(
      `UPDATE "games" SET "ratingSum" = 5, "ratingCount" = 1 WHERE "id" = $1`,
      [game],
    );

    await run("0052_games_rating_totals_recompute.sql");

    const { rows } = await pool.query(
      `SELECT "ratingSum", "ratingCount" FROM "games" WHERE "id" = $1`,
      [game],
    );

    expect(rows[0]).toEqual({ ratingSum: 0, ratingCount: 0 });
  });
});

describe("0053 — the current slug in its own history", () => {
  it("records the slug of a row that never went through a model", async () => {
    const game = await insertGame("hand-made");

    await pool.query(
      `INSERT INTO "news" ("title", "slug", "content") VALUES ('N', 'n', 'x')`,
    );

    // The state 0053 was written for: a live slug and no history row. 0054's
    // triggers record one as the row goes in, so it is taken away again —
    // which is exactly what a row inserted before those triggers looks like.
    await pool.query(`DELETE FROM "game_slugs"`);
    await pool.query(`DELETE FROM "news_slugs"`);

    await run("0053_slug_history_backfill_current.sql");
    // And again: every row it would add is there now.
    await run("0053_slug_history_backfill_current.sql");

    const games = await pool.query(
      `SELECT "gameId", "slug" FROM "game_slugs"`,
    );
    const news = await pool.query(`SELECT "slug" FROM "news_slugs"`);

    expect(games.rows).toEqual([{ gameId: game, slug: "hand-made" }]);
    expect(news.rows).toEqual([{ slug: "n" }]);
  });
});

describe("0054 — every live slug kept in its own history", () => {
  /**
   * 0054 creates functions and triggers, so unlike the two repairs above it
   * cannot simply be run a second time. It is replayed instead against the
   * state it was written for — the triggers not there yet, and rows that
   * have a live slug the history has never seen — inside a transaction that
   * is rolled back afterwards, which puts the real triggers back exactly as
   * the migration runner left them.
   */
  async function replay(
    arrange: (client: import("pg").PoolClient) => Promise<void>,
    assert: (client: import("pg").PoolClient) => Promise<void>,
  ): Promise<void> {
    const sql = await readFile(
      path.join(MIGRATIONS, "0054_slug_history_triggers.sql"),
      "utf8",
    );
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`
        DROP TRIGGER "games_record_slug_history" ON "games";
        DROP TRIGGER "news_record_slug_history" ON "news";
        DROP FUNCTION "record_game_slug_history"();
        DROP FUNCTION "record_news_slug_history"();
      `);
      await arrange(client);
      await client.query(sql);
      await assert(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("backfills the rows written without a model since 0053", async () => {
    await replay(
      async (client) => {
        await client.query(
          `INSERT INTO "games" ("id", "title", "slug", "genre")
           VALUES (1, 'Quake', 'quake', 'ACTION')`,
        );
        await client.query(
          `INSERT INTO "news" ("id", "title", "slug", "content")
           VALUES (1, 'Hand made', 'hand-made', 'x')`,
        );
      },
      async (client) => {
        const games = await client.query(
          `SELECT "gameId", "slug" FROM "game_slugs"`,
        );
        const news = await client.query(
          `SELECT "newsId", "slug" FROM "news_slugs"`,
        );

        expect(games.rows).toEqual([{ gameId: 1, slug: "quake" }]);
        expect(news.rows).toEqual([{ newsId: 1, slug: "hand-made" }]);
      },
    );
  });

  // Only a missing live slug is added, and after everything recorded before
  // it — so a game renamed by hand keeps the slug it was created with first.
  it("adds a live slug changed by hand after the history it already had", async () => {
    await replay(
      async (client) => {
        await client.query(
          `INSERT INTO "games" ("id", "title", "slug", "genre")
           VALUES (1, 'Doom', 'doom', 'ACTION')`,
        );
        await client.query(
          `INSERT INTO "game_slugs" ("gameId", "slug") VALUES (1, 'doom')`,
        );
        await client.query(
          `UPDATE "games" SET "slug" = 'doom-by-hand' WHERE "id" = 1`,
        );
      },
      async (client) => {
        const { rows } = await client.query(
          `SELECT "slug" FROM "game_slugs" WHERE "gameId" = 1 ORDER BY "id"`,
        );

        expect(rows.map((row) => row.slug)).toEqual(["doom", "doom-by-hand"]);
      },
    );
  });

  it("installs the triggers that keep it that way", async () => {
    await replay(
      async () => {},
      async (client) => {
        await client.query(
          `INSERT INTO "games" ("id", "title", "slug", "genre")
           VALUES (7, 'Hexen', 'hexen', 'ACTION')`,
        );
        await client.query(
          `UPDATE "games" SET "slug" = 'hexen-by-hand' WHERE "id" = 7`,
        );
        await client.query(
          `INSERT INTO "news" ("id", "title", "slug", "content")
           VALUES (7, 'Article', 'article', 'x')`,
        );

        const games = await client.query(
          `SELECT "slug" FROM "game_slugs" WHERE "gameId" = 7 ORDER BY "id"`,
        );
        const news = await client.query(
          `SELECT "slug" FROM "news_slugs" WHERE "newsId" = 7`,
        );

        expect(games.rows.map((row) => row.slug)).toEqual([
          "hexen",
          "hexen-by-hand",
        ]);
        expect(news.rows).toEqual([{ slug: "article" }]);
      },
    );
  });

  /**
   * The failure the triggers exist for, on the table that has no suite of
   * its own here: resolveSlug asks the history alone, so a hand-inserted
   * article's slug used to be invisible to it, and a new article under the
   * same title collided on "news_slug_unique" five times over — the 500 page,
   * with the admin's article gone. Games are covered in
   * tests/models/game-slugs.test.ts.
   */
  it("lets an article take a title whose slug a hand-inserted one holds", async () => {
    const { rows: users } = await pool.query(
      `INSERT INTO "users" ("email", "password", "role")
       VALUES ('admin@example.com', 'x', 'ADMIN') RETURNING "id"`,
    );
    const userId = users[0].id as number;

    await pool.query(
      `INSERT INTO "news" ("title", "slug", "content")
       VALUES ('Patch notes', 'patch-notes', 'x')`,
    );

    const created = await News.create({
      title: "Patch notes",
      content: "<p>x</p>",
      userId,
    });
    const other = await News.create({
      title: "Something else",
      content: "<p>x</p>",
      userId,
    });
    const renamed = await News.update(other.id, {
      title: "Patch notes",
      content: "<p>x</p>",
    });

    expect(created.slug).toBe("patch-notes-2");
    expect(renamed?.slug).toBe("patch-notes-3");
  });

  /**
   * News.update still records the outgoing slug beside the new one, in one
   * INSERT … UNION whose output order decided their ids — so the first rename
   * of a hand-inserted article to a title sorting earlier made the new slug
   * its "first", and the news feed re-announced it under a new guid. With the
   * trigger the outgoing slug is always recorded already, so that half of the
   * UNION inserts nothing and cannot come first.
   */
  it("keeps a hand-inserted article's slug first through its first rename", async () => {
    const { rows } = await pool.query(
      `INSERT INTO "news" ("title", "slug", "content")
       VALUES ('Zeta', 'zeta-by-hand', 'x') RETURNING "id"`,
    );
    const id = rows[0].id as number;

    await News.update(id, { title: "Alpha", content: "<p>x</p>" });

    expect((await News.findFirstSlugs([id])).get(id)).toBe("zeta-by-hand");
    expect(await News.findCurrentSlug("zeta-by-hand")).toBe("alpha");
  });
});

describe("0051 — the neighbour index", () => {
  it("replaces the single-column title index with the composite one", async () => {
    const { rows } = await pool.query(
      `SELECT "indexname" FROM "pg_indexes"
       WHERE "tablename" = 'games'
         AND "indexname" IN ('idx_games_title_lower', 'idx_games_title_lower_id')`,
    );

    expect(rows.map((row) => row.indexname)).toEqual([
      "idx_games_title_lower_id",
    ]);
  });
});

describe("0057 — voters' addresses out of the legacy voter ids", () => {
  it("replaces every 'ip:' voter id and leaves browser ids alone", async () => {
    const gameId = await insertGame("doom");
    const otherId = await insertGame("quake");
    const browser = "0f8fad5b-d9cb-469f-a165-70867728950e";

    await pool.query(
      `INSERT INTO "ratings" ("gameId", "rating", "voterId", "ipAddress")
       VALUES ($1, 5, 'ip:203.0.113.7', NULL),
              ($2, 2, 'ip:203.0.113.7', NULL),
              ($1, 3, $3, '198.51.100.1')`,
      [gameId, otherId, browser],
    );

    await run("0057_ratings_legacy_voter_ids.sql");

    const { rows } = await pool.query(
      `SELECT "id", "gameId", "voterId", "rating" FROM "ratings" ORDER BY "id"`,
    );

    expect(rows).toEqual([
      { id: 1, gameId, voterId: "legacy:1", rating: 5 },
      { id: 2, gameId: otherId, voterId: "legacy:2", rating: 2 },
      { id: 3, gameId, voterId: browser, rating: 3 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
  });

  // The 0042 trigger fires on this UPDATE; the vote's value and its game are
  // the same, so the totals must come through exactly as they were.
  it("leaves the rating totals as they were", async () => {
    const gameId = await insertGame("doom");

    await pool.query(
      `INSERT INTO "ratings" ("gameId", "rating", "voterId")
       VALUES ($1, 5, 'ip:203.0.113.7'), ($1, 1, 'ip:203.0.113.8')`,
      [gameId],
    );

    await run("0057_ratings_legacy_voter_ids.sql");

    const { rows } = await pool.query(
      `SELECT "ratingSum", "ratingCount" FROM "games" WHERE "id" = $1`,
      [gameId],
    );

    expect(rows[0]).toEqual({ ratingSum: 6, ratingCount: 2 });
  });

  it("finds nothing to do the second time", async () => {
    const gameId = await insertGame("doom");

    await pool.query(
      `INSERT INTO "ratings" ("gameId", "rating", "voterId")
       VALUES ($1, 4, 'ip:203.0.113.7')`,
      [gameId],
    );

    await run("0057_ratings_legacy_voter_ids.sql");
    await run("0057_ratings_legacy_voter_ids.sql");

    const { rows } = await pool.query(`SELECT "voterId" FROM "ratings"`);

    expect(rows).toEqual([{ voterId: "legacy:1" }]);
  });
});

describe("0058 — 0054's backfill once more", () => {
  /**
   * The state an earlier text of 0054 could have left: a live slug missing
   * from its history. The triggers record every write now, so the row is
   * taken out of the history directly — "game_slugs" has no trigger of its
   * own.
   */
  it("puts back a live slug missing from its history", async () => {
    const gameId = await insertGame("quake");
    const { rows: news } = await pool.query(
      `INSERT INTO "news" ("title", "slug", "content")
       VALUES ('Hidden', 'hidden', 'x') RETURNING "id"`,
    );

    await pool.query(`DELETE FROM "game_slugs" WHERE "gameId" = $1`, [gameId]);
    await pool.query(`DELETE FROM "news_slugs" WHERE "newsId" = $1`, [
      news[0].id,
    ]);

    await run("0058_slug_history_backfill_again.sql");

    const games = await pool.query(`SELECT "gameId", "slug" FROM "game_slugs"`);
    const articles = await pool.query(
      `SELECT "newsId", "slug" FROM "news_slugs"`,
    );

    expect(games.rows).toEqual([{ gameId, slug: "quake" }]);
    expect(articles.rows).toEqual([{ newsId: news[0].id, slug: "hidden" }]);
  });

  it("adds nothing where the history is already complete", async () => {
    await insertGame("doom");

    const before = await pool.query(
      `SELECT "id", "gameId", "slug" FROM "game_slugs" ORDER BY "id"`,
    );

    await run("0058_slug_history_backfill_again.sql");

    const after = await pool.query(
      `SELECT "id", "gameId", "slug" FROM "game_slugs" ORDER BY "id"`,
    );

    expect(after.rows).toEqual(before.rows);
  });
});

/**
 * What 0059's header gets wrong, written down here because an applied
 * migration cannot be edited — the runner records its checksum, and a
 * changed comment is a changed file.
 *
 * - "A '<' marks the re-serialising path" holds one way only. DOMPurify drops
 *   the tags it does not keep, so a re-serialised comment can be left with no
 *   "<" at all — "Tom & Jerry <sarcasm>no</sarcasm>" was stored as "Tom &amp;
 *   Jerry no" — and 0059 skipped those. The other way, 0023 turned a typed
 *   "&lt;" into "<" in fast-path comments, so a comment that never went
 *   through it can have one, and 0059 decoded the "&amp;" its writer typed.
 * - "Sanitizing stopped when 0023 was applied" is the release command's view.
 *   The old release went on serving while it ran, so a comment posted in that
 *   window was sanitized and dated after 0023, and neither migration
 *   touched it.
 * - DOMPurify parses entities before it serialises, so a typed "&nbsp;" came
 *   out as "&nbsp;" — the no-break space — not "&amp;nbsp;". The REPLACE
 *   order matters only for an entity typed already escaped, and the header's
 *   "Not repairable" list is longer than it says.
 *
 * Checked against production after it ran, on 2026-10-02: 43 comments, none
 * of them showing a literal entity. Nothing is left for a follow-up
 * migration to repair, so none was written; the cases below pin what 0059
 * does, not what its header claims.
 */
describe("0059 — the entities 0023 left behind", () => {
  /** A comment as it was stored, dated relative to when 0023 was applied. */
  async function insertComment(
    gameId: number,
    content: string,
    when: "before 0023" | "after 0023",
    nick = "anonymous",
  ): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO "comments" ("gameId", "content", "nick", "createdAt")
       SELECT $1, $2, $3, "appliedAt" + $4::interval
       FROM "migrations"
       WHERE "name" = '0023_unescape_comment_entities.sql'
       RETURNING "id"`,
      [gameId, content, nick, when === "before 0023" ? "-1 day" : "1 second"],
    );

    return rows[0].id as number;
  }

  async function stored(id: number): Promise<{ content: string; nick: string }> {
    const { rows } = await pool.query(
      'SELECT "content", "nick" FROM "comments" WHERE "id" = $1',
      [id],
    );

    return rows[0];
  }

  /**
   * DOMPurify re-serialised anything with a "<" in it, which escapes "&" and
   * U+00A0 as well as the angle brackets. 0023 reversed only the brackets, so
   * "<3 Tom & Jerry" — stored as "&lt;3 Tom &amp; Jerry" — has rendered as
   * "<3 Tom &amp; Jerry" ever since.
   */
  it("decodes what re-serialising escaped, on the comments that went through it", async () => {
    const game = await insertGame("doom");
    const id = await insertComment(
      game,
      "<3 Tom &amp; Jerry&nbsp;forever",
      "before 0023",
      "<b>&amp;co",
    );

    await run("0059_comments_reserialized_entities.sql");

    expect(await stored(id)).toEqual({
      content: "<3 Tom & Jerry forever",
      nick: "<b>&co",
    });
  });

  // DOMPurify's fast path: no "<", so the comment was stored exactly as it
  // was typed, and its "&amp;" is the writer's own.
  it("leaves a comment with no '<' alone", async () => {
    const game = await insertGame("doom");
    const id = await insertComment(game, "a &amp; b > c", "before 0023");

    await run("0059_comments_reserialized_entities.sql");

    expect((await stored(id)).content).toBe("a &amp; b > c");
  });

  // Sanitizing had stopped by then, so this is what somebody wrote.
  it("leaves a comment written after 0023 alone", async () => {
    const game = await insertGame("doom");
    const id = await insertComment(game, "<3 &amp;", "after 0023");

    await run("0059_comments_reserialized_entities.sql");

    expect((await stored(id)).content).toBe("<3 &amp;");
  });

  /**
   * "&nbsp;" before "&amp;", so an entity stored escaped twice comes back one
   * level down rather than two: "&amp;nbsp;" — what a writer who typed
   * "&amp;nbsp;" was stored as — becomes the text "&nbsp;", where the other
   * order would make it a no-break space. (A writer who typed "&nbsp;" itself
   * was not stored this way: DOMPurify parses the entity first. See above.)
   */
  it("decodes an entity stored escaped twice one level, not two", async () => {
    const game = await insertGame("doom");
    const id = await insertComment(
      game,
      "<p> &amp;nbsp; &amp;amp; &amp;lt;",
      "before 0023",
    );

    await run("0059_comments_reserialized_entities.sql");

    expect((await stored(id)).content).toBe("<p> &nbsp; &amp; &lt;");
  });

  // One level and no more. Unlike 0052 and 0053 this is not safe to run
  // twice — a second pass would decode the "&amp;" the first one gave back —
  // which is fine for a migration, since the runner applies it once.
  it("decodes exactly one level of escaping", async () => {
    const game = await insertGame("doom");
    const id = await insertComment(game, "<3 &amp;amp;", "before 0023");

    await run("0059_comments_reserialized_entities.sql");

    expect((await stored(id)).content).toBe("<3 &amp;");
  });
});
