import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * How the catalogue ranks games by rating, against a real database.
 *
 * The mocked Game suite can only read back the SQL that was built, so it can
 * say the ordering mentions the site mean but not what the ordering actually
 * produces. The bug this guards was invisible from that angle: findTopRated
 * weighted small vote counts down and find() did not, so /top-dos-games put a
 * game with one five-star vote above a game with two hundred votes averaging
 * 4.9 — while the "Top rated" widget rendered beside it, running the other
 * query, disagreed.
 */
describe("Game rating ranking", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const rate = async (gameId: number, votes: number[]) => {
    for (const [index, rating] of votes.entries()) {
      await Game.rate(gameId, `voter-${gameId}-${index}`, rating);
    }
  };

  /**
   * Enough ordinary games for the site mean to sit where a real catalogue's
   * does. With only the two contenders in the table the mean is dragged up to
   * meet them and the weighting has nothing left to pull against — which is
   * exactly how this bug survives a two-row fixture.
   */
  const seedOrdinaryGames = async () => {
    for (let n = 0; n < 20; n++) {
      const { id } = await Game.create({
        title: `Ordinary ${n}`,
        genre: "ACTION",
      });

      await rate(id, [1, 2, 3, 4, 5, 3, 3, 2, 4, 3]);
    }
  };

  const seedContenders = async () => {
    const lucky = await Game.create({ title: "One Vote Wonder", genre: "RPG" });
    const loved = await Game.create({ title: "Beloved Classic", genre: "RPG" });

    await rate(lucky.id, [5]);
    await rate(
      loved.id,
      Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? 4 : 5)),
    );

    return { lucky, loved };
  };

  it("puts weight of evidence above a lone perfect vote", async () => {
    await seedOrdinaryGames();
    const { loved } = await seedContenders();

    const ranked = await Game.find({ orderBy: "rating", orderDir: "DESC" });

    expect(ranked[0]!.title).toBe("Beloved Classic");
    // The raw average really is the lower of the two, so this is the
    // weighting talking and not a coincidence of the fixture.
    expect(ranked[0]!.averageRating).toBeLessThan(5);
    expect(ranked[0]!.id).toBe(loved.id);
  });

  it("agrees with the widget rendered beside it", async () => {
    await seedOrdinaryGames();
    await seedContenders();

    const [list, widget] = await Promise.all([
      Game.find({ orderBy: "rating", orderDir: "DESC", limit: 5 }),
      Game.findTopRated(),
    ]);

    expect(list[0]!.title).toBe(widget[0]!.title);
  });

  it("weighs the default ordering the homepage uses as well", async () => {
    await seedOrdinaryGames();
    await seedContenders();

    // No orderBy at all — the branch the homepage and the genre pages fall
    // through to, which sorted on the plain average just the same.
    const ranked = await Game.find({});

    expect(ranked[0]!.title).toBe("Beloved Classic");
  });

  it("keeps unrated games at the bottom of a descending sort", async () => {
    await seedOrdinaryGames();
    await Game.create({ title: "Nobody Voted", genre: "PUZZLE" });

    const ranked = await Game.find({ orderBy: "rating", orderDir: "DESC" });

    // The prior would be the better estimate of a game with no votes, but a
    // list titled "top rated" is not the place to float one above the games
    // people actually rated.
    expect(ranked.at(-1)!.title).toBe("Nobody Voted");
    expect(ranked.at(-1)!.ratingCount).toBe(0);
  });

  it("ranks an empty ratings table without dropping any game", async () => {
    await Game.create({ title: "Unrated One", genre: "ACTION" });
    await Game.create({ title: "Unrated Two", genre: "ACTION" });

    // The site mean is NULL when nothing has been rated, and a CROSS JOIN on
    // a row that does not exist would return no games at all.
    const ranked = await Game.find({ orderBy: "rating", orderDir: "DESC" });

    expect(ranked).toHaveLength(2);
  });

  /**
   * The "Similar games" strip, which was the one rating-ordered query left on
   * the plain average — so a reader on a game's page was shown a strip led by
   * whichever genre-mate one person had rated once, beside a sidebar running
   * the weighted query and disagreeing with it. That is the same visible
   * contradiction the two tests above guard for /top-dos-games.
   */
  describe("findSimilar", () => {
    it("puts weight of evidence above a lone perfect vote", async () => {
      await seedOrdinaryGames();
      const { lucky, loved } = await seedContenders();

      // A third RPG to be the game whose page this strip is on, so neither
      // contender is the one excluded by id.
      const subject = await Game.create({ title: "The Subject", genre: "RPG" });

      const similar = await Game.findSimilar(subject.id, "RPG", 6);

      expect(similar.map((game) => game.id)).toEqual([loved.id, lucky.id]);
      expect(similar[0]!.averageRating).toBeLessThan(5);
    });

    it("agrees with the ranking the rest of the site uses", async () => {
      await seedOrdinaryGames();
      await seedContenders();
      const subject = await Game.create({ title: "The Subject", genre: "RPG" });

      const [strip, ranked] = await Promise.all([
        Game.findSimilar(subject.id, "RPG", 6),
        Game.find({ genre: "RPG", orderBy: "rating", orderDir: "DESC" }),
      ]);

      expect(strip[0]!.title).toBe(
        ranked.find((game) => game.id !== subject.id)!.title,
      );
    });

    it("still offers a genre-mate nobody has voted on, last", async () => {
      await seedOrdinaryGames();
      const { loved } = await seedContenders();
      const subject = await Game.create({ title: "The Subject", genre: "RPG" });
      const unrated = await Game.create({ title: "Nobody Voted", genre: "RPG" });

      // The join stays LEFT on purpose: an unrated game still belongs in the
      // strip, it just scores 0 and sorts last — which is where the old
      // "NULLS LAST" put it too.
      const similar = await Game.findSimilar(subject.id, "RPG", 6);

      expect(similar[0]!.id).toBe(loved.id);
      expect(similar.at(-1)!.id).toBe(unrated.id);
    });

    it("leaves the game its own page is about out of it", async () => {
      const subject = await Game.create({ title: "The Subject", genre: "RPG" });
      await Game.create({ title: "Another RPG", genre: "RPG" });

      const similar = await Game.findSimilar(subject.id, "RPG", 6);

      expect(similar.map((game) => game.id)).not.toContain(subject.id);
    });
  });
});
