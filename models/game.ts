import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";

interface GameData extends ModelData {
  title: string;
  slug: string;
  description: string;
  genre: string;
  release: number | null;
  developer: string;
  publisher: string;
  images: string[];
  stream: string;
  manual: string;
}

const properties: Record<
  keyof Omit<GameData, "id" | "createdAt" | "updatedAt" | "deletedAt">,
  "string" | "number" | "string[]"
> = {
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

function serialize(data: Partial<GameData>): Partial<GameData> {
  const obj: Partial<GameData> = {};

  Object.entries(properties).forEach(([prop, type]) => {
    if (type === "number" && data[prop] === "") {
      obj[prop] = null;
    } else {
      obj[prop] = data[prop];
    }
  });

  return obj;
}

function validate(data: Partial<GameData>): void {
  if (!data.title || !data.genre) {
    throw new Error("Title and genre are required.");
  }
}

export default class Game extends Model {
  title: string;
  slug: string;
  description: string;
  genre: string;
  release: number | null;
  developer: string;
  publisher: string;
  images: string[];
  stream: string;
  manual: string;
  averageRating?: number;

  private static cachedGenres: string[];

  constructor(data: GameData) {
    super(data);

    Object.entries(properties).forEach(([prop, type]) => {
      this[prop] = data[prop];
    });
  }

  static async getGenres(): Promise<string[]> {
    if (this.cachedGenres) {
      return this.cachedGenres;
    }

    const { rows } = await db.query(
      "SELECT enum_range(NULL::GAME_GENRE) AS genres"
    );

    this.cachedGenres = rows[0].genres.slice(1, -1).split(",");

    return this.cachedGenres;
  }

  static createSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  static async find({
    genre,
    limit,
    orderBy = "rating",
    orderDir = "DESC",
    page,
    search,
  }: {
    genre?: string;
    limit?: number;
    orderBy?: string;
    orderDir?: string;
    page?: number;
    search?: string;
  } = {}): Promise<Game[]> {
    let query = 'SELECT * FROM "games"';
    const values: any[] = [];

    if (genre) {
      query += ` WHERE "genre" = $${values.length + 1}`;
      values.push(genre.toUpperCase());
    }

    if (search) {
      query += query.includes("WHERE") ? " AND" : " WHERE";
      query += ` "title" ILIKE $${values.length + 1}`;
      values.push(`%${search.trim()}%`);
    }

    if (orderBy === "rating") {
      query += ` ORDER BY (SELECT AVG("rating") FROM "ratings" WHERE "gameId" = "games"."id") ${orderDir}, "id" ${orderDir}`;
    } else {
      query += ` ORDER BY "${orderBy}" ${orderDir}, "id" ${orderDir}`;
    }

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

    const games = await Promise.all(
      rows.map(async (row) => {
        const game = new Game(row);
        game.averageRating = await Game.getAverageRating(game.id);
        return game;
      })
    );

    return games;
  }

  static async findRecentlyAdded(): Promise<Game[]> {
    const result = await Game.find({
      limit: 5,
      orderBy: "createdAt",
      orderDir: "DESC",
    });

    return result;
  }

  static async findById(id: string | number): Promise<Game | null> {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "id" = $1', [
      id,
    ]);

    return rows[0] ? new Game(rows[0]) : null;
  }

  static async findBySlug(slug: string): Promise<Game | null> {
    const { rows } = await db.query('SELECT * FROM "games" WHERE "slug" = $1', [
      slug,
    ]);

    const game = rows[0] ? new Game(rows[0]) : null;

    if (game) {
      game.averageRating = await Game.getAverageRating(game.id);
    }

    return game;
  }

  static async create(data: Partial<GameData>): Promise<{ id: number }> {
    const gameData = serialize(data);

    validate(gameData);

    gameData.slug = Game.createSlug(gameData.title!);

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

  static async update(
    id: string | number,
    data: Partial<GameData>
  ): Promise<{ id: number }> {
    const gameData = serialize(data);

    validate(gameData);

    gameData.slug = Game.createSlug(gameData.title!);
    gameData.updatedAt = new Date();

    const fields = Object.keys(gameData);
    const values = Object.values(gameData);

    const updateFields = fields
      .map((field, index) => `"${field}" = $${index + 1}`)
      .join(", ");

    values.push(id);

    const { rows } = await db.query(
      `UPDATE "games" SET ${updateFields} WHERE "id" = $${values.length} RETURNING "id"`,
      values
    );

    return rows[0];
  }

  static async delete(id: string | number): Promise<void> {
    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);
  }

  static async rate(
    id: string | number,
    ip: string,
    rating: number
  ): Promise<void> {
    await db.query(
      'INSERT INTO "ratings" ("gameId", "ipAddress", "rating") VALUES ($1, $2, $3) ON CONFLICT ("gameId", "ipAddress") DO UPDATE SET "rating" = $3',
      [id, ip, rating]
    );
  }

  static async getAverageRating(id: string | number): Promise<number> {
    const { rows } = await db.query(
      'SELECT AVG("rating") as "averageRating" FROM "ratings" WHERE "gameId" = $1',
      [id]
    );

    return rows[0]?.averageRating ?? 0;
  }
}
