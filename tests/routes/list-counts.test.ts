import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";
import { LISTS, countListGames } from "../../routes/lists.ts";
import { loadNonEmptyListings } from "../../middlewares/sidebar-data.ts";
import { LETTER_BUCKETS } from "../../utils/letter-buckets.ts";

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
 * loadNonEmptyListings is what every link to a listing decides by, through the
 * cache entry in middlewares/sidebar-data.ts: views/lists/lists-index.ejs and
 * the "Top Lists" block, the related-list buttons on every list, the genre
 * links in the sidebar, the error pages and the footer, and the A–Z filter.
 * It has to agree with the routes: whatever it reports is a page that answers
 * 200, and whatever it leaves out is one that answers 404 — which is the same
 * contract routes/sitemap.ts relies on countListGames for, so this checks the
 * composed answer rather than the branch arithmetic the tests above cover.
 */
describe("loadNonEmptyListings", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const listSlugs = async () =>
    (await loadNonEmptyListings()).nonEmptyListSlugs;

  it("reports nothing at all for an empty catalogue", async () => {
    const listings = await loadNonEmptyListings();

    expect(listings.nonEmptyListSlugs.size).toBe(0);
    expect(listings.nonEmptyGenres?.size).toBe(0);
    expect(listings.nonEmptyYears?.size).toBe(0);
    expect(listings.letterBuckets.filter((entry) => entry.linked)).toEqual([]);
  });

  it("names the lists a game falls into and no others", async () => {
    await Game.create({ title: "Doom", genre: "SHOOTER", release: 1993 });

    const slugs = await listSlugs();

    // Its genre list, the decade it came out in, and the unfiltered list.
    expect(slugs.has("best-shooter-games")).toBe(true);
    expect(slugs.has("dos-games-1990s")).toBe(true);
    expect(slugs.has("top-dos-games")).toBe(true);

    // And nothing else — a card or a sidebar link for any of these is a link
    // to a 404.
    expect(slugs.has("best-rpg-games")).toBe(false);
    expect(slugs.has("dos-games-1980s")).toBe(false);
  });

  it("agrees with countListGames for every list", async () => {
    await Game.create({ title: "Zork", genre: "ADVENTURE", release: 1980 });
    await Game.create({ title: "Dune II", genre: "STRATEGY", release: 1992 });

    const slugs = await listSlugs();
    const { counts } = await Game.getSitemapCounts();
    const totalGames = await Game.count();

    for (const list of LISTS) {
      expect(
        slugs.has(list.slug),
        `loadNonEmptyListings disagrees with countListGames for /${list.slug}`,
      ).toBe(countListGames(list, counts, totalGames) > 0);
    }
  });

  /**
   * The genre links, the A–Z filter and the footer's years ask the same
   * question of the same counts, and each has a route that answers it by
   * counting for itself. A genre it names is one "/<genre>" serves; a page of
   * the filter it links is one "/letter/<bucket>" serves; and the reverse.
   */
  it("agrees with Game.count() about every genre, letter page and year", async () => {
    await Game.create({ title: "1942", genre: "SHOOTER", release: 1984 });
    await Game.create({ title: "Über Racer", genre: "RACING", release: 1995 });
    await Game.create({ title: "Doom", genre: "SHOOTER", release: 1993 });
    await Game.create({ title: "Zork", genre: "ADVENTURE" });

    const listings = await loadNonEmptyListings();

    for (const genre of await Game.getGenres()) {
      expect(listings.nonEmptyGenres!.has(genre), genre).toBe(
        (await Game.count({ genre })) > 0,
      );
    }

    for (const { bucket, linked } of listings.letterBuckets) {
      expect(linked, `/letter/${bucket}`).toBe(
        (await Game.count({ letter: bucket })) > 0,
      );
    }

    expect(listings.letterBuckets.map((entry) => entry.bucket)).toEqual(
      LETTER_BUCKETS,
    );
    expect(listings.nonEmptyYears).toEqual(new Set([1984, 1995, 1993]));
    expect(listings.listingCounts?.get("genre:SHOOTER")).toBe(2);
  });
});
