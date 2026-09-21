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

  /**
   * This week's pick, with its game already attached.
   *
   * One query, not two. It used to select the pick and then call
   * Game.findById with the id it found — two round trips, in series, on a
   * widget every page on the site renders, and the second one waiting on the
   * first for no reason other than that the id was not known until it came
   * back.
   *
   * The game's own columns arrive as JSON rather than spread out beside the
   * pick's, because the two tables share "id", "createdAt" and "updatedAt"
   * and a flat select would have one silently overwrite the other. The
   * rating aggregates stay top-level: they are this query's, not the row's.
   *
   * An inner join, so a pick whose game has gone is no pick at all rather
   * than one rendering as a blank. The foreign key cascades (0012), so that
   * cannot happen today; if it ever does, getOrSelectCurrent below reads the
   * null as "nothing current" and picks again, which is the right answer.
   */
  static async getCurrent(): Promise<GameOfTheWeek | null> {
    const { rows } = await db.query(
      `SELECT gw.*, to_jsonb(g.*) AS "gameRow",
              COALESCE(AVG(r."rating"), 0) AS "averageRating",
              COUNT(r."rating") AS "ratingCount"
       FROM "game_of_the_week" gw
       JOIN "games" g ON g."id" = gw."gameId"
       LEFT JOIN "ratings" r ON r."gameId" = g."id"
       WHERE NOW() BETWEEN gw."startDate" AND gw."endDate"
       GROUP BY gw."id", g."id"
       ORDER BY gw."startDate" DESC
       LIMIT 1`,
    );

    if (!rows.length) {
      return null;
    }

    const gameOfTheWeek = new GameOfTheWeek(rows[0]);

    const game = new Game(rows[0].gameRow);
    // Parsed here for the same reason every listing in models/game.ts parses
    // them: node-postgres hands numeric and bigint back as strings.
    game.averageRating = parseFloat(rows[0].averageRating) || 0;
    game.ratingCount = parseInt(rows[0].ratingCount, 10) || 0;

    gameOfTheWeek.game = game;

    return gameOfTheWeek;
  }

  static async selectNewGameOfTheWeek(
    executor: Queryable = db,
  ): Promise<GameOfTheWeek | null> {
    // Playable games only, both here and in the fallback below — the same
    // condition Game.findRandom applies, and for the same reason. The widget
    // is a "play this" call to action on every page of the site, and a game
    // with no stream cannot be played: the pick used to be able to land on one,
    // and then the most prominent recommendation on the site led to a page with
    // no player on it for a week. The catalogue holds such rows on purpose —
    // a game catalogued before its bundle exists — so this is reachable rather
    // than theoretical.
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
       AND g."stream" IS NOT NULL AND g."stream" <> ''
       AND (r.avg_rating IS NULL OR r.avg_rating >= 4)
       ORDER BY RANDOM()
       LIMIT 1`,
    );

    if (!games.length) {
      const { rows: anyGames } = await executor.query(
        `SELECT id FROM "games"
         WHERE "stream" IS NOT NULL AND "stream" <> ''
         ORDER BY RANDOM() LIMIT 1`,
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
