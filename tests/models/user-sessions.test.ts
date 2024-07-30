import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import User from "../../models/user.ts";
import { credentialOf, holdsCredential } from "../../utils/session-credential.ts";

/**
 * create-admin doubles as the password reset, and it used to change the hash
 * and nothing else: a session opened with a phished password kept working
 * after the reset meant to lock it out. Against the real "session" table,
 * because the point is what connect-pg-simple actually stores — JSON with the
 * user routes/auth.ts puts in it.
 */
describe("User.upsertAdmin and the sessions an account already has", () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE "session", "users" RESTART IDENTITY CASCADE');
  });

  async function openSession(sid: string, userId: number | null): Promise<void> {
    const sess = {
      cookie: { originalMaxAge: 86_400_000 },
      ...(userId === null ? {} : { user: { id: userId, email: "x", role: "ADMIN" } }),
    };

    await pool.query(
      `INSERT INTO "session" ("sid", "sess", "expire")
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [sid, JSON.stringify(sess)],
    );
  }

  async function sessions(): Promise<string[]> {
    const { rows } = await pool.query('SELECT "sid" FROM "session" ORDER BY "sid"');

    return rows.map((row) => row.sid as string);
  }

  it("signs out every session of the account whose password it resets", async () => {
    const { id } = await User.upsertAdmin({
      email: "admin@example.com",
      password: "the first long password",
    });
    const { id: other } = await User.upsertAdmin({
      email: "someone@example.com",
      password: "another long password",
    });

    await openSession("stolen", id);
    await openSession("also-this-account", id);
    await openSession("somebody-else", other);
    await openSession("anonymous", null);

    const reset = await User.upsertAdmin({
      email: "Admin@Example.com",
      password: "a brand new long password",
    });

    expect(reset).toEqual({ id, created: false });
    expect(await sessions()).toEqual(["anonymous", "somebody-else"]);
  });

  /**
   * What the admin guard relies on when a row survives the DELETE by any
   * route: the reset stores a new hash, so the credential a session was opened
   * with stops matching the account. That has to hold even when the "new"
   * password is the old one typed again — it does, because every hash gets a
   * fresh salt — or re-running the script with the same password would reset
   * nothing a resurrected session could notice.
   */
  it("gives the account a new credential, even for the same password", async () => {
    const same = "the same long password";
    const { id } = await User.upsertAdmin({ email: "admin@example.com", password: same });
    const before = (await User.findById(id))!.password;

    await User.upsertAdmin({ email: "admin@example.com", password: same });

    const after = (await User.findById(id))!.password;

    expect(after).not.toBe(before);
    expect(holdsCredential(credentialOf(before), after)).toBe(false);
    expect(holdsCredential(credentialOf(after), after)).toBe(true);
  });

  it("leaves every session alone when it creates a new account", async () => {
    await openSession("anonymous", null);

    const { created } = await User.upsertAdmin({
      email: "new@example.com",
      password: "a long enough password",
    });

    expect(created).toBe(true);
    expect(await sessions()).toEqual(["anonymous"]);
  });
});
