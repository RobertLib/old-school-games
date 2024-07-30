import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import GameOfTheWeek from "../../models/game-of-the-week.ts";

/**
 * The weekly rotation against a real database. tests/models/game-of-the-week.test.ts
 * mocks every query and so proves the SQL text, not that it selects what it
 * claims to: that an expired pick is replaced, that the replacement is not
 * the game just featured, that a catalogue with nothing else falls back to
 * it anyway, and that two requests in one week agree.
 */
describe("Game of the week rollover", () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "comments", "ratings", "plays", "game_of_the_week", "games" RESTART IDENTITY CASCADE',
    );
  });

  async function createGame(title: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO "games" ("title", "slug", "genre") VALUES ($1, $2, 'ACTION') RETURNING "id"`,
      [title, title.toLowerCase()],
    );

    return rows[0].id;
  }

  async function expiredPick(gameId: number, daysAgo: number): Promise<void> {
    await pool.query(
      `INSERT INTO "game_of_the_week" ("gameId", "startDate", "endDate")
       VALUES ($1, NOW() - make_interval(days => $2), NOW() - make_interval(days => $2 - 7))`,
      [gameId, daysAgo],
    );
  }

  it("answers null when there is nothing to feature", async () => {
    expect(await GameOfTheWeek.getOrSelectCurrent()).toBeNull();
  });

  it("selects a game when no pick is current", async () => {
    const id = await createGame("Alpha");

    const pick = await GameOfTheWeek.getOrSelectCurrent();

    expect(pick?.gameId).toBe(id);
    expect(pick?.game?.title).toBe("Alpha");
  });

  it("replaces an expired pick with a game featured recently excluded", async () => {
    const alpha = await createGame("Alpha");
    const beta = await createGame("Beta");
    await expiredPick(alpha, 14);

    const pick = await GameOfTheWeek.getOrSelectCurrent();

    expect(pick?.gameId).toBe(beta);
  });

  it("lets a game come back once it has been out for sixty days", async () => {
    const alpha = await createGame("Alpha");
    await expiredPick(alpha, 90);

    const pick = await GameOfTheWeek.getOrSelectCurrent();

    expect(pick?.gameId).toBe(alpha);
  });

  it("falls back to a recently featured game when nothing else exists", async () => {
    const alpha = await createGame("Alpha");
    await expiredPick(alpha, 14);

    const pick = await GameOfTheWeek.getOrSelectCurrent();

    expect(pick?.gameId).toBe(alpha);
  });

  it("skips a poorly rated game while another is available", async () => {
    const alpha = await createGame("Alpha");
    const beta = await createGame("Beta");
    await pool.query(
      `INSERT INTO "ratings" ("gameId", "voterId", "rating") VALUES ($1, 'v1', 2), ($1, 'v2', 3)`,
      [alpha],
    );

    const pick = await GameOfTheWeek.getOrSelectCurrent();

    expect(pick?.gameId).toBe(beta);
  });

  it("keeps one pick for the week, however many times it is asked", async () => {
    await createGame("Alpha");
    await createGame("Beta");

    const first = await GameOfTheWeek.getOrSelectCurrent();
    const again = await Promise.all([
      GameOfTheWeek.getOrSelectCurrent(),
      GameOfTheWeek.getOrSelectCurrent(),
      GameOfTheWeek.getOrSelectCurrent(),
    ]);

    for (const pick of again) {
      expect(pick?.id).toBe(first?.id);
    }

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM "game_of_the_week"');

    expect(rows[0].n).toBe(1);
  });
});
