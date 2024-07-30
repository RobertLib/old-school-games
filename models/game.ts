import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import IndexNow from "../utils/indexnow.ts";
import { clearSitemapCache } from "../routes/sitemap.ts";

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
    letter,
    developer,
    publisher,
    year,
    limit,
    orderBy,
    orderDir,
    page,
    search,
  }: {
    genre?: string;
    letter?: string;
    developer?: string;
    publisher?: string;
    year?: number;
    limit?: number;
    orderBy?: string;
    orderDir?: string;
    page?: number;
    search?: string;
  } = {}): Promise<Game[]> {
    let query = `
      SELECT g.*, COALESCE(AVG(r.rating), 0) as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g.id = r."gameId"
    `;

    const values: any[] = [];
    const whereConditions: string[] = [];

    const direction =
      orderDir || (letter || year || developer || publisher ? "ASC" : "DESC");

    if (genre) {
      whereConditions.push(`g."genre" = $${values.length + 1}`);
      values.push(genre.toUpperCase());
    }

    if (letter) {
      whereConditions.push(`g."title" ILIKE $${values.length + 1}`);
      values.push(`${letter}%`);
    }

    if (year) {
      whereConditions.push(`g."release" = $${values.length + 1}`);
      values.push(year);
    }

    if (search) {
      whereConditions.push(`g."title" ILIKE $${values.length + 1}`);
      values.push(`%${search.trim()}%`);
    }

    if (developer) {
      whereConditions.push(`g."developer" = $${values.length + 1}`);
      values.push(developer);
    }

    if (publisher) {
      whereConditions.push(
        `(g."publisher" = $${values.length + 1} OR (g."developer" = $${
          values.length + 1
        } AND (g."publisher" IS NULL OR g."publisher" = '')))`
      );
      values.push(publisher);
    }

    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    query += ` GROUP BY g.id`;

    if (orderBy === "rating") {
      query += ` ORDER BY "averageRating" ${direction}, g."id" ${direction}`;
    } else if (orderBy) {
      query += ` ORDER BY g."${orderBy}" ${direction}, g."id" ${direction}`;
    } else {
      // Default ordering for different page types
      if (letter || year || developer || publisher) {
        query += ` ORDER BY g."title" ${direction}, g."id" ${direction}`;
      } else {
        query += ` ORDER BY "averageRating" ${direction}, g."id" ${direction}`;
      }
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

    const games = rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      return game;
    });

    return games;
  }

  static async findForSitemap(): Promise<{ slug: string; updatedAt?: Date }[]> {
    const { rows } = await db.query(
      'SELECT "slug", "updatedAt" FROM "games" ORDER BY "id"'
    );

    return rows;
  }

  static async findRecentlyAdded(): Promise<Game[]> {
    const result = await Game.find({
      limit: 5,
      orderBy: "createdAt",
      orderDir: "DESC",
    });

    return result;
  }

  static async findTopRated(): Promise<Game[]> {
    const { rows } = await db.query(`
      SELECT g.*, AVG(r.rating) as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g.id = r."gameId"
      GROUP BY g.id
      ORDER BY "averageRating" DESC NULLS LAST
      LIMIT 5
    `);

    return rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      return game;
    });
  }

  static async findFeatured(limit: number = 8): Promise<Game[]> {
    const { rows } = await db.query(`
      SELECT g.*, AVG(r.rating) as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g.id = r."gameId"
      GROUP BY g.id
      HAVING AVG(r.rating) >= 3.5 OR AVG(r.rating) IS NULL
      ORDER BY RANDOM()
      LIMIT $1
    `, [limit]);

    return rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      return game;
    });
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

  static async count({
    genre,
    letter,
    developer,
    publisher,
    year,
  }: {
    genre?: string;
    letter?: string;
    developer?: string;
    publisher?: string;
    year?: number;
  } = {}): Promise<number> {
    let query = 'SELECT COUNT(*) as total FROM "games" g';
    const values: any[] = [];
    const whereConditions: string[] = [];

    if (genre) {
      whereConditions.push(`g."genre" = $${values.length + 1}`);
      values.push(genre.toUpperCase());
    }

    if (letter) {
      whereConditions.push(`g."title" ILIKE $${values.length + 1}`);
      values.push(`${letter}%`);
    }

    if (year) {
      whereConditions.push(`g."release" = $${values.length + 1}`);
      values.push(year);
    }

    if (developer) {
      whereConditions.push(`g."developer" = $${values.length + 1}`);
      values.push(developer);
    }

    if (publisher) {
      whereConditions.push(
        `(g."publisher" = $${values.length + 1} OR (g."developer" = $${
          values.length + 1
        } AND (g."publisher" IS NULL OR g."publisher" = '')))`
      );
      values.push(publisher);
    }

    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    const { rows } = await db.query(query, values);
    return parseInt(rows[0].total, 10);
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

    // Clear sitemap cache
    clearSitemapCache();

    // Submit to IndexNow (async, don't await to avoid blocking)
    IndexNow.submitGameUrls(
      gameData.slug!,
      gameData.genre,
      gameData.developer,
      gameData.publisher,
      gameData.release || undefined
    ).catch((error) => {
      console.error("IndexNow submission failed for created game:", error);
    });

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

    // Clear sitemap cache
    clearSitemapCache();

    // Submit to IndexNow (async, don't await to avoid blocking)
    IndexNow.submitGameUrls(
      gameData.slug!,
      gameData.genre,
      gameData.developer,
      gameData.publisher,
      gameData.release || undefined
    ).catch((error) => {
      console.error("IndexNow submission failed for updated game:", error);
    });

    return rows[0];
  }

  static async delete(id: string | number): Promise<void> {
    // Get game data before deletion for IndexNow
    const game = await Game.findById(id);

    await db.query('DELETE FROM "games" WHERE "id" = $1', [id]);

    // Clear sitemap cache
    clearSitemapCache();

    // Submit to IndexNow if game existed (async, don't await to avoid blocking)
    if (game) {
      IndexNow.submitGameDeletedUrls(game.slug).catch((error) => {
        console.error("IndexNow submission failed for deleted game:", error);
      });
    }
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

  static async getDevelopers(): Promise<string[]> {
    const { rows } = await db.query(
      'SELECT DISTINCT "developer" FROM "games" WHERE "developer" IS NOT NULL AND "developer" != \'\' ORDER BY "developer" ASC'
    );

    return rows.map((row) => row.developer);
  }

  static async getPublishers(): Promise<string[]> {
    const { rows } = await db.query(`
      SELECT DISTINCT name FROM (
        SELECT "publisher" as name FROM "games"
        WHERE "publisher" IS NOT NULL AND "publisher" != ''
        UNION
        SELECT "developer" as name FROM "games"
        WHERE "developer" IS NOT NULL AND "developer" != ''
        AND ("publisher" IS NULL OR "publisher" = '')
      ) AS publishers
      ORDER BY name ASC
    `);

    return rows.map((row) => row.name);
  }

  static async getYears(): Promise<number[]> {
    const { rows } = await db.query(`
      SELECT DISTINCT "release"
      FROM "games"
      WHERE "release" IS NOT NULL
      ORDER BY "release" DESC
    `);

    return rows.map((row) => row.release);
  }

  static async findSimilar(
    gameId: string | number,
    genre: string,
    limit: number = 6
  ): Promise<Game[]> {
    const query = `
      SELECT g.*, AVG(r."rating") as "averageRating"
      FROM "games" g
      LEFT JOIN "ratings" r ON g."id" = r."gameId"
      WHERE g."genre" = $1 AND g."id" != $2
      GROUP BY g.id
      ORDER BY "averageRating" DESC NULLS LAST, g."createdAt" DESC
      LIMIT $3
    `;

    const { rows } = await db.query(query, [genre, gameId, limit]);

    const games = rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      return game;
    });

    return games;
  }

  static async findAdjacentGames(
    title: string
  ): Promise<{ prevGame: Game | null; nextGame: Game | null }> {
    // Find previous game (alphabetically before current)
    const prevQuery = `
      SELECT * FROM "games"
      WHERE LOWER("title") < LOWER($1)
      ORDER BY "title" DESC
      LIMIT 1
    `;

    // Find next game (alphabetically after current)
    const nextQuery = `
      SELECT * FROM "games"
      WHERE LOWER("title") > LOWER($1)
      ORDER BY "title" ASC
      LIMIT 1
    `;

    const [prevResult, nextResult] = await Promise.all([
      db.query(prevQuery, [title]),
      db.query(nextQuery, [title]),
    ]);

    const prevGame = prevResult.rows[0] ? new Game(prevResult.rows[0]) : null;
    const nextGame = nextResult.rows[0] ? new Game(nextResult.rows[0]) : null;

    return { prevGame, nextGame };
  }
}
