const Model = require("./model");
const db = require("../db");

const properties = {
  title: "string",
  description: "string",
  genre: "string",
  release: "number",
  publisher: "string",
  images: "string[]",
  stream: "string",
};

function serialize(data) {
  const obj = {};

  Object.entries(properties).forEach(([prop, type]) => {
    if (type === "number" && data[prop] === "") {
      obj[prop] = null;
    } else {
      obj[prop] = data[prop];
    }
  });

  return {
    data: obj,
    fields: Object.keys(obj),
    values: Object.values(obj),
  };
}

function validate(data) {
  if (!data.title || !data.genre) {
    throw new Error("Title and genre are required.");
  }
}

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

  constructor(data) {
    super(data);

    this.title = data.title;
    this.description = data.description;
    this.genre = data.genre;
    this.release = data.release;
    this.publisher = data.publisher;
    this.images = data.images;
    this.stream = data.stream;
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

  static async create(data) {
    const { data: gameData, fields, values } = serialize(data);

    validate(gameData);

    const quotedFields = fields.map((field) => `"${field}"`).join(", ");
    const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");

    const { rows } = await db.query(
      `INSERT INTO "games" (${quotedFields}) VALUES (${placeholders}) RETURNING "id"`,
      values
    );

    return rows[0];
  }

  static async update(id, data) {
    const { data: gameData, fields, values } = serialize(data);

    validate(gameData);

    gameData.updatedAt = new Date();

    const set = fields
      .map((field, index) => `"${field}" = $${index + 1}`)
      .join(", ");

    values.push(id);

    const { rows } = await db.query(
      `UPDATE "games" SET ${set} WHERE "id" = $${values.length} RETURNING "id"`,
      values
    );

    return rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);
  }
}

module.exports = Game;
