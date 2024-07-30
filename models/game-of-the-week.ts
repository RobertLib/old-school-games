import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import Game from "./game.ts";

interface GameOfTheWeekData extends ModelData {
  gameId: number;
  startDate: Date | string;
  endDate: Date | string;
}

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
       LIMIT 1`
    );

    if (!rows.length) {
      return null;
    }

    const gameOfTheWeek = new GameOfTheWeek(rows[0]);
    const game = await Game.findById(gameOfTheWeek.gameId);

    if (game) {
      game.averageRating = await Game.getAverageRating(game.id);
      gameOfTheWeek.game = game;
    }

    return gameOfTheWeek;
  }

  static async selectNewGameOfTheWeek(): Promise<GameOfTheWeek | null> {
    const { rows: games } = await db.query(
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
       LIMIT 1`
    );

    if (!games.length) {
      const { rows: anyGames } = await db.query(
        `SELECT id FROM "games" ORDER BY RANDOM() LIMIT 1`
      );

      if (!anyGames.length) {
        return null;
      }

      games.push(anyGames[0]);
    }

    const gameId = games[0].id;

    const { rows } = await db.query(
      `INSERT INTO "game_of_the_week" ("gameId")
       VALUES ($1)
       RETURNING *`,
      [gameId]
    );

    return new GameOfTheWeek(rows[0]);
  }

  static async getOrSelectCurrent(): Promise<GameOfTheWeek | null> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    return await this.selectNewGameOfTheWeek();
  }
}
