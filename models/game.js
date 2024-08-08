const Model = require("./model");
const db = require("../db");

class Game extends Model {
  constructor({ id, title, description, images, stream }) {
    super({ id });

    this.title = title;
    this.description = description;
    this.images = images;
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

    return rows[0] ? new Game(rows[0]) : null;
  }

  static async create({ title, description, images, stream }) {
    const { rows } = await db.query(
      'INSERT INTO "games" ("title", "description", "images", "stream") VALUES ($1, $2, $3, $4) RETURNING "id"',
      [title, description, images, stream]
    );

    return rows[0];
  }

  static async update(id, { title, description, images, stream }) {
    const { rows } = await db.query(
      'UPDATE "games" SET "title" = $1, "description" = $2, "images" = $3, "stream" = $4 WHERE "id" = $5 RETURNING "id"',
      [title, description, images, stream, id]
    );

    return rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);
  }
}

module.exports = Game;
