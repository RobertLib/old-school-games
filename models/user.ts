import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import { parseId } from "../utils/ids.ts";
import { hashPassword } from "../utils/password.ts";

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

  /**
   * Case-insensitive, because nobody remembers how they capitalised their own
   * address. A direct comparison meant an account seeded as
   * "admin@example.com" simply did not exist for anyone typing
   * "Admin@example.com" — indistinguishable from a wrong password.
   *
   * LOWER() on both sides is matched by the functional index in
   * 0025_users_email_case_insensitive.sql, which also rules out two accounts
   * that differ only in case.
   */
  static async findByEmail(email: string): Promise<User | null> {
    const { rows } = await db.query(
      'SELECT * FROM "users" WHERE LOWER("email") = LOWER($1)',
      [email],
    );

    return rows[0] ? new User(rows[0]) : null;
  }

  /**
   * The account behind a session, so the admin guard can read a role that is
   * current rather than the copy login wrote into the session — see
   * middlewares/is-admin.ts.
   *
   * parseId rather than trusting the caller: the value comes off a session
   * this process issued, but it ends up in an integer comparison, and a model
   * that builds a query out of its argument should not depend on where the
   * argument has been.
   */
  static async findById(id: unknown): Promise<User | null> {
    const numericId = parseId(id);

    if (numericId === null) return null;

    const { rows } = await db.query(
      'SELECT * FROM "users" WHERE "id" = $1',
      [numericId],
    );

    return rows[0] ? new User(rows[0]) : null;
  }

  /**
   * There is no sign-up route: accounts are seeded by hand, so this is the
   * only way one gets made. Kept for that and for the suite, not dead code
   * awaiting a caller.
   *
   * `password` is the plain one, and hashing it is this method's job rather
   * than the caller's. It used to store the value it was handed verbatim,
   * which made the only way to seed an account correctly an unwritten one —
   * hashPassword had no caller anywhere in the app, and nothing in the
   * signature said it was owed. Anybody reaching for the obvious
   * `User.create({ email, password })` stored a plaintext password, and
   * verifyPassword would then refuse the very password that was set.
   *
   * The cost of a hash is deliberate and measured in hundreds of
   * milliseconds — see utils/password.ts — which is unremarkable for an
   * account seeded by hand and the reason this is async.
   */
  static async create({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ id: number }> {
    const { rows } = await db.query(
      'INSERT INTO "users" ("email", "password") VALUES ($1, $2) RETURNING "id"',
      [email, await hashPassword(password)],
    );

    return rows[0];
  }

  /**
   * Makes `email` an admin with `password`, creating the account if there is
   * none — what create-admin.ts runs, and the only way an admin comes into
   * existence.
   *
   * There was no way at all before this. create() above inserts "email" and
   * "password" and nothing else, so the column takes its DEFAULT 'USER';
   * "role" is not a parameter and no other code path writes it. So on a fresh
   * install every admin surface — both game forms, both news forms, comment
   * moderation — was unreachable, and the README's setup section (create the
   * database, migrate, start) never said otherwise. Getting in meant an UPDATE
   * by hand, and not only that: because verifyPassword expects
   * "scrypt$N$r$p$salt$key", the INSERT could not be written by hand either
   * without first calling hashPassword from a REPL to produce the value.
   *
   * Promoting as well as creating, because both halves were missing and the
   * second is the one somebody with an existing account needs. That makes the
   * script idempotent, which is what you want from something run against
   * production by hand: running it twice is not an error, and it doubles as
   * the way to reset an admin password.
   *
   * One statement, so a crash cannot leave an account created but not
   * promoted. The arbiter is LOWER("email") — the functional index from
   * 0025_users_email_case_insensitive.sql — because that is the uniqueness
   * that actually applies: "Admin@example.com" must find the row stored as
   * "admin@example.com" rather than fail the plain UNIQUE on the column.
   *
   * "created" comes from xmax, which is Postgres's own answer to "did this
   * upsert insert or update": the system column is zero on a row this
   * statement inserted and non-zero on one it updated. There is no portable
   * spelling of that, and the alternative — a SELECT, then a branch — is two
   * round trips that can disagree with each other.
   */
  static async upsertAdmin({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ id: number; created: boolean }> {
    // An existing account's sessions end in the same statement that changes
    // its password. This doubles as the password reset (see create-admin.ts),
    // and it used to change the hash and nothing else — so a session somebody
    // had opened with a phished password survived the reset that was meant to
    // lock them out, renewing itself on every request. Demoting the account
    // and promoting it back did not help either: isAdmin re-reads the role by
    // the session's user id, so the stolen session was an admin again the
    // moment the real one was. Only deleting rows by hand or rotating
    // SESSION_SECRET ended it.
    //
    // connect-pg-simple stores the session as JSON, and routes/auth.ts puts
    // the user there as { id, email, role, credential }. A fresh account has
    // no sessions to end, so the DELETE matches nothing on the insert path.
    // Being one statement, a failed reset leaves every session as it was.
    //
    // Deleting the rows was not the end of it, and for a while that was the
    // whole of the protection. A request of the stolen session already in
    // flight when this ran saved its session on the way out — every admin
    // POST writes a flash — and the store's upsert wrote the deleted row
    // straight back: a loop of admin POSTs outlived this reset in half the
    // trials. Two things hold it now. utils/session-store.ts never re-creates
    // a row a save finds gone, so the DELETE stays done; and the new hash is a
    // new credential, so middlewares/is-admin.ts signs out any session still
    // carrying the old one, however its row came to exist — see
    // utils/session-credential.ts.
    const { rows } = await db.query(
      `WITH upserted AS (
         INSERT INTO "users" ("email", "password", "role")
         VALUES ($1, $2, 'ADMIN')
         ON CONFLICT (LOWER("email")) DO UPDATE
           SET "password" = EXCLUDED."password",
               "role" = 'ADMIN',
               "updatedAt" = NOW()
         RETURNING "id", (xmax = 0) AS "created"
       ), signed_out AS (
         DELETE FROM "session"
         WHERE "sess" -> 'user' ->> 'id' = (SELECT "id"::text FROM upserted)
       )
       SELECT "id", "created" FROM upserted`,
      [email, await hashPassword(password)],
    );

    return { id: rows[0].id, created: rows[0].created };
  }
}
