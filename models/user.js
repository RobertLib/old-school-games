const Model = require("./model");
const db = require("../db");

class User extends Model {
  constructor({ id, email, password, role }) {
    super({ id });

    this.email = email;
    this.password = password;
    this.role = role;
  }

  static async findByEmail(email) {
    const { rows } = await db.query(
      'SELECT * FROM "users" WHERE "email" = $1',
      [email]
    );

    return rows[0] ? new User(rows[0]) : null;
  }

  static async create({ email, password }) {
    const { rows } = await db.query(
      'INSERT INTO "users" ("email", "password") VALUES ($1, $2) RETURNING "id"',
      [email, password]
    );

    return rows[0];
  }
}

module.exports = User;
