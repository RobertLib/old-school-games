import pool from "../db.ts";
import Model, { type ModelData } from "./model.ts";

export interface NewsData extends ModelData {
  title: string;
  content: string;
  userId?: number | null;
}

export default class News extends Model {
  title: string;
  content: string;
  userId?: number | null;

  constructor(data: NewsData) {
    super(data);
    this.title = data.title;
    this.content = data.content;
    this.userId = data.userId;
  }

  static async create(data: {
    title: string;
    content: string;
    userId: number;
  }): Promise<News> {
    const result = await pool.query(
      `INSERT INTO "news" ("title", "content", "userId") VALUES ($1, $2, $3) RETURNING *`,
      [data.title, data.content, data.userId]
    );

    return new News(result.rows[0]);
  }

  static async findAll({
    page = 1,
    limit = 10,
  }: {
    page?: number;
    limit?: number;
  } = {}): Promise<{ news: News[]; total: number; totalPages: number }> {
    const offset = (page - 1) * limit;

    const [newsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM "news"
         WHERE "deletedAt" IS NULL
         ORDER BY "createdAt" DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM "news" WHERE "deletedAt" IS NULL`
      ),
    ]);

    const news = newsResult.rows.map((row) => new News(row));
    const total = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    return { news, total, totalPages };
  }

  static async findRecent(limit = 5): Promise<News[]> {
    const result = await pool.query(
      `SELECT * FROM "news"
       WHERE "deletedAt" IS NULL
       ORDER BY "createdAt" DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map((row) => new News(row));
  }

  static async findById(id: number): Promise<News | null> {
    const result = await pool.query(
      `SELECT * FROM "news" WHERE "id" = $1 AND "deletedAt" IS NULL`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return new News(result.rows[0]);
  }

  static async count(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as total FROM "news" WHERE "deletedAt" IS NULL`
    );

    return parseInt(result.rows[0].total, 10);
  }
}
