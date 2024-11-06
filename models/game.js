import Model from "./model.js";
import db from "../db.js";

const properties = {
  title: "string",
  slug: "string",
  description: "string",
  genre: "string",
  release: "number",
  developer: "string",
  publisher: "string",
  images: "string[]",
  stream: "string",
  manual: "string",
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

  return obj;
}

function validate(data) {
  if (!data.title || !data.genre) {
    throw new Error("Title and genre are required.");
  }
}

export default class Game extends Model {
  constructor(data) {
    super(data);

    this.title = data.title;
    this.slug = data.slug;
    this.description = data.description;
    this.genre = data.genre;
    this.release = data.release;
    this.developer = data.developer;
    this.publisher = data.publisher;
    this.images = data.images;
    this.stream = data.stream;
    this.manual = data.manual;
  }

  static async getGenres() {
    if (this.cachedGenres) {
      return this.cachedGenres;
    }

    const { rows } = await db.query(
      "SELECT enum_range(NULL::GAME_GENRE) AS genres"
    );

    this.cachedGenres = rows[0].genres.slice(1, -1).split(",");

    return this.cachedGenres;
  }

  static createSlug(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  static async find({
    genre,
    limit,
    orderBy = "title",
    orderDir = "ASC",
    page,
  } = {}) {
    let query = 'SELECT * FROM "games"';
    const values = [];

    if (genre) {
      query += ` WHERE "genre" = $${values.length + 1}`;
      values.push(genre.toUpperCase());
    }

    query += ` ORDER BY "${orderBy}" ${orderDir}`;

    if (limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(limit);

      if (page) {
        const offset = (page - 1) * limit;
        query += ` OFFSET $${values.length + 1}`;
        values.push(offset);
      }
    }

    const { rows } = await db.query(query, values);

    return rows.map((row) => new Game(row));
  }

  static async findRecentlyAdded() {
    return await Game.find({
      limit: 5,
      orderBy: "createdAt",
      orderDir: "DESC",
    });
  }

  static async findById(id) {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "id" = $1', [
      id,
    ]);

    return rows[0] ? new Game(rows[0]) : null;
  }

  static async findBySlug(slug) {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "slug" = $1', [
      slug,
    ]);

    return rows[0] ? new Game(rows[0]) : null;
  }

  static async create(data) {
    const gameData = serialize(data);

    validate(gameData);

    gameData.slug = Game.createSlug(gameData.title);

    const fields = Object.keys(gameData);
    const values = Object.values(gameData);

    const quotedFields = fields.map((field) => `"${field}"`).join(", ");
    const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");

    const { rows } = await db.query(
      `INSERT INTO "games" (${quotedFields}) VALUES (${placeholders}) RETURNING "id"`,
      values
    );

    return rows[0];
  }

  static async update(id, data) {
    const gameData = serialize(data);

    validate(gameData);

    gameData.slug = Game.createSlug(gameData.title);
    gameData.updatedAt = new Date();

    const fields = Object.keys(gameData);
    const values = Object.values(gameData);

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
