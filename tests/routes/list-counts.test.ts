import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";
import { LISTS, countListGames, listLastmod } from "../../routes/lists.ts";

/**
 * countListGames answers "how many games are in this curated list?" out of the
 * counts routes/sitemap.ts already has, instead of calling Game.count() once
 * per list. That is only safe while the two agree, and nothing about the types
 * makes them: a list whose findParams/countParams grow a filter the function
 * does not know about would silently fall through to its "whole catalogue"
 * branch and the sitemap would go back to advertising a 404.
 *
 * So this checks every list in LISTS against the count() it stands in for,
 * against a real Postgres — the mocked Game suite can only inspect the SQL it
 * built, not the numbers it would return.
 */
describe("countListGames", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string, extra: Record<string, unknown> = {}) =>
    Game.create({ title, genre: "ACTION", ...extra });

  async function expectEveryListToAgree(): Promise<void> {
    const { counts } = await Game.getSitemapCounts();
    const totalGames = await Game.count();

    for (const list of LISTS) {
      expect(
        countListGames(list, counts, totalGames),
        `countListGames disagrees with Game.count() for /${list.slug}`,
      ).toBe(await Game.count(list.countParams));
    }
  }

  it("agrees with count() for every list on an empty catalogue", async () => {
    await expectEveryListToAgree();
  });

  it("agrees with count() across genres and release years", async () => {
    // Spread over both decade lists, several genres, and either side of the
    // 1980s/1990s boundary the two era lists cut on.
    await create("Doom", { genre: "SHOOTER", release: 1993 });
    await create("Quake", { genre: "SHOOTER", release: 1996 });
    await create("Ultima Underworld", { genre: "RPG", release: 1992 });
    await create("Dune II", { genre: "STRATEGY", release: 1992 });
    await create("Prince of Persia", { genre: "PLATFORMER", release: 1989 });
    await create("Bubble Bobble", { genre: "PUZZLE", release: 1987 });
    // A release of 1999 and one of 1980 sit exactly on the inclusive bounds.
    await create("Planescape Torment", { genre: "RPG", release: 1999 });
    await create("Zork", { genre: "ADVENTURE", release: 1980 });
    // No release year at all, which the year buckets exclude and the ">= AND
    // <=" count() builds excludes too — so neither era list may count it.
    await create("Unknown Year", { genre: "ACTION" });

    await expectEveryListToAgree();
  });

  it("counts nothing for a genre the catalogue has no games for", async () => {
    await create("Doom", { genre: "SHOOTER", release: 1993 });

    const { counts } = await Game.getSitemapCounts();
    const totalGames = await Game.count();

    const horror = LISTS.find((list) => list.slug === "best-horror-games")!;
    const shooter = LISTS.find((list) => list.slug === "best-shooter-games")!;

    // The pair the sitemap now decides on: one list is skipped, the other is
    // named. Zero is the whole point — it is what the route answers 404 for.
    expect(countListGames(horror, counts, totalGames)).toBe(0);
    expect(countListGames(shooter, counts, totalGames)).toBe(1);
  });

  it("counts the whole catalogue for a list with no filters", async () => {
    await create("Doom", { genre: "SHOOTER", release: 1993 });
    await create("Zork", { genre: "ADVENTURE", release: 1980 });
    await create("Unknown Year");

    const { counts } = await Game.getSitemapCounts();
    const totalGames = await Game.count();

    const top = LISTS.find((list) => list.slug === "top-dos-games")!;

    // Including the game with no release year, which the era lists drop.
    expect(countListGames(top, counts, totalGames)).toBe(3);
  });
});

/**
 * listLastmod is countListGames' twin: same three branches over `countParams`,
 * reading the lastmod half of the same GROUP BY. The pair only stays right
 * while both are taught about a new filter together, so what is checked here
 * is that each branch actually reads the group it claims to.
 */
describe("listLastmod", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const bySlug = (slug: string) => LISTS.find((list) => list.slug === slug)!;

  /**
   * Created, then stamped with a date of its own.
   *
   * The timestamps have to be stated rather than taken from NOW(): two rows
   * inserted back to back land in the same millisecond often enough, and
   * getSitemapCounts reports these through toISOString(), which keeps
   * milliseconds and drops everything finer. A test that assumes two writes
   * produce two distinct dates passes on a slow machine and fails on a fast
   * one — and it is the wrong thing to be asserting anyway. What matters is
   * that a list reads the group it claims to, which needs the dates to differ
   * by construction.
   */
  async function game(
    title: string,
    extra: Record<string, unknown>,
    updatedAt: string,
  ): Promise<void> {
    const { id } = await Game.create({ title, genre: "ACTION", ...extra });

    await pool.query('UPDATE "games" SET "updatedAt" = $1 WHERE "id" = $2', [
      updatedAt,
      id,
    ]);
  }

  it("dates a genre list from that genre alone", async () => {
    await game("Doom", { genre: "SHOOTER" }, "2024-03-05T10:00:00.000Z");
    await game("Zork", { genre: "ADVENTURE" }, "2024-07-09T10:00:00.000Z");

    const { lastmods } = await Game.getSitemapCounts();

    expect(listLastmod(bySlug("best-shooter-games"), lastmods)).toBe(
      "2024-03-05T10:00:00.000Z",
    );
    expect(listLastmod(bySlug("best-adventure-games"), lastmods)).toBe(
      "2024-07-09T10:00:00.000Z",
    );
  });

  it("takes the newest game in the genre, not the first", async () => {
    await game("Doom", { genre: "SHOOTER" }, "2024-03-05T10:00:00.000Z");
    await game("Quake", { genre: "SHOOTER" }, "2025-01-20T10:00:00.000Z");

    const { lastmods } = await Game.getSitemapCounts();

    expect(listLastmod(bySlug("best-shooter-games"), lastmods)).toBe(
      "2025-01-20T10:00:00.000Z",
    );
  });

  it("dates an era list from the newest year inside its range", async () => {
    await game(
      "Zork",
      { genre: "ADVENTURE", release: 1980 },
      "2025-06-06T10:00:00.000Z",
    );
    await game(
      "Doom",
      { genre: "SHOOTER", release: 1993 },
      "2024-03-05T10:00:00.000Z",
    );
    await game(
      "Quake",
      { genre: "SHOOTER", release: 1996 },
      "2024-11-11T10:00:00.000Z",
    );

    const { lastmods } = await Game.getSitemapCounts();

    expect(listLastmod(bySlug("dos-games-1990s"), lastmods)).toBe(
      "2024-11-11T10:00:00.000Z",
    );

    // The 1980s list must not reach into the 1990s — which is the whole point
    // of filtering the year keys rather than taking the newest of all of them,
    // and the 1980 game here is deliberately the freshest row in the table.
    expect(listLastmod(bySlug("dos-games-1980s"), lastmods)).toBe(
      "2025-06-06T10:00:00.000Z",
    );
  });

  it("dates an unfiltered list from the catalogue", async () => {
    await game(
      "Doom",
      { genre: "SHOOTER", release: 1993 },
      "2024-03-05T10:00:00.000Z",
    );

    const { lastmods } = await Game.getSitemapCounts();

    expect(
      listLastmod(
        bySlug("top-dos-games"),
        lastmods,
        "2025-05-05T00:00:00.000Z",
      ),
    ).toBe("2025-05-05T00:00:00.000Z");
  });

  /**
   * A sitemap entry may carry no lastmod at all, and routes/sitemap.ts leans
   * on that: a wrong date is worse than none, because Google stops trusting
   * the element when it does not match the page.
   */
  it("answers undefined rather than guessing when nothing is known", async () => {
    const { lastmods } = await Game.getSitemapCounts();

    expect(lastmods.size).toBe(0);
    expect(listLastmod(bySlug("best-shooter-games"), lastmods)).toBeUndefined();
    expect(listLastmod(bySlug("dos-games-1990s"), lastmods)).toBeUndefined();
    expect(listLastmod(bySlug("top-dos-games"), lastmods)).toBeUndefined();
  });
});
