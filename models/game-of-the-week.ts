import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import Game from "./game.ts";

interface GameOfTheWeekData extends ModelData {
  gameId: number;
  startDate: Date | string;
  endDate: Date | string;
}

/** Satisfied by both the pool and a single client checked out of it. */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// Arbitrary, but must be the same in every process for the lock to mean
// anything.
const SELECTION_LOCK_KEY = 8612004;

export default class GameOfTheWeek extends Model {
  gameId: number;
  startDate: Date | string;
  endDate: Date | string;
  game?: Game;

  constructor(data: GameOfTheWeekData) {
    super(data);
    this.gameId = data.gameId;
    this.startDate = data.startDate;
    this.endDate = data.endDate;
  }

  static async getCurrent(): Promise<GameOfTheWeek | null> {
    const { rows } = await db.query(
      `SELECT * FROM "game_of_the_week"
       WHERE NOW() BETWEEN "startDate" AND "endDate"
       ORDER BY "startDate" DESC
       LIMIT 1`,
    );

    if (!rows.length) {
      return null;
    }

    const gameOfTheWeek = new GameOfTheWeek(rows[0]);
    const game = await Game.findById(gameOfTheWeek.gameId);

    if (game) {
      // findById already returns the average and the vote count as numbers;
      // re-fetching the average here replaced it with a raw numeric string.
      gameOfTheWeek.game = game;
    }

    return gameOfTheWeek;
  }

  static async selectNewGameOfTheWeek(
    executor: Queryable = db,
  ): Promise<GameOfTheWeek | null> {
    const { rows: games } = await executor.query(
      `SELECT g.id
       FROM "games" g
       LEFT JOIN (
         SELECT "gameId"
         FROM "game_of_the_week"
         WHERE "startDate" > NOW() - INTERVAL '60 days'
       ) recent ON g.id = recent."gameId"
       LEFT JOIN (
         SELECT "gameId", AVG(rating) as avg_rating
         FROM "ratings"
         GROUP BY "gameId"
       ) r ON g.id = r."gameId"
       WHERE recent."gameId" IS NULL
       AND (r.avg_rating IS NULL OR r.avg_rating >= 4)
       ORDER BY RANDOM()
       LIMIT 1`,
    );

    if (!games.length) {
      const { rows: anyGames } = await executor.query(
        `SELECT id FROM "games" ORDER BY RANDOM() LIMIT 1`,
      );

      if (!anyGames.length) {
        return null;
      }

      games.push(anyGames[0]);
    }

    const gameId = games[0].id;

    const { rows } = await executor.query(
      `INSERT INTO "game_of_the_week" ("gameId")
       VALUES ($1)
       RETURNING *`,
      [gameId],
    );

    return new GameOfTheWeek(rows[0]);
  }

  static async getOrSelectCurrent(): Promise<GameOfTheWeek | null> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    // Every request arriving in the gap between one week expiring and a new
    // pick being made used to insert its own game of the week, so a busy
    // moment produced several — and each server then showed a different one.
    // The first caller through the lock selects; the others find it done.
    const client = await db.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        SELECTION_LOCK_KEY,
      ]);

      const { rows } = await client.query(
        `SELECT 1 FROM "game_of_the_week"
         WHERE NOW() BETWEEN "startDate" AND "endDate"
         LIMIT 1`,
      );

      if (!rows.length) {
        await this.selectNewGameOfTheWeek(client);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Re-read through getCurrent so the pick always arrives with its game
    // attached, however it was made.
    return await this.getCurrent();
  }
}
