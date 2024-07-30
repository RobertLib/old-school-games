const Model = require("./model");
const db = require("../db");

class Game extends Model {
  constructor({ id, title, description, stream }) {
    super({ id });

    this.title = title;
    this.description = description;
    this.stream = stream;
  }

  static async all() {
    const { rows } = await db.query('SELECT * FROM "games"');

    return rows.map((row) => new Game(row));
  }

  static async findById(id) {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "id" = $1', [
      id,
    ]);

    return new Game(rows[0]);
  }

  static async create({ title, description, stream }) {
    const { rows } = await db.query(
      'INSERT INTO "games" ("title", "description", "stream") VALUES ($1, $2, $3) RETURNING "id"',
      [title, description, stream]
    );

    return rows[0];
  }

  static async update(id, { title, description, stream }) {
    const { rows } = await db.query(
      'UPDATE "games" SET "title" = $1, "description" = $2, "stream" = $3 WHERE "id" = $4 RETURNING "id"',
      [title, description, stream, id]
    );

    return rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);
  }
}

module.exports = Game;
