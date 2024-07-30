import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";

interface UserData extends ModelData {
  email: string;
  password: string;
  role?: string;
}

export default class User extends Model {
  email: string;
  password: string;
  role?: string;

  constructor(data: UserData) {
    super(data);

    this.email = data.email;
    this.password = data.password;
    this.role = data.role;
  }

  static async findByEmail(email: string): Promise<User | null> {
    const { rows } = await db.query(
      'SELECT * FROM "users" WHERE "email" = $1',
      [email]
    );

    return rows[0] ? new User(rows[0]) : null;
  }

  static async create({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ id: number }> {
    const { rows } = await db.query(
      'INSERT INTO "users" ("email", "password") VALUES ($1, $2) RETURNING "id"',
      [email, password]
    );

    return rows[0];
  }
}
