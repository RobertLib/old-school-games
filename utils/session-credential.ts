import crypto from "crypto";
import { deriveKey } from "./session-secret.ts";

/**
 * The credential a session was opened with, as the session keeps it.
 *
 * A session used to hold only who it belonged to — { id, email, role } — so
 * nothing in it could tell a session opened before a password reset from one
 * opened after. The reset (User.upsertAdmin, run by create-admin.ts) ended the
 * old ones by deleting their rows, and that was the whole of the protection:
 * any path by which a row came back — the upsert that utils/session-store.ts
 * exists to stop, a restored backup, a request that read the session just
 * before the reset committed and saved it just after — handed back a full
 * admin session, because isAdmin re-reads the role by user id and the role is
 * unchanged by a reset.
 *
 * So the login writes this into the session, and middlewares/is-admin.ts
 * compares it with the account's current hash on every admin request. A reset
 * always stores a new hash — a fresh salt even for the same password — so
 * every session opened under the old one stops matching at that moment,
 * whatever happens to the rows.
 *
 * An HMAC of the stored hash rather than the hash or a plain digest of it, so
 * the session table carries nothing that can be computed from the users table
 * alone: forging a session that passes needs SESSION_SECRET as well as the
 * row. The key is derived for this purpose only (see deriveKey).
 */
const KEY = deriveKey("session credential v1");

export function credentialOf(passwordHash: string): string {
  return crypto.createHmac("sha256", KEY).update(passwordHash).digest("hex");
}

/**
 * Whether `held` — what a session carries — is the credential of an account
 * whose stored hash is now `passwordHash`.
 *
 * Both sides are checked for being strings because both come out of the
 * database: a session written before this existed has no credential at all,
 * and that has to read as "does not match", never as a throw.
 *
 * Constant-time, like every other comparison against a secret-derived value
 * here, although this one is not reachable from the outside: the session is
 * server-side and the browser only holds its id.
 */
export function holdsCredential(held: unknown, passwordHash: unknown): boolean {
  if (typeof held !== "string" || typeof passwordHash !== "string") {
    return false;
  }

  const expected = Buffer.from(credentialOf(passwordHash), "utf8");
  const actual = Buffer.from(held, "utf8");

  return (
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  );
}
