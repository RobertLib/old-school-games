import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";
import {
  DIGIT_BUCKET,
  LETTER_BUCKETS,
  isLetterBucket,
} from "../../utils/letter-buckets.ts";

/**
 * The A–Z browse, against a real Postgres.
 *
 * A letter page used to list the games whose *title* began with its letter,
 * and there were only twenty-six of them — so a title beginning with anything
 * else was listed on none. "1942", "688 Attack Sub" and "Über Racer" were in
 * the catalogue and on no letter page, and Game.getSitemapCounts counted them
 * under keys ("letter:1", "letter:ü") that no route answered. A game is filed
 * by the first character of its slug now — see utils/letter-buckets.ts — and
 * what is checked here is the property that buys: every game is on exactly one
 * page, the counts name exactly the pages that exist, and the two agree.
 *
 * Against the database rather than the mocked suite, because the question is
 * which rows Postgres returns for the predicate, not what SQL was built.
 */
describe("the A–Z buckets", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string) => Game.create({ title, genre: "ACTION" });

  /** Titles that begin with a letter, a digit, a diacritic and punctuation. */
  async function seedAwkwardTitles(): Promise<void> {
    for (const title of [
      "1942",
      "688 Attack Sub",
      "Über Racer",
      '"Nam" 1965',
      "Doom",
      "doom II",
      "Zork",
      "...And Justice for All",
    ]) {
      await create(title);
    }
  }

  it("lists a title that starts with a digit on the digits' page", async () => {
    await seedAwkwardTitles();

    expect(await Game.count({ letter: DIGIT_BUCKET })).toBe(2);

    const games = await Game.find({ letter: DIGIT_BUCKET, limit: 25, page: 1 });

    expect(games.map((game) => game.title)).toEqual(["1942", "688 Attack Sub"]);
  });

  it("lists a title with a diacritic under the letter its slug starts with", async () => {
    await seedAwkwardTitles();

    const games = await Game.find({ letter: "u", limit: 25, page: 1 });

    expect(games.map((game) => game.title)).toEqual(["Über Racer"]);
  });

  it("lists a title that opens with punctuation under its first letter", async () => {
    await seedAwkwardTitles();

    expect(
      (await Game.find({ letter: "n", limit: 25, page: 1 })).map(
        (game) => game.title,
      ),
    ).toEqual(['"Nam" 1965']);
    expect(
      (await Game.find({ letter: "a", limit: 25, page: 1 })).map(
        (game) => game.title,
      ),
    ).toEqual(["...And Justice for All"]);
  });

  // A slug is lower case whatever the title was, so "Doom" and "doom II" are
  // one page — the same page "/letter/D" redirects to.
  it("ignores the case of the title and of the letter asked for", async () => {
    await seedAwkwardTitles();

    expect(await Game.count({ letter: "d" })).toBe(2);
    expect(await Game.count({ letter: "D" })).toBe(2);
  });

  it("files every game on exactly one page", async () => {
    await seedAwkwardTitles();

    const seen: number[] = [];

    for (const bucket of LETTER_BUCKETS) {
      const games = await Game.find({ letter: bucket, limit: 100, page: 1 });

      seen.push(...games.map((game) => game.id));
    }

    expect(seen).toHaveLength(await Game.count());
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * The counts the sitemap and the alphabet filter decide by. Every key they
   * produce has to be a page that exists, and every page has to be counted
   * the way its own route counts it — a key nobody serves is a URL that
   * cannot be listed, and a count that disagrees is a 404 advertised.
   */
  it("counts exactly the buckets the routes serve, as the routes count them", async () => {
    await seedAwkwardTitles();

    const { counts, lastmods } = await Game.getSitemapCounts();
    const letterKeys = [...counts.keys()].filter((key) =>
      key.startsWith("letter:"),
    );

    for (const key of letterKeys) {
      expect(isLetterBucket(key.slice("letter:".length)), key).toBe(true);
    }

    expect(counts.has("letter:1")).toBe(false);
    expect(counts.has("letter:6")).toBe(false);
    expect(counts.has("letter:ü")).toBe(false);
    expect(counts.has('letter:"')).toBe(false);
    expect(counts.has("letter:.")).toBe(false);

    for (const bucket of LETTER_BUCKETS) {
      expect(counts.get(`letter:${bucket}`) ?? 0, bucket).toBe(
        await Game.count({ letter: bucket }),
      );
    }

    expect(lastmods.has(`letter:${DIGIT_BUCKET}`)).toBe(true);
  });

  /**
   * The digits' page is a range over the slug rather than a LIKE, and a range
   * has edges: "-" sorts just below "0" and ":" just above "9". Neither can
   * begin a slug slugify() writes, but a slug inserted by hand could — so it
   * is checked that the edges are where the digits end, not where a guess put
   * them.
   */
  it("draws the digits' page at exactly the digits", async () => {
    for (const slug of ["-dash", "0-zero", "9-nine", ":colon", "a-letter"]) {
      // Two parameters for the one value: "title" is VARCHAR and "slug" TEXT,
      // and Postgres will not deduce two types for a single $1.
      await pool.query(
        `INSERT INTO "games" ("title", "slug", "genre") VALUES ($1, $2, 'ACTION')`,
        [slug, slug],
      );
    }

    const games = await Game.find({ letter: DIGIT_BUCKET, limit: 25, page: 1 });

    expect(games.map((game) => game.slug).sort()).toEqual(["0-zero", "9-nine"]);
  });
});

describe("0055 — the slug pattern index", () => {
  it("indexes the slug in byte order, which is what a prefix range needs", async () => {
    const { rows } = await pool.query(
      `SELECT "indexdef" FROM "pg_indexes"
       WHERE "tablename" = 'games' AND "indexname" = 'idx_games_slug_pattern'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("text_pattern_ops");
    expect(rows[0].indexdef).toContain("(slug text_pattern_ops)");
  });
});
