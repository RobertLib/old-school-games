const Model = require("./model");
const db = require("../db");

class Game extends Model {
  static GENRES = [
    "ACTION",
    "ADVENTURE",
    "RPG",
    "STRATEGY",
    "SIMULATION",
    "SPORTS",
    "PUZZLE",
    "HORROR",
    "PLATFORMER",
    "RACING",
    "FIGHTING",
    "SHOOTER",
    "OTHER",
  ];

  constructor({ id, title, description, genre, images, stream }) {
    super({ id });

    this.title = title;
    this.description = description;
    this.genre = genre;
    this.images = images;
    this.stream = stream;
  }

  static async all() {
    const { rows } = await db.query('SELECT * FROM "games" ORDER BY "title"');

    return rows.map((row) => new Game(row));
  }

  static async findByGenre(genre) {
    if (!Game.GENRES.includes(genre)) {
      return await Game.all();
    }

    const { rows } = await db.query(
      'SELECT * FROM "games" WHERE "genre" = $1 ORDER BY "title"',
      [genre]
    );

    return rows.map((row) => new Game(row));
  }

  static async findById(id) {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "id" = $1', [
      id,
    ]);

    return rows[0] ? new Game(rows[0]) : null;
  }

  static async create({ title, description, genre, images, stream }) {
    const { rows } = await db.query(
      'INSERT INTO "games" ("title", "description", "genre", "images", "stream") VALUES ($1, $2, $3, $4, $5) RETURNING "id"',
      [title, description, genre, images, stream]
    );

    return rows[0];
  }

  static async update(id, { title, description, genre, images, stream }) {
    const { rows } = await db.query(
      'UPDATE "games" SET "title" = $1, "description" = $2, "genre" = $3, "images" = $4, "stream" = $5 WHERE "id" = $6 RETURNING "id"',
      [title, description, genre, images, stream, id]
    );

    return rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);
  }
}

module.exports = Game;
