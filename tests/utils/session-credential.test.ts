import { describe, expect, it } from "vitest";
import crypto from "crypto";
import {
  credentialOf,
  holdsCredential,
} from "../../utils/session-credential.ts";

/**
 * What a session keeps of the password it was opened with, and the comparison
 * middlewares/is-admin.ts makes against the account's current hash. A reset
 * always stores a new hash — a fresh salt even for the same password — so a
 * session opened before it stops matching.
 */

const HASH = `scrypt$16384$8$5$${"a".repeat(32)}$${"b".repeat(128)}`;
const RESET = `scrypt$16384$8$5$${"c".repeat(32)}$${"b".repeat(128)}`;

describe("credentialOf", () => {
  it("is the same for the same hash, so a session keeps matching", () => {
    expect(credentialOf(HASH)).toBe(credentialOf(HASH));
    expect(credentialOf(HASH)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the hash does, which is what a reset does", () => {
    expect(credentialOf(RESET)).not.toBe(credentialOf(HASH));
  });

  /**
   * Keyed, so the session table carries nothing computable from the users
   * table alone — neither the hash itself nor a plain digest of it.
   */
  it("is neither the hash nor an unkeyed digest of it", () => {
    const plain = crypto.createHash("sha256").update(HASH).digest("hex");

    expect(credentialOf(HASH)).not.toContain(HASH);
    expect(credentialOf(HASH)).not.toBe(plain);
  });
});

describe("holdsCredential", () => {
  it("accepts the credential of the current hash", () => {
    expect(holdsCredential(credentialOf(HASH), HASH)).toBe(true);
  });

  it("refuses the credential of a hash that has been replaced", () => {
    expect(holdsCredential(credentialOf(HASH), RESET)).toBe(false);
  });

  /**
   * Both sides come out of the database. A session written before sessions
   * carried a credential has none, and that has to read as "does not match"
   * rather than as a throw — every session in production on the day this
   * shipped is one.
   */
  it.each([
    ["no credential", undefined, HASH],
    ["a null credential", null, HASH],
    ["a credential that is not a string", 42, HASH],
    ["a stored hash that is not a string", credentialOf(HASH), null],
    ["an empty credential", "", HASH],
    ["a credential of the wrong length", "ab", HASH],
    ["a multi-byte credential of the same character length", "é".repeat(64), HASH],
  ])("refuses %s without throwing", (_label, held, hash) => {
    expect(() => holdsCredential(held, hash)).not.toThrow();
    expect(holdsCredential(held, hash)).toBe(false);
  });
});
