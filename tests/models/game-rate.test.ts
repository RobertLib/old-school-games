import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * Game.rate against a real database: what it answers for a game that is not
 * there, and the order it takes its locks in.
 */
describe("Game.rate", () => {
  let holder: PoolClient | null = null;

  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  afterEach(async () => {
    if (holder) {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      holder = null;
    }
  });

  it("records a vote, changes it, and keeps the totals with it", async () => {
    const { id } = await Game.create({ title: "Doom", genre: "ACTION" });

    expect(await Game.rate(id, "voter-1", 5, "192.0.2.1")).toBe(true);
    expect(await Game.rate(id, "voter-1", 2, "192.0.2.1")).toBe(true);

    expect(await Game.getVoterRating(id, "voter-1")).toBe(2);
    expect(await Game.getRatingSummary(id)).toEqual({
      averageRating: 2,
      ratingCount: 1,
    });
  });

  it("answers false for a game that does not exist, and writes nothing", async () => {
    expect(await Game.rate(999_999, "voter-1", 5)).toBe(false);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS "n" FROM "ratings"');

    expect(rows[0].n).toBe(0);
  });

  /**
   * The deadlock this order prevents: a changed vote used to lock its rating
   * row first (the upsert's DO UPDATE) and the game's row second (the 0042
   * trigger), while Game.delete locks the game's row first and the rating
   * rows second (its cascade). Each could end up holding what the other
   * waited for.
   *
   * So with the game's row held elsewhere, a re-vote must be waiting on
   * *that* — and must not have locked its rating row yet. NOWAIT on the
   * rating row says which: it fails at once if the vote holds it.
   */
  it("locks the game's row before the vote's, so it cannot deadlock with a delete", async () => {
    const { id } = await Game.create({ title: "Doom", genre: "ACTION" });

    await Game.rate(id, "voter-1", 5);

    holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query('SELECT 1 FROM "games" WHERE "id" = $1 FOR UPDATE', [id]);

    const revote = Game.rate(id, "voter-1", 3);

    // Until the vote's backend is waiting on a lock — the game's row.
    for (let tries = 0; ; tries++) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS "n" FROM pg_stat_activity
         WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`,
      );

      if (rows[0].n > 0) break;
      if (tries > 200) throw new Error("the re-vote never waited on a lock");

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const probe = await pool.connect();

    try {
      await probe.query("BEGIN");
      await expect(
        probe.query(
          `SELECT 1 FROM "ratings"
           WHERE "gameId" = $1 AND "voterId" = 'voter-1'
           FOR UPDATE NOWAIT`,
          [id],
        ),
      ).resolves.toBeDefined();
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }

    await holder.query("ROLLBACK");
    holder.release();
    holder = null;

    expect(await revote).toBe(true);
    expect(await Game.getVoterRating(id, "voter-1")).toBe(3);
  });

  // A delete that commits while the vote waits leaves nothing to vote on: no
  // row, so false — not a foreign-key violation, and not a deadlock.
  it("answers false when the game is deleted while the vote waits", async () => {
    const { id } = await Game.create({ title: "Doom", genre: "ACTION" });

    await Game.rate(id, "voter-1", 5);

    holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query('DELETE FROM "games" WHERE "id" = $1', [id]);

    const revote = Game.rate(id, "voter-1", 3);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await holder.query("COMMIT");
    holder.release();
    holder = null;

    expect(await revote).toBe(false);
  });
});
