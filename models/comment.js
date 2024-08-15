const Model = require("./model");
const db = require("../db");

class Comment extends Model {
  constructor(data) {
    super(data);

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

  static async create({ content, gameId }) {
    const { rows } = await db.query(
      'INSERT INTO "comments" ("content", "gameId") VALUES ($1, $2) RETURNING *',
      [content, gameId]
    );

    return new Comment(rows[0]);
  }
}

module.exports = Comment;
