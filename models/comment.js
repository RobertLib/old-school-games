import Model from "./model.js";
import db from "../db.js";

export default class Comment extends Model {
  constructor(data) {
    super(data);

    this.nick = data.nick;
    this.content = data.content;
    this.gameId = data.gameId;
  }

  static async findByGameId(gameId) {
    const { rows } = await db.query(
      'SELECT * FROM "comments" WHERE "gameId" = $1 ORDER BY "createdAt" ASC LIMIT 100',
      [gameId]
    );

    return rows.map((row) => new Comment(row));
  }

  static async create({ nick, content, gameId }) {
    const { rows } = await db.query(
      'INSERT INTO "comments" ("nick", "content", "gameId") VALUES ($1, $2, $3) RETURNING *',
      [nick, content, gameId]
    );

    return new Comment(rows[0]);
  }
}
