import { describe, expect, it } from "vitest";
import { scryptSync } from "crypto";
import {
  fakeVerifyPassword,
  hashPassword,
  verifyPassword,
} from "../../utils/password.ts";

/**
 * A hash in the shape this used to store: "salt:key" at node's own scrypt
 * defaults, with the cost left unstated. Rows written before the format
 * carried its parameters still look like this, and they have to keep
 * verifying — the accounts here are seeded by hand and there is no reset flow.
 */
function legacyHash(password: string, salt: string): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

describe("hashPassword", () => {
  it("stores the cost alongside the salt and key", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // "scrypt$N$r$p$salt$key". The cost is written down so it can be raised
    // without invalidating every password already stored.
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
  });

  it("stays inside the column the hash is stored in", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // "password" is VARCHAR(255) — see migrations/0001_init.sql.
    expect(hash.length).toBeLessThanOrEqual(255);
  });

  it("salts each hash, so the same password never stores the same value", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);

    expect(first).not.toBe(second);
    await expect(verifyPassword("same-password", first)).resolves.toBe(true);
    await expect(verifyPassword("same-password", second)).resolves.toBe(true);
  });

  it("handles empty and unicode passwords", async () => {
    const empty = await hashPassword("");
    const unicode = await hashPassword("héslo–ü🔑");

    await expect(verifyPassword("", empty)).resolves.toBe(true);
    await expect(verifyPassword("héslo–ü🔑", unicode)).resolves.toBe(true);
    await expect(verifyPassword("x", empty)).resolves.toBe(false);
  });
});

describe("verifyPassword", () => {
  it("rejects a wrong password", async () => {
    const hash = await hashPassword("right");

    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("is case- and whitespace-sensitive", async () => {
    const hash = await hashPassword("Secret");

    await expect(verifyPassword("secret", hash)).resolves.toBe(false);
    await expect(verifyPassword("Secret ", hash)).resolves.toBe(false);
  });

  // A malformed row used to hand `undefined` to Buffer.from, which throws and
  // turned a failed login into a 500.
  it.each([
    ["no separator", "notahash"],
    ["empty string", ""],
    ["empty salt", ":abcdef"],
    ["non-hex key", "salt:zzzz"],
    ["odd-length key", "salt:abc"],
    ["separator only", ":"],
  ])("returns false for a malformed hash (%s)", async (_label, stored) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("returns false when the stored key is the wrong length", async () => {
    await expect(verifyPassword("anything", "salt:abcd")).resolves.toBe(false);
  });

  /**
   * The signature says string, but the value comes off a database row, so the
   * guard is not reachable from typed code and is worth keeping anyway: a
   * NULL column would otherwise throw out of a failed login as a 500.
   */
  it("refuses a stored value that is not a string at all", async () => {
    for (const stored of [null, undefined, 42, {}]) {
      await expect(
        verifyPassword("anything", stored as unknown as string),
      ).resolves.toBe(false);
    }
  });

  it("still accepts a hash stored in the old salt:key shape", async () => {
    const stored = legacyHash("legacy-password", "a".repeat(32));

    await expect(verifyPassword("legacy-password", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  /**
   * The cost comes out of the database, and scrypt allocates 128 * N * r
   * bytes before it does anything else — so a mangled row claiming a huge N
   * would ask for a terabyte and take the process down rather than failing
   * one login.
   */
  it("refuses a cost past the bound instead of allocating for it", async () => {
    const absurd = `scrypt$1073741824$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

    await expect(verifyPassword("anything", absurd)).resolves.toBe(false);
  });

  it("refuses a malformed cost field", async () => {
    const salt = "a".repeat(32);
    const key = "b".repeat(128);

    for (const bad of [
      `scrypt$0$8$1$${salt}$${key}`,
      `scrypt$16384$8$1e1$${salt}$${key}`,
      `scrypt$16384$8$${salt}$${key}`,
      `scrypt$16384$8$1$not-hex$${key}`,
    ]) {
      await expect(verifyPassword("anything", bad)).resolves.toBe(false);
    }
  });

  /**
   * N has to be a power of two, which the bounds check cannot know. node
   * refuses it, and that is a row this process cannot verify — a failed
   * login, not a 500.
   */
  it("refuses a cost node itself rejects", async () => {
    const odd = `scrypt$16385$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

    await expect(verifyPassword("anything", odd)).resolves.toBe(false);
  });
});

describe("fakeVerifyPassword", () => {
  it("resolves without throwing, so an unknown user still costs the same work", async () => {
    await expect(fakeVerifyPassword("anything")).resolves.toBeUndefined();
  });
});
