import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * The two retention sweeps, against a real database.
 *
 * tests/models/game.test.ts mocks the driver, so it can say what shape the
 * statements have but not that they parse, nor which rows they touch — and
 * pruneRatingIps has been rewritten into a shape (= ANY(ARRAY(...))) the
 * mocked suite would pass whether or not Postgres accepts it.
 */
describe("Game retention sweeps", () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "ratings", "plays", "games" RESTART IDENTITY CASCADE',
    );
  });

  async function game(): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO "games" ("title", "slug", "genre")
       VALUES ('Doom', 'doom', 'ACTION') RETURNING "id"`,
    );

    return rows[0].id as number;
  }

  /** A vote cast `daysAgo` days ago, from `ip` (or none). */
  async function vote(
    gameId: number,
    voter: string,
    daysAgo: number,
    ip: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO "ratings" ("gameId", "voterId", "ipAddress", "rating", "createdAt")
       VALUES ($1, $2, $3, 4, NOW() - make_interval(days => $4::int))`,
      [gameId, voter, ip, daysAgo],
    );
  }

  describe("pruneRatingIps", () => {
    it("clears the address off the votes past the window, and only those", async () => {
      const id = await game();

      await vote(id, "old-with-ip", 120, "203.0.113.1");
      await vote(id, "old-scrubbed", 200, null);
      await vote(id, "recent", 10, "203.0.113.2");

      expect(await Game.pruneRatingIps()).toBe(1);

      const { rows } = await pool.query(
        `SELECT "voterId", "ipAddress" FROM "ratings" ORDER BY "voterId"`,
      );

      expect(rows).toEqual([
        { voterId: "old-scrubbed", ipAddress: null },
        { voterId: "old-with-ip", ipAddress: null },
        { voterId: "recent", ipAddress: "203.0.113.2" },
      ]);
    });

    // The vote is what every listing ranks by; only the address goes.
    it("keeps the votes and the totals they add up to", async () => {
      const id = await game();

      await vote(id, "a", 120, "203.0.113.1");
      await vote(id, "b", 100, "203.0.113.1");

      await Game.pruneRatingIps();

      const { rows } = await pool.query(
        `SELECT "ratingSum", "ratingCount" FROM "games" WHERE "id" = $1`,
        [id],
      );

      expect(rows[0]).toEqual({ ratingSum: 8, ratingCount: 2 });
    });

    // One batch at a time, oldest first, until one comes back short.
    it("works through a backlog in batches", async () => {
      const id = await game();

      for (let n = 0; n < 5; n++) {
        await vote(id, `old-${n}`, 100 + n, "203.0.113.1");
      }

      expect(await Game.pruneRatingIps(90, 2)).toBe(5);
      expect(await Game.pruneRatingIps(90, 2)).toBe(0);
    });
  });

  // Left as it was: see the note on prunePlays for why it never had the
  // planning problem pruneRatingIps did. This holds what it does.
  describe("prunePlays", () => {
    it("deletes the plays past the window and keeps the rest", async () => {
      const id = await game();

      await pool.query(
        `INSERT INTO "plays" ("gameId", "createdAt")
         VALUES ($1, NOW() - interval '400 days'), ($1, NOW() - interval '10 days')`,
        [id],
      );

      expect(await Game.prunePlays()).toBe(1);

      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "plays"`);

      expect(rows[0].n).toBe(1);
    });
  });
});
