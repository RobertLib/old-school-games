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
});
