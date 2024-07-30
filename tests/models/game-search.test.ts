import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * Searching against a real database.
 *
 * The rest of the Game suite mocks the driver, so it only ever inspects the
 * SQL string that was built — it cannot tell whether Postgres accepts it. That
 * blind spot is real: find() ranks its results and count() does not, so the two
 * build different statements from the same search, and a parameter added for
 * the ranking left count() supplying one more value than its statement uses.
 * Postgres rejects that outright, and every mocked test still passed.
 */
describe("Game search", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string, extra: Record<string, unknown> = {}) =>
    Game.create({ title, genre: "ACTION", ...extra });

  it("runs find and count over the same search", async () => {
    await create("Doom");
    await create("Quake");

    await expect(
      Game.find({ search: "doom", limit: 25 }),
    ).resolves.toHaveLength(1);
    await expect(Game.count({ search: "doom" })).resolves.toBe(1);
  });

  it("runs a search alongside paging and an explicit sort", async () => {
    await create("Doom");
    await create("Doom II");

    const games = await Game.find({
      search: "doom",
      limit: 1,
      page: 2,
      orderBy: "title",
      orderDir: "ASC",
    });

    expect(games).toHaveLength(1);
    expect(games[0]!.title).toBe("Doom II");
  });

  it("matches the developer and the publisher, not only the title", async () => {
    await create("Wolfenstein 3D", { developer: "id Software" });
    await create("Quake", { publisher: "GT Interactive" });

    await expect(Game.count({ search: "id Software" })).resolves.toBe(1);
    await expect(Game.count({ search: "GT Interactive" })).resolves.toBe(1);
  });

  // "%" and "_" are ILIKE wildcards. Left as they were, "100%" behaved like a
  // search for "100" and a lone "_" returned the entire catalogue.
  it("treats wildcards in the query as literal characters", async () => {
    await create("Lemmings 100% Edition");
    await create("Doom");
    await create("Quake");

    await expect(Game.count({ search: "%" })).resolves.toBe(1);
    await expect(Game.count({ search: "_" })).resolves.toBe(0);
    await expect(Game.count({ search: "100%" })).resolves.toBe(1);

    const games = await Game.find({ search: "100%", limit: 25 });
    expect(games.map((game) => game.title)).toEqual(["Lemmings 100% Edition"]);
  });

  it("still finds a game whose title really does contain a wildcard", async () => {
    await create("Snake_Case");
    await create("Doom");

    // Only the one, and found by the literal underscore rather than in spite
    // of it. Nothing is asserted about a near-miss like "SnakeXCase": the
    // trigram match would find that whatever the ILIKE pattern does, which is
    // the point of having it.
    await expect(Game.count({ search: "Snake_Case" })).resolves.toBe(1);
  });

  it("ranks an exact title above an incidental match", async () => {
    await create("Doom");
    await create("Ultimate Doom Collection");

    const games = await Game.find({ search: "doom", limit: 25 });

    expect(games[0]!.title).toBe("Doom");
  });

  it("finds a game through a typo", async () => {
    await create("The Secret of Monkey Island");

    const games = await Game.find({ search: "moneky island", limit: 25 });

    expect(games.map((game) => game.title)).toContain(
      "The Secret of Monkey Island",
    );
  });

  /**
   * The fuzzy arm is pg_trgm's "%" now rather than "similarity(...) > 0.28",
   * which says the same thing and cannot be served by the GIN index from
   * 0020 — so every search was a sequential scan of the catalogue. The
   * operator compares against a session setting, so the statement runs inside
   * a transaction that sets it; these cases are what says the threshold
   * actually arrives.
   */
  describe("the trigram threshold", () => {
    it("still refuses a term too far from any title", async () => {
      await create("The Secret of Monkey Island");

      // Nothing in common but a few letters: below the threshold, so no
      // match — a default threshold of 0.3 or a missing one would be a
      // different answer here.
      await expect(Game.count({ search: "xyzzyplugh" })).resolves.toBe(0);
    });

    /**
     * Two searches in a row, because the threshold is set with SET LOCAL and
     * a pooled connection is handed straight back. A setting that leaked would
     * make the second search behave differently from the first — and a
     * threshold that never arrived would make the typo case above fail only
     * sometimes, depending on which connection answered.
     */
    it("gives the same answer twice running", async () => {
      await create("The Secret of Monkey Island");

      await expect(Game.count({ search: "moneky island" })).resolves.toBe(1);
      await expect(Game.count({ search: "moneky island" })).resolves.toBe(1);
      await expect(Game.count({ search: "xyzzyplugh" })).resolves.toBe(0);
    });

    // The suggestions run at a much looser threshold of their own, so a term
    // the search itself rejects still gets a guess.
    it("suggests titles at a looser threshold than the search", async () => {
      await create("The Secret of Monkey Island");

      const suggestions = await Game.findTitleSuggestions("monkey", 5);

      expect(suggestions.map((game) => game.title)).toContain(
        "The Secret of Monkey Island",
      );
    });
  });

  /**
   * find() pages the games before it joins the rating aggregates on for every
   * ordering but the rating one, so the two shapes have to return the same
   * rows in the same order — and count() has to agree with both, or a listing
   * advertises pages it then answers with a 404.
   */
  describe("paging agrees with counting", () => {
    beforeEach(async () => {
      for (let n = 0; n < 5; n++) {
        await create(`Paged ${n}`, {
          developer: "Shared Dev",
          publisher: "Shared Pub",
          release: 1991,
        });
      }
    });

    it.each([
      ["genre", { genre: "ACTION" }],
      ["letter", { letter: "P" }],
      ["developer", { developer: "Shared Dev" }],
      ["publisher", { publisher: "Shared Pub" }],
      ["year", { year: 1991 }],
      ["release range", { releaseFrom: 1990, releaseTo: 1992 }],
      ["search", { search: "Paged" }],
    ])("walks every page of a %s filter exactly once", async (_label, filter) => {
      const total = await Game.count(filter as any);

      expect(total).toBe(5);

      const seen: number[] = [];

      for (let page = 1; page <= 3; page++) {
        const games = await Game.find({ ...(filter as any), limit: 2, page });

        seen.push(...games.map((game) => game.id));
      }

      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it("carries the rating aggregates onto the page it returns", async () => {
      const [first] = await Game.find({ letter: "P", limit: 1 });

      await Game.rate(first!.id, "voter-1", 5, "127.0.0.1");

      const [again] = await Game.find({ letter: "P", limit: 1 });

      expect(again!.averageRating).toBe(5);
      expect(again!.ratingCount).toBe(1);
    });

    // An unrated game reads as 0 and 0 rather than as null, which is what the
    // joined COALESCE(AVG(...), 0) produced and what the views print.
    it("reads an unrated game as zero, not null", async () => {
      const [game] = await Game.find({ letter: "P", limit: 1 });

      expect(game!.averageRating).toBe(0);
      expect(game!.ratingCount).toBe(0);
    });

    // Same rows, same order, whichever shape the ordering chose.
    it("orders a rating-ranked page the same way it counts it", async () => {
      const games = await Game.find({ orderBy: "rating", limit: 3 });
      const total = await Game.count({});

      expect(total).toBe(5);
      expect(games).toHaveLength(3);
    });
  });
});
